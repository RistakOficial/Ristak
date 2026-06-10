import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Obtiene la URL base correcta según el entorno
 */
function getWebhookBaseUrl() {
  // En producción (Render), usar la URL externa
  if (process.env.RENDER_EXTERNAL_URL) {
    logger.info(`Usando URL de producción: ${process.env.RENDER_EXTERNAL_URL}`)
    return process.env.RENDER_EXTERNAL_URL
  }

  // En desarrollo, usar localhost
  const port = process.env.PORT || 3001
  logger.info(`Usando URL de desarrollo: http://localhost:${port}`)
  return `http://localhost:${port}`
}

/**
 * Actualiza los custom values de webhooks en HighLevel
 */
export const updateWebhooks = async (req, res) => {
  try {
    // Obtener configuración de HighLevel
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      })
    }

    const baseUrl = getWebhookBaseUrl()
    logger.info('Actualizando webhooks con URL base:', baseUrl)

    // Definir los webhooks que necesitamos - Usar nombres EXACTOS que HighLevel espera
    const webhooks = {
      'webhook_contacts': `${baseUrl}/webhook/contact`,
      'webhook_payments': `${baseUrl}/webhook/payment`,
      'webhook_invoice': `${baseUrl}/webhook/invoice`,
      'webhook_refunds': `${baseUrl}/webhook/refund`,
      'webhook_appointments': `${baseUrl}/webhook/appointment`,
      'webhook_appointment_showed': `${baseUrl}/webhook/appointment/showed`,
      'webhook_whatsapp_attribution': `${baseUrl}/webhook/whatsapp/attribution`,
      'webhook_conversations': `${baseUrl}/webhook/conversation`
    }

    // Obtener custom values existentes
    const getUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
    const getResponse = await fetch(getUrl, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    let existingCustomValues = []
    if (getResponse.ok) {
      const getData = await getResponse.json()
      existingCustomValues = getData.customValues || []
      logger.info(`Encontrados ${existingCustomValues.length} custom values existentes`)
    }

    const results = []

    // Actualizar o crear cada webhook
    for (const [name, value] of Object.entries(webhooks)) {
      try {
        const existing = existingCustomValues.find(cv => cv.name === name)

        if (existing) {
          // Actualizar existente con PUT
          logger.info(`Actualizando webhook: ${name}`)
          const updateUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues/${existing.id}`
          const updateResponse = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${config.api_token}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, value })
          })

          if (updateResponse.ok) {
            results.push({ name, status: 'updated', value })
            logger.info(`✅ Webhook actualizado: ${name}`)
          } else {
            const errorData = await updateResponse.json()
            results.push({ name, status: 'error', error: errorData })
            logger.error(`❌ Error actualizando ${name}:`, errorData)
          }
        } else {
          // Crear nuevo con POST
          logger.info(`Creando webhook: ${name}`)
          const createUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
          const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.api_token}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, value })
          })

          if (createResponse.ok) {
            results.push({ name, status: 'created', value })
            logger.info(`✅ Webhook creado: ${name}`)
          } else {
            const errorData = await createResponse.json()
            results.push({ name, status: 'error', error: errorData })
            logger.error(`❌ Error creando ${name}:`, errorData)
          }
        }
      } catch (err) {
        results.push({ name, status: 'error', error: err.message })
        logger.error(`Error configurando ${name}:`, err)
      }
    }

    res.json({
      success: true,
      baseUrl,
      results,
      environment: process.env.RENDER_EXTERNAL_URL ? 'production' : 'development'
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

    // Identificar webhooks duplicados o vacíos
    const toDelete = []

    // Webhooks obsoletos (NO incluir los que sí necesitamos)
    const obsoleteNames = [
      'test_webhook_contacts',
      'Webhook - Contacts',
      'Webhook - Payments',
      'Webhook - Refunds',
      'Webhook - Appointments',
      'Webhook - WhatsApp Attribution'
    ]

    for (const cv of customValues) {
      // Eliminar solo webhooks obsoletos (no los vacíos que podríamos necesitar)
      if (obsoleteNames.includes(cv.name)) {
        toDelete.push(cv)
      }
    }

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
