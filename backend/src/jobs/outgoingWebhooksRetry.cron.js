import cron from 'node-cron'
import { processDueOutgoingWebhookRetries } from '../services/outgoingWebhooksService.js'
import { logger } from '../utils/logger.js'

export function startOutgoingWebhooksRetryCron() {
  logger.info('🔁 Iniciando reintentos de webhooks salientes')

  cron.schedule('* * * * *', async () => {
    try {
      const processed = await processDueOutgoingWebhookRetries()
      if (processed > 0) {
        logger.info(`🔁 Reintentos de webhooks salientes procesados: ${processed}`)
      }
    } catch (error) {
      logger.error(`Error en reintentos de webhooks salientes: ${error.message}`)
    }
  })

  logger.success('✅ Reintentos de webhooks salientes activos')
}
