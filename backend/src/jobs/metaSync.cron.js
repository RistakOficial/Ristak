import cron from 'node-cron'
import { updateRecentAds } from '../services/metaAdsService.js'
import { refreshConnectedSocialProfileBlocks } from '../services/metaSocialProfilesService.js'
import { logger } from '../utils/logger.js'

/**
 * Cron job para actualizar ads recientes cada hora
 * Se ejecuta tanto en desarrollo como en producción
 */
export function startMetaSyncCron() {
  logger.info('Iniciando cron job de Meta Ads (cada hora)')

  // Ejecutar cada hora en punto.
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

  // Refresca una vez al dia los seguidores usados por perfiles sociales publicados.
  cron.schedule('17 5 * * *', async () => {
    logger.info('Revisando perfiles sociales publicados antes de actualizar datos de Meta...')
    try {
      const result = await refreshConnectedSocialProfileBlocks()
      if (result.success) {
        logger.success(result.message)
      } else {
        logger.warn('Actualización diaria de perfiles sociales saltada:', result.message)
      }
    } catch (error) {
      logger.error('Error actualizando perfiles sociales:', error.message)
    }
  })

  logger.success('Cron job de Meta Ads configurado (cada hora en punto)')
}
