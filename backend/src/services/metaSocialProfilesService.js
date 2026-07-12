import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js'
import { logger } from '../utils/logger.js'
import { DEFAULT_TIMEZONE, businessTodayDateOnly, getAccountTimezone } from '../utils/dateUtils.js'
import { getMetaSocialConfig } from './metaAdsService.js'

const THREADS_GRAPH_URL = 'https://graph.threads.net/v1.0'
const META_PROFILE_PLATFORMS = new Set(['facebook', 'instagram'])

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

function normalizePlatform(value) {
  return cleanString(value).toLowerCase()
}

function isMetaProfilePlatform(value) {
  return META_PROFILE_PLATFORMS.has(normalizePlatform(value))
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

function normalizeInstagramProfile(page = {}, updatedAt, configuredPageId = '', configuredInstagramAccountId = '') {
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
    isConfiguredInstagram: Boolean(configuredInstagramAccountId && sourceId === configuredInstagramAccountId),
    updatedAt
  }
}

function dedupeProfiles(profiles = []) {
  const byId = new Map()
  for (const profile of profiles) {
    if (profile?.id) byId.set(profile.id, profile)
  }
  return sortProfilesByPriority([...byId.values()])
}

function getProfileFollowerCount(profile = {}) {
  return normalizeCount(profile.followers) || 0
}

function isConfiguredProfile(profile = {}) {
  return Boolean(profile.isConfiguredPage || profile.isConfiguredInstagram)
}

function sortProfilesByPriority(profiles = []) {
  return [...profiles].sort((a, b) => {
    const configuredDelta = Number(isConfiguredProfile(b)) - Number(isConfiguredProfile(a))
    if (configuredDelta !== 0) return configuredDelta

    return getProfileFollowerCount(b) - getProfileFollowerCount(a)
  })
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

async function fetchMetaPages(accessToken, params, appSecretProof = '') {
  let pages = []
  try {
    pages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/me/accounts?${params.toString()}`)
  } catch (error) {
    logger.warn(`Meta no devolvio todos los campos de perfil social: ${safeMetaGraphTransportError(error)}`)
    throw error
  }

  if (pages.length > 0) return pages

  try {
    const debugParams = new URLSearchParams({ input_token: accessToken, access_token: accessToken })
    if (appSecretProof) debugParams.set('appsecret_proof', appSecretProof)
    const debugUrl = `${API_URLS.META_TOKEN_DEBUG}?${debugParams.toString()}`
    const debugResponse = await fetch(debugUrl)
    const debugData = await debugResponse.json()
    const userId = debugData?.data?.user_id
    if (!userId) return pages

    for (const edge of ['accounts', 'assigned_pages']) {
      try {
        const fallbackPages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/${encodeURIComponent(userId)}/${edge}?${params.toString()}`)
        pages.push(...fallbackPages)
      } catch (fallbackError) {
        logger.warn(`No se pudieron leer páginas Meta desde ${edge}: ${safeMetaGraphTransportError(fallbackError)}`)
      }
    }
  } catch (error) {
    logger.warn(`No se pudo revisar rutas alternas de páginas Meta: ${safeMetaGraphTransportError(error)}`)
  }

  return pages
}

async function fetchOAuthConfiguredPage(pageId, accessToken, appSecretProof, fields) {
  const params = new URLSearchParams({ fields, access_token: accessToken })
  if (appSecretProof) params.set('appsecret_proof', appSecretProof)
  let response
  try {
    response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(pageId)}?${params.toString()}`)
  } catch (error) {
    throw new Error(safeMetaGraphTransportError(error))
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.error) throw new Error(data?.error?.message || `Meta respondió ${response.status}`)
  return data?.id ? [data] : []
}

export async function getConnectedMetaSocialProfiles(options = {}) {
  const hasExplicitAccessToken = Boolean(cleanString(options.accessToken))
  const config = options.accessToken
    ? {
        access_token: cleanString(options.accessToken),
        page_id: cleanString(options.pageId),
        instagram_account_id: cleanString(options.instagramAccountId)
      }
    : await getMetaSocialConfig().catch(error => {
      logger.warn(`No se pudo leer configuración Meta para perfiles sociales: ${error.message}`)
      return null
    })

  const accessToken = cleanString(config?.access_token)
  const appSecretProof = cleanString(config?.oauth_appsecret_proof)
  const isOAuth = ['oauth_bisu', 'oauth_user'].includes(cleanString(config?.connection_mode))
  const pageAccessToken = isOAuth
    ? cleanString(config?.oauth_page_access_token)
    : accessToken
  const pageAppSecretProof = isOAuth
    ? cleanString(config?.oauth_page_appsecret_proof)
    : appSecretProof
  const configuredPageId = cleanString(config?.page_id)
  const configuredInstagramAccountId = cleanString(config?.instagram_account_id)
  const updatedAt = new Date().toISOString()
  const restrictToConfiguredProfiles = options.restrictToConfiguredProfiles !== false && !hasExplicitAccessToken

  if (!accessToken) {
    return { connected: false, updatedAt, profiles: [], message: 'Meta no tiene token guardado' }
  }

  if (isOAuth && (!configuredPageId || !pageAccessToken || !pageAppSecretProof)) {
    return { connected: false, updatedAt, profiles: [], message: 'La Página OAuth no tiene acceso operativo completo' }
  }

  if (restrictToConfiguredProfiles && !configuredPageId && !configuredInstagramAccountId) {
    return {
      connected: false,
      updatedAt,
      profiles: [],
      message: 'No hay página de Facebook o Instagram conectada'
    }
  }

  const richFields = [
    'id',
    'name',
    'category',
    'picture{url}',
    'fan_count',
    'followers_count',
    'instagram_business_account{id,username,name,profile_picture_url,followers_count}',
    'connected_instagram_account{id,username,name,profile_picture_url,followers_count}'
  ].join(',')

  const fallbackFields = [
    'id',
    'name',
    'category',
    'picture{url}',
    'instagram_business_account{id,username,name,profile_picture_url}',
    'connected_instagram_account{id,username,name,profile_picture_url}'
  ].join(',')

  const params = new URLSearchParams({
    fields: richFields,
    limit: '100',
    access_token: pageAccessToken || accessToken
  })
  if (pageAppSecretProof) params.set('appsecret_proof', pageAppSecretProof)

  let pages = []
  try {
    pages = isOAuth && configuredPageId && pageAccessToken
      ? await fetchOAuthConfiguredPage(configuredPageId, pageAccessToken, pageAppSecretProof, richFields)
      : await fetchMetaPages(accessToken, params, appSecretProof)
  } catch (error) {
    logger.warn(`Meta no devolvio todos los campos de perfil social: ${safeMetaGraphTransportError(error)}`)
    params.set('fields', fallbackFields)
    try {
      pages = isOAuth && configuredPageId && pageAccessToken
        ? await fetchOAuthConfiguredPage(configuredPageId, pageAccessToken, pageAppSecretProof, fallbackFields)
        : await fetchMetaPages(accessToken, params, appSecretProof)
    } catch (fallbackError) {
      logger.warn(`No se pudieron leer páginas Meta conectadas: ${safeMetaGraphTransportError(fallbackError)}`)
      pages = []
    }
  }
  const profiles = []

  for (const page of pages) {
    const facebook = normalizeFacebookProfile(page, updatedAt, configuredPageId)
    const instagram = normalizeInstagramProfile(page, updatedAt, configuredPageId, configuredInstagramAccountId)
    if (facebook && (!restrictToConfiguredProfiles || facebook.sourceId === configuredPageId)) profiles.push(facebook)
    if (instagram && (!restrictToConfiguredProfiles || instagram.sourceId === configuredInstagramAccountId)) profiles.push(instagram)
  }

  if (!restrictToConfiguredProfiles) {
    try {
      const threads = await fetchThreadsProfile(accessToken, updatedAt)
      if (threads) profiles.push(threads)
    } catch (error) {
      logger.warn(`No se pudo leer perfil Threads conectado: ${error.message}`)
    }
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
        : 'Página de Facebook conectada',
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
        : 'Página de Facebook conectada',
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
  const sourcePlatform = normalizePlatform(settings.socialSourcePlatform || settings.platform)
  const sourceId = cleanString(settings.socialSourceId)

  return profiles.find(profile => (
    sourceProfileId && profile.id === sourceProfileId
  )) || profiles.find(profile => (
    sourcePlatform && sourceId && profile.platform === sourcePlatform && profile.sourceId === sourceId
  )) || sortProfilesByPriority(profiles.filter(profile => (
    sourcePlatform && profile.platform === sourcePlatform
  )))[0] || null
}

function shouldRefreshSocialSettings(settings = {}, today, force) {
  if (settings.socialAutoSync !== true) return false
  if (!isMetaProfilePlatform(settings.socialSourcePlatform || settings.platform)) return false
  if (!cleanString(settings.socialSourceProfileId) && !cleanString(settings.socialSourceId)) return true
  if (!force && cleanString(settings.socialSyncedAt).slice(0, 10) === today) return false
  return true
}

async function getPublishedSocialProfileSyncTargets({ force, today }) {
  const [siteCandidates, blockCandidates] = await Promise.all([
    db.all(`
      SELECT id, theme_json
      FROM public_sites
      WHERE LOWER(COALESCE(status, '')) = 'published'
        AND theme_json LIKE '%socialAutoSync%'
    `),
    db.all(`
      SELECT b.id, b.site_id, b.settings_json
      FROM public_site_blocks b
      INNER JOIN public_sites s ON s.id = b.site_id
      WHERE b.block_type = 'social_profile'
        AND LOWER(COALESCE(s.status, '')) = 'published'
    `)
  ])

  const siteRows = siteCandidates.filter(row => (
    shouldRefreshSocialSettings(parseJson(row.theme_json, {}), today, force)
  ))
  const blockRows = blockCandidates.filter(row => (
    shouldRefreshSocialSettings(parseJson(row.settings_json, {}), today, force)
  ))

  return { siteRows, blockRows }
}

export async function refreshConnectedSocialProfileBlocks({ force = false } = {}) {
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const today = businessTodayDateOnly(timezone)
  const { siteRows, blockRows } = await getPublishedSocialProfileSyncTargets({ force, today })

  if (siteRows.length === 0 && blockRows.length === 0) {
    return {
      success: false,
      updated: 0,
      message: 'No hay perfiles sociales publicados con actualización automática'
    }
  }

  const { connected, profiles, message } = await getConnectedMetaSocialProfiles()
  if (!connected || profiles.length === 0) {
    return { success: false, updated: 0, message: message || 'No hay perfiles Meta conectados' }
  }

  let updated = 0

  for (const row of siteRows) {
    const theme = parseJson(row.theme_json, {})

    const profile = findProfileForSettings(theme, profiles)
    if (!profile) continue

    await db.run(
      'UPDATE public_sites SET theme_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jsonString(applyProfileToTheme(theme, profile)), row.id]
    )
    updated += 1
  }

  for (const row of blockRows) {
    const settings = parseJson(row.settings_json, {})

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
