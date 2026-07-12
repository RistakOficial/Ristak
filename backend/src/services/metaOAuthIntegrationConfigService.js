import { db } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

export const META_OAUTH_INTEGRATION_KINDS = Object.freeze(['social', 'ads'])

export function normalizeMetaOAuthIntegrationKind(value, { required = true } = {}) {
  const kind = String(value || '').trim().toLowerCase()
  if (META_OAUTH_INTEGRATION_KINDS.includes(kind)) return kind
  if (!required && !kind) return ''
  const error = new Error('La conexión OAuth de Meta debe ser social o ads.')
  error.statusCode = 400
  error.code = 'META_OAUTH_INTEGRATION_KIND_INVALID'
  throw error
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function openSecret(row, column, label) {
  if (!row?.[column]) return
  try {
    if (isEncrypted(row[column])) {
      row[column] = decrypt(row[column])
      return
    }
    const plain = row[column]
    await db.run(
      `UPDATE meta_oauth_integrations SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [encrypt(plain), row.id]
    )
    row[column] = plain
    logger.warn(`La credencial ${label} de Meta OAuth se migró a almacenamiento cifrado.`)
  } catch (error) {
    throw new Error(`No se pudo abrir ${label} de Meta OAuth. Verifica ENCRYPTION_MASTER_KEY: ${error.message}`)
  }
}

export async function getActiveMetaOAuthIntegration(integrationKind) {
  const kind = normalizeMetaOAuthIntegrationKind(integrationKind)
  const row = await db.get(
    `SELECT * FROM meta_oauth_integrations
     WHERE integration_kind = ? AND status = 'active'
     ORDER BY connected_at DESC, updated_at DESC LIMIT 1`,
    [kind]
  ).catch(error => {
    // Durante el primer arranque de una instalación vieja la tabla puede aún no
    // existir; el fallback legacy debe seguir funcionando hasta terminar init.
    if (/no such table|does not exist/i.test(error.message || '')) return null
    throw error
  })
  if (!row) return null

  await openSecret(row, 'access_token', `${kind} access token`)
  await openSecret(row, 'appsecret_proof', `${kind} appsecret_proof`)
  await openSecret(row, 'page_access_token', `${kind} Page token`)
  await openSecret(row, 'page_appsecret_proof', `${kind} Page appsecret_proof`)
  row.granted_scopes = parseJsonArray(row.granted_scopes_json)
  row.missing_scopes = parseJsonArray(row.missing_scopes_json)
  row.granular_scopes = parseJsonArray(row.granular_scopes_json)
  return row
}

export async function hasActiveMetaOAuthSocialPage(pageId, { ignoreConnectionId = '' } = {}) {
  const normalizedPageId = String(pageId || '').trim()
  if (!normalizedPageId) return false
  const ignoredConnectionId = String(ignoreConnectionId || '').trim()
  const row = await db.get(
    `SELECT id FROM meta_oauth_integrations
     WHERE integration_kind = 'social' AND status = 'active' AND page_id = ?
       AND (? = '' OR connection_id != ?)
     LIMIT 1`,
    [normalizedPageId, ignoredConnectionId, ignoredConnectionId]
  ).catch(error => {
    if (/no such table|does not exist/i.test(error.message || '')) return null
    throw error
  })
  return Boolean(row)
}

function applyOAuthMetadata(config, row) {
  if (!row) return config
  return {
    ...config,
    connection_mode: 'oauth_bisu',
    oauth_integration_kind: row.integration_kind,
    oauth_integration_id: row.id,
    oauth_connection_id: row.connection_id,
    oauth_user_id: row.user_id,
    oauth_user_name: row.user_name,
    oauth_app_id: row.app_id,
    oauth_business_id: row.business_id,
    oauth_config_id: row.config_id,
    oauth_granted_scopes_json: row.granted_scopes_json,
    oauth_missing_scopes_json: row.missing_scopes_json,
    oauth_granular_scopes_json: row.granular_scopes_json,
    oauth_data_access_expires_at: row.data_access_expires_at,
    oauth_connected: 1,
    oauth_validated: Number(row.validated) === 1 ? 1 : 0,
    oauth_connected_at: row.connected_at,
    oauth_validated_at: Number(row.validated) === 1 ? row.connected_at : null,
    token_expires_at: row.token_expires_at
  }
}

export function mergeMetaAdsOAuthConfig(legacyConfig = null, ads = null) {
  if (!ads) return legacyConfig
  const merged = applyOAuthMetadata({ ...(legacyConfig || {}) }, ads)
  Object.assign(merged, {
    access_token: ads.access_token,
    app_id: ads.app_id || null,
    app_secret: null,
    meta_business_id: ads.business_id || null,
    ad_account_id: ads.ad_account_id,
    pixel_id: ads.dataset_id || null,
    oauth_appsecret_proof: ads.appsecret_proof,
    // No inyectar activos Social como si el token Ads tuviera tareas ADVERTISE.
    // La publicación de creativos debe validar esa capacidad por separado.
    page_id: null,
    instagram_account_id: null
  })
  return merged
}

export function mergeMetaSocialOAuthConfig(legacyConfig = null, social = null) {
  if (!social) return legacyConfig
  const merged = applyOAuthMetadata({ ...(legacyConfig || {}) }, social)
  Object.assign(merged, {
    access_token: social.access_token,
    app_id: social.app_id || null,
    app_secret: null,
    meta_business_id: social.business_id || null,
    page_id: social.page_id,
    instagram_account_id: social.instagram_account_id || null,
    oauth_appsecret_proof: social.appsecret_proof,
    oauth_page_access_token: social.page_access_token,
    oauth_page_appsecret_proof: social.page_appsecret_proof,
    oauth_relay_status: social.relay_status || 'inactive',
    oauth_relay_registered_at: social.relay_registered_at || null,
    oauth_relay_error: social.relay_error || null
  })
  return merged
}

export function metaOAuthIntegrationCapabilities(row = null) {
  const kind = row?.integration_kind || ''
  const scopes = new Set(parseJsonArray(row?.granted_scopes_json))
  return {
    adsRead: kind === 'ads' && scopes.has('ads_read'),
    adsManagement: kind === 'ads' && scopes.has('ads_management'),
    campaignPublishing: kind === 'ads' && scopes.has('ads_management'),
    campaignPublishingRequiresUpgrade: kind === 'ads' && !scopes.has('ads_management'),
    capiEnabled: kind === 'ads' && Boolean(row?.dataset_id) && scopes.has('ads_read'),
    datasetSelected: kind === 'ads' && Boolean(row?.dataset_id),
    socialMessaging: kind === 'social' && scopes.has('pages_messaging'),
    facebookComments: kind === 'social' && scopes.has('pages_manage_engagement'),
    instagramComments: kind === 'social' && scopes.has('instagram_manage_comments'),
    instagramMessaging: kind === 'social' && scopes.has('instagram_manage_messages')
  }
}
