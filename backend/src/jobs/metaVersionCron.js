import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import {
  compareMetaApiVersions,
  detectLatestVersion,
  getCurrentVersion,
  getPinnedMetaApiVersion,
  isMetaApiVersionAvailable,
  saveVersion
} from '../services/metaVersionService.js'

let metaVersionTask = null

/**
 * Actualiza la versión de Meta API si es necesario.
 */
export async function updateMetaVersion({ source = 'manual' } = {}) {
  try {
    logger.info(`🔄 Verificando actualización de versión de Meta API (${source})...`)

    const pinnedVersion = getPinnedMetaApiVersion()
    if (pinnedVersion) {
      logger.info(`📌 META_API_VERSION está fijada en ${pinnedVersion}; se omite actualización automática`)
      return {
        updated: false,
        pinned: true,
        version: pinnedVersion,
        source
      }
    }

    const currentVersion = await getCurrentVersion()
    const latestVersion = await detectLatestVersion(currentVersion)

    if (currentVersion === latestVersion) {
      logger.info(`✅ Ya tienes la versión más reciente: ${currentVersion}`)
      return {
        updated: false,
        version: currentVersion,
        source
      }
    }

    const detectedOlderThanCurrent = compareMetaApiVersions(latestVersion, currentVersion) < 0
    if (detectedOlderThanCurrent && await isMetaApiVersionAvailable(currentVersion)) {
      logger.warn(`⚠️ Meta reportó ${latestVersion}, pero la app usa ${currentVersion}; no se hará downgrade`)
      return {
        updated: false,
        version: currentVersion,
        detectedVersion: latestVersion,
        source
      }
    }

    if (detectedOlderThanCurrent) {
      logger.warn(`⚠️ La versión guardada ${currentVersion} no está disponible; se corregirá a ${latestVersion}`)
    }

    // Guardar nueva versión
    const saved = await saveVersion(latestVersion)
    if (!saved) {
      return {
        updated: false,
        error: `No se pudo guardar la versión ${latestVersion}`,
        version: currentVersion,
        detectedVersion: latestVersion,
        source
      }
    }

    logger.success(`
      ✨ VERSIÓN DE META API ACTUALIZADA ✨
      Anterior: ${currentVersion}
      Nueva: ${latestVersion}
    `)

    return {
      updated: true,
      oldVersion: currentVersion,
      newVersion: latestVersion,
      source
    }
  } catch (error) {
    logger.error('Error actualizando versión de Meta API:', error.message)
    return {
      updated: false,
      error: error.message,
      source
    }
  }
}

/**
 * Inicia el cron job para actualización de versión
 * Se ejecuta el día 1 de cada mes a las 3:00 AM
 */
export function startMetaVersionCron() {
  if (metaVersionTask) return
  // Ejecutar el día 1 de cada mes a las 3:00 AM
  metaVersionTask = cron.schedule('0 3 1 * *', async () => {
    if (isDeployShutdownStarted()) return
    logger.info('⏰ Ejecutando verificación mensual de versión de Meta API...')

    const result = await trackDeployDrainWork(
      'cron:meta-version',
      () => updateMetaVersion({ source: 'monthly-cron' }),
      'monthly-cron'
    )

    if (result.updated) {
      logger.success(`✅ Cron: Versión actualizada de ${result.oldVersion} a ${result.newVersion}`)
    }
  }, {
    timezone: 'America/Mexico_City'
  })

  logger.info('✅ Cron de actualización de versión Meta API iniciado (día 1 de cada mes a las 3 AM)')
}

export function stopMetaVersionCron() {
  if (!metaVersionTask) return
  metaVersionTask.stop()
  metaVersionTask.destroy?.()
  metaVersionTask = null
}

/**
 * Función para forzar actualización manual (para testing)
 */
export async function forceMetaVersionUpdate(source = 'manual-force') {
  logger.warn('⚠️ Forzando actualización manual de versión...')
  return await updateMetaVersion({ source })
}
