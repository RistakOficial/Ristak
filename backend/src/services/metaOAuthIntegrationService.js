import crypto from 'crypto'
import { db } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import {
  claimCentralOAuthHandoff,
  connectCentralMetaOAuth,
  createCentralMetaOAuthConnectUrl,
  disconnectCentralMetaOAuth,
  finalizeCentralMetaOAuth,
  getCentralMetaOAuthStatus,
  updateCentralMetaWebhookSubscription
} from './licenseService.js'
import {
  META_OAUTH_SCOPES_BY_KIND,
  discoverMetaOAuthAssets,
  extractPageSecrets
} from './metaOAuthService.js'
import {
  getActiveMetaOAuthIntegration,
  hasActiveMetaOAuthSocialPage,
  metaOAuthIntegrationCapabilities,
  normalizeMetaOAuthIntegrationKind
} from './metaOAuthIntegrationConfigService.js'
import {
  enableMetaSocialChannelsForConnectedProfiles,
  ensureMetaConversionEventsEnabledForConnectedPixel,
  getMetaConfig,
  getMetaSocialConfig,
  normalizeMetaConnectionMode,
  syncMetaSocialChannelDefaults,
  updateRecentAds
} from './metaAdsService.js'
import {
  ensureMetaPageMessagingSubscription,
  removeMetaPageMessagingSubscription,
  syncMetaSocialConversationHistoryInBackground
} from './metaSocialMessagingService.js'
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js'

const SESSION_TTL_MS = 15 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const REQUIRED_PAGE_TASKS = ['MESSAGING', 'MODERATE']

const defaultCentralClient = {
  claimHandoff: claimCentralOAuthHandoff,
  connect: connectCentralMetaOAuth,
  createConnectUrl: createCentralMetaOAuthConnectUrl,
  disconnect: disconnectCentralMetaOAuth,
  finalize: finalizeCentralMetaOAuth,
  getStatus: getCentralMetaOAuthStatus,
  updateWebhookSubscription: updateCentralMetaWebhookSubscription
}
const defaultRuntimeClient = {
  enableConversionEvents: ensureMetaConversionEventsEnabledForConnectedPixel,
  enableSocialChannels: enableMetaSocialChannelsForConnectedProfiles,
  ensurePageSubscription: ensureMetaPageMessagingSubscription,
  removePageSubscription: removeMetaPageMessagingSubscription,
  startSocialHistory: syncMetaSocialConversationHistoryInBackground,
  syncSocialChannelDefaults: syncMetaSocialChannelDefaults,
  syncCrons: syncRegisteredIntegrationCronsForProvider,
  updateRecentAds
}

let centralClient = { ...defaultCentralClient }
let runtimeClient = { ...defaultRuntimeClient }
let cleanupTimer = null
const localMutations = new Set()

export function setMetaOAuthIntegrationCentralClientForTest(overrides = null) {
  centralClient = overrides && typeof overrides === 'object'
    ? { ...defaultCentralClient, ...overrides }
    : { ...defaultCentralClient }
}

export function setMetaOAuthIntegrationRuntimeClientForTest(overrides = null) {
  runtimeClient = overrides && typeof overrides === 'object'
    ? { ...defaultRuntimeClient, ...overrides }
    : { ...defaultRuntimeClient }
}

function cleanString(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function toStringArray(value) {
  if (Array.isArray(value)) return [...new Set(value.map(cleanString).filter(Boolean))]
  if (typeof value === 'string') return [...new Set(value.split(',').map(cleanString).filter(Boolean))]
  return []
}

function parseJson(value, fallback = []) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeInstant(value) {
  if (!value || Number(value) === 0) return null
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function toSqlUtc(iso) {
  return cleanString(iso).replace('T', ' ').replace('Z', '')
}

function parseSqlUtc(value) {
  const clean = cleanString(value)
  if (!clean) return NaN
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(clean)
    ? `${clean.replace(' ', 'T')}Z`
    : clean)
}

function oauthError(message, statusCode = 400, code = 'META_OAUTH_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function normalizeAdAccountId(value) {
  return cleanString(value).replace(/^act_/i, '')
}

function unwrapHandoffMeta(handoff = {}) {
  return handoff?.payload?.meta || handoff?.meta || handoff?.payload || handoff || {}
}

function handoffIntegrationKind(handoff = {}, meta = {}) {
  return cleanString(
    meta.integration_kind || meta.integrationKind ||
    handoff.integration_kind || handoff.integrationKind ||
    handoff?.payload?.integration_kind || handoff?.payload?.integrationKind
  ).toLowerCase()
}

function buildRelayWebhookUrl(publicBaseUrl) {
  const base = cleanString(
    publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.APP_URL
  ).replace(/\/+$/, '')
  return base ? `${base}/webhooks/meta/installer-relay` : ''
}

function pageRuntimeConfig(payload, selected) {
  const secret = payload.pageSecrets?.[selected.pageId] || {}
  return {
    connection_mode: 'oauth_bisu',
    access_token: payload.accessToken,
    oauth_appsecret_proof: payload.appSecretProof,
    page_id: selected.pageId,
    instagram_account_id: selected.instagramAccountId || null,
    oauth_page_access_token: secret.pageAccessToken,
    oauth_page_appsecret_proof: secret.pageAppSecretProof
  }
}

function snapshotActiveIntegration(row = null) {
  if (!row) return null
  return {
    connection_id: cleanString(row.connection_id),
    page_id: cleanString(row.page_id),
    instagram_account_id: cleanString(row.instagram_account_id),
    access_token: cleanString(row.access_token),
    appsecret_proof: cleanString(row.appsecret_proof),
    page_access_token: cleanString(row.page_access_token),
    page_appsecret_proof: cleanString(row.page_appsecret_proof)
  }
}

function socialRuntimeConfigFromSnapshot(snapshot = null) {
  if (!snapshot?.page_id) return null
  return {
    connection_mode: 'oauth_bisu',
    page_id: snapshot.page_id,
    instagram_account_id: snapshot.instagram_account_id || null,
    access_token: snapshot.access_token,
    oauth_appsecret_proof: snapshot.appsecret_proof,
    oauth_page_access_token: snapshot.page_access_token,
    oauth_page_appsecret_proof: snapshot.page_appsecret_proof
  }
}

async function removeSocialPageSubscriptionIfUnused({
  config,
  ignoreActiveConnectionId = '',
  warningLabel,
  runtimeWarnings = []
} = {}) {
  const pageId = cleanString(config?.page_id)
  if (!pageId) return { removed: false, reason: 'no-page' }
  try {
    if (await hasActiveMetaOAuthSocialPage(pageId, {
      ignoreConnectionId: ignoreActiveConnectionId
    })) return { removed: false, reason: 'page-still-active' }

    // El OAuth combinado legacy usa la misma app central. Si conserva la
    // misma Page, DELETE subscribed_apps también rompería ese fallback. Un
    // token manual no se usa como guard porque puede pertenecer a otra app.
    const legacy = await db.get(
      `SELECT access_token, connection_mode, page_id
       FROM meta_config ORDER BY id LIMIT 1`
    ).catch(() => null)
    const legacyMode = normalizeMetaConnectionMode(legacy?.connection_mode)
    if (
      legacy?.access_token &&
      ['oauth_bisu', 'oauth_user'].includes(legacyMode) &&
      cleanString(legacy.page_id) === pageId
    ) {
      return { removed: false, reason: 'legacy-oauth-page-fallback' }
    }

    await runtimeClient.removePageSubscription({ config })
    return { removed: true, reason: 'unused-page' }
  } catch (error) {
    const warning = `${warningLabel || 'page-subscription'}: ${error.message}`
    runtimeWarnings.push(warning)
    logger.warn(`Meta Social OAuth: ${warning}`)
    return { removed: false, reason: 'error' }
  }
}

async function runPostActivationRuntimeEffects({ kind, payload, selected, previous = null } = {}) {
  const runtimeWarnings = []
  if (kind === 'social') {
    const previousSnapshot = payload?.saga?.previousActive || snapshotActiveIntegration(previous)
    if (
      previousSnapshot?.page_id &&
      cleanString(previousSnapshot.connection_id) !== cleanString(payload.connectionId)
    ) {
      await removeSocialPageSubscriptionIfUnused({
        config: socialRuntimeConfigFromSnapshot(previousSnapshot),
        warningLabel: 'previous-page',
        runtimeWarnings
      })
    }

    const config = await getMetaSocialConfig().catch(error => {
      runtimeWarnings.push(`social-config: ${error.message}`)
      return null
    })
    await runtimeClient.syncSocialChannelDefaults({
      previousPageId: previousSnapshot?.page_id,
      previousInstagramAccountId: previousSnapshot?.instagram_account_id,
      nextPageId: selected.pageId,
      nextInstagramAccountId: selected.instagramAccountId
    }).catch(error => {
      runtimeWarnings.push(`social-defaults: ${error.message}`)
    })
    const socialChannels = await runtimeClient.enableSocialChannels(config || {}).catch(error => {
      runtimeWarnings.push(`social-channels: ${error.message}`)
      return {}
    })
    const platforms = [
      ...(selected.pageId ? ['messenger'] : []),
      ...(selected.instagramAccountId ? ['instagram'] : [])
    ]
    const socialHistoryBackfill = platforms.length
      ? await Promise.resolve(runtimeClient.startSocialHistory({
        platforms,
        reason: 'meta-social-oauth-connected'
      })).catch(error => {
        runtimeWarnings.push(`social-history: ${error.message}`)
        return { syncStarted: false, started: [], skipped: platforms }
      })
      : { syncStarted: false, started: [], skipped: [] }
    await runtimeClient.syncCrons('meta-social', { reason: 'meta-social-oauth-connected' }).catch(error => {
      runtimeWarnings.push(`crons: ${error.message}`)
    })
    await runtimeClient.syncCrons('meta', { reason: 'meta-oauth-connected' }).catch(error => {
      runtimeWarnings.push(`version-cron: ${error.message}`)
    })
    return {
      conversionEvents: { enabled: false, reason: 'social_connection' },
      socialChannels,
      socialHistoryBackfill,
      adsSync: { syncStarted: false },
      runtimeWarnings
    }
  }

  const conversionEvents = selected.pixelId
    ? await runtimeClient.enableConversionEvents({
        accessToken: payload.accessToken,
        pixelId: selected.pixelId
      }).catch(error => {
        runtimeWarnings.push(`conversion-events: ${error.message}`)
        return { enabled: false, reason: 'runtime_error' }
      })
    : { enabled: false, reason: 'dataset_not_selected' }
  await runtimeClient.syncCrons('meta-ads', { reason: 'meta-ads-oauth-connected' }).catch(error => {
    runtimeWarnings.push(`crons: ${error.message}`)
  })
  await runtimeClient.syncCrons('meta', { reason: 'meta-oauth-connected' }).catch(error => {
    runtimeWarnings.push(`version-cron: ${error.message}`)
  })
  Promise.resolve(runtimeClient.updateRecentAds())
    .catch(error => logger.warn(`Meta Ads OAuth: sincronización inicial falló: ${error.message}`))
  return {
    conversionEvents,
    socialChannels: {},
    socialHistoryBackfill: { syncStarted: false, started: [], skipped: [] },
    adsSync: { syncStarted: true },
    runtimeWarnings
  }
}

function selectedFromRow(row = null) {
  return {
    businessId: cleanString(row?.business_id),
    adAccountId: row?.ad_account_id ? `act_${normalizeAdAccountId(row.ad_account_id)}` : '',
    pixelId: cleanString(row?.dataset_id),
    pageId: cleanString(row?.page_id),
    instagramAccountId: cleanString(row?.instagram_account_id)
  }
}

function localOAuthState(row = null) {
  const connected = Boolean(row && row.status === 'active')
  return {
    connected,
    validated: connected && Number(row?.validated) === 1,
    connectionId: cleanString(row?.connection_id),
    userId: cleanString(row?.user_id),
    userName: cleanString(row?.user_name),
    appId: cleanString(row?.app_id),
    businessId: cleanString(row?.business_id),
    configId: cleanString(row?.config_id),
    grantedScopes: parseJson(row?.granted_scopes_json, []),
    missingScopes: parseJson(row?.missing_scopes_json, []),
    granularScopes: parseJson(row?.granular_scopes_json, []),
    tokenExpiresAt: row?.token_expires_at || null,
    dataAccessExpiresAt: row?.data_access_expires_at || null,
    connectedAt: row?.connected_at || null,
    relayStatus: cleanString(row?.relay_status) || 'inactive',
    relayRegisteredAt: row?.relay_registered_at || null,
    relayError: cleanString(row?.relay_error)
  }
}

async function createPendingSession(integrationKind, payload) {
  await cleanupMetaOAuthIntegrationSessions()
  const id = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await db.run(
    `INSERT INTO meta_oauth_integration_sessions
       (id, integration_kind, payload_encrypted, status, expires_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [id, integrationKind, encrypt(JSON.stringify(payload)), toSqlUtc(expiresAt)]
  )
  return { id, expiresAt }
}

async function readPendingSession(sessionId, integrationKind) {
  const id = cleanString(sessionId)
  const row = id
    ? await db.get(
      `SELECT * FROM meta_oauth_integration_sessions
       WHERE id = ? AND integration_kind = ?`,
      [id, integrationKind]
    )
    : null
  if (!row || row.status !== 'pending') {
    throw oauthError('La sesión OAuth ya fue usada o no existe.', 410, 'META_OAUTH_SESSION_UNAVAILABLE')
  }
  if (!Number.isFinite(parseSqlUtc(row.expires_at)) || parseSqlUtc(row.expires_at) <= Date.now()) {
    await db.run('DELETE FROM meta_oauth_integration_sessions WHERE id = ?', [id]).catch(() => undefined)
    throw oauthError('La sesión OAuth expiró. Vuelve a conectar con Meta.', 410, 'META_OAUTH_SESSION_EXPIRED')
  }
  try {
    return { row, payload: JSON.parse(decrypt(row.payload_encrypted)) }
  } catch {
    throw oauthError('No se pudo abrir la sesión OAuth cifrada.', 500, 'META_OAUTH_SESSION_DECRYPT_FAILED')
  }
}

async function consumePendingSession(sessionId, integrationKind) {
  const result = await db.run(
    `UPDATE meta_oauth_integration_sessions
     SET status = 'consuming', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND integration_kind = ? AND status = 'pending'
       AND expires_at >= CURRENT_TIMESTAMP`,
    [sessionId, integrationKind]
  )
  if (!Number(result?.rowCount ?? result?.changes ?? 0)) {
    throw oauthError('La sesión OAuth ya fue usada.', 409, 'META_OAUTH_SESSION_ALREADY_USED')
  }
}

async function persistSessionPayload(sessionId, payload, status) {
  await db.run(
    `UPDATE meta_oauth_integration_sessions
     SET payload_encrypted = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [encrypt(JSON.stringify(payload)), status, sessionId]
  )
}

function sanitizeSession(payload, session) {
  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    integrationKind: payload.integrationKind,
    user: payload.user,
    permissions: payload.permissions,
    businesses: [],
    adAccounts: payload.integrationKind === 'ads' ? payload.adAccounts : [],
    pages: payload.integrationKind === 'social' ? payload.pages : [],
    defaults: {
      businessId: payload.defaults?.businessId || '',
      adAccountId: payload.integrationKind === 'ads' ? payload.defaults?.adAccountId || '' : '',
      pixelId: payload.integrationKind === 'ads' ? payload.defaults?.pixelId || '' : '',
      pageId: payload.integrationKind === 'social' ? payload.defaults?.pageId || '' : '',
      instagramAccountId: payload.integrationKind === 'social'
        ? payload.defaults?.instagramAccountId || ''
        : ''
    }
  }
}

function validateGranularTargets(payload, selected) {
  for (const granular of Array.isArray(payload.permissions?.granular) ? payload.permissions.granular : []) {
    const targets = toStringArray(granular?.targetIds || granular?.target_ids)
    if (!targets.length) continue
    const scope = cleanString(granular?.scope)
    let allowed = true
    if (payload.integrationKind === 'ads' && /^ads_/.test(scope)) {
      allowed = targets.some(target => normalizeAdAccountId(target) === normalizeAdAccountId(selected.adAccountId))
    } else if (payload.integrationKind === 'social' && /^pages_/.test(scope)) {
      allowed = targets.includes(selected.pageId)
    } else if (payload.integrationKind === 'social' && /^instagram_/.test(scope) && selected.instagramAccountId) {
      allowed = targets.includes(selected.instagramAccountId) || targets.includes(selected.pageId)
    }
    if (!allowed) {
      throw oauthError(
        `El permiso ${scope} no incluye el activo seleccionado. Reautoriza Meta eligiendo ese activo.`,
        409,
        'META_OAUTH_GRANULAR_TARGET_MISMATCH'
      )
    }
  }
}

function validateSplitSelection(payload, selection = {}) {
  const businessId = cleanString(selection.businessId)
  if (payload.integrationKind === 'social') {
    if (selection.adAccountId || selection.ad_account_id || selection.pixelId || selection.datasetId) {
      throw oauthError('La conexión Social no acepta cuentas publicitarias ni datasets.', 400, 'META_OAUTH_SELECTION_SURFACE_MISMATCH')
    }
    const pageId = cleanString(selection.pageId)
    const instagramAccountId = cleanString(selection.instagramAccountId)
    const page = payload.pages.find(item => cleanString(item?.id) === pageId)
    if (!pageId || !page) {
      throw oauthError('Selecciona una Página incluida en esta autorización.', 409, 'META_OAUTH_PAGE_REQUIRED')
    }
    if (businessId && page.businessId && cleanString(page.businessId) !== businessId) {
      throw oauthError('La Página no pertenece al portafolio indicado.', 400, 'META_OAUTH_PAGE_BUSINESS_MISMATCH')
    }
    if (page.tasksAvailable) {
      const tasks = new Set(toStringArray(page.tasks).map(task => task.toUpperCase()))
      const missing = REQUIRED_PAGE_TASKS.filter(task => !tasks.has(task))
      if (missing.length) {
        throw oauthError(
          `La Página no concedió las tareas necesarias (${missing.join(', ')}).`,
          409,
          'META_OAUTH_PAGE_TASKS_MISSING'
        )
      }
    }
    const instagram = instagramAccountId
      ? page.instagramAccounts.find(item => cleanString(item?.id) === instagramAccountId)
      : null
    if (instagramAccountId && !instagram) {
      throw oauthError('Instagram no está enlazado a la Página seleccionada.', 400, 'META_OAUTH_INSTAGRAM_PAGE_MISMATCH')
    }
    const selected = {
      businessId: businessId || cleanString(page.businessId),
      adAccountId: '',
      pixelId: '',
      pageId,
      instagramAccountId
    }
    validateGranularTargets(payload, selected)
    return selected
  }

  if (selection.pageId || selection.page_id || selection.instagramAccountId || selection.instagram_account_id) {
    throw oauthError('La conexión Ads no acepta Página ni Instagram.', 400, 'META_OAUTH_SELECTION_SURFACE_MISMATCH')
  }
  const adAccountId = normalizeAdAccountId(selection.adAccountId)
  const datasetId = cleanString(selection.datasetId || selection.pixelId)
  const adAccount = payload.adAccounts.find(item => normalizeAdAccountId(item?.id) === adAccountId)
  if (!adAccountId || !adAccount) {
    throw oauthError('Selecciona una cuenta publicitaria incluida en esta autorización.', 409, 'META_OAUTH_AD_ACCOUNT_REQUIRED')
  }
  if (businessId && adAccount.businessId && cleanString(adAccount.businessId) !== businessId) {
    throw oauthError('La cuenta publicitaria no pertenece al portafolio indicado.', 400, 'META_OAUTH_AD_ACCOUNT_BUSINESS_MISMATCH')
  }
  const dataset = datasetId
    ? adAccount.pixels.find(item => cleanString(item?.id) === datasetId)
    : null
  if (datasetId && !dataset) {
    throw oauthError(
      'El Dataset/Pixel no pertenece a la cuenta o requiere ampliar el acceso al Dataset en Meta.',
      400,
      'META_OAUTH_DATASET_ACCESS_REQUIRED'
    )
  }
  const selected = {
    businessId: businessId || cleanString(adAccount.businessId),
    adAccountId,
    pixelId: datasetId,
    pageId: '',
    instagramAccountId: ''
  }
  validateGranularTargets(payload, selected)
  return selected
}

async function upsertCandidate(payload, selected, { relayStatus = 'inactive' } = {}) {
  const pageSecret = payload.pageSecrets?.[selected.pageId] || {}
  const rowId = cleanString(payload.localCandidateId) || crypto.randomUUID()
  payload.localCandidateId = rowId
  await db.run(
    `INSERT INTO meta_oauth_integrations (
       id, integration_kind, status, connection_id,
       access_token, appsecret_proof, page_access_token, page_appsecret_proof,
       app_id, config_id, user_id, user_name, business_id,
       ad_account_id, dataset_id, page_id, instagram_account_id,
       granted_scopes_json, missing_scopes_json, granular_scopes_json,
       token_expires_at, data_access_expires_at, validated, relay_status,
       relay_registered_at, relay_error, connected_at
     ) VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL)
     ON CONFLICT(integration_kind, connection_id) DO UPDATE SET
       status = 'candidate', access_token = excluded.access_token,
       appsecret_proof = excluded.appsecret_proof,
       page_access_token = excluded.page_access_token,
       page_appsecret_proof = excluded.page_appsecret_proof,
       app_id = excluded.app_id, config_id = excluded.config_id,
       user_id = excluded.user_id, user_name = excluded.user_name,
       business_id = excluded.business_id, ad_account_id = excluded.ad_account_id,
       dataset_id = excluded.dataset_id, page_id = excluded.page_id,
       instagram_account_id = excluded.instagram_account_id,
       granted_scopes_json = excluded.granted_scopes_json,
       missing_scopes_json = excluded.missing_scopes_json,
       granular_scopes_json = excluded.granular_scopes_json,
       token_expires_at = excluded.token_expires_at,
       data_access_expires_at = excluded.data_access_expires_at,
       validated = 0, relay_status = excluded.relay_status,
       relay_registered_at = NULL, relay_error = NULL,
       connected_at = NULL, updated_at = CURRENT_TIMESTAMP`,
    [
      rowId,
      payload.integrationKind,
      payload.connectionId,
      encrypt(payload.accessToken),
      payload.appSecretProof ? encrypt(payload.appSecretProof) : null,
      pageSecret.pageAccessToken ? encrypt(pageSecret.pageAccessToken) : null,
      pageSecret.pageAppSecretProof ? encrypt(pageSecret.pageAppSecretProof) : null,
      payload.appId || null,
      payload.configId || null,
      payload.user?.id || null,
      payload.user?.name || null,
      selected.businessId || null,
      selected.adAccountId || null,
      selected.pixelId || null,
      selected.pageId || null,
      selected.instagramAccountId || null,
      JSON.stringify(payload.permissions?.granted || []),
      JSON.stringify(payload.permissions?.missing || []),
      JSON.stringify(payload.permissions?.granular || []),
      payload.tokenExpiresAt || null,
      payload.dataAccessExpiresAt || null,
      relayStatus
    ]
  )
  return rowId
}

async function activateCandidate(payload, { relayRegistered = false } = {}) {
  const connectedAt = new Date().toISOString()
  await db.transaction(async tx => {
    await tx.run(
      `UPDATE meta_oauth_integrations SET status = 'replaced', updated_at = CURRENT_TIMESTAMP
       WHERE integration_kind = ? AND status = 'active' AND connection_id != ?`,
      [payload.integrationKind, payload.connectionId]
    )
    const result = await tx.run(
      `UPDATE meta_oauth_integrations
       SET status = 'active', validated = 1, connected_at = ?,
           relay_status = ?, relay_registered_at = ?, relay_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE integration_kind = ? AND connection_id = ? AND status IN ('candidate', 'active')`,
      [
        connectedAt,
        relayRegistered ? 'registered' : 'inactive',
        relayRegistered ? connectedAt : null,
        payload.integrationKind,
        payload.connectionId
      ]
    )
    if (!Number(result?.rowCount ?? result?.changes ?? 0)) {
      throw oauthError('No se encontró la conexión candidata para activarla.', 500, 'META_OAUTH_CANDIDATE_MISSING')
    }
    await tx.run(
      `DELETE FROM meta_oauth_integrations
       WHERE integration_kind = ? AND status = 'replaced'`,
      [payload.integrationKind]
    )
  })
}

async function deleteCandidate(payload) {
  if (!payload?.connectionId || !payload?.integrationKind) return
  await db.run(
    `DELETE FROM meta_oauth_integrations
     WHERE integration_kind = ? AND connection_id = ? AND status = 'candidate'`,
    [payload.integrationKind, payload.connectionId]
  ).catch(() => undefined)
}

async function isCandidatePromotedCentrally(payload) {
  const status = await centralClient.getStatus({ integrationKind: payload.integrationKind })
  const connection = status?.connection || status?.meta?.connection || status
  return Boolean(
    connection?.connected !== false &&
    cleanString(connection?.connection_id || connection?.connectionId) === cleanString(payload.connectionId)
  )
}

async function finalizeUnlocked({
  integrationKind,
  sessionId,
  businessId = '',
  adAccountId = '',
  datasetId = '',
  pixelId = '',
  pageId = '',
  instagramAccountId = '',
  publicBaseUrl = ''
} = {}) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  const { payload } = await readPendingSession(sessionId, kind)
  if (payload.integrationKind !== kind) {
    throw oauthError('La sesión OAuth pertenece a otra conexión de Meta.', 409, 'META_OAUTH_SESSION_KIND_MISMATCH')
  }
  if (payload.permissions?.missing?.length) {
    throw oauthError(
      `Meta no concedió todos los permisos requeridos: ${payload.permissions.missing.join(', ')}`,
      409,
      'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
  }
  const selected = validateSplitSelection(payload, {
    businessId,
    adAccountId,
    datasetId: datasetId || pixelId,
    pageId,
    instagramAccountId
  })
  if (!cleanString(payload.appSecretProof)) {
    throw oauthError('El Installer no entregó appsecret_proof.', 502, 'META_OAUTH_APPSECRET_PROOF_MISSING')
  }
  if (kind === 'social') {
    const pageSecret = payload.pageSecrets?.[selected.pageId] || {}
    if (!pageSecret.pageAccessToken || !pageSecret.pageAppSecretProof) {
      throw oauthError(
        'Meta no entregó el acceso protegido de la Página seleccionada.',
        409,
        'META_OAUTH_PAGE_CREDENTIALS_MISSING'
      )
    }
  }

  await consumePendingSession(sessionId, kind)
  const previous = await getActiveMetaOAuthIntegration(kind)
  let candidateStored = false
  let pageSubscribed = false
  let centralCommitted = false
  let runtimeEffects = null
  const webhookUrl = kind === 'social' ? buildRelayWebhookUrl(publicBaseUrl) : ''
  if (kind === 'social' && !webhookUrl) {
    await db.run(
      `UPDATE meta_oauth_integration_sessions SET status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'consuming'`,
      [sessionId]
    ).catch(() => undefined)
    throw oauthError('No hay URL pública verificada para el relay de Meta.', 409, 'META_OAUTH_PUBLIC_URL_MISSING')
  }

  try {
    payload.saga = {
      stage: 'preparing',
      selected,
      webhookUrl,
      previousActive: snapshotActiveIntegration(previous)
    }
    await persistSessionPayload(sessionId, payload, 'consuming')

    if (kind === 'social') {
      await runtimeClient.ensurePageSubscription({ config: pageRuntimeConfig(payload, selected) })
      pageSubscribed = true
      payload.saga.stage = 'page_subscribed'
      await persistSessionPayload(sessionId, payload, 'consuming')
    }

    await upsertCandidate(payload, selected, { relayStatus: kind === 'social' ? 'pending' : 'inactive' })
    candidateStored = true
    payload.saga.stage = 'candidate_stored'
    await persistSessionPayload(sessionId, payload, 'consuming')

    payload.saga.stage = 'central_registering'
    await persistSessionPayload(sessionId, payload, 'consuming')
    try {
      if (kind === 'social') {
        await centralClient.updateWebhookSubscription({
          action: 'register',
          integrationKind: kind,
          connectionId: payload.connectionId,
          pageId: selected.pageId,
          instagramAccountId: selected.instagramAccountId,
          webhookUrl
        })
      } else {
        await centralClient.finalize({
          integrationKind: kind,
          connectionId: payload.connectionId,
          adAccountId: selected.adAccountId,
          datasetId: selected.pixelId
        })
      }
    } catch (centralError) {
      try {
        if (!await isCandidatePromotedCentrally(payload)) throw centralError
      } catch (reconcileError) {
        if (reconcileError === centralError) throw centralError
        payload.saga.stage = 'central_unknown'
        await persistSessionPayload(sessionId, payload, 'consuming').catch(() => undefined)
        const uncertain = oauthError(
          'Meta está confirmando la conexión. Ristak la reconciliará automáticamente.',
          503,
          'META_OAUTH_FINALIZATION_UNCERTAIN'
        )
        uncertain.preserveCandidate = true
        throw uncertain
      }
    }
    centralCommitted = true
    payload.saga.stage = 'central_committed'
    await persistSessionPayload(sessionId, payload, 'central_committed')

    await activateCandidate(payload, { relayRegistered: kind === 'social' })
    runtimeEffects = await runPostActivationRuntimeEffects({
      kind,
      payload,
      selected,
      previous
    })
    await db.run(
      `UPDATE meta_oauth_integration_sessions
       SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP,
           payload_encrypted = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [sessionId]
    )
  } catch (error) {
    if (centralCommitted) {
      const uncertain = oauthError(
        'Installer confirmó la conexión; Ristak terminará de activarla automáticamente.',
        503,
        'META_OAUTH_LOCAL_ACTIVATION_PENDING'
      )
      uncertain.cause = error
      throw uncertain
    }
    if (error.preserveCandidate === true) throw error
    if (candidateStored) await deleteCandidate(payload)
    if (pageSubscribed) {
      await removeSocialPageSubscriptionIfUnused({
        config: pageRuntimeConfig(payload, selected),
        warningLabel: 'candidate-page-rollback'
      })
    }
    delete payload.saga
    await persistSessionPayload(sessionId, payload, 'pending').catch(() => undefined)
    throw error
  }

  const active = await getActiveMetaOAuthIntegration(kind)
  return {
    integrationKind: kind,
    connectionMode: 'oauth_bisu',
    connected: true,
    validated: true,
    selected,
    permissions: payload.permissions,
    capabilities: metaOAuthIntegrationCapabilities(active),
    relay: kind === 'social'
      ? { status: 'registered', subscribed: true }
      : { status: 'inactive', subscribed: false },
    subscription: kind === 'social'
      ? { subscribed: true, pageId: selected.pageId }
      : { subscribed: false, pageId: '' },
    ...(runtimeEffects || {
      socialChannels: {},
      conversionEvents: { enabled: false, reason: 'runtime-effects-not-run' },
      socialHistoryBackfill: { syncStarted: false, started: [], skipped: [] },
      adsSync: { syncStarted: false },
      runtimeWarnings: ['runtime-effects: not-run']
    })
  }
}

async function withKindLock(integrationKind, operation) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  if (localMutations.has(kind)) {
    throw oauthError('Otra operación de esta conexión Meta está en progreso.', 409, 'META_OAUTH_CONNECTION_BUSY')
  }
  localMutations.add(kind)
  try {
    const execution = await withCronLock(
      `meta-oauth-${kind}-connection-mutation`,
      2 * 60 * 1000,
      operation,
      { failOpen: false, leaseTtlMs: 5 * 60 * 1000 }
    )
    if (!execution.ran) {
      throw oauthError('Otra operación de esta conexión Meta está en progreso.', 409, 'META_OAUTH_CONNECTION_BUSY')
    }
    return execution.result
  } finally {
    localMutations.delete(kind)
  }
}

export async function getMetaOAuthIntegrationStatus(integrationKind) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  if (!localMutations.has(kind)) await cleanupMetaOAuthIntegrationSessions()
  const [row, legacy] = await Promise.all([
    getActiveMetaOAuthIntegration(kind),
    db.get('SELECT * FROM meta_config ORDER BY id LIMIT 1').catch(() => null)
  ])
  let central = {}
  let centralError = ''
  try {
    central = await centralClient.getStatus({ integrationKind: kind })
  } catch (error) {
    centralError = error.message || 'No se pudo consultar el Installer'
  }
  const legacyMode = normalizeMetaConnectionMode(legacy?.connection_mode)
  const manualConfigured = Boolean(legacy?.access_token && legacyMode === 'manual_system_user')
  const legacyCombinedConnected = Boolean(
    legacy?.access_token && ['oauth_bisu', 'oauth_user'].includes(legacyMode)
  )
  return {
    integrationKind: kind,
    configured: central?.configured === true,
    available: central?.available === true,
    mode: cleanString(central?.mode) || 'redirect',
    source: cleanString(central?.source) || 'oauth_bisu',
    reviewPending: central?.review_pending !== false,
    connectUrl: '',
    connectEndpoint: `/api/meta/oauth/${kind}/connect-url`,
    appId: cleanString(central?.app_id || central?.appId),
    configId: '',
    requiredScopes: toStringArray(
      central?.required_scopes || central?.requiredScopes || META_OAUTH_SCOPES_BY_KIND[kind]
    ),
    connectionMode: row ? 'oauth_bisu' : manualConfigured ? 'manual_system_user' : legacyCombinedConnected ? 'oauth_bisu' : null,
    manualConfigured,
    legacyCombinedConnected,
    oauth: localOAuthState(row),
    selected: selectedFromRow(row),
    capabilities: metaOAuthIntegrationCapabilities(row),
    centralConnection: central?.connection || null,
    error: centralError || null
  }
}

export async function createMetaOAuthIntegrationUrl({ integrationKind, returnPath } = {}) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  const result = await centralClient.createConnectUrl({ integrationKind: kind, returnPath })
  const connectUrl = cleanString(result?.connectUrl || result?.connect_url)
  if (!connectUrl) {
    throw oauthError('El Installer no devolvió una URL de conexión con Meta.', 502, 'META_OAUTH_CONNECT_URL_MISSING')
  }
  return {
    integrationKind: kind,
    connectUrl,
    mode: cleanString(result?.mode) || 'redirect',
    expiresAt: result?.expires_at || result?.expiresAt || null
  }
}

export async function completeMetaOAuthIntegration({
  integrationKind,
  code = '',
  configId = '',
  handoffToken = '',
  returnPath = ''
} = {}) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  let token = cleanString(handoffToken)
  let connectMeta = {}
  if (!token) {
    if (!cleanString(code)) {
      throw oauthError('Falta el handoff de Meta.', 400, 'META_OAUTH_HANDOFF_REQUIRED')
    }
    const connected = await centralClient.connect({
      integrationKind: kind,
      code,
      configId,
      returnPath
    })
    token = cleanString(connected.handoffToken)
    connectMeta = connected.meta || {}
  }
  if (!token) throw oauthError('El Installer no devolvió el handoff OAuth.', 502, 'META_OAUTH_HANDOFF_MISSING')

  const handoff = await centralClient.claimHandoff({ provider: 'meta', handoffToken: token })
  const handoffMeta = unwrapHandoffMeta(handoff)
  const claimedKind = handoffIntegrationKind(handoff, handoffMeta)
  if (claimedKind !== kind) {
    throw oauthError('El handoff OAuth pertenece a otra conexión de Meta.', 409, 'META_OAUTH_HANDOFF_KIND_MISMATCH')
  }
  const accessToken = cleanString(handoffMeta.access_token || handoffMeta.accessToken)
  if (!accessToken) throw oauthError('El handoff de Meta no incluyó acceso.', 502, 'META_OAUTH_ACCESS_MISSING')

  const discovered = await discoverMetaOAuthAssets({
    token: accessToken,
    handoffMeta,
    integrationKind: kind
  })
  if (discovered.permissions.missing.length) {
    throw oauthError(
      `Meta no concedió todos los permisos requeridos: ${discovered.permissions.missing.join(', ')}`,
      409,
      'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
  }
  if (kind === 'social' && !discovered.pages.length) {
    throw oauthError('La autorización no entregó una Página administrable.', 409, 'META_OAUTH_REQUIRED_ASSETS_MISSING')
  }
  if (kind === 'ads' && !discovered.adAccounts.length) {
    throw oauthError('La autorización no entregó una cuenta publicitaria.', 409, 'META_OAUTH_REQUIRED_ASSETS_MISSING')
  }

  const payload = {
    integrationKind: kind,
    accessToken,
    appSecretProof: cleanString(handoffMeta.appsecret_proof || handoffMeta.appSecretProof),
    pageSecrets: kind === 'social' ? extractPageSecrets(handoffMeta.assets) : {},
    source: 'oauth_bisu',
    connectionId: cleanString(handoffMeta.connection_id || handoffMeta.connectionId || handoff?.id) || crypto.randomUUID(),
    appId: cleanString(handoffMeta.app_id || handoffMeta.appId || connectMeta.app_id || connectMeta.appId),
    configId: cleanString(handoffMeta.config_id || handoffMeta.configId || configId),
    user: discovered.user,
    tokenExpiresAt: normalizeInstant(handoffMeta.expires_at || handoffMeta.expiresAt),
    dataAccessExpiresAt: normalizeInstant(handoffMeta.data_access_expires_at || handoffMeta.dataAccessExpiresAt),
    permissions: discovered.permissions,
    businesses: discovered.businesses,
    adAccounts: kind === 'ads' ? discovered.adAccounts : [],
    pages: kind === 'social' ? discovered.pages : [],
    defaults: discovered.defaults
  }
  const session = await createPendingSession(kind, payload)
  return sanitizeSession(payload, session)
}

export function finalizeMetaOAuthIntegration(options = {}) {
  const kind = normalizeMetaOAuthIntegrationKind(options.integrationKind)
  return withKindLock(kind, () => finalizeUnlocked({ ...options, integrationKind: kind }))
}

async function disconnectUnlocked(integrationKind) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  const active = await getActiveMetaOAuthIntegration(kind)
  if (!active) return { integrationKind: kind, disconnected: false, reason: 'not-oauth' }
  const runtimeWarnings = []

  if (kind === 'social') {
    await centralClient.updateWebhookSubscription({
      action: 'unregister',
      integrationKind: kind,
      connectionId: active.connection_id,
      pageId: active.page_id,
      instagramAccountId: active.instagram_account_id,
      webhookUrl: ''
    })
  }
  await centralClient.disconnect({ integrationKind: kind })

  if (kind === 'social') {
    await removeSocialPageSubscriptionIfUnused({
      config: socialRuntimeConfigFromSnapshot(snapshotActiveIntegration(active)),
      ignoreActiveConnectionId: active.connection_id,
      warningLabel: 'disconnect-page',
      runtimeWarnings
    })
  }

  await db.transaction(async tx => {
    await tx.run('DELETE FROM meta_oauth_integrations WHERE integration_kind = ?', [kind])
    await tx.run('DELETE FROM meta_oauth_integration_sessions WHERE integration_kind = ?', [kind])
  })
  const fallback = await (kind === 'ads' ? getMetaConfig() : getMetaSocialConfig()).catch(error => {
    runtimeWarnings.push(`fallback-config: ${error.message}`)
    return null
  })
  if (kind === 'social') {
    await runtimeClient.syncSocialChannelDefaults({
      previousPageId: active.page_id,
      previousInstagramAccountId: active.instagram_account_id,
      nextPageId: fallback?.page_id,
      nextInstagramAccountId: fallback?.instagram_account_id
    }).catch(error => {
      runtimeWarnings.push(`social-defaults: ${error.message}`)
    })
    if (fallback?.access_token && fallback?.page_id) {
      await runtimeClient.ensurePageSubscription({ config: fallback }).catch(error => {
        runtimeWarnings.push(`fallback-page: ${error.message}`)
      })
      await runtimeClient.enableSocialChannels(fallback).catch(error => {
        runtimeWarnings.push(`fallback-channels: ${error.message}`)
      })
    }
  }
  await runtimeClient.syncCrons(kind === 'ads' ? 'meta-ads' : 'meta-social', {
    reason: `meta-${kind}-oauth-disconnected`
  }).catch(error => {
    runtimeWarnings.push(`crons: ${error.message}`)
  })
  await runtimeClient.syncCrons('meta', { reason: 'meta-oauth-disconnected' }).catch(error => {
    runtimeWarnings.push(`version-cron: ${error.message}`)
  })
  const fallbackLegacy = Boolean(
    cleanString(fallback?.access_token) && cleanString(
      kind === 'ads' ? fallback?.ad_account_id : fallback?.page_id
    )
  )
  return {
    integrationKind: kind,
    disconnected: true,
    fallbackLegacy,
    restoredLegacy: fallbackLegacy,
    runtimeWarning: runtimeWarnings[0] || null,
    runtimeWarnings
  }
}

export function disconnectMetaOAuthIntegration(integrationKind) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  return withKindLock(kind, () => disconnectUnlocked(kind))
}

async function repairPromotedSession(row, payload) {
  const kind = normalizeMetaOAuthIntegrationKind(payload?.integrationKind)
  const selected = payload?.saga?.selected || {}
  const current = await getActiveMetaOAuthIntegration(kind)
  const previous = payload?.saga?.previousActive || (
    cleanString(current?.connection_id) !== cleanString(payload.connectionId)
      ? snapshotActiveIntegration(current)
      : null
  )
  await activateCandidate(payload, { relayRegistered: kind === 'social' })
  const effects = await runPostActivationRuntimeEffects({
    kind,
    payload,
    selected,
    previous
  })
  for (const warning of effects.runtimeWarnings || []) {
    logger.warn(`Meta OAuth ${kind}: reparación activada con advertencia: ${warning}`)
  }
  await db.run(
    `UPDATE meta_oauth_integration_sessions
     SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP,
         payload_encrypted = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [row.id]
  )
}

export async function cleanupMetaOAuthIntegrationSessions() {
  let rows = []
  try {
    rows = await db.all(
      `SELECT * FROM meta_oauth_integration_sessions
       WHERE status = 'central_committed' OR expires_at < CURRENT_TIMESTAMP`
    )
  } catch (error) {
    if (/no such table|does not exist/i.test(error.message || '')) return { repaired: 0, removed: 0 }
    throw error
  }
  let repaired = 0
  let removed = 0
  for (const row of rows) {
    let payload = null
    try {
      payload = row.payload_encrypted ? JSON.parse(decrypt(row.payload_encrypted)) : null
    } catch {
      payload = null
    }
    if (['central_registering', 'central_unknown'].includes(payload?.saga?.stage)) {
      try {
        if (await isCandidatePromotedCentrally(payload)) {
          await repairPromotedSession(row, payload)
          repaired += 1
          continue
        }
      } catch (error) {
        // Mientras Installer no pueda confirmar el resultado, conservar el
        // candidate cifrado; borrarlo podría dejar un commit remoto sin runtime.
        logger.warn(`Meta OAuth ${payload.integrationKind}: promoción central aún incierta: ${error.message}`)
        continue
      }
    }
    if (row.status === 'central_committed' && payload?.connectionId) {
      try {
        await repairPromotedSession(row, payload)
        repaired += 1
        continue
      } catch (error) {
        logger.warn(`Meta OAuth ${payload.integrationKind}: activación local pendiente: ${error.message}`)
        continue
      }
    }
    if (
      payload?.integrationKind === 'social' &&
      ['page_subscribed', 'candidate_stored', 'central_registering', 'central_unknown'].includes(payload?.saga?.stage)
    ) {
      await removeSocialPageSubscriptionIfUnused({
        config: pageRuntimeConfig(payload, payload.saga.selected || {}),
        warningLabel: 'expired-candidate-page'
      })
    }
    if (payload) await deleteCandidate(payload)
    await db.run('DELETE FROM meta_oauth_integration_sessions WHERE id = ?', [row.id])
    removed += 1
  }
  return { repaired, removed }
}

export function startMetaOAuthIntegrationCleanupScheduler({ intervalMs = CLEANUP_INTERVAL_MS } = {}) {
  if (cleanupTimer) return cleanupTimer
  cleanupMetaOAuthIntegrationSessions().catch(error => logger.warn(`Cleanup Meta OAuth separado falló: ${error.message}`))
  cleanupTimer = setInterval(() => {
    cleanupMetaOAuthIntegrationSessions().catch(error => logger.warn(`Cleanup Meta OAuth separado falló: ${error.message}`))
  }, Math.max(60_000, Number(intervalMs) || CLEANUP_INTERVAL_MS))
  cleanupTimer.unref?.()
  return cleanupTimer
}

export function stopMetaOAuthIntegrationCleanupScheduler() {
  if (!cleanupTimer) return
  clearInterval(cleanupTimer)
  cleanupTimer = null
}
