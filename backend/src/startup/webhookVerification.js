import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Verifica y actualiza webhooks al iniciar el servidor
 * Se ejecuta automáticamente cuando el servidor detecta que está en producción
 */
export async function verifyAndUpdateWebhooks() {
  try {
    // Solo ejecutar si estamos en producción (Render)
    if (!process.env.RENDER_EXTERNAL_URL) {
      logger.info('📌 Servidor en desarrollo - webhooks usando localhost')
      return
    }

    logger.info('🚀 Servidor en producción - verificando webhooks...')

    // Obtener configuración de HighLevel
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      logger.warn('⚠️ No hay configuración de HighLevel - saltando verificación de webhooks')
      return
    }

    const productionUrl = process.env.RENDER_EXTERNAL_URL
    logger.info(`📍 URL de producción detectada: ${productionUrl}`)

    // Definir webhooks correctos - Usar los nombres EXACTOS que HighLevel espera
    const webhooks = {
      'webhook_contacts': `${productionUrl}/webhook/contact`,
      'webhook_payments': `${productionUrl}/webhook/payment`,
      'webhook_invoice': `${productionUrl}/webhook/invoice`,
      'webhook_refunds': `${productionUrl}/webhook/refund`,
      'webhook_appointments': `${productionUrl}/webhook/appointment`,
      'webhook_appointment_showed': `${productionUrl}/webhook/appointment/showed`,
      'webhook_whatsapp_attribution': `${productionUrl}/webhook/whatsapp/attribution`,
      'webhook_conversations': `${productionUrl}/webhook/conversation`
    }

    // Obtener custom values existentes
    const getUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
    const getResponse = await fetch(getUrl, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    if (!getResponse.ok) {
      logger.error('❌ No se pudieron obtener custom values de HighLevel')
      return
    }

    const getData = await getResponse.json()
    const existingCustomValues = getData.customValues || []

    // Verificar si algún webhook necesita actualización
    let needsUpdate = false
    const webhooksToUpdate = []

    for (const [name, correctUrl] of Object.entries(webhooks)) {
      const existing = existingCustomValues.find(cv => cv.name === name)

      if (!existing) {
        logger.info(`⚠️ Webhook no existe: ${name}`)
        webhooksToUpdate.push({ name, action: 'create', url: correctUrl })
        needsUpdate = true
      } else if (existing.value !== correctUrl) {
        logger.info(`⚠️ Webhook con URL incorrecta: ${name}`)
        logger.info(`   Actual: ${existing.value}`)
        logger.info(`   Correcta: ${correctUrl}`)
        webhooksToUpdate.push({ name, action: 'update', id: existing.id, url: correctUrl })
        needsUpdate = true
      } else {
        logger.info(`✅ Webhook correcto: ${name}`)
      }
    }

    // Si no hay nada que actualizar, salir
    if (!needsUpdate) {
      logger.info('✅ Todos los webhooks están configurados correctamente')
      return
    }

    // Actualizar webhooks que lo necesiten
    logger.info('🔄 Actualizando webhooks...')

    for (const webhook of webhooksToUpdate) {
      try {
        if (webhook.action === 'create') {
          // Crear nuevo
          const createUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
          const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.api_token}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: webhook.name,
              value: webhook.url
            })
          })

          if (createResponse.ok) {
            logger.info(`✅ Webhook creado: ${webhook.name}`)
          } else {
            const error = await createResponse.json()
            logger.error(`❌ Error creando ${webhook.name}:`, error)
          }
        } else {
          // Actualizar existente
          const updateUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues/${webhook.id}`
          const updateResponse = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${config.api_token}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: webhook.name,
              value: webhook.url
            })
          })

          if (updateResponse.ok) {
            logger.info(`✅ Webhook actualizado: ${webhook.name}`)
          } else {
            const error = await updateResponse.json()
            logger.error(`❌ Error actualizando ${webhook.name}:`, error)
          }
        }
      } catch (err) {
        logger.error(`❌ Error procesando webhook ${webhook.name}:`, err)
      }
    }

    // Limpiar webhooks obsoletos
    await cleanupObsoleteWebhooks(config, existingCustomValues)

    logger.info('✅ Verificación de webhooks completada')

  } catch (error) {
    logger.error('❌ Error en verificación de webhooks:', error)
  }
}

/**
 * Limpia webhooks obsoletos o duplicados
 */
async function cleanupObsoleteWebhooks(config, customValues) {
  // Lista de nombres de webhooks obsoletos (NO incluir los que sí necesitamos)
  const obsoleteNames = [
    'test_webhook_contacts',
    'Webhook - Contacts',
    'Webhook - Payments',
    'Webhook - Refunds',
    'Webhook - Appointments',
    'Webhook - WhatsApp Attribution'
  ]

  const toDelete = customValues.filter(cv =>
    obsoleteNames.includes(cv.name)
  )

  if (toDelete.length === 0) {
    return
  }

  logger.info(`🗑️ Limpiando ${toDelete.length} webhooks obsoletos...`)

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
        logger.info(`🗑️ Webhook obsoleto eliminado: ${cv.name}`)
      }
    } catch (err) {
      logger.error(`Error eliminando webhook obsoleto ${cv.name}:`, err)
    }
  }
}
