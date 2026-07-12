import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getMetaApiVersion, setMetaApiVersion } from '../config/constants.js'

const DEFAULT_META_API_VERSION = 'v25.0'
const MIN_META_API_MAJOR = 15
const MAX_META_API_MAJOR = 30
// (META-004) Techo de auto-detección: nunca subir por encima de la versión con la
// que la app fue probada (DEFAULT_META_API_VERSION). Que un endpoint raíz de Graph
// "responda" para vXX no garantiza que esa versión sea GA ni compatible con los
// endpoints de ads que usamos; saltar a una más nueva sin validar puede romper la
// sincronización. Se permite override explícito vía META_API_AUTODETECT_MAX_MAJOR.
const AUTODETECT_MAX_MAJOR = (() => {
  const known = Number(String(DEFAULT_META_API_VERSION).match(/^v(\d+)\.0$/)?.[1] || MAX_META_API_MAJOR)
  const override = Number(process.env.META_API_AUTODETECT_MAX_MAJOR)
  const ceiling = Number.isFinite(override) && override > 0 ? override : known
  return Math.min(MAX_META_API_MAJOR, Math.max(MIN_META_API_MAJOR, ceiling))
})()

export function normalizeMetaApiVersion(version) {
  const cleanVersion = String(version || '').trim().toLowerCase()
  if (!cleanVersion) return ''

  const prefixedVersion = cleanVersion.startsWith('v') ? cleanVersion : `v${cleanVersion}`
  const match = prefixedVersion.match(/^v(\d+)(?:\.0)?$/)

  return match ? `v${match[1]}.0` : ''
}

export function compareMetaApiVersions(a, b) {
  const majorA = Number(normalizeMetaApiVersion(a).match(/^v(\d+)\.0$/)?.[1] || 0)
  const majorB = Number(normalizeMetaApiVersion(b).match(/^v(\d+)\.0$/)?.[1] || 0)

  return majorA - majorB
}

export function getPinnedMetaApiVersion() {
  return normalizeMetaApiVersion(process.env.META_API_VERSION)
}

/**
 * Detecta la versión más reciente de Meta API disponible
 * Prueba desde v30.0 hacia abajo hasta encontrar una valida
 */
export async function detectLatestVersion(fallbackVersion = DEFAULT_META_API_VERSION) {
  logger.info('🔍 Detectando versión más reciente de Meta API...')

  const normalizedFallback = normalizeMetaApiVersion(fallbackVersion) || DEFAULT_META_API_VERSION

  // (META-004) Probar desde el techo conocido-bueno hacia abajo (no desde v30):
  // así la detección sirve para RECUPERARSE a una versión soportada, nunca para
  // saltar a una más nueva sin validar.
  const versionsToTest = []
  for (let major = AUTODETECT_MAX_MAJOR; major >= MIN_META_API_MAJOR; major--) {
    versionsToTest.push(`v${major}.0`)
  }

  for (const version of versionsToTest) {
    const isValid = await testVersion(version)
    if (isValid) {
      logger.success(`✅ Versión más reciente detectada: ${version}`)
      return version
    }
  }

  // Si ninguna funciona, conservar la version actual/fallback para no degradar por una falla externa.
  logger.warn(`⚠️ No se pudo detectar versión, conservando ${normalizedFallback}`)
  return normalizedFallback
}

/**
 * Prueba si una versión específica de la API está disponible
 */
async function testVersion(version) {
  try {
    // Sin token: las versiones existentes responden "Unsupported get request".
    // Las inexistentes responden "Object with ID 'vXX.0' does not exist".
    const url = `https://graph.facebook.com/${version}`
    const response = await fetch(url)
    const data = await response.json()

    const message = data.error?.message || ''
    return response.status === 400 &&
      data.error?.code === 100 &&
      message.includes('Unsupported get request') &&
      !message.includes(`Object with ID '${version}' does not exist`)
  } catch (error) {
    return false
  }
}

export async function isMetaApiVersionAvailable(version) {
  const normalizedVersion = normalizeMetaApiVersion(version)
  return normalizedVersion ? await testVersion(normalizedVersion) : false
}

/**
 * Obtiene la versión actual guardada en BD
 */
export async function getCurrentVersion() {
  try {
    const pinnedVersion = getPinnedMetaApiVersion()
    if (pinnedVersion) {
      return pinnedVersion
    }

    const result = await db.get(
      'SELECT version FROM meta_api_version ORDER BY updated_at DESC LIMIT 1'
    )
    return normalizeMetaApiVersion(result?.version) || DEFAULT_META_API_VERSION
  } catch (error) {
    logger.error('Error obteniendo versión actual:', error.message)
    return normalizeMetaApiVersion(getMetaApiVersion()) || DEFAULT_META_API_VERSION
  }
}

/**
 * Guarda una nueva versión en BD
 */
export async function saveVersion(version) {
  try {
    const normalizedVersion = normalizeMetaApiVersion(version)
    if (!normalizedVersion) {
      throw new Error(`Versión Meta API inválida: ${version}`)
    }

    // Usar CURRENT_TIMESTAMP directamente en lugar de intentar insertar el valor
    await db.run(
      'INSERT INTO meta_api_version (version, updated_at) VALUES (?, CURRENT_TIMESTAMP)',
      [normalizedVersion]
    )

    // También actualizar en memoria
    setMetaApiVersion(normalizedVersion)

    logger.success(`📝 Versión ${normalizedVersion} guardada en BD`)
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
 * Respeta META_API_VERSION si esta definido; si no, usa la ultima version guardada.
 */
export async function initializeVersion() {
  try {
    const pinnedVersion = getPinnedMetaApiVersion()
    if (pinnedVersion) {
      logger.info(`🔧 Versión Meta API fijada por META_API_VERSION: ${pinnedVersion}`)
      setMetaApiVersion(pinnedVersion)
      return pinnedVersion
    }

    const result = await db.get(
      'SELECT version FROM meta_api_version ORDER BY updated_at DESC LIMIT 1'
    )
    const storedVersion = normalizeMetaApiVersion(result?.version)

    if (storedVersion) {
      setMetaApiVersion(storedVersion)
      logger.info(`✅ Versión de Meta API inicializada desde BD: ${storedVersion}`)
      return storedVersion
    }

    setMetaApiVersion(DEFAULT_META_API_VERSION)
    await saveVersion(DEFAULT_META_API_VERSION)

    logger.info(`✅ Versión de Meta API inicializada con fallback: ${DEFAULT_META_API_VERSION}`)
    return DEFAULT_META_API_VERSION
  } catch (error) {
    logger.error('Error inicializando versión:', error.message)
    const fallback = normalizeMetaApiVersion(getMetaApiVersion()) || DEFAULT_META_API_VERSION
    setMetaApiVersion(fallback)
    return fallback
  }
}
