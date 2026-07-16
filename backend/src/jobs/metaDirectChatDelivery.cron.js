import crypto from 'crypto'
import { sendChatMessageNotification } from '../services/pushNotificationsService.js'
import { isMetaDirectWhatsAppConnected } from '../services/integrationConnectionStateService.js'
import {
  CHAT_DELIVERY_ENRICHMENT_MAX_ATTEMPTS,
  CHAT_DELIVERY_MAX_ATTEMPTS,
  CHAT_DELIVERY_JOB_KIND,
  claimNextChatDeliveryJob,
  cleanupCompletedChatDeliveryJobs,
  completeChatDeliveryJob,
  renewChatDeliveryJobLease,
  retryChatDeliveryJob
} from '../services/chatDeliveryOutboxService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const BOOT_DELAY_MS = 750
const DELIVERY_INTERVAL_MS = 10_000
const DELIVERY_LEASE_MS = 60_000
const JOBS_PER_TICK = 40
const DELIVERY_CLEANUP_INTERVAL_MS = 60 * 60_000

const runningLanes = new Set()
const laneSchedulers = new Map([
  [CHAT_DELIVERY_JOB_KIND.PUSH, { started: false, bootTimeoutId: null, intervalId: null, immediateTimeoutId: null }],
  [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT, { started: false, bootTimeoutId: null, intervalId: null, immediateTimeoutId: null }]
])
let pushSenderForTest = null
let enrichmentProcessorForTest = null
let connectionCheckerForTest = null
let lastDeliveryCleanupAt = 0

async function cleanupChatDeliveryOutboxIfDue() {
  const now = Date.now()
  if (lastDeliveryCleanupAt > 0 && now - lastDeliveryCleanupAt < DELIVERY_CLEANUP_INTERVAL_MS) {
    return null
  }
  // Se marca antes de ejecutar: un fallo transitorio espera al siguiente ciclo
  // horario en vez de convertir cada tick de 10 s en un full scan terminal.
  lastDeliveryCleanupAt = now
  return cleanupCompletedChatDeliveryJobs()
}

async function runPushJob(job) {
  const sender = pushSenderForTest || sendChatMessageNotification
  const result = await sender({ ...job.payload, durableDelivery: true })
  if (Number(result?.retryableFailures || 0) > 0) {
    const error = new Error(
      `Push tuvo ${Number(result.retryableFailures)} fallo(s) transitorio(s) de ${Number(result.attempted || 0)} intento(s)`
    )
    error.code = 'push_delivery_retryable_failure'
    const normalizeTargetIds = values => [...new Set(
      (Array.isArray(values) ? values : [])
        .map(targetId => String(targetId || '').trim())
        .filter(Boolean)
    )]
    const retryTargets = {
      webSubscriptionIds: normalizeTargetIds(result?.retryTargets?.webSubscriptionIds),
      mobileDeviceIds: normalizeTargetIds(result?.retryTargets?.mobileDeviceIds)
    }
    const hasExactRetryTargets = retryTargets.webSubscriptionIds.length > 0 || retryTargets.mobileDeviceIds.length > 0
    error.retryPayload = hasExactRetryTargets
      ? { ...job.payload, deliveryTargets: retryTargets }
      : job.payload
    throw error
  }
  return result
}

async function runEnrichmentJob(job) {
  if (enrichmentProcessorForTest) return enrichmentProcessorForTest(job)
  const { processMetaDirectInboundEnrichmentJob } = await import('../services/whatsappApiService.js')
  return processMetaDirectInboundEnrichmentJob({
    messageId: job.message_id,
    payload: job.payload
  })
}

async function isDeliveryEnabled() {
  const checker = connectionCheckerForTest || isMetaDirectWhatsAppConnected
  return Boolean(await checker())
}

export async function drainMetaDirectChatDeliveryJobs({
  maxJobs = JOBS_PER_TICK,
  requireConnected = true,
  retryDelayMs = null,
  maxAttempts = null,
  jobKinds = [CHAT_DELIVERY_JOB_KIND.PUSH, CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT]
} = {}) {
  let effectiveJobKinds = [...new Set(jobKinds)]
  let enrichmentSkipped = false
  if (
    requireConnected &&
    effectiveJobKinds.includes(CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT) &&
    !(await isDeliveryEnabled())
  ) {
    effectiveJobKinds = effectiveJobKinds.filter(kind => kind !== CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT)
    enrichmentSkipped = true
    if (!effectiveJobKinds.length) {
      return {
        processed: 0,
        completed: 0,
        failed: 0,
        deadLettered: 0,
        skipped: true,
        reason: 'meta_direct_disconnected'
      }
    }
  }

  const ownerId = `meta-direct-delivery-${process.pid}-${crypto.randomUUID()}`
  const limit = Math.max(1, Math.min(250, Number(maxJobs) || JOBS_PER_TICK))
  let processed = 0
  let completed = 0
  let failed = 0
  let deadLettered = 0
  const processedJobIds = []
  const maxAttemptsOverride = Number(maxAttempts) > 0 ? Number(maxAttempts) : null

  for (let index = 0; index < limit; index += 1) {
    if (isDeployShutdownStarted()) break
    const job = await claimNextChatDeliveryJob({
      ownerId,
      leaseMs: DELIVERY_LEASE_MS,
      jobKinds: effectiveJobKinds,
      excludedJobIds: processedJobIds
    })
    if (!job) break
    processedJobIds.push(job.id)
    processed += 1

    const heartbeat = setInterval(() => {
      void renewChatDeliveryJobLease({
        jobId: job.id,
        ownerId,
        leaseMs: DELIVERY_LEASE_MS
      }).catch(error => {
        logger.warn(`[Meta directo] No se pudo renovar lease de ${job.id}: ${error.message}`)
      })
    }, Math.floor(DELIVERY_LEASE_MS / 3))
    heartbeat.unref?.()

    try {
      if (job.job_kind === CHAT_DELIVERY_JOB_KIND.PUSH) {
        await runPushJob(job)
      } else {
        await runEnrichmentJob(job)
      }
      const markedCompleted = await completeChatDeliveryJob({ jobId: job.id, ownerId })
      if (!markedCompleted) {
        const leaseError = new Error(`El lease de ${job.id} cambió antes de confirmar el job`)
        leaseError.code = 'chat_delivery_lease_lost'
        throw leaseError
      }
      completed += 1
    } catch (error) {
      failed += 1
      const retryResult = await retryChatDeliveryJob({
        jobId: job.id,
        ownerId,
        error,
        attemptCount: job.attemptCount,
        maxAttempts: maxAttemptsOverride || (
          job.job_kind === CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT
            ? CHAT_DELIVERY_ENRICHMENT_MAX_ATTEMPTS
            : CHAT_DELIVERY_MAX_ATTEMPTS
        ),
        payload: error?.retryPayload || job.payload,
        retryDelayMs
      })
      if (retryResult?.deadLettered) {
        deadLettered += 1
        logger.error(`[Meta directo] Outbox ${job.job_kind} agotó intentos para ${job.message_id}: ${error.message}`)
      } else {
        logger.warn(`[Meta directo] Outbox ${job.job_kind} reintentará ${job.message_id}: ${error.message}`)
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  return { processed, completed, failed, deadLettered, skipped: false, enrichmentSkipped }
}

async function runDeliveryLane(jobKind, reason) {
  if (runningLanes.has(jobKind) || isDeployShutdownStarted()) return null
  runningLanes.add(jobKind)
  try {
    if (jobKind === CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT && !(await isDeliveryEnabled())) return null
    const locked = await trackDeployDrainWork(
      `cron:meta-direct-chat-delivery:${jobKind}`,
      () => withCronLock(
        `meta-direct-chat-delivery:${jobKind}`,
        DELIVERY_INTERVAL_MS,
        async () => {
          const result = await drainMetaDirectChatDeliveryJobs({
            requireConnected: false,
            jobKinds: [jobKind],
            maxJobs: jobKind === CHAT_DELIVERY_JOB_KIND.PUSH ? JOBS_PER_TICK : 10
          })
          if (jobKind === CHAT_DELIVERY_JOB_KIND.PUSH) {
            await cleanupChatDeliveryOutboxIfDue().catch(error => {
              logger.warn(`[Push] No se pudo limpiar el outbox terminal: ${error.message}`)
            })
          }
          return result
        }
      ),
      reason
    )
    return locked?.result || null
  } catch (error) {
    logger.warn(`[Meta directo] Recuperación ${jobKind} ${reason} falló: ${error.message}`)
    return null
  } finally {
    runningLanes.delete(jobKind)
  }
}

function requestDeliveryLaneDrain(jobKind, reason) {
  const scheduler = laneSchedulers.get(jobKind)
  if (!scheduler?.started || scheduler.immediateTimeoutId || isDeployShutdownStarted()) return false
  scheduler.immediateTimeoutId = setTimeout(() => {
    scheduler.immediateTimeoutId = null
    void runDeliveryLane(jobKind, reason)
  }, 0)
  scheduler.immediateTimeoutId.unref?.()
  return true
}

export function requestMetaDirectChatDeliveryDrain(reason = 'webhook') {
  const pushRequested = requestDeliveryLaneDrain(CHAT_DELIVERY_JOB_KIND.PUSH, reason)
  const enrichmentRequested = requestDeliveryLaneDrain(CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT, reason)
  return pushRequested || enrichmentRequested
}

function startDeliveryLaneCron(jobKind) {
  const scheduler = laneSchedulers.get(jobKind)
  if (!scheduler || scheduler.started) return
  scheduler.started = true
  scheduler.bootTimeoutId = setTimeout(
    () => requestDeliveryLaneDrain(jobKind, 'startup'),
    BOOT_DELAY_MS
  )
  scheduler.intervalId = setInterval(
    () => requestDeliveryLaneDrain(jobKind, 'tick'),
    DELIVERY_INTERVAL_MS
  )
  scheduler.bootTimeoutId.unref?.()
  scheduler.intervalId.unref?.()
  return true
}

function stopDeliveryLaneCron(jobKind) {
  const scheduler = laneSchedulers.get(jobKind)
  if (!scheduler) return
  if (scheduler.bootTimeoutId) clearTimeout(scheduler.bootTimeoutId)
  if (scheduler.intervalId) clearInterval(scheduler.intervalId)
  if (scheduler.immediateTimeoutId) clearTimeout(scheduler.immediateTimeoutId)
  scheduler.bootTimeoutId = null
  scheduler.intervalId = null
  scheduler.immediateTimeoutId = null
  scheduler.started = false
}

// Push y limpieza son infraestructura del sistema: deben seguir recuperándose
// aunque Meta Direct se desconecte después de confirmar un inbound.
export function startChatPushDeliveryCron() {
  return startDeliveryLaneCron(CHAT_DELIVERY_JOB_KIND.PUSH)
}

export function stopChatPushDeliveryCron() {
  return stopDeliveryLaneCron(CHAT_DELIVERY_JOB_KIND.PUSH)
}

// Sólo el enriquecimiento de Graph/media depende de que Meta Direct siga conectado.
export function startMetaDirectChatDeliveryCron() {
  return startDeliveryLaneCron(CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT)
}

export function stopMetaDirectChatDeliveryCron() {
  return stopDeliveryLaneCron(CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT)
}

export function setMetaDirectChatDeliveryHandlersForTest({
  pushSender = null,
  enrichmentProcessor = null,
  connectionChecker = null
} = {}) {
  pushSenderForTest = typeof pushSender === 'function' ? pushSender : null
  enrichmentProcessorForTest = typeof enrichmentProcessor === 'function' ? enrichmentProcessor : null
  connectionCheckerForTest = typeof connectionChecker === 'function' ? connectionChecker : null
}

export function resetMetaDirectChatDeliveryHandlersForTest() {
  pushSenderForTest = null
  enrichmentProcessorForTest = null
  connectionCheckerForTest = null
}
