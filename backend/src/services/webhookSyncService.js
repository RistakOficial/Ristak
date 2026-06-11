import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  API_URLS,
  WEBHOOK_CUSTOM_VALUE_MAP,
  OBSOLETE_WEBHOOK_NAMES
} from '../config/constants.js'

/**
 * Obtiene la URL base pública según el entorno.
 * En producción (Render) usa RENDER_EXTERNAL_URL; en local, localhost.
 */
export function getWebhookBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL
  }
  const port = process.env.PORT || 3001
  return `http://localhost:${port}`
}

/**
 * Construye el mapa nombre -> URL completa de los custom values de webhook.
 * @param {string} baseUrl
 * @returns {Record<string, string>}
 */
export function buildWebhookCustomValues(baseUrl) {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  return Object.fromEntries(
    WEBHOOK_CUSTOM_VALUE_MAP.map(({ name, path }) => [name, `${cleanBase}${path}`])
  )
}

/**
 * Lee la configuración de HighLevel (single-tenant).
 * @returns {Promise<{location_id: string, api_token: string} | null>}
 */
export async function getHighLevelConfig() {
  return db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
}

/**
 * Crea o actualiza en HighLevel todos los custom values de webhook definidos
 * en WEBHOOK_CUSTOM_VALUE_MAP, y limpia los nombres obsoletos.
 *
 * Esta es la ÚNICA implementación real de sincronización. La llaman:
 *  - syncCustomValues (botón de Configuración)
 *  - updateWebhooks (endpoint manual /api/webhook-config/update)
 *  - verifyAndUpdateWebhooks (arranque en producción)
 *
 * @param {{ config: {location_id: string, api_token: string}, baseUrl?: string }} params
 * @returns {Promise<{ baseUrl: string, results: Array, environment: string }>}
 */
export async function syncWebhookCustomValues({ config, baseUrl } = {}) {
  if (!config?.location_id || !config?.api_token) {
    throw new Error('Configuración de HighLevel no encontrada (location_id / api_token)')
  }

  const resolvedBase = baseUrl || getWebhookBaseUrl()
  const webhooks = buildWebhookCustomValues(resolvedBase)

  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Version': '2021-07-28'
  }
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }

  logger.info(`🔗 Sincronizando custom values de webhook con base: ${resolvedBase}`)

  // Obtener custom values existentes
  const listUrl = API_URLS.HIGHLEVEL_CUSTOM_VALUES(config.location_id)
  const getResponse = await fetch(listUrl, { headers })

  if (!getResponse.ok) {
    const errorData = await getResponse.text()
    throw new Error(`No se pudieron obtener custom values de HighLevel: ${getResponse.status} ${errorData}`)
  }

  const getData = await getResponse.json()
  const existingCustomValues = getData.customValues || []
  logger.info(`📋 ${existingCustomValues.length} custom values existentes en HighLevel`)

  const results = []

  for (const [name, value] of Object.entries(webhooks)) {
    try {
      const existing = existingCustomValues.find(cv => cv.name === name)

      if (existing && existing.value === value) {
        results.push({ name, status: 'unchanged', value })
        logger.info(`✅ Webhook ya correcto: ${name}`)
        continue
      }

      if (existing) {
        const updateUrl = API_URLS.HIGHLEVEL_CUSTOM_VALUE(config.location_id, existing.id)
        const updateResponse = await fetch(updateUrl, {
          method: 'PUT',
          headers: jsonHeaders,
          body: JSON.stringify({ name, value })
        })

        if (updateResponse.ok) {
          results.push({ name, status: 'updated', value })
          logger.info(`🔄 Webhook actualizado: ${name}`)
        } else {
          const errorData = await updateResponse.json().catch(() => ({}))
          results.push({ name, status: 'error', error: errorData })
          logger.error(`❌ Error actualizando ${name}:`, errorData)
        }
      } else {
        const createResponse = await fetch(listUrl, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ name, value })
        })

        if (createResponse.ok) {
          results.push({ name, status: 'created', value })
          logger.info(`✨ Webhook creado: ${name}`)
        } else {
          const errorData = await createResponse.json().catch(() => ({}))
          results.push({ name, status: 'error', error: errorData })
          logger.error(`❌ Error creando ${name}:`, errorData)
        }
      }
    } catch (err) {
      results.push({ name, status: 'error', error: err.message })
      logger.error(`❌ Error configurando ${name}:`, err)
    }
  }

  // Limpiar nombres obsoletos/duplicados
  await cleanupObsoleteWebhooks(config, existingCustomValues)

  return {
    baseUrl: resolvedBase,
    results,
    environment: process.env.RENDER_EXTERNAL_URL ? 'production' : 'development'
  }
}

/**
 * Elimina custom values con nombres obsoletos/duplicados.
 */
export async function cleanupObsoleteWebhooks(config, customValues) {
  const toDelete = customValues.filter(cv => OBSOLETE_WEBHOOK_NAMES.includes(cv.name))
  if (toDelete.length === 0) return

  logger.info(`🗑️ Limpiando ${toDelete.length} webhooks obsoletos...`)
  for (const cv of toDelete) {
    try {
      const deleteUrl = API_URLS.HIGHLEVEL_CUSTOM_VALUE(config.location_id, cv.id)
      const deleteResponse = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${config.api_token}`,
          'Version': '2021-07-28'
        }
      })
      if (deleteResponse.ok) {
        logger.info(`🗑️ Webhook obsoleto eliminado: ${cv.name}`)
      }
    } catch (err) {
      logger.error(`Error eliminando webhook obsoleto ${cv.name}:`, err)
    }
  }
}
