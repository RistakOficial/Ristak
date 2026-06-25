// (GCAL-002) Cron de reintento de sincronización Google Calendar <-> local.
// Antes no existía: las citas/cuentas que quedaban con error/pendiente al sincronizar
// con Google NUNCA se reintentaban hasta que alguien forzaba la sync a mano. Este cron
// reintenta periódicamente, de forma acotada e idempotente, reutilizando el servicio.
import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { retryGoogleCalendarSync } from '../services/googleCalendarService.js'

// (GCAL-002) TTL del lock = intervalo del cron (cada hora). Si un tick crashea sin liberar
// el lock, se libera solo en el siguiente ciclo. Mismo criterio que los demás crons (GHL-005).
const GOOGLE_CALENDAR_SYNC_LOCK_TTL_MS = 60 * 60 * 1000

// (GCAL-002) Guard intra-proceso anti-solape: la sync (pull + push) puede tardar más que
// el intervalo si hay muchas citas pendientes. Si un tick anterior sigue corriendo, no
// encimamos otro. Mismo patrón que highlevelSync (CRON-008) / appointmentReminders.
let googleCalendarSyncRunning = false

async function runGoogleCalendarSyncRetry(source = 'interval') {
  if (isDeployShutdownStarted()) return
  if (googleCalendarSyncRunning) {
    logger.warn('Reintento de sincronización de Google Calendar saltado: ya hay un tick en curso')
    return
  }
  googleCalendarSyncRunning = true

  try {
    // (GCAL-002) Flush-on-drain: si arranca un deploy mientras corre el reintento, el graceful
    // shutdown espera a que termine en lugar de cortarlo a la mitad.
    await trackDeployDrainWork('cron:google-calendar-sync', async () => {
      // (GCAL-002) Lock distribuido: con varias réplicas, solo una reintenta la sync por ciclo
      // (evita doble pull/push contra la API de Google). Defensivo con 1 instancia.
      const { ran } = await withCronLock('google-calendar-sync', GOOGLE_CALENDAR_SYNC_LOCK_TTL_MS, async () => {
        const result = await retryGoogleCalendarSync()
        if (result?.enabled === false) {
          // Google no conectado: no-op silencioso, no es un error.
          return
        }
        const sync = result?.sync || {}
        logger.info(
          `(GCAL-002) Reintento de sincronización Google Calendar (${source}): ` +
          `${Number(sync.events || 0)} cita(s) sincronizada(s), ` +
          `${Number(sync.failed || 0)} pendiente(s) por error`
        )
      })
      if (!ran) logger.info('(GCAL-002) Reintento de sincronización Google Calendar omitido: otra instancia tiene el lock')
    }, source)
  } catch (error) {
    logger.warn(`(GCAL-002) Error en reintento de sincronización de Google Calendar: ${error.message}`)
  } finally {
    googleCalendarSyncRunning = false
  }
}

export function startGoogleCalendarSyncCron() {
  logger.info('(GCAL-002) Iniciando cron de reintento de sincronización de Google Calendar (cada hora)')

  // (GCAL-002) Minuto 37 para no competir con Meta (:00), HighLevel (:17) ni sus conversaciones (cada 10).
  cron.schedule('37 * * * *', () => {
    runGoogleCalendarSyncRetry('interval').catch(error => {
      logger.warn(`(GCAL-002) Error no manejado en reintento de sincronización de Google Calendar: ${error.message}`)
    })
  })

  logger.success('(GCAL-002) Cron de Google Calendar configurado (cada hora a las XX:37)')
}
