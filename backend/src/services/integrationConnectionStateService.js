import { db, getAppConfig } from '../config/database.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'
const GOOGLE_CALENDAR_CONFIG_KEY = 'google_calendar_service_account_config'

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

export async function isMetaConnected() {
  const disconnected = cleanString(await getAppConfig('meta_config_disconnected')).toLowerCase() === '1'
  if (disconnected) return false

  const row = await db.get(
    `SELECT ad_account_id, access_token
     FROM meta_config
     WHERE access_token IS NOT NULL AND access_token != ''
       AND ad_account_id IS NOT NULL AND ad_account_id != ''
     LIMIT 1`
  ).catch(() => null)
  return Boolean(row?.access_token && row?.ad_account_id)
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
