import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { encrypt, decrypt, isEncrypted } from '../utils/encryption.js'
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
 * DESENCRIPTA el access_token antes de devolverlo
 */
export async function getMetaConfig() {
  try {
    const config = await db.get('SELECT * FROM meta_config LIMIT 1')

    if (!config) {
      return null
    }

    // Desencriptar el access_token
    if (config.access_token) {
      try {
        // Si está encriptado, desencriptarlo
        if (isEncrypted(config.access_token)) {
          config.access_token = decrypt(config.access_token)
        } else {
          // Si NO está encriptado (tokens viejos), encriptarlo ahora
          logger.warn('⚠️ Token de Meta NO estaba encriptado. Encriptando ahora...')
          const plainToken = config.access_token
          const encryptedToken = encrypt(plainToken)

          // Actualizar en BD con token encriptado
          await db.run(
            'UPDATE meta_config SET access_token = ? WHERE id = ?',
            [encryptedToken, config.id]
          )

          // Devolver el token plano para usar
          config.access_token = plainToken
        }
      } catch (error) {
        logger.error('Error al desencriptar token de Meta:', error.message)
        throw new Error('No se pudo desencriptar el token. Verifica ENCRYPTION_MASTER_KEY.')
      }
    }

    // También desencriptar app_secret si existe
    if (config.app_secret && isEncrypted(config.app_secret)) {
      try {
        config.app_secret = decrypt(config.app_secret)
      } catch (error) {
        logger.warn('No se pudo desencriptar app_secret:', error.message)
      }
    }

    return config
  } catch (error) {
    logger.error('Error obteniendo configuración de Meta:', error.message)
    throw error
  }
}

/**
 * Obtiene información de timezone de la cuenta de Meta Ads
 */
async function getAdAccountTimezone(adAccountId, accessToken) {
  try {
    const accountIdClean = adAccountId.replace('act_', '')
    const url = `${API_URLS.META_GRAPH}/act_${accountIdClean}?fields=timezone_id,timezone_name,timezone_offset_hours_utc&access_token=${accessToken}`

    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      logger.warn('No se pudo obtener timezone de Meta:', data.error.message)
      return null
    }

    return {
      timezone_id: data.timezone_id || null,
      timezone_name: data.timezone_name || null,
      timezone_offset_hours_utc: data.timezone_offset_hours_utc || null
    }
  } catch (error) {
    logger.warn('Error obteniendo timezone de cuenta Meta:', error.message)
    return null
  }
}

/**
 * Sincroniza custom values de Meta en HighLevel
 */
async function syncMetaCustomValues(adAccountId, accessToken, pixelId, appId, appSecret) {
  try {
    // Obtener configuración de HighLevel
    const ghlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')

    if (!ghlConfig || !ghlConfig.location_id || !ghlConfig.api_token) {
      logger.warn('⚠️ No hay configuración de HighLevel. Saltando sincronización de custom values de Meta.')
      return { success: false, message: 'No HighLevel config' }
    }

    logger.info('📝 Sincronizando custom values de Meta en HighLevel...')

    // Custom values a crear/actualizar
    const customValues = {
      'Facebook - Ad Account ID': adAccountId,
      'Facebook - App Access Token': accessToken,
      'Facebook - Pixel ID': pixelId || '',
      'Facebook - App ID': appId || '',
      'Facebook - App Secret': appSecret || ''
    }

    // Obtener custom values existentes
    const getResponse = await fetch(
      `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues`,
      {
        headers: {
          'Authorization': `Bearer ${ghlConfig.api_token}`,
          'Version': '2021-07-28'
        }
      }
    )

    let existingCustomValues = []
    if (getResponse.ok) {
      const getData = await getResponse.json()
      existingCustomValues = getData.customValues || []
    }

    const results = []

    // Crear o actualizar cada custom value
    for (const [name, value] of Object.entries(customValues)) {
      try {
        const existing = existingCustomValues.find(cv => cv.name === name)

        if (existing) {
          // Actualizar existente con PUT
          logger.info(`  Actualizando: ${name}`)
          const updateResponse = await fetch(
            `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues/${existing.id}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${ghlConfig.api_token}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
              },
              body: JSON.stringify({ name, value })
            }
          )

          if (updateResponse.ok) {
            results.push({ name, status: 'updated' })
            logger.info(`  ✅ ${name} actualizado`)
          } else {
            const errorData = await updateResponse.json()
            results.push({ name, status: 'error', error: errorData })
            logger.error(`  ❌ Error actualizando ${name}:`, errorData)
          }
        } else {
          // Crear nuevo con POST
          logger.info(`  Creando: ${name}`)
          const createResponse = await fetch(
            `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${ghlConfig.api_token}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
              },
              body: JSON.stringify({ name, value })
            }
          )

          if (createResponse.ok) {
            results.push({ name, status: 'created' })
            logger.info(`  ✅ ${name} creado`)
          } else {
            const errorData = await createResponse.json()
            results.push({ name, status: 'error', error: errorData })
            logger.error(`  ❌ Error creando ${name}:`, errorData)
          }
        }
      } catch (err) {
        results.push({ name, status: 'error', error: err.message })
        logger.error(`Error configurando ${name}:`, err)
      }
    }

    const successCount = results.filter(r => r.status === 'created' || r.status === 'updated').length
    logger.success(`✅ Custom values de Meta sincronizados: ${successCount}/${results.length}`)

    return { success: true, results }
  } catch (error) {
    logger.error('Error sincronizando custom values de Meta:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Guarda la configuración de Meta en la base de datos
 * ENCRIPTA el access_token y app_secret antes de guardar
 * CREA/ACTUALIZA custom values en HighLevel automáticamente
 */
export async function saveMetaConfig(adAccountId, accessToken, pixelId = null, appId = null, appSecret = null) {
  try {
    // Encriptar el access_token
    const encryptedToken = encrypt(accessToken)
    logger.info('Token de Meta encriptado correctamente')

    // Encriptar app_secret si existe
    let encryptedSecret = null
    if (appSecret) {
      encryptedSecret = encrypt(appSecret)
      logger.info('App Secret de Meta encriptado correctamente')
    }

    // Obtener timezone de la cuenta de Meta
    logger.info('Obteniendo timezone de la cuenta de Meta...')
    const timezoneData = await getAdAccountTimezone(adAccountId, accessToken)

    if (timezoneData) {
      logger.info(`Timezone detectado: ${timezoneData.timezone_name} (ID: ${timezoneData.timezone_id}, Offset: ${timezoneData.timezone_offset_hours_utc}h)`)
    }

    const existing = await db.get('SELECT id FROM meta_config WHERE ad_account_id = ?', [adAccountId])

    if (existing) {
      await db.run(`
        UPDATE meta_config
        SET access_token = ?, pixel_id = ?, app_id = ?, app_secret = ?,
            timezone_id = ?, timezone_name = ?, timezone_offset_hours_utc = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE ad_account_id = ?
      `, [
        encryptedToken,
        pixelId,
        appId,
        encryptedSecret,
        timezoneData?.timezone_id,
        timezoneData?.timezone_name,
        timezoneData?.timezone_offset_hours_utc,
        adAccountId
      ])
    } else {
      await db.run(`
        INSERT INTO meta_config (ad_account_id, access_token, pixel_id, app_id, app_secret, timezone_id, timezone_name, timezone_offset_hours_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        adAccountId,
        encryptedToken,
        pixelId,
        appId,
        encryptedSecret,
        timezoneData?.timezone_id,
        timezoneData?.timezone_name,
        timezoneData?.timezone_offset_hours_utc
      ])
    }

    logger.success('Configuración de Meta guardada en BD local (encriptada con timezone y pixel)')

    // Sincronizar custom values en HighLevel (no bloquear si falla)
    syncMetaCustomValues(adAccountId, accessToken, pixelId, appId, appSecret).catch(err => {
      logger.warn('No se pudieron sincronizar custom values de Meta en HighLevel:', err.message)
    })

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
 * NOTA IMPORTANTE: Las fechas de Meta vienen en el timezone de la cuenta (timezone_name de meta_config).
 * Las guardamos TAL CUAL porque representan "el día" en el timezone del anunciante.
 * El frontend debe mostrarlas en el timezone del usuario de HighLevel (no se convierten).
 */
async function saveAdsToDatabase(ads, accountId) {
  try {
    for (const ad of ads) {
      // Calcular CPM y CTR
      const cpm = ad.reach > 0 ? (ad.spend / ad.reach) * 1000 : 0
      const ctr = ad.reach > 0 ? (ad.clicks / ad.reach) * 100 : 0

      // ad.date_start viene como "YYYY-MM-DD" en el timezone de la cuenta de Meta
      // Lo guardamos directo sin conversión (representa el "día" en el timezone del anunciante)
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
 * @param {Date} startDate - Fecha de inicio
 * @param {Function} onProgress - Callback para reportar progreso (opcional)
 */
export async function syncMetaAds(startDate, onProgress = null) {
  try {
    const config = await getMetaConfig()
    if (!config) {
      throw new Error('No hay configuración de Meta. Configura Meta primero.')
    }

    const { ad_account_id, access_token } = config

    // ✅ VALIDAR TOKEN ANTES DE INICIAR SYNC
    logger.info('Validando token de Meta antes de sincronizar...')
    const tokenValidation = await verifyMetaToken(access_token)

    if (!tokenValidation.valid) {
      const errorMsg = tokenValidation.error || 'Token inválido o expirado'
      logger.error(`❌ Token de Meta inválido: ${errorMsg}`)
      throw new Error(`Token de Meta inválido: ${errorMsg}. Configura un nuevo token en Settings.`)
    }

    // Verificar si el token está cerca de expirar (menos de 7 días)
    if (tokenValidation.expiresAt) {
      const daysUntilExpiry = Math.ceil((tokenValidation.expiresAt - new Date()) / (1000 * 60 * 60 * 24))
      if (daysUntilExpiry <= 7) {
        logger.warn(`⚠️ Token de Meta expira en ${daysUntilExpiry} días. Considera renovarlo.`)
      } else {
        logger.info(`✅ Token válido (expira en ${daysUntilExpiry} días)`)
      }
    } else {
      logger.info('✅ Token válido (sin fecha de expiración)')
    }

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

    // Reportar total de meses a sincronizar
    if (onProgress) {
      onProgress({ saved: 0, total: dateChunks.length, status: 'syncing', message: `Preparando ${dateChunks.length} meses de datos...` })
    }

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

      // Reportar progreso en tiempo real
      if (onProgress) {
        onProgress({
          saved: i,
          total: dateChunks.length,
          status: 'syncing',
          message: `Sincronizando mes ${i + 1}/${dateChunks.length}...`
        })
      }

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

      // Reportar progreso actualizado
      if (onProgress) {
        onProgress({
          saved: i + 1,
          total: dateChunks.length,
          status: 'syncing',
          message: `Mes ${i + 1}/${dateChunks.length} completado`
        })
      }
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

    // Reportar completado
    if (onProgress) {
      onProgress({
        saved: dateChunks.length,
        total: dateChunks.length,
        status: 'completed',
        message: `${dateChunks.length} meses sincronizados exitosamente`
      })
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

    // Reportar error
    if (onProgress) {
      onProgress({
        saved: 0,
        total: 0,
        status: 'error',
        message: `Error: ${error.message}`
      })
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

    // ✅ VALIDAR TOKEN (silenciosamente en el cron)
    const tokenValidation = await verifyMetaToken(access_token)

    if (!tokenValidation.valid) {
      logger.error(`❌ Token de Meta inválido en cron job: ${tokenValidation.error}`)
      return { success: false, message: 'Token inválido', error: tokenValidation.error }
    }

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
