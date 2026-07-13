import crypto from 'crypto'
import nodeFetch from 'node-fetch'
import { db, setAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import {
  claimCentralOAuthHandoff,
  connectCentralMetaOAuth,
  createCentralMetaOAuthConnectUrl,
  disconnectCentralMetaOAuth,
  getCentralMetaOAuthStatus,
  updateCentralMetaWebhookSubscription
} from './licenseService.js'
import {
  disableMetaConversionEventsForDisconnectedPixel,
  enableMetaSocialChannelsForConnectedProfiles,
  ensureMetaConversionEventsEnabledForConnectedPixel,
  getMetaConfig as getOperationalMetaConfig,
  getLegacyMetaConfig as getMetaConfig,
  normalizeMetaConnectionMode,
  saveMetaConfig,
  updateRecentAds
} from './metaAdsService.js'
import {
  ensureMetaPageMessagingSubscription,
  removeMetaPageMessagingSubscription,
  syncMetaSocialConversationHistoryInBackground
} from './metaSocialMessagingService.js'
import { clearMetaIntegrationCredentials } from './integrationCredentialsCleanupService.js'
import {
  getActiveMetaOAuthIntegration,
  hasActiveMetaOAuthSocialPage
} from './metaOAuthIntegrationConfigService.js'
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js'
import { withCronLock } from '../utils/cronLock.js'

const META_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000
const META_OAUTH_COMPENSATION_TTL_MS = 24 * 60 * 60 * 1000
const META_OAUTH_COMPENSATION_RETRY_BASE_MS = 5 * 60 * 1000
const META_OAUTH_COMPENSATION_RETRY_MAX_MS = 2 * 60 * 60 * 1000
const GRAPH_PAGE_LIMIT = 100
const MAX_GRAPH_PAGES = 20
const MANUAL_BACKUP_ID = 'manual_before_oauth'
const AUTHORIZED_ASSETS_ID = 'unified'
const META_STATE_CONFIG_KEYS = [
  'meta_config_disconnected',
  'meta_test_event_code',
  'meta_webhook_verify_token',
  'meta_whatsapp_business_account_id',
  'meta_whatsapp_purchase_enabled',
  'meta_whatsapp_schedule_enabled',
  'meta_payment_purchase_event_config',
  'meta_messenger_messaging_enabled',
  'meta_instagram_messaging_enabled',
  'meta_facebook_comments_enabled',
  'meta_instagram_comments_enabled',
  'meta_oauth_relay_last_received_at'
]
const META_REQUIRED_PAGE_TASKS = ['ANALYZE', 'MESSAGING', 'MODERATE']

// Los permisos finales los controla la configuración de Facebook Login for
// Business del Installer. Esta lista local sirve para diagnóstico y para hacer
// visibles las capacidades que no quedaron concedidas; nunca agrega scopes al
// vuelo ni intenta saltarse la configuración aprobada por Meta.
export const META_OAUTH_SOCIAL_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'pages_read_user_content',
  'pages_messaging',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages'
]

export const META_OAUTH_ADS_REQUIRED_SCOPES = [
  'ads_read'
]

export const META_OAUTH_SCOPES_BY_KIND = Object.freeze({
  social: META_OAUTH_SOCIAL_REQUIRED_SCOPES,
  ads: META_OAUTH_ADS_REQUIRED_SCOPES
})

// El Config ID unificado del Installer concede en una sola autorización Ads,
// Dataset, Pages, Instagram, mensajes y comentarios. El Installer amplía los
// User Access Tokens y conserva compatibilidad con BISU heredado. Publicar/editar campañas
// sigue fuera de este flujo: cuando el producto lo habilite deberá solicitar y
// revisar `ads_management` explícitamente, no exigirlo para reportes/CAPI.
export const META_OAUTH_REQUIRED_SCOPES = [
  ...META_OAUTH_ADS_REQUIRED_SCOPES,
  'business_management',
  ...META_OAUTH_SOCIAL_REQUIRED_SCOPES
]

let metaOAuthFetch = nodeFetch
const defaultCentralClient = {
  claimHandoff: claimCentralOAuthHandoff,
  connect: connectCentralMetaOAuth,
  createConnectUrl: createCentralMetaOAuthConnectUrl,
  disconnect: disconnectCentralMetaOAuth,
  getStatus: getCentralMetaOAuthStatus,
  updateWebhookSubscription: updateCentralMetaWebhookSubscription
}
let centralClient = { ...defaultCentralClient }
const defaultRuntimeClient = {
  enableSocialChannels: enableMetaSocialChannelsForConnectedProfiles,
  ensurePageSubscription: ensureMetaPageMessagingSubscription,
  removePageSubscription: removeMetaPageMessagingSubscription,
  startSocialHistory: syncMetaSocialConversationHistoryInBackground,
  syncCrons: syncRegisteredIntegrationCronsForProvider,
  updateRecentAds
}
let runtimeClient = { ...defaultRuntimeClient }
let metaConnectionMutationRunning = false
let metaOAuthCleanupTimer = null
let markLocalRelayRegisteredForTest = null

export function setMetaOAuthFetchForTest(fetchImpl) {
  metaOAuthFetch = typeof fetchImpl === 'function' ? fetchImpl : nodeFetch
}

export function setMetaOAuthCentralClientForTest(overrides = null) {
  centralClient = overrides && typeof overrides === 'object'
    ? { ...defaultCentralClient, ...overrides }
    : { ...defaultCentralClient }
}

export function setMetaOAuthRuntimeClientForTest(overrides = null) {
  runtimeClient = overrides && typeof overrides === 'object'
    ? { ...defaultRuntimeClient, ...overrides }
    : { ...defaultRuntimeClient }
}

export function setMetaOAuthMarkLocalRelayForTest(override = null) {
  markLocalRelayRegisteredForTest = typeof override === 'function' ? override : null
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isMetaOAuthConnectionMode(value) {
  return ['oauth_user', 'oauth_bisu'].includes(normalizeMetaConnectionMode(value))
}

function resolveMetaOAuthConnectionMode(handoffMeta = {}) {
  const explicitMode = cleanString(
    handoffMeta.connection_mode || handoffMeta.connectionMode
  ).toLowerCase()
  if (explicitMode === 'oauth_user' || explicitMode === 'oauth_bisu') return explicitMode

  const debugTokenType = cleanString(
    handoffMeta.debug_token_type || handoffMeta.debugTokenType
  ).toUpperCase()
  if (debugTokenType === 'USER') return 'oauth_user'
  if (debugTokenType === 'SYSTEM_USER') return 'oauth_bisu'

  const source = cleanString(handoffMeta.source).toLowerCase()
  return source === 'oauth_bisu' ? 'oauth_bisu' : 'oauth_user'
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toStringArray(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  return [...new Set(source.map(item => cleanString(
    typeof item === 'object' ? item.permission || item.name || item.scope : item
  )).filter(Boolean))]
}

function normalizeGranularScopes(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      scope: cleanString(item.scope || item.permission || item.name),
      targetIds: toStringArray(item.target_ids || item.targetIds || item.targets)
    }))
    .filter(item => item.scope)
}

function normalizeInstant(value) {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null
  const numeric = Number(value)
  const parsed = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function parseUtcDbInstant(value) {
  const clean = cleanString(value)
  if (!clean) return NaN
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(clean)
    ? `${clean.replace(' ', 'T')}Z`
    : clean
  return Date.parse(normalized)
}

function normalizeAdAccountId(value) {
  return cleanString(value).replace(/^act_/i, '')
}

function graphAdAccountId(value) {
  const id = normalizeAdAccountId(value)
  return id ? `act_${id}` : ''
}

function metaOAuthError(message, statusCode = 400, code = 'META_OAUTH_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function safeGraphNextUrl(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  try {
    const url = new URL(clean)
    if (url.protocol !== 'https:' || !/(^|\.)facebook\.com$/i.test(url.hostname)) return ''
    return url.toString()
  } catch {
    return ''
  }
}

async function graphJson(pathOrUrl, { token, appSecretProof = '', fields = '', query = {} } = {}) {
  const url = /^https:\/\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${API_URLS.META_GRAPH}/${String(pathOrUrl || '').replace(/^\/+/, '')}`)
  if (fields) url.searchParams.set('fields', fields)
  if (cleanString(appSecretProof)) url.searchParams.set('appsecret_proof', cleanString(appSecretProof))
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  let response
  try {
    response = await metaOAuthFetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch {
    throw metaOAuthError('No se pudo contactar Meta Graph.', 502, 'META_GRAPH_UNREACHABLE')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.error) {
    const message = data?.error?.message || `Meta Graph respondió ${response.status}`
    throw metaOAuthError(message, response.status >= 400 ? response.status : 502, 'META_GRAPH_ERROR')
  }
  return data
}

async function graphCollection(path, { token, appSecretProof = '', fields = '', query = {} } = {}) {
  const rows = []
  let next = path
  let page = 0
  while (next && page < MAX_GRAPH_PAGES) {
    const data = await graphJson(next, {
      token,
      appSecretProof,
      fields: page === 0 ? fields : '',
      query: page === 0 ? { limit: GRAPH_PAGE_LIMIT, ...query } : {}
    })
    if (Array.isArray(data?.data)) rows.push(...data.data)
    next = safeGraphNextUrl(data?.paging?.next)
    page += 1
  }
  return rows
}

function mergeById(primary = [], fallback = []) {
  const byId = new Map()
  for (const item of [...fallback, ...primary]) {
    const id = cleanString(item?.id)
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...item, id })
  }
  return [...byId.values()]
}

function enrichAuthorizedAssets(authorized = [], live = [], normalizeId = value => cleanString(value)) {
  const liveById = new Map(live.map(item => [normalizeId(item?.id), item]).filter(([id]) => id))
  return authorized.flatMap(item => {
    const id = normalizeId(item?.id)
    const liveItem = liveById.get(id)
    return id ? [{ ...item, ...(liveItem || {}), id: cleanString(liveItem?.id || item?.id) }] : []
  })
}

function normalizeHintAssets(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const businesses = Array.isArray(source.businesses) ? source.businesses : []
  const singularBusinessId = cleanString(source.business_id || source.businessId)
  if (singularBusinessId && !businesses.some(item => cleanString(item?.id) === singularBusinessId)) {
    businesses.push({ id: singularBusinessId, name: '' })
  }

  const flatPixels = Array.isArray(source.pixels) ? source.pixels : []
  const flatInstagram = Array.isArray(source.instagram_accounts) ? source.instagram_accounts : []
  const adAccounts = (Array.isArray(source.ad_accounts) ? source.ad_accounts : []).map(account => ({
    id: graphAdAccountId(account?.id || account?.account_id),
    name: cleanString(account?.name),
    businessId: cleanString(account?.business_id || account?.businessId || account?.business?.id),
    currency: cleanString(account?.currency),
    timezoneName: cleanString(account?.timezone_name || account?.timezoneName),
    status: account?.account_status ?? account?.status ?? null,
    pixels: mergeById(
      flatPixels
        .filter(pixel => {
          const directAccount = normalizeAdAccountId(pixel?.ad_account_id || pixel?.adAccountId)
          const pixelBusiness = cleanString(pixel?.business_id || pixel?.businessId)
          const accountBusiness = cleanString(account?.business_id || account?.businessId || account?.business?.id)
          return directAccount === normalizeAdAccountId(account?.id || account?.account_id) || (
            pixelBusiness && accountBusiness && pixelBusiness === accountBusiness
          )
        })
        .map(pixel => {
          const businessId = cleanString(pixel?.business_id || pixel?.businessId)
          return {
            id: cleanString(pixel?.id),
            name: cleanString(pixel?.name),
            ...(businessId ? { businessId } : {})
          }
        }),
      (Array.isArray(account?.pixels) ? account.pixels : [])
        .map(pixel => ({ id: cleanString(pixel?.id), name: cleanString(pixel?.name) }))
    )
  })).filter(account => account.id)
  const pages = (Array.isArray(source.pages) ? source.pages : []).map(page => {
    const pageId = cleanString(page?.id)
    const nested = [page?.instagram_business_account, page?.connected_instagram_account]
      .filter(Boolean)
    const instagramAccounts = mergeById(
      nested.map(account => ({
        id: cleanString(account?.id),
        username: cleanString(account?.username),
        name: cleanString(account?.name),
        pageId
      })),
      flatInstagram
        .filter(account => cleanString(account?.page_id || account?.pageId) === pageId)
        .map(account => ({
          id: cleanString(account?.id),
          username: cleanString(account?.username),
          name: cleanString(account?.name),
          pageId
        }))
    )
    return {
      id: pageId,
      name: cleanString(page?.name),
      category: cleanString(page?.category),
      businessId: cleanString(page?.business_id || page?.businessId || page?.business?.id),
      tasksAvailable: page?.tasks_available === true || Array.isArray(page?.tasks),
      tasks: Array.isArray(page?.tasks) ? toStringArray(page.tasks).map(task => task.toUpperCase()) : [],
      instagramAccounts
    }
  }).filter(page => page.id)

  return {
    businesses: businesses.map(item => ({ id: cleanString(item?.id), name: cleanString(item?.name) })).filter(item => item.id),
    adAccounts,
    pages
  }
}

export function extractPageSecrets(value = {}) {
  const pages = Array.isArray(value?.pages) ? value.pages : []
  return Object.fromEntries(pages.map(page => {
    const pageId = cleanString(page?.id)
    return [pageId, {
      pageAccessToken: cleanString(page?.page_access_token || page?.pageAccessToken),
      pageAppSecretProof: cleanString(page?.page_appsecret_proof || page?.pageAppSecretProof)
    }]
  }).filter(([pageId, secrets]) => pageId && secrets.pageAccessToken))
}

async function discoverPages({ token, appSecretProof = '', userId, systemUser = false }) {
  const richFields = [
    'id',
    'name',
    'category',
    'tasks',
    'business{id,name}',
    'instagram_business_account{id,username,name}',
    'connected_instagram_account{id,username,name}'
  ].join(',')
  const fallbackFields = [
    'id',
    'name',
    'category',
    'business{id,name}',
    'instagram_business_account{id,username,name}',
    'connected_instagram_account{id,username,name}'
  ].join(',')
  if (systemUser && userId) {
    try {
      const pages = await graphCollection(`${encodeURIComponent(userId)}/assigned_pages`, {
        token,
        appSecretProof,
        fields: richFields
      })
      if (pages.length || systemUser) return pages
    } catch (error) {
      logger.warn(`Meta OAuth no devolvió assigned_pages: ${error.message}`)
      if (systemUser) return []
    }
  }
  try {
    const pages = await graphCollection('me/accounts', { token, appSecretProof, fields: richFields })
    if (pages.length) return pages
  } catch (error) {
    logger.warn(`Meta OAuth no devolvió páginas por me/accounts: ${error.message}`)
  }
  return graphCollection('me/accounts', { token, appSecretProof, fields: fallbackFields })
    .catch(error => {
      logger.warn(`Meta OAuth no devolvió páginas con fields básicos: ${error.message}`)
      return []
    })
}

async function discoverAdAccounts({ token, appSecretProof = '', userId, systemUser = false }) {
  const fields = 'id,account_id,name,currency,timezone_name,account_status,business{id,name}'
  if (systemUser && userId) {
    try {
      const accounts = await graphCollection(`${encodeURIComponent(userId)}/assigned_ad_accounts`, {
        token,
        appSecretProof,
        fields
      })
      if (accounts.length || systemUser) return accounts
    } catch (error) {
      logger.warn(`Meta OAuth no devolvió assigned_ad_accounts: ${error.message}`)
      if (systemUser) return []
    }
  }
  try {
    const accounts = await graphCollection('me/adaccounts', { token, appSecretProof, fields })
    if (accounts.length) return accounts
  } catch (error) {
    logger.warn(`Meta OAuth no devolvió cuentas por me/adaccounts: ${error.message}`)
  }
  return []
}

async function discoverBusinessPixels({ token, appSecretProof = '', businessIds = [] }) {
  const rows = await Promise.all([...new Set(businessIds.map(cleanString).filter(Boolean))].map(async businessId => {
    const [owned, client] = await Promise.all([
      graphCollection(`${encodeURIComponent(businessId)}/owned_pixels`, {
        token,
        appSecretProof,
        fields: 'id,name'
      }).catch(error => {
        logger.warn(`Meta OAuth no devolvió Datasets propios para ${businessId}: ${error.message}`)
        return []
      }),
      graphCollection(`${encodeURIComponent(businessId)}/client_pixels`, {
        token,
        appSecretProof,
        fields: 'id,name'
      }).catch(error => {
        logger.warn(`Meta OAuth no devolvió Datasets compartidos para ${businessId}: ${error.message}`)
        return []
      })
    ])
    return mergeById(owned, client).map(pixel => ({
      id: cleanString(pixel?.id),
      name: cleanString(pixel?.name),
      businessId
    }))
  }))
  return mergeById(rows.flat(), [])
}

/** Descubrimiento local: el Installer entrega el token, no la selección final. */
export async function discoverMetaOAuthAssets({ token, handoffMeta = {}, integrationKind = '' } = {}) {
  const accessToken = cleanString(token)
  const appSecretProof = cleanString(handoffMeta.appsecret_proof || handoffMeta.appSecretProof)
  const kind = cleanString(integrationKind).toLowerCase()
  const splitKind = ['social', 'ads'].includes(kind) ? kind : ''
  const requiredScopes = splitKind ? META_OAUTH_SCOPES_BY_KIND[splitKind] : META_OAUTH_REQUIRED_SCOPES
  if (!accessToken) throw metaOAuthError('El handoff de Meta no incluyó token.', 400, 'META_OAUTH_TOKEN_MISSING')
  const hintAssets = normalizeHintAssets(handoffMeta.assets)
  const hintedUserId = cleanString(handoffMeta.user_id || handoffMeta.userId)
  const connectionMode = resolveMetaOAuthConnectionMode(handoffMeta)
  const systemUser = connectionMode === 'oauth_bisu'
  let identity = {
    id: hintedUserId,
    name: cleanString(handoffMeta.user_name || handoffMeta.userName)
  }
  if (systemUser && hintedUserId) {
    identity = await graphJson(hintedUserId, { token: accessToken, appSecretProof, fields: 'id,name' })
      .then(value => ({ ...identity, ...value }))
      .catch(error => {
        logger.warn(`Meta OAuth no devolvió la identidad explícita ${hintedUserId}: ${error.message}`)
        return identity
      })
  } else if (!systemUser) {
    identity = await graphJson('me', { token: accessToken, appSecretProof, fields: 'id,name' })
      .then(value => ({ ...identity, ...value }))
  }
  const userId = cleanString(identity?.id || hintedUserId)
  if (!userId) throw metaOAuthError('Meta no devolvió la identidad autorizada.', 502, 'META_OAUTH_IDENTITY_MISSING')

  const [permissionsRows, businessesRaw, adAccountsRaw, pagesRaw] = await Promise.all([
    systemUser
      ? Promise.resolve([])
      : graphCollection('me/permissions', { token: accessToken, appSecretProof }).catch(error => {
        logger.warn(`Meta OAuth no devolvió permisos locales: ${error.message}`)
        return []
      }),
    splitKind || systemUser
      ? Promise.resolve([])
      : graphCollection('me/businesses', { token: accessToken, appSecretProof, fields: 'id,name' }).catch(error => {
        logger.warn(`Meta OAuth no devolvió portafolios: ${error.message}`)
        return []
      }),
    splitKind === 'social'
      ? Promise.resolve([])
      : discoverAdAccounts({ token: accessToken, appSecretProof, userId, systemUser }),
    splitKind === 'ads'
      ? Promise.resolve([])
      : discoverPages({ token: accessToken, appSecretProof, userId, systemUser })
  ])

  const handoffScopes = toStringArray(handoffMeta.scopes)
  const grantedFromGraph = permissionsRows
    .filter(item => cleanString(item?.status).toLowerCase() === 'granted')
    .map(item => cleanString(item?.permission))
    .filter(Boolean)
  const explicitlyMissing = permissionsRows
    .filter(item => cleanString(item?.status).toLowerCase() !== 'granted')
    .map(item => cleanString(item?.permission))
    .filter(permission => requiredScopes.includes(permission))
  const grantedScopes = permissionsRows.length
    ? handoffScopes.filter(scope => grantedFromGraph.includes(scope))
    : handoffScopes
  const missingScopes = [...new Set([
    ...requiredScopes.filter(scope => !grantedScopes.includes(scope)),
    ...explicitlyMissing
  ])]

  // El candidate/handoff es la allowlist de consentimiento. Graph vivo sólo
  // enriquece esos IDs; una asignación posterior al callback jamás se agrega.
  const liveBusinessesById = new Map(
    businessesRaw
      .map(item => ({ id: cleanString(item?.id), name: cleanString(item?.name) }))
      .filter(item => item.id)
      .map(item => [item.id, item])
  )
  // El handoff firmado del Installer es la allowlist de consentimiento. El edge
  // /me/businesses sólo enriquece nombres: si Meta lo omite o falla, no debemos
  // volver imposible una selección cuyo Ad Account/Page sí confirma ese mismo
  // business_id en Graph vivo.
  const businesses = hintAssets.businesses.map(item => ({
    ...item,
    ...(liveBusinessesById.get(item.id) || {}),
    id: item.id
  }))
  const liveAdAccounts = adAccountsRaw.map(account => {
    const businessId = cleanString(account?.business?.id)
    return {
      id: graphAdAccountId(account?.id || account?.account_id),
      name: cleanString(account?.name),
      ...(businessId ? { businessId } : {}),
      currency: cleanString(account?.currency),
      timezoneName: cleanString(account?.timezone_name),
      status: account?.account_status ?? null
    }
  })
  const rawAdAccounts = enrichAuthorizedAssets(
    hintAssets.adAccounts,
    liveAdAccounts,
    normalizeAdAccountId
  )

  const businessPixels = splitKind === 'social'
    ? []
    : await discoverBusinessPixels({
        token: accessToken,
        appSecretProof,
        businessIds: [
          ...hintAssets.businesses.map(item => item.id),
          ...rawAdAccounts.map(account => account.businessId)
        ]
      })

  const adAccounts = await Promise.all(rawAdAccounts.map(async account => {
    const graphId = graphAdAccountId(account.id)
    const discoveredPixels = await graphCollection(`${graphId}/adspixels`, {
      token: accessToken,
      appSecretProof,
      fields: 'id,name'
    }).catch(error => {
      logger.warn(`Meta OAuth no devolvió pixels para ${graphId}: ${error.message}`)
      return []
    })
    const accountBusinessId = cleanString(account.businessId) || (
      hintAssets.businesses.length === 1 ? cleanString(hintAssets.businesses[0]?.id) : ''
    )
    const discoveredForBusiness = accountBusinessId
      ? businessPixels.filter(pixel => pixel.businessId === accountBusinessId)
      : []
    return {
      ...account,
      id: graphId,
      pixels: enrichAuthorizedAssets(
        account.pixels,
        mergeById(
          discoveredPixels.map(pixel => ({ id: cleanString(pixel?.id), name: cleanString(pixel?.name) })),
          discoveredForBusiness
        )
      )
    }
  }))

  const livePages = pagesRaw.map(page => {
    const pageId = cleanString(page?.id)
    const instagramAccounts = mergeById([
      page?.instagram_business_account,
      page?.connected_instagram_account
    ].filter(Boolean).map(account => ({
      id: cleanString(account?.id),
      username: cleanString(account?.username),
      name: cleanString(account?.name),
      pageId
    })), [])
    const businessId = cleanString(page?.business?.id)
    return {
      id: pageId,
      name: cleanString(page?.name),
      category: cleanString(page?.category),
      ...(businessId ? { businessId } : {}),
      tasksAvailable: Array.isArray(page?.tasks),
      tasks: Array.isArray(page?.tasks) ? toStringArray(page.tasks).map(task => task.toUpperCase()) : [],
      instagramAccounts
    }
  })
  const pages = enrichAuthorizedAssets(hintAssets.pages, livePages).map(page => {
    const hintPage = hintAssets.pages.find(hint => cleanString(hint?.id) === cleanString(page?.id)) || {}
    const livePage = livePages.find(live => cleanString(live?.id) === cleanString(page?.id)) || {}
    const liveTasksAvailable = livePage.tasksAvailable === true
    return {
      ...page,
      // El handoff fue enumerado por Installer durante el mismo consentimiento.
      // Si el fallback vivo de /me/accounts no devuelve `tasks`, conservar esa
      // evidencia en vez de convertirla en "no sabemos" y omitir el gate.
      tasksAvailable: liveTasksAvailable || hintPage.tasksAvailable === true,
      tasks: liveTasksAvailable ? livePage.tasks : (hintPage.tasks || []),
      instagramAccounts: enrichAuthorizedAssets(
        hintPage.instagramAccounts || [],
        livePage.instagramAccounts || []
      )
    }
  })

  const hintedBusinessId = cleanString(handoffMeta.client_business_id || handoffMeta.business_id)
  const defaults = {
    businessId: businesses.some(item => item.id === hintedBusinessId) ? hintedBusinessId : businesses[0]?.id || '',
    adAccountId: adAccounts[0]?.id || '',
    // El Dataset es una capacidad opcional y siempre exige elección explícita.
    pixelId: '',
    pageId: pages[0]?.id || '',
    instagramAccountId: pages[0]?.instagramAccounts?.[0]?.id || ''
  }

  return {
    connectionMode,
    user: {
      id: userId,
      name: cleanString(identity?.name || handoffMeta.user_name || handoffMeta.userName)
    },
    permissions: {
      granted: grantedScopes,
      missing: missingScopes,
      granular: normalizeGranularScopes(handoffMeta.granular_scopes || handoffMeta.granularScopes)
    },
    businesses,
    adAccounts,
    pages,
    defaults
  }
}

function pendingSagaPageConfig(payload = {}) {
  const saga = payload?.saga || {}
  const pageId = cleanString(saga?.selection?.pageId)
  const pageSecrets = payload?.pageSecrets?.[pageId] || {}
  return {
    access_token: payload?.accessToken,
    connection_mode: resolveMetaOAuthConnectionMode(payload),
    page_id: pageId,
    instagram_account_id: cleanString(saga?.selection?.instagramAccountId),
    oauth_appsecret_proof: payload?.appSecretProof,
    oauth_page_access_token: pageSecrets?.pageAccessToken,
    oauth_page_appsecret_proof: pageSecrets?.pageAppSecretProof
  }
}

function oauthConfigOwnsPage(config = null, pageId = '') {
  const mode = normalizeMetaConnectionMode(config?.connection_mode)
  return Boolean(
    config?.access_token &&
    isMetaOAuthConnectionMode(mode) &&
    cleanString(config?.page_id) === cleanString(pageId)
  )
}

async function removeMetaPageSubscriptionIfUnused({
  config,
  fallbackConfig = null,
  warningLabel = 'page-subscription',
  runtimeWarnings = null
} = {}) {
  const pageId = cleanString(config?.page_id)
  if (!pageId) return { removed: false, reason: 'no-page' }
  try {
    // DELETE /subscribed_apps afecta a toda la app sobre la Page, no sólo al
    // connection_id candidato. Una reconexión combinada o un OAuth Social
    // separado sobre la misma Page deben conservar esa suscripción compartida.
    if (oauthConfigOwnsPage(fallbackConfig, pageId)) {
      return { removed: false, reason: 'combined-page-fallback' }
    }
    if (await hasActiveMetaOAuthSocialPage(pageId)) {
      return { removed: false, reason: 'split-social-page-fallback' }
    }
    await runtimeClient.removePageSubscription({ config })
    return { removed: true, reason: 'unused-page' }
  } catch (error) {
    if (Array.isArray(runtimeWarnings)) runtimeWarnings.push(`${warningLabel}: ${error.message}`)
    logger.warn(`Meta OAuth: ${warningLabel}: ${error.message}`)
    return { removed: false, reason: 'error', error }
  }
}

async function persistPendingPayload(sessionId, payload, status = null) {
  const statusSql = status ? ', status = ?' : ''
  const params = status
    ? [encrypt(JSON.stringify(payload)), status, sessionId]
    : [encrypt(JSON.stringify(payload)), sessionId]
  await db.run(
    `UPDATE meta_oauth_pending_sessions
     SET payload_encrypted = ?, updated_at = CURRENT_TIMESTAMP${statusSql}
     WHERE id = ?`,
    params
  )
}

async function restorePreviousStateIfCandidateStillLocal(payload = {}) {
  const previousState = payload?.saga?.previousState
  if (!previousState) return
  const current = await db.get('SELECT connection_mode, oauth_connection_id FROM meta_config ORDER BY id LIMIT 1').catch(() => null)
  const currentIsCandidate = ['oauth_bisu', 'oauth_user'].includes(cleanString(current?.connection_mode)) &&
    cleanString(current?.oauth_connection_id) === cleanString(payload?.connectionId)
  if (currentIsCandidate) await restoreLocalMetaState(previousState)
}

function inspectCentralPromotion(status = {}, { connectionId, pageId, instagramAccountId, webhookUrl } = {}) {
  const connection = status?.connection || status?.meta?.connection || null
  if (!connection || typeof connection !== 'object') return 'not_promoted'
  const activeConnectionId = cleanString(connection.connection_id || connection.connectionId)
  if (!activeConnectionId) return connection.connected === false ? 'not_promoted' : 'ambiguous'
  if (activeConnectionId !== cleanString(connectionId)) return 'not_promoted'
  const selections = Array.isArray(connection.webhook_selections || connection.webhookSelections)
    ? (connection.webhook_selections || connection.webhookSelections)
    : []
  const matchingRoute = selections.some(selection => {
    const active = selection?.active === true || Number(selection?.active) === 1
    const samePage = cleanString(selection?.page_id || selection?.pageId) === cleanString(pageId)
    const sameInstagram = cleanString(selection?.instagram_account_id || selection?.instagramAccountId) === cleanString(instagramAccountId)
    const sameCallback = cleanString(selection?.callback_url || selection?.callbackUrl) === cleanString(webhookUrl)
    return active && samePage && sameInstagram && sameCallback
  })
  return matchingRoute ? 'promoted' : 'ambiguous'
}

async function reconcileCentralPromotion(payload = {}) {
  try {
    const status = await centralClient.getStatus()
    return inspectCentralPromotion(status, {
      connectionId: payload?.connectionId,
      pageId: payload?.saga?.selection?.pageId,
      instagramAccountId: payload?.saga?.selection?.instagramAccountId,
      webhookUrl: payload?.saga?.webhookUrl
    })
  } catch {
    return 'ambiguous'
  }
}

async function markLocalRelayRegistered(payload = {}, registeredAt = new Date().toISOString()) {
  if (markLocalRelayRegisteredForTest) {
    return markLocalRelayRegisteredForTest(payload, registeredAt)
  }
  const result = await db.run(
    `UPDATE meta_config SET oauth_relay_status = 'registered', oauth_relay_registered_at = ?,
     oauth_relay_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE oauth_connection_id = ? AND connection_mode IN ('oauth_bisu', 'oauth_user')`,
    [registeredAt, payload?.connectionId]
  )
  if (!changedRows(result)) {
    throw metaOAuthError('No se pudo confirmar localmente el relay de Meta.', 500, 'META_OAUTH_RELAY_LOCAL_COMMIT_FAILED')
  }
}

async function compensatePendingOAuthSaga(payload = {}) {
  const saga = payload?.saga
  if (!saga || !['subscribing', 'subscribed', 'local_saved', 'central_registering', 'central_unknown'].includes(cleanString(saga.stage))) {
    return { compensated: true, errors: [] }
  }

  const errors = []
  const selectedPageId = cleanString(saga?.selection?.pageId)
  const selectedInstagramAccountId = cleanString(saga?.selection?.instagramAccountId)
  try {
    await centralClient.updateWebhookSubscription({
      action: 'unregister',
      connectionId: cleanString(payload?.connectionId),
      pageId: selectedPageId,
      instagramAccountId: selectedInstagramAccountId,
      webhookUrl: ''
    })
  } catch (error) {
    errors.push(`relay: ${error.message}`)
  }

  const pageCleanup = await removeMetaPageSubscriptionIfUnused({
    config: pendingSagaPageConfig(payload),
    fallbackConfig: openSnapshotMetaConfig(saga?.previousState?.config),
    warningLabel: 'page-rollback'
  })
  if (pageCleanup.error) errors.push(`page: ${pageCleanup.error.message}`)

  if (!errors.length) {
    try {
      await restorePreviousStateIfCandidateStillLocal(payload)
    } catch (error) {
      errors.push(`local: ${error.message}`)
    }
  }

  return { compensated: errors.length === 0, errors }
}

async function schedulePendingCompensationRetry(row, payload, errors = [], { repair = false } = {}) {
  const now = Date.now()
  const saga = payload.saga || {}
  const attempts = Math.max(0, Number(saga.cleanupAttempts || 0)) + 1
  const retryDelay = Math.min(
    META_OAUTH_COMPENSATION_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 6)),
    META_OAUTH_COMPENSATION_RETRY_MAX_MS
  )
  payload.saga = {
    ...saga,
    cleanupAttempts: attempts,
    nextCleanupAt: new Date(now + retryDelay).toISOString(),
    cleanupDeadline: saga.cleanupDeadline || new Date(now + META_OAUTH_COMPENSATION_TTL_MS).toISOString()
  }
  await persistPendingPayload(row.id, payload, 'cleanup_pending')
  logger.warn(`Meta OAuth dejó una ${repair ? 'reparación del commit' : 'compensación'} pendiente (${errors.map(error => error.split(':')[0]).join(', ') || 'desconocida'}); se reintentará sin exponer credenciales.`)
}

async function markCentralCommitRepairPending(payload = {}, errorMessage = '') {
  await db.run(
    `UPDATE meta_config SET oauth_relay_status = 'repair_pending', oauth_relay_error = ?,
     updated_at = CURRENT_TIMESTAMP
     WHERE oauth_connection_id = ? AND connection_mode IN ('oauth_bisu', 'oauth_user')`,
    [cleanString(errorMessage).slice(0, 500) || 'Falta confirmar el relay local', payload?.connectionId]
  ).catch(() => undefined)
}

async function scheduleCentralCommitRepair(row, payload, errors = []) {
  payload.saga = { ...(payload.saga || {}), stage: 'central_committed' }
  await markCentralCommitRepairPending(payload, errors.join('; '))
  return schedulePendingCompensationRetry(row, payload, errors, { repair: true })
}

function minimizeCentralCommitRepairPayload(payload = {}) {
  const saga = payload?.saga || {}
  return {
    connectionId: cleanString(payload?.connectionId),
    saga: {
      stage: 'central_committed',
      selection: saga.selection || {},
      webhookUrl: cleanString(saga.webhookUrl),
      cleanupAttempts: Number(saga.cleanupAttempts || 0),
      cleanupDeadline: new Date(Date.now() + META_OAUTH_COMPENSATION_TTL_MS).toISOString()
    }
  }
}

export async function cleanupMetaOAuthPendingSessions() {
  const rows = await db.all(
    'SELECT id, payload_encrypted, status, expires_at, updated_at FROM meta_oauth_pending_sessions'
  ).catch(() => [])
  const now = Date.now()
  for (const row of rows) {
    const expiresAtMs = parseUtcDbInstant(row.expires_at)
    const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= now
    if (row.status === 'consumed') {
      await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [row.id]).catch(() => undefined)
      continue
    }
    const updatedAtMs = parseUtcDbInstant(row.updated_at)
    const stale = row.status === 'consuming' && Number.isFinite(updatedAtMs) &&
      now - updatedAtMs > 2 * 60 * 1000
    if (row.status === 'consuming' && !stale) continue
    if (!expired && !stale && row.status !== 'cleanup_pending') continue

    let payload = null
    try {
      payload = row.payload_encrypted ? JSON.parse(decrypt(row.payload_encrypted)) : null
    } catch {
      logger.warn('Sesión Meta OAuth ilegible durante cleanup; se eliminará sin registrar su contenido.')
    }
    const saga = payload?.saga
    const sagaStage = cleanString(saga?.stage)
    const centralDecisionStage = ['central_registering', 'central_unknown', 'central_committed'].includes(sagaStage)
    if (!saga || !['subscribing', 'subscribed', 'local_saved', 'central_registering', 'central_unknown', 'central_committed'].includes(sagaStage)) {
      if (expired || stale || row.status === 'cleanup_pending') {
        await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [row.id]).catch(() => undefined)
      }
      continue
    }

    const cleanupDeadlineMs = normalizeInstant(saga.cleanupDeadline)
      ? Date.parse(normalizeInstant(saga.cleanupDeadline))
      : now + META_OAUTH_COMPENSATION_TTL_MS
    const nextCleanupMs = normalizeInstant(saga.nextCleanupAt)
      ? Date.parse(normalizeInstant(saga.nextCleanupAt))
      : 0
    if (nextCleanupMs > now && cleanupDeadlineMs > now) continue

    if (centralDecisionStage) {
      const promotionState = await reconcileCentralPromotion(payload)
      if (promotionState === 'promoted') {
        payload.saga.stage = 'central_committed'
        try {
          await markLocalRelayRegistered(payload)
          await runMetaOAuthConnectedRuntimeEffects({
            payload,
            selected: saga.selection,
            previousConfig: openSnapshotMetaConfig(saga?.previousState?.config),
            reason: 'meta-oauth-reconciled-after-ambiguous-commit',
            awaitAds: true
          })
          await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [row.id]).catch(() => undefined)
        } catch (error) {
          if (cleanupDeadlineMs <= now) payload = minimizeCentralCommitRepairPayload(payload)
          await scheduleCentralCommitRepair(row, payload, ['local: falta confirmar relay'])
        }
        continue
      }
      if (promotionState === 'ambiguous') {
        if (sagaStage === 'central_committed' || cleanupDeadlineMs <= now) {
          if (cleanupDeadlineMs <= now) payload = minimizeCentralCommitRepairPayload(payload)
          await scheduleCentralCommitRepair(row, payload, [
            sagaStage === 'central_committed'
              ? 'central: commit confirmado, status temporalmente ambiguo'
              : 'central: respuesta ambigua agotó TTL; se conserva B fail-closed sin rollback destructivo'
          ])
          continue
        }
        await schedulePendingCompensationRetry(row, payload, ['central: estado ambiguo'])
        continue
      }
      if (sagaStage === 'central_committed') {
        if (cleanupDeadlineMs <= now) payload = minimizeCentralCommitRepairPayload(payload)
        await scheduleCentralCommitRepair(row, payload, ['central: commit confirmado; ruta aún no visible en status'])
        continue
      }
    }

    const result = await compensatePendingOAuthSaga(payload)
    if (result.compensated) {
      await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [row.id]).catch(() => undefined)
      continue
    }

    if (cleanupDeadlineMs <= now) {
      await restorePreviousStateIfCandidateStillLocal(payload).catch(() => undefined)
      await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [row.id]).catch(() => undefined)
      logger.error('Meta OAuth agotó la ventana de compensación; se purgó el secreto temporal y el relay local queda fail-closed.')
      continue
    }
    await schedulePendingCompensationRetry(row, payload, result.errors)
  }
}

export function startMetaOAuthPendingSessionCleanupScheduler({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (metaOAuthCleanupTimer) return metaOAuthCleanupTimer
  const runCleanup = () => withMetaConnectionLock(() => cleanupMetaOAuthPendingSessions()).catch(error => {
    logger.warn(`No se pudo ejecutar cleanup de sesiones Meta OAuth: ${error.message}`)
  })
  runCleanup()
  metaOAuthCleanupTimer = setInterval(runCleanup, Math.max(60_000, Number(intervalMs) || 5 * 60 * 1000))
  metaOAuthCleanupTimer.unref?.()
  return metaOAuthCleanupTimer
}

export function stopMetaOAuthPendingSessionCleanupScheduler() {
  if (!metaOAuthCleanupTimer) return
  clearInterval(metaOAuthCleanupTimer)
  metaOAuthCleanupTimer = null
}

async function createPendingSession(payload) {
  await cleanupMetaOAuthPendingSessions()
  const id = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + META_OAUTH_SESSION_TTL_MS).toISOString()
  const expiresAtDb = expiresAt.replace('T', ' ').replace('Z', '')
  await db.run(
    `INSERT INTO meta_oauth_pending_sessions (id, payload_encrypted, status, expires_at)
     VALUES (?, ?, 'pending', ?)`,
    [id, encrypt(JSON.stringify(payload)), expiresAtDb]
  )
  return { id, expiresAt }
}

async function readPendingSession(sessionId) {
  await cleanupMetaOAuthPendingSessions()
  const id = cleanString(sessionId)
  const row = id
    ? await db.get('SELECT * FROM meta_oauth_pending_sessions WHERE id = ?', [id])
    : null
  if (!row || row.status !== 'pending') {
    throw metaOAuthError('La sesión OAuth ya fue usada o no existe.', 410, 'META_OAUTH_SESSION_UNAVAILABLE')
  }
  if (!Number.isFinite(parseUtcDbInstant(row.expires_at)) || parseUtcDbInstant(row.expires_at) <= Date.now()) {
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [id]).catch(() => undefined)
    throw metaOAuthError('La sesión OAuth expiró. Vuelve a conectar con Meta.', 410, 'META_OAUTH_SESSION_EXPIRED')
  }
  try {
    return { row, payload: JSON.parse(decrypt(row.payload_encrypted)) }
  } catch {
    throw metaOAuthError('No se pudo abrir la sesión OAuth cifrada.', 500, 'META_OAUTH_SESSION_DECRYPT_FAILED')
  }
}

function changedRows(result) {
  return Number(result?.rowCount ?? result?.changes ?? 0)
}

async function consumePendingSession(sessionId) {
  const result = await db.run(
    `UPDATE meta_oauth_pending_sessions
     SET status = 'consuming', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending' AND expires_at >= CURRENT_TIMESTAMP`,
    [sessionId]
  )
  if (!changedRows(result)) {
    throw metaOAuthError('La sesión OAuth ya fue usada.', 409, 'META_OAUTH_SESSION_ALREADY_USED')
  }
}

function sanitizeSessionData(session, expiresAt) {
  return {
    sessionId: session.id,
    expiresAt,
    connectionMode: resolveMetaOAuthConnectionMode(session),
    user: session.user,
    permissions: session.permissions,
    businesses: session.businesses,
    adAccounts: session.adAccounts,
    pages: session.pages,
    defaults: session.defaults
  }
}

function authorizedAssetsPayload(payload = {}) {
  return {
    connectionId: cleanString(payload.connectionId),
    connectionMode: resolveMetaOAuthConnectionMode(payload),
    source: cleanString(payload.source),
    debugTokenType: cleanString(payload.debugTokenType || payload.debug_token_type).toUpperCase(),
    appId: cleanString(payload.appId),
    configId: cleanString(payload.configId),
    user: payload.user || {},
    tokenExpiresAt: payload.tokenExpiresAt || null,
    dataAccessExpiresAt: payload.dataAccessExpiresAt || null,
    permissions: payload.permissions || { granted: [], missing: [], granular: [] },
    businesses: Array.isArray(payload.businesses) ? payload.businesses : [],
    adAccounts: Array.isArray(payload.adAccounts) ? payload.adAccounts : [],
    pages: Array.isArray(payload.pages) ? payload.pages : [],
    pageSecrets: payload.pageSecrets && typeof payload.pageSecrets === 'object' ? payload.pageSecrets : {}
  }
}

async function saveAuthorizedAssets(payload) {
  const authorized = authorizedAssetsPayload(payload)
  if (!authorized.connectionId) {
    throw metaOAuthError('Falta identificar el inventario autorizado de Meta.', 500, 'META_OAUTH_AUTHORIZED_ASSETS_CONNECTION_MISSING')
  }
  await db.run(
    `INSERT INTO meta_oauth_authorized_assets (id, connection_id, payload_encrypted)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       connection_id = excluded.connection_id,
       payload_encrypted = excluded.payload_encrypted,
       updated_at = CURRENT_TIMESTAMP`,
    [AUTHORIZED_ASSETS_ID, authorized.connectionId, encrypt(JSON.stringify(authorized))]
  )
}

async function loadAuthorizedAssets() {
  const row = await db.get(
    'SELECT connection_id, payload_encrypted FROM meta_oauth_authorized_assets WHERE id = ?',
    [AUTHORIZED_ASSETS_ID]
  ).catch(() => null)
  if (!row?.payload_encrypted) return null
  try {
    const payload = JSON.parse(decrypt(row.payload_encrypted))
    return {
      ...authorizedAssetsPayload(payload),
      connectionId: cleanString(payload?.connectionId || row.connection_id)
    }
  } catch (error) {
    logger.error(`No se pudo abrir el inventario autorizado de Meta: ${error.message}`)
    return null
  }
}

function localMetaOAuthState(config) {
  const connectionMode = config ? normalizeMetaConnectionMode(config.connection_mode) : null
  const oauthConnected = isMetaOAuthConnectionMode(connectionMode) && Number(config?.oauth_connected) === 1
  const lifecycleInstants = [config?.token_expires_at, config?.oauth_data_access_expires_at]
    .map(parseUtcDbInstant)
    .filter(Number.isFinite)
  const nextExpirationAt = lifecycleInstants.length ? Math.min(...lifecycleInstants) : NaN
  const reauthorizationRequired = connectionMode === 'oauth_user' && Number.isFinite(nextExpirationAt) && nextExpirationAt <= Date.now()
  const reauthorizationRecommended = connectionMode === 'oauth_user' && Number.isFinite(nextExpirationAt) &&
    nextExpirationAt > Date.now() && nextExpirationAt <= Date.now() + 14 * 24 * 60 * 60 * 1000
  return {
    connectionMode,
    manualConfigured: Boolean(config?.access_token && connectionMode === 'manual_system_user'),
    oauth: {
      connected: oauthConnected,
      validated: oauthConnected && Number(config?.oauth_validated) === 1,
      connectionId: cleanString(config?.oauth_connection_id),
      userId: cleanString(config?.oauth_user_id),
      userName: cleanString(config?.oauth_user_name),
      appId: cleanString(config?.oauth_app_id || config?.app_id),
      businessId: cleanString(config?.oauth_business_id || config?.meta_business_id),
      configId: cleanString(config?.oauth_config_id),
      grantedScopes: parseJson(config?.oauth_granted_scopes_json, []),
      missingScopes: parseJson(config?.oauth_missing_scopes_json, []),
      granularScopes: parseJson(config?.oauth_granular_scopes_json, []),
      tokenExpiresAt: config?.token_expires_at || null,
      dataAccessExpiresAt: config?.oauth_data_access_expires_at || null,
      reauthorizationRequired,
      reauthorizationRecommended,
      connectedAt: config?.oauth_connected_at || null,
      validatedAt: config?.oauth_validated_at || null,
      relayStatus: cleanString(config?.oauth_relay_status) || 'inactive',
      relayRegisteredAt: config?.oauth_relay_registered_at || null,
      relayError: cleanString(config?.oauth_relay_error)
    }
  }
}

export async function getMetaOAuthConnectionStatus() {
  if (!metaConnectionMutationRunning) await cleanupMetaOAuthPendingSessions()
  const localConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer estado local Meta OAuth: ${error.message}`)
    return null
  })
  const local = localMetaOAuthState(localConfig)
  const manualBackup = await loadManualConnectionBackup()
  let central = {}
  let centralError = ''
  try {
    central = await centralClient.getStatus()
  } catch (error) {
    centralError = error.message || 'No se pudo consultar el Installer'
  }

  return {
    configured: central?.configured === true,
    available: central?.available === true,
    mode: cleanString(central?.mode) || 'redirect',
    source: cleanString(central?.source) || 'oauth_user',
    reviewPending: central?.review_pending !== false,
    connectUrl: '',
    connectEndpoint: '/api/meta/oauth/connect-url',
    appId: cleanString(central?.app_id || central?.appId),
    configId: cleanString(central?.config_id || central?.configId),
    requiredScopes: toStringArray(central?.required_scopes || central?.requiredScopes || META_OAUTH_REQUIRED_SCOPES),
    ...local,
    manualBackupAvailable: Boolean(manualBackup?.config?.access_token),
    centralConnection: central?.connection || null,
    error: centralError || null
  }
}

export async function createMetaOAuthConnectionUrl({ returnPath = '/settings/meta-ads/token' } = {}) {
  const result = await centralClient.createConnectUrl({ returnPath })
  const connectUrl = cleanString(result?.connectUrl || result?.connect_url)
  if (!connectUrl) {
    throw metaOAuthError('El Installer no devolvió una URL de conexión con Meta.', 502, 'META_OAUTH_CONNECT_URL_MISSING')
  }
  return {
    connectUrl,
    mode: cleanString(result?.mode) || 'redirect',
    expiresAt: result?.expires_at || result?.expiresAt || null
  }
}

function unwrapHandoffMeta(handoff = {}) {
  return handoff?.payload?.meta || handoff?.meta || handoff?.payload || handoff || {}
}

export async function completeMetaOAuthConnection({
  code = '',
  configId = '',
  handoffToken = '',
  returnPath = '/settings/meta-ads/token'
} = {}) {
  let token = cleanString(handoffToken)
  let connectMeta = {}
  if (!token) {
    if (!cleanString(code)) {
      throw metaOAuthError('Falta el handoff de Meta. Vuelve a iniciar la conexión.', 400, 'META_OAUTH_HANDOFF_REQUIRED')
    }
    const connected = await centralClient.connect({ code, configId, returnPath })
    token = cleanString(connected.handoffToken)
    connectMeta = connected.meta || {}
  }
  if (!token) throw metaOAuthError('El Installer no devolvió el handoff OAuth.', 502, 'META_OAUTH_HANDOFF_MISSING')

  const handoff = await centralClient.claimHandoff({ provider: 'meta', handoffToken: token })
  const handoffMeta = unwrapHandoffMeta(handoff)
  const accessToken = cleanString(handoffMeta.access_token || handoffMeta.accessToken)
  if (!accessToken) throw metaOAuthError('El handoff de Meta no incluyó acceso.', 502, 'META_OAUTH_ACCESS_MISSING')

  const discovered = await discoverMetaOAuthAssets({ token: accessToken, handoffMeta })
  if (discovered.permissions.missing.length) {
    throw metaOAuthError(
      `Meta no concedió todos los permisos requeridos: ${discovered.permissions.missing.join(', ')}`,
      409,
      'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
  }
  if (!discovered.pages.length) {
    throw metaOAuthError(
      'La autorización no entregó una Página administrable para Messenger e Instagram.',
      409,
      'META_OAUTH_REQUIRED_ASSETS_MISSING'
    )
  }
  const pendingPayload = {
    id: crypto.randomUUID(),
    accessToken,
    appSecretProof: cleanString(handoffMeta.appsecret_proof || handoffMeta.appSecretProof),
    pageSecrets: extractPageSecrets(handoffMeta.assets),
    connectionMode: discovered.connectionMode,
    source: cleanString(handoffMeta.source) || discovered.connectionMode,
    debugTokenType: cleanString(handoffMeta.debug_token_type || handoffMeta.debugTokenType).toUpperCase(),
    connectionId: cleanString(handoffMeta.connection_id || handoffMeta.connectionId || handoff?.id) || crypto.randomUUID(),
    appId: cleanString(handoffMeta.app_id || handoffMeta.appId || connectMeta.app_id || connectMeta.appId),
    configId: cleanString(handoffMeta.config_id || handoffMeta.configId || configId),
    user: discovered.user,
    tokenExpiresAt: normalizeInstant(handoffMeta.expires_at || handoffMeta.expiresAt),
    dataAccessExpiresAt: normalizeInstant(handoffMeta.data_access_expires_at || handoffMeta.dataAccessExpiresAt),
    permissions: discovered.permissions,
    businesses: discovered.businesses,
    adAccounts: discovered.adAccounts,
    pages: discovered.pages,
    defaults: discovered.defaults
  }
  const session = await createPendingSession(pendingPayload)
  return sanitizeSessionData({ ...pendingPayload, id: session.id }, session.expiresAt)
}

export async function prepareMetaOAuthReconfiguration() {
  const config = await getMetaConfig().catch(() => null)
  if (!config || !isMetaOAuthConnectionMode(config.connection_mode)) {
    throw metaOAuthError('Primero conecta Meta con OAuth.', 409, 'META_OAUTH_RECONFIGURE_NOT_CONNECTED')
  }
  const authorized = await loadAuthorizedAssets()
  if (!authorized || cleanString(authorized.connectionId) !== cleanString(config.oauth_connection_id)) {
    throw metaOAuthError(
      'Esta conexión es anterior al selector interno. Autoriza Meta una vez más para guardar todos los activos permitidos.',
      409,
      'META_OAUTH_RECONFIGURE_REAUTH_REQUIRED'
    )
  }
  if (!cleanString(config.access_token) || !cleanString(config.oauth_appsecret_proof)) {
    throw metaOAuthError(
      'La conexión OAuth guardada está incompleta. Vuelve a autorizar Meta.',
      409,
      'META_OAUTH_RECONFIGURE_CREDENTIALS_MISSING'
    )
  }

  const pendingPayload = {
    id: crypto.randomUUID(),
    accessToken: config.access_token,
    appSecretProof: config.oauth_appsecret_proof,
    pageSecrets: authorized.pageSecrets,
    connectionMode: authorized.connectionMode || normalizeMetaConnectionMode(config.connection_mode),
    source: authorized.source || normalizeMetaConnectionMode(config.connection_mode),
    debugTokenType: authorized.debugTokenType || '',
    connectionId: authorized.connectionId,
    appId: authorized.appId || cleanString(config.oauth_app_id || config.app_id),
    configId: authorized.configId || cleanString(config.oauth_config_id),
    user: authorized.user,
    tokenExpiresAt: authorized.tokenExpiresAt || config.token_expires_at || null,
    dataAccessExpiresAt: authorized.dataAccessExpiresAt || config.oauth_data_access_expires_at || null,
    permissions: authorized.permissions,
    businesses: authorized.businesses,
    adAccounts: authorized.adAccounts,
    pages: authorized.pages,
    defaults: {
      businessId: cleanString(config.oauth_business_id || config.meta_business_id),
      adAccountId: normalizeAdAccountId(config.ad_account_id),
      pixelId: cleanString(config.pixel_id),
      pageId: cleanString(config.page_id),
      instagramAccountId: cleanString(config.instagram_account_id)
    }
  }
  const session = await createPendingSession(pendingPayload)
  return sanitizeSessionData({ ...pendingPayload, id: session.id }, session.expiresAt)
}

function validateSelection(payload, selection = {}) {
  const businessId = cleanString(selection.businessId)
  const requestedAdId = normalizeAdAccountId(selection.adAccountId)
  const pixelId = cleanString(selection.pixelId)
  const pageId = cleanString(selection.pageId)
  const instagramAccountId = cleanString(selection.instagramAccountId)

  const business = businessId
    ? payload.businesses.find(item => cleanString(item?.id) === businessId)
    : null
  if (businessId && !business) throw metaOAuthError('El portafolio seleccionado no pertenece a esta autorización.', 400, 'META_OAUTH_BUSINESS_INVALID')

  const adAccount = requestedAdId
    ? payload.adAccounts.find(item => normalizeAdAccountId(item?.id) === requestedAdId)
    : null
  if (requestedAdId && !adAccount) throw metaOAuthError('La cuenta publicitaria no pertenece a esta autorización.', 400, 'META_OAUTH_AD_ACCOUNT_INVALID')
  if (businessId && adAccount?.businessId && cleanString(adAccount.businessId) !== businessId) {
    throw metaOAuthError('La cuenta publicitaria no pertenece al portafolio seleccionado.', 400, 'META_OAUTH_AD_ACCOUNT_BUSINESS_MISMATCH')
  }

  const pixel = pixelId && adAccount
    ? adAccount.pixels.find(item => cleanString(item?.id) === pixelId)
    : null
  if (pixelId && !adAccount) throw metaOAuthError('Selecciona la cuenta publicitaria antes del pixel.', 400, 'META_OAUTH_PIXEL_REQUIRES_AD_ACCOUNT')
  if (pixelId && !pixel) throw metaOAuthError('El pixel no pertenece a la cuenta publicitaria seleccionada.', 400, 'META_OAUTH_PIXEL_INVALID')

  const page = pageId ? payload.pages.find(item => cleanString(item?.id) === pageId) : null
  if (pageId && !page) throw metaOAuthError('La página no pertenece a esta autorización.', 400, 'META_OAUTH_PAGE_INVALID')
  if (businessId && page?.businessId && cleanString(page.businessId) !== businessId) {
    throw metaOAuthError('La página no pertenece al portafolio seleccionado.', 400, 'META_OAUTH_PAGE_BUSINESS_MISMATCH')
  }
  if (page?.tasksAvailable) {
    const pageTasks = new Set(toStringArray(page.tasks).map(task => task.toUpperCase()))
    const missingTasks = META_REQUIRED_PAGE_TASKS.filter(task => !pageTasks.has(task))
    if (missingTasks.length) {
      throw metaOAuthError(
        `La Página no concedió las tareas necesarias (${missingTasks.join(', ')}). Reautoriza Meta con control total de la Página.`,
        409,
        'META_OAUTH_PAGE_TASKS_MISSING'
      )
    }
  }

  const instagramAccount = instagramAccountId && page
    ? page.instagramAccounts.find(item => cleanString(item?.id) === instagramAccountId)
    : null
  if (instagramAccountId && !page) throw metaOAuthError('Selecciona la página enlazada antes de Instagram.', 400, 'META_OAUTH_INSTAGRAM_REQUIRES_PAGE')
  if (instagramAccountId && !instagramAccount) {
    throw metaOAuthError('La cuenta de Instagram no está enlazada a la página seleccionada.', 400, 'META_OAUTH_INSTAGRAM_PAGE_MISMATCH')
  }

  for (const granular of Array.isArray(payload.permissions?.granular) ? payload.permissions.granular : []) {
    const targets = toStringArray(granular?.targetIds || granular?.target_ids)
    if (!targets.length) continue
    const scope = cleanString(granular?.scope)
    let allowed = true
    if (/^ads_/.test(scope) && requestedAdId) {
      allowed = targets.some(target => normalizeAdAccountId(target) === requestedAdId)
    } else if (/^pages_/.test(scope) && pageId) {
      allowed = targets.includes(pageId)
    } else if (/^instagram_/.test(scope) && instagramAccountId) {
      // Meta puede granularizar Instagram contra el IG ID o contra su Page
      // contenedora según el producto/configuración FLFB.
      allowed = targets.includes(instagramAccountId) || targets.includes(pageId)
    }
    if (!allowed) {
      throw metaOAuthError(
        `El permiso ${scope} no incluye el activo seleccionado. Reautoriza Meta eligiendo ese activo.`,
        409,
        'META_OAUTH_GRANULAR_TARGET_MISMATCH'
      )
    }
  }

  return {
    businessId: businessId || cleanString(business?.id),
    adAccountId: requestedAdId,
    pixelId,
    pageId,
    instagramAccountId
  }
}

async function validateDatasetUploadAccess(payload, selected) {
  const datasetId = cleanString(selected?.pixelId)
  if (!datasetId) return { validated: false, reason: 'dataset_not_selected' }

  const businessId = cleanString(selected?.businessId)
  const authorizedUserId = cleanString(payload?.user?.id)
  if (!businessId || !authorizedUserId) {
    throw metaOAuthError(
      'Meta no devolvió el portafolio o la identidad autorizada necesaria para validar el Dataset.',
      409,
      'META_OAUTH_DATASET_IDENTITY_REQUIRED'
    )
  }

  await graphJson(encodeURIComponent(datasetId), {
    token: payload.accessToken,
    appSecretProof: payload.appSecretProof,
    fields: 'id,name'
  }).catch(error => {
    throw metaOAuthError(
      `Ristak no puede leer el Dataset seleccionado: ${error.message}`,
      409,
      'META_OAUTH_DATASET_ACCESS_REQUIRED'
    )
  })

  // Un User Access Token representa al administrador que autorizó el negocio;
  // no aparece necesariamente en /assigned_users, porque ese edge enumera
  // usuarios del negocio y System Users con tareas sobre el Dataset. Haber
  // leído el Dataset con el token/proof y la allowlist firmada es el preflight
  // correcto para este modo. El POST real de CAPI seguirá reportando cualquier
  // revocación posterior sin convertirla en un falso error de configuración.
  if (resolveMetaOAuthConnectionMode(payload) === 'oauth_user') {
    return { validated: true, datasetId, businessId, authorizedUserId, mode: 'oauth_user' }
  }

  const assignedUsers = await graphCollection(`${encodeURIComponent(datasetId)}/assigned_users`, {
    token: payload.accessToken,
    appSecretProof: payload.appSecretProof,
    fields: 'id,name,tasks,permitted_tasks',
    query: { business: businessId }
  }).catch(error => {
    throw metaOAuthError(
      `Meta no permitió validar quién puede enviar eventos al Dataset: ${error.message}`,
      409,
      'META_OAUTH_DATASET_UPLOAD_ACCESS_REQUIRED'
    )
  })
  const assigned = assignedUsers.find(user => cleanString(user?.id) === authorizedUserId)
  const tasks = new Set(toStringArray([
    ...(Array.isArray(assigned?.tasks) ? assigned.tasks : []),
    ...(Array.isArray(assigned?.permitted_tasks) ? assigned.permitted_tasks : [])
  ]).map(task => task.toUpperCase()))
  if (!assigned || !tasks.has('UPLOAD')) {
    throw metaOAuthError(
      'El usuario de sistema no tiene la tarea UPLOAD sobre este Dataset. Asígnale acceso para administrar y enviar eventos desde Meta Business.',
      409,
      'META_OAUTH_DATASET_UPLOAD_ACCESS_REQUIRED'
    )
  }
  return { validated: true, datasetId, businessId, systemUserId: authorizedUserId }
}

function buildRelayWebhookUrl(publicBaseUrl) {
  const base = cleanString(
    publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.APP_URL
  ).replace(/\/+$/, '')
  return base ? `${base}/webhooks/meta/installer-relay` : ''
}

async function getSplitSocialFallback() {
  return getActiveMetaOAuthIntegration('social').catch(error => {
    logger.warn(`No se pudo leer el fallback Social durante la migración Meta: ${error.message}`)
    return null
  })
}

async function suspendSplitSocialRoute(splitSocial, runtimeWarnings = []) {
  if (!splitSocial?.connection_id || !splitSocial?.page_id) return
  try {
    await centralClient.updateWebhookSubscription({
      action: 'unregister',
      integrationKind: 'social',
      connectionId: cleanString(splitSocial.connection_id),
      pageId: cleanString(splitSocial.page_id),
      instagramAccountId: cleanString(splitSocial.instagram_account_id),
      webhookUrl: ''
    })
  } catch (error) {
    runtimeWarnings.push(`split-social-suspend: ${error.message}`)
    logger.warn(`Meta OAuth unificado: no se pudo pausar la ruta Social anterior: ${error.message}`)
  }
}

async function restoreSplitSocialRoute(splitSocial, runtimeWarnings = [], { publicBaseUrl = '', required = false } = {}) {
  if (!splitSocial?.connection_id || !splitSocial?.page_id) return { restored: false, reason: 'missing-split-social' }
  const webhookUrl = buildRelayWebhookUrl(publicBaseUrl)
  if (!webhookUrl) {
    const error = metaOAuthError(
      'No hay URL pública verificada para restaurar la conexión anterior de Facebook e Instagram.',
      409,
      'META_OAUTH_SPLIT_SOCIAL_RESTORE_URL_MISSING'
    )
    if (required) throw error
    runtimeWarnings.push(`split-social-restore: ${error.message}`)
    return { restored: false, reason: 'missing-public-url' }
  }
  try {
    await centralClient.updateWebhookSubscription({
      action: 'register',
      integrationKind: 'social',
      connectionId: cleanString(splitSocial.connection_id),
      pageId: cleanString(splitSocial.page_id),
      instagramAccountId: cleanString(splitSocial.instagram_account_id),
      webhookUrl
    })
    return { restored: true, reason: 'registered' }
  } catch (error) {
    if (required) throw metaOAuthError(
      `No se pudo restaurar la conexión anterior de Facebook e Instagram: ${error.message}`,
      Number(error?.statusCode) || 502,
      'META_OAUTH_SPLIT_SOCIAL_RESTORE_FAILED'
    )
    runtimeWarnings.push(`split-social-restore: ${error.message}`)
    logger.warn(`Meta OAuth unificado: no se pudo restaurar la ruta Social anterior: ${error.message}`)
    return { restored: false, reason: 'error' }
  }
}

function openSnapshotMetaConfig(config = null) {
  if (!config || typeof config !== 'object') return null
  const opened = { ...config }
  for (const key of [
    'access_token',
    'app_secret',
    'messenger_user_token',
    'oauth_appsecret_proof',
    'oauth_page_access_token',
    'oauth_page_appsecret_proof'
  ]) {
    if (!opened[key]) continue
    try {
      opened[key] = decrypt(opened[key])
    } catch {
      // Snapshots antiguos o de tests pueden contener texto ya abierto.
    }
  }
  return opened
}

async function runMetaOAuthConnectedRuntimeEffects({
  payload,
  selected,
  previousConfig = null,
  reason = 'meta-oauth-connected',
  awaitAds = false
} = {}) {
  const runtimeWarnings = []
  if (
    ['oauth_bisu', 'oauth_user'].includes(cleanString(previousConfig?.connection_mode)) &&
    cleanString(previousConfig?.page_id) &&
    cleanString(previousConfig?.page_id) !== cleanString(selected?.pageId)
  ) {
    await removeMetaPageSubscriptionIfUnused({
      config: previousConfig,
      warningLabel: 'previous-page',
      runtimeWarnings
    })
  }

  for (const provider of ['meta', 'meta-ads', 'meta-social']) {
    try {
      await runtimeClient.syncCrons(provider, { reason })
    } catch (error) {
      runtimeWarnings.push(`crons-${provider}: ${error.message}`)
      logger.warn(`Meta OAuth conectado; no se pudieron sincronizar crons ${provider}: ${error.message}`)
    }
  }
  const config = await getMetaConfig().catch(error => {
    runtimeWarnings.push(`config: ${error.message}`)
    return null
  })
  let socialChannels = {}
  try {
    socialChannels = await runtimeClient.enableSocialChannels(config || {})
  } catch (error) {
    runtimeWarnings.push(`social-channels: ${error.message}`)
    logger.warn(`Meta OAuth conectado; no se pudieron activar canales sociales: ${error.message}`)
  }

  const platforms = [
    ...(selected?.pageId ? ['messenger'] : []),
    ...(selected?.instagramAccountId ? ['instagram'] : [])
  ]
  let socialHistoryBackfill = { syncStarted: false, started: [], skipped: [] }
  if (platforms.length) {
    try {
      socialHistoryBackfill = await Promise.resolve(
        runtimeClient.startSocialHistory({ platforms, reason })
      )
    } catch (error) {
      runtimeWarnings.push(`social-history: ${error.message}`)
      logger.warn(`Meta OAuth conectado; no se pudo iniciar backfill social: ${error.message}`)
    }
  }

  const adsSync = { syncStarted: Boolean(selected?.adAccountId) }
  if (selected?.adAccountId) {
    const adsTask = Promise.resolve().then(() => runtimeClient.updateRecentAds())
    if (awaitAds) {
      await adsTask.catch(error => {
        runtimeWarnings.push(`ads: ${error.message}`)
        logger.warn(`Meta OAuth: actualización inicial de Ads falló: ${error.message}`)
      })
    } else {
      adsTask.catch(error => logger.warn(`Meta OAuth: actualización inicial de Ads falló: ${error.message}`))
    }
  }

  return { socialChannels, socialHistoryBackfill, adsSync, runtimeWarnings }
}

async function captureLocalMetaState() {
  const config = await db.get('SELECT * FROM meta_config ORDER BY id LIMIT 1').catch(() => null)
  const rows = await db.all(
    `SELECT config_key, config_value FROM app_config
     WHERE config_key IN (${META_STATE_CONFIG_KEYS.map(() => '?').join(', ')})`,
    META_STATE_CONFIG_KEYS
  ).catch(() => [])
  return {
    config,
    appConfig: Object.fromEntries(rows.map(row => [row.config_key, row.config_value]))
  }
}

async function restoreLocalMetaState(snapshot = {}) {
  await clearMetaIntegrationCredentials()
  await db.run(
    `DELETE FROM app_config WHERE config_key IN (${META_STATE_CONFIG_KEYS.map(() => '?').join(', ')})`,
    META_STATE_CONFIG_KEYS
  )

  const row = snapshot?.config
  if (row && typeof row === 'object') {
    const columns = Object.keys(row)
    await db.run(
      `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => row[column])
    )
  }
  for (const [key, value] of Object.entries(snapshot?.appConfig || {})) {
    await setAppConfig(key, value)
  }
}

async function ensureManualConnectionBackup(snapshot) {
  if (!snapshot?.config?.access_token) return false
  if (normalizeMetaConnectionMode(snapshot.config.connection_mode) !== 'manual_system_user') return false
  await db.run(
    `INSERT INTO meta_oauth_connection_backups (id, payload_encrypted)
     VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload_encrypted = excluded.payload_encrypted,
       updated_at = CURRENT_TIMESTAMP`,
    [MANUAL_BACKUP_ID, encrypt(JSON.stringify(snapshot))]
  )
  return true
}

async function loadManualConnectionBackup() {
  const row = await db.get(
    'SELECT payload_encrypted FROM meta_oauth_connection_backups WHERE id = ?',
    [MANUAL_BACKUP_ID]
  ).catch(() => null)
  if (!row?.payload_encrypted) return null
  try {
    return JSON.parse(decrypt(row.payload_encrypted))
  } catch (error) {
    logger.error(`No se pudo abrir el respaldo manual de Meta: ${error.message}`)
    return null
  }
}

async function finalizeMetaOAuthConnectionUnlocked({
  sessionId,
  businessId = '',
  adAccountId,
  pixelId,
  pageId,
  instagramAccountId,
  publicBaseUrl = ''
} = {}) {
  const { payload } = await readPendingSession(sessionId)
  const splitSocialFallback = await getSplitSocialFallback()
  const migrationWarnings = []
  const selected = validateSelection(payload, {
    businessId: businessId || payload.defaults?.businessId,
    adAccountId: adAccountId === undefined ? payload.defaults?.adAccountId : adAccountId,
    pixelId: pixelId === undefined ? payload.defaults?.pixelId : pixelId,
    pageId: pageId === undefined ? payload.defaults?.pageId : pageId,
    instagramAccountId: instagramAccountId === undefined
      ? payload.defaults?.instagramAccountId
      : instagramAccountId
  })
  if (payload.permissions?.missing?.length) {
    throw metaOAuthError(
      `Meta no concedió todos los permisos requeridos: ${payload.permissions.missing.join(', ')}`,
      409,
      'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
  }
  if (!selected.pageId) {
    throw metaOAuthError(
      'Selecciona una Página antes de terminar. La cuenta publicitaria y el Dataset son opcionales.',
      409,
      'META_OAUTH_REQUIRED_ASSET_SELECTION_MISSING'
    )
  }
  if (!cleanString(payload.appSecretProof)) {
    throw metaOAuthError(
      'El Installer no entregó appsecret_proof para proteger las llamadas a Meta.',
      502,
      'META_OAUTH_APPSECRET_PROOF_MISSING'
    )
  }
  const selectedPageSecrets = payload.pageSecrets?.[selected.pageId] || {}
  if (!cleanString(selectedPageSecrets.pageAccessToken) || !cleanString(selectedPageSecrets.pageAppSecretProof)) {
    throw metaOAuthError(
      'Meta no entregó el acceso protegido de la Página seleccionada.',
      409,
      'META_OAUTH_PAGE_CREDENTIALS_MISSING'
    )
  }
  await validateDatasetUploadAccess(payload, selected)
  await consumePendingSession(sessionId)
  const connectionMode = resolveMetaOAuthConnectionMode(payload)

  const webhookUrl = buildRelayWebhookUrl(publicBaseUrl)
  if (!webhookUrl) {
    await db.run(
      `UPDATE meta_oauth_pending_sessions SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'consuming'`,
      [sessionId]
    ).catch(() => undefined)
    throw metaOAuthError(
      'No hay URL pública verificada para el relay de Meta.',
      409,
      'META_OAUTH_PUBLIC_URL_MISSING'
    )
  }

  const pendingConfig = {
    access_token: payload.accessToken,
    connection_mode: connectionMode,
    page_id: selected.pageId,
    instagram_account_id: selected.instagramAccountId,
    oauth_appsecret_proof: payload.appSecretProof,
    oauth_page_access_token: selectedPageSecrets.pageAccessToken,
    oauth_page_appsecret_proof: selectedPageSecrets.pageAppSecretProof
  }
  const selectedAdAccount = payload.adAccounts.find(account => normalizeAdAccountId(account?.id) === selected.adAccountId)
  let previousState = null
  let previousConfig = null
  let relayResult = null
  let repairPending = null
  try {
    // La intención se cifra ANTES del POST subscribed_apps. Si el proceso cae
    // después de que Meta acepte la suscripción, el cleanup puede deshacerla
    // con el Page token/proof sin depender de memoria del proceso.
    previousState = await captureLocalMetaState()
    previousConfig = await getMetaConfig().catch(() => null)
    await ensureManualConnectionBackup(previousState)
    payload.saga = {
      stage: 'subscribing',
      selection: selected,
      previousState,
      webhookUrl,
      cleanupAttempts: 0,
      cleanupDeadline: new Date(Date.now() + META_OAUTH_COMPENSATION_TTL_MS).toISOString()
    }
    await persistPendingPayload(sessionId, payload, 'consuming')

    // Primero prueba la Page candidata sin tocar la ruta central activa.
    await runtimeClient.ensurePageSubscription({ config: pendingConfig })
    payload.saga.stage = 'subscribed'
    await persistPendingPayload(sessionId, payload, 'consuming')

    const registeredAt = new Date().toISOString()
    await saveMetaConfig(
      selected.adAccountId,
      payload.accessToken,
      selected.pixelId || null,
      selected.pageId || null,
      selected.instagramAccountId || null,
      {
        connectionMode,
        oauthConnectionId: payload.connectionId,
        oauthUserId: payload.user?.id,
        oauthUserName: payload.user?.name,
        oauthAppId: payload.appId,
        oauthBusinessId: selected.businessId,
        oauthConfigId: payload.configId,
        appSecretProof: payload.appSecretProof,
        pageAccessToken: selectedPageSecrets.pageAccessToken,
        pageAppSecretProof: selectedPageSecrets.pageAppSecretProof,
        grantedScopes: payload.permissions?.granted,
        missingScopes: payload.permissions?.missing,
        granularScopes: payload.permissions?.granular,
        tokenExpiresAt: payload.tokenExpiresAt,
        dataAccessExpiresAt: payload.dataAccessExpiresAt,
        validated: true,
        relayStatus: 'pending',
        relayRegisteredAt: null,
        timezoneData: selectedAdAccount?.timezoneName
          ? { timezone_name: selectedAdAccount.timezoneName, timezone_id: null, timezone_offset_hours_utc: null }
          : null
      }
    )
    await setAppConfig('meta_config_disconnected', '0')
    // Conserva cifrada la allowlist completa, incluyendo los Page tokens que
    // Meta entregó para cada Página. Así cambiar entre activos ya autorizados
    // no obliga a repetir OAuth ni expone secretos al navegador.
    await saveAuthorizedAssets(payload)
    payload.saga.stage = 'local_saved'
    await persistPendingPayload(sessionId, payload, 'consuming')

    // Desde aquí el POST puede haber hecho commit aunque la respuesta se pierda.
    // El cleanup DEBE consultar Installer antes de decidir; nunca asume rollback.
    payload.saga.stage = 'central_registering'
    await persistPendingPayload(sessionId, payload, 'consuming')

    // Installer promueve el candidate connection_id y reemplaza la ruta anterior
    // atómicamente. Una promoción confirmada es el punto irreversible: después
    // sólo se repara B localmente; A ya no puede restaurarse como conexión real.
    try {
      relayResult = await centralClient.updateWebhookSubscription({
        action: 'register',
        connectionId: payload.connectionId,
        pageId: selected.pageId,
        instagramAccountId: selected.instagramAccountId,
        webhookUrl
      })
    } catch (registerError) {
      const promotionState = await reconcileCentralPromotion(payload)
      if (promotionState === 'promoted') {
        relayResult = { registered: true, reconciledAfterAmbiguousResponse: true }
      } else if (promotionState === 'ambiguous') {
        payload.saga.stage = 'central_unknown'
        await schedulePendingCompensationRetry(
          { id: sessionId },
          payload,
          ['central: no se pudo confirmar si el commit terminó']
        ).catch(() => undefined)
        const uncertain = metaOAuthError(
          'Meta está confirmando la conexión. No repitas ni cambies credenciales todavía; Ristak la reconciliará automáticamente.',
          503,
          'META_OAUTH_FINALIZATION_UNCERTAIN'
        )
        uncertain.skipMetaOAuthCompensation = true
        throw uncertain
      } else {
        payload.saga.stage = 'local_saved'
        await persistPendingPayload(sessionId, payload, 'consuming').catch(() => undefined)
        throw registerError
      }
    }
    payload.saga.stage = 'central_committed'
    await persistPendingPayload(sessionId, payload, 'consuming').catch(persistError => {
      logger.warn(`Meta OAuth quedó conectado, pero no se pudo marcar la etapa final temporal: ${persistError.message}`)
    })
    if (
      splitSocialFallback?.page_id &&
      cleanString(splitSocialFallback.page_id) !== cleanString(selected.pageId)
    ) {
      await suspendSplitSocialRoute(splitSocialFallback, migrationWarnings)
    }
    try {
      await markLocalRelayRegistered(payload, registeredAt)
    } catch (error) {
      repairPending = error
      await scheduleCentralCommitRepair(
        { id: sessionId },
        payload,
        [`local: ${error.message}`]
      ).catch(() => undefined)
    }
  } catch (error) {
    if (error.skipMetaOAuthCompensation === true) throw error
    const compensation = await compensatePendingOAuthSaga(payload)
    if (compensation.compensated) {
      delete payload.saga
      await persistPendingPayload(sessionId, payload, 'pending').catch(() => undefined)
    } else {
      await schedulePendingCompensationRetry({ id: sessionId }, payload, compensation.errors).catch(() => undefined)
    }
    throw error
  }

  if (repairPending) {
    return {
      connectionMode,
      connected: true,
      validated: true,
      repairPending: true,
      selected,
      permissions: payload.permissions,
      relay: {
        status: 'repair_pending',
        subscribed: true,
        error: 'Installer ya promovió la conexión; falta confirmar el estado local.',
        result: relayResult
      },
      subscription: { subscribed: true, pageId: selected.pageId },
      socialChannels: {},
      socialHistoryBackfill: { syncStarted: false, started: [], skipped: [] },
      adsSync: { syncStarted: false },
      runtimeWarnings: ['relay-local-repair: pendiente', ...migrationWarnings]
    }
  }

  await db.run(
    `UPDATE meta_oauth_pending_sessions
     SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP, payload_encrypted = '', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [sessionId]
  ).catch(error => logger.warn(`Meta OAuth quedó conectado, pero no se pudo cerrar la sesión local: ${error.message}`))

  const runtimeEffects = await runMetaOAuthConnectedRuntimeEffects({
    payload,
    selected,
    previousConfig,
    reason: 'meta-oauth-connected'
  })
  runtimeEffects.runtimeWarnings = [
    ...migrationWarnings,
    ...(runtimeEffects.runtimeWarnings || [])
  ]
  const relay = { status: 'registered', subscribed: true, error: '', result: relayResult }
  const subscription = { subscribed: true, pageId: selected.pageId }

  return {
    connectionMode,
    connected: true,
    validated: true,
    selected,
    permissions: payload.permissions,
    relay,
    subscription,
    ...runtimeEffects
  }
}

async function disconnectMetaOAuthConnectionUnlocked({ publicBaseUrl = '' } = {}) {
  const config = await getMetaConfig().catch(() => null)
  if (!config || !isMetaOAuthConnectionMode(config.connection_mode)) {
    return { disconnected: false, reason: 'not-oauth' }
  }
  const splitSocialFallback = await getSplitSocialFallback()
  const runtimeWarnings = []
  const splitUsesSamePage = Boolean(
    splitSocialFallback?.connection_id &&
    splitSocialFallback?.page_id &&
    cleanString(splitSocialFallback.page_id) === cleanString(config.page_id)
  )
  let splitRestore = { restored: false, reason: 'no-split-social' }

  // Si la Page es distinta, la ruta split fue pausada al promover el login
  // unificado. Restaurarla primero deja una operación reintentable: si falla,
  // todavía no destruimos la conexión actual ni sus secretos locales.
  if (splitSocialFallback?.connection_id && !splitUsesSamePage) {
    splitRestore = await restoreSplitSocialRoute(splitSocialFallback, runtimeWarnings, {
      publicBaseUrl,
      required: true
    })
  }

  await centralClient.updateWebhookSubscription({
    action: 'unregister',
    connectionId: cleanString(config.oauth_connection_id),
    pageId: cleanString(config.page_id),
    instagramAccountId: cleanString(config.instagram_account_id),
    webhookUrl: ''
  })
  await centralClient.disconnect()
  if (splitUsesSamePage) {
    // Installer restaura atómicamente el fallback de la misma Page al quitar la
    // ruta unificada; registrarla otra vez desde Ristak crearía una carrera.
    splitRestore = { restored: true, reason: 'installer-fallback' }
  }
  const splitSocialOwnsPage = await hasActiveMetaOAuthSocialPage(config.page_id)
  if (!splitSocialOwnsPage) {
    await runtimeClient.removePageSubscription({ config }).catch(error => {
      // El mapping central ya quedó apagado, así que no quedan entregas al tenant.
      // La limpieza remota de subscribed_apps puede reintentarse sin conservar el
      // BISU token como conexión activa.
      logger.warn(`No se pudo quitar subscribed_apps al desconectar Meta OAuth: ${error.message}`)
    })
  }

  const manualBackup = await loadManualConnectionBackup()
  const splitConnections = await db.get(
    `SELECT COUNT(*) AS total FROM meta_oauth_integrations WHERE status = 'active'`
  ).catch(() => ({ total: 0 }))
  const preserveSplitRuntimeState = Number(splitConnections?.total || 0) > 0
  if (manualBackup?.config?.access_token) {
    if (preserveSplitRuntimeState) {
      await db.run('DELETE FROM meta_config')
      const columns = Object.keys(manualBackup.config)
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => manualBackup.config[column])
      )
    } else {
      await restoreLocalMetaState(manualBackup)
    }
  } else {
    if (preserveSplitRuntimeState) {
      await db.run('DELETE FROM meta_config')
    } else {
      await clearMetaIntegrationCredentials()
      await setAppConfig('meta_config_disconnected', '1')
    }
  }
  await db.run('DELETE FROM meta_oauth_pending_sessions')
  await db.run('DELETE FROM meta_oauth_connection_backups WHERE id = ?', [MANUAL_BACKUP_ID])
  await db.run('DELETE FROM meta_oauth_authorized_assets WHERE id = ?', [AUTHORIZED_ASSETS_ID])
  if (preserveSplitRuntimeState) {
    const restoredAdsConfig = await getOperationalMetaConfig().catch(() => null)
    if (restoredAdsConfig?.access_token && restoredAdsConfig?.pixel_id) {
      await ensureMetaConversionEventsEnabledForConnectedPixel({
        accessToken: restoredAdsConfig.access_token,
        pixelId: restoredAdsConfig.pixel_id
      })
    } else {
      await disableMetaConversionEventsForDisconnectedPixel()
    }
  }
  for (const provider of ['meta', 'meta-ads', 'meta-social']) {
    try {
      await runtimeClient.syncCrons(provider, { reason: 'meta-oauth-disconnected' })
    } catch (error) {
      runtimeWarnings.push(`crons-${provider}: ${error.message}`)
      logger.warn(`Meta OAuth desconectado; no se pudieron sincronizar crons ${provider}: ${error.message}`)
    }
  }
  return {
    disconnected: true,
    restoredManual: Boolean(manualBackup?.config?.access_token),
    restoredSplitSocial: splitRestore.restored === true,
    runtimeWarning: runtimeWarnings[0] || null,
    runtimeWarnings
  }
}

async function withMetaConnectionLock(operation) {
  if (metaConnectionMutationRunning) throw metaOAuthError('Otra operación de Meta está en progreso. Intenta de nuevo.', 409, 'META_OAUTH_CONNECTION_BUSY')
  metaConnectionMutationRunning = true
  try {
    const execution = await withCronLock(
      'meta-oauth-connection-mutation',
      2 * 60 * 1000,
      operation,
      { failOpen: false, leaseTtlMs: 5 * 60 * 1000 }
    )
    if (!execution.ran) throw metaOAuthError('Otra operación de Meta está en progreso. Intenta de nuevo.', 409, 'META_OAUTH_CONNECTION_BUSY')
    return execution.result
  } finally {
    metaConnectionMutationRunning = false
  }
}

export function finalizeMetaOAuthConnection(options = {}) {
  return withMetaConnectionLock(() => finalizeMetaOAuthConnectionUnlocked(options))
}

export function disconnectMetaOAuthConnection(options = {}) {
  return withMetaConnectionLock(() => disconnectMetaOAuthConnectionUnlocked(options))
}

export function replaceMetaOAuthWithManualConnection(saveManualConfig, options = {}) {
  return withMetaConnectionLock(async () => {
    await disconnectMetaOAuthConnectionUnlocked(options)
    return saveManualConfig()
  })
}

export async function markMetaOAuthRelayReceived() {
  await setAppConfig('meta_oauth_relay_last_received_at', new Date().toISOString())
}
