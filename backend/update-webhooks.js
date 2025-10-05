import fetch from 'node-fetch'
import { db } from './src/config/database.js'

async function updateWebhooks() {
  try {
    // Obtener configuración de HighLevel
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      console.error('❌ No hay configuración de HighLevel guardada')
      process.exit(1)
    }

    console.log('📋 ACTUALIZANDO WEBHOOKS EN HIGHLEVEL')
    console.log('=====================================')
    console.log('Location ID:', config.location_id)
    console.log('')

    // Determinar URL base
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`
    console.log('🌐 URL Base:', baseUrl)
    console.log('')

    // Definir los webhooks correctos
    const webhooks = {
      'webhook_contacts': `${baseUrl}/webhook/contact`,
      'webhook_payments': `${baseUrl}/webhook/payment`,
      'webhook_refunds': `${baseUrl}/webhook/refund`,
      'webhook_appointments': `${baseUrl}/webhook/appointment`,
      'webhook_whatsapp_attribution': `${baseUrl}/webhook/whatsapp/attribution`
    }

    // Obtener custom values existentes
    console.log('📥 Obteniendo custom values existentes...')
    const getUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`
    const getResponse = await fetch(getUrl, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    if (!getResponse.ok) {
      console.error('❌ Error obteniendo custom values:', getResponse.statusText)
      process.exit(1)
    }

    const getData = await getResponse.json()
    const existingCustomValues = getData.customValues || []
    console.log(`✅ Encontrados ${existingCustomValues.length} custom values`)
    console.log('')

    // Actualizar cada webhook
    console.log('🔄 ACTUALIZANDO WEBHOOKS:')
    console.log('-------------------------')

    for (const [name, value] of Object.entries(webhooks)) {
      const existing = existingCustomValues.find(cv => cv.name === name)

      if (existing) {
        if (existing.value === value) {
          console.log(`✅ ${name}: Ya tiene la URL correcta`)
          console.log(`   ${value}`)
        } else {
          // Actualizar con PUT
          console.log(`🔄 ${name}: Actualizando...`)
          console.log(`   Anterior: ${existing.value || '(vacío)'}`)
          console.log(`   Nueva: ${value}`)

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
            console.log(`   ✅ Actualizado exitosamente`)
          } else {
            const error = await updateResponse.json()
            console.error(`   ❌ Error:`, error)
          }
        }
      } else {
        // Crear con POST
        console.log(`➕ ${name}: Creando nuevo custom value...`)
        console.log(`   URL: ${value}`)

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
          const createData = await createResponse.json()
          console.log(`   ✅ Creado con ID: ${createData.customValue?.id}`)
        } else {
          const error = await createResponse.json()
          console.error(`   ❌ Error:`, error)
        }
      }
      console.log('')
    }

    // Limpiar webhooks obsoletos
    console.log('🗑️ LIMPIANDO WEBHOOKS OBSOLETOS:')
    console.log('----------------------------------')

    const obsoleteNames = [
      'test_webhook_contacts',
      'Webhook - Contacts',
      'Webhook - Payments',
      'Webhook - Refunds',
      'Webhook - Appointments',
      'Webhook - WhatsApp Attribution'
    ]

    let deletedCount = 0
    for (const cv of existingCustomValues) {
      if (obsoleteNames.includes(cv.name)) {
        console.log(`🗑️ Eliminando: ${cv.name}`)

        const deleteUrl = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues/${cv.id}`
        const deleteResponse = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${config.api_token}`,
            'Version': '2021-07-28'
          }
        })

        if (deleteResponse.ok) {
          console.log(`   ✅ Eliminado`)
          deletedCount++
        } else {
          console.log(`   ❌ Error al eliminar`)
        }
      }
    }

    if (deletedCount === 0) {
      console.log('✅ No hay webhooks obsoletos para eliminar')
    } else {
      console.log(`✅ Se eliminaron ${deletedCount} webhooks obsoletos`)
    }

    console.log('')
    console.log('✅ ACTUALIZACIÓN COMPLETADA')

    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

updateWebhooks()