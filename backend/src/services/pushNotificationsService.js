import crypto from 'crypto'
import fs from 'fs/promises'
import http2 from 'http2'
import sharp from 'sharp'
import webPush from 'web-push'
import { db, getAppConfig, setAppConfig, getUserAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { getAccountTimezone, normalizeToUtcIso, resolveTimezone } from '../utils/dateUtils.js'
import {
  getCentralMobilePushStatus,
  sendCentralMobilePushNotifications
} from './licenseService.js'
import { shouldSuppressChatNotificationForConversationalAgent } from './conversationalAgentService.js'
// (MOB-002 / NOTI-004) Importamos el chequeo de contactos ocultos para no exponerlos en el push
import { resolvePushNotificationTargetForEvent, isContactHiddenFromNotifications } from './notificationPreferencesService.js'
// (Presencia) No notificar a quien ya tiene el chat abierto; marcarle leído.
import { getViewingUserIds } from './presenceService.js'
import { markChatContactReadForUser } from './chatReadStateService.js'
import { publishPaymentChangedEvent } from './paymentLiveEventsService.js'

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
const NOTIFICATION_INITIALS_AVATAR_PATH = '/api/push/contact-avatar'
const NOTIFICATION_INITIALS_AVATAR_SIZE = 512
const NOTIFICATION_INITIALS_AVATAR_COLORS = [
  '#0ea5e9',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#be123c'
]
const ANDROID_CHANNELS = {
  alerts: 'ristak_alerts',
  sound: 'ristak_sound',
  vibration: 'ristak_vibrate',
  silent: 'ristak_silent'
}
let appNotificationPayloadSenderForTest = null
let contactVisibilityCheckerForTest = null

export function setAppNotificationPayloadSenderForTest(sender) {
  appNotificationPayloadSenderForTest = typeof sender === 'function' ? sender : null
}

export function setPushContactVisibilityCheckerForTest(checker) {
  contactVisibilityCheckerForTest = typeof checker === 'function' ? checker : null
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
const CENTRAL_MOBILE_PUSH_STATUS_TTL_MS = 60_000
const DEFAULT_NATIVE_PUSH_PROVIDER_TIMEOUT_MS = 8_000
let nativePushProviderTimeoutMs = DEFAULT_NATIVE_PUSH_PROVIDER_TIMEOUT_MS
let pushProviderFetch = (...args) => fetch(...args)
let webPushSendNotification = (...args) => webPush.sendNotification(...args)
let fcmAccessTokenCache = { token: '', expiresAt: 0 }
let apnsJwtCache = { token: '', expiresAt: 0 }
let centralMobilePushStatusCache = { status: null, expiresAt: 0 }

async function fetchPushProvider(url, options = {}, consumeResponse = null) {
  const controller = new AbortController()
  let timeoutId = null
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      const timeoutError = new Error(`Proveedor push excedió ${nativePushProviderTimeoutMs} ms`)
      timeoutError.code = 'push_provider_timeout'
      reject(timeoutError)
    }, nativePushProviderTimeoutMs)
  })
  const requestPromise = Promise.resolve().then(async () => {
    const response = await pushProviderFetch(url, {
      ...options,
      signal: controller.signal
    })
    return typeof consumeResponse === 'function'
      ? consumeResponse(response)
      : response
  })
  try {
    return await Promise.race([requestPromise, timeoutPromise])
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'push_provider_timeout') {
      const timeoutError = new Error(`Proveedor push excedió ${nativePushProviderTimeoutMs} ms`)
      timeoutError.code = 'push_provider_timeout'
      throw timeoutError
    }
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function fetchPushProviderJson(url, options = {}) {
  return fetchPushProvider(url, options, async response => {
    let data = {}
    try {
      data = await response.json()
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
      if (response?.ok) {
        const invalidResponseError = new Error(
          `Proveedor push respondió ${response?.status || '2xx'} con JSON inválido`
        )
        invalidResponseError.code = 'push_provider_invalid_response'
        invalidResponseError.retryable = true
        invalidResponseError.cause = error
        throw invalidResponseError
      }
    }
    return { response, data }
  })
}

export function setPushProviderTransportForTest({ fetchImpl = null, webPushImpl = null, timeoutMs = null } = {}) {
  pushProviderFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => fetch(...args)
  webPushSendNotification = typeof webPushImpl === 'function'
    ? webPushImpl
    : (...args) => webPush.sendNotification(...args)
  nativePushProviderTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_NATIVE_PUSH_PROVIDER_TIMEOUT_MS
}

export function resetPushProviderTransportForTest() {
  pushProviderFetch = (...args) => fetch(...args)
  webPushSendNotification = (...args) => webPush.sendNotification(...args)
  nativePushProviderTimeoutMs = DEFAULT_NATIVE_PUSH_PROVIDER_TIMEOUT_MS
}

export async function fetchPushProviderJsonForTest(url, options = {}) {
  return fetchPushProviderJson(url, options)
}
const APP_NAME_TEXT_PATTERN = '(?:Ristak|Ristack|Reistak|Reistack)'
const APP_NAME_NOTIFICATION_TEXTS = new Set([
  'ristak',
  'ristak app',
  'ristak chat',
  'app ristak',
  'de ristak',
  'from ristak',
  'from ristak chat',
  'ristack',
  'ristack app',
  'ristack chat',
  'de ristack',
  'from ristack',
  'reistak',
  'reistak app',
  'reistak chat',
  'de reistak',
  'from reistak',
  'reistack',
  'reistack app',
  'reistack chat',
  'de reistack',
  'from reistack'
])
const NOTIFICATION_TITLE_EMOJI_BY_TEXT = new Map([
  ['Nuevo Pago', '💸'],
  ['Pago recibido', '💸'],
  ['Pago completado', '💸'],
  ['Pago rechazado', '❌'],
  ['Pago requiere atención', '⚠️'],
  ['Pago pendiente', '⏳'],
  ['Pago parcial', '🧾'],
  ['Pago vencido', '⏰'],
  ['Pago reembolsado', '↩️'],
  ['Pago cancelado', '❌'],
  ['Pago programado', '📅'],
  ['Pago enviado', '📤'],
  ['Pago creado', '🧾'],
  ['Pago actualizado', '💳'],
  ['Nueva Cita', '📅'],
  ['Cita agendada', '📅'],
  ['Cita confirmada', '✅'],
  ['Cita reprogramada', '↩️'],
  ['Cita cancelada', '❌'],
  ['Cita sin asistencia', '⚠️'],
  ['Cita actualizada', '📅']
])
const NOTIFICATION_TITLE_EMOJI_PREFIXES = Array.from(
  new Set(NOTIFICATION_TITLE_EMOJI_BY_TEXT.values())
)
const PAYMENT_STATUS_TITLES = {
  paid: 'Nuevo Pago',
  succeeded: 'Nuevo Pago',
  completed: 'Nuevo Pago',
  complete: 'Nuevo Pago',
  fulfilled: 'Nuevo Pago',
  success: 'Nuevo Pago',
  captured: 'Nuevo Pago',
  approved: 'Nuevo Pago',
  accredited: 'Nuevo Pago',
  failed: 'Pago rechazado',
  failure: 'Pago rechazado',
  error: 'Pago rechazado',
  declined: 'Pago rechazado',
  rejected: 'Pago rechazado',
  requires_action: 'Pago requiere atención',
  pending: 'Pago pendiente',
  processing: 'Pago pendiente',
  in_process: 'Pago pendiente',
  partial: 'Pago parcial',
  overdue: 'Pago vencido',
  refunded: 'Pago reembolsado',
  refund: 'Pago reembolsado',
  partially_refunded: 'Pago reembolsado',
  void: 'Pago cancelado',
  voided: 'Pago cancelado',
  cancelled: 'Pago cancelado',
  canceled: 'Pago cancelado',
  deleted: 'Pago cancelado',
  scheduled: 'Pago programado',
  sent: 'Pago enviado',
  draft: 'Pago creado'
}
const APPOINTMENT_STATUS_TITLES = {
  booked: 'Nueva Cita',
  scheduled: 'Nueva Cita',
  created: 'Nueva Cita',
  confirmed: 'Cita confirmada',
  rescheduled: 'Cita reprogramada',
  cancelled: 'Cita cancelada',
  canceled: 'Cita cancelada',
  no_show: 'Cita sin asistencia',
  noshow: 'Cita sin asistencia'
}

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
  logger.warn('[Push] Push nativo local sin FCM/APNs; los celulares pueden enviarse por Installer central si el proveedor esta configurado alla.')
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function emptyCentralMobilePushStatus(reason = '', { transientFailure = false } = {}) {
  return {
    configured: false,
    nativeConfigured: false,
    iosConfigured: false,
    androidConfigured: false,
    reason,
    status: transientFailure ? 'unknown' : 'known',
    transientFailure
  }
}

async function getCentralMobilePushStatusCached({ force = false } = {}) {
  if (!force && centralMobilePushStatusCache.status && centralMobilePushStatusCache.expiresAt > Date.now()) {
    return centralMobilePushStatusCache.status
  }

  try {
    const status = await getCentralMobilePushStatus()
    const normalized = {
      configured: status?.configured === true || status?.nativeConfigured === true,
      nativeConfigured: status?.nativeConfigured === true || status?.configured === true,
      iosConfigured: status?.iosConfigured === true || status?.ios?.configured === true,
      androidConfigured: status?.androidConfigured === true || status?.android?.configured === true,
      ios: status?.ios || null,
      android: status?.android || null,
      status: 'known',
      transientFailure: false
    }
    centralMobilePushStatusCache = {
      status: normalized,
      expiresAt: Date.now() + CENTRAL_MOBILE_PUSH_STATUS_TTL_MS
    }
    return normalized
  } catch (error) {
    const staleStatus = centralMobilePushStatusCache.status
    const status = staleStatus
      ? {
          ...staleStatus,
          reason: 'central_unavailable_stale',
          status: 'stale',
          transientFailure: true
        }
      : emptyCentralMobilePushStatus('central_unavailable', { transientFailure: true })
    centralMobilePushStatusCache = {
      status,
      expiresAt: Date.now() + Math.min(10_000, CENTRAL_MOBILE_PUSH_STATUS_TTL_MS)
    }
    logger.warn(`[Push] No se pudo leer push movil central: ${error.message}`)
    return status
  }
}

export function resetCentralMobilePushStatusCacheForTest() {
  centralMobilePushStatusCache = { status: null, expiresAt: 0 }
}

async function getEffectivePushTransportStatus() {
  const central = await getCentralMobilePushStatusCached()
  return {
    webConfigured: pushConfigured,
    nativeConfigured: nativePushConfigured || central.iosConfigured || central.androidConfigured,
    androidConfigured: fcmConfigured || central.androidConfigured,
    iosConfigured: apnsConfigured || central.iosConfigured,
    central
  }
}

async function hasAnyPushTransport() {
  const status = await getEffectivePushTransportStatus()
  return status.webConfigured || status.nativeConfigured
}

function normalizeCalendarIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizeUserIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizeDeliveryTargets(value = {}) {
  const normalizeIds = ids => Array.isArray(ids)
    ? [...new Set(ids.map(item => String(item || '').trim()).filter(Boolean))]
    : []
  return {
    webSubscriptionIds: normalizeIds(value?.webSubscriptionIds),
    mobileDeviceIds: normalizeIds(value?.mobileDeviceIds)
  }
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

  const { response, data } = await fetchPushProviderJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  })

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
  const contactAvatarUrl = getNotificationContactAvatarUrl(payload)
  const notificationImageUrl = getNotificationImageUrl(payload)
  const contactName = getNotificationContactName(payload)
  const title = getNotificationTitle(payload)
  const body = getNotificationBody(payload)
  return Object.fromEntries(
    Object.entries({
      title,
      body,
      url: payload.url || '/movil',
      category: payload.category || 'ristak',
      tag: payload.tag || 'ristak',
      threadId: payload.threadId || payload.tag || payload.category || 'ristak',
      eventKey: payload.eventKey || '',
      messageId: payload.messageId || '',
      contactId: payload.contactId || '',
      contactName,
      contactAvatarUrl,
      senderAvatarUrl: contactAvatarUrl,
      notificationImageUrl,
      notificationAttachmentUrl: notificationImageUrl
    }).map(([key, value]) => [key, String(value || '')])
  )
}

function cleanNotificationText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function stripAppNameFromNotificationText(value = '') {
  return cleanNotificationText(value)
    .replace(new RegExp(`\\s+(?:from|de)\\s+${APP_NAME_TEXT_PATTERN}(?:\\s+(?:Chat|App))?$`, 'i'), '')
    .replace(new RegExp(`^${APP_NAME_TEXT_PATTERN}(?:\\s+(?:Chat|App))?\\s*[:\\-–]\\s*`, 'i'), '')
    .trim()
}

function isAppNameNotificationText(value = '') {
  const text = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()

  return APP_NAME_NOTIFICATION_TEXTS.has(text)
}

function titleStartsWithNotificationEmoji(value = '') {
  const text = cleanNotificationText(value)
  return NOTIFICATION_TITLE_EMOJI_PREFIXES.some((emoji) => text.startsWith(`${emoji} `))
}

function addNotificationTitleEmoji(value = '') {
  const title = cleanNotificationText(value)
  if (!title || titleStartsWithNotificationEmoji(title)) return title
  const emoji = NOTIFICATION_TITLE_EMOJI_BY_TEXT.get(title)
  return emoji ? `${emoji} ${title}` : title
}

function getNotificationTitle(payload = {}) {
  const fallback = payload.category === 'chat' ? 'Mensaje nuevo' : DEFAULT_NOTIFICATION_TITLE
  const title = stripAppNameFromNotificationText(payload.title)
  const safeTitle = title && !isAppNameNotificationText(title) ? title : fallback
  return addNotificationTitleEmoji(safeTitle)
}

function getNotificationBody(payload = {}) {
  const body = stripAppNameFromNotificationText(payload.body)
  return body && !isAppNameNotificationText(body) ? body : DEFAULT_NOTIFICATION_BODY
}

export function normalizeNotificationPayload(payload = {}) {
  return {
    ...payload,
    title: getNotificationTitle(payload),
    body: getNotificationBody(payload)
  }
}

function cleanPublicImageUrl(value = '') {
  const raw = cleanNotificationText(value)
  if (!raw || /^data:/i.test(raw) || /^file:/i.test(raw)) return ''
  try {
    const parsed = new URL(raw)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : ''
  } catch {
    return ''
  }
}

function cleanPublicBaseUrl(value = '') {
  const raw = cleanNotificationText(value).replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

function getNotificationPublicBaseUrl() {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_PUBLIC_URL,
    process.env.FRONTEND_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL
  ]

  for (const candidate of candidates) {
    const baseUrl = cleanPublicBaseUrl(candidate)
    if (baseUrl) return baseUrl
  }
  return ''
}

function getNotificationImageUrl(payload = {}) {
  return cleanPublicImageUrl(
    payload.notificationImageUrl ||
    payload.notification_image_url ||
    payload.notificationAttachmentUrl ||
    payload.notification_attachment_url ||
    payload.mediaAttachmentUrl ||
    payload.media_attachment_url ||
    ''
  )
}

function getNotificationContactAvatarUrl(payload = {}) {
  return cleanPublicImageUrl(
    payload.contactAvatarUrl ||
    payload.contact_avatar_url ||
    payload.senderAvatarUrl ||
    payload.sender_avatar_url ||
    payload.avatarUrl ||
    payload.avatar_url ||
    payload.profilePictureUrl ||
    payload.profile_picture_url ||
    payload.photoUrl ||
    payload.photo_url ||
    payload.pictureUrl ||
    payload.picture_url ||
    ''
  )
}

function shouldUseNotificationServiceExtension(payload = {}) {
  if (getNotificationContactAvatarUrl(payload) || getNotificationImageUrl(payload)) {
    return true
  }
  // Chat: siempre corre la extensión de notificaciones (mutable-content) para que
  // iOS pinte el avatar circular del remitente aunque el mensaje sea solo texto y sin
  // URL de imagen. Si no hay foto real, la extensión dibuja las iniciales en el propio
  // dispositivo, así que ya no dependemos de que exista una base URL pública para
  // servir el PNG de iniciales.
  return getNotificationCategory(payload).toLowerCase() === 'chat'
}

function getNotificationContactName(payload = {}) {
  const candidates = [
    payload.contactName,
    payload.contact_name,
    payload.senderName,
    payload.sender_name,
    payload.customerName,
    payload.customer_name,
    payload.clientName,
    payload.client_name,
    payload.profileName,
    payload.profile_name
  ]

  for (const candidate of candidates) {
    const value = stripAppNameFromNotificationText(candidate)
    if (value && !isAppNameNotificationText(value)) {
      return value.slice(0, 90)
    }
  }

  return ''
}

function getPayloadContactImageCandidateUrl(payload = {}) {
  return getNotificationContactAvatarUrl(payload) ||
    cleanPublicImageUrl(payload.imageUrl || payload.image_url || '')
}

function normalizePayloadContactIds(payload = {}) {
  const values = []
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append)
      return
    }
    const raw = String(value || '').trim()
    if (!raw) return
    raw.split(',').map((item) => item.trim()).filter(Boolean).forEach((item) => values.push(item))
  }

  append(payload.contactIds)
  append(payload.contact_ids)
  append(payload.contactId)
  append(payload.contact_id)

  return [...new Set(values)]
}

function findProfilePictureUrlInValue(value) {
  if (!value) return ''
  let parsed = value
  if (typeof value === 'string') {
    const clean = value.trim()
    if (!clean) return ''
    try {
      parsed = JSON.parse(clean)
    } catch {
      return cleanPublicImageUrl(clean)
    }
  }
  if (!parsed || typeof parsed !== 'object') return ''

  const keys = [
    'profilePictureUrl',
    'profile_picture_url',
    'profilePhotoUrl',
    'profile_photo_url',
    'pictureUrl',
    'picture_url',
    'avatarUrl',
    'avatar_url',
    'photoUrl',
    'photo_url',
    'displayPictureUrl',
    'display_picture_url'
  ]
  for (const key of keys) {
    const candidate = cleanPublicImageUrl(parsed[key])
    if (candidate) return candidate
  }
  for (const nested of Object.values(parsed)) {
    if (nested && typeof nested === 'object') {
      const candidate = findProfilePictureUrlInValue(nested)
      if (candidate) return candidate
    }
  }
  return ''
}

function escapeSvgText(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function normalizeNotificationInitials(value = '') {
  const clean = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  const words = clean
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter(Boolean)

  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase()
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }

  const alphanumeric = clean.match(/[a-z0-9]/gi)?.join('') || ''
  return (alphanumeric.slice(0, 2) || 'C').toUpperCase()
}

function getNotificationAvatarColorIndex(seed = '') {
  const bytes = crypto.createHash('sha256').update(cleanNotificationText(seed) || 'contact').digest()
  return bytes[0] % NOTIFICATION_INITIALS_AVATAR_COLORS.length
}

function getNotificationInitialsAvatarSignatureSecret() {
  const seed = [
    VAPID_PRIVATE_KEY,
    APNS_PRIVATE_KEY,
    FCM_SERVICE_ACCOUNT_JSON,
    process.env.JWT_SECRET,
    process.env.SESSION_SECRET,
    process.env.INTERNAL_INSTALLER_TOKEN,
    'ristak-notification-initials-avatar'
  ].filter(Boolean).join('|')

  return crypto.createHash('sha256').update(seed).digest()
}

function signNotificationInitialsAvatar({ contactId = '', initials = '', colorIndex = 0 } = {}) {
  return crypto
    .createHmac('sha256', getNotificationInitialsAvatarSignatureSecret())
    .update(`${cleanNotificationText(contactId)}:${normalizeNotificationInitials(initials)}:${Number(colorIndex) || 0}`)
    .digest('base64url')
    .slice(0, 36)
}

function safeEqualSignature(left = '', right = '') {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function getNotificationContactFallbackName(payload = {}, contact = null) {
  const candidates = [
    getNotificationContactName(payload),
    contact?.full_name,
    [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    contact?.whatsapp_profile_name,
    contact?.meta_social_profile_name,
    contact?.meta_social_username,
    contact?.email,
    contact?.phone,
    payload.contactId,
    payload.contact_id
  ]

  for (const candidate of candidates) {
    const value = stripAppNameFromNotificationText(candidate)
    if (value && !isAppNameNotificationText(value)) return value
  }

  return 'Contacto'
}

function buildNotificationInitialsAvatarUrl({ contactId = '', displayName = '' } = {}) {
  const baseUrl = getNotificationPublicBaseUrl()
  const id = cleanNotificationText(contactId)
  if (!baseUrl || !id) return ''

  const initials = normalizeNotificationInitials(displayName)
  const colorIndex = getNotificationAvatarColorIndex(`${id}:${displayName}:${initials}`)
  const signature = signNotificationInitialsAvatar({ contactId: id, initials, colorIndex })
  const url = new URL(`${baseUrl}${NOTIFICATION_INITIALS_AVATAR_PATH}/${encodeURIComponent(id)}`)
  url.searchParams.set('i', initials)
  url.searchParams.set('c', String(colorIndex))
  url.searchParams.set('s', signature)
  return url.href
}

async function getContactNotificationAvatarUrl(contactId = '') {
  const id = String(contactId || '').trim()
  if (!id) return ''

  const contact = await db.get(`
    SELECT
      c.id,
      c.phone,
      (
        SELECT profile_picture_url
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = c.phone
           OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
        ORDER BY CASE WHEN NULLIF(profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                 profile_picture_updated_at DESC,
                 updated_at DESC
        LIMIT 1
      ) AS whatsapp_profile_picture_url,
      (
        SELECT raw_profile_json
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = c.phone
           OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS whatsapp_raw_profile_json,
      (
        SELECT profile_picture_url
        FROM meta_social_contacts
        WHERE contact_id = c.id
        ORDER BY CASE WHEN NULLIF(profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                 updated_at DESC
        LIMIT 1
      ) AS meta_social_profile_picture_url
    FROM contacts c
    WHERE c.id = ?
    LIMIT 1
  `, [id]).catch((error) => {
    logger.warn(`[Push] No se pudo resolver avatar de contacto para notificación: ${error.message}`)
    return null
  })

  return cleanPublicImageUrl(contact?.whatsapp_profile_picture_url) ||
    cleanPublicImageUrl(contact?.meta_social_profile_picture_url) ||
    findProfilePictureUrlInValue(contact?.whatsapp_raw_profile_json)
}

async function getContactNotificationFallbackAvatarUrl(contactId = '', payload = {}) {
  const id = String(contactId || '').trim()
  if (!id) return ''

  const contact = await db.get(`
    SELECT
      c.id,
      c.phone,
      c.email,
      c.full_name,
      c.first_name,
      c.last_name,
      (
        SELECT profile_name
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = c.phone
           OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS whatsapp_profile_name,
      (
        SELECT profile_name
        FROM meta_social_contacts
        WHERE contact_id = c.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS meta_social_profile_name,
      (
        SELECT username
        FROM meta_social_contacts
        WHERE contact_id = c.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS meta_social_username
    FROM contacts c
    WHERE c.id = ?
    LIMIT 1
  `, [id]).catch((error) => {
    logger.warn(`[Push] No se pudo resolver iniciales de contacto para notificación: ${error.message}`)
    return null
  })

  const displayName = getNotificationContactFallbackName(payload, contact)
  return buildNotificationInitialsAvatarUrl({ contactId: id, displayName })
}

export async function renderNotificationInitialsAvatarPng({
  contactId = '',
  initials = '',
  colorIndex = '',
  signature = ''
} = {}) {
  const id = cleanNotificationText(contactId)
  const cleanInitials = normalizeNotificationInitials(initials).slice(0, 2)
  const parsedColorIndex = Number(colorIndex)
  const safeColorIndex = Number.isInteger(parsedColorIndex) && parsedColorIndex >= 0
    ? parsedColorIndex % NOTIFICATION_INITIALS_AVATAR_COLORS.length
    : 0
  const expectedSignature = signNotificationInitialsAvatar({
    contactId: id,
    initials: cleanInitials,
    colorIndex: safeColorIndex
  })

  if (!id || !signature || !safeEqualSignature(signature, expectedSignature)) {
    throw new Error('Avatar de notificación inválido')
  }

  const background = NOTIFICATION_INITIALS_AVATAR_COLORS[safeColorIndex]
  const fontSize = cleanInitials.length > 1 ? 188 : 230
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${NOTIFICATION_INITIALS_AVATAR_SIZE}" height="${NOTIFICATION_INITIALS_AVATAR_SIZE}" viewBox="0 0 ${NOTIFICATION_INITIALS_AVATAR_SIZE} ${NOTIFICATION_INITIALS_AVATAR_SIZE}">
      <rect width="100%" height="100%" rx="${NOTIFICATION_INITIALS_AVATAR_SIZE / 2}" fill="${background}"/>
      <circle cx="256" cy="256" r="238" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="18"/>
      <text x="256" y="278" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" fill="#f8fbff">${escapeSvgText(cleanInitials)}</text>
    </svg>
  `

  return sharp(Buffer.from(svg), { limitInputPixels: NOTIFICATION_INITIALS_AVATAR_SIZE * NOTIFICATION_INITIALS_AVATAR_SIZE })
    .png()
    .toBuffer()
}

async function enrichNotificationPayloadForDelivery(payload = {}) {
  const normalized = normalizeNotificationPayload(payload)
  if (String(normalized.category || '').trim().toLowerCase() !== 'chat') return normalized

  const contactIds = normalizePayloadContactIds(normalized)
  if (contactIds.length !== 1) return normalized

  const directImageUrl = getPayloadContactImageCandidateUrl(normalized)
  if (directImageUrl) {
    return {
      ...normalized,
      contactId: normalized.contactId || contactIds[0],
      contactAvatarUrl: directImageUrl,
      senderAvatarUrl: directImageUrl
    }
  }

  const contactAvatarUrl = await getContactNotificationAvatarUrl(contactIds[0])
  const fallbackAvatarUrl = contactAvatarUrl || await getContactNotificationFallbackAvatarUrl(contactIds[0], normalized)
  if (!fallbackAvatarUrl) return normalized

  return {
    ...normalized,
    contactId: normalized.contactId || contactIds[0],
    contactAvatarUrl: fallbackAvatarUrl,
    senderAvatarUrl: fallbackAvatarUrl
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

  return 'Mensaje nuevo'
}

function getChatMessageType(message = {}) {
  return String(message.messageType || message.type || '').trim().toLowerCase()
}

function getFirstCleanChatValue(candidates = []) {
  for (const candidate of candidates) {
    const value = cleanNotificationText(candidate)
    if (value) return value
  }
  return ''
}

function getChatMediaFilename(message = {}) {
  const raw = getFirstCleanChatValue([
    message.mediaFilename,
    message.media_filename,
    message.filename,
    message.fileName,
    message.file_name,
    message.originalFilename,
    message.original_filename,
    message.document?.filename,
    message.document?.fileName,
    message.document?.file_name,
    message.file?.filename,
    message.file?.fileName,
    message.media?.filename,
    message.media?.fileName,
    message.mediaUrl,
    message.media_url,
    message.attachmentUrl,
    message.attachment_url,
    message.documentUrl,
    message.document_url
  ])

  if (!raw) return ''

  let filename = raw
  try {
    const parsed = new URL(raw)
    filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
  } catch {
    filename = raw.split(/[\\/]/).pop()
  }

  return cleanNotificationText(filename).slice(0, 160)
}

function parseChatDurationMs(value, unit = 'ms') {
  const raw = cleanNotificationText(value)
  if (!raw) return 0

  if (/^\d{1,2}(?::\d{1,2}){1,2}$/.test(raw)) {
    const parts = raw.split(':').map(part => Number(part))
    if (parts.every(Number.isFinite)) {
      const seconds = parts.reduce((total, part) => total * 60 + part, 0)
      return seconds > 0 ? seconds * 1000 : 0
    }
  }

  const numeric = Number(raw)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  if (unit === 'seconds') return Math.round(numeric * 1000)
  if (unit === 'auto') return numeric <= 3600 ? Math.round(numeric * 1000) : Math.round(numeric)
  return Math.round(numeric)
}

function getChatMediaDurationMs(message = {}) {
  const millisecondCandidates = [
    message.mediaDurationMs,
    message.media_duration_ms,
    message.durationMs,
    message.duration_ms,
    message.audioDurationMs,
    message.audio_duration_ms,
    message.voiceDurationMs,
    message.voice_duration_ms,
    message.audio?.durationMs,
    message.audio?.duration_ms,
    message.voice?.durationMs,
    message.voice?.duration_ms,
    message.media?.durationMs,
    message.media?.duration_ms
  ]
  for (const candidate of millisecondCandidates) {
    const durationMs = parseChatDurationMs(candidate, 'ms')
    if (durationMs) return durationMs
  }

  const secondCandidates = [
    message.durationSeconds,
    message.duration_seconds,
    message.audioDurationSeconds,
    message.audio_duration_seconds,
    message.voiceDurationSeconds,
    message.voice_duration_seconds,
    message.audio?.durationSeconds,
    message.audio?.duration_seconds,
    message.voice?.durationSeconds,
    message.voice?.duration_seconds,
    message.media?.durationSeconds,
    message.media?.duration_seconds
  ]
  for (const candidate of secondCandidates) {
    const durationMs = parseChatDurationMs(candidate, 'seconds')
    if (durationMs) return durationMs
  }

  const ambiguousCandidates = [
    message.duration,
    message.audio?.duration,
    message.voice?.duration,
    message.media?.duration
  ]
  for (const candidate of ambiguousCandidates) {
    const durationMs = parseChatDurationMs(candidate, 'auto')
    if (durationMs) return durationMs
  }

  return 0
}

function formatChatMediaDuration(durationMs = 0) {
  const numericDurationMs = Number(durationMs || 0)
  if (!Number.isFinite(numericDurationMs) || numericDurationMs <= 0) return ''
  const totalSeconds = Math.max(1, Math.round(numericDurationMs / 1000))

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const paddedSeconds = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
  return `${minutes}:${paddedSeconds}`
}

function isChatAudioType(type = '') {
  return ['audio', 'voice'].includes(String(type || '').trim().toLowerCase())
}

function buildChatVoiceBody(message = {}) {
  const duration = formatChatMediaDuration(getChatMediaDurationMs(message))
  return duration ? `🎤 Mensaje de voz (${duration})` : '🎤 Mensaje de voz'
}

function isChatDocumentType(type = '') {
  return ['document', 'file'].includes(String(type || '').trim().toLowerCase())
}

function isLikelyDocumentFilename(value = '') {
  return /\.[a-z0-9]{2,10}$/i.test(cleanNotificationText(value))
}

function getChatDocumentPageCount(message = {}) {
  const candidates = [
    message.pageCount,
    message.page_count,
    message.pages,
    message.mediaPageCount,
    message.media_page_count,
    message.mediaPages,
    message.media_pages,
    message.documentPageCount,
    message.document_page_count,
    message.documentPages,
    message.document_pages,
    message.document?.pageCount,
    message.document?.page_count,
    message.document?.pages,
    message.file?.pageCount,
    message.file?.pages,
    message.media?.pageCount,
    message.media?.pages
  ]

  for (const candidate of candidates) {
    const count = Number(cleanNotificationText(candidate))
    if (Number.isFinite(count) && count > 0) return Math.floor(count)
  }

  return 0
}

function buildChatDocumentBody(message = {}, bodyText = '') {
  const filename = getChatMediaFilename(message) || (isLikelyDocumentFilename(bodyText) ? bodyText : '')
  const pageCount = getChatDocumentPageCount(message)
  const pageLabel = pageCount ? ` (${pageCount} ${pageCount === 1 ? 'página' : 'páginas'})` : ''
  return filename ? `📄 ${filename}${pageLabel}` : '📄 Documento'
}

function isGenericChatMediaText(value = '', type = '') {
  const normalized = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()

  if (!normalized) return true

  const genericByType = {
    image: new Set(['foto', 'image', 'imagen']),
    photo: new Set(['foto', 'photo', 'imagen']),
    picture: new Set(['foto', 'picture', 'imagen']),
    video: new Set(['video']),
    gif: new Set(['gif']),
    audio: new Set(['audio', 'mensaje de voz', 'nota de voz', 'voice message']),
    voice: new Set(['audio', 'mensaje de voz', 'nota de voz', 'voice message']),
    document: new Set(['documento', 'document', 'archivo', 'file']),
    file: new Set(['documento', 'document', 'archivo', 'file']),
    location: new Set(['ubicacion', 'location']),
    sticker: new Set(['sticker', 'pegatina'])
  }

  return genericByType[type]?.has(normalized) === true
}

function getChatMessageBody(message = {}) {
  const bodyText = cleanNotificationText(message.text)
  const type = getChatMessageType(message)
  const bodyIsGeneric = isGenericChatMediaText(bodyText, type)
  if (isChatDocumentType(type)) {
    const documentBody = buildChatDocumentBody(message, bodyText)
    if (!bodyText || bodyIsGeneric || isLikelyDocumentFilename(bodyText)) return documentBody.slice(0, 220)
  }
  if (isChatAudioType(type) && (!bodyText || bodyIsGeneric)) return buildChatVoiceBody(message)
  if (type === 'location') return '📍 Ubicación'

  const typeLabels = {
    image: '📷 Envió una foto.',
    photo: '📷 Envió una foto.',
    picture: '📷 Envió una foto.',
    video: '🎥 Envió un video.',
    gif: 'GIF',
    audio: buildChatVoiceBody(message),
    voice: buildChatVoiceBody(message),
    document: buildChatDocumentBody(message, bodyText),
    file: buildChatDocumentBody(message, bodyText),
    sticker: 'Sticker',
    location: '📍 Ubicación',
    contacts: 'Contacto',
    contact: 'Contacto',
    reaction: 'Reacción',
    button: 'Respuesta',
    interactive: 'Respuesta'
  }

  if (bodyText && !bodyIsGeneric) return bodyText.slice(0, 220)

  return typeLabels[type] || 'Mensaje'
}

function getFirstArrayValue(value) {
  return Array.isArray(value) ? value.find(item => cleanNotificationText(item)) : ''
}

function isChatMediaPreviewType(type = '') {
  return ['image', 'photo', 'picture', 'video', 'gif'].includes(String(type || '').trim().toLowerCase())
}

function getChatNotificationMediaUrl(message = {}) {
  const type = getChatMessageType(message)
  const candidates = [
    message.notificationImageUrl,
    message.notification_image_url,
    message.notificationAttachmentUrl,
    message.notification_attachment_url,
    message.mediaAttachmentUrl,
    message.media_attachment_url,
    message.mediaUrl,
    message.media_url,
    message.attachmentUrl,
    message.attachment_url,
    message.thumbnailUrl,
    message.thumbnail_url,
    message.previewUrl,
    message.preview_url,
    getFirstArrayValue(message.attachments),
    isChatMediaPreviewType(type) ? message.imageUrl : '',
    isChatMediaPreviewType(type) ? message.image_url : '',
    isChatMediaPreviewType(type) ? message.videoUrl : '',
    isChatMediaPreviewType(type) ? message.video_url : ''
  ]

  for (const candidate of candidates) {
    const url = cleanPublicImageUrl(candidate)
    if (url && isChatMediaPreviewType(type)) return url
  }

  return ''
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

// (MOB-006) Interpreta el valor on/off por-usuario (string|bool) con un default.
function interpretBooleanPushValue(raw, fallback = false) {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

// (MOB-006) Lee una clave on/off resuelta para el USUARIO destinatario (override propio
// con fallback al global). Así quien no personalizó nada sigue recibiendo lo de antes.
async function getUserBooleanPushConfig(userId, key, fallback = false) {
  const raw = await getUserAppConfig(userId, key).catch(() => null)
  return interpretBooleanPushValue(raw, fallback)
}

// (MOB-006) Resuelve sonido/vibración POR usuario (cada device usa lo de su dueño),
// con un caché user_id->experience para no repetir queries dentro de un mismo envío.
function createUserExperienceResolver() {
  const cache = new Map()
  return async (userId) => {
    const key = String(userId || '').trim()
    if (cache.has(key)) return cache.get(key)
    const [soundEnabled, vibrationEnabled] = await Promise.all([
      getUserBooleanPushConfig(key, PUSH_SOUND_CONFIG_KEY, true),
      getUserBooleanPushConfig(key, PUSH_VIBRATION_CONFIG_KEY, true)
    ])
    const experience = { soundEnabled, vibrationEnabled }
    cache.set(key, experience)
    return experience
  }
}

// (MOB-006) ¿El usuario destinatario tiene activado este tipo de notificación?
// enabledKey es la clave on/off del evento; si el usuario no la personalizó, hereda el
// global (fallback en getUserAppConfig) -> comportamiento idéntico al previo.
async function isEventEnabledForUser(userId, enabledKey) {
  if (!enabledKey) return true
  return getUserBooleanPushConfig(userId, enabledKey, true)
}

// (MOB-006) Para calendario: si el usuario tiene override propio de calendar_ids, ese
// override manda; lista vacía = todos los calendarios. Si no tiene override, no filtra
// por usuario (el filtrado por device/global ya se aplicó antes).
async function isCalendarAllowedForUser(userId, calendarId) {
  const target = String(calendarId || '').trim()
  if (!target) return true
  const raw = await getUserAppConfig(userId, 'calendar_push_notification_calendar_ids').catch(() => null)
  const calendarIds = normalizeCalendarIds(
    Array.isArray(raw) ? raw : safeJsonParse(raw || '[]', [])
  )
  if (calendarIds.length === 0) return true
  return calendarIds.includes(target)
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

function formatAppointmentTime(value, timezone) {
  if (!value) return ''
  const zone = resolveTimezone(timezone)
  const normalizedValue = normalizeToUtcIso(value, zone)
  if (!normalizedValue) return ''
  const date = new Date(normalizedValue)
  if (Number.isNaN(date.getTime())) return ''

  const parts = new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: zone
  }).formatToParts(date)
  const part = (type) => parts.find((item) => item.type === type)?.value || ''
  const month = part('month')
  const capitalizedMonth = month ? `${month.charAt(0).toUpperCase()}${month.slice(1)}` : ''
  const dayPeriod = part('dayPeriod').replace(/[.\s]/g, '').toUpperCase()
  const dateLabel = [part('day'), capitalizedMonth].filter(Boolean).join(' ')
  const timeLabel = `${part('hour')}:${part('minute')}${dayPeriod ? ` ${dayPeriod}` : ''}`
  return [dateLabel, timeLabel].filter(Boolean).join(', ')
}

function formatPaymentAmount(amount, currency = '') {
  if (amount === undefined || amount === null || amount === '') return ''
  const value = Number(amount)
  if (!Number.isFinite(value)) return ''
  const normalizedCurrency = String(currency || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) return ''

  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value)
  } catch {
    return `$${value.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  }
}

function normalizePaymentStatus(value = '') {
  const status = cleanNotificationText(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (status === 'succeeded') return 'paid'
  if (status === 'canceled') return 'cancelled'
  return status
}

function getPaymentNotificationTitle(payment = {}) {
  const status = normalizePaymentStatus(payment.paymentStatus || payment.payment_status || payment.status || 'paid')
  return addNotificationTitleEmoji(PAYMENT_STATUS_TITLES[status] || 'Pago actualizado')
}

function getPaymentContactLabel(payment = {}) {
  const contact = cleanNotificationText(
    payment.contactName ||
    payment.contact_name ||
    payment.customerName ||
    payment.customer_name ||
    payment.clientName ||
    payment.client_name ||
    ''
  )
  return contact && !isAppNameNotificationText(contact) ? contact.slice(0, 90) : 'Cliente'
}

function getPaymentDetailLabel(payment = {}) {
  const detail = cleanNotificationText(
    payment.failureReason ||
    payment.failure_reason ||
    payment.errorMessage ||
    payment.error_message ||
    payment.reason ||
    ''
  )
  return detail.slice(0, 110)
}

function getPaymentNotificationBody(payment = {}) {
  const contactLabel = getPaymentContactLabel(payment)
  const amountLabel = formatPaymentAmount(payment.amount, payment.currency)
  const detail = getPaymentDetailLabel(payment)
  const primary = amountLabel ? `${contactLabel} (${amountLabel})` : contactLabel
  return (`${primary}${detail ? ` - ${detail}` : ''}` || 'Revisa el detalle del pago.').slice(0, 220)
}

function normalizeAppointmentEventType(value = '') {
  const eventType = cleanNotificationText(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (eventType === 'appointment_booked' || eventType === 'booked') return 'booked'
  if (eventType === 'appointment_scheduled' || eventType === 'scheduled') return 'scheduled'
  if (eventType === 'appointment_created' || eventType === 'created') return 'created'
  if (eventType === 'appointment_confirmed' || eventType === 'confirmed') return 'confirmed'
  if (eventType === 'appointment_rescheduled' || eventType === 'rescheduled') return 'rescheduled'
  if (eventType === 'appointment_cancelled' || eventType === 'cancelled' || eventType === 'appointment_canceled' || eventType === 'canceled') return 'cancelled'
  return eventType || 'booked'
}

function getAppointmentNotificationTitle(eventType = 'booked') {
  return addNotificationTitleEmoji(APPOINTMENT_STATUS_TITLES[normalizeAppointmentEventType(eventType)] || 'Cita actualizada')
}

function getAppointmentEventKey(eventType = 'booked') {
  const normalized = normalizeAppointmentEventType(eventType)
  if (normalized === 'booked' || normalized === 'scheduled' || normalized === 'created') return 'appointment_booked'
  if (normalized === 'confirmed') return 'appointment_confirmed'
  return `appointment_${normalized}`
}

function getAppointmentNotificationBody(appointment = {}, options = {}, { contactName = '', detail = '', timezone = '' } = {}) {
  const timeLabel = formatAppointmentTime(
    options.startTime ||
    appointment.startTime ||
    appointment.start_time,
    timezone
  )
  const primary = [contactName || 'Cliente', timeLabel].filter(Boolean).join(' - ')
  const cleanDetail = cleanNotificationText(detail)
  return (`${primary}${cleanDetail ? ` - ${cleanDetail}` : ''}` || 'Revisa los detalles de la cita.').slice(0, 220)
}

async function resolveAppointmentNotificationTimezone(appointment = {}, options = {}) {
  const explicitTimezone = cleanNotificationText(
    options.timezone ||
    options.timeZone ||
    appointment.timezone ||
    appointment.time_zone ||
    ''
  )
  if (explicitTimezone) return resolveTimezone(explicitTimezone)
  return resolveTimezone(await getAccountTimezone())
}

function getAndroidChannelId({ soundEnabled = true, vibrationEnabled = true } = {}) {
  if (soundEnabled && vibrationEnabled) return ANDROID_CHANNELS.alerts
  if (soundEnabled) return ANDROID_CHANNELS.sound
  if (vibrationEnabled) return ANDROID_CHANNELS.vibration
  return ANDROID_CHANNELS.silent
}

function isExpoAndroidPushDevice(row = {}) {
  const clientType = String(row.client_type || row.clientType || '').trim().toLowerCase()
  const appPackage = String(row.app_package || row.appPackage || '').trim().toLowerCase()
  return clientType === 'expo' || clientType === 'expo_background_v1' || appPackage === 'com.ristak.android'
}

function supportsExpoHeadlessBackgroundPush(row = {}) {
  const clientType = String(row.client_type || row.clientType || '').trim().toLowerCase()
  return clientType === 'expo_background_v1'
}

function shouldUseExpoHeadlessBackgroundPush(row = {}, payload = {}) {
  return supportsExpoHeadlessBackgroundPush(row) &&
    getNotificationCategory(payload).toLowerCase() === 'chat'
}

function getNotificationCategory(payload = {}) {
  const category = cleanNotificationText(payload.category || 'ristak')
  return category || 'ristak'
}

function getNotificationThreadId(payload = {}) {
  const threadId = cleanNotificationText(payload.threadId || payload.contactId || payload.tag || getNotificationCategory(payload))
  return threadId.slice(0, 64) || 'ristak'
}

function getNotificationCollapseId(payload = {}) {
  const raw = cleanNotificationText(payload.messageId || payload.tag || payload.eventKey || '')
  if (!raw) return ''
  const ascii = raw.replace(/[^a-z0-9._-]+/gi, '_')
  if (ascii.length <= 64) return ascii
  return `ristak_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 56)}`
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

export async function getPublicPushConfig() {
  const transport = await getEffectivePushTransportStatus()
  return {
    configured: pushConfigured,
    publicKey: pushConfigured ? VAPID_PUBLIC_KEY : '',
    nativeConfigured: transport.nativeConfigured,
    androidConfigured: transport.androidConfigured,
    iosConfigured: transport.iosConfigured
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
  clientType = '',
  appPackage = '',
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
  const rawClientType = String(clientType || '').trim().toLowerCase()
  const normalizedClientType = ['expo', 'expo_background_v1', 'native'].includes(rawClientType)
    ? rawClientType
    : ''
  const normalizedAppPackage = String(appPackage || '').trim().toLowerCase().slice(0, 128)

  await db.run(`
    INSERT INTO mobile_push_devices (
      id, user_id, platform, token, client_type, app_package, calendar_ids_json, enabled,
      app_version, app_build, device_model, os_version, last_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(token) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, mobile_push_devices.user_id),
      platform = excluded.platform,
      client_type = excluded.client_type,
      app_package = excluded.app_package,
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
    normalizedClientType,
    normalizedAppPackage,
    JSON.stringify(normalizedCalendarIds),
    String(appVersion || '').trim(),
    String(appBuild || '').trim(),
    String(deviceModel || '').trim(),
    String(osVersion || '').trim()
  ])

  return {
    id,
    platform: normalizedPlatform,
    clientType: normalizedClientType,
    appPackage: normalizedAppPackage,
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
  const normalizedUserIds = Array.isArray(userIds) ? normalizeUserIds(userIds) : null
  if (normalizedUserIds && normalizedUserIds.length === 0) return []
  return db.all(`
    SELECT id, user_id, endpoint, subscription_json
    FROM push_subscriptions
    WHERE enabled = 1
      ${normalizedUserIds ? `AND user_id IN (${normalizedUserIds.map(() => '?').join(', ')})` : ''}
  `, normalizedUserIds || [])
}

async function getMobileDevicesForCalendar(calendarId) {
  const rows = await db.all(`
    SELECT id, user_id, platform, token, client_type, app_package, calendar_ids_json
    FROM mobile_push_devices
    WHERE enabled = 1
  `)

  return rows.filter((row) => {
    const calendarIds = normalizeCalendarIds(safeJsonParse(row.calendar_ids_json || '[]', []))
    return calendarIds.length === 0 || calendarIds.includes(calendarId)
  })
}

async function getEnabledMobileDevices(userIds = null) {
  const normalizedUserIds = Array.isArray(userIds) ? normalizeUserIds(userIds) : null
  if (normalizedUserIds && normalizedUserIds.length === 0) return []
  return db.all(`
    SELECT id, user_id, platform, token, client_type, app_package, calendar_ids_json
    FROM mobile_push_devices
    WHERE enabled = 1
      ${normalizedUserIds ? `AND user_id IN (${normalizedUserIds.map(() => '?').join(', ')})` : ''}
  `, normalizedUserIds || [])
}

async function markSubscriptionError(row, error) {
  const shouldDisable = isPermanentWebPushError(error)

  await db.run(
    `UPDATE push_subscriptions
     SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [shouldDisable ? 0 : 1, error?.message || 'Error enviando notificación', row.id]
  ).catch(() => {})
}

function isPermanentWebPushError(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0)
  return statusCode === 404 || statusCode === 410
}

function isPermanentMobilePushError(error) {
  const reason = [error?.code, error?.reason, error?.errorCode, error?.error]
    .map(value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ''))
    .filter(Boolean)
    .join(' ')
  return reason.includes('UNREGISTERED') ||
    reason.includes('BADDEVICETOKEN') ||
    reason.includes('DEVICENOTREGISTERED') ||
    reason.includes('REGISTRATIONTOKENNOTREGISTERED')
}

async function markMobileDeviceError(row, error) {
  const shouldDisable = isPermanentMobilePushError(error)

  await db.run(
    `UPDATE mobile_push_devices
     SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [shouldDisable ? 0 : 1, error?.message || 'Error enviando notificación al celular', row.id]
  ).catch(() => {})
}

async function sendNotificationRows(rows = [], payload = {}) {
  let sent = 0
  let retryableFailures = 0
  let permanentFailures = 0
  const retrySubscriptionIds = []
  await Promise.all(rows.map(async (row) => {
    const subscription = safeJsonParse(row.subscription_json, null)
    if (!subscription) {
      permanentFailures += 1
      await markSubscriptionError(row, {
        statusCode: 410,
        message: 'Suscripción web push corrupta'
      })
      return
    }

    try {
      await webPushSendNotification(subscription, JSON.stringify(payload), {
        timeout: nativePushProviderTimeoutMs
      })
      sent += 1
    } catch (error) {
      if (isPermanentWebPushError(error)) permanentFailures += 1
      else {
        retryableFailures += 1
        retrySubscriptionIds.push(String(row.id))
      }
      logger.warn(`[Push] No se pudo enviar notificación a ${row.id}: ${error.message}`)
      await markSubscriptionError(row, error)
    }
  }))

  return {
    sent,
    attempted: rows.length,
    retryableFailures,
    permanentFailures,
    acceptedSkips: 0,
    retryTargets: {
      webSubscriptionIds: [...new Set(retrySubscriptionIds.filter(Boolean))],
      mobileDeviceIds: []
    }
  }
}

export function buildFcmMessageBody(row, payload = {}, experience = {}) {
  const notificationTitle = getNotificationTitle(payload)
  const notificationBody = getNotificationBody(payload)
  const channelId = getAndroidChannelId(experience)
  const collapseId = getNotificationCollapseId(payload) || getNotificationThreadId(payload)
  const useHeadlessBackgroundPush = shouldUseExpoHeadlessBackgroundPush(row, payload)
  const notificationData = getNotificationData(payload)
  if (useHeadlessBackgroundPush) {
    // expo-notifications auto-presenta un data-only que contenga las llaves
    // reservadas `title`/`message`. Usa nombres privados para que sólo nuestro
    // task publique la alerta después de preparar el caché.
    delete notificationData.title
    delete notificationData.body
  }
  const data = {
    ...notificationData,
    ...(useHeadlessBackgroundPush
      ? {
          ristakRelayTitle: notificationTitle,
          ristakRelayBody: notificationBody
        }
      : {
          title: notificationTitle,
          body: notificationBody
        }),
    channelId,
    androidChannelId: channelId,
    soundEnabled: String(experience.soundEnabled !== false),
    vibrationEnabled: String(experience.vibrationEnabled !== false)
  }

  const message = {
    token: row.token,
    data,
    android: {
      priority: 'HIGH',
      collapse_key: collapseId
    }
  }

  // Las versiones Expo anteriores necesitan `notification` para que Android pinte
  // la alerta. La app que anuncia `expo_background_v1` registra un headless task:
  // debe recibir data-only para precargar el chat y publicar una sola alerta local.
  if (isExpoAndroidPushDevice(row) && !useHeadlessBackgroundPush) {
    message.notification = {
      title: notificationTitle,
      body: notificationBody
    }
    message.android.notification = {
      channel_id: channelId,
      tag: collapseId,
      notification_priority: 'PRIORITY_HIGH'
    }
  }

  return {
    message: {
      ...message
    }
  }
}

export function buildApnsMessageBody(payload = {}, experience = {}) {
  const aps = {
    alert: {
      title: getNotificationTitle(payload),
      body: getNotificationBody(payload)
    },
    'thread-id': getNotificationThreadId(payload),
    category: getApnsCategory(payload)
  }
  if (shouldUseNotificationServiceExtension(payload)) {
    aps['mutable-content'] = 1
  }
  if (getNotificationCategory(payload).toLowerCase() === 'chat') {
    // La alerta sigue siendo visible, pero iOS también concede una ventana corta
    // de ejecución para dejar inbox/hilo listos antes de que el usuario abra.
    aps['content-available'] = 1
  }
  if (experience.soundEnabled) {
    aps.sound = 'default'
  }
  if (Number.isFinite(Number(payload.badge))) {
    aps.badge = Math.max(0, Number(payload.badge))
  }

  return {
    aps,
    ...getNotificationData(payload)
  }
}

async function sendFcmNotification(row, payload = {}, experience = {}) {
  if (!fcmConfigured) {
    throw new Error('Faltan credenciales FCM para notificaciones Android')
  }

  const accessToken = await getFcmAccessToken()
  const { response, data } = await fetchPushProviderJson(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(FCM_PROJECT_ID)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildFcmMessageBody(row, payload, experience))
    }
  )

  if (!response.ok) {
    const error = new Error(data?.error?.message || `FCM respondió ${response.status}`)
    error.statusCode = response.status
    error.code = data?.error?.details?.find?.(detail => detail?.errorCode)?.errorCode || data?.error?.status || ''
    throw error
  }
}

async function sendApnsNotification(row, payload = {}, experience = {}) {
  if (!apnsConfigured) {
    throw new Error('Faltan credenciales APNs para notificaciones iPhone')
  }

  const host = APNS_ENV === 'development' || APNS_ENV === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com'
  const authToken = await getApnsJwt()
  const client = http2.connect(`https://${host}`)
  const requestBody = JSON.stringify(buildApnsMessageBody(payload, experience))

  return new Promise((resolve, reject) => {
    let statusCode = 0
    let responseText = ''
    let settled = false
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${row.token}`,
      authorization: `bearer ${authToken}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      ...(getNotificationCollapseId(payload) ? { 'apns-collapse-id': getNotificationCollapseId(payload) } : {}),
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(requestBody)
    })

    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        client.destroy()
        reject(error)
        return
      }
      client.close()
      resolve()
    }
    const timeout = setTimeout(() => {
      const error = new Error(`APNs excedió ${nativePushProviderTimeoutMs} ms`)
      error.code = 'push_provider_timeout'
      request.close()
      finish(error)
    }, nativePushProviderTimeoutMs)

    request.setEncoding('utf8')
    request.on('response', (headers) => {
      statusCode = Number(headers[':status'] || 0)
    })
    request.on('data', (chunk) => {
      responseText += chunk
    })
    request.on('error', (error) => {
      finish(error)
    })
    request.on('end', () => {
      if (statusCode >= 200 && statusCode < 300) {
        finish()
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
      finish(error)
    })
    client.on('error', finish)

    request.end(requestBody)
  })
}

// (MOB-006) experience puede ser un objeto fijo (global) o una función resolver
// async(userId)->experience para calcular sonido/vibración por dueño del device.
async function resolveExperienceForRow(experience, row) {
  if (typeof experience === 'function') {
    return experience(row.user_id)
  }
  return experience
}

function shouldDisableMobileDeviceFromCentralResult(result = {}) {
  return isPermanentMobilePushError(result)
}

function isRetryableCentralMobilePushSkip(result = {}) {
  const reason = String(result?.reason || result?.error || result?.code || '')
    .trim()
    .toLowerCase()
  return reason === 'apns_not_configured' ||
    reason === 'fcm_not_configured' ||
    reason === 'mobile_push_not_configured'
}

async function markCentralMobileDeviceResults(rowsById, results = []) {
  const seenIds = new Set()
  const uniqueResults = results.filter(result => {
    const id = String(result?.id || '').trim()
    if (!id || seenIds.has(id)) return false
    seenIds.add(id)
    return true
  })
  await Promise.all(uniqueResults.map(async (result) => {
    if (result?.success || result?.skipped) return
    const row = rowsById.get(String(result?.id || '').trim())
    if (!row) return
    await db.run(
      `UPDATE mobile_push_devices
       SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        shouldDisableMobileDeviceFromCentralResult(result) ? 0 : 1,
        result?.error || result?.reason || 'Error enviando notificacion al celular',
        row.id
      ]
    ).catch(() => {})
  }))
}

async function sendMobileNotificationRows(rows = [], payload = {}, experience = {}, transport = {}) {
  let sent = 0
  let attempted = 0
  let retryableFailures = 0
  let permanentFailures = 0
  let acceptedSkips = 0
  const retryMobileDeviceIds = []
  const centralDevices = []
  const centralRowsById = new Map()

  const shouldSendThroughCentral = (platform) => {
    if (platform === 'ios') return !apnsConfigured && transport?.central?.iosConfigured === true
    if (platform === 'android') return !fcmConfigured && transport?.central?.androidConfigured === true
    return false
  }

  await Promise.all(rows.map(async (row) => {
    const platform = normalizePlatform(row.platform)
    const rowExperience = await resolveExperienceForRow(experience, row) // (MOB-006) por usuario

    if (shouldSendThroughCentral(platform)) {
      const centralDevice = {
        id: row.id,
        platform,
        token: row.token,
        experience: rowExperience
      }
      if (row.client_type) centralDevice.clientType = row.client_type
      if (row.app_package) centralDevice.appPackage = row.app_package
      centralDevices.push(centralDevice)
      centralRowsById.set(String(row.id || '').trim(), row)
      return
    }

    if (platform === 'android' && !fcmConfigured) {
      if (transport?.central?.transientFailure === true) {
        attempted += 1
        retryableFailures += 1
        retryMobileDeviceIds.push(String(row.id))
      }
      return
    }
    if (platform === 'ios' && !apnsConfigured) {
      if (transport?.central?.transientFailure === true) {
        attempted += 1
        retryableFailures += 1
        retryMobileDeviceIds.push(String(row.id))
      }
      return
    }

    try {
      if (platform === 'android') {
        attempted += 1
        await sendFcmNotification(row, payload, rowExperience)
      } else if (platform === 'ios') {
        attempted += 1
        await sendApnsNotification(row, payload, rowExperience)
      } else {
        return
      }
      sent += 1
    } catch (error) {
      if (isPermanentMobilePushError(error)) permanentFailures += 1
      else {
        retryableFailures += 1
        retryMobileDeviceIds.push(String(row.id))
      }
      logger.warn(`[Push] No se pudo enviar notificación nativa a ${row.id}: ${error.message}`)
      await markMobileDeviceError(row, error)
    }
  }))

  if (centralDevices.length > 0) {
    attempted += centralDevices.length
    try {
      const result = await sendCentralMobilePushNotifications({ devices: centralDevices, payload })
      const centralSent = Math.min(centralDevices.length, Math.max(0, Number(result?.sent || 0)))
      sent += centralSent
      const centralResults = Array.isArray(result?.results) ? result.results : []
      await markCentralMobileDeviceResults(centralRowsById, centralResults)
      if (centralResults.length) {
        const seenIds = new Set()
        for (const centralResult of centralResults) {
          const id = String(centralResult?.id || '').trim()
          if (!id || !centralRowsById.has(id) || seenIds.has(id)) continue
          seenIds.add(id)
          if (centralResult?.success) {
            continue
          }
          if (centralResult?.skipped) {
            if (isRetryableCentralMobilePushSkip(centralResult)) {
              retryableFailures += 1
              retryMobileDeviceIds.push(id)
            } else {
              acceptedSkips += 1
            }
            continue
          }
          if (isPermanentMobilePushError(centralResult)) permanentFailures += 1
          else {
            retryableFailures += 1
            retryMobileDeviceIds.push(id)
          }
        }
        for (const device of centralDevices) {
          const id = String(device.id || '').trim()
          if (seenIds.has(id)) continue
          // Un total agregado no identifica qué target fue aceptado. Reintentar los
          // IDs omitidos conserva at-least-once sin volver a tocar éxitos conocidos.
          retryableFailures += 1
          retryMobileDeviceIds.push(id)
        }
      } else if (centralSent < centralDevices.length) {
        // Sin resultados por target, un parcial es ambiguo: se reintentan todos.
        retryableFailures += centralDevices.length
        retryMobileDeviceIds.push(...centralDevices.map(device => String(device.id)))
      }
    } catch (error) {
      retryableFailures += centralDevices.length
      retryMobileDeviceIds.push(...centralDevices.map(device => String(device.id)))
      logger.warn(`[Push] No se pudo enviar notificacion nativa por Installer central: ${error.message}`)
      await Promise.all(Array.from(centralRowsById.values()).map((row) => markMobileDeviceError(row, error)))
    }
  }

  return {
    sent,
    attempted,
    retryableFailures,
    permanentFailures,
    acceptedSkips,
    retryTargets: {
      webSubscriptionIds: [],
      mobileDeviceIds: [...new Set(retryMobileDeviceIds.filter(Boolean))]
    }
  }
}

// (MOB-006) Filtra filas (web + nativas) por la preferencia del USUARIO destinatario:
// (a) on/off del evento (enabledKey) y (b) override de calendarios cuando aplica.
// Mantiene las filas sin user_id (no se puede resolver -> se respeta el comportamiento
// previo, que ya las dejaba pasar tras el filtro por matrix/calendario).
async function filterRowsByUserPreference(rows, { enabledKey = '', calendarId = '' } = {}) {
  if (!enabledKey && !calendarId) return rows
  const results = await Promise.all(rows.map(async (row) => {
    const userId = String(row.user_id || '').trim()
    if (!userId) {
      // (MOB-006) Una suscripción sin user_id no tiene preferencia por-usuario, pero debe
      // seguir respetando el apagado GLOBAL (preserva el kill-switch previo): si la clave
      // on/off del evento está en false a nivel global, no se envía.
      if (enabledKey && !(await getBooleanPushConfig(enabledKey, true))) return null
      return row
    }
    if (enabledKey && !(await isEventEnabledForUser(userId, enabledKey))) return null
    if (calendarId && !(await isCalendarAllowedForUser(userId, calendarId))) return null
    return row
  }))
  return results.filter(Boolean)
}

// (MOB-006) enabledKey: clave on/off del evento para resolver la preferencia POR
// usuario destinatario (con fallback al global). Si se omite, no se filtra por usuario.
export async function sendAppNotificationPayload(payload = {}, {
  calendarId = '',
  userIds = null,
  enabledKey = '',
  excludeUserIds = null,
  deliveryTargets = null,
  durableDelivery = false
} = {}) {
  const normalizedPayload = await enrichNotificationPayloadForDelivery(payload)
  if (appNotificationPayloadSenderForTest) {
    return appNotificationPayloadSenderForTest(normalizedPayload, {
      calendarId,
      userIds,
      enabledKey,
      excludeUserIds,
      deliveryTargets,
      durableDelivery
    })
  }

  const transport = await getEffectivePushTransportStatus()
  const probeUnknownCentralTargets = durableDelivery === true && transport?.central?.transientFailure === true
  if (!pushConfigured && !transport.nativeConfigured && !probeUnknownCentralTargets) {
    return {
      sent: 0,
      webSent: 0,
      nativeSent: 0,
      skipped: true,
      reason: 'not_configured',
      retryTargets: { webSubscriptionIds: [], mobileDeviceIds: [] }
    }
  }

  const filterByUser = Array.isArray(userIds)
  const normalizedUserIds = filterByUser ? normalizeUserIds(userIds) : null
  if (filterByUser && normalizedUserIds.length === 0) {
    return {
      sent: 0,
      webSent: 0,
      nativeSent: 0,
      skipped: true,
      reason: 'missing_recipients',
      retryTargets: { webSubscriptionIds: [], mobileDeviceIds: [] }
    }
  }

  const [webRows, nativeRows] = await Promise.all([
    pushConfigured
      ? (calendarId ? getSubscriptionsForCalendar(calendarId) : getEnabledSubscriptions(normalizedUserIds))
      : Promise.resolve([]),
    (transport.nativeConfigured || probeUnknownCentralTargets)
      ? (calendarId ? getMobileDevicesForCalendar(calendarId) : getEnabledMobileDevices(normalizedUserIds))
      : Promise.resolve([])
  ])

  // (Presencia) Excluir dispositivos de usuarios que YA están viendo el chat.
  // Corre DESPUÉS del filtro de matriz, así que resta correctamente incluso
  // cuando userIds === null ("todos"). Filas sin user_id se conservan (no pueden
  // ser "el que está viendo"). Fail-open: sin exclusiones, no cambia nada.
  const excludeSet = Array.isArray(excludeUserIds) && excludeUserIds.length
    ? new Set(excludeUserIds.map((id) => String(id ?? '').trim()).filter(Boolean))
    : null
  const applyExclude = (rows) => (excludeSet
    ? rows.filter((row) => {
        const rowUserId = String(row.user_id || '').trim()
        return !rowUserId || !excludeSet.has(rowUserId)
    })
    : rows)

  const normalizedDeliveryTargets = deliveryTargets && typeof deliveryTargets === 'object'
    ? normalizeDeliveryTargets(deliveryTargets)
    : null
  const webTargetSet = normalizedDeliveryTargets
    ? new Set(normalizedDeliveryTargets.webSubscriptionIds)
    : null
  const mobileTargetSet = normalizedDeliveryTargets
    ? new Set(normalizedDeliveryTargets.mobileDeviceIds)
    : null
  const filterWebTargets = rows => webTargetSet
    ? rows.filter(row => webTargetSet.has(String(row.id || '').trim()))
    : rows
  const filterMobileTargets = rows => mobileTargetSet
    ? rows.filter(row => mobileTargetSet.has(String(row.id || '').trim()))
    : rows

  const matrixWebRows = filterWebTargets(applyExclude(filterByUser
    ? webRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : webRows))
  const matrixNativeRows = filterMobileTargets(applyExclude(filterByUser
    ? nativeRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : nativeRows))

  // (MOB-006) Tercer eje: override por-usuario de las 7 claves. La entrega final llega a
  // un device del user U solo si (matrix permite a U) AND (preferencia de U on/off true,
  // con fallback global) AND (calendario permitido para U). Sin override => hereda global
  // => idéntico al comportamiento previo (no se silencia a nadie que ya recibía).
  const [filteredWebRows, filteredNativeRows] = await Promise.all([
    filterRowsByUserPreference(matrixWebRows, { enabledKey, calendarId }),
    filterRowsByUserPreference(matrixNativeRows, { enabledKey, calendarId })
  ])

  if (filteredWebRows.length === 0 && filteredNativeRows.length === 0) {
    return {
      sent: 0,
      webSent: 0,
      nativeSent: 0,
      skipped: true,
      reason: 'no_subscriptions',
      retryTargets: { webSubscriptionIds: [], mobileDeviceIds: [] }
    }
  }

  // (MOB-006) Sonido/vibración por dueño del device (resolver cacheado por user_id).
  const experienceResolver = createUserExperienceResolver()

  const emptyDelivery = {
    sent: 0,
    attempted: 0,
    retryableFailures: 0,
    permanentFailures: 0,
    acceptedSkips: 0,
    retryTargets: { webSubscriptionIds: [], mobileDeviceIds: [] }
  }
  const [webDelivery, nativeDelivery] = await Promise.all([
    pushConfigured ? sendNotificationRows(filteredWebRows, normalizedPayload) : Promise.resolve(emptyDelivery),
    (transport.nativeConfigured || probeUnknownCentralTargets)
      ? sendMobileNotificationRows(filteredNativeRows, normalizedPayload, experienceResolver, transport)
      : Promise.resolve(emptyDelivery)
  ])

  return {
    sent: webDelivery.sent + nativeDelivery.sent,
    webSent: webDelivery.sent,
    nativeSent: nativeDelivery.sent,
    attempted: webDelivery.attempted + nativeDelivery.attempted,
    retryableFailures: webDelivery.retryableFailures + nativeDelivery.retryableFailures,
    permanentFailures: webDelivery.permanentFailures + nativeDelivery.permanentFailures,
    acceptedSkips: webDelivery.acceptedSkips + nativeDelivery.acceptedSkips,
    retryTargets: {
      webSubscriptionIds: [...new Set(webDelivery.retryTargets?.webSubscriptionIds || [])],
      mobileDeviceIds: [...new Set(nativeDelivery.retryTargets?.mobileDeviceIds || [])]
    },
    skipped: false
  }
}

export async function sendCalendarAppointmentNotification(appointment = {}, options = {}) {
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  if (!calendarId) return { sent: 0, skipped: true, reason: 'missing_calendar' }

  // (MOB-006) El on/off de calendario ahora se resuelve POR usuario destinatario en el
  // dispatcher (enabledKey), con fallback al global. Aquí solo se aplica el filtro GLOBAL
  // de calendarios (mismo comportamiento que antes); el override por-usuario de
  // calendar_ids se aplica adicionalmente por fila vía el calendarId que pasamos abajo.
  const config = await getGlobalCalendarPushConfig()
  if (config.calendarIds.length > 0 && !config.calendarIds.includes(calendarId)) {
    return { sent: 0, skipped: true, reason: 'calendar_filtered' }
  }
  const preferenceTarget = await getPushPreferenceTarget('appointment_booked')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contactName = await getAppointmentContactName(appointment, options)
  const timezone = await resolveAppointmentNotificationTimezone(appointment, options)
  const eventType = normalizeAppointmentEventType(options.eventType || 'booked')
  const eventKey = getAppointmentEventKey(eventType)
  const isTest = Boolean(options.isTest ?? appointment.isTest ?? appointment.is_test)
  const baseTitle = getAppointmentNotificationTitle(eventType)
  const payload = {
    title: isTest ? `Prueba · ${baseTitle}` : baseTitle,
    body: getAppointmentNotificationBody(appointment, options, { contactName, timezone }),
    tag: `calendar-${calendarId}`,
    threadId: `calendar-${calendarId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointment.id || '')}`,
    category: eventKey,
    eventKey,
    contactName,
    contactId: appointment.contactId || appointment.contact_id || '',
    isTest,
    testRunId: options.testRunId || appointment.testRunId || appointment.test_run_id || '',
    testEffectId: options.testEffectId || appointment.testEffectId || appointment.test_effect_id || '',
    testExpiresAt: options.testExpiresAt || appointment.testExpiresAt || appointment.test_expires_at || ''
  }

  // (MOB-006) enabledKey + calendarId => on/off y calendarios por usuario destinatario.
  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    calendarId,
    enabledKey: 'calendar_push_notifications_enabled'
  }))
}

export async function sendAppointmentStatusNotification(appointment = {}, options = {}) {
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  const eventType = normalizeAppointmentEventType(options.eventType || options.status || appointment.appointmentStatus || appointment.appointment_status || appointment.status || 'booked')
  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  if (!calendarId) return { sent: 0, skipped: true, reason: 'missing_calendar' }

  const config = await getGlobalCalendarPushConfig()
  if (config.calendarIds.length > 0 && !config.calendarIds.includes(calendarId)) {
    return { sent: 0, skipped: true, reason: 'calendar_filtered' }
  }

  const preferenceEvent = eventType === 'confirmed' ? 'appointment_confirmed' : 'appointment_booked'
  const enabledKey = eventType === 'confirmed'
    ? 'appointment_confirmation_push_notifications_enabled'
    : 'calendar_push_notifications_enabled'
  const preferenceTarget = await getPushPreferenceTarget(preferenceEvent)
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contactName = await getAppointmentContactName(appointment, options)
  const timezone = await resolveAppointmentNotificationTimezone(appointment, options)
  const eventKey = getAppointmentEventKey(eventType)
  const appointmentId = String(options.appointmentId || appointment.id || '').trim()
  const payload = {
    title: getAppointmentNotificationTitle(eventType),
    body: getAppointmentNotificationBody(appointment, options, {
      contactName,
      detail: options.resultDetail || options.detail || '',
      timezone
    }),
    tag: `appointment-${eventType}-${appointmentId || calendarId}`,
    threadId: `calendar-${calendarId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`,
    category: eventKey,
    eventKey,
    contactName,
    contactId: appointment.contactId || appointment.contact_id || options.contactId || ''
  }

  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    calendarId,
    enabledKey
  }))
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
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  // (MOB-006) El on/off ahora se resuelve POR usuario destinatario en el dispatcher
  // (enabledKey, fallback al global), no como kill-switch global aquí.
  const appointmentId = String(options.appointmentId || appointment.id || '').trim()
  if (!appointmentId) return { sent: 0, skipped: true, reason: 'missing_appointment' }

  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  const preferenceTarget = await getPushPreferenceTarget('appointment_confirmed')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const contactName = await getAppointmentContactName(appointment, options)
  const timezone = await resolveAppointmentNotificationTimezone(appointment, options)
  const payload = {
    title: getAppointmentNotificationTitle('confirmed'),
    body: getAppointmentNotificationBody(appointment, options, {
      contactName,
      detail: options.resultDetail || '',
      timezone
    }),
    tag: `appointment-confirmed-${appointmentId}`,
    threadId: calendarId ? `calendar-${calendarId}` : `appointment-${appointmentId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`,
    category: 'appointment_confirmed',
    eventKey: 'appointment_confirmed',
    contactName,
    contactId: appointment.contactId || appointment.contact_id || options.contactId || ''
  }

  // (MOB-006) enabledKey => on/off por usuario destinatario (fallback global).
  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    calendarId,
    enabledKey: 'appointment_confirmation_push_notifications_enabled'
  }))
}

export async function sendChatMessageNotification(message = {}) {
  const durableDelivery = message.durableDelivery === true
  const initialTransport = await getEffectivePushTransportStatus()
  const canProbeUnknownCentral = durableDelivery && initialTransport?.central?.transientFailure === true
  if (!initialTransport.webConfigured && !initialTransport.nativeConfigured && !canProbeUnknownCentral) {
    return {
      sent: 0,
      skipped: true,
      reason: 'not_configured',
      retryTargets: { webSubscriptionIds: [], mobileDeviceIds: [] }
    }
  }

  // (MOB-006) El on/off de chat se resuelve POR usuario destinatario en el dispatcher.
  const suppressByAgent = await shouldSuppressChatNotificationForConversationalAgent(message.contactId).catch((error) => {
    logger.warn(`[Push] No se pudo revisar silencio del agente conversacional: ${error.message}`)
    return false
  })
  if (suppressByAgent) {
    return { sent: 0, skipped: true, reason: 'conversational_agent_attending' }
  }
  // (MOB-002 / NOTI-004) No exponer nombre ni texto de contactos ocultos en el push de chat
  const visibilityChecker = contactVisibilityCheckerForTest || isContactHiddenFromNotifications
  const hidden = await visibilityChecker(message.contactId, { throwOnError: durableDelivery }).catch((error) => {
    logger.warn(`[Push] No se pudo verificar contacto oculto para chat: ${error.message}`)
    if (durableDelivery) {
      const retryableError = error instanceof Error ? error : new Error(String(error || 'Error de visibilidad'))
      retryableError.code = retryableError.code || 'push_contact_visibility_unavailable'
      retryableError.retryable = true
      throw retryableError
    }
    return true // fail-safe: ante error no enviamos para evitar fuga
  })
  if (hidden) {
    return { sent: 0, skipped: true, reason: 'hidden_contact' }
  }
  const chatContactId = String(message.contactId || '').trim()

  // (Asignación) El usuario asignado al contacto siempre entra al set de
  // destinatarios (sumado a la config de "quién recibe chat"), respetando su
  // propia preferencia on/off y la supresión por presencia.
  let assignedUserId = ''
  if (chatContactId) {
    try {
      const assignedRow = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [chatContactId])
      assignedUserId = String(assignedRow?.assigned_user_id || '').trim()
    } catch (error) {
      logger.warn(`[Push] No se pudo leer el usuario asignado del contacto: ${error.message}`)
    }
  }

  const preferenceTarget = await getPushPreferenceTarget('conversations')
  // Config "nadie" apaga el chat para todos... salvo que el contacto tenga un
  // asignado: a ese responsable sí se le notifica (la asignación enruta al dueño).
  if (isPushPreferenceDisabled(preferenceTarget) && !assignedUserId) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  // (Presencia) Usuarios que tienen ESTE chat abierto y al frente ahora mismo.
  // A ellos NO se les manda push (lo están viendo) y se les marca leído — como en
  // un chat real. Fail-open: ante cualquier error de presencia, no se excluye a
  // nadie (mejor una push de más que perder una legítima).
  let viewingUserIds = []
  if (chatContactId) {
    try {
      viewingUserIds = getViewingUserIds(chatContactId)
    } catch (error) {
      logger.warn(`[Push] No se pudo leer presencia de chat: ${error.message}`)
      viewingUserIds = []
    }
    if (viewingUserIds.length) {
      await Promise.all(viewingUserIds.map((userId) =>
        markChatContactReadForUser({ userId, contactId: chatContactId }).catch((error) => {
          logger.warn(`[Push] No se pudo marcar leído por presencia (${userId}): ${error.message}`)
        })
      ))
    }
  }

  const senderName = getChatSenderName(message)
  const bodyText = getChatMessageBody(message)
  const mediaAttachmentUrl = getChatNotificationMediaUrl(message)
  const messageKey = cleanNotificationText(message.messageId || message.timestamp || `${senderName}-${bodyText}-${Date.now()}`)
  const payload = {
    title: senderName,
    body: bodyText,
    tag: `chat-${messageKey}`,
    threadId: message.contactId ? `chat-${message.contactId}` : `chat-${senderName}`,
    messageId: messageKey,
    contactName: senderName,
    contactId: message.contactId || '',
    url: `/movil?contact=${encodeURIComponent(message.contactId || '')}`,
    category: 'chat',
    ...(mediaAttachmentUrl ? {
      notificationImageUrl: mediaAttachmentUrl,
      notificationAttachmentUrl: mediaAttachmentUrl
    } : {})
  }

  // (MOB-006) enabledKey => on/off de chat por usuario destinatario (fallback global).
  // (Asignación) sumamos el asignado a los destinatarios; (Presencia) restamos a
  // quien está viendo el chat ahora.
  const baseOptions = getPushPreferenceOptions(preferenceTarget, {
    enabledKey: 'chat_push_notifications_enabled'
  })
  let recipientUserIds = Object.prototype.hasOwnProperty.call(baseOptions, 'userIds')
    ? baseOptions.userIds
    : null
  if (assignedUserId && Array.isArray(recipientUserIds)) {
    // userIds === null ("todos") ya incluye al asignado; solo hace falta sumarlo
    // cuando la config es una lista concreta (o "nadie" con asignado => solo él).
    if (!recipientUserIds.map(String).includes(assignedUserId)) {
      recipientUserIds = [...recipientUserIds, assignedUserId]
    }
  }

  return sendAppNotificationPayload(payload, {
    ...baseOptions,
    userIds: recipientUserIds,
    excludeUserIds: viewingUserIds,
    deliveryTargets: message.deliveryTargets && typeof message.deliveryTargets === 'object'
      ? message.deliveryTargets
      : null,
    durableDelivery
  })
}

export async function sendConversationalAgentPriorityNotification(signal = {}) {
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  // (MOB-006) El on/off de chat se resuelve POR usuario destinatario en el dispatcher.
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
    contactName: senderName,
    contactId,
    url: `/movil?contact=${encodeURIComponent(contactId)}`,
    category: 'agent_priority',
    eventKey: 'agent_priority'
  }

  // (MOB-006) Comparte el on/off de chat (chat_push_notifications_enabled) por usuario.
  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    enabledKey: 'chat_push_notifications_enabled'
  }))
}

export function buildPaymentNotificationPayload(payment = {}) {
  const amountLabel = formatPaymentAmount(payment.amount, payment.currency)
  return {
    title: getPaymentNotificationTitle(payment),
    body: getPaymentNotificationBody(payment) || amountLabel || 'Revisa el detalle del pago.',
    tag: `payment-${payment.id || payment.contactId || 'ristak'}`,
    threadId: payment.contactId || payment.contact_id ? `payment-${payment.contactId || payment.contact_id}` : 'payments',
    url: '/movil/transactions',
    category: 'payment',
    eventKey: 'payments',
    contactName: getPaymentContactLabel(payment),
    contactId: payment.contactId || payment.contact_id || ''
  }
}

export async function sendPaymentNotification(payment = {}) {
  publishPaymentChangedEvent(payment)

  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  // (MOB-006) El on/off de pagos se resuelve POR usuario destinatario en el dispatcher.
  const preferenceTarget = await getPushPreferenceTarget('payments')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const explicitCurrency = cleanNotificationText(
    payment.currency ||
    payment.currencyCode ||
    payment.currency_code ||
    ''
  ).toUpperCase()
  const currency = explicitCurrency || await getAccountCurrency()
  const payload = buildPaymentNotificationPayload({ ...payment, currency })

  // (MOB-006) enabledKey => on/off de pagos por usuario destinatario (fallback global).
  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    enabledKey: 'payment_push_notifications_enabled'
  }))
}
