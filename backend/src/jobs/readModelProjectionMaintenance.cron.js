import {
  CHAT_ACTIVITY_PROJECTION_VERSION,
  readChatActivityProjectionState,
  scheduleChatActivityProjectionBackfill
} from '../services/chatActivityProjectionService.js'
import {
  CRM_LIST_PROJECTION_VERSION,
  readCrmListProjectionState,
  scheduleCrmListProjectionBackfill
} from '../services/crmListProjectionService.js'
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
  MESSAGE_ANALYTICS_PROJECTION_VERSION,
  readMessageAnalyticsProjectionState,
  scheduleMessageAnalyticsProjectionBackfill
} from '../services/messageAnalyticsProjectionService.js'
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
import {
  TRACKING_ANALYTICS_PROJECTION_VERSION,
  readTrackingAnalyticsProjectionState,
  scheduleTrackingAnalyticsProjectionBackfill
} from '../services/trackingAnalyticsProjectionService.js'
import {
  TRACKING_CONVERSION_PROJECTION_VERSION,
  readTrackingConversionProjectionState,
  scheduleTrackingConversionProjectionBackfill
} from '../services/trackingConversionProjectionService.js'
import {
  CONTACT_ORIGIN_PROJECTION_VERSION,
  readContactOriginProjectionState,
  scheduleContactOriginProjectionBackfill
} from '../services/contactOriginProjectionService.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'
import { logger as defaultLogger } from '../utils/logger.js'

const DEFAULT_INTERVAL_MS = 30_000

const defaultProjections = Object.freeze([
  {
    key: 'crm-list-projections',
    version: CRM_LIST_PROJECTION_VERSION,
    readState: readCrmListProjectionState,
    schedule: scheduleCrmListProjectionBackfill
  },
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
    key: 'message-analytics',
    version: MESSAGE_ANALYTICS_PROJECTION_VERSION,
    readState: readMessageAnalyticsProjectionState,
    schedule: scheduleMessageAnalyticsProjectionBackfill,
    continuous: true
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
  },
  {
    key: 'tracking-analytics',
    version: TRACKING_ANALYTICS_PROJECTION_VERSION,
    readState: readTrackingAnalyticsProjectionState,
    schedule: scheduleTrackingAnalyticsProjectionBackfill,
    // A diferencia de un backfill cerrado, esta proyección tiene una cola de
    // cambios que sigue recibiendo eventos después de publicar `ready`.
    // El tick de 30 s es sólo el watchdog; el servicio mantiene su poll corto.
    continuous: true
  },
  {
    key: 'tracking-conversion',
    version: TRACKING_CONVERSION_PROJECTION_VERSION,
    readState: readTrackingConversionProjectionState,
    schedule: scheduleTrackingConversionProjectionBackfill,
    continuous: true
  },
  {
    key: 'contact-origin',
    version: CONTACT_ORIGIN_PROJECTION_VERSION,
    readState: readContactOriginProjectionState,
    schedule: scheduleContactOriginProjectionBackfill,
    continuous: true
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
        if (ready && !projection.continuous) continue
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
