import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { syncWebhookCustomValues, getWebhookBaseUrl, getHighLevelConfig } from '../services/webhookSyncService.js'
import { OBSOLETE_WEBHOOK_NAMES } from '../config/constants.js'

/**
 * Actualiza los custom values de webhooks en HighLevel.
 * Delega en la fuente única de verdad (webhookSyncService).
 */
export const updateWebhooks = async (req, res) => {
  try {
    const config = await getHighLevelConfig()

    if (!config?.location_id || !config?.api_token) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      })
    }

    const { baseUrl, results, environment } = await syncWebhookCustomValues({ config })

    res.json({
      success: results.every(r => r.status !== 'error'),
      baseUrl,
      results,
      environment
    })

  } catch (error) {
    logger.error('Error en updateWebhooks:', error)
    res.status(500).json({
      success: false,
      error: 'Error al actualizar webhooks'
    })
  }
}

/**
 * Verifica el estado actual de los webhooks
 */
export const checkWebhooks = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      })
    }

    // Obtener custom values
    const url = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      throw new Error('Error obteniendo custom values')
    }

    const data = await response.json()
    const customValues = data.customValues || []

    // Filtrar webhooks
    const webhooks = customValues.filter(cv =>
      cv.name.includes('Webhook') ||
      cv.name.includes('webhook')
    )

    const currentUrl = getWebhookBaseUrl()
    const needsUpdate = webhooks.some(webhook => {
      return webhook.value && !webhook.value.startsWith(currentUrl)
    })

    res.json({
      success: true,
      currentUrl,
      needsUpdate,
      webhooks: webhooks.map(w => ({
        name: w.name,
        value: w.value,
        id: w.id,
        correctUrl: w.value?.startsWith(currentUrl)
      })),
      environment: process.env.RENDER_EXTERNAL_URL ? 'production' : 'development'
    })

  } catch (error) {
    logger.error('Error en checkWebhooks:', error)
    res.status(500).json({
      success: false,
      error: 'Error al verificar webhooks'
    })
  }
}

/**
 * Limpia webhooks duplicados o vacíos
 */
export const cleanupWebhooks = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      })
    }

    // Obtener custom values
    const url = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      throw new Error('Error obteniendo custom values')
    }

    const data = await response.json()
    const customValues = data.customValues || []

    // Identificar webhooks obsoletos (NO incluir los que sí necesitamos)
    const toDelete = customValues.filter(cv => OBSOLETE_WEBHOOK_NAMES.includes(cv.name))

    const results = []

    // Eliminar custom values obsoletos
    for (const cv of toDelete) {
      try {
        const deleteUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues/${cv.id}`
        const deleteResponse = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${config.api_token}`,
            'Version': '2021-07-28'
          }
        })

        if (deleteResponse.ok) {
          results.push({ name: cv.name, status: 'deleted' })
          logger.info(`🗑️ Webhook eliminado: ${cv.name}`)
        } else {
          results.push({ name: cv.name, status: 'error' })
          logger.error(`❌ Error eliminando ${cv.name}`)
        }
      } catch (err) {
        results.push({ name: cv.name, status: 'error', error: err.message })
      }
    }

    res.json({
      success: true,
      deleted: results.filter(r => r.status === 'deleted').length,
      results
    })

  } catch (error) {
    logger.error('Error en cleanupWebhooks:', error)
    res.status(500).json({
      success: false,
      error: 'Error al limpiar webhooks'
    })
  }
}
