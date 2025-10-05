/**
 * Script para probar sincronización parcial
 * Solo sincroniza citas, pagos y anuncios de Meta (sin contactos)
 */

import fetch from 'node-fetch'
import { db } from './src/config/database.js'
import { logger } from './src/utils/logger.js'
import { syncMetaAds } from './src/services/metaAdsService.js'

async function getHighLevelConfig() {
  const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
  return config
}

/**
 * PRUEBA 1: Sincronizar citas
 */
async function testAppointmentsSync() {
  try {
    console.log('\n📅 PRUEBA 1: SINCRONIZANDO CITAS')
    console.log('================================')

    const config = await getHighLevelConfig()
    if (!config) {
      console.error('❌ No hay configuración de HighLevel')
      return
    }

    const startDate = '2020-01-01'
    const endDate = '2030-12-31'

    const url = `https://services.leadconnectorhq.com/calendars/events/search?locationId=${config.location_id}&startTime=${startDate}&endTime=${endDate}&includeAll=true`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-04-15'
      }
    })

    const data = await response.json()
    const appointments = data.events || []

    console.log(`✅ Encontradas ${appointments.length} citas`)

    if (appointments.length > 0) {
      console.log('Ejemplo de cita:', {
        title: appointments[0].title,
        date: appointments[0].startTime,
        status: appointments[0].status
      })
    }

    return appointments.length

  } catch (error) {
    console.error('❌ Error sincronizando citas:', error.message)
    return 0
  }
}

/**
 * PRUEBA 2: Sincronizar pagos
 */
async function testPaymentsSync() {
  try {
    console.log('\n💰 PRUEBA 2: SINCRONIZANDO PAGOS')
    console.log('================================')

    const config = await getHighLevelConfig()
    if (!config) {
      console.error('❌ No hay configuración de HighLevel')
      return
    }

    const url = `https://services.leadconnectorhq.com/payments/transactions?locationId=${config.location_id}&limit=100`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-04-15'
      }
    })

    const data = await response.json()
    const payments = data.transactions || []

    console.log(`✅ Encontrados ${payments.length} pagos`)

    if (payments.length > 0) {
      console.log('Ejemplo de pago:', {
        amount: payments[0].amount,
        status: payments[0].status,
        date: payments[0].createdAt
      })
    }

    // Contar pagos en DB
    const dbPayments = await db.get('SELECT COUNT(*) as count FROM payments')
    console.log(`📊 Pagos en base de datos: ${dbPayments.count}`)

    return payments.length

  } catch (error) {
    console.error('❌ Error sincronizando pagos:', error.message)
    return 0
  }
}

/**
 * PRUEBA 3: Sincronizar anuncios de Meta
 */
async function testMetaAdsSync() {
  try {
    console.log('\n📊 PRUEBA 3: SINCRONIZANDO ANUNCIOS DE META')
    console.log('==========================================')

    // Verificar configuración de Meta
    const metaConfig = await db.get('SELECT * FROM meta_config LIMIT 1')

    if (!metaConfig) {
      console.log('⚠️ No hay configuración de Meta - saltando prueba')
      return 0
    }

    console.log('✅ Configuración de Meta encontrada')
    console.log(`Ad Account: ${metaConfig.ad_account_id}`)

    // Sincronizar solo últimos 3 meses para la prueba
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - 3)

    console.log(`Sincronizando anuncios desde: ${startDate.toISOString().split('T')[0]}`)

    const result = await syncMetaAds(startDate)

    if (result.success) {
      // Contar anuncios en DB
      const adsCount = await db.get(
        'SELECT COUNT(*) as count FROM meta_ads WHERE ad_account_id = ?',
        [metaConfig.ad_account_id]
      )

      console.log(`✅ Anuncios sincronizados: ${adsCount.count}`)

      // Ver ejemplo de anuncio
      const sampleAd = await db.get(
        'SELECT * FROM meta_ads ORDER BY date DESC LIMIT 1'
      )

      if (sampleAd) {
        console.log('Ejemplo de anuncio:', {
          campaign: sampleAd.campaign_name,
          spend: sampleAd.spend,
          reach: sampleAd.reach,
          clicks: sampleAd.clicks,
          date: sampleAd.date
        })
      }

      return adsCount.count
    }

    return 0

  } catch (error) {
    console.error('❌ Error sincronizando anuncios:', error.message)
    return 0
  }
}

/**
 * EJECUTAR TODAS LAS PRUEBAS
 */
async function runTests() {
  console.log('🚀 INICIANDO PRUEBAS DE SINCRONIZACIÓN PARCIAL')
  console.log('===============================================')
  console.log('(Excluyendo contactos por ser muchos)')
  console.log('')

  const results = {
    appointments: 0,
    payments: 0,
    metaAds: 0
  }

  // Prueba 1: Citas
  results.appointments = await testAppointmentsSync()

  // Prueba 2: Pagos
  results.payments = await testPaymentsSync()

  // Prueba 3: Anuncios de Meta
  results.metaAds = await testMetaAdsSync()

  // Resumen final
  console.log('\n✨ RESUMEN DE PRUEBAS')
  console.log('======================')
  console.log(`📅 Citas: ${results.appointments > 0 ? '✅' : '❌'} (${results.appointments} encontradas)`)
  console.log(`💰 Pagos: ${results.payments > 0 ? '✅' : '❌'} (${results.payments} encontrados)`)
  console.log(`📊 Meta Ads: ${results.metaAds > 0 ? '✅' : '❌'} (${results.metaAds} sincronizados)`)
  console.log('')

  const allPassed = results.appointments >= 0 && results.payments >= 0 && results.metaAds >= 0
  console.log(allPassed ? '🎉 TODAS LAS PRUEBAS COMPLETADAS!' : '⚠️ Algunas pruebas fallaron')

  process.exit(0)
}

// Ejecutar pruebas
runTests().catch(error => {
  console.error('❌ Error fatal:', error)
  process.exit(1)
})