import crypto from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { getAccountTimezone, normalizeToUtcIso } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import * as localCalendarService from './localCalendarService.js'

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
    throw new Error('El JSON del Service Account no trae client_email valido')
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('El JSON del Service Account no trae private_key valida')
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
      throw new Error(`Google Calendar no respondio despues de ${timeout}ms`)
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
  const connected = Boolean(config.calendarId && config.credentialsEncrypted)
  return {
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
    updatedAt: config.updatedAt || null
  }
}

export async function getGoogleCalendarConfig({ includeCredentials = false } = {}) {
  const config = await getStoredConfig()
  if (!config) return includeCredentials ? null : publicConfig()

  if (!includeCredentials) {
    return publicConfig(config)
  }

  if (!config.credentialsEncrypted || !config.calendarId) {
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
    logger.warn(`[Google Calendar] No se pudo desencriptar la configuracion: ${error.message}`)
    return null
  }
}

export async function getGoogleServiceAccountJson() {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config?.credentials) {
    throw new Error('Google Calendar no esta configurado')
  }

  return JSON.stringify(config.credentials, null, 2)
}

export async function saveGoogleCalendarConfig({ calendarId, credentials }) {
  const normalizedCalendarId = normalizeGoogleCalendarIdInput(calendarId)
  if (!normalizedCalendarId) {
    throw new Error('El Calendar ID es requerido')
  }

  const existing = await getStoredConfig()
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

export async function deleteGoogleCalendarConfig() {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEY])
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
    throw new Error('Google Calendar no esta configurado')
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

export async function syncGoogleCalendarsToLocal({ config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) {
    return { enabled: false, saved: 0, calendars: [] }
  }

  let calendars = []
  try {
    calendars = await listGoogleCalendars({ config: activeConfig })
  } catch (error) {
    logger.warn(`[Google Calendar] No se pudo listar calendarList, se usara Calendar ID configurado: ${error.message}`)
  }
  const knownIds = new Set()
  const savedCalendars = []

  for (const calendar of calendars) {
    const googleCalendarId = cleanString(calendar.id)
    if (!googleCalendarId || knownIds.has(googleCalendarId)) continue

    knownIds.add(googleCalendarId)
    const localRecord = googleCalendarToLocalRecord(calendar, activeConfig)
    const localCalendar = await localCalendarService.upsertLocalCalendar(
      localRecord,
      {
        source: 'google',
        syncStatus: 'synced',
        rawJson: localRecord.rawJson
      }
    )
    savedCalendars.push(localCalendar)
  }

  if (activeConfig.calendarId && !knownIds.has(activeConfig.calendarId)) {
    const metadata = await getGoogleCalendarMetadata(activeConfig)
    const fallbackCalendar = {
      id: activeConfig.calendarId,
      summary: metadata.summary || activeConfig.calendarSummary || activeConfig.calendarId,
      description: metadata.description || '',
      timeZone: metadata.timeZone || activeConfig.calendarTimeZone || '',
      accessRole: 'writer',
      selected: true
    }
    const localRecord = googleCalendarToLocalRecord(fallbackCalendar, activeConfig)
    const localCalendar = await localCalendarService.upsertLocalCalendar(
      localRecord,
      {
        source: 'google',
        syncStatus: 'synced',
        rawJson: localRecord.rawJson
      }
    )
    savedCalendars.push(localCalendar)
  }

  return {
    enabled: true,
    saved: savedCalendars.length,
    calendars: savedCalendars
  }
}

export async function listGoogleEvents({ timeMin, timeMax, calendarId = null, config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) return []

  const targetCalendarId = calendarId || activeConfig.calendarId
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
    maxResults: '2500'
  })

  if (timeMin) params.set('timeMin', new Date(Number(timeMin) || timeMin).toISOString())
  if (timeMax) params.set('timeMax', new Date(Number(timeMax) || timeMax).toISOString())

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

function googleCalendarIdFromLocalCalendar(calendar = {}) {
  calendar = calendar || {}
  return cleanString(calendar.googleCalendarId || calendar.rawJson?.googleCalendarId || calendar.raw_json?.googleCalendarId)
}

async function resolveGoogleSyncTargets(config, calendarId = null) {
  if (calendarId) {
    const localCalendar = await localCalendarService.getLocalCalendar(calendarId)
    const googleCalendarId = googleCalendarIdFromLocalCalendar(localCalendar)

    if (localCalendar?.source === 'google' && googleCalendarId) {
      return [{
        googleCalendarId,
        localCalendarId: localCalendar.id
      }]
    }

    return [{
      googleCalendarId: config.calendarId,
      localCalendarId: calendarId
    }]
  }

  const calendarSync = await syncGoogleCalendarsToLocal({ config })
  const targets = (calendarSync.calendars || [])
    .map(calendar => ({
      googleCalendarId: googleCalendarIdFromLocalCalendar(calendar),
      localCalendarId: calendar.id
    }))
    .filter(target => target.googleCalendarId && target.localCalendarId)

  if (targets.length) return targets

  const fallbackLocalCalendarId = localIdForGoogleCalendar(config.calendarId)
  return [{
    googleCalendarId: config.calendarId,
    localCalendarId: fallbackLocalCalendarId
  }]
}

export async function syncGoogleEventsToLocal({ startTime, endTime, calendarId = null, config = null } = {}) {
  const activeConfig = config || await getGoogleCalendarConfig({ includeCredentials: true })
  if (!activeConfig) {
    return { enabled: false, saved: 0 }
  }

  const targets = await resolveGoogleSyncTargets(activeConfig, calendarId)

  let saved = 0
  for (const target of targets) {
    const events = await listGoogleEvents({
      timeMin: startTime,
      timeMax: endTime,
      calendarId: target.googleCalendarId,
      config: activeConfig
    })

    for (const event of events) {
      if (!event?.id || !event.start) continue

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

  return { enabled: true, saved }
}

export async function syncGoogleIntegrationNow({ startTime = null, endTime = null } = {}) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    throw new Error('Google Calendar no esta configurado')
  }

  const now = new Date()
  const syncStart = startTime || new Date(now.getTime() - MANUAL_SYNC_PAST_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const syncEnd = endTime || new Date(now.getTime() + MANUAL_SYNC_FUTURE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const existing = await getStoredConfig()

  try {
    const calendarsResult = await syncGoogleCalendarsToLocal({ config })
    const eventsResult = await syncGoogleEventsToLocal({
      startTime: syncStart,
      endTime: syncEnd,
      config
    })

    const updatedConfig = {
      ...existing,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'success',
      lastSyncMessage: `${calendarsResult.saved} calendario(s) y ${eventsResult.saved} cita(s) sincronizados`,
      syncedCalendarsCount: calendarsResult.saved,
      syncedEventsCount: eventsResult.saved
    }
    await persistConfig(updatedConfig)

    return {
      ...publicConfig(updatedConfig),
      sync: {
        calendars: calendarsResult.saved,
        events: eventsResult.saved
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

export async function syncAppointmentToGoogle(appointmentOrId) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    return { enabled: false, appointment: appointmentOrId }
  }

  const appointment = typeof appointmentOrId === 'string'
    ? await localCalendarService.getLocalAppointment(appointmentOrId)
    : appointmentOrId

  if (!appointment?.id) {
    return { enabled: true, appointment: null }
  }

  try {
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
        remote = await googleRequest(config, eventPath(config.calendarId, eventId), {
          method: 'PATCH',
          body: JSON.stringify(payload)
        })
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error
        eventId = null
      }
    }

    if (!eventId) {
      remote = await googleRequest(config, eventPath(config.calendarId), {
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

export async function deleteGoogleEventForAppointment(appointmentOrId) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) return { enabled: false }

  const appointment = typeof appointmentOrId === 'string'
    ? await localCalendarService.getLocalAppointment(appointmentOrId)
    : appointmentOrId

  if (!appointment?.id || !appointment.googleEventId) {
    return { enabled: true, deleted: false }
  }

  try {
    await googleRequest(config, eventPath(config.calendarId, appointment.googleEventId), {
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
    throw new Error('Guarda primero las credenciales y el Calendar ID')
  }

  const existing = await getStoredConfig()
  let testEventId = null

  try {
    const metadata = await getGoogleCalendarMetadata(config)
    const now = new Date()
    const start = new Date(now.getTime() + 10 * 60 * 1000)
    const end = new Date(start.getTime() + 5 * 60 * 1000)

    await listGoogleEvents({
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      config
    })

    const created = await googleRequest(config, eventPath(config.calendarId), {
      method: 'POST',
      body: JSON.stringify({
        summary: 'Ristak prueba de conexion',
        description: 'Evento temporal creado por Ristak para validar permisos de Google Calendar.',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        extendedProperties: {
          private: {
            source: 'ristak_connection_test'
          }
        }
      })
    })
    testEventId = created?.id

    if (!testEventId) {
      throw new Error('Google Calendar permitio crear, pero no devolvio ID de evento')
    }

    await googleRequest(config, eventPath(config.calendarId, testEventId), {
      method: 'PATCH',
      body: JSON.stringify({
        summary: 'Ristak prueba de conexion actualizada'
      })
    })

    await getGoogleEvent(testEventId, { config })
    await googleRequest(config, eventPath(config.calendarId, testEventId), {
      method: 'DELETE'
    })
    testEventId = null

    const updatedConfig = {
      ...existing,
      calendarSummary: metadata.summary || '',
      calendarTimeZone: metadata.timeZone || '',
      lastTestAt: new Date().toISOString(),
      lastTestStatus: 'success',
      lastTestMessage: 'Lectura, creacion, actualizacion y cancelacion validadas'
    }
    await persistConfig(updatedConfig)

    return publicConfig(updatedConfig)
  } catch (error) {
    if (testEventId) {
      await googleRequest(config, eventPath(config.calendarId, testEventId), {
        method: 'DELETE'
      }).catch(() => {})
    }

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
  deleteGoogleCalendarConfig,
  deleteGoogleEventForAppointment,
  getGoogleCalendarConfig,
  getGoogleCalendarMetadata,
  getGoogleServiceAccountJson,
  listGoogleCalendars,
  listGoogleEvents,
  normalizeServiceAccountCredentials,
  saveGoogleCalendarConfig,
  syncAppointmentToGoogle,
  syncGoogleCalendarsToLocal,
  syncGoogleEventsForDateRange,
  syncGoogleEventsToLocal,
  syncGoogleIntegrationNow,
  testGoogleCalendarConnection
}
