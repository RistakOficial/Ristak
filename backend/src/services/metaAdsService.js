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
let isMetaFullSyncRunning = false

export function getMetaSyncProgress() {
  return syncProgress
}

function updateProgress(updates) {
  syncProgress = { ...syncProgress, ...updates }
  logger.info(`Progreso Meta: ${syncProgress.step} (Mes ${syncProgress.monthsCurrent}/${syncProgress.monthsTotal})`)
}

const META_AD_CREATIVE_FIELDS = [
  'id',
  'name',
  'object_type',
  'thumbnail_url',
  'image_url',
  'video_id',
  'preview_url',
  'object_story_spec',
  'asset_feed_spec'
].join(',')

const META_VIDEO_FIELDS = 'id,source,permalink_url,thumbnails.limit(1){uri,is_preferred}'

function chunkArray(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function pickFirstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = pickFirstString(...value)
      if (nested) return nested
      continue
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function normalizeId(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized || null
}

function getCreativeVideoId(creative = {}) {
  const storySpec = creative.object_story_spec || {}
  const videoData = storySpec.video_data || {}
  const assetFeedSpec = creative.asset_feed_spec || {}
  const assetVideo = Array.isArray(assetFeedSpec.videos) ? assetFeedSpec.videos[0] : null

  return normalizeId(pickFirstString(
    creative.video_id,
    videoData.video_id,
    assetVideo?.video_id,
    assetVideo?.id
  ))
}

function extractCreativeMedia(creative = {}, videoMediaById = new Map()) {
  const storySpec = creative.object_story_spec || {}
  const videoData = storySpec.video_data || {}
  const linkData = storySpec.link_data || {}
  const photoData = storySpec.photo_data || {}
  const assetFeedSpec = creative.asset_feed_spec || {}
  const assetImage = Array.isArray(assetFeedSpec.images) ? assetFeedSpec.images[0] : null
  const assetVideo = Array.isArray(assetFeedSpec.videos) ? assetFeedSpec.videos[0] : null

  const videoId = getCreativeVideoId(creative)
  const videoMedia = videoId ? videoMediaById.get(videoId) : null
  const imageUrl = pickFirstString(
    creative.image_url,
    linkData.image_url,
    photoData.url,
    videoData.image_url,
    assetImage?.url,
    assetImage?.image_url,
    assetImage?.thumbnail_url
  )
  const videoUrl = pickFirstString(videoMedia?.videoUrl)
  const thumbnailUrl = pickFirstString(
    creative.thumbnail_url,
    videoData.image_url,
    assetVideo?.thumbnail_url,
    videoMedia?.thumbnailUrl,
    imageUrl
  )
  const previewUrl = pickFirstString(creative.preview_url, videoMedia?.previewUrl)
  const creativeType = videoId || videoUrl ? 'video' : (imageUrl || thumbnailUrl ? 'image' : null)

  return {
    creative_id: normalizeId(creative.id),
    creative_type: creativeType,
    creative_thumbnail_url: thumbnailUrl,
    creative_image_url: imageUrl,
    creative_video_id: videoId,
    creative_video_url: videoUrl,
    creative_preview_url: previewUrl
  }
}

async function fetchMetaVideoMedia(videoIds, accessToken) {
  const uniqueVideoIds = [...new Set(videoIds.map(normalizeId).filter(Boolean))]
  const videoMediaById = new Map()

  if (uniqueVideoIds.length === 0) {
    return videoMediaById
  }

  for (const chunk of chunkArray(uniqueVideoIds, 50)) {
    try {
      const params = new URLSearchParams({
        ids: chunk.join(','),
        fields: META_VIDEO_FIELDS,
        access_token: accessToken
      })
      const response = await fetch(`${API_URLS.META_GRAPH}?${params.toString()}`)
      const data = await response.json()

      if (data.error) {
        logger.warn(`No se pudo obtener video media de Meta: ${data.error.message}`)
        continue
      }

      Object.entries(data || {}).forEach(([videoId, video]) => {
        const thumbnails = Array.isArray(video?.thumbnails?.data) ? video.thumbnails.data : []
        const preferredThumbnail = thumbnails.find(thumbnail => thumbnail.is_preferred) || thumbnails[0]

        videoMediaById.set(String(videoId), {
          videoUrl: pickFirstString(video?.source),
          thumbnailUrl: pickFirstString(preferredThumbnail?.uri),
          previewUrl: pickFirstString(video?.permalink_url)
        })
      })
    } catch (error) {
      logger.warn(`Error obteniendo video media de Meta: ${error.message}`)
    }
  }

  return videoMediaById
}

async function fetchMetaCreativesForAds(adIds, accessToken) {
  const uniqueAdIds = [...new Set(adIds.map(normalizeId).filter(Boolean))]
  const rawCreativesByAdId = new Map()

  if (uniqueAdIds.length === 0) {
    return new Map()
  }

  for (const chunk of chunkArray(uniqueAdIds, 50)) {
    try {
      const params = new URLSearchParams({
        ids: chunk.join(','),
        fields: `id,creative{${META_AD_CREATIVE_FIELDS}}`,
        access_token: accessToken
      })
      const response = await fetch(`${API_URLS.META_GRAPH}?${params.toString()}`)
      const data = await response.json()

      if (data.error) {
        logger.warn(`No se pudieron obtener creatives de Meta: ${data.error.message}`)
        continue
      }

      Object.entries(data || {}).forEach(([adId, adData]) => {
        if (adData?.creative) {
          rawCreativesByAdId.set(String(adId), adData.creative)
        }
      })
    } catch (error) {
      logger.warn(`Error obteniendo creatives de Meta: ${error.message}`)
    }
  }

  const videoIds = [...rawCreativesByAdId.values()].map(getCreativeVideoId).filter(Boolean)
  const videoMediaById = await fetchMetaVideoMedia(videoIds, accessToken)
  const creativeMediaByAdId = new Map()

  rawCreativesByAdId.forEach((creative, adId) => {
    creativeMediaByAdId.set(adId, extractCreativeMedia(creative, videoMediaById))
  })

  logger.info(`Creatives de Meta obtenidos: ${creativeMediaByAdId.size}/${uniqueAdIds.length}`)
  return creativeMediaByAdId
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
 * Genera un Pixel API Token (Conversions API Token) automáticamente
 * Este token es específico para el pixel y se usa para enviar eventos mediante Conversions API
 * @param {string} pixelId - ID del pixel de Meta
 * @param {string} accessToken - Access Token de Meta (System User)
 * @returns {Promise<string>} Token generado para el pixel
 */
export async function generatePixelCapiToken(pixelId, accessToken) {
  try {
    logger.info(`Generando Pixel API Token para pixel ${pixelId}...`)

    const url = `${API_URLS.META_GRAPH}/${pixelId}/access_tokens?access_token=${accessToken}`

    const response = await fetch(url, { method: 'POST' })
    const data = await response.json()

    if (data.error) {
      logger.error(`Error generando Pixel API Token: ${data.error.message}`)
      throw new Error(`Error generando Pixel API Token: ${data.error.message}`)
    }

    if (!data.access_token) {
      throw new Error('Meta API no devolvió un token válido')
    }

    logger.success(`✅ Pixel API Token generado exitosamente para pixel ${pixelId}`)
    return data.access_token
  } catch (error) {
    logger.error('Error generando Pixel API Token:', error.message)
    throw error
  }
}

/**
 * Sincroniza custom values de Meta en HighLevel
 */
async function syncMetaCustomValues(adAccountId, accessToken, pixelId, pixelApiToken = null) {
  try {
    // Obtener configuración de HighLevel
    const ghlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')

    if (!ghlConfig || !ghlConfig.location_id || !ghlConfig.api_token) {
      logger.warn('⚠️ No hay configuración de HighLevel. Saltando sincronización de custom values de Meta.')
      return { success: false, message: 'No HighLevel config' }
    }

    logger.info('📝 Sincronizando custom values de Meta en HighLevel...')

    // Custom values a crear/actualizar (System User - no necesita App ID ni App Secret)
    const customValues = {
      'Facebook - Ad Account ID': adAccountId,
      'Facebook - App Access Token': accessToken,
      'Facebook - Pixel ID': pixelId || '',
      'Facebook - Pixel API Token': pixelApiToken || ''
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
      // 🔒 SEGURIDAD: NO enviar valores vacíos a HighLevel
      // Si el usuario borra un campo en la UI, NO se sobrescribe en HighLevel
      // Solo se actualiza cuando hay un NUEVO valor válido
      if (!value || (typeof value === 'string' && value.trim() === '')) {
        logger.info(`  Saltando ${name} (vacío) - NO se modifica en HighLevel`)
        continue
      }

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
 * ENCRIPTA el access_token y pixel_api_token antes de guardar
 * USA System User Token (no requiere App ID ni App Secret)
 * CREA/ACTUALIZA custom values en HighLevel automáticamente
 * GENERA AUTOMÁTICAMENTE el Pixel API Token si se proporciona pixelId
 */
export async function saveMetaConfig(adAccountId, accessToken, pixelId = null, pixelApiToken = null, pageId = null) {
  try {
    // Encriptar el access_token
    const encryptedToken = encrypt(accessToken)
    logger.info('Token de Meta encriptado correctamente')

    // Si hay pixelId pero NO hay pixelApiToken, generarlo automáticamente
    let finalPixelApiToken = pixelApiToken
    if (pixelId && !pixelApiToken) {
      try {
        logger.info('🔄 Generando Pixel API Token automáticamente...')
        finalPixelApiToken = await generatePixelCapiToken(pixelId, accessToken)
        logger.success('✅ Pixel API Token generado y será guardado')
      } catch (error) {
        logger.warn(`⚠️ No se pudo generar Pixel API Token automáticamente: ${error.message}`)
        // Continuar sin el token (no es crítico)
      }
    }

    // Encriptar pixel_api_token si existe (Conversions API Token)
    let encryptedPixelApiToken = null
    if (finalPixelApiToken) {
      encryptedPixelApiToken = encrypt(finalPixelApiToken)
      logger.info('Pixel API Token de Meta encriptado correctamente')
    }

    // Obtener timezone de la cuenta de Meta
    logger.info('Obteniendo timezone de la cuenta de Meta...')
    const timezoneData = await getAdAccountTimezone(adAccountId, accessToken)

    if (timezoneData) {
      logger.info(`Timezone detectado: ${timezoneData.timezone_name} (ID: ${timezoneData.timezone_id}, Offset: ${timezoneData.timezone_offset_hours_utc}h)`)
    }

    // IMPORTANTE: Solo permitir 1 configuración de Meta en la base de datos
    // Eliminar cualquier configuración existente antes de insertar la nueva
    const existingCount = await db.get('SELECT COUNT(*) as count FROM meta_config')

    if (existingCount && existingCount.count > 0) {
      logger.info('Eliminando configuración de Meta existente (solo se permite 1)')
      await db.run('DELETE FROM meta_config')
    }

    // Insertar la nueva configuración (System User - solo necesita access_token + ad_account_id)
    await db.run(`
      INSERT INTO meta_config (ad_account_id, access_token, pixel_id, pixel_api_token, page_id, timezone_id, timezone_name, timezone_offset_hours_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      adAccountId,
      encryptedToken,
      pixelId,
      encryptedPixelApiToken,
      pageId,
      timezoneData?.timezone_id,
      timezoneData?.timezone_name,
      timezoneData?.timezone_offset_hours_utc
    ])

    logger.success('Configuración de Meta guardada en BD local (System User Token + Pixel)')

    // Sincronizar custom values en HighLevel (no bloquear si falla)
    // Incluye Pixel API Token si fue generado o proporcionado
    syncMetaCustomValues(adAccountId, accessToken, pixelId, finalPixelApiToken).catch(err => {
      logger.warn('No se pudieron sincronizar custom values de Meta en HighLevel:', err.message)
    })

    return { success: true, pixelApiTokenGenerated: !!finalPixelApiToken && !pixelApiToken }
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
async function saveAdsToDatabase(ads, accountId, creativeMediaByAdId = new Map()) {
  try {
    // IMPORTANTE: accountId se guarda SIN el prefijo "act_" para consistencia
    // - Meta Config guarda: "123456789" (sin "act_")
    // - Meta Ads guarda: "123456789" (sin "act_")
    // - Esto evita duplicados al cambiar entre formatos
    // - fetchMetaAdsInsights ya hace .replace('act_', '') antes de llamar aquí

    for (const ad of ads) {
      // Calcular CPM y CTR
      const cpm = ad.reach > 0 ? (ad.spend / ad.reach) * 1000 : 0
      const ctr = ad.reach > 0 ? (ad.clicks / ad.reach) * 100 : 0

      // ad.date_start viene como "YYYY-MM-DD" en el timezone de la cuenta de Meta
      // Lo guardamos directo sin conversión (representa el "día" en el timezone del anunciante)
      const creativeMedia = creativeMediaByAdId.get(String(ad.ad_id)) || {}

      await db.run(`
        INSERT INTO meta_ads (
          date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
          ad_id, ad_name, creative_id, creative_type, creative_thumbnail_url,
          creative_image_url, creative_video_id, creative_video_url, creative_preview_url,
          spend, reach, clicks, cpc, cpm, ctr
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, campaign_id, adset_id, ad_id) DO UPDATE SET
          campaign_name = excluded.campaign_name,
          adset_name = excluded.adset_name,
          ad_name = excluded.ad_name,
          creative_id = COALESCE(excluded.creative_id, meta_ads.creative_id),
          creative_type = COALESCE(excluded.creative_type, meta_ads.creative_type),
          creative_thumbnail_url = COALESCE(excluded.creative_thumbnail_url, meta_ads.creative_thumbnail_url),
          creative_image_url = COALESCE(excluded.creative_image_url, meta_ads.creative_image_url),
          creative_video_id = COALESCE(excluded.creative_video_id, meta_ads.creative_video_id),
          creative_video_url = COALESCE(excluded.creative_video_url, meta_ads.creative_video_url),
          creative_preview_url = COALESCE(excluded.creative_preview_url, meta_ads.creative_preview_url),
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
        creativeMedia.creative_id || null,
        creativeMedia.creative_type || null,
        creativeMedia.creative_thumbnail_url || null,
        creativeMedia.creative_image_url || null,
        creativeMedia.creative_video_id || null,
        creativeMedia.creative_video_url || null,
        creativeMedia.creative_preview_url || null,
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
  if (isMetaFullSyncRunning) {
    const message = 'Ya hay una sincronización completa de Meta en progreso'
    logger.warn(message)
    return { success: false, message }
  }

  isMetaFullSyncRunning = true
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
    const creativeMediaCache = new Map()

    // Reportar total de meses a sincronizar
    if (onProgress) {
      onProgress({ saved: 0, total: dateChunks.length, status: 'syncing', message: `Preparando ${dateChunks.length} meses de datos...` })
    }

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

      const adIds = [...new Set(ads.map(ad => normalizeId(ad.ad_id)).filter(Boolean))]
      const missingCreativeAdIds = adIds.filter(adId => !creativeMediaCache.has(adId))

      if (missingCreativeAdIds.length > 0) {
        const fetchedCreativeMedia = await fetchMetaCreativesForAds(missingCreativeAdIds, access_token)
        missingCreativeAdIds.forEach(adId => {
          creativeMediaCache.set(adId, fetchedCreativeMedia.get(adId) || null)
        })
      }

      const creativeMediaByAdId = new Map()
      adIds.forEach(adId => {
        const media = creativeMediaCache.get(adId)
        if (media) {
          creativeMediaByAdId.set(adId, media)
        }
      })

      // IMPORTANTE:
      // En lugar de borrar TODA la tabla (causa ventanas de "gasto = 0" durante sync),
      // borramos SOLO el rango del chunk actual y luego lo reinsertamos.
      // Así la app nunca se queda sin histórico completo mientras sincroniza.
      await db.run(
        'DELETE FROM meta_ads WHERE ad_account_id = ? AND date >= ? AND date <= ?',
        [ad_account_id, chunk.since, chunk.until]
      )

      if (ads.length > 0) {
        await saveAdsToDatabase(ads, ad_account_id, creativeMediaByAdId)
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
  } finally {
    isMetaFullSyncRunning = false
  }
}

/**
 * Actualiza ads recientes (últimos 7 días)
 * Esta función se ejecuta cada hora desde el cron job
 */
export async function updateRecentAds() {
  try {
    if (isMetaFullSyncRunning) {
      logger.warn('Saltando actualización rápida de Meta porque hay una sincronización completa en curso')
      return { success: false, message: 'Sync completo en progreso' }
    }

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
      const creativeMediaByAdId = await fetchMetaCreativesForAds(
        ads.map(ad => ad.ad_id),
        access_token
      )
      await saveAdsToDatabase(ads, ad_account_id, creativeMediaByAdId)
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
