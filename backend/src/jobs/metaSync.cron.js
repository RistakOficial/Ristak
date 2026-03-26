import cron from 'node-cron'
import { updateRecentAds } from '../services/metaAdsService.js'
import { logger } from '../utils/logger.js'

/**
 * Cron job para actualizar ads recientes cada hora
 * Se ejecuta tanto en desarrollo como en producción
 */
export function startMetaSyncCron() {
  logger.info('Iniciando cron job de Meta Ads (cada hora)')

  // Ejecutar cada hora (minuto 7) para evitar choque con otros cron jobs pesados
  cron.schedule('7 * * * *', async () => {
    logger.info('Ejecutando actualización automática de Meta Ads...')
    try {
      const result = await updateRecentAds()
      if (result.success) {
        logger.success(`Actualización automática completada: ${result.count} ads actualizados`)
      } else {
        logger.warn('Actualización automática saltada:', result.message)
      }
    } catch (error) {
      logger.error('Error en actualización automática de Meta Ads:', error.message)
    }
  })

  logger.success('Cron job de Meta Ads configurado')
}
