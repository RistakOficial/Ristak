import { dispatchDueScheduledChatMessages } from '../services/scheduledChatMessagesService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { canRunBackgroundJob } from '../services/licenseService.js'

const SCHEDULED_CHAT_INTERVAL_MS = 30 * 1000
const SCHEDULED_CHAT_LOCK_TTL_MS = 2 * 60 * 1000

let started = false
let running = false

async function runScheduledChatDispatch(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  if (!(await canRunBackgroundJob('whatsapp'))) return
  running = true

  try {
    // (NOTI-010) Flush-on-drain: el tick que esté en vuelo cuando empieza el shutdown queda
    // registrado en trackDeployDrainWork, así que el graceful shutdown espera a que termine de
    // despachar los mensajes programados ya vencidos en vez de matar el proceso a media tanda.
    await trackDeployDrainWork('cron:scheduled-chat-messages', async () => {
      const { ran } = await withCronLock('scheduled-chat-messages', SCHEDULED_CHAT_LOCK_TTL_MS, async () => {
        const results = await dispatchDueScheduledChatMessages()
        const sent = results.filter(result => result.sent).length
        const failed = results.filter(result => result.error).length

        if (sent || failed) {
          logger.info(`[Mensajes programados] ${source}: ${sent} enviados, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Mensajes programados] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
  } catch (error) {
    logger.error(`[Mensajes programados] Error revisando cola: ${error.message}`)
  } finally {
    running = false
  }
}

export function startScheduledChatMessagesCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de mensajes programados del chat')
  setInterval(() => {
    runScheduledChatDispatch().catch(error => {
      logger.error(`[Mensajes programados] Error no manejado: ${error.message}`)
    })
  }, SCHEDULED_CHAT_INTERVAL_MS)

  runScheduledChatDispatch('startup').catch(error => {
    logger.error(`[Mensajes programados] Error inicial: ${error.message}`)
  })
}
