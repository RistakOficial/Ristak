import { db, getAppConfig } from '../config/database.js'
import { YCLOUD_HISTORY_BACKFILL_VERSION } from './whatsappApiService.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'
const GOOGLE_CALENDAR_CONFIG_KEY = 'google_calendar_service_account_config'
const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeMode(value) {
  return cleanString(value).toLowerCase() === 'test' ? 'test' : 'live'
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function enabledFlag(value, fallback = true) {
  const normalized = cleanString(value).toLowerCase()
  if (!normalized) return fallback
  return !['0', 'false', 'off', 'no'].includes(normalized)
}

async function getActivePaymentMode() {
  const settings = parseJson(await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY), {})
  return normalizeMode(settings.paymentMode)
}

async function getAppConfigRows(keys = []) {
  if (!keys.length) return {}
  const rows = await db.all(
    `SELECT config_key, config_value
     FROM app_config
     WHERE config_key IN (${keys.map(() => '?').join(', ')})`,
    keys
  ).catch(() => [])
  return Object.fromEntries((rows || []).map((row) => [row.config_key, row.config_value]))
}

function getModeConnection(rawValue, mode) {
  const stored = parseJson(rawValue, {})
  return stored?.[normalizeMode(mode)] || {}
}

export async function isGoogleCalendarConnected() {
  const config = parseJson(await getAppConfig(GOOGLE_CALENDAR_CONFIG_KEY), null)
  return Boolean(config?.connectionMode === 'oauth' && cleanString(config.refreshTokenEncrypted))
}

export async function isHighLevelConnected() {
  const row = await db.get(
    `SELECT location_id, api_token
     FROM highlevel_config
     WHERE location_id IS NOT NULL AND location_id != ''
       AND api_token IS NOT NULL AND api_token != ''
     LIMIT 1`
  ).catch(() => null)
  return Boolean(row?.location_id && row?.api_token)
}

async function hasActiveSplitMetaConnection(integrationKind, requiredAssetColumn) {
  const row = await db.get(
    `SELECT access_token, ${requiredAssetColumn} AS asset_id
     FROM meta_oauth_integrations
     WHERE integration_kind = ? AND status = 'active' AND validated = 1
       AND access_token IS NOT NULL AND access_token != ''
       AND ${requiredAssetColumn} IS NOT NULL AND ${requiredAssetColumn} != ''
     LIMIT 1`,
    [integrationKind]
  ).catch(error => {
    if (/no such table|does not exist/i.test(error.message || '')) return null
    throw error
  })
  return Boolean(row?.access_token && row?.asset_id)
}

async function hasLegacyMetaConnection(requiredAssetColumn) {
  const disconnected = cleanString(await getAppConfig('meta_config_disconnected')).toLowerCase() === '1'
  if (disconnected) return false

  const row = await db.get(
    `SELECT ${requiredAssetColumn} AS asset_id, access_token
     FROM meta_config
     WHERE access_token IS NOT NULL AND access_token != ''
       AND ${requiredAssetColumn} IS NOT NULL AND ${requiredAssetColumn} != ''
     LIMIT 1`
  ).catch(() => null)
  return Boolean(row?.access_token && row?.asset_id)
}

export async function isMetaAdsConnected() {
  if (await hasActiveSplitMetaConnection('ads', 'ad_account_id')) return true
  return hasLegacyMetaConnection('ad_account_id')
}

export async function isMetaSocialConnected() {
  if (await hasActiveSplitMetaConnection('social', 'page_id')) return true
  return hasLegacyMetaConnection('page_id')
}

export async function isMetaConnected() {
  const [ads, social] = await Promise.all([
    isMetaAdsConnected(),
    isMetaSocialConnected()
  ])
  return ads || social
}

export async function isStripeConnected() {
  const mode = await getActivePaymentMode()
  const raw = await getAppConfigRows([
    'stripe_enabled',
    'stripe_mode',
    'stripe_publishable_key',
    'stripe_secret_key_encrypted',
    'stripe_manual_mode_connections'
  ])

  if (!enabledFlag(raw.stripe_enabled, true)) return false

  const active = getModeConnection(raw.stripe_manual_mode_connections, mode)
  const activePublishable = cleanString(active.publishableKey || active.publishable_key)
  const activeSecret = cleanString(active.secretKey || active.secret_key)
  if (activePublishable && activeSecret) return true

  const legacyMode = normalizeMode(raw.stripe_mode)
  return legacyMode === mode &&
    Boolean(cleanString(raw.stripe_publishable_key) && cleanString(raw.stripe_secret_key_encrypted))
}

export async function isConektaConnected() {
  const mode = await getActivePaymentMode()
  const raw = await getAppConfigRows([
    'conekta_enabled',
    'conekta_mode',
    'conekta_public_key',
    'conekta_private_key_encrypted',
    'conekta_mode_connections'
  ])

  if (!enabledFlag(raw.conekta_enabled, true)) return false

  const active = getModeConnection(raw.conekta_mode_connections, mode)
  const activePublic = cleanString(active.publicKey || active.public_key)
  const activePrivate = cleanString(active.privateKey || active.private_key)
  if (activePublic && activePrivate) return true

  const legacyMode = normalizeMode(raw.conekta_mode)
  return legacyMode === mode &&
    Boolean(cleanString(raw.conekta_public_key) && cleanString(raw.conekta_private_key_encrypted))
}

export async function isMercadoPagoConnected() {
  const mode = await getActivePaymentMode()
  const raw = await getAppConfigRows([
    'mercadopago_enabled',
    'mercadopago_mode',
    'mercadopago_user_id',
    'mercadopago_access_token_encrypted',
    'mercadopago_mode_connections'
  ])

  if (!enabledFlag(raw.mercadopago_enabled, true)) return false

  const active = getModeConnection(raw.mercadopago_mode_connections, mode)
  const activeUserId = cleanString(active.userId || active.user_id)
  const activeAccessToken = cleanString(active.accessToken || active.access_token)
  if (activeUserId && activeAccessToken) return true

  const legacyMode = normalizeMode(raw.mercadopago_mode)
  return legacyMode === mode &&
    Boolean(cleanString(raw.mercadopago_user_id) && cleanString(raw.mercadopago_access_token_encrypted))
}

export async function isClipConnected() {
  const mode = await getActivePaymentMode()
  const raw = await getAppConfigRows([
    'clip_enabled',
    'clip_mode',
    'clip_api_key_encrypted',
    'clip_mode_connections'
  ])

  if (!enabledFlag(raw.clip_enabled, true)) return false

  const active = getModeConnection(raw.clip_mode_connections, mode)
  const activeApiKey = cleanString(active.apiKey || active.api_key)
  if (activeApiKey) return true

  const legacyMode = normalizeMode(raw.clip_mode)
  return legacyMode === mode && Boolean(cleanString(raw.clip_api_key_encrypted))
}

export async function isRebillConnected() {
  const mode = await getActivePaymentMode()
  const raw = await getAppConfigRows([
    'rebill_enabled',
    'rebill_mode',
    'rebill_public_key',
    'rebill_secret_key_encrypted',
    'rebill_mode_connections'
  ])

  if (!enabledFlag(raw.rebill_enabled, true)) return false

  const active = getModeConnection(raw.rebill_mode_connections, mode)
  const activePublicKey = cleanString(active.publicKey || active.public_key)
  const activeSecretKey = cleanString(active.secretKey || active.secret_key)
  if (activePublicKey && activeSecretKey) return true

  const legacyMode = normalizeMode(raw.rebill_mode)
  return legacyMode === mode &&
    Boolean(cleanString(raw.rebill_public_key) && cleanString(raw.rebill_secret_key_encrypted))
}

export async function isGigstackConnected() {
  const settings = parseJson(await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY), {})
  const taxes = settings?.taxes || {}
  if (!enabledFlag(taxes.enabled, false) || !enabledFlag(taxes.gigstackEnabled, false)) return false

  return Boolean(
    cleanString(taxes.gigstackTestApiTokenEncrypted) ||
    cleanString(taxes.gigstackLiveApiTokenEncrypted) ||
    cleanString(taxes.gigstackApiTokenEncrypted)
  )
}

export async function isWhatsAppQrConnected() {
  const row = await db.get(`
    SELECT s.id
    FROM whatsapp_qr_sessions s
    JOIN whatsapp_api_phone_numbers p ON p.id = s.phone_number_id
    WHERE p.qr_send_enabled = 1
      AND s.consent_accepted = 1
    LIMIT 1
  `).catch(() => null)
  return Boolean(row?.id)
}

export async function isWhatsAppApiHistoryBackfillPending() {
  const raw = await getAppConfigRows([
    'whatsapp_api_enabled',
    'whatsapp_api_ycloud_api_key_encrypted',
    'whatsapp_api_provider',
    'whatsapp_api_history_direction_repair_version'
  ])
  const provider = cleanString(raw.whatsapp_api_provider).toLowerCase()

  return (!provider || provider === 'ycloud') &&
    enabledFlag(raw.whatsapp_api_enabled, true) &&
    Boolean(cleanString(raw.whatsapp_api_ycloud_api_key_encrypted)) &&
    cleanString(raw.whatsapp_api_history_direction_repair_version) !== YCLOUD_HISTORY_BACKFILL_VERSION
}

export async function isMetaDirectWhatsAppConnected() {
  const raw = await getAppConfigRows([
    'whatsapp_api_enabled',
    'whatsapp_meta_direct_status',
    'whatsapp_meta_direct_system_user_token_encrypted',
    'whatsapp_meta_direct_waba_id',
    'whatsapp_meta_direct_phone_number_id'
  ])
  if (
    !enabledFlag(raw.whatsapp_api_enabled, true) ||
    cleanString(raw.whatsapp_meta_direct_status).toLowerCase() !== 'connected' ||
    !cleanString(raw.whatsapp_meta_direct_system_user_token_encrypted) ||
    !cleanString(raw.whatsapp_meta_direct_waba_id) ||
    !cleanString(raw.whatsapp_meta_direct_phone_number_id)
  ) {
    return false
  }

  const phone = await db.get(`
    SELECT id
    FROM whatsapp_api_phone_numbers
    WHERE provider = 'meta_direct'
      AND api_send_enabled = 1
      AND id = ?
    LIMIT 1
  `, [
    cleanString(raw.whatsapp_meta_direct_phone_number_id)
  ]).catch(() => null)
  return Boolean(phone?.id)
}

export async function isEmailInboundConnected() {
  const rows = await getAppConfigRows([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY])
  const config = parseJson(rows[EMAIL_CONFIG_KEY], null)
  const inbound = config?.inbound && typeof config.inbound === 'object' ? config.inbound : {}

  return Boolean(
    config?.connected &&
    cleanString(config.host) &&
    cleanString(config.username) &&
    cleanString(rows[EMAIL_PASSWORD_KEY]) &&
    inbound.enabled === true &&
    cleanString(inbound.host) &&
    cleanString(inbound.username)
  )
}
