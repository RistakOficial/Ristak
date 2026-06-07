import { dispatchDueScheduledChatMessages } from '../services/scheduledChatMessagesService.js'
import { logger } from '../utils/logger.js'

const SCHEDULED_CHAT_INTERVAL_MS = 30 * 1000

let started = false
let running = false

async function runScheduledChatDispatch(source = 'interval') {
  if (running) return
  running = true

  try {
    const results = await dispatchDueScheduledChatMessages()
    const sent = results.filter(result => result.sent).length
    const failed = results.filter(result => result.error).length

    if (sent || failed) {
      logger.info(`[Mensajes programados] ${source}: ${sent} enviados, ${failed} con error`)
    }
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
