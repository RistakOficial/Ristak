import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { API_URLS, META_INSIGHTS_FIELDS, PAGINATION } from '../config/constants.js'
import { splitDateRangeIntoMonths, formatDate, daysAgo } from '../utils/dateUtils.js'

// Variable global para trackear el estado de sincronización
let syncProgress = {
  status: 'idle',
  step: '',
  total: 0,
  current: 0,
  message: '',
  monthsTotal: 0,
  monthsCurrent: 0
}

export function getMetaSyncProgress() {
  return syncProgress
}

function updateProgress(updates) {
  syncProgress = { ...syncProgress, ...updates }
  logger.info(`Progreso Meta: ${syncProgress.step} (Mes ${syncProgress.monthsCurrent}/${syncProgress.monthsTotal})`)
}

/**
 * Obtiene la configuración de Meta desde la base de datos
 */
export async function getMetaConfig() {
  try {
    const config = await db.get('SELECT * FROM meta_config LIMIT 1')
    return config
  } catch (error) {
    logger.error('Error obteniendo configuración de Meta:', error.message)
    throw error
  }
}

/**
 * Guarda la configuración de Meta en la base de datos
 */
export async function saveMetaConfig(adAccountId, accessToken, appId = null, appSecret = null) {
  try {
    const existing = await db.get('SELECT id FROM meta_config WHERE ad_account_id = ?', [adAccountId])

    if (existing) {
      await db.run(`
        UPDATE meta_config
        SET access_token = ?, app_id = ?, app_secret = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ad_account_id = ?
      `, [accessToken, appId, appSecret, adAccountId])
    } else {
      await db.run(`
        INSERT INTO meta_config (ad_account_id, access_token, app_id, app_secret)
        VALUES (?, ?, ?, ?)
      `, [adAccountId, accessToken, appId, appSecret])
    }

    logger.success('Configuración de Meta guardada')
    return { success: true }
  } catch (error) {
    logger.error('Error guardando configuración de Meta:', error.message)
    throw error
  }
}

/**
 * Obtiene insights de ads de Meta para un rango de fechas
 */
async function fetchMetaAdsInsights(accountId, accessToken, sinceDate, untilDate) {
  try {
    let allAds = []
    let nextUrl = null

    const initialUrl = `${API_URLS.META_AD_INSIGHTS(accountId.replace('act_', ''))}?level=ad&time_increment=1&fields=${META_INSIGHTS_FIELDS}&time_range=${JSON.stringify({ since: sinceDate, until: untilDate })}&limit=${PAGINATION.META_ADS_LIMIT}&access_token=${accessToken}`

    nextUrl = initialUrl

    while (nextUrl) {
      const response = await fetch(nextUrl)
      const data = await response.json()

      if (data.error) {
        throw new Error(`Error de Meta API: ${data.error.message}`)
      }

      const ads = data.data || []
      allAds = allAds.concat(ads)

      // Siguiente página
      nextUrl = data.paging?.next || null

      logger.debug(`Obtenidos ${ads.length} ads, total acumulado: ${allAds.length}`)

      // Pequeña pausa para no saturar la API
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return allAds
  } catch (error) {
    logger.error('Error obteniendo insights de Meta:', error.message)
    throw error
  }
}

/**
 * Guarda ads en la base de datos
 */
async function saveAdsToDatabase(ads, accountId) {
  try {
    for (const ad of ads) {
      // Calcular CPM y CTR
      const cpm = ad.reach > 0 ? (ad.spend / ad.reach) * 1000 : 0
      const ctr = ad.reach > 0 ? (ad.clicks / ad.reach) * 100 : 0

      await db.run(`
        INSERT INTO meta_ads (
          date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
          ad_id, ad_name, spend, reach, clicks, cpc, cpm, ctr
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, campaign_id, adset_id, ad_id) DO UPDATE SET
          campaign_name = excluded.campaign_name,
          adset_name = excluded.adset_name,
          ad_name = excluded.ad_name,
          spend = excluded.spend,
          reach = excluded.reach,
          clicks = excluded.clicks,
          cpc = excluded.cpc,
          cpm = excluded.cpm,
          ctr = excluded.ctr,
          updated_at = CURRENT_TIMESTAMP
      `, [
        ad.date_start,
        accountId,
        ad.campaign_id,
        ad.campaign_name || '',
        ad.adset_id,
        ad.adset_name || '',
        ad.ad_id,
        ad.ad_name || '',
        parseFloat(ad.spend || 0),
        parseInt(ad.reach || 0),
        parseInt(ad.clicks || 0),
        parseFloat(ad.cpc || 0),
        parseFloat(cpm || 0),
        parseFloat(ctr || 0)
      ])
    }
  } catch (error) {
    logger.error('Error guardando ads en base de datos:', error.message)
    throw error
  }
}

/**
 * Sincroniza ads desde una fecha específica hasta hoy
 */
export async function syncMetaAds(startDate) {
  try {
    const config = await getMetaConfig()
    if (!config) {
      throw new Error('No hay configuración de Meta. Configura Meta primero.')
    }

    const { ad_account_id, access_token } = config

    updateProgress({
      status: 'syncing',
      step: 'Preparando sincronización',
      current: 0,
      total: 0,
      monthsCurrent: 0,
      monthsTotal: 0,
      message: 'Preparando sincronización de Meta Ads...'
    })

    // Usar fecha actual para obtener datos de hoy
    const endDate = new Date()
    const start = new Date(startDate)

    // Dividir en chunks mensuales
    const dateChunks = splitDateRangeIntoMonths(start, endDate)

    logger.info(`Sincronizando ${dateChunks.length} meses de datos...`)

    syncProgress.monthsTotal = dateChunks.length

    // Borrar TODOS los ads existentes antes de sincronizar
    logger.info('Borrando ads existentes...')
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [ad_account_id])

    // Procesar cada chunk mensual
    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i]

      updateProgress({
        step: `Sincronizando mes ${i + 1} de ${dateChunks.length}`,
        monthsCurrent: i + 1,
        message: `Obteniendo datos del ${chunk.since} al ${chunk.until}...`
      })

      const ads = await fetchMetaAdsInsights(ad_account_id, access_token, chunk.since, chunk.until)

      logger.info(`Mes ${i + 1}/${dateChunks.length}: ${ads.length} ads obtenidos`)

      if (ads.length > 0) {
        await saveAdsToDatabase(ads, ad_account_id)
      }

      updateProgress({
        current: i + 1,
        total: dateChunks.length,
        message: `Mes ${i + 1}/${dateChunks.length} completado`
      })
    }

    syncProgress = {
      status: 'completed',
      step: 'Completado',
      total: 100,
      current: 100,
      monthsTotal: dateChunks.length,
      monthsCurrent: dateChunks.length,
      message: 'Sincronización de Meta Ads completada exitosamente'
    }

    logger.success('Sincronización de Meta Ads completada')
    return { success: true }
  } catch (error) {
    syncProgress = {
      status: 'error',
      step: 'Error',
      total: 0,
      current: 0,
      message: error.message
    }
    logger.error('Error en sincronización de Meta Ads:', error.message)
    throw error
  }
}

/**
 * Actualiza ads recientes (últimos 7 días)
 * Esta función se ejecuta cada hora desde el cron job
 */
export async function updateRecentAds() {
  try {
    const config = await getMetaConfig()
    if (!config) {
      logger.warn('No hay configuración de Meta. Saltando actualización de ads recientes.')
      return { success: false, message: 'No config' }
    }

    const { ad_account_id, access_token } = config

    // Últimos 7 días hasta hoy
    const startDate = daysAgo(7)
    const endDate = new Date()

    logger.info(`Actualizando ads recientes (últimos 7 días hasta hoy)...`)

    const ads = await fetchMetaAdsInsights(
      ad_account_id,
      access_token,
      formatDate(startDate),
      formatDate(endDate)
    )

    logger.info(`${ads.length} ads obtenidos para actualización`)

    if (ads.length > 0) {
      await saveAdsToDatabase(ads, ad_account_id)
    }

    logger.success('Ads recientes actualizados correctamente')
    return { success: true, count: ads.length }
  } catch (error) {
    logger.error('Error actualizando ads recientes:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Verifica si el token de Meta es válido
 */
export async function verifyMetaToken(accessToken) {
  try {
    const response = await fetch(`${API_URLS.META_TOKEN_DEBUG}?input_token=${accessToken}&access_token=${accessToken}`)
    const data = await response.json()

    if (data.error) {
      return { valid: false, error: data.error.message }
    }

    const isValid = data.data?.is_valid || false
    const expiresAt = data.data?.expires_at ? new Date(data.data.expires_at * 1000) : null

    return {
      valid: isValid,
      expiresAt,
      scopes: data.data?.scopes || []
    }
  } catch (error) {
    logger.error('Error verificando token de Meta:', error.message)
    return { valid: false, error: error.message }
  }
}
