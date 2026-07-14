import cron from 'node-cron'
import { updateRecentAds } from '../services/metaAdsService.js'
import { refreshConnectedSocialProfileBlocks } from '../services/metaSocialProfilesService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { withCronLock } from '../utils/cronLock.js'
import {
  DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES,
  formatMetaAdsSyncInterval,
  getMetaAdsSyncIntervalMinutes
} from '../services/metaAdsSyncSettingsService.js'

/**
 * Job configurable para actualizar anuncios recientes.
 * Se ejecuta tanto en desarrollo como en producción y sólo existe cuando la
 * integración de Meta Ads está conectada (integrationCronRegistry).
 */
// (META-006) Guards anti-solape intra-proceso: si un tick anterior aún corre
// (una corrida tardó más que el intervalo, o el solape de un deploy zero-downtime
// dispara dos veces seguidas en el mismo proceso), no encimamos otra ejecución de
// la misma tarea. Evita doble sync de Meta Ads / doble refresh de perfiles.
let metaAdsSyncRunning = false
let metaSocialRefreshRunning = false
let metaAdsSyncTask = null
let metaSocialRefreshTask = null
let activeMetaAdsSyncIntervalMinutes = DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES

async function runMetaAdsSyncTick(intervalMinutes) {
  if (isDeployShutdownStarted()) return
  try {
    if (!(await canRunBackgroundJob('meta_ads'))) return
  } catch (error) {
    logger.warn(`No se pudo validar el plan antes de sincronizar Meta Ads: ${error.message}`)
    return
  }

  if (metaAdsSyncRunning) {
    logger.warn('Actualización automática de Meta Ads saltada: ya hay un tick en curso')
    return
  }

  metaAdsSyncRunning = true
  logger.info('Ejecutando actualización automática de Meta Ads...')
  try {
    await trackDeployDrainWork('cron:meta-ads-sync', async () => {
      const { ran } = await withCronLock('meta-ads-sync', intervalMinutes * 60 * 1000, async () => {
        const result = await updateRecentAds()
        if (result.success) {
          logger.success(`Actualización automática completada: ${result.count} ads actualizados`)
        } else {
          logger.warn('Actualización automática saltada:', result.message)
        }
      })
      if (!ran) {
        logger.info('Actualización automática de Meta Ads omitida: otra instancia tiene el lock')
      }
    })
  } catch (error) {
    logger.error('Error en actualización automática de Meta Ads:', error.message)
  } finally {
    metaAdsSyncRunning = false
  }
}

export async function startMetaAdsSyncCron() {
  if (metaAdsSyncTask) return
  activeMetaAdsSyncIntervalMinutes = await getMetaAdsSyncIntervalMinutes()
  const intervalLabel = formatMetaAdsSyncInterval(activeMetaAdsSyncIntervalMinutes)
  logger.info(`Iniciando sincronización automática de Meta Ads (${intervalLabel})`)

  metaAdsSyncTask = setInterval(() => {
    runMetaAdsSyncTick(activeMetaAdsSyncIntervalMinutes).catch(error => {
      logger.error('Error no manejado en sincronización automática de Meta Ads:', error.message)
    })
  }, activeMetaAdsSyncIntervalMinutes * 60 * 1000)
  metaAdsSyncTask.unref?.()

  logger.success(`Sincronización automática de Meta Ads configurada (${intervalLabel})`)
}

export function stopMetaAdsSyncCron() {
  if (!metaAdsSyncTask) return
  clearInterval(metaAdsSyncTask)
  metaAdsSyncTask = null
}

export function startMetaSocialRefreshCron() {
  if (metaSocialRefreshTask) return
  logger.info('Iniciando cron de perfiles Meta Social (diario)')

  // Refresca una vez al día los seguidores usados por perfiles sociales publicados.
  metaSocialRefreshTask = cron.schedule('17 5 * * *', async () => {
    if (isDeployShutdownStarted()) return
    try {
      if (!(await canRunBackgroundJob('meta_ads'))) return
    } catch (error) {
      logger.warn(`No se pudo validar el plan antes de refrescar perfiles Meta: ${error.message}`)
      return
    }
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

  logger.success('Cron de perfiles Meta Social configurado (diario)')
}

export function stopMetaSocialRefreshCron() {
  metaSocialRefreshTask?.stop()
  metaSocialRefreshTask?.destroy?.()
  metaSocialRefreshTask = null
}

// Compatibilidad con imports anteriores. Los nuevos registros llaman cada
// superficie por separado para que desconectar Social no apague Ads ni al revés.
export function startMetaSyncCron() {
  startMetaAdsSyncCron()
  startMetaSocialRefreshCron()
}

export function stopMetaSyncCron() {
  stopMetaAdsSyncCron()
  stopMetaSocialRefreshCron()
}
