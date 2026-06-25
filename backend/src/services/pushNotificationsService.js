import crypto from 'crypto'
import fs from 'fs/promises'
import http2 from 'http2'
import webPush from 'web-push'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { shouldSuppressChatNotificationForConversationalAgent } from './conversationalAgentService.js'
// (MOB-002 / NOTI-004) Importamos el chequeo de contactos ocultos para no exponerlos en el push
import { resolvePushNotificationTargetForEvent, isContactHiddenFromNotifications } from './notificationPreferencesService.js'

const ENV_VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || ''
const ENV_VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT = process.env.WEB_PUSH_SUBJECT || process.env.VAPID_SUBJECT || 'mailto:soporte@ristak.com'
const WEB_PUSH_PUBLIC_CONFIG_KEY = 'web_push_public_key'
const WEB_PUSH_PRIVATE_CONFIG_KEY = 'web_push_private_key'
const PUSH_SOUND_CONFIG_KEY = 'push_notification_sound_enabled'
const PUSH_VIBRATION_CONFIG_KEY = 'push_notification_vibration_enabled'
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || ''
const FCM_SERVICE_ACCOUNT_JSON = process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''
const FCM_SERVICE_ACCOUNT_FILE = process.env.FCM_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || ''
const APNS_KEY_ID = process.env.APNS_KEY_ID || ''
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || ''
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || process.env.IOS_BUNDLE_ID || 'com.ristak.app'
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY || ''
const APNS_PRIVATE_KEY_FILE = process.env.APNS_PRIVATE_KEY_FILE || ''
const APNS_ENV = String(process.env.APNS_ENV || process.env.NODE_ENV || 'production').toLowerCase()
const DEFAULT_NOTIFICATION_TITLE = 'Notificación nueva'
const DEFAULT_NOTIFICATION_BODY = 'Tienes una notificación nueva.'
const ANDROID_CHANNELS = {
  alerts: 'ristak_alerts',
  sound: 'ristak_sound',
  vibration: 'ristak_vibrate',
  silent: 'ristak_silent'
}
let appNotificationPayloadSenderForTest = null

export function setAppNotificationPayloadSenderForTest(sender) {
  appNotificationPayloadSenderForTest = typeof sender === 'function' ? sender : null
}

async function resolveWebPushKeys() {
  const envPublicKey = String(ENV_VAPID_PUBLIC_KEY || '').trim()
  const envPrivateKey = String(ENV_VAPID_PRIVATE_KEY || '').trim()

  if (envPublicKey && envPrivateKey) {
    return {
      publicKey: envPublicKey,
      privateKey: envPrivateKey,
      source: 'environment'
    }
  }

  if (envPublicKey || envPrivateKey) {
    logger.warn('[Push] Llaves VAPID incompletas en variables de entorno; se usará configuración guardada o se crearán nuevas llaves web.')
  }

  const [storedPublicKey, storedPrivateKey] = await Promise.all([
    getAppConfig(WEB_PUSH_PUBLIC_CONFIG_KEY).catch(() => ''),
    getAppConfig(WEB_PUSH_PRIVATE_CONFIG_KEY).catch(() => '')
  ])

  const cleanStoredPublicKey = String(storedPublicKey || '').trim()
  const cleanStoredPrivateKey = String(storedPrivateKey || '').trim()
  if (cleanStoredPublicKey && cleanStoredPrivateKey) {
    return {
      publicKey: cleanStoredPublicKey,
      privateKey: cleanStoredPrivateKey,
      source: 'database'
    }
  }

  const generated = webPush.generateVAPIDKeys()
  await Promise.all([
    setAppConfig(WEB_PUSH_PUBLIC_CONFIG_KEY, generated.publicKey),
    setAppConfig(WEB_PUSH_PRIVATE_CONFIG_KEY, generated.privateKey)
  ])

  logger.success('[Push] Llaves web push creadas y guardadas para activar notificaciones en celulares PWA.')
  // (NOTI-009) Las llaves VAPID autogeneradas viven solo en esta base de datos. Si la BD se
  // reinicia, se restaura o las llaves se regeneran, la llave pública cambia y TODAS las
  // suscripciones push existentes quedan inservibles (los navegadores quedan atados a la
  // pública original). Recomendamos fijar WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY por
  // variables de entorno para mantenerlas estables entre reinicios y despliegues.
  logger.warn('[Push] (NOTI-009) Llaves VAPID autogeneradas en base de datos: NO recomendado para producción. Si la BD se reinicia o las llaves cambian, se romperán todas las suscripciones push existentes. Define WEB_PUSH_PUBLIC_KEY y WEB_PUSH_PRIVATE_KEY en variables de entorno para que sean permanentes.')

  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    source: 'generated'
  }
}

const resolvedWebPushKeys = await resolveWebPushKeys().catch((error) => {
  logger.warn(`[Push] No se pudieron preparar llaves web push: ${error.message}`)
  return { publicKey: '', privateKey: '', source: 'unavailable' }
})

const VAPID_PUBLIC_KEY = resolvedWebPushKeys.publicKey
const VAPID_PRIVATE_KEY = resolvedWebPushKeys.privateKey
const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
const fcmConfigured = Boolean(FCM_PROJECT_ID && (FCM_SERVICE_ACCOUNT_JSON || FCM_SERVICE_ACCOUNT_FILE))
const apnsConfigured = Boolean(APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID && (APNS_PRIVATE_KEY || APNS_PRIVATE_KEY_FILE))
const nativePushConfigured = fcmConfigured || apnsConfigured
let fcmAccessTokenCache = { token: '', expiresAt: 0 }
let apnsJwtCache = { token: '', expiresAt: 0 }

if (pushConfigured) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  if (resolvedWebPushKeys.source !== 'environment') {
    logger.info(`[Push] Web Push activo con llaves ${resolvedWebPushKeys.source === 'generated' ? 'creadas automáticamente' : 'guardadas en base de datos'}.`)
    // (NOTI-009) Las llaves no provienen de variables de entorno: están atadas a esta base de
    // datos. Avisamos en cada arranque porque cualquier reinicio/restauración de la BD que cambie
    // la llave pública dejará inservibles las suscripciones push ya registradas. Fija
    // WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY en el entorno para hacerlas permanentes.
    logger.warn('[Push] (NOTI-009) Llaves VAPID NO fijadas por entorno (origen: base de datos). Para evitar romper las suscripciones push ante un reinicio o restauración de la BD, define WEB_PUSH_PUBLIC_KEY y WEB_PUSH_PRIVATE_KEY como variables de entorno.')
  }
} else {
  logger.warn('[Push] Web Push sin llaves VAPID; las suscripciones se guardan, pero no se enviarán notificaciones.')
}

if (!nativePushConfigured) {
  logger.warn('[Push] Push nativo sin FCM/APNs; los celulares nativos se guardan, pero no recibirán notificaciones hasta configurar credenciales.')
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeCalendarIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizeUserIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizePlatform(value = '') {
  const platform = String(value || '').trim().toLowerCase()
  if (platform === 'ios' || platform === 'android') return platform
  return ''
}

function getNativeDeviceId(platform = '', token = '') {
  return `native_push_${crypto.createHash('sha256').update(`${platform}:${token}`).digest('hex')}`
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function normalizePrivateKey(value = '') {
  return String(value || '').replace(/\\n/g, '\n').trim()
}

function ecdsaDerToJose(signature, size = 32) {
  let offset = 0
  if (signature[offset++] !== 0x30) return signature.toString('base64url')

  let sequenceLength = signature[offset++]
  if (sequenceLength & 0x80) {
    const bytes = sequenceLength & 0x7f
    sequenceLength = 0
    for (let index = 0; index < bytes; index += 1) {
      sequenceLength = (sequenceLength << 8) + signature[offset++]
    }
  }

  if (signature[offset++] !== 0x02) return signature.toString('base64url')
  const rLength = signature[offset++]
  let r = signature.subarray(offset, offset + rLength)
  offset += rLength

  if (signature[offset++] !== 0x02) return signature.toString('base64url')
  const sLength = signature[offset++]
  let s = signature.subarray(offset, offset + sLength)

  while (r.length > 0 && r[0] === 0) r = r.subarray(1)
  while (s.length > 0 && s[0] === 0) s = s.subarray(1)

  const rPad = Buffer.concat([Buffer.alloc(Math.max(0, size - r.length)), r]).subarray(-size)
  const sPad = Buffer.concat([Buffer.alloc(Math.max(0, size - s.length)), s]).subarray(-size)
  return Buffer.concat([rPad, sPad]).toString('base64url')
}

function signJwt({ header, payload, privateKey, algorithm }) {
  const encodedHeader = base64urlJson(header)
  const encodedPayload = base64urlJson(payload)
  const signer = crypto.createSign(algorithm)
  signer.update(`${encodedHeader}.${encodedPayload}`)
  signer.end()
  const rawSignature = signer.sign(privateKey)
  const signature = header.alg === 'ES256'
    ? ecdsaDerToJose(rawSignature)
    : rawSignature.toString('base64url')
  return `${encodedHeader}.${encodedPayload}.${signature}`
}

async function readOptionalFile(path = '') {
  if (!path) return ''
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    logger.warn(`[Push] No se pudo leer archivo de credenciales ${path}: ${error.message}`)
    return ''
  }
}

async function getFcmServiceAccount() {
  const raw = FCM_SERVICE_ACCOUNT_JSON || await readOptionalFile(FCM_SERVICE_ACCOUNT_FILE)
  if (!raw) return null

  try {
    const account = JSON.parse(raw)
    return {
      clientEmail: String(account.client_email || '').trim(),
      privateKey: normalizePrivateKey(account.private_key)
    }
  } catch (error) {
    logger.warn(`[Push] Credenciales FCM inválidas: ${error.message}`)
    return null
  }
}

async function getFcmAccessToken() {
  if (fcmAccessTokenCache.token && fcmAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return fcmAccessTokenCache.token
  }

  const account = await getFcmServiceAccount()
  if (!account?.clientEmail || !account?.privateKey) {
    throw new Error('Faltan credenciales FCM para notificaciones Android')
  }

  const now = Math.floor(Date.now() / 1000)
  const assertion = signJwt({
    header: { alg: 'RS256', typ: 'JWT' },
    payload: {
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    },
    privateKey: account.privateKey,
    algorithm: 'RSA-SHA256'
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'No se pudo obtener permiso FCM')
  }

  fcmAccessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000
  }

  return fcmAccessTokenCache.token
}

async function getApnsPrivateKey() {
  return normalizePrivateKey(APNS_PRIVATE_KEY || await readOptionalFile(APNS_PRIVATE_KEY_FILE))
}

async function getApnsJwt() {
  if (apnsJwtCache.token && apnsJwtCache.expiresAt > Date.now() + 60_000) {
    return apnsJwtCache.token
  }

  const privateKey = await getApnsPrivateKey()
  if (!privateKey) {
    throw new Error('Falta la llave privada APNs para notificaciones iPhone')
  }

  const now = Math.floor(Date.now() / 1000)
  const token = signJwt({
    header: { alg: 'ES256', kid: APNS_KEY_ID },
    payload: { iss: APNS_TEAM_ID, iat: now },
    privateKey,
    algorithm: 'SHA256'
  })

  apnsJwtCache = {
    token,
    expiresAt: Date.now() + 50 * 60 * 1000
  }

  return token
}

function getNotificationData(payload = {}) {
  return Object.fromEntries(
    Object.entries({
      url: payload.url || '/phone/chat',
      category: payload.category || 'ristak',
      tag: payload.tag || 'ristak',
      threadId: payload.threadId || payload.tag || payload.category || 'ristak',
      eventKey: payload.eventKey || '',
      messageId: payload.messageId || '',
      contactId: payload.contactId || ''
    }).map(([key, value]) => [key, String(value || '')])
  )
}

function cleanNotificationText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function stripAppNameFromNotificationText(value = '') {
  return cleanNotificationText(value)
    .replace(/\s+(?:from|de)\s+Ristak(?:\s+Chat)?$/i, '')
    .replace(/^Ristak(?:\s+Chat)?\s*[:\-–]\s*/i, '')
    .trim()
}

function isAppNameNotificationText(value = '') {
  const text = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()

  return text === 'ristak' || text === 'ristak chat' || text === 'from ristak' || text === 'from ristak chat'
}

function getNotificationTitle(payload = {}) {
  const title = stripAppNameFromNotificationText(payload.title)
  return title && !isAppNameNotificationText(title) ? title : DEFAULT_NOTIFICATION_TITLE
}

function getNotificationBody(payload = {}) {
  const body = stripAppNameFromNotificationText(payload.body)
  return body && !isAppNameNotificationText(body) ? body : DEFAULT_NOTIFICATION_BODY
}

function normalizeNotificationPayload(payload = {}) {
  return {
    ...payload,
    title: getNotificationTitle(payload),
    body: getNotificationBody(payload)
  }
}

function getChatSenderName(message = {}) {
  const candidates = [
    message.contactName,
    message.contact_name,
    message.profileName,
    message.name,
    message.phone
  ]

  for (const candidate of candidates) {
    const value = stripAppNameFromNotificationText(candidate)
    if (value && !isAppNameNotificationText(value)) {
      return value.slice(0, 90)
    }
  }

  return 'WhatsApp'
}

function getChatMessageBody(message = {}) {
  const bodyText = cleanNotificationText(message.text)
  if (bodyText) return bodyText.slice(0, 220)

  const type = String(message.messageType || message.type || '').trim().toLowerCase()
  const typeLabels = {
    image: 'Foto',
    video: 'Video',
    audio: 'Audio',
    voice: 'Audio',
    document: 'Documento',
    sticker: 'Sticker',
    location: 'Ubicación',
    contacts: 'Contacto',
    contact: 'Contacto',
    reaction: 'Reacción',
    button: 'Respuesta',
    interactive: 'Respuesta'
  }

  return typeLabels[type] || 'Mensaje'
}

async function getBooleanPushConfig(key, fallback = false) {
  const raw = await getAppConfig(key).catch(() => null)
  if (raw === null || raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

async function getNotificationExperienceConfig() {
  const [soundEnabled, vibrationEnabled] = await Promise.all([
    getBooleanPushConfig(PUSH_SOUND_CONFIG_KEY, true),
    getBooleanPushConfig(PUSH_VIBRATION_CONFIG_KEY, true)
  ])

  return { soundEnabled, vibrationEnabled }
}

async function getPushPreferenceTarget(eventKey) {
  return resolvePushNotificationTargetForEvent(eventKey).catch((error) => {
    logger.warn(`[Push] No se pudo leer preferencias de notificaciones para ${eventKey}: ${error.message}`)
    return { configured: false, userIds: null }
  })
}

function getPushPreferenceOptions(target, extraOptions = {}) {
  return target.configured
    ? { ...extraOptions, userIds: target.userIds }
    : extraOptions
}

function isPushPreferenceDisabled(target) {
  return target.configured && Array.isArray(target.userIds) && target.userIds.length === 0
}

function getSubscriptionId(endpoint = '') {
  return `push_${crypto.createHash('sha256').update(endpoint).digest('hex')}`
}

function formatAppointmentTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

function formatPaymentAmount(amount, currency = 'MXN') {
  const value = Number(amount)
  const safeAmount = Number.isFinite(value) ? value : 0

  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: String(currency || 'MXN').toUpperCase(),
      maximumFractionDigits: 2
    }).format(safeAmount)
  } catch {
    return `$${safeAmount.toFixed(2)}`
  }
}

function getAndroidChannelId({ soundEnabled = true, vibrationEnabled = true } = {}) {
  if (soundEnabled && vibrationEnabled) return ANDROID_CHANNELS.alerts
  if (soundEnabled) return ANDROID_CHANNELS.sound
  if (vibrationEnabled) return ANDROID_CHANNELS.vibration
  return ANDROID_CHANNELS.silent
}

function getNotificationCategory(payload = {}) {
  const category = cleanNotificationText(payload.category || 'ristak')
  return category || 'ristak'
}

function getNotificationThreadId(payload = {}) {
  const threadId = cleanNotificationText(payload.threadId || payload.contactId || payload.tag || getNotificationCategory(payload))
  return threadId.slice(0, 64) || 'ristak'
}

function getApnsCategory(payload = {}) {
  return getNotificationCategory(payload)
    .replace(/[^a-z0-9_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 64) || 'RISTAK'
}

async function getGlobalCalendarPushConfig() {
  const enabledRaw = await getAppConfig('calendar_push_notifications_enabled').catch(() => null)
  const calendarIdsRaw = await getAppConfig('calendar_push_notification_calendar_ids').catch(() => null)
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(enabledRaw || '').toLowerCase())
  const calendarIds = normalizeCalendarIds(
    Array.isArray(calendarIdsRaw)
      ? calendarIdsRaw
      : safeJsonParse(calendarIdsRaw || '[]', [])
  )

  return { enabled, calendarIds }
}

export function getPublicPushConfig() {
  return {
    configured: pushConfigured,
    publicKey: pushConfigured ? VAPID_PUBLIC_KEY : '',
    nativeConfigured: nativePushConfigured,
    androidConfigured: fcmConfigured,
    iosConfigured: apnsConfigured
  }
}

export async function savePushSubscription({
  subscription,
  userId = null,
  calendarIds = [],
  userAgent = ''
}) {
  const endpoint = String(subscription?.endpoint || '').trim()
  if (!endpoint) {
    throw new Error('Suscripción inválida')
  }

  const id = getSubscriptionId(endpoint)
  const normalizedCalendarIds = normalizeCalendarIds(calendarIds)

  await db.run(`
    INSERT INTO push_subscriptions (
      id, user_id, endpoint, subscription_json, calendar_ids_json, enabled, user_agent, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, push_subscriptions.user_id),
      subscription_json = excluded.subscription_json,
      calendar_ids_json = excluded.calendar_ids_json,
      enabled = 1,
      user_agent = excluded.user_agent,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    userId,
    endpoint,
    JSON.stringify(subscription),
    JSON.stringify(normalizedCalendarIds),
    userAgent
  ])

  return {
    id,
    enabled: true,
    calendarIds: normalizedCalendarIds
  }
}

export async function disablePushSubscription(endpoint = '') {
  const normalizedEndpoint = String(endpoint || '').trim()
  if (!normalizedEndpoint) return

  await db.run(
    'UPDATE push_subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE endpoint = ?',
    [normalizedEndpoint]
  )
}

export async function saveMobilePushDevice({
  token,
  platform,
  userId = null,
  calendarIds = [],
  appVersion = '',
  appBuild = '',
  deviceModel = '',
  osVersion = ''
}) {
  const normalizedToken = String(token || '').trim()
  const normalizedPlatform = normalizePlatform(platform)

  if (!normalizedToken) {
    throw new Error('Falta la llave de notificaciones del celular')
  }

  if (!normalizedPlatform) {
    throw new Error('Este tipo de celular no está soportado para notificaciones')
  }

  const id = getNativeDeviceId(normalizedPlatform, normalizedToken)
  const normalizedCalendarIds = normalizeCalendarIds(calendarIds)

  await db.run(`
    INSERT INTO mobile_push_devices (
      id, user_id, platform, token, calendar_ids_json, enabled,
      app_version, app_build, device_model, os_version, last_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(token) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, mobile_push_devices.user_id),
      platform = excluded.platform,
      calendar_ids_json = excluded.calendar_ids_json,
      enabled = 1,
      app_version = excluded.app_version,
      app_build = excluded.app_build,
      device_model = excluded.device_model,
      os_version = excluded.os_version,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    userId,
    normalizedPlatform,
    normalizedToken,
    JSON.stringify(normalizedCalendarIds),
    String(appVersion || '').trim(),
    String(appBuild || '').trim(),
    String(deviceModel || '').trim(),
    String(osVersion || '').trim()
  ])

  return {
    id,
    platform: normalizedPlatform,
    enabled: true,
    calendarIds: normalizedCalendarIds
  }
}

export async function disableMobilePushDevice(token = '') {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) return

  await db.run(
    'UPDATE mobile_push_devices SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE token = ?',
    [normalizedToken]
  )
}

async function getSubscriptionsForCalendar(calendarId) {
  const rows = await db.all(`
    SELECT id, user_id, endpoint, subscription_json, calendar_ids_json
    FROM push_subscriptions
    WHERE enabled = 1
  `)

  return rows.filter((row) => {
    const calendarIds = normalizeCalendarIds(safeJsonParse(row.calendar_ids_json || '[]', []))
    return calendarIds.length === 0 || calendarIds.includes(calendarId)
  })
}

async function getEnabledSubscriptions(userIds = null) {
  const rows = await db.all(`
    SELECT id, user_id, endpoint, subscription_json
    FROM push_subscriptions
    WHERE enabled = 1
  `)
  if (!Array.isArray(userIds)) return rows
  const allowed = new Set(normalizeUserIds(userIds))
  return rows.filter((row) => allowed.has(String(row.user_id || '').trim()))
}

async function getMobileDevicesForCalendar(calendarId) {
  const rows = await db.all(`
    SELECT id, user_id, platform, token, calendar_ids_json
    FROM mobile_push_devices
    WHERE enabled = 1
  `)

  return rows.filter((row) => {
    const calendarIds = normalizeCalendarIds(safeJsonParse(row.calendar_ids_json || '[]', []))
    return calendarIds.length === 0 || calendarIds.includes(calendarId)
  })
}

async function getEnabledMobileDevices(userIds = null) {
  const rows = await db.all(`
    SELECT id, user_id, platform, token, calendar_ids_json
    FROM mobile_push_devices
    WHERE enabled = 1
  `)
  if (!Array.isArray(userIds)) return rows
  const allowed = new Set(normalizeUserIds(userIds))
  return rows.filter((row) => allowed.has(String(row.user_id || '').trim()))
}

async function markSubscriptionError(row, error) {
  const statusCode = error?.statusCode || error?.status
  const shouldDisable = statusCode === 404 || statusCode === 410

  await db.run(
    `UPDATE push_subscriptions
     SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [shouldDisable ? 0 : 1, error?.message || 'Error enviando notificación', row.id]
  ).catch(() => {})
}

async function markMobileDeviceError(row, error) {
  const statusCode = error?.statusCode || error?.status
  const code = String(error?.code || error?.reason || '').toUpperCase()
  const shouldDisable = statusCode === 400 ||
    statusCode === 404 ||
    statusCode === 410 ||
    code.includes('UNREGISTERED') ||
    code.includes('BADDEVICETOKEN') ||
    code.includes('UNREGISTERED')

  await db.run(
    `UPDATE mobile_push_devices
     SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [shouldDisable ? 0 : 1, error?.message || 'Error enviando notificación al celular', row.id]
  ).catch(() => {})
}

async function sendNotificationRows(rows = [], payload = {}) {
  let sent = 0
  await Promise.all(rows.map(async (row) => {
    const subscription = safeJsonParse(row.subscription_json, null)
    if (!subscription) return

    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload))
      sent += 1
    } catch (error) {
      logger.warn(`[Push] No se pudo enviar notificación a ${row.id}: ${error.message}`)
      await markSubscriptionError(row, error)
    }
  }))

  return sent
}

async function sendFcmNotification(row, payload = {}, experience = {}) {
  if (!fcmConfigured) {
    throw new Error('Faltan credenciales FCM para notificaciones Android')
  }

  const notificationTitle = getNotificationTitle(payload)
  const notificationBody = getNotificationBody(payload)
  const channelId = getAndroidChannelId(experience)
  const accessToken = await getFcmAccessToken()
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(FCM_PROJECT_ID)}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        token: row.token,
        notification: {
          title: notificationTitle,
          body: notificationBody
        },
        data: getNotificationData(payload),
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: channelId,
            click_action: 'OPEN_RISTAK',
            icon: 'ic_stat_whatsapp',
            tag: payload.tag || undefined,
            notification_priority: 'PRIORITY_HIGH',
            default_sound: Boolean(experience.soundEnabled),
            default_vibrate_timings: Boolean(experience.vibrationEnabled),
            default_light_settings: true,
            visibility: 'PUBLIC'
          }
        }
      }
    })
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data?.error?.message || `FCM respondió ${response.status}`)
    error.statusCode = response.status
    error.code = data?.error?.status || data?.error?.details?.[0]?.errorCode || ''
    throw error
  }
}

async function sendApnsNotification(row, payload = {}, experience = {}) {
  if (!apnsConfigured) {
    throw new Error('Faltan credenciales APNs para notificaciones iPhone')
  }

  const notificationTitle = getNotificationTitle(payload)
  const notificationBody = getNotificationBody(payload)
  const host = APNS_ENV === 'development' || APNS_ENV === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com'
  const authToken = await getApnsJwt()
  const client = http2.connect(`https://${host}`)
  const aps = {
    alert: {
      title: notificationTitle,
      body: notificationBody
    },
    'thread-id': getNotificationThreadId(payload),
    category: getApnsCategory(payload)
  }
  if (experience.soundEnabled) {
    aps.sound = 'default'
  }
  if (Number.isFinite(Number(payload.badge))) {
    aps.badge = Math.max(0, Number(payload.badge))
  }
  const requestBody = JSON.stringify({
    aps,
    ...getNotificationData(payload)
  })

  return new Promise((resolve, reject) => {
    let statusCode = 0
    let responseText = ''
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${row.token}`,
      authorization: `bearer ${authToken}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(requestBody)
    })

    request.setEncoding('utf8')
    request.on('response', (headers) => {
      statusCode = Number(headers[':status'] || 0)
    })
    request.on('data', (chunk) => {
      responseText += chunk
    })
    request.on('error', (error) => {
      client.close()
      reject(error)
    })
    request.on('end', () => {
      client.close()
      if (statusCode >= 200 && statusCode < 300) {
        resolve()
        return
      }

      let parsed = {}
      try {
        parsed = responseText ? JSON.parse(responseText) : {}
      } catch {
        parsed = {}
      }
      const error = new Error(parsed.reason || `APNs respondió ${statusCode}`)
      error.statusCode = statusCode
      error.reason = parsed.reason || ''
      reject(error)
    })

    request.end(requestBody)
  })
}

async function sendMobileNotificationRows(rows = [], payload = {}, experience = {}) {
  let sent = 0
  await Promise.all(rows.map(async (row) => {
    const platform = normalizePlatform(row.platform)
    try {
      if (platform === 'android') {
        await sendFcmNotification(row, payload, experience)
      } else if (platform === 'ios') {
        await sendApnsNotification(row, payload, experience)
      } else {
        return
      }
      sent += 1
    } catch (error) {
      logger.warn(`[Push] No se pudo enviar notificación nativa a ${row.id}: ${error.message}`)
      await markMobileDeviceError(row, error)
    }
  }))

  return sent
}

export async function sendAppNotificationPayload(payload = {}, { calendarId = '', userIds = null } = {}) {
  if (appNotificationPayloadSenderForTest) {
    return appNotificationPayloadSenderForTest(payload, { calendarId, userIds })
  }

  if (!pushConfigured && !nativePushConfigured) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'not_configured' }
  }

  const filterByUser = Array.isArray(userIds)
  const normalizedUserIds = filterByUser ? normalizeUserIds(userIds) : null
  if (filterByUser && normalizedUserIds.length === 0) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'missing_recipients' }
  }

  const normalizedPayload = normalizeNotificationPayload(payload)
  const [webRows, nativeRows, experience] = await Promise.all([
    pushConfigured
      ? (calendarId ? getSubscriptionsForCalendar(calendarId) : getEnabledSubscriptions())
      : Promise.resolve([]),
    nativePushConfigured
      ? (calendarId ? getMobileDevicesForCalendar(calendarId) : getEnabledMobileDevices(normalizedUserIds))
      : Promise.resolve([]),
    getNotificationExperienceConfig()
  ])

  const filteredWebRows = filterByUser
    ? webRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : webRows
  const filteredNativeRows = filterByUser
    ? nativeRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : nativeRows

  if (filteredWebRows.length === 0 && filteredNativeRows.length === 0) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'no_subscriptions' }
  }

  const [webSent, nativeSent] = await Promise.all([
    pushConfigured ? sendNotificationRows(filteredWebRows, normalizedPayload) : Promise.resolve(0),
    nativePushConfigured ? sendMobileNotificationRows(filteredNativeRows, normalizedPayload, experience) : Promise.resolve(0)
  ])

  return {
    sent: webSent + nativeSent,
    webSent,
    nativeSent,
    skipped: false
  }
}

export async function sendCalendarAppointmentNotification(appointment = {}, options = {}) {
  if (!pushConfigured && !nativePushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  if (!calendarId) return { sent: 0, skipped: true, reason: 'missing_calendar' }

  const config = await getGlobalCalendarPushConfig()
  if (!config.enabled) return { sent: 0, skipped: true, reason: 'disabled' }
  if (config.calendarIds.length > 0 && !config.calendarIds.includes(calendarId)) {
    return { sent: 0, skipped: true, reason: 'calendar_filtered' }
  }
  const preferenceTarget = await getPushPreferenceTarget('appointment_booked')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contactName = await getAppointmentContactName(appointment, options)
  const appointmentTitle = String(appointment.title || appointment.name || 'Nueva cita').trim()
  const calendarName = String(options.calendarName || appointment.calendarName || 'Calendario').trim()
  const timeLabel = formatAppointmentTime(appointment.startTime || appointment.start_time)
  const body = timeLabel
    ? `${appointmentTitle} · ${timeLabel}`
    : appointmentTitle
  const payload = {
    title: contactName || 'Nueva cita',
    body: `${calendarName}: ${body}`,
    tag: `calendar-${calendarId}`,
    threadId: `calendar-${calendarId}`,
    url: `/phone/calendar?open=appointment&id=${encodeURIComponent(appointment.id || '')}`,
    category: 'appointment_booked',
    eventKey: 'appointment_booked',
    contactId: appointment.contactId || appointment.contact_id || ''
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, { calendarId }))
}

async function getAppointmentContactName(appointment = {}, options = {}) {
  const direct = cleanNotificationText(
    options.contactName ||
    appointment.contactName ||
    appointment.contact_name ||
    appointment.fullName ||
    appointment.full_name ||
    appointment.firstName ||
    appointment.first_name ||
    ''
  )
  if (direct) return direct.slice(0, 90)

  const contactId = String(options.contactId || appointment.contactId || appointment.contact_id || '').trim()
  if (!contactId) return ''

  const contact = await db.get(
    'SELECT full_name, first_name, phone FROM contacts WHERE id = ?',
    [contactId]
  ).catch(() => null)

  return cleanNotificationText(contact?.full_name || contact?.first_name || contact?.phone || '').slice(0, 90)
}

export async function sendAppointmentConfirmationNotification(appointment = {}, options = {}) {
  if (!pushConfigured && !nativePushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const enabled = await getBooleanPushConfig('appointment_confirmation_push_notifications_enabled', true)
  if (!enabled) return { sent: 0, skipped: true, reason: 'disabled' }

  const appointmentId = String(options.appointmentId || appointment.id || '').trim()
  if (!appointmentId) return { sent: 0, skipped: true, reason: 'missing_appointment' }

  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  const preferenceTarget = await getPushPreferenceTarget('appointment_confirmed')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contactName = await getAppointmentContactName(appointment, options)
  const appointmentTitle = cleanNotificationText(options.appointmentTitle || appointment.title || appointment.name || 'cita')
  const timeLabel = formatAppointmentTime(options.startTime || appointment.startTime || appointment.start_time)
  const detail = cleanNotificationText(options.resultDetail || '')
  const bodyParts = [
    `Confirmó ${appointmentTitle}`,
    timeLabel,
    detail
  ].filter(Boolean)
  const payload = {
    title: contactName || 'Cita confirmada',
    body: bodyParts.join(' · ').slice(0, 220),
    tag: `appointment-confirmed-${appointmentId}`,
    threadId: calendarId ? `calendar-${calendarId}` : `appointment-${appointmentId}`,
    url: `/phone/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`,
    category: 'appointment_confirmed',
    eventKey: 'appointment_confirmed',
    contactId: appointment.contactId || appointment.contact_id || options.contactId || ''
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, { calendarId }))
}

export async function sendChatMessageNotification(message = {}) {
  if (!pushConfigured && !nativePushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const enabled = await getBooleanPushConfig('chat_push_notifications_enabled', true)
  if (!enabled) return { sent: 0, skipped: true, reason: 'disabled' }

  const suppressByAgent = await shouldSuppressChatNotificationForConversationalAgent(message.contactId).catch((error) => {
    logger.warn(`[Push] No se pudo revisar silencio del agente conversacional: ${error.message}`)
    return false
  })
  if (suppressByAgent) {
    return { sent: 0, skipped: true, reason: 'conversational_agent_attending' }
  }
  // (MOB-002 / NOTI-004) No exponer nombre ni texto de contactos ocultos en el push de chat
  const hidden = await isContactHiddenFromNotifications(message.contactId).catch((error) => {
    logger.warn(`[Push] No se pudo verificar contacto oculto para chat: ${error.message}`)
    return true // fail-safe: ante error no enviamos para evitar fuga
  })
  if (hidden) {
    return { sent: 0, skipped: true, reason: 'hidden_contact' }
  }
  const preferenceTarget = await getPushPreferenceTarget('conversations')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const senderName = getChatSenderName(message)
  const bodyText = getChatMessageBody(message)
  const messageKey = cleanNotificationText(message.messageId || message.timestamp || `${senderName}-${bodyText}-${Date.now()}`)
  const payload = {
    title: senderName,
    body: bodyText,
    tag: `chat-${messageKey}`,
    threadId: message.contactId ? `chat-${message.contactId}` : `chat-${senderName}`,
    messageId: messageKey,
    contactId: message.contactId || '',
    url: `/phone/chat?contact=${encodeURIComponent(message.contactId || '')}`,
    category: 'chat'
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget))
}

export async function sendConversationalAgentPriorityNotification(signal = {}) {
  if (!pushConfigured && !nativePushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const enabled = await getBooleanPushConfig('chat_push_notifications_enabled', true)
  if (!enabled) return { sent: 0, skipped: true, reason: 'disabled' }

  const contactId = String(signal.contactId || '').trim()
  if (!contactId) return { sent: 0, skipped: true, reason: 'missing_contact' }
  // (MOB-002 / NOTI-004) No exponer nombre de contactos ocultos en el aviso de prioridad
  const hidden = await isContactHiddenFromNotifications(contactId).catch((error) => {
    logger.warn(`[Push] No se pudo verificar contacto oculto para prioridad: ${error.message}`)
    return true // fail-safe: ante error no enviamos para evitar fuga
  })
  if (hidden) {
    return { sent: 0, skipped: true, reason: 'hidden_contact' }
  }
  const preferenceTarget = await getPushPreferenceTarget('agent_priority')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contact = await db.get(
    'SELECT full_name, first_name, phone FROM contacts WHERE id = ?',
    [contactId]
  ).catch(() => null)
  const senderName = getChatSenderName({
    contactName: contact?.full_name || contact?.first_name || '',
    phone: contact?.phone || ''
  })
  const reason = cleanNotificationText(signal.reason || signal.summary)
  const body = reason
    ? `${senderName}: ${reason}`
    : `${senderName}: el agente lo dejó en prioridad para humano.`
  const payload = {
    title: 'Pasar a un humano',
    body,
    tag: `agent-priority-${contactId}`,
    threadId: `chat-${contactId}`,
    messageId: `agent-priority-${contactId}-${Date.now()}`,
    contactId,
    url: `/phone/chat?contact=${encodeURIComponent(contactId)}`,
    category: 'chat'
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget))
}

export async function sendPaymentNotification(payment = {}) {
  if (!pushConfigured && !nativePushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const enabled = await getBooleanPushConfig('payment_push_notifications_enabled', true)
  if (!enabled) return { sent: 0, skipped: true, reason: 'disabled' }
  const preferenceTarget = await getPushPreferenceTarget('payments')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const amountLabel = formatPaymentAmount(payment.amount, payment.currency)
  const contactLabel = String(payment.contactName || payment.contact_name || 'Cliente').trim()
  const payload = {
    title: 'Pago registrado',
    body: `${contactLabel}: ${amountLabel}`,
    tag: `payment-${payment.id || payment.contactId || 'ristak'}`,
    threadId: payment.contactId || payment.contact_id ? `payment-${payment.contactId || payment.contact_id}` : 'payments',
    url: '/phone/transactions',
    category: 'payment',
    eventKey: 'payments',
    contactId: payment.contactId || payment.contact_id || ''
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget))
}
