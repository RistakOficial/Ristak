import cron from 'node-cron'
import { updateRecentAds } from '../services/metaAdsService.js'
import { refreshConnectedSocialProfileBlocks } from '../services/metaSocialProfilesService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

/**
 * Cron job para actualizar ads recientes cada hora
 * Se ejecuta tanto en desarrollo como en producción
 */
// (META-006) Guards anti-solape intra-proceso: si un tick anterior aún corre
// (una corrida tardó más que el intervalo, o el solape de un deploy zero-downtime
// dispara dos veces seguidas en el mismo proceso), no encimamos otra ejecución de
// la misma tarea. Evita doble sync de Meta Ads / doble refresh de perfiles.
let metaAdsSyncRunning = false
let metaSocialRefreshRunning = false

export function startMetaSyncCron() {
  logger.info('Iniciando cron job de Meta Ads (cada hora)')

  // Ejecutar cada hora en punto.
  cron.schedule('0 * * * *', async () => {
    if (isDeployShutdownStarted()) return
    // (META-006) Claim intra-proceso antes de actuar.
    if (metaAdsSyncRunning) {
      logger.warn('Actualización automática de Meta Ads saltada: ya hay un tick en curso')
      return
    }
    metaAdsSyncRunning = true
    logger.info('Ejecutando actualización automática de Meta Ads...')
    try {
      await trackDeployDrainWork('cron:meta-ads-sync', async () => {
        const result = await updateRecentAds()
        if (result.success) {
          logger.success(`Actualización automática completada: ${result.count} ads actualizados`)
        } else {
          logger.warn('Actualización automática saltada:', result.message)
        }
      })
    } catch (error) {
      logger.error('Error en actualización automática de Meta Ads:', error.message)
    } finally {
      metaAdsSyncRunning = false // (META-006)
    }
  })

  // Refresca una vez al dia los seguidores usados por perfiles sociales publicados.
  cron.schedule('17 5 * * *', async () => {
    if (isDeployShutdownStarted()) return
    // (META-006) Claim intra-proceso antes de actuar.
    if (metaSocialRefreshRunning) {
      logger.warn('Actualización de perfiles sociales saltada: ya hay un tick en curso')
      return
    }
    metaSocialRefreshRunning = true
    logger.info('Revisando perfiles sociales publicados antes de actualizar datos de Meta...')
    try {
      await trackDeployDrainWork('cron:meta-social-profile-refresh', async () => {
        const result = await refreshConnectedSocialProfileBlocks()
        if (result.success) {
          logger.success(result.message)
        } else {
          logger.warn('Actualización diaria de perfiles sociales saltada:', result.message)
        }
      })
    } catch (error) {
      logger.error('Error actualizando perfiles sociales:', error.message)
    } finally {
      metaSocialRefreshRunning = false // (META-006)
    }
  })

  logger.success('Cron job de Meta Ads configurado (cada hora en punto)')
}
