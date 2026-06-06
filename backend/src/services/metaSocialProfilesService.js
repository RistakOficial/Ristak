import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'

const THREADS_GRAPH_URL = 'https://graph.threads.net/v1.0'

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonString(value) {
  return JSON.stringify(value ?? {})
}

function normalizeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null
}

function formatCompactDecimal(value) {
  const rounded = Math.round(value * 10) / 10
  if (Number.isInteger(rounded)) return String(rounded)
  return rounded.toFixed(1).replace('.', ',')
}

function formatFollowers(value) {
  const number = normalizeCount(value)
  if (number === null) return ''
  if (number < 1000) return String(number)
  if (number < 1000000) return `${formatCompactDecimal(number / 1000)} mil`

  const millions = formatCompactDecimal(number / 1000000)
  return `${millions} ${millions === '1' ? 'millon' : 'millones'}`
}

function profileKey(platform, sourceId) {
  return `${platform}:${sourceId}`
}

async function fetchMetaConnection(initialUrl) {
  const records = []
  let nextUrl = initialUrl
  let pageCount = 0

  while (nextUrl && pageCount < 10) {
    const response = await fetch(nextUrl)
    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.message || 'Error de Meta API')
    }

    if (Array.isArray(data.data)) records.push(...data.data)
    nextUrl = data.paging?.next || null
    pageCount += 1
  }

  return records
}

function normalizeFacebookProfile(page = {}, updatedAt, configuredPageId = '') {
  const sourceId = cleanString(page.id)
  const followerCount = normalizeCount(page.followers_count ?? page.fan_count)
  if (!sourceId || !cleanString(page.name)) return null

  return {
    id: profileKey('facebook', sourceId),
    platform: 'facebook',
    sourceId,
    pageId: sourceId,
    pageName: cleanString(page.name),
    name: cleanString(page.name),
    username: '',
    category: cleanString(page.category),
    avatarUrl: page.picture?.data?.url || page.picture?.url || '',
    followers: followerCount,
    followersLabel: formatFollowers(followerCount),
    isConfiguredPage: Boolean(configuredPageId && sourceId === configuredPageId),
    updatedAt
  }
}

function normalizeInstagramProfile(page = {}, updatedAt, configuredPageId = '') {
  const instagram = page.instagram_business_account || page.connected_instagram_account
  const sourceId = cleanString(instagram?.id)
  if (!sourceId) return null

  const username = cleanString(instagram.username)
  const name = username || cleanString(instagram.name) || cleanString(page.name)
  const followerCount = normalizeCount(instagram.followers_count)

  return {
    id: profileKey('instagram', sourceId),
    platform: 'instagram',
    sourceId,
    pageId: cleanString(page.id),
    pageName: cleanString(page.name),
    name,
    username,
    category: 'Instagram',
    avatarUrl: instagram.profile_picture_url || '',
    followers: followerCount,
    followersLabel: formatFollowers(followerCount),
    isConfiguredPage: Boolean(configuredPageId && cleanString(page.id) === configuredPageId),
    updatedAt
  }
}

function dedupeProfiles(profiles = []) {
  const byId = new Map()
  for (const profile of profiles) {
    if (profile?.id) byId.set(profile.id, profile)
  }
  return [...byId.values()].sort((a, b) => Number(Boolean(b.isConfiguredPage)) - Number(Boolean(a.isConfiguredPage)))
}

function extractThreadsFollowers(insights = {}) {
  const metrics = Array.isArray(insights.data) ? insights.data : []
  const followersMetric = metrics.find(metric => metric?.name === 'followers_count')
  const value = followersMetric?.total_value?.value
    ?? followersMetric?.values?.[followersMetric.values.length - 1]?.value
    ?? followersMetric?.value

  return normalizeCount(value)
}

async function fetchThreadsProfile(accessToken, updatedAt) {
  const profileParams = new URLSearchParams({
    fields: 'id,username,threads_profile_picture_url',
    access_token: accessToken
  })
  const profileResponse = await fetch(`${THREADS_GRAPH_URL}/me?${profileParams.toString()}`)
  const profile = await profileResponse.json()

  if (profile.error) {
    throw new Error(profile.error.message || 'Threads no devolvio el perfil conectado')
  }

  const sourceId = cleanString(profile.id)
  const username = cleanString(profile.username)
  if (!sourceId || !username) return null

  let followerCount = null
  try {
    const insightsParams = new URLSearchParams({
      metric: 'followers_count',
      access_token: accessToken
    })
    const insightsResponse = await fetch(`${THREADS_GRAPH_URL}/me/threads_insights?${insightsParams.toString()}`)
    const insights = await insightsResponse.json()
    if (insights.error) {
      logger.warn(`Meta Threads no devolvio seguidores: ${insights.error.message || 'sin detalle'}`)
    } else {
      followerCount = extractThreadsFollowers(insights)
    }
  } catch (error) {
    logger.warn(`No se pudo leer seguidores de Threads: ${error.message}`)
  }

  return {
    id: profileKey('threads', sourceId),
    platform: 'threads',
    sourceId,
    pageId: '',
    pageName: '',
    name: username,
    username,
    category: 'Threads',
    avatarUrl: profile.threads_profile_picture_url || '',
    followers: followerCount,
    followersLabel: formatFollowers(followerCount),
    updatedAt
  }
}

async function fetchMetaPages(accessToken, params) {
  let pages = []
  try {
    pages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/me/accounts?${params.toString()}`)
  } catch (error) {
    logger.warn(`Meta no devolvio todos los campos de perfil social: ${error.message}`)
    throw error
  }

  if (pages.length > 0) return pages

  try {
    const debugUrl = `${API_URLS.META_TOKEN_DEBUG}?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`
    const debugResponse = await fetch(debugUrl)
    const debugData = await debugResponse.json()
    const userId = debugData?.data?.user_id
    if (!userId) return pages

    for (const edge of ['accounts', 'assigned_pages']) {
      try {
        const fallbackPages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/${encodeURIComponent(userId)}/${edge}?${params.toString()}`)
        pages.push(...fallbackPages)
      } catch (fallbackError) {
        logger.warn(`No se pudieron leer paginas Meta desde ${edge}: ${fallbackError.message}`)
      }
    }
  } catch (error) {
    logger.warn(`No se pudo revisar rutas alternas de paginas Meta: ${error.message}`)
  }

  return pages
}

export async function getConnectedMetaSocialProfiles(options = {}) {
  const config = options.accessToken
    ? { access_token: cleanString(options.accessToken) }
    : await getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer configuracion Meta para perfiles sociales: ${error.message}`)
      return null
    })

  const accessToken = cleanString(config?.access_token)
  const configuredPageId = cleanString(config?.page_id)
  const updatedAt = new Date().toISOString()

  if (!accessToken) {
    return { connected: false, updatedAt, profiles: [] }
  }

  const richFields = [
    'id',
    'name',
    'category',
    'picture{url}',
    'fan_count',
    'followers_count',
    'instagram_business_account{id,username,name,profile_picture_url,followers_count}'
  ].join(',')

  const fallbackFields = [
    'id',
    'name',
    'category',
    'picture{url}',
    'instagram_business_account{id,username,name,profile_picture_url}'
  ].join(',')

  const params = new URLSearchParams({
    fields: richFields,
    limit: '100',
    access_token: accessToken
  })

  let pages = []
  try {
    pages = await fetchMetaPages(accessToken, params)
  } catch (error) {
    logger.warn(`Meta no devolvio todos los campos de perfil social: ${error.message}`)
    params.set('fields', fallbackFields)
    try {
      pages = await fetchMetaPages(accessToken, params)
    } catch (fallbackError) {
      logger.warn(`No se pudieron leer paginas Meta conectadas: ${fallbackError.message}`)
      pages = []
    }
  }
  const profiles = []

  for (const page of pages) {
    const facebook = normalizeFacebookProfile(page, updatedAt, configuredPageId)
    const instagram = normalizeInstagramProfile(page, updatedAt, configuredPageId)
    if (facebook) profiles.push(facebook)
    if (instagram) profiles.push(instagram)
  }

  try {
    const threads = await fetchThreadsProfile(accessToken, updatedAt)
    if (threads) profiles.push(threads)
  } catch (error) {
    logger.warn(`No se pudo leer perfil Threads conectado: ${error.message}`)
  }

  return {
    connected: true,
    updatedAt,
    profiles: dedupeProfiles(profiles)
  }
}

function applyProfileToSettings(settings = {}, profile) {
  return {
    ...settings,
    platform: profile.platform,
    brandName: profile.name || settings.brandName || '',
    brandSubtitle: profile.platform === 'instagram'
      ? 'Perfil de Instagram conectado'
      : profile.platform === 'threads'
        ? 'Perfil de Threads conectado'
        : 'Pagina de Facebook conectada',
    brandAvatar: profile.avatarUrl || settings.brandAvatar || '',
    followers: profile.followersLabel || '',
    socialAutoSync: true,
    socialSourceProfileId: profile.id,
    socialSourcePlatform: profile.platform,
    socialSourceId: profile.sourceId,
    socialSourcePageId: profile.pageId || '',
    socialSourceName: profile.name || '',
    socialSyncedAt: profile.updatedAt
  }
}

function applyProfileToTheme(theme = {}, profile) {
  return {
    ...theme,
    ...(profile.platform === 'facebook' || profile.platform === 'instagram' ? { template: profile.platform } : {}),
    brandName: profile.name || theme.brandName || '',
    brandSubtitle: profile.platform === 'instagram'
      ? 'Perfil de Instagram conectado'
      : profile.platform === 'threads'
        ? 'Perfil de Threads conectado'
        : 'Pagina de Facebook conectada',
    brandAvatar: profile.avatarUrl || theme.brandAvatar || '',
    followers: profile.followersLabel || '',
    socialAutoSync: true,
    socialSourceProfileId: profile.id,
    socialSourcePlatform: profile.platform,
    socialSourceId: profile.sourceId,
    socialSourcePageId: profile.pageId || '',
    socialSourceName: profile.name || '',
    socialSyncedAt: profile.updatedAt
  }
}

function findProfileForSettings(settings = {}, profiles = []) {
  const sourceProfileId = cleanString(settings.socialSourceProfileId)
  const sourcePlatform = cleanString(settings.socialSourcePlatform || settings.platform)
  const sourceId = cleanString(settings.socialSourceId)

  return profiles.find(profile => (
    sourceProfileId && profile.id === sourceProfileId
  )) || profiles.find(profile => (
    sourcePlatform && sourceId && profile.platform === sourcePlatform && profile.sourceId === sourceId
  )) || null
}

export async function refreshConnectedSocialProfileBlocks({ force = false } = {}) {
  const { connected, profiles } = await getConnectedMetaSocialProfiles()
  if (!connected || profiles.length === 0) {
    return { success: false, updated: 0, message: 'No hay perfiles Meta conectados' }
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows = await db.all(
    "SELECT id, site_id, settings_json FROM public_site_blocks WHERE block_type = 'social_profile'"
  )

  let updated = 0
  const siteRows = await db.all(
    "SELECT id, theme_json FROM public_sites WHERE theme_json LIKE '%socialAutoSync%'"
  )

  for (const row of siteRows) {
    const theme = parseJson(row.theme_json, {})
    if (theme.socialAutoSync !== true) continue
    if (!force && cleanString(theme.socialSyncedAt).slice(0, 10) === today) continue

    const profile = findProfileForSettings(theme, profiles)
    if (!profile) continue

    await db.run(
      'UPDATE public_sites SET theme_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jsonString(applyProfileToTheme(theme, profile)), row.id]
    )
    updated += 1
  }

  for (const row of rows) {
    const settings = parseJson(row.settings_json, {})
    if (settings.socialAutoSync !== true) continue
    if (!force && cleanString(settings.socialSyncedAt).slice(0, 10) === today) continue

    const profile = findProfileForSettings(settings, profiles)
    if (!profile) continue

    await db.run(
      'UPDATE public_site_blocks SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?',
      [jsonString(applyProfileToSettings(settings, profile)), row.id, row.site_id]
    )
    updated += 1
  }

  return {
    success: true,
    updated,
    message: `${updated} perfil(es) social(es) actualizados`
  }
}
