import cron from 'node-cron'
import { updateRecentAds } from '../services/metaAdsService.js'
import { logger } from '../utils/logger.js'

/**
 * Cron job para actualizar ads recientes cada hora
 * Solo se ejecuta en desarrollo (NODE_ENV !== 'production')
 * En producción, Render Cron Job llama directamente al endpoint
 */
export function startMetaSyncCron() {
  // Solo ejecutar en desarrollo
  if (process.env.NODE_ENV === 'production') {
    logger.info('Modo producción: Cron job de Meta manejado por Render')
    return
  }

  logger.info('Iniciando cron job de Meta Ads (cada hora)')

  // Ejecutar cada hora (minuto 0)
  cron.schedule('0 * * * *', async () => {
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
