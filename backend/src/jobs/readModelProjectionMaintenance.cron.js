import {
  CHAT_ACTIVITY_PROJECTION_VERSION,
  readChatActivityProjectionState,
  scheduleChatActivityProjectionBackfill
} from '../services/chatActivityProjectionService.js'
import {
  CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION,
  readConversationalAgentMetricsProjectionState,
  scheduleConversationalAgentMetricsProjectionBackfill
} from '../services/conversationalAgentMetricsProjectionService.js'
import {
  MESSAGE_FIRST_SEEN_PROJECTION_VERSION,
  readMessageFirstSeenProjectionState,
  scheduleMessageFirstSeenProjectionBackfill
} from '../services/messageFirstSeenProjectionService.js'
import {
  CONTACT_PERSON_IDENTITY_PROJECTION_VERSION,
  readContactPersonIdentityProjectionState,
  scheduleContactPersonIdentityProjectionBackfill
} from '../services/contactPersonIdentityProjectionService.js'
import {
  TRACKING_VISITOR_PROJECTION_VERSION,
  readTrackingVisitorProjectionState,
  scheduleTrackingVisitorProjectionBackfill
} from '../services/trackingVisitorProjectionService.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'
import { logger as defaultLogger } from '../utils/logger.js'

const DEFAULT_INTERVAL_MS = 30_000

const defaultProjections = Object.freeze([
  {
    key: 'contact-person-identity',
    version: CONTACT_PERSON_IDENTITY_PROJECTION_VERSION,
    readState: readContactPersonIdentityProjectionState,
    schedule: scheduleContactPersonIdentityProjectionBackfill
  },
  {
    key: 'chat-activity',
    version: CHAT_ACTIVITY_PROJECTION_VERSION,
    readState: readChatActivityProjectionState,
    schedule: scheduleChatActivityProjectionBackfill
  },
  {
    key: 'message-first-seen',
    version: MESSAGE_FIRST_SEEN_PROJECTION_VERSION,
    readState: readMessageFirstSeenProjectionState,
    schedule: scheduleMessageFirstSeenProjectionBackfill
  },
  {
    key: 'conversational-agent-metrics',
    version: CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION,
    readState: readConversationalAgentMetricsProjectionState,
    schedule: scheduleConversationalAgentMetricsProjectionBackfill
  },
  {
    key: 'tracking-visitor',
    version: TRACKING_VISITOR_PROJECTION_VERSION,
    readState: readTrackingVisitorProjectionState,
    schedule: scheduleTrackingVisitorProjectionBackfill
  }
])

/**
 * Mantiene las proyecciones fuera del request path. Cada tick solo lee sus
 * singleton rows y delega cualquier trabajo a la cola global con sus
 * prioridades existentes; nunca recorre tablas fuente ni espera el backfill.
 */
export function createReadModelProjectionMaintenanceScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  projections = defaultProjections,
  shuttingDown = isDeployShutdownStarted,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = defaultLogger
} = {}) {
  let intervalId = null
  let running = false

  async function tick() {
    if (running || shuttingDown()) return { scheduled: [], skipped: true }
    running = true
    try {
      const scheduled = []
      const states = await Promise.all(projections.map(async projection => {
        try {
          return { projection, state: await projection.readState(), error: null }
        } catch (error) {
          logger.warn(`[Proyecciones] No se pudo leer ${projection.key}: ${error.message}`)
          return { projection, state: null, error }
        }
      }))
      for (const { projection, state, error } of states) {
        if (error) continue
        if (!state) continue
        const ready = Number(state.projection_version) === Number(projection.version) &&
          String(state.status || '').toLowerCase() === 'ready'
        if (ready) continue
        try {
          const queued = projection.schedule()
          scheduled.push({ key: projection.key, queued: Boolean(queued?.scheduled) })
        } catch (scheduleError) {
          logger.warn(`[Proyecciones] No se pudo agendar ${projection.key}: ${scheduleError.message}`)
        }
      }
      return { scheduled, skipped: false }
    } finally {
      running = false
    }
  }

  function reportFailure(error) {
    logger.warn(`[Proyecciones] No se pudo revisar el mantenimiento de read models: ${error.message}`)
  }

  function start() {
    if (intervalId) return false
    intervalId = setIntervalFn(() => tick().catch(reportFailure), Math.max(250, Number(intervalMs) || DEFAULT_INTERVAL_MS))
    intervalId?.unref?.()
    tick().catch(reportFailure)
    return true
  }

  function stop() {
    if (!intervalId) return false
    clearIntervalFn(intervalId)
    intervalId = null
    return true
  }

  return Object.freeze({ tick, start, stop })
}

const scheduler = createReadModelProjectionMaintenanceScheduler()

export function runReadModelProjectionMaintenanceTick() {
  return scheduler.tick()
}

export function startReadModelProjectionMaintenanceScheduler() {
  return scheduler.start()
}

export function stopReadModelProjectionMaintenanceScheduler() {
  return scheduler.stop()
}
