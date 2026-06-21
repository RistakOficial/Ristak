import crypto from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { getAccountTimezone, normalizeToUtcIso } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import * as localCalendarService from './localCalendarService.js'
import { clearGoogleCalendarIntegrationCredentials } from './integrationCredentialsCleanupService.js'
import {
  claimCentralOAuthHandoff,
  refreshCentralGoogleCalendarToken
} from './licenseService.js'

const CONFIG_KEY = 'google_calendar_service_account_config'
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
const REQUEST_TIMEOUT = 15000
const MANUAL_SYNC_PAST_DAYS = 30
const MANUAL_SYNC_FUTURE_DAYS = 365

let tokenCache = null

function cleanString(value) {
  return String(value ?? '').trim()
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeGoogleEventTimeBound(value, label) {
  const raw = cleanString(value)
  if (!raw) return ''

  const numericValue = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(raw)
    ? Number(value)
    : Number.NaN
  const millis = Number.isFinite(numericValue) && Math.abs(numericValue) < 100000000000
    ? numericValue * 1000
    : numericValue
  const date = Number.isFinite(millis) ? new Date(millis) : new Date(raw)

  if (Number.isNaN(date.getTime())) {
    throw new Error(`El rango de fechas de Google Calendar no es válido (${label}).`)
  }

  return date.toISOString()
}

function normalizeGoogleEventTimeRange({ startTime = '', endTime = '' } = {}) {
  const timeMin = normalizeGoogleEventTimeBound(startTime, 'startTime')
  const timeMax = normalizeGoogleEventTimeBound(endTime, 'endTime')

  if (timeMin && timeMax && new Date(timeMin).getTime() > new Date(timeMax).getTime()) {
    throw new Error('El rango de fechas de Google Calendar no es válido: la fecha inicial es posterior a la final.')
  }

  return { timeMin, timeMax }
}

function normalizePrivateKey(privateKey) {
  return cleanString(privateKey).replace(/\\n/g, '\n')
}

function decodeBase64Url(value) {
  const normalized = cleanString(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8').trim()
}

function normalizeGoogleCalendarIdInput(value) {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const url = new URL(raw)
    const cid = url.searchParams.get('cid')
    if (cid) {
      const decoded = decodeBase64Url(cid)
      if (decoded) return decoded
    }

    const src = url.searchParams.get('src')
    if (src) {
      const decoded = decodeURIComponent(src).trim()
      if (decoded) return decoded
    }
  } catch {
    // No es URL; se usa el valor tal cual como Calendar ID.
  }

  return raw
}

export function normalizeServiceAccountCredentials(input) {
  const credentials = typeof input === 'string' ? parseJson(input) : input
  if (!credentials || typeof credentials !== 'object') {
    throw new Error('Pega el JSON completo del Service Account')
  }

  const clientEmail = cleanString(credentials.client_email).toLowerCase()
  const privateKey = normalizePrivateKey(credentials.private_key)
  const tokenUri = cleanString(credentials.token_uri) || GOOGLE_TOKEN_URI

  if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    throw new Error('El JSON del Service Account no trae client_email válido')
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('El JSON del Service Account no trae private_key válida')
  }

  return {
    type: cleanString(credentials.type) || 'service_account',
    project_id: cleanString(credentials.project_id),
    private_key_id: cleanString(credentials.private_key_id),
    private_key: privateKey,
    client_email: clientEmail,
    client_id: cleanString(credentials.client_id),
    auth_uri: cleanString(credentials.auth_uri),
    token_uri: tokenUri,
    auth_provider_x509_cert_url: cleanString(credentials.auth_provider_x509_cert_url),
    client_x509_cert_url: cleanString(credentials.client_x509_cert_url),
    universe_domain: cleanString(credentials.universe_domain)
  }
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      throw new Error(`Google Calendar no respondió después de ${timeout}ms`)
    }
    throw error
  }
}

async function getStoredConfig() {
  return parseJson(await getAppConfig(CONFIG_KEY), null)
}

async function persistConfig(config) {
  await setAppConfig(CONFIG_KEY, {
    ...config,
    updatedAt: new Date().toISOString()
  })
}

function publicConfig(config = {}) {
  const connectionMode = config.connectionMode === 'oauth' ? 'oauth' : 'service_account'
  const connected = connectionMode === 'oauth'
    ? Boolean(config.refreshTokenEncrypted)
    : Boolean(config.credentialsEncrypted)
  return {
    connectionMode,
    connected,
    calendarId: config.calendarId || '',
    serviceAccountEmail: config.serviceAccountEmail || '',
    projectId: config.projectId || '',
    privateKeyId: config.privateKeyId || '',
    calendarSummary: config.calendarSummary || '',
    calendarTimeZone: config.calendarTimeZone || '',
    lastTestAt: config.lastTestAt || null,
    lastTestStatus: config.lastTestStatus || null,
    lastTestMessage: config.lastTestMessage || '',
    lastSyncAt: config.lastSyncAt || null,
    lastSyncStatus: config.lastSyncStatus || null,
    lastSyncMessage: config.lastSyncMessage || '',
    syncedCalendarsCount: Number(config.syncedCalendarsCount || 0),
    syncedEventsCount: Number(config.syncedEventsCount || 0),
    connectedAt: config.connectedAt || null,
    updatedAt: config.updatedAt || null,
    googleAccountEmail: config.googleAccountEmail || '',
    googleAccountName: config.googleAccountName || '',
    googleAccountPictureUrl: config.googleAccountPictureUrl || '',
    scopes: Array.isArray(config.scopes) ? config.scopes : [],
    canManageEvents: connectionMode === 'oauth' ? (config.scopes || []).includes('https://www.googleapis.com/auth/calendar.events') : connected,
    canListCalendars: connectionMode === 'oauth' ? (config.scopes || []).includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly') : connected
  }
}

export async function getGoogleCalendarConfig({ includeCredentials = false } = {}) {
  const config = await getStoredConfig()
  if (!config) return includeCredentials ? null : publicConfig()

  if (!includeCredentials) {
    return publicConfig(config)
  }

  if (config.connectionMode === 'oauth') {
    if (!config.refreshTokenEncrypted) return null
    try {
      const encryptedValue = config.refreshTokenEncrypted
      const refreshToken = isEncrypted(encryptedValue)
        ? decrypt(encryptedValue)
        : encryptedValue
      return {
        ...config,
        connectionMode: 'oauth',
        refreshToken,
        calendarId: cleanString(config.calendarId)
      }
    } catch (error) {
      logger.warn(`[Google Calendar] No se pudo desencriptar OAuth local: ${error.message}`)
      return null
    }
  }

  if (!config.credentialsEncrypted) {
    return null
  }

  try {
    const encryptedValue = config.credentialsEncrypted
    const credentialsJson = isEncrypted(encryptedValue)
      ? decrypt(encryptedValue)
      : encryptedValue
    const credentials = normalizeServiceAccountCredentials(parseJson(credentialsJson, null))
    return {
      ...config,
      credentials,
      calendarId: cleanString(config.calendarId)
    }
  } catch (error) {
    logger.warn(`[Google Calendar] No se pudo desencriptar la configuración: ${error.message}`)
    return null
  }
}

export async function getGoogleServiceAccountJson() {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config?.credentials) {
    throw new Error('Google Calendar no está configurado')
  }

  return JSON.stringify(config.credentials, null, 2)
}

export async function saveGoogleCalendarConfig({ calendarId, credentials }) {
  const existing = await getStoredConfig()
  const receivedCalendarId = calendarId !== undefined && calendarId !== null
  const normalizedCalendarId = receivedCalendarId
    ? normalizeGoogleCalendarIdInput(calendarId)
    : cleanString(existing?.calendarId)
  const hasNewCredentials = Boolean(
    typeof credentials === 'string'
      ? cleanString(credentials)
      : credentials
  )

  if (!hasNewCredentials && !existing?.credentialsEncrypted) {
    throw new Error('Pega el JSON completo del Service Account')
  }

  const normalizedCredentials = hasNewCredentials
    ? normalizeServiceAccountCredentials(credentials)
    : null
  const credentialsEncrypted = normalizedCredentials
    ? encrypt(JSON.stringify(normalizedCredentials))
    : existing.credentialsEncrypted

  const config = {
    ...existing,
    connectionMode: 'service_account',
    calendarId: normalizedCalendarId,
    credentialsEncrypted,
    serviceAccountEmail: normalizedCredentials?.client_email || existing?.serviceAccountEmail || '',
    projectId: normalizedCredentials?.project_id || existing?.projectId || '',
    privateKeyId: normalizedCredentials?.private_key_id || existing?.privateKeyId || '',
    connectedAt: existing?.connectedAt || new Date().toISOString(),
    lastTestStatus: existing?.lastTestStatus || null,
    lastTestMessage: existing?.lastTestMessage || ''
  }

  await persistConfig(config)
  tokenCache = null
  return publicConfig(config)
}

export async function saveGoogleCalendarOAuthConnection(connection = {}) {
  const refreshToken = cleanString(connection.refresh_token || connection.refreshToken)
  if (!refreshToken) {
    throw new Error('Google Calendar no devolvió refresh token.')
  }

  const scopes = Array.isArray(connection.scopes)
    ? connection.scopes
    : cleanString(connection.scopes || connection.scope).split(/\s+/).filter(Boolean)

  const existing = await getStoredConfig()
  const config = {
    ...existing,
    connectionMode: 'oauth',
    credentialsEncrypted: '',
    refreshTokenEncrypted: encrypt(refreshToken),
    calendarId: cleanString(existing?.calendarId),
    serviceAccountEmail: '',
    projectId: '',
    privateKeyId: '',
    googleAccountEmail: cleanString(connection.email),
    googleAccountName: cleanString(connection.name),
    googleAccountPictureUrl: cleanString(connection.picture_url || connection.pictureUrl),
    scopes,
    connectedAt: cleanString(connection.connected_at || connection.connectedAt) || new Date().toISOString(),
    lastTestStatus: null,
    lastTestMessage: ''
  }

  await persistConfig(config)
  tokenCache = null
  return publicConfig(config)
}

export async function claimGoogleCalendarOAuthHandoff(handoffToken = '') {
  const handoff = await claimCentralOAuthHandoff({
    provider: 'google_calendar',
    handoffToken
  })
  const calendar = handoff?.payload?.calendar || {}
  return saveGoogleCalendarOAuthConnection(calendar)
}

export async function deleteGoogleCalendarConfig() {
  await clearGoogleCalendarIntegrationCredentials()
  tokenCache = null
}

function createServiceAccountAssertion(credentials) {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {})
  }
  const claims = {
    iss: credentials.client_email,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: credentials.token_uri || GOOGLE_TOKEN_URI,
    iat: now,
    exp: now + 3600
  }

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(credentials.private_key)

  return `${unsigned}.${base64Url(signature)}`
}

async function getAccessToken(config) {
  if (config.connectionMode === 'oauth') {
    const cacheKey = `oauth:${config.googleAccountEmail || ''}:${config.refreshToken ? crypto.createHash('sha1').update(config.refreshToken).digest('hex') : ''}`
    if (tokenCache?.cacheKey === cacheKey && tokenCache.expiresAt > Date.now() + 60000) {
      return tokenCache.accessToken
    }

    const payload = await refreshCentralGoogleCalendarToken({ refreshToken: config.refreshToken })
    if (!payload?.access_token) {
      throw new Error('Google Calendar no devolvió access token.')
    }

    tokenCache = {
      cacheKey,
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(1, Number(payload.expires_in || 3600) - 30) * 1000
    }

    return tokenCache.accessToken
  }

  const credentials = config.credentials
  const cacheKey = `${credentials.client_email}:${credentials.private_key_id || ''}`
  if (tokenCache?.cacheKey === cacheKey && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken
  }

  const assertion = createServiceAccountAssertion(credentials)
  const response = await fetchWithTimeout(credentials.token_uri || GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload.error_description || payload.error || `HTTP ${response.status}`
    throw new Error(`No se pudo autenticar el Service Account: ${message}`)
  }

  tokenCache = {
    cacheKey,
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(1, Number(payload.expires_in || 3600) - 30) * 1000
  }

  return tokenCache.accessToken
}

async function googleRequest(config, path, options = {}) {
  const token = await getAccessToken(config)
  const response = await fetchWithTimeout(`${GOOGLE_CALENDAR_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  })

  if (response.status === 204) return null

  const text = await response.text()
  const payload = text ? parseJson(text, null) : null

  if (!response.ok) {
    const message = payload?.error?.message || payload?.error_description || payload?.error || text || `HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  return payload
}

function eventPath(calendarId, eventId = '') {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base
}

function calendarListPath(pageToken = '') {
  const params = new URLSearchParams({
    maxResults: '250',
    showHidden: 'true',
    minAccessRole: 'reader'
  })
  if (pageToken) params.set('pageToken', pageToken)
  return `/users/me/calendarList?${params.toString()}`
}

function localIdForGoogleCalendar(calendarId) {
  const hash = crypto.createHash('sha1').update(cleanString(calendarId)).digest('hex').slice(0, 32)
  return `google_cal_${hash}`
}

function googleCalendarListItemToApi(calendar = {}) {
  const id = cleanString(calendar.id)
  const summary = cleanString(calendar.summaryOverride || calendar.summary || id || 'Google Calendar')

  return {
    id,
    summary,
    name: summary,
    description: cleanString(calendar.description),
    timeZone: cleanString(calendar.timeZone),
    accessRole: cleanString(calendar.accessRole),
    primary: Boolean(calendar.primary),
    selected: calendar.selected !== false,
    backgroundColor: cleanString(calendar.backgroundColor),
    foregroundColor: cleanString(calendar.foregroundColor)
  }
}

function canWriteGoogleCalendar(calendar = {}) {
  return ['owner', 'writer'].includes(cleanString(calendar.accessRole).toLowerCase())
}

function googleCalendarToLocalRecord(calendar = {}, config = {}) {
  const googleCalendarId = cleanString(calendar.id || config.calendarId)
  const name = cleanString(calendar.summaryOverride || calendar.summary || config.calendarSummary || 'Google Calendar')
  const color = cleanString(calendar.backgroundColor || calendar.foregroundColor || '#4285f4')

  return {
    id: localIdForGoogleCalendar(googleCalendarId),
    name,
    description: cleanString(calendar.description),
    calendarType: 'event',
    widgetType: 'classic',
    eventTitle: name || 'Cita',
    eventColor: color.startsWith('#') ? color : '#4285f4',
    isActive: !calendar.deleted,
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    openHours: [],
    autoConfirm: true,
    allowReschedule: true,
    allowCancellation: true,
    source: 'google',
    rawJson: {
      provider: 'google',
      googleCalendarId,
      summary: calendar.summary || config.calendarSummary || '',
      summaryOverride: calendar.summaryOverride || '',
      description: calendar.description || '',
      timeZone: calendar.timeZone || config.calendarTimeZone || '',
      accessRole: calendar.accessRole || '',
      primary: Boolean(calendar.primary),
      selected: calendar.selected !== false,
      backgroundColor: calendar.backgroundColor || '',
      foregroundColor: calendar.foregroundColor || ''
    }
  }
}

export async function getGoogleCalendarMetadata(config = null) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) {
    throw new Error('Google Calendar no está configurado')
  }
  if (!activeConfig.calendarId) {
    throw new Error('No hay Calendar ID global configurado')
  }

  return googleRequest(
    activeConfig,
    `/calendars/${encodeURIComponent(activeConfig.calendarId)}`
  )
}

export async function listGoogleCalendars({ config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) return []

  const calendars = []
  let pageToken = ''

  do {
    const payload = await googleRequest(activeConfig, calendarListPath(pageToken))
    calendars.push(...(Array.isArray(payload?.items) ? payload.items : []))
    pageToken = payload?.nextPageToken || ''
  } while (pageToken)

  return calendars.filter(calendar => calendar?.id && !calendar.deleted)
}

export async function listGoogleCalendarOptions({ config = null } = {}) {
  const calendars = await listGoogleCalendars({ config })
  return calendars
    .map(googleCalendarListItemToApi)
    .filter(calendar => calendar.id)
    .sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1
      if (canWriteGoogleCalendar(a) !== canWriteGoogleCalendar(b)) return canWriteGoogleCalendar(a) ? -1 : 1
      return a.summary.localeCompare(b.summary)
    })
}

export async function syncGoogleCalendarsToLocal({ config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) {
    return { enabled: false, saved: 0, calendars: [], availableCalendars: [] }
  }

  const availableCalendars = await listGoogleCalendarOptions({ config: activeConfig })

  return {
    enabled: true,
    saved: 0,
    calendars: [],
    availableCalendars
  }
}

export async function listGoogleEvents({ timeMin, timeMax, calendarId = null, config = null, showDeleted = false } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) return []

  const targetCalendarId = calendarId || activeConfig.calendarId
  const range = normalizeGoogleEventTimeRange({ startTime: timeMin, endTime: timeMax })
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: showDeleted ? 'true' : 'false',
    maxResults: '2500'
  })

  if (range.timeMin) params.set('timeMin', range.timeMin)
  if (range.timeMax) params.set('timeMax', range.timeMax)

  const events = []
  let pageToken = ''

  do {
    if (pageToken) params.set('pageToken', pageToken)
    const payload = await googleRequest(activeConfig, `${eventPath(targetCalendarId)}?${params.toString()}`)
    events.push(...(Array.isArray(payload?.items) ? payload.items : []))
    pageToken = payload?.nextPageToken || ''
  } while (pageToken)

  return events
}

async function getGoogleEvent(eventId, { config = null, calendarId = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) return null
  return googleRequest(activeConfig, eventPath(calendarId || activeConfig.calendarId, eventId))
}

function mapGoogleEventStatus(event = {}) {
  if (event.status === 'cancelled') return 'cancelled'
  return 'confirmed'
}

function googleEventDateToIso(value = {}, fallback = null) {
  const raw = value.dateTime || (value.date ? `${value.date}T00:00:00.000Z` : fallback)
  if (!raw) return null
  return normalizeToUtcIso(raw, 'UTC')
}

function localIdForGoogleEvent(eventId) {
  const hash = crypto.createHash('sha1').update(cleanString(eventId)).digest('hex').slice(0, 32)
  return `google_appt_${hash}`
}

async function resolveLocalCalendarId(preferredCalendarId = null) {
  if (preferredCalendarId) {
    const preferred = await localCalendarService.getLocalCalendar(preferredCalendarId)
    if (preferred) return preferred.id
  }

  const defaultCalendarId = cleanString(await getAppConfig('default_calendar_id'))
  if (defaultCalendarId) {
    const defaultCalendar = await localCalendarService.getLocalCalendar(defaultCalendarId)
    if (defaultCalendar) return defaultCalendar.id
  }

  const calendar = await localCalendarService.ensureDefaultLocalCalendar()
  return calendar.id
}

function googleEventToAppointment(event = {}, { calendarId, locationId = null } = {}) {
  const privateProps = event.extendedProperties?.private || {}
  const ristakAppointmentId = cleanString(privateProps.ristakAppointmentId)
  const ristakCalendarId = cleanString(privateProps.ristakCalendarId)
  const startTime = googleEventDateToIso(event.start)
  const endTime = googleEventDateToIso(event.end, startTime)

  return {
    id: ristakAppointmentId || localIdForGoogleEvent(event.id),
    googleEventId: event.id,
    calendarId: ristakCalendarId || calendarId,
    locationId,
    title: cleanString(event.summary) || 'Cita',
    appointmentStatus: mapGoogleEventStatus(event),
    status: mapGoogleEventStatus(event),
    notes: cleanString(event.description),
    address: cleanString(event.location),
    startTime,
    endTime,
    dateAdded: event.created || startTime || new Date().toISOString(),
    dateUpdated: event.updated || new Date().toISOString(),
    source: ristakAppointmentId ? 'ristak' : 'google'
  }
}

async function deleteLocalAppointmentForCancelledGoogleEvent(event = {}) {
  const privateProps = event.extendedProperties?.private || {}
  const candidateIds = [
    cleanString(privateProps.ristakAppointmentId),
    cleanString(event.id)
  ].filter(Boolean)

  for (const candidateId of [...new Set(candidateIds)]) {
    const existing = await localCalendarService.getLocalAppointment(candidateId).catch(() => null)
    if (existing?.id) {
      await localCalendarService.deleteLocalAppointment(existing.id)
      return true
    }
  }

  return false
}

function googleCalendarIdFromLocalCalendar(calendar = {}) {
  calendar = calendar || {}
  return cleanString(calendar.googleCalendarId || calendar.rawJson?.googleCalendarId || calendar.raw_json?.googleCalendarId)
}

async function findGoogleCalendarOption(googleCalendarId, { config = null } = {}) {
  const normalizedGoogleCalendarId = normalizeGoogleCalendarIdInput(googleCalendarId)
  if (!normalizedGoogleCalendarId) return null

  const calendars = await listGoogleCalendarOptions({ config })
  return calendars.find(calendar => (
    cleanString(calendar.id).toLowerCase() === normalizedGoogleCalendarId.toLowerCase()
  )) || null
}

async function resolveGoogleSyncTargets(config, calendarId = null) {
  if (calendarId) {
    const localCalendar = await localCalendarService.getLocalCalendar(calendarId)
    const googleCalendarId = googleCalendarIdFromLocalCalendar(localCalendar)

    if (googleCalendarId) {
      return [{
        googleCalendarId,
        localCalendarId: localCalendar.id
      }]
    }

    return []
  }

  const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars()
  const targets = linkedCalendars
    .map(calendar => ({
      googleCalendarId: googleCalendarIdFromLocalCalendar(calendar),
      localCalendarId: calendar.id
    }))
    .filter(target => target.googleCalendarId && target.localCalendarId)

  if (targets.length) return targets

  return []
}

export async function syncGoogleEventsToLocal({ startTime, endTime, calendarId = null, config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) {
    return { enabled: false, saved: 0 }
  }

  const targets = await resolveGoogleSyncTargets(activeConfig, calendarId)
  if (!targets.length) {
    return { enabled: true, saved: 0, linkedCalendars: 0 }
  }

  const range = normalizeGoogleEventTimeRange({ startTime, endTime })
  let saved = 0
  let deleted = 0
  for (const target of targets) {
    const events = await listGoogleEvents({
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        calendarId: target.googleCalendarId,
        config: activeConfig,
        showDeleted: true
      })

    for (const event of events) {
      if (!event?.id) continue

      if (mapGoogleEventStatus(event) === 'cancelled') {
        if (await deleteLocalAppointmentForCancelledGoogleEvent(event)) {
          deleted += 1
        }
        continue
      }

      if (!event.start) continue

      const appointment = googleEventToAppointment(event, {
        calendarId: target.localCalendarId
      })

      if (!appointment.startTime || !appointment.endTime) continue

      const localCalendarId = await resolveLocalCalendarId(appointment.calendarId)
      const localCalendar = await localCalendarService.getLocalCalendar(localCalendarId)
      appointment.calendarId = localCalendarId
      appointment.locationId = localCalendar?.locationId || null
      const existingAppointment = await localCalendarService.getLocalAppointment(appointment.id).catch(() => null)

      await localCalendarService.upsertLocalAppointment(appointment, {
        id: appointment.id,
        source: appointment.source,
        googleEventId: event.id,
        calendarId: localCalendarId,
        locationId: localCalendar?.locationId || null,
        syncStatus: existingAppointment?.syncStatus || (appointment.source === 'google' ? 'synced' : 'pending'),
        googleSyncStatus: 'synced'
      })
      saved += 1
    }
  }

  return { enabled: true, saved, deleted, linkedCalendars: targets.length }
}

export async function syncGoogleIntegrationNow({ startTime = null, endTime = null } = {}) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    throw new Error('Google Calendar no está configurado')
  }

  const now = new Date()
  const syncStart = startTime || new Date(now.getTime() - MANUAL_SYNC_PAST_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const syncEnd = endTime || new Date(now.getTime() + MANUAL_SYNC_FUTURE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const existing = await getStoredConfig()

  try {
    const availableCalendars = await listGoogleCalendarOptions({ config })
    const eventsResult = await syncGoogleEventsToLocal({
      startTime: syncStart,
      endTime: syncEnd,
      config
    })
    const outboundResult = await syncLocalAppointmentsToGoogle()
    const linkedCalendars = Number(eventsResult.linkedCalendars || outboundResult.linkedCalendars || 0)
    const syncedEvents = Number(eventsResult.saved || 0) + Number(outboundResult.synced || 0)
    const deletedEvents = Number(eventsResult.deleted || 0)
    const failedEvents = Number(outboundResult.failed || 0)

    const updatedConfig = {
      ...existing,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'success',
      lastSyncMessage: `${linkedCalendars} calendario(s) vinculado(s), ${syncedEvents} cita(s) sincronizada(s)${deletedEvents ? ` y ${deletedEvents} eliminada(s)` : ''}${failedEvents ? `; ${failedEvents} pendiente(s) por error` : ''}`,
      syncedCalendarsCount: linkedCalendars,
      syncedEventsCount: syncedEvents + deletedEvents
    }
    await persistConfig(updatedConfig)

    return {
      ...publicConfig(updatedConfig),
      sync: {
        calendars: linkedCalendars,
        events: syncedEvents + deletedEvents,
        deleted: deletedEvents,
        availableCalendars: availableCalendars.length,
        failed: failedEvents
      }
    }
  } catch (error) {
    const failedConfig = {
      ...existing,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncMessage: error.message
    }
    await persistConfig(failedConfig)
    throw error
  }
}

export async function updateLocalCalendarGoogleSync({ calendarId, googleCalendarId }) {
  const normalizedCalendarId = cleanString(calendarId)
  if (!normalizedCalendarId) {
    throw new Error('Calendario de Ristak requerido')
  }

  const localCalendar = await localCalendarService.getLocalCalendar(normalizedCalendarId)
  if (!localCalendar?.id) {
    throw new Error('Calendario de Ristak no encontrado')
  }

  const normalizedGoogleCalendarId = normalizeGoogleCalendarIdInput(googleCalendarId)
  if (!normalizedGoogleCalendarId) {
    return localCalendarService.updateLocalCalendar(localCalendar.id, {
      googleCalendarId: '',
      googleAccessRole: '',
      googleCalendarSummary: '',
      googleCalendarTimeZone: ''
    }, {
      syncStatus: localCalendar.syncStatus || 'pending'
    })
  }

  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    throw new Error('Conecta Google Calendar antes de sincronizar este calendario')
  }

  const googleCalendar = await findGoogleCalendarOption(normalizedGoogleCalendarId, { config })
  if (!googleCalendar?.id) {
    throw new Error('Ese calendario de Google no está disponible para esta integración')
  }

  if (!canWriteGoogleCalendar(googleCalendar)) {
    throw new Error('Ese calendario de Google necesita permiso para hacer cambios en eventos')
  }

  return localCalendarService.updateLocalCalendar(localCalendar.id, {
    googleCalendarId: googleCalendar.id,
    googleAccessRole: googleCalendar.accessRole,
    googleCalendarSummary: googleCalendar.summary,
    googleCalendarTimeZone: googleCalendar.timeZone
  }, {
    syncStatus: localCalendar.syncStatus || 'pending'
  })
}

export async function syncGoogleEventsForDateRange({ startDate, endDate, timezone = null, calendarId = null } = {}) {
  const zone = timezone || await getAccountTimezone()
  const start = normalizeToUtcIso(`${startDate}T00:00:00`, zone)
  const end = normalizeToUtcIso(`${endDate}T23:59:59`, zone)
  return syncGoogleEventsToLocal({ startTime: start, endTime: end, calendarId })
}

function buildGoogleEventPayload(appointment = {}, timezone = 'UTC') {
  const status = cleanString(appointment.appointmentStatus || appointment.status).toLowerCase()
  const title = cleanString(appointment.title) || 'Cita'
  const privateProperties = {
    ristakAppointmentId: cleanString(appointment.id),
    ristakCalendarId: cleanString(appointment.calendarId),
    source: 'ristak'
  }

  return {
    summary: title,
    description: cleanString(appointment.notes || appointment.description),
    location: cleanString(appointment.address),
    start: {
      dateTime: normalizeToUtcIso(appointment.startTime, timezone),
      timeZone: timezone
    },
    end: {
      dateTime: normalizeToUtcIso(appointment.endTime || appointment.startTime, timezone),
      timeZone: timezone
    },
    status: status === 'cancelled' || status === 'canceled' ? 'cancelled' : 'confirmed',
    extendedProperties: {
      private: privateProperties
    }
  }
}

async function markGoogleSyncError(appointmentId, message) {
  if (!appointmentId) return
  await db.run(`
    UPDATE appointments
    SET google_sync_status = 'error',
        google_sync_error = ?,
        date_updated = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [message, appointmentId])
}

async function markGoogleSyncSuccess(appointmentId, eventId) {
  if (!appointmentId) return null
  await db.run(`
    UPDATE appointments
    SET google_event_id = ?,
        google_sync_status = 'synced',
        google_sync_error = NULL,
        google_synced_at = CURRENT_TIMESTAMP,
        date_updated = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [eventId || null, appointmentId])

  return localCalendarService.getLocalAppointment(appointmentId)
}

async function resolveAppointment(appointmentOrId) {
  return typeof appointmentOrId === 'string'
    ? localCalendarService.getLocalAppointment(appointmentOrId)
    : appointmentOrId
}

export async function syncAppointmentToGoogle(appointmentOrId) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    return { enabled: false, appointment: appointmentOrId }
  }

  const appointment = await resolveAppointment(appointmentOrId)

  if (!appointment?.id) {
    return { enabled: true, appointment: null }
  }

  try {
    const localCalendar = await localCalendarService.getLocalCalendar(appointment.calendarId)
    const targetGoogleCalendarId = googleCalendarIdFromLocalCalendar(localCalendar)
    if (!targetGoogleCalendarId) {
      return {
        enabled: false,
        reason: 'calendar_not_linked',
        appointment
      }
    }

    const status = cleanString(appointment.appointmentStatus || appointment.status).toLowerCase()
    if (status === 'cancelled' || status === 'canceled') {
      await deleteGoogleEventForAppointment(appointment)
      return {
        enabled: true,
        appointment: await localCalendarService.getLocalAppointment(appointment.id)
      }
    }

    const timezone = await getAccountTimezone()
    const payload = buildGoogleEventPayload(appointment, timezone)
    let eventId = appointment.googleEventId
    let remote

    if (eventId) {
      try {
        remote = await googleRequest(config, eventPath(targetGoogleCalendarId, eventId), {
          method: 'PATCH',
          body: JSON.stringify(payload)
        })
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error
        eventId = null
      }
    }

    if (!eventId) {
      remote = await googleRequest(config, eventPath(targetGoogleCalendarId), {
        method: 'POST',
        body: JSON.stringify(payload)
      })
      eventId = remote?.id
    }

    if (!eventId) {
      throw new Error('Google Calendar no devolvio ID de evento')
    }

    const updated = await markGoogleSyncSuccess(appointment.id, eventId)
    return { enabled: true, appointment: updated || appointment, event: remote }
  } catch (error) {
    await markGoogleSyncError(appointment.id, error.message)
    logger.warn(`[Google Calendar] No se pudo sincronizar cita ${appointment.id}: ${error.message}`)
    throw error
  }
}

export async function syncLocalAppointmentsToGoogle({ calendarId = null, limit = 500 } = {}) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    return { enabled: false, total: 0, synced: 0, failed: 0 }
  }

  const linkedCalendars = calendarId
    ? [await localCalendarService.getLocalCalendar(calendarId)].filter(calendar => googleCalendarIdFromLocalCalendar(calendar))
    : await localCalendarService.listGoogleLinkedLocalCalendars()
  const linkedCalendarIds = [...new Set(linkedCalendars.map(calendar => cleanString(calendar.id)).filter(Boolean))]

  if (!linkedCalendarIds.length) {
    return { enabled: true, total: 0, synced: 0, failed: 0, linkedCalendars: 0 }
  }

  const conditions = [
    'deleted_at IS NULL',
    "COALESCE(sync_status, '') != 'pending_delete'",
    "(COALESCE(source, 'ristak') = 'ristak' OR id LIKE 'rstk_appt_%')",
    "LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'invalid')",
    "(COALESCE(google_sync_status, '') != 'synced' OR COALESCE(google_event_id, '') = '')",
    `calendar_id IN (${linkedCalendarIds.map(() => '?').join(', ')})`
  ]
  const params = [...linkedCalendarIds]

  const rows = await db.all(`
    SELECT id
    FROM appointments
    WHERE ${conditions.join(' AND ')}
    ORDER BY date_added ASC
    LIMIT ?
  `, [...params, Math.max(1, Number(limit) || 500)])

  let synced = 0
  let failed = 0

  for (const row of rows) {
    try {
      const appointment = await localCalendarService.getLocalAppointment(row.id)
      if (!appointment?.id) continue

      const result = await syncAppointmentToGoogle(appointment)
      if (result?.enabled !== false && result?.reason !== 'calendar_not_linked') {
        synced += 1
      }
    } catch (error) {
      failed += 1
      logger.warn(`[Google Calendar] No se pudo subir cita local ${row.id}: ${error.message}`)
    }
  }

  return {
    enabled: true,
    total: rows.length,
    synced,
    failed,
    linkedCalendars: linkedCalendarIds.length
  }
}

async function getConfiguredGoogleLocalCalendar(config = null) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig?.calendarId) return null

  try {
    const calendarSync = await syncGoogleCalendarsToLocal({ config: activeConfig })
    const configuredCalendarId = cleanString(activeConfig.calendarId).toLowerCase()
    const calendar = (calendarSync.calendars || []).find(item => (
      cleanString(item.googleCalendarId || item.id).toLowerCase() === configuredCalendarId
    ))
    if (calendar?.id) return calendar
  } catch (error) {
    logger.warn(`[Google Calendar] No se pudo asegurar calendario local configurado: ${error.message}`)
  }

  return localCalendarService.getLocalCalendar(localIdForGoogleCalendar(activeConfig.calendarId))
}

async function getRistakCalendarsWithActiveAppointments() {
  const configuredDefaultCalendarId = cleanString(await getAppConfig('default_calendar_id'))
  const rows = await db.all(`
    SELECT c.id, COUNT(a.id) AS appointments_count
    FROM calendars c
    INNER JOIN appointments a ON a.calendar_id = c.id
    WHERE (
        COALESCE(c.source, 'ristak') = 'ristak'
        OR c.id LIKE 'rstk_cal_%'
      )
      AND a.deleted_at IS NULL
      AND COALESCE(a.sync_status, '') != 'pending_delete'
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('cancelled', 'canceled', 'invalid')
    GROUP BY c.id, c.name, c.slug
    ORDER BY
      CASE WHEN c.id = ? THEN 0 ELSE 1 END,
      CASE
        WHEN LOWER(COALESCE(c.name, '')) LIKE '%calendario ristak%' THEN 0
        WHEN LOWER(COALESCE(c.name, '')) = 'mi calendario' THEN 0
        WHEN LOWER(COALESCE(c.slug, '')) = 'calendario-ristak' THEN 0
        WHEN LOWER(COALESCE(c.slug, '')) = 'mi-calendario' THEN 0
        ELSE 1
      END,
      LOWER(COALESCE(c.name, '')) ASC
  `, [configuredDefaultCalendarId])

  const calendars = []
  for (const row of rows) {
    const calendar = await localCalendarService.getLocalCalendar(row.id)
    if (!calendar?.id || calendar.source !== 'ristak') continue

    calendars.push({
      ...calendar,
      appointmentsCount: Number(row.appointments_count || 0)
    })
  }

  return calendars
}

export async function getGoogleCalendarMergePreview() {
  return {
    connected: Boolean(await getGoogleCalendarConfig({ includeCredentials: true })),
    mergeAvailable: false,
    googleCalendar: null,
    sourceCalendars: [],
    totalAppointments: 0
  }
}

export async function mergeRistakAppointmentsIntoGoogle({ sourceCalendarIds = null } = {}) {
  void sourceCalendarIds
  throw new Error('La combinación automática ya no está disponible; vincula cada calendario de Ristak con Google desde su configuración')
}

export async function deleteGoogleEventForAppointment(appointmentOrId) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) return { enabled: false }

  const appointment = await resolveAppointment(appointmentOrId)

  if (!appointment?.id || !appointment.googleEventId) {
    return { enabled: true, deleted: false }
  }

  try {
    const localCalendar = await localCalendarService.getLocalCalendar(appointment.calendarId)
    const targetGoogleCalendarId = googleCalendarIdFromLocalCalendar(localCalendar) || cleanString(config.calendarId)
    if (!targetGoogleCalendarId) {
      return { enabled: false, deleted: false, reason: 'calendar_not_linked' }
    }

    await googleRequest(config, eventPath(targetGoogleCalendarId, appointment.googleEventId), {
      method: 'DELETE'
    })
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) {
      await markGoogleSyncError(appointment.id, error.message)
      throw error
    }
  }

  await markGoogleSyncSuccess(appointment.id, null)
  return { enabled: true, deleted: true }
}

export async function testGoogleCalendarConnection() {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    throw new Error('Guarda primero las credenciales de Google Calendar')
  }

  const existing = await getStoredConfig()

  try {
    const calendars = await listGoogleCalendarOptions({ config })
    if (!calendars.length) {
      throw new Error('Las credenciales funcionan, pero la integración no tiene calendarios disponibles')
    }

    const writableCalendars = calendars.filter(canWriteGoogleCalendar)
    if (!writableCalendars.length) {
      throw new Error('Google Calendar responde, pero ningun calendario compartido tiene permiso para hacer cambios')
    }

    const primaryCalendar = writableCalendars[0]

    const updatedConfig = {
      ...existing,
      calendarSummary: primaryCalendar.summary || '',
      calendarTimeZone: primaryCalendar.timeZone || '',
      lastTestAt: new Date().toISOString(),
      lastTestStatus: 'success',
      lastTestMessage: `${writableCalendars.length} calendario(s) de Google con permiso de escritura disponibles`
    }
    await persistConfig(updatedConfig)

    return publicConfig(updatedConfig)
  } catch (error) {
    const failedConfig = {
      ...existing,
      lastTestAt: new Date().toISOString(),
      lastTestStatus: 'error',
      lastTestMessage: error.message
    }
    await persistConfig(failedConfig)
    throw error
  }
}

export default {
  claimGoogleCalendarOAuthHandoff,
  deleteGoogleCalendarConfig,
  deleteGoogleEventForAppointment,
  getGoogleCalendarConfig,
  getGoogleCalendarMergePreview,
  getGoogleCalendarMetadata,
  getGoogleServiceAccountJson,
  listGoogleCalendarOptions,
  listGoogleCalendars,
  listGoogleEvents,
  mergeRistakAppointmentsIntoGoogle,
  normalizeServiceAccountCredentials,
  saveGoogleCalendarOAuthConnection,
  saveGoogleCalendarConfig,
  syncAppointmentToGoogle,
  syncLocalAppointmentsToGoogle,
  syncGoogleCalendarsToLocal,
  syncGoogleEventsForDateRange,
  syncGoogleEventsToLocal,
  syncGoogleIntegrationNow,
  testGoogleCalendarConnection,
  updateLocalCalendarGoogleSync
}
