import crypto from 'crypto'
import fs from 'fs/promises'
import http2 from 'http2'
import webPush from 'web-push'
import { db, getAppConfig, setAppConfig, getUserAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  getCentralMobilePushStatus,
  isLicenseEnforced,
  sendCentralMobilePushNotifications
} from './licenseService.js'
import { shouldSuppressChatNotificationForConversationalAgent } from './conversationalAgentService.js'
// (MOB-002 / NOTI-004) Importamos el chequeo de contactos ocultos para no exponerlos en el push
import { resolvePushNotificationTargetForEvent, isContactHiddenFromNotifications } from './notificationPreferencesService.js'
// (Presencia) No notificar a quien ya tiene el chat abierto; marcarle leído.
import { getViewingUserIds } from './presenceService.js'
import { markChatContactReadForUser } from './chatReadStateService.js'

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
const FALLBACK_MOBILE_NOTIFICATION_ICON = 'ic_stat_ristak'
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
const CENTRAL_MOBILE_PUSH_STATUS_TTL_MS = 60_000
let fcmAccessTokenCache = { token: '', expiresAt: 0 }
let apnsJwtCache = { token: '', expiresAt: 0 }
let centralMobilePushStatusCache = { status: null, expiresAt: 0 }
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
  ['Pago recibido', '💸'],
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
  paid: 'Pago recibido',
  succeeded: 'Pago recibido',
  completed: 'Pago recibido',
  complete: 'Pago recibido',
  fulfilled: 'Pago recibido',
  success: 'Pago recibido',
  captured: 'Pago recibido',
  approved: 'Pago recibido',
  accredited: 'Pago recibido',
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
  booked: 'Cita agendada',
  scheduled: 'Cita agendada',
  created: 'Cita agendada',
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
  logger.warn('[Push] Push nativo local sin FCM/APNs; iPhone puede enviarse por Installer central si APNs esta configurado alla.')
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function emptyCentralMobilePushStatus(reason = '') {
  return {
    configured: false,
    nativeConfigured: false,
    iosConfigured: false,
    androidConfigured: false,
    reason
  }
}

async function getCentralMobilePushStatusCached({ force = false } = {}) {
  if (!isLicenseEnforced()) return emptyCentralMobilePushStatus('standalone')

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
      android: status?.android || null
    }
    centralMobilePushStatusCache = {
      status: normalized,
      expiresAt: Date.now() + CENTRAL_MOBILE_PUSH_STATUS_TTL_MS
    }
    return normalized
  } catch (error) {
    const status = emptyCentralMobilePushStatus('central_unavailable')
    centralMobilePushStatusCache = {
      status,
      expiresAt: Date.now() + Math.min(10_000, CENTRAL_MOBILE_PUSH_STATUS_TTL_MS)
    }
    logger.warn(`[Push] No se pudo leer push movil central: ${error.message}`)
    return status
  }
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
  const imageUrl = getNotificationImageUrl(payload)
  const contactName = getNotificationContactName(payload)
  return Object.fromEntries(
    Object.entries({
      url: payload.url || '/movil',
      category: payload.category || 'ristak',
      tag: payload.tag || 'ristak',
      threadId: payload.threadId || payload.tag || payload.category || 'ristak',
      eventKey: payload.eventKey || '',
      messageId: payload.messageId || '',
      contactId: payload.contactId || '',
      contactName,
      contactAvatarUrl: imageUrl,
      notificationImageUrl: imageUrl
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

function getNotificationImageUrl(payload = {}) {
  return cleanPublicImageUrl(
    payload.contactAvatarUrl ||
    payload.notificationImageUrl ||
    ''
  )
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
  return cleanPublicImageUrl(
    payload.contactAvatarUrl ||
    payload.notificationImageUrl ||
    payload.imageUrl ||
    payload.profilePictureUrl ||
    payload.profile_picture_url ||
    payload.avatarUrl ||
    payload.avatar_url ||
    payload.photoUrl ||
    payload.photo_url ||
    payload.pictureUrl ||
    payload.picture_url ||
    ''
  )
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

async function enrichNotificationPayloadForDelivery(payload = {}) {
  const normalized = normalizeNotificationPayload(payload)
  const contactIds = normalizePayloadContactIds(normalized)
  if (contactIds.length !== 1) return normalized

  const directImageUrl = getPayloadContactImageCandidateUrl(normalized)
  if (directImageUrl) {
    return {
      ...normalized,
      contactId: normalized.contactId || contactIds[0],
      contactAvatarUrl: directImageUrl,
      notificationImageUrl: directImageUrl
    }
  }

  const contactAvatarUrl = await getContactNotificationAvatarUrl(contactIds[0])
  if (!contactAvatarUrl) return normalized

  return {
    ...normalized,
    contactId: normalized.contactId || contactIds[0],
    contactAvatarUrl,
    notificationImageUrl: contactAvatarUrl
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
  if (amount === undefined || amount === null || amount === '') return ''
  const value = Number(amount)
  if (!Number.isFinite(value)) return ''

  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: String(currency || 'MXN').toUpperCase(),
      maximumFractionDigits: 2
    }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
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

function getPaymentConceptLabel(payment = {}) {
  const concept = cleanNotificationText(
    payment.title ||
    payment.description ||
    payment.concept ||
    payment.productName ||
    payment.product_name ||
    payment.name ||
    ''
  )
  if (!concept || /^pago(?:\s+(?:registrado|recibido|manual|programado))?$/i.test(concept)) return ''
  return concept.slice(0, 90)
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
  const parts = [
    getPaymentContactLabel(payment),
    formatPaymentAmount(payment.amount, payment.currency),
    getPaymentConceptLabel(payment),
    getPaymentDetailLabel(payment)
  ].filter(Boolean)
  return (parts.join(' · ') || 'Revisa el detalle del pago.').slice(0, 220)
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

function getAppointmentNotificationBody(appointment = {}, options = {}, { contactName = '', detail = '' } = {}) {
  const appointmentTitle = cleanNotificationText(
    options.appointmentTitle ||
    appointment.title ||
    appointment.name ||
    ''
  )
  const calendarName = cleanNotificationText(
    options.calendarName ||
    appointment.calendarName ||
    appointment.calendar_name ||
    ''
  )
  const timeLabel = formatAppointmentTime(
    options.startTime ||
    appointment.startTime ||
    appointment.start_time
  )
  const parts = [
    contactName,
    appointmentTitle && !/^nueva cita$/i.test(appointmentTitle) ? appointmentTitle : '',
    timeLabel,
    calendarName,
    cleanNotificationText(detail)
  ].filter(Boolean)
  return (parts.join(' · ') || 'Revisa los detalles de la cita.').slice(0, 220)
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
  const notificationImageUrl = getNotificationImageUrl(payload)
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
          body: notificationBody,
          ...(notificationImageUrl ? { image: notificationImageUrl } : {})
        },
        data: getNotificationData(payload),
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: channelId,
            click_action: 'OPEN_RISTAK',
            icon: FALLBACK_MOBILE_NOTIFICATION_ICON,
            ...(notificationImageUrl ? { image: notificationImageUrl } : {}),
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
  if (getNotificationImageUrl(payload)) {
    aps['mutable-content'] = 1
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

// (MOB-006) experience puede ser un objeto fijo (global) o una función resolver
// async(userId)->experience para calcular sonido/vibración por dueño del device.
async function resolveExperienceForRow(experience, row) {
  if (typeof experience === 'function') {
    return experience(row.user_id)
  }
  return experience
}

function shouldDisableMobileDeviceFromCentralResult(result = {}) {
  const statusCode = Number(result.statusCode || result.status || 0)
  const reason = String(result.reason || result.error || '').toUpperCase()
  return statusCode === 400 ||
    statusCode === 404 ||
    statusCode === 410 ||
    reason.includes('BADDEVICETOKEN') ||
    reason.includes('UNREGISTERED')
}

async function markCentralMobileDeviceResults(rowsById, results = []) {
  await Promise.all(results.map(async (result) => {
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
  const centralDevices = []
  const centralRowsById = new Map()
  const centralIosConfigured = transport?.central?.iosConfigured === true

  await Promise.all(rows.map(async (row) => {
    const platform = normalizePlatform(row.platform)
    const rowExperience = await resolveExperienceForRow(experience, row) // (MOB-006) por usuario

    if (platform === 'ios' && !apnsConfigured && centralIosConfigured) {
      centralDevices.push({
        id: row.id,
        platform: 'ios',
        token: row.token,
        experience: rowExperience
      })
      centralRowsById.set(String(row.id || '').trim(), row)
      return
    }

    if (platform === 'android' && !fcmConfigured) return
    if (platform === 'ios' && !apnsConfigured) return

    try {
      if (platform === 'android') {
        await sendFcmNotification(row, payload, rowExperience)
      } else if (platform === 'ios') {
        await sendApnsNotification(row, payload, rowExperience)
      } else {
        return
      }
      sent += 1
    } catch (error) {
      logger.warn(`[Push] No se pudo enviar notificación nativa a ${row.id}: ${error.message}`)
      await markMobileDeviceError(row, error)
    }
  }))

  if (centralDevices.length > 0) {
    try {
      const result = await sendCentralMobilePushNotifications({ devices: centralDevices, payload })
      sent += Number(result?.sent || 0)
      await markCentralMobileDeviceResults(centralRowsById, Array.isArray(result?.results) ? result.results : [])
    } catch (error) {
      logger.warn(`[Push] No se pudo enviar iOS por Installer central: ${error.message}`)
      await Promise.all(Array.from(centralRowsById.values()).map((row) => markMobileDeviceError(row, error)))
    }
  }

  return sent
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
export async function sendAppNotificationPayload(payload = {}, { calendarId = '', userIds = null, enabledKey = '', excludeUserIds = null } = {}) {
  const normalizedPayload = await enrichNotificationPayloadForDelivery(payload)
  if (appNotificationPayloadSenderForTest) {
    return appNotificationPayloadSenderForTest(normalizedPayload, { calendarId, userIds, enabledKey, excludeUserIds })
  }

  const transport = await getEffectivePushTransportStatus()
  if (!pushConfigured && !transport.nativeConfigured) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'not_configured' }
  }

  const filterByUser = Array.isArray(userIds)
  const normalizedUserIds = filterByUser ? normalizeUserIds(userIds) : null
  if (filterByUser && normalizedUserIds.length === 0) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'missing_recipients' }
  }

  const [webRows, nativeRows] = await Promise.all([
    pushConfigured
      ? (calendarId ? getSubscriptionsForCalendar(calendarId) : getEnabledSubscriptions())
      : Promise.resolve([]),
    transport.nativeConfigured
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

  const matrixWebRows = applyExclude(filterByUser
    ? webRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : webRows)
  const matrixNativeRows = applyExclude(filterByUser
    ? nativeRows.filter((row) => normalizedUserIds.includes(String(row.user_id || '').trim()))
    : nativeRows)

  // (MOB-006) Tercer eje: override por-usuario de las 7 claves. La entrega final llega a
  // un device del user U solo si (matrix permite a U) AND (preferencia de U on/off true,
  // con fallback global) AND (calendario permitido para U). Sin override => hereda global
  // => idéntico al comportamiento previo (no se silencia a nadie que ya recibía).
  const [filteredWebRows, filteredNativeRows] = await Promise.all([
    filterRowsByUserPreference(matrixWebRows, { enabledKey, calendarId }),
    filterRowsByUserPreference(matrixNativeRows, { enabledKey, calendarId })
  ])

  if (filteredWebRows.length === 0 && filteredNativeRows.length === 0) {
    return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'no_subscriptions' }
  }

  // (MOB-006) Sonido/vibración por dueño del device (resolver cacheado por user_id).
  const experienceResolver = createUserExperienceResolver()

  const [webSent, nativeSent] = await Promise.all([
    pushConfigured ? sendNotificationRows(filteredWebRows, normalizedPayload) : Promise.resolve(0),
    transport.nativeConfigured ? sendMobileNotificationRows(filteredNativeRows, normalizedPayload, experienceResolver, transport) : Promise.resolve(0)
  ])

  return {
    sent: webSent + nativeSent,
    webSent,
    nativeSent,
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
  const eventType = normalizeAppointmentEventType(options.eventType || 'booked')
  const eventKey = getAppointmentEventKey(eventType)
  const payload = {
    title: getAppointmentNotificationTitle(eventType),
    body: getAppointmentNotificationBody(appointment, options, { contactName }),
    tag: `calendar-${calendarId}`,
    threadId: `calendar-${calendarId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointment.id || '')}`,
    category: eventKey,
    eventKey,
    contactName,
    contactId: appointment.contactId || appointment.contact_id || ''
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
  const eventKey = getAppointmentEventKey(eventType)
  const appointmentId = String(options.appointmentId || appointment.id || '').trim()
  const payload = {
    title: getAppointmentNotificationTitle(eventType),
    body: getAppointmentNotificationBody(appointment, options, {
      contactName,
      detail: options.resultDetail || options.detail || ''
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
  const payload = {
    title: getAppointmentNotificationTitle('confirmed'),
    body: getAppointmentNotificationBody(appointment, options, {
      contactName,
      detail: options.resultDetail || ''
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
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  // (MOB-006) El on/off de chat se resuelve POR usuario destinatario en el dispatcher.
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
    category: 'chat'
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
    excludeUserIds: viewingUserIds
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
    category: 'chat'
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
  if (!(await hasAnyPushTransport())) return { sent: 0, skipped: true, reason: 'not_configured' }

  // (MOB-006) El on/off de pagos se resuelve POR usuario destinatario en el dispatcher.
  const preferenceTarget = await getPushPreferenceTarget('payments')
  if (isPushPreferenceDisabled(preferenceTarget)) {
    return { sent: 0, skipped: true, reason: 'disabled_by_preferences' }
  }

  const payload = buildPaymentNotificationPayload(payment)

  // (MOB-006) enabledKey => on/off de pagos por usuario destinatario (fallback global).
  return sendAppNotificationPayload(payload, getPushPreferenceOptions(preferenceTarget, {
    enabledKey: 'payment_push_notifications_enabled'
  }))
}
