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
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const REQUEST_TIMEOUT = 15000
const MANUAL_SYNC_PAST_DAYS = 30
const MANUAL_SYNC_FUTURE_DAYS = 365

let tokenCache = null

function cleanString(value) {
  return String(value ?? '').trim()
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
  const scopes = Array.isArray(config.scopes) ? config.scopes : []
  const connected = config.connectionMode === 'oauth' && Boolean(config.refreshTokenEncrypted)
  return {
    connectionMode: 'oauth',
    connected,
    calendarId: config.calendarId || '',
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
    scopes,
    canManageEvents: scopes.includes('https://www.googleapis.com/auth/calendar.events'),
    canListCalendars: scopes.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly')
  }
}

export async function getGoogleCalendarConfig({ includeCredentials = false } = {}) {
  const config = await getStoredConfig()
  if (!config) return includeCredentials ? null : publicConfig()

  if (!includeCredentials) {
    return publicConfig(config)
  }

  if (config.connectionMode !== 'oauth' || !config.refreshTokenEncrypted) {
    return null
  }

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
    serviceAccountEmail: undefined,
    projectId: undefined,
    privateKeyId: undefined,
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
  // (GCAL-005) Al desconectar Google también hay que limpiar el `googleCalendarId`
  // viejo de los calendarios locales vinculados; si no, quedan apuntando a un
  // calendario de Google al que ya no tenemos acceso y la UI sigue "vinculada".
  try {
    const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars({ includeInactive: true })
    for (const calendar of linkedCalendars) {
      await updateLocalCalendarGoogleSync({
        calendarId: calendar.id,
        googleCalendarId: ''
      }).catch(error => {
        logger.warn(`[Google Calendar] No se pudo limpiar vínculo Google del calendario ${calendar.id}: ${error.message}`)
      })
    }
  } catch (error) {
    logger.warn(`[Google Calendar] No se pudieron limpiar vínculos Google locales al desconectar: ${error.message}`)
  }
  await clearGoogleCalendarIntegrationCredentials()
  tokenCache = null
}

async function getAccessToken(config, { forceRefresh = false } = {}) {
  if (config.connectionMode !== 'oauth' || !config.refreshToken) {
    throw new Error('Conecta Google Calendar con OAuth antes de sincronizar.')
  }

  const cacheKey = `oauth:${config.googleAccountEmail || ''}:${crypto.createHash('sha1').update(config.refreshToken).digest('hex')}`
  // (GCAL-008) `forceRefresh` permite saltar el cache global por proceso cuando Google
  // ya revocó/invalidó el token server-side (401). Sin esto, el access token cacheado
  // se seguiría sirviendo hasta su expiración (~1h) aunque las credenciales ya no sirvan.
  if (!forceRefresh && tokenCache?.cacheKey === cacheKey && tokenCache.expiresAt > Date.now() + 60000) {
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

async function googleRequest(config, path, options = {}, { forceRefresh = false } = {}) {
  const token = await getAccessToken(config, { forceRefresh })
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
    // (GCAL-008) Un 401 significa que el access token cacheado por proceso ya no es válido
    // (Google revocó/invalidó las credenciales). Invalidamos el cache global y reintentamos
    // una sola vez forzando un refresh; si persiste, propagamos el error real.
    if (response.status === 401 && !forceRefresh) {
      tokenCache = null
      return googleRequest(config, path, options, { forceRefresh: true })
    }

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

function eventWritePath(calendarId, eventId = '') {
  return `${eventPath(calendarId, eventId)}?sendUpdates=all`
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

export function googleTestEventIdForEffect(testEffectId) {
  const effectId = cleanString(testEffectId)
  if (!effectId) throw new Error('La cita de prueba no tiene testEffectId para generar su ID de Google')
  // Google permite IDs client-side de 5..1024 caracteres usando base32hex
  // (0-9, a-v). SHA-256 hexadecimal es un subconjunto válido y evita depender
  // de la respuesta del POST para saber qué evento limpiar.
  return `ristaktest${crypto.createHash('sha256').update(effectId).digest('hex')}`
}

export function googleAppointmentEventIdForLocalAppointment(appointmentId, mirrorGeneration = 0) {
  const localAppointmentId = cleanString(appointmentId)
  if (!localAppointmentId) throw new Error('La cita local no tiene ID para generar su espejo determinista de Google')
  const generation = Math.max(0, Math.trunc(Number(mirrorGeneration) || 0))
  const identity = generation > 0 ? `${localAppointmentId}\u0000${generation}` : localAppointmentId
  // El ID solicitado por cliente vuelve idempotente el espejo en vivo. Si un
  // POST termina en timeout, el reintento consulta exactamente el mismo ID en
  // vez de crear otro evento. Hexadecimal cumple el alfabeto base32hex de Google.
  return `ristakappt${crypto.createHash('sha256').update(identity).digest('hex')}`
}

function mapGoogleEventStatus(event = {}) {
  if (event.status === 'cancelled') return 'cancelled'
  if (event.status === 'tentative') return 'pending'
  return 'confirmed'
}

function googleEventDateToIso(value = {}, fallback = null, timezone = 'UTC') {
  // (GCAL-004) Eventos all-day de Google solo traen `date` (YYYY-MM-DD) sin hora ni zona.
  // Anclar la medianoche a la zona de la cuenta (no a UTC) para que el día no se desfase
  // en zonas no-UTC (p. ej. México UTC-6, donde medianoche UTC cae el día anterior).
  if (value.dateTime) {
    return normalizeToUtcIso(value.dateTime, 'UTC')
  }
  if (value.date) {
    return normalizeToUtcIso(`${value.date}T00:00:00`, timezone)
  }
  if (!fallback) return null
  return normalizeToUtcIso(fallback, 'UTC')
}

function localIdForGoogleEvent(eventId) {
  const hash = crypto.createHash('sha1').update(cleanString(eventId)).digest('hex').slice(0, 32)
  return `google_appt_${hash}`
}

function localIdForGoogleOwnershipShadow(eventId, calendarId) {
  const hash = crypto.createHash('sha1')
    .update(`${cleanString(eventId)}\u0000${cleanString(calendarId)}`)
    .digest('hex')
    .slice(0, 32)
  return `google_shadow_${hash}`
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

export function googleEventToAppointment(event = {}, { calendarId, locationId = null, timezone = 'UTC' } = {}) {
  const privateProps = event.extendedProperties?.private || {}
  const ristakAppointmentId = cleanString(privateProps.ristakAppointmentId)
  const ristakCalendarId = cleanString(privateProps.ristakCalendarId)
  const targetCalendarId = cleanString(calendarId)
  const embeddedOwnerMismatch = Boolean(targetCalendarId && ristakCalendarId && ristakCalendarId !== targetCalendarId)
  const embeddedOwnerMatchesTarget = !embeddedOwnerMismatch
  const effectiveRistakAppointmentId = embeddedOwnerMatchesTarget ? ristakAppointmentId : ''
  // (GCAL-004) Pasar la zona de la cuenta para anclar correctamente los eventos all-day.
  const startTime = googleEventDateToIso(event.start, null, timezone)
  const endTime = googleEventDateToIso(event.end, startTime, timezone)

  // (GCAL-006) Google manda los invitados en event.attendees como
  // {email, displayName, organizer, self}. Tomamos el primer attendee que NO sea
  // el organizador y NO sea la propia cuenta (self), y que traiga email utilizable.
  // Ese invitado es el "contacto" de la cita. Si no hay ninguno, queda null y la
  // cita entra sin contacto (degradación segura).
  const guest = Array.isArray(event.attendees)
    ? event.attendees.find(a => a && !a.organizer && !a.self && cleanString(a.email))
    : null

  return {
    id: effectiveRistakAppointmentId || (embeddedOwnerMismatch
      ? localIdForGoogleOwnershipShadow(event.id, targetCalendarId)
      : localIdForGoogleEvent(event.id)),
    // (GCAL-006) Datos del invitado para resolver/crear contacto antes del upsert.
    guestEmail: guest ? cleanString(guest.email) : null,
    guestName: guest ? cleanString(guest.displayName) : null,
    // En una religa no podemos reutilizar google_event_id: sigue unido a la
    // cita canónica de A. El shadow determinista de B sólo representa ocupación.
    googleEventId: embeddedOwnerMismatch ? null : event.id,
    // El vínculo actual Google -> calendario local manda. Un evento puede traer
    // metadata vieja de la agenda A después de que el dueño religó Google a B;
    // nunca movemos la cita canónica de A ni dejamos invisible la ocupación en B.
    calendarId: targetCalendarId || ristakCalendarId,
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
    source: embeddedOwnerMismatch ? 'google_shadow' : (effectiveRistakAppointmentId ? 'ristak' : 'google')
  }
}

function isRistakCanonicalAppointment(appointment = {}) {
  return cleanString(appointment.source).toLowerCase() === 'ristak' || cleanString(appointment.id).startsWith('rstk_appt_')
}

function googleMirrorMatchesCanonicalAppointment(event = {}, appointment = {}) {
  const sameInstant = (left, right) => {
    const leftTime = Date.parse(cleanString(left))
    const rightTime = Date.parse(cleanString(right))
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
  }
  const remoteStart = googleEventDateToIso(event.start, null, 'UTC')
  const remoteEnd = googleEventDateToIso(event.end, remoteStart, 'UTC')
  return (
    cleanString(event.summary || 'Cita') === cleanString(appointment.title || 'Cita') &&
    cleanString(event.description) === cleanString(appointment.notes) &&
    cleanString(event.location) === cleanString(appointment.address) &&
    mapGoogleEventStatus(event) === cleanString(appointment.appointmentStatus || appointment.status || 'confirmed').toLowerCase() &&
    sameInstant(remoteStart, appointment.startTime) &&
    sameInstant(remoteEnd, appointment.endTime)
  )
}

async function deleteLocalAppointmentForCancelledGoogleEvent(event = {}, {
  calendarId = '',
  providerCalendarId = ''
} = {}) {
  const privateProps = event.extendedProperties?.private || {}
  const targetCalendarId = cleanString(calendarId)
  const embeddedCalendarId = cleanString(privateProps.ristakCalendarId)
  const embeddedOwnerMismatch = Boolean(targetCalendarId && embeddedCalendarId && embeddedCalendarId !== targetCalendarId)
  const embeddedOwnerMatchesTarget = !embeddedOwnerMismatch
  const candidateIds = [
    embeddedOwnerMatchesTarget ? cleanString(privateProps.ristakAppointmentId) : '',
    embeddedOwnerMatchesTarget ? cleanString(event.id) : '',
    cleanString(event.id)
      ? (embeddedOwnerMismatch
          ? localIdForGoogleOwnershipShadow(event.id, targetCalendarId)
          : localIdForGoogleEvent(event.id))
      : ''
  ].filter(Boolean)

  for (const candidateId of [...new Set(candidateIds)]) {
    const existing = await localCalendarService.getLocalAppointment(candidateId).catch(() => null)
    if (existing?.id && (!targetCalendarId || cleanString(existing.calendarId) === targetCalendarId)) {
      if (isRistakCanonicalAppointment(existing)) {
        // Google sólo borró su copia. La cita local sigue viva y queda pendiente
        // para reparar el espejo; jamás propagamos esa cancelación hacia Ristak.
        // Un tombstone viejo puede reaparecer después de religar B→A→B. La
        // rotación de abajo queda condicionada también en SQL: sólo el provider
        // que actualmente posee el espejo (o una fila legacy sin provider) puede
        // invalidar esa generación.
        if (cleanString(existing.googleEventId) === cleanString(event.id)) {
          await rotateGoogleMirrorGeneration({
            appointmentId: existing.id,
            expectedGeneration: existing.googleMirrorGeneration,
            expectedEventId: existing.googleEventId,
            providerCalendarId,
            message: 'La copia de Google fue cancelada o eliminada; Ristak conservó la cita y publicará un espejo nuevo.'
          })
        }
        return { handled: true, deleted: false, preservedLocal: true }
      }

      // Un evento nacido fuera de Ristak sí es sólo ocupación importada y puede
      // retirarse localmente cuando Google lo cancela.
      await localCalendarService.cancelLocalAppointment(existing.id)
      return { handled: true, deleted: true, preservedLocal: false }
    }
  }

  return { handled: false, deleted: false, preservedLocal: false }
}

function googleCalendarIdFromLocalCalendar(calendar = {}) {
  calendar = calendar || {}
  return cleanString(calendar.googleCalendarId || calendar.rawJson?.googleCalendarId || calendar.raw_json?.googleCalendarId)
}

function duplicateGoogleCalendarOwnerError(googleCalendarId, ownerIds = []) {
  const error = new Error(
    `El calendario de Google ${googleCalendarId} ya está ligado a otra agenda de Ristak. Desvincúlalo de la agenda anterior antes de continuar.`
  )
  error.status = 409
  error.code = 'duplicate_google_calendar_owner'
  error.ownerIds = ownerIds
  return error
}

function assertUniqueGoogleCalendarOwner({ googleCalendarId, localCalendarId, linkedCalendars = [] } = {}) {
  const normalizedGoogleId = normalizeGoogleCalendarIdInput(googleCalendarId).toLowerCase()
  if (!normalizedGoogleId) return
  const owners = (Array.isArray(linkedCalendars) ? linkedCalendars : [])
    .filter(calendar => googleCalendarIdFromLocalCalendar(calendar).toLowerCase() === normalizedGoogleId)
    .map(calendar => cleanString(calendar.id))
    .filter(Boolean)
  const uniqueOwners = [...new Set(owners)]
  if (uniqueOwners.some(ownerId => ownerId !== cleanString(localCalendarId)) || uniqueOwners.length > 1) {
    throw duplicateGoogleCalendarOwnerError(googleCalendarId, uniqueOwners)
  }
}

async function assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
  googleCalendarId,
  localCalendarId
} = {}) {
  const normalizedGoogleCalendarId = normalizeGoogleCalendarIdInput(googleCalendarId)
  const normalizedLocalCalendarId = cleanString(localCalendarId)
  if (!normalizedGoogleCalendarId || !normalizedLocalCalendarId) return

  // Se consulta de nuevo inmediatamente antes de cada escritura remota. Esto
  // hace que una instalación legacy con dos agendas apuntando al mismo Google
  // Calendar falle cerrada antes de POST/PATCH/DELETE, aunque haya pasado una
  // validación anterior o la corrupción exista desde una versión vieja.
  assertUniqueGoogleCalendarOwner({
    googleCalendarId: normalizedGoogleCalendarId,
    localCalendarId: normalizedLocalCalendarId,
    linkedCalendars: await localCalendarService.listGoogleLinkedLocalCalendars({ includeInactive: true })
  })
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
      assertUniqueGoogleCalendarOwner({
        googleCalendarId,
        localCalendarId: localCalendar.id,
        linkedCalendars: await localCalendarService.listGoogleLinkedLocalCalendars({ includeInactive: true })
      })
      return [{
        googleCalendarId,
        localCalendarId: localCalendar.id
      }]
    }

    return []
  }

  const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars()
  for (const calendar of linkedCalendars) {
    assertUniqueGoogleCalendarOwner({
      googleCalendarId: googleCalendarIdFromLocalCalendar(calendar),
      localCalendarId: calendar.id,
      linkedCalendars
    })
  }
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
  // (GCAL-004) Zona de la cuenta para anclar los eventos all-day al día correcto.
  const accountTimezone = await getAccountTimezone()
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
        const cancellation = await deleteLocalAppointmentForCancelledGoogleEvent(event, {
          calendarId: target.localCalendarId,
          providerCalendarId: target.googleCalendarId
        })
        if (cancellation.deleted) {
          deleted += 1
        }
        continue
      }

      if (!event.start) continue

      let appointment = googleEventToAppointment(event, {
        calendarId: target.localCalendarId,
        timezone: accountTimezone // (GCAL-004)
      })

      if (!appointment.startTime || !appointment.endTime) continue

      const localCalendarId = await resolveLocalCalendarId(appointment.calendarId)
      const localCalendar = await localCalendarService.getLocalCalendar(localCalendarId)
      appointment.calendarId = localCalendarId
      appointment.locationId = localCalendar?.locationId || null
      let existingAppointment = await localCalendarService.getLocalAppointment(appointment.id).catch(() => null)
      if (appointment.source !== 'google_shadow') {
        const existingByRemoteId = await localCalendarService.getLocalAppointment(event.id).catch(() => null)
        if (existingByRemoteId?.id) existingAppointment = existingByRemoteId
      }

      if (appointment.source === 'ristak' && !existingAppointment?.id) {
        // La metadata privada de Google no tiene autoridad para inventar o
        // resucitar una cita canónica que ya no existe en Ristak.
        appointment = {
          ...appointment,
          id: localIdForGoogleOwnershipShadow(event.id, localCalendarId),
          googleEventId: null,
          source: 'google_shadow'
        }
        existingAppointment = await localCalendarService.getLocalAppointment(appointment.id).catch(() => null)
      }

      if (
        existingAppointment?.id &&
        isRistakCanonicalAppointment(existingAppointment) &&
        cleanString(existingAppointment.calendarId) === localCalendarId
      ) {
        const storedProvider = cleanString(existingAppointment.googleProviderCalendarId)
        if (storedProvider && storedProvider.toLowerCase() !== target.googleCalendarId.toLowerCase()) {
          // No reasignamos la propiedad remota de una cita canónica con sólo
          // verla desde otro destino. Materializamos una sombra de ocupación.
          appointment = {
            ...appointment,
            id: localIdForGoogleOwnershipShadow(event.id, localCalendarId),
            googleEventId: null,
            source: 'google_shadow'
          }
          existingAppointment = await localCalendarService.getLocalAppointment(appointment.id).catch(() => null)
        } else {
          if (googleMirrorMatchesCanonicalAppointment(event, existingAppointment)) {
            await markGoogleSyncSuccess(existingAppointment.id, event.id, target.googleCalendarId, {
              expectedAppointment: existingAppointment,
              failOnStale: false
            })
          } else {
            await markGoogleMirrorPending(
              existingAppointment.id,
              event.id,
              target.googleCalendarId,
              'Google modificó la copia; Ristak conservará y volverá a publicar la cita local.',
              { expectedAppointment: existingAppointment }
            )
          }
          saved += 1
          continue
        }
      }

      // (GCAL-006) Enlazar/crear contacto por email (y teléfono si viniera) del invitado
      // ANTES del upsert, para que la cita entrante de Google entre al MISMO flujo de
      // recordatorios/automatizaciones (cron-driven por contact_id) que una cita normal.
      // upsertLocalAppointment ya llama updateContactAppointmentDate cuando hay contactId.
      if (!appointment.contactId && (appointment.guestEmail || existingAppointment?.contactId)) {
        if (existingAppointment?.contactId) {
          // (GCAL-006) Si ya existía con contacto, conservarlo (no pisar el enlace previo).
          appointment.contactId = existingAppointment.contactId
        } else {
          try {
            const resolvedContactId = await localCalendarService.resolveOrCreateContactForGoogleAppointment({
              email: appointment.guestEmail,
              name: appointment.guestName
            })
            if (resolvedContactId) {
              appointment.contactId = resolvedContactId
            } else {
              // (GCAL-006) Invitado sin datos utilizables: la cita entra sin contacto, como hoy.
              logger.info(`(GCAL-006) Evento de Google ${event.id} entró sin datos de contacto utilizables; cita sin contacto.`)
            }
          } catch (contactError) {
            // (GCAL-006) No romper el sync si falla la resolución de contacto: degradar a cita sin contacto.
            logger.warn(`(GCAL-006) No se pudo resolver/crear contacto para evento de Google ${event.id}: ${contactError.message}`)
          }
        }
      } else if (!appointment.contactId) {
        // (GCAL-006) Evento sin attendees utilizables y sin contacto previo: cita sin contacto.
        logger.info(`(GCAL-006) Evento de Google ${event.id} sin invitado con email; cita sin contacto.`)
      }

      const ownershipShadow = appointment.source === 'google_shadow'
      await localCalendarService.upsertLocalAppointment(appointment, {
        id: appointment.id,
        source: appointment.source,
        googleEventId: ownershipShadow ? null : event.id,
        googleProviderCalendarId: target.googleCalendarId,
        calendarId: localCalendarId,
        locationId: localCalendar?.locationId || null,
        syncStatus: existingAppointment?.syncStatus || (appointment.source === 'ristak' ? 'pending' : 'synced'),
        googleSyncStatus: 'synced',
        // (GCAL-003) Pull entrante de Google: last-write-wins por date_updated para no pisar
        // una edición local fresca con el evento viejo de Google cuando el push falló o no corrió.
        lastWriteWins: true
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
    // Ristak manda: primero publicamos/migramos las citas canónicas y después
    // importamos ocupación externa. Así un pull nunca roba la procedencia A→B.
    const outboundResult = await syncLocalAppointmentsToGoogle()
    const eventsResult = await syncGoogleEventsToLocal({
      startTime: syncStart,
      endTime: syncEnd,
      config
    })
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

// (GCAL-002) Reintento periódico de la sincronización Google<->local para las citas que
// quedaron en error/pendiente. Es idempotente y acotado:
//  - Pull Google->local: `syncGoogleEventsToLocal` (last-write-wins por date_updated, no pisa
//    ediciones locales frescas; cancelados se soft-cancelan, nunca hard-delete - ver GCAL-001/003).
//  - Push local->Google: `syncLocalAppointmentsToGoogle` SOLO selecciona citas con
//    google_sync_status != 'synced' o sin google_event_id (las que fallaron/están pendientes),
//    con LIMIT acotado; las ya sincronizadas se saltan. Eso es exactamente "reintentar las que
//    quedaron con error/pendiente".
// Si Google no está conectado o no hay calendarios vinculados, hace no-op seguro (no lanza),
// para que el cron no genere ruido ni falle cuando la integración no está activa.
// NO cambia las firmas existentes; reutiliza syncGoogleIntegrationNow tal cual.
export async function retryGoogleCalendarSync() {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    return { enabled: false, ran: false }
  }

  // Reutiliza el flujo completo (pull + push) ya probado. syncGoogleIntegrationNow
  // persiste lastSyncStatus/lastSyncMessage y, si hay 0 calendarios vinculados,
  // simplemente devuelve 0 sincronizadas sin tocar nada (degradación segura).
  const result = await syncGoogleIntegrationNow()
  return { enabled: true, ran: true, sync: result?.sync || null }
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

  const previousGoogleCalendarId = googleCalendarIdFromLocalCalendar(localCalendar)
  const normalizedGoogleCalendarId = normalizeGoogleCalendarIdInput(googleCalendarId)
  if (!normalizedGoogleCalendarId) {
    const affectedContacts = []
    const updated = await db.transaction(async () => {
      if (previousGoogleCalendarId) {
        await db.run(`
          UPDATE appointments
          SET google_provider_calendar_id = COALESCE(NULLIF(google_provider_calendar_id, ''), ?)
          WHERE calendar_id = ? AND COALESCE(google_event_id, '') != ''
        `, [previousGoogleCalendarId, localCalendar.id])
      }
      const rows = await db.all(`
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE calendar_id = ?
          AND source IN ('google', 'google_shadow')
          AND contact_id IS NOT NULL
      `, [localCalendar.id])
      affectedContacts.push(...rows.map(row => row.contact_id).filter(Boolean))
      await db.run(`
        DELETE FROM appointment_participants
        WHERE appointment_id IN (
          SELECT id FROM appointments
          WHERE calendar_id = ? AND source IN ('google', 'google_shadow')
        )
      `, [localCalendar.id])
      await db.run(
        "DELETE FROM appointments WHERE calendar_id = ? AND source IN ('google', 'google_shadow')",
        [localCalendar.id]
      )
      const updated = await localCalendarService.updateLocalCalendar(localCalendar.id, {
        googleCalendarId: '',
        googleAccessRole: '',
        googleCalendarSummary: '',
        googleCalendarTimeZone: ''
      }, {
        syncStatus: localCalendar.syncStatus || 'pending',
        allowGoogleSyncMetadata: true
      })
      return updated
    })
    for (const contactId of [...new Set(affectedContacts)]) {
      await localCalendarService.updateContactAppointmentDate(contactId)
    }
    return updated
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

  const affectedContacts = []
  const updated = await db.transaction(async () => {
    // Serializa la elección aunque dos pestañas intenten ligar el mismo Google
    // Calendar al mismo tiempo. Como el ID vive dentro de raw_json, el candado
    // explícito sobre las agendas sustituye una restricción UNIQUE tradicional.
    await db.all(
      `SELECT id FROM calendars ORDER BY id${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`
    )
    const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars({ includeInactive: true })
    assertUniqueGoogleCalendarOwner({
      googleCalendarId: googleCalendar.id,
      localCalendarId: localCalendar.id,
      linkedCalendars
    })
    const linkChanged = previousGoogleCalendarId.toLowerCase() !== googleCalendar.id.toLowerCase()
    if (linkChanged) {
      if (previousGoogleCalendarId) {
        await db.run(`
          UPDATE appointments
          SET google_provider_calendar_id = COALESCE(NULLIF(google_provider_calendar_id, ''), ?)
          WHERE calendar_id = ? AND COALESCE(google_event_id, '') != ''
        `, [previousGoogleCalendarId, localCalendar.id])
      }
      const rows = await db.all(`
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE calendar_id = ?
          AND source IN ('google', 'google_shadow')
          AND contact_id IS NOT NULL
      `, [localCalendar.id])
      affectedContacts.push(...rows.map(row => row.contact_id).filter(Boolean))
      await db.run(`
        DELETE FROM appointment_participants
        WHERE appointment_id IN (
          SELECT id FROM appointments
          WHERE calendar_id = ? AND source IN ('google', 'google_shadow')
        )
      `, [localCalendar.id])
      await db.run(
        "DELETE FROM appointments WHERE calendar_id = ? AND source IN ('google', 'google_shadow')",
        [localCalendar.id]
      )
      await db.run(`
        UPDATE appointments
        SET google_sync_status = 'pending',
            google_sync_error = 'El calendario espejo cambió; Ristak migrará la copia sin alterar la cita local.'
        WHERE calendar_id = ?
          AND deleted_at IS NULL
          AND (COALESCE(source, 'ristak') = 'ristak' OR id LIKE 'rstk_appt_%')
      `, [localCalendar.id])
    }
    return localCalendarService.updateLocalCalendar(localCalendar.id, {
      googleCalendarId: googleCalendar.id,
      googleAccessRole: googleCalendar.accessRole,
      googleCalendarSummary: googleCalendar.summary,
      googleCalendarTimeZone: googleCalendar.timeZone
    }, {
      syncStatus: localCalendar.syncStatus || 'pending',
      allowGoogleSyncMetadata: true
    })
  })
  for (const contactId of [...new Set(affectedContacts)]) {
    await localCalendarService.updateContactAppointmentDate(contactId)
  }
  return updated
}

export async function syncGoogleEventsForDateRange({ startDate, endDate, timezone = null, calendarId = null } = {}) {
  const zone = timezone || await getAccountTimezone()
  const start = normalizeToUtcIso(`${startDate}T00:00:00`, zone)
  const end = normalizeToUtcIso(`${endDate}T23:59:59`, zone)
  return syncGoogleEventsToLocal({ startTime: start, endTime: end, calendarId })
}

function buildGoogleAttendees(participants = []) {
  const attendees = []
  const seenEmails = new Set()

  for (const participant of Array.isArray(participants) ? participants : []) {
    const email = cleanString(participant?.email || participant?.emailSnapshot || participant?.email_snapshot).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seenEmails.has(email)) continue
    seenEmails.add(email)

    const displayName = cleanString(
      participant?.name || participant?.nameSnapshot || participant?.name_snapshot
    )
    attendees.push({
      email,
      ...(displayName ? { displayName } : {})
    })
  }

  return attendees
}

export function buildGoogleEventPayload(appointment = {}, timezone = 'UTC') {
  const status = cleanString(appointment.appointmentStatus || appointment.status).toLowerCase()
  const title = cleanString(appointment.title) || 'Cita'
  const isTest = Boolean(appointment.isTest || appointment.is_test)
  const privateProperties = {
    ristakAppointmentId: cleanString(appointment.id),
    ristakCalendarId: cleanString(appointment.calendarId),
    source: isTest ? 'ristak_test' : 'ristak',
    ...(isTest
      ? {
          ristakTestRunId: cleanString(appointment.testRunId || appointment.test_run_id),
          ristakTestEffectId: cleanString(appointment.testEffectId || appointment.test_effect_id),
          ristakTestExpiresAt: cleanString(appointment.testExpiresAt || appointment.test_expires_at)
        }
      : {})
  }

  return {
    summary: title,
    description: cleanString(appointment.notes || appointment.description),
    location: cleanString(appointment.address),
    attendees: buildGoogleAttendees(appointment.participants),
    start: {
      dateTime: normalizeToUtcIso(appointment.startTime, timezone),
      timeZone: timezone
    },
    end: {
      dateTime: normalizeToUtcIso(appointment.endTime || appointment.startTime, timezone),
      timeZone: timezone
    },
    // Una cita pendiente (auto_confirm apagado, sin confirmar aún) vive en Google como
    // 'tentative', no 'confirmed': así no aparenta estar confirmada hasta que el contacto,
    // el equipo o una automatización la confirme y se re-sincronice como 'confirmed'.
    status: status === 'cancelled' || status === 'canceled'
      ? 'cancelled'
      : (status === 'pending' ? 'tentative' : 'confirmed'),
    extendedProperties: {
      private: privateProperties
    }
  }
}

function googleMirrorResponseStaleError() {
  const error = new Error('La cita cambió mientras respondía Google. Se conservó la versión local más reciente para volver a sincronizarla.')
  error.status = 409
  error.statusCode = 409
  error.code = 'appointment_provider_response_stale'
  return error
}

function googleMirrorFence(expectedAppointment = null) {
  if (!expectedAppointment || typeof expectedAppointment !== 'object') {
    return { sql: '', params: [] }
  }

  const dateUpdated = normalizeToUtcIso(
    expectedAppointment.dateUpdated || expectedAppointment.date_updated,
    'UTC'
  )
  if (!dateUpdated) throw new Error('La versión local esperada de la cita no es válida')

  return {
    sql: `
      AND date_updated = ?
      AND COALESCE(google_event_id, '') = ?
      AND COALESCE(google_provider_calendar_id, '') = ?
      AND COALESCE(google_mirror_generation, 0) = ?
    `,
    params: [
      dateUpdated,
      cleanString(expectedAppointment.googleEventId || expectedAppointment.google_event_id),
      cleanString(expectedAppointment.googleProviderCalendarId || expectedAppointment.google_provider_calendar_id),
      Math.max(0, Math.trunc(Number(
        expectedAppointment.googleMirrorGeneration ?? expectedAppointment.google_mirror_generation ?? 0
      ) || 0))
    ]
  }
}

async function preserveGoogleMirrorPendingAfterStale(appointmentId) {
  if (!appointmentId) return null
  await db.run(`
    UPDATE appointments
    SET google_sync_status = 'pending'
    WHERE id = ?
  `, [appointmentId])
  return localCalendarService.getLocalAppointment(appointmentId)
}

async function markGoogleSyncError(appointmentId, message, { expectedAppointment = null } = {}) {
  if (!appointmentId) return
  const fence = googleMirrorFence(expectedAppointment)
  const result = await db.run(`
    UPDATE appointments
    SET google_sync_status = 'error',
        google_sync_error = ?
    WHERE id = ?
    ${fence.sql}
  `, [message, appointmentId, ...fence.params])

  if (expectedAppointment && Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    return preserveGoogleMirrorPendingAfterStale(appointmentId)
  }
  return localCalendarService.getLocalAppointment(appointmentId)
}

async function markGoogleSyncSuccess(
  appointmentId,
  eventId,
  providerCalendarId = null,
  { expectedAppointment = null, failOnStale = true } = {}
) {
  if (!appointmentId) return null
  const fence = googleMirrorFence(expectedAppointment)
  const result = await db.run(`
    UPDATE appointments
    SET google_event_id = ?,
        google_provider_calendar_id = ?,
        google_sync_status = 'synced',
        google_sync_error = NULL,
        google_synced_at = CURRENT_TIMESTAMP
    WHERE id = ?
    ${fence.sql}
  `, [eventId || null, cleanString(providerCalendarId) || null, appointmentId, ...fence.params])

  if (expectedAppointment && Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    const current = await preserveGoogleMirrorPendingAfterStale(appointmentId)
    if (failOnStale) throw googleMirrorResponseStaleError()
    return current
  }

  return localCalendarService.getLocalAppointment(appointmentId)
}

async function markGoogleMirrorPending(
  appointmentId,
  eventId,
  providerCalendarId,
  message,
  { expectedAppointment = null } = {}
) {
  if (!appointmentId) return null
  const fence = googleMirrorFence(expectedAppointment)
  const result = await db.run(`
    UPDATE appointments
    SET google_event_id = COALESCE(?, google_event_id),
        google_provider_calendar_id = COALESCE(?, google_provider_calendar_id),
        google_sync_status = 'pending',
        google_sync_error = ?
    WHERE id = ?
    ${fence.sql}
  `, [
    cleanString(eventId) || null,
    cleanString(providerCalendarId) || null,
    cleanString(message).slice(0, 1000) || 'El espejo de Google necesita repararse desde Ristak.',
    appointmentId,
    ...fence.params
  ])
  if (expectedAppointment && Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    return preserveGoogleMirrorPendingAfterStale(appointmentId)
  }
  return localCalendarService.getLocalAppointment(appointmentId)
}

async function rotateGoogleMirrorGeneration({
  appointmentId,
  expectedGeneration = 0,
  expectedEventId = '',
  providerCalendarId = '',
  message = ''
} = {}) {
  const normalizedProviderCalendarId = cleanString(providerCalendarId)
  await db.run(`
    UPDATE appointments
    SET google_event_id = NULL,
        google_provider_calendar_id = COALESCE(?, google_provider_calendar_id),
        google_mirror_generation = COALESCE(google_mirror_generation, 0) + 1,
        google_sync_status = 'pending',
        google_sync_error = ?
    WHERE id = ?
      AND COALESCE(google_mirror_generation, 0) = ?
      AND COALESCE(google_event_id, '') = ?
      AND (
        COALESCE(google_provider_calendar_id, '') = ''
        OR LOWER(google_provider_calendar_id) = LOWER(?)
      )
  `, [
    normalizedProviderCalendarId || null,
    cleanString(message).slice(0, 1000) || 'La copia anterior de Google quedó inválida; se publicará una generación nueva.',
    appointmentId,
    Math.max(0, Math.trunc(Number(expectedGeneration) || 0)),
    cleanString(expectedEventId),
    normalizedProviderCalendarId
  ])
  return localCalendarService.getLocalAppointment(appointmentId)
}

async function resolveAppointment(appointmentOrId) {
  if (typeof appointmentOrId === 'string') {
    return localCalendarService.getLocalAppointment(appointmentOrId)
  }

  if (!appointmentOrId?.id || Array.isArray(appointmentOrId.participants)) {
    return appointmentOrId
  }

  const participants = await localCalendarService.getAppointmentParticipants(appointmentOrId.id)
  return { ...appointmentOrId, participants }
}

function isAmbiguousGoogleWriteError(error) {
  const status = Number(error?.status || 0)
  return !status || status === 408 || status === 409 || status === 429 || status >= 500
}

async function findGoogleEventAfterAmbiguousWrite({ config, calendarId, eventId }) {
  try {
    const event = await getGoogleEvent(eventId, { config, calendarId })
    return cleanString(event?.id) ? event : null
  } catch (error) {
    if (error.status === 404 || error.status === 410) return null
    throw error
  }
}

export async function syncAppointmentToGoogle(appointmentOrId) {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    return { enabled: false, appointment: appointmentOrId }
  }

  const appointment = await resolveAppointment(appointmentOrId)
  let mirrorFenceAppointment = appointment

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

    // Preflight temprano: en una BD legacy corrupta no hacemos ni siquiera la
    // reconciliación remota. Además se repite justo antes de cada write para no
    // depender de una comprobación que pudo quedar vieja.
    await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
      googleCalendarId: targetGoogleCalendarId,
      localCalendarId: appointment.calendarId
    })

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
    let storedEventId = cleanString(appointment.googleEventId)
    const storedProviderCalendarId = cleanString(appointment.googleProviderCalendarId)

    // Si la agenda cambió de Google A a Google B, primero retiramos la copia de
    // A. No hacemos un PATCH ciego en B con un ID que pertenece a otro calendario
    // ni creamos dos espejos cuando el DELETE anterior quedó ambiguo.
    if (
      storedEventId &&
      storedProviderCalendarId &&
      storedProviderCalendarId.toLowerCase() !== targetGoogleCalendarId.toLowerCase()
    ) {
      await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
        googleCalendarId: storedProviderCalendarId,
        localCalendarId: appointment.calendarId
      })
      try {
        await googleRequest(config, eventWritePath(storedProviderCalendarId, storedEventId), {
          method: 'DELETE'
        })
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error
      }
      mirrorFenceAppointment = await markGoogleSyncSuccess(appointment.id, null, null, {
        expectedAppointment: mirrorFenceAppointment
      })
      storedEventId = ''
    }

    let eventId = storedEventId || googleAppointmentEventIdForLocalAppointment(
      appointment.id,
      appointment.googleMirrorGeneration
    )
    let remote
    let testReceipt = null

    if (appointment.isTest) {
      eventId = googleTestEventIdForEffect(appointment.testEffectId)
      testReceipt = await localCalendarService.prepareConversationalTestAppointmentProviderCommand({
        appointmentId: appointment.id,
        testEffectId: appointment.testEffectId,
        testRunId: appointment.testRunId,
        provider: 'google',
        externalId: eventId,
        commandKey: `google:${appointment.testEffectId}:${targetGoogleCalendarId}`,
        idempotencyMarker: eventId,
        commandPayload: {
          providerCalendarId: targetGoogleCalendarId,
          localCalendarId: appointment.calendarId,
          eventId,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
          contactId: appointment.contactId
        },
        calendarId: appointment.calendarId,
        cleanupDueAt: appointment.testExpiresAt
      })

      // Todo reintento comienza reconciliando el ID determinista. Aunque el
      // proceso anterior muriera tras POST, GET recupera el evento sin duplicarlo.
      try {
        remote = await findGoogleEventAfterAmbiguousWrite({
          config,
          calendarId: targetGoogleCalendarId,
          eventId
        })
        await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
          receiptId: testReceipt.id,
          externalId: eventId,
          remoteStatus: remote ? 'created' : 'absent',
          reconciled: true
        })
      } catch (reconcileError) {
        await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
          receiptId: testReceipt.id,
          remoteStatus: 'remote_outcome_unknown',
          remoteError: reconcileError.message,
          reconciled: true
        })
        throw new Error(`No se pudo reconciliar el evento determinista de Google: ${reconcileError.message}`, { cause: reconcileError })
      }
    }

    if (storedEventId && !appointment.isTest) {
      await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
        googleCalendarId: targetGoogleCalendarId,
        localCalendarId: appointment.calendarId
      })
      try {
        remote = await googleRequest(config, eventWritePath(targetGoogleCalendarId, eventId), {
          method: 'PATCH',
          body: JSON.stringify(payload)
        })
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error
        eventId = googleAppointmentEventIdForLocalAppointment(
          appointment.id,
          appointment.googleMirrorGeneration
        )
      }
    }

    if (!remote) {
      const requestedEventId = eventId
      await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
        googleCalendarId: targetGoogleCalendarId,
        localCalendarId: appointment.calendarId
      })
      try {
        remote = await googleRequest(config, eventWritePath(targetGoogleCalendarId), {
          method: 'POST',
          body: JSON.stringify({ id: requestedEventId, ...payload })
        })
        eventId = remote?.id || requestedEventId
      } catch (writeError) {
        if (!isAmbiguousGoogleWriteError(writeError)) throw writeError
        try {
          remote = await findGoogleEventAfterAmbiguousWrite({
            config,
            calendarId: targetGoogleCalendarId,
            eventId: requestedEventId
          })
        } catch (reconcileError) {
          if (appointment.isTest) {
            await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
              receiptId: testReceipt.id,
              remoteStatus: 'remote_outcome_unknown',
              remoteError: `${writeError.message} | reconcile: ${reconcileError.message}`,
              reconciled: true
            })
          }
          throw new Error(`Google no confirmó si creó el espejo de la cita local: ${reconcileError.message}`, { cause: writeError })
        }
        if (!remote) {
          if (appointment.isTest) {
            await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
              receiptId: testReceipt.id,
              remoteStatus: 'absent',
              remoteError: writeError.message,
              reconciled: true
            })
          }
          throw writeError
        }
        if (mapGoogleEventStatus(remote) === 'cancelled') {
          await rotateGoogleMirrorGeneration({
            appointmentId: appointment.id,
            expectedGeneration: appointment.googleMirrorGeneration,
            expectedEventId: requestedEventId,
            providerCalendarId: targetGoogleCalendarId,
            message: `Google devolvió un tombstone cancelado para ${requestedEventId}; se rotará el ID del espejo.`
          })
          throw new Error('Google reconcilió un evento cancelado; Ristak conservará la cita y usará un ID de espejo nuevo.')
        }
        eventId = remote.id || requestedEventId
        // El ID determinista también puede pertenecer a un intento anterior cuya
        // respuesta llegó después de una edición local. Encontrarlo evita el
        // duplicado, pero no demuestra que contenga la versión vigente: si
        // difiere, imponemos la cita canónica con PATCH antes de marcar synced.
        if (!googleMirrorMatchesCanonicalAppointment(remote, appointment)) {
          await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
            googleCalendarId: targetGoogleCalendarId,
            localCalendarId: appointment.calendarId
          })
          remote = await googleRequest(config, eventWritePath(targetGoogleCalendarId, eventId), {
            method: 'PATCH',
            body: JSON.stringify(payload)
          })
        }
      }
    }

    if (!eventId) {
      throw new Error('Google Calendar no devolvio ID de evento')
    }
    if (mapGoogleEventStatus(remote) === 'cancelled') {
      await rotateGoogleMirrorGeneration({
        appointmentId: appointment.id,
        expectedGeneration: appointment.googleMirrorGeneration,
        expectedEventId: eventId,
        providerCalendarId: targetGoogleCalendarId,
        message: `Google devolvió cancelado el espejo ${eventId}; se rotará su ID.`
      })
      throw new Error('Google devolvió un espejo cancelado; la cita local se conserva para reintentar con otro ID.')
    }

    if (appointment.isTest) {
      await localCalendarService.markConversationalTestAppointmentProviderRemoteStatus({
        receiptId: testReceipt.id,
        externalId: eventId,
        remoteStatus: 'created',
        reconciled: true
      })
    }

    const updated = await markGoogleSyncSuccess(appointment.id, eventId, targetGoogleCalendarId, {
      expectedAppointment: mirrorFenceAppointment
    })
    return { enabled: true, appointment: updated || appointment, event: remote }
  } catch (error) {
    if (error?.code === 'appointment_provider_response_stale') {
      await preserveGoogleMirrorPendingAfterStale(appointment.id)
    } else {
      await markGoogleSyncError(appointment.id, error.message, {
        expectedAppointment: mirrorFenceAppointment
      })
    }
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

  const targetOwnershipConditions = linkedCalendars.map(() => `(
    calendar_id = ? AND (
      COALESCE(google_sync_status, '') != 'synced'
      OR COALESCE(google_event_id, '') = ''
      OR COALESCE(google_provider_calendar_id, '') = ''
      OR LOWER(google_provider_calendar_id) != LOWER(?)
    )
  )`)
  const targetOwnershipParams = linkedCalendars.flatMap(calendar => [
    cleanString(calendar.id),
    googleCalendarIdFromLocalCalendar(calendar)
  ])

  const conditions = [
    'deleted_at IS NULL',
    "COALESCE(sync_status, '') != 'pending_delete'",
    `(
      (
        (COALESCE(source, 'ristak') = 'ristak' OR id LIKE 'rstk_appt_%')
        AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'invalid')
      )
      OR (
        LOWER(COALESCE(appointment_status, status, '')) IN ('cancelled', 'canceled')
        AND COALESCE(google_event_id, '') != ''
      )
    )`,
    `(${targetOwnershipConditions.join(' OR ')})`
  ]
  const params = targetOwnershipParams

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
        WHEN LOWER(COALESCE(c.slug, '')) = 'calendario-ristak' THEN 0
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

function googleTestCleanupAuthorityError(message, code, status = 403) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.statusCode = status
  return error
}

/**
 * Borra exclusivamente el evento Google autorizado por un receipt durable de
 * Modo test. No usa el owner actual del calendario local: ese vínculo puede
 * haber cambiado después del POST original. La autoridad queda cerrada por
 * receipt + effect + run + ID determinista + provider original.
 */
export async function deleteConversationalTestGoogleEventFromReceipt({
  receiptId,
  testEffectId
} = {}) {
  const cleanReceiptId = cleanString(receiptId)
  const cleanEffectId = cleanString(testEffectId)
  if (!cleanReceiptId || !cleanEffectId) {
    throw googleTestCleanupAuthorityError(
      'La limpieza Google de prueba requiere receipt y effect durables.',
      'test_google_cleanup_receipt_required',
      400
    )
  }

  const authority = await db.get(`
    SELECT
      r.id, r.test_effect_id, r.test_run_id, r.appointment_id, r.provider,
      r.external_id, r.command_json,
      e.effect_type, e.entity_id AS effect_entity_id, e.run_id AS effect_run_id,
      a.id AS local_appointment_id, a.is_test AS appointment_is_test,
      a.test_effect_id AS appointment_test_effect_id,
      a.test_run_id AS appointment_test_run_id,
      a.google_provider_calendar_id
    FROM conversational_appointment_test_provider_receipts r
    INNER JOIN conversational_agent_test_effects e
      ON e.id = r.test_effect_id AND e.run_id = r.test_run_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
    WHERE r.id = ?
    LIMIT 1
  `, [cleanReceiptId])
  if (
    !authority ||
    cleanString(authority.provider).toLowerCase() !== 'google' ||
    cleanString(authority.test_effect_id) !== cleanEffectId ||
    cleanString(authority.effect_type) !== 'appointment' ||
    cleanString(authority.effect_run_id) !== cleanString(authority.test_run_id) ||
    (
      cleanString(authority.effect_entity_id) &&
      cleanString(authority.effect_entity_id) !== cleanString(authority.appointment_id)
    ) ||
    (
      cleanString(authority.local_appointment_id) &&
      (
        Number(authority.appointment_is_test || 0) !== 1 ||
        cleanString(authority.appointment_test_effect_id) !== cleanEffectId ||
        cleanString(authority.appointment_test_run_id) !== cleanString(authority.test_run_id)
      )
    )
  ) {
    throw googleTestCleanupAuthorityError(
      'El receipt no autoriza limpiar este evento Google de prueba.',
      'test_google_cleanup_receipt_mismatch'
    )
  }

  const externalId = cleanString(authority.external_id)
  const deterministicId = googleTestEventIdForEffect(cleanEffectId)
  if (!externalId || externalId !== deterministicId) {
    throw googleTestCleanupAuthorityError(
      'El receipt no conserva el ID determinista del evento Google de prueba.',
      'test_google_cleanup_event_identity_mismatch'
    )
  }

  const command = parseJson(authority.command_json, {}) || {}
  if (cleanString(command.eventId) && cleanString(command.eventId) !== externalId) {
    throw googleTestCleanupAuthorityError(
      'El comando y el receipt apuntan a eventos Google distintos.',
      'test_google_cleanup_command_mismatch'
    )
  }
  const providerCalendarId = normalizeGoogleCalendarIdInput(
    command.providerCalendarId || authority.google_provider_calendar_id
  )
  if (!providerCalendarId) {
    throw googleTestCleanupAuthorityError(
      'El receipt no conserva el calendario Google original y no se puede borrar con seguridad.',
      'test_google_cleanup_provider_identity_required',
      409
    )
  }

  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) return { enabled: false, deleted: false }

  try {
    await googleRequest(config, eventWritePath(providerCalendarId, externalId), {
      method: 'DELETE'
    })
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error
  }
  return {
    enabled: true,
    deleted: true,
    eventId: externalId,
    providerCalendarId
  }
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
    const targetGoogleCalendarId = cleanString(appointment.googleProviderCalendarId)
      || googleCalendarIdFromLocalCalendar(localCalendar)
      || cleanString(config.calendarId)
    if (!targetGoogleCalendarId) {
      return { enabled: false, deleted: false, reason: 'calendar_not_linked' }
    }

    await assertUniqueGoogleCalendarOwnerBeforeOutboundWrite({
      googleCalendarId: targetGoogleCalendarId,
      localCalendarId: appointment.calendarId
    })
    await googleRequest(config, eventWritePath(targetGoogleCalendarId, appointment.googleEventId), {
      method: 'DELETE'
    })
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) {
      await markGoogleSyncError(appointment.id, error.message, { expectedAppointment: appointment })
      throw error
    }
  }

  await markGoogleSyncSuccess(appointment.id, null, null, { expectedAppointment: appointment })
  return { enabled: true, deleted: true }
}

export async function testGoogleCalendarConnection() {
  const config = await getGoogleCalendarConfig({ includeCredentials: true })
  if (!config) {
    throw new Error('Conecta primero Google Calendar con OAuth')
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
  deleteConversationalTestGoogleEventFromReceipt,
  deleteGoogleCalendarConfig,
  deleteGoogleEventForAppointment,
  getGoogleCalendarConfig,
  getGoogleCalendarMergePreview,
  getGoogleCalendarMetadata,
  googleAppointmentEventIdForLocalAppointment,
  googleEventToAppointment,
  listGoogleCalendarOptions,
  listGoogleCalendars,
  listGoogleEvents,
  mergeRistakAppointmentsIntoGoogle,
  retryGoogleCalendarSync, // (GCAL-002)
  saveGoogleCalendarOAuthConnection,
  syncAppointmentToGoogle,
  syncLocalAppointmentsToGoogle,
  syncGoogleCalendarsToLocal,
  syncGoogleEventsForDateRange,
  syncGoogleEventsToLocal,
  syncGoogleIntegrationNow,
  testGoogleCalendarConnection,
  updateLocalCalendarGoogleSync
}
