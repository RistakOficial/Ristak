import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { setMetaApiVersion } from '../config/constants.js'

/**
 * Detecta la versión más reciente de Meta API disponible
 * Prueba desde v30.0 hacia abajo hasta encontrar una válida
 */
export async function detectLatestVersion() {
  logger.info('🔍 Detectando versión más reciente de Meta API...')

  // Probar versiones desde v30.0 hasta v15.0
  const versionsToTest = []
  for (let major = 30; major >= 15; major--) {
    versionsToTest.push(`v${major}.0`)
  }

  for (const version of versionsToTest) {
    const isValid = await testVersion(version)
    if (isValid) {
      logger.success(`✅ Versión más reciente detectada: ${version}`)
      return version
    }
  }

  // Si ninguna funciona, usar v23.0 como fallback
  logger.warn('⚠️ No se pudo detectar versión, usando fallback v23.0')
  return 'v23.0'
}

/**
 * Prueba si una versión específica de la API está disponible
 */
async function testVersion(version) {
  try {
    // Usar un endpoint simple que siempre existe
    const url = `https://graph.facebook.com/${version}/me?access_token=test`
    const response = await fetch(url)
    const data = await response.json()

    // Si el error es 190 (token inválido) = la versión existe ✅
    // Si el error es 2500 (versión no existe) = versión no disponible ❌
    if (data.error) {
      return data.error.code === 190 // Token inválido = versión existe
    }

    return false
  } catch (error) {
    return false
  }
}

/**
 * Obtiene la versión actual guardada en BD
 */
export async function getCurrentVersion() {
  try {
    const result = await db.get(
      'SELECT version FROM meta_api_version ORDER BY updated_at DESC LIMIT 1'
    )
    return result?.version || 'v23.0'
  } catch (error) {
    logger.error('Error obteniendo versión actual:', error.message)
    return 'v23.0'
  }
}

/**
 * Guarda una nueva versión en BD
 */
export async function saveVersion(version) {
  try {
    // Usar CURRENT_TIMESTAMP directamente en lugar de intentar insertar el valor
    await db.run(
      'INSERT INTO meta_api_version (version, updated_at) VALUES (?, CURRENT_TIMESTAMP)',
      [version]
    )

    // También actualizar en memoria
    setMetaApiVersion(version)

    logger.success(`📝 Versión ${version} guardada en BD`)
    return true
  } catch (error) {
    logger.error('Error guardando versión:', error.message)
    return false
  }
}

/**
 * Obtiene el historial de versiones
 */
export async function getVersionHistory(limit = 10) {
  try {
    const history = await db.all(
      'SELECT version, updated_at FROM meta_api_version ORDER BY updated_at DESC LIMIT ?',
      [limit]
    )
    return history || []
  } catch (error) {
    logger.error('Error obteniendo historial de versiones:', error.message)
    return []
  }
}

/**
 * Inicializa la versión desde BD al arrancar el servidor
 * SIEMPRE usa v23.0 para evitar problemas con versiones inválidas
 */
export async function initializeVersion() {
  try {
    // FORZAR v23.0 siempre (versión estable conocida)
    const stableVersion = 'v23.0'

    logger.info(`🔧 Forzando versión estable: ${stableVersion}`)

    setMetaApiVersion(stableVersion)
    await saveVersion(stableVersion)

    logger.info(`✅ Versión de Meta API inicializada: ${stableVersion}`)
    return stableVersion
  } catch (error) {
    logger.error('Error inicializando versión:', error.message)
    const fallback = 'v23.0'
    setMetaApiVersion(fallback)
    return fallback
  }
}