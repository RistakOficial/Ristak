import { processDueContactBulkActions } from '../services/contactBulkActionsService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'

const CONTACT_BULK_ACTIONS_INTERVAL_MS = 20 * 1000
const CONTACT_BULK_ACTIONS_LOCK_TTL_MS = 2 * 60 * 1000

let started = false
let running = false

async function runContactBulkActions(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    await trackDeployDrainWork('cron:contact-bulk-actions', async () => {
      const { ran } = await withCronLock('contact-bulk-actions', CONTACT_BULK_ACTIONS_LOCK_TTL_MS, async () => {
        const results = await processDueContactBulkActions()
        const completed = results.filter((result) => result.completed).length
        const failed = results.filter((result) => result.error).length

        if (completed || failed) {
          logger.info(`[Acciones masivas] ${source}: ${completed} completadas, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Acciones masivas] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
  } catch (error) {
    logger.error(`[Acciones masivas] Error revisando cola: ${error.message}`)
  } finally {
    running = false
  }
}

export function startContactBulkActionsCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de acciones masivas de contactos')
  setInterval(() => {
    runContactBulkActions().catch((error) => {
      logger.error(`[Acciones masivas] Error no manejado: ${error.message}`)
    })
  }, CONTACT_BULK_ACTIONS_INTERVAL_MS)

  runContactBulkActions('startup').catch((error) => {
    logger.error(`[Acciones masivas] Error inicial: ${error.message}`)
  })
}
