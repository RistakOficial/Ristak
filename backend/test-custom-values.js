import fetch from 'node-fetch'
import { db } from './src/config/database.js'

async function testCustomValues() {
  try {
    // Obtener configuración de HighLevel
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    )

    if (!config) {
      console.error('No hay configuración de HighLevel guardada')
      process.exit(1)
    }

    console.log('📋 VERIFICANDO CUSTOM VALUES EN HIGHLEVEL')
    console.log('========================================')
    console.log('Location ID:', config.location_id)
    console.log('')

    // Obtener todos los custom values
    const url = `https://services.leadconnectorhq.com/locations/${config.location_id}/customValues`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      console.error('❌ Error obteniendo custom values:', response.status, response.statusText)
      const errorText = await response.text()
      console.error('Respuesta:', errorText)
      process.exit(1)
    }

    const data = await response.json()
    const customValues = data.customValues || []

    console.log(`✅ Total de custom values encontrados: ${customValues.length}`)
    console.log('')

    // Filtrar webhooks
    const webhookValues = customValues.filter(cv =>
      cv.name.toLowerCase().includes('webhook') ||
      cv.value?.includes('webhook')
    )

    console.log('🔗 WEBHOOKS CONFIGURADOS:')
    console.log('-------------------------')
    if (webhookValues.length === 0) {
      console.log('❌ No se encontraron webhooks configurados')
    } else {
      webhookValues.forEach(cv => {
        console.log(`📌 ${cv.name}:`)
        console.log(`   ID: ${cv.id}`)
        console.log(`   Valor: ${cv.value}`)
        console.log('')
      })
    }

    // Filtrar configuración de Meta
    const metaValues = customValues.filter(cv =>
      cv.name.toLowerCase().includes('facebook') ||
      cv.name.toLowerCase().includes('meta') ||
      cv.name.toLowerCase().includes('ad account')
    )

    console.log('📱 CONFIGURACIÓN DE META:')
    console.log('-------------------------')
    if (metaValues.length === 0) {
      console.log('❌ No se encontró configuración de Meta')
    } else {
      metaValues.forEach(cv => {
        const value = cv.value?.length > 50
          ? cv.value.substring(0, 50) + '...'
          : cv.value
        console.log(`📌 ${cv.name}: ${value}`)
      })
    }

    console.log('')
    console.log('🔍 TODOS LOS CUSTOM VALUES:')
    console.log('---------------------------')
    customValues.forEach(cv => {
      const value = cv.value?.length > 60
        ? cv.value.substring(0, 60) + '...'
        : cv.value
      console.log(`• ${cv.name}: ${value || '(vacío)'}`)
    })

    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error.message)
    process.exit(1)
  }
}

testCustomValues()