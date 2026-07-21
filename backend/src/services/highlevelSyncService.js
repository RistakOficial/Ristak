/**
 * HIGHLEVEL SYNC SERVICE
 * Sincroniza contactos, citas y pagos desde HighLevel
 */

import fetch from 'node-fetch'
import { db, setAppConfig, getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { formatDate } from '../utils/dateUtils.js'
import { getMetaConfig, saveMetaConfig, syncMetaAds } from './metaAdsService.js'
import {
  fetchHighLevelContactCustomFieldDefinitions,
  resolveHighLevelContactCustomFields
} from './highlevelCustomFieldsService.js'
import { hasContactCustomFieldsPayload } from '../utils/contactCustomFields.js'
import {
  finalizePreparedPhoneUpsert,
  linkContactToGhl,
  mergeContactIds,
  prepareContactPhoneUpsert,
  resolveContactIdByGhlId,
  resolveOrCreateContactForGhl
} from './contactIdentityService.js'
import { sanitizeContactName, normalizePhoneDigits } from '../utils/phoneUtils.js'
import { formatContactName, splitContactName } from '../utils/contactNameFormatter.js'
import GHLClient from './ghlClient.js'
import {
  claimPreparedHighLevelMirrorIntent,
  getLocalCalendar,
  inspectInboundHighLevelAppointment,
  reconcileInboundHighLevelAppointment,
  syncLocalAppointmentsToHighLevel,
  syncLocalCalendarsToHighLevel,
  upsertLocalCalendar
} from './localCalendarService.js'
import { syncProductsWithHighLevel } from './localProductService.js'
import { iterateHighLevelContactPages } from './highlevelContactSearchService.js'
import { createSingleFlightRunner } from '../utils/singleFlight.js'

const HIGHLEVEL_BASE_URL = 'https://services.leadconnectorhq.com'
const HIGHLEVEL_API_VERSION = '2021-07-28'
const MASKED_SECRET_PREFIX = '***'
const META_CUSTOM_VALUE_FIELDS = [
  { key: 'adAccountId', names: ['Facebook - Ad Account ID'] },
  { key: 'accessToken', names: ['Facebook - App Access Token'], secret: true },
  { key: 'pixelId', names: ['Facebook - Pixel ID', 'pixel_id'] },
  { key: 'pageId', names: ['Facebook - Page ID'] },
  { key: 'instagramAccountId', names: ['Facebook - Instagram Account ID', 'Instagram Account ID'] },
  { key: 'whatsappBusinessAccountId', names: ['Facebook - WhatsApp Business Account ID', 'WhatsApp Business Account ID', 'WABA ID'] }
]
const HIGHLEVEL_CONVERSATION_BACKGROUND_THRESHOLD = 100

let backgroundConversationSyncRunning = false
const runHighLevelSyncSingleFlight = createSingleFlightRunner({
  onDuplicate: () => logger.info('[HighLevel Sync] Ya hay una sincronización completa en curso; se reutiliza la ejecución activa')
})

// Variable global para trackear el estado de sincronización
let syncProgress = {
  status: 'idle',
  step: '',
  total: 0,
  current: 0,
  message: '',
  triggerSource: 'manual', // 'manual' o 'cron' - indica si se debe mostrar en UI
  contacts: { saved: 0, total: 0, status: 'pending', message: '' },
  whatsappContacts: { saved: 0, total: 0, status: 'pending', message: '' },
  appointments: { saved: 0, total: 0, status: 'pending', message: '' },
  products: { saved: 0, total: 0, status: 'pending', message: '' },
  payments: { saved: 0, total: 0, status: 'pending', message: '' },
  conversations: { saved: 0, total: 0, status: 'pending', message: '' },
  metaAds: { synced: false, count: 0, saved: 0, total: 0, status: 'pending', message: '' }
}

export function getSyncProgress() {
  return syncProgress
}

/**
 * Establece el origen de la sincronización ('manual' o 'cron')
 * Esto controla si la barra de progreso se muestra en el frontend
 */
export function setSyncTriggerSource(source) {
  syncProgress.triggerSource = source
}

function updateGlobalProgress() {
  // Calcular el total global y el progreso actual sumando todos los módulos
  const totalGlobal =
    (syncProgress.contacts.total || 0) +
    (syncProgress.whatsappContacts?.total || 0) +
    (syncProgress.appointments.total || 0) +
    (syncProgress.products?.total || 0) +
    (syncProgress.payments.total || 0) +
    (syncProgress.conversations?.total || 0) +
    (syncProgress.metaAds?.total || 0)

  const currentGlobal =
    (syncProgress.contacts.saved || 0) +
    (syncProgress.whatsappContacts?.saved || 0) +
    (syncProgress.appointments.saved || 0) +
    (syncProgress.products?.saved || 0) +
    (syncProgress.payments.saved || 0) +
    (syncProgress.conversations?.saved || 0) +
    (syncProgress.metaAds?.saved || 0)

  syncProgress.total = totalGlobal
  syncProgress.current = currentGlobal
}

function updateContacts(saved, total, status, message) {
  syncProgress.contacts = { saved, total, status, message }
  updateGlobalProgress()
}

function updateWhatsAppContacts(saved, total, status, message) {
  syncProgress.whatsappContacts = { saved, total, status, message }
  updateGlobalProgress()
}

function updateAppointments(saved, total, status, message) {
  syncProgress.appointments = { saved, total, status, message }
  updateGlobalProgress()
}

function updateProducts(saved, total, status, message) {
  syncProgress.products = { saved, total, status, message }
  updateGlobalProgress()
}

function updatePayments(saved, total, status, message) {
  syncProgress.payments = { saved, total, status, message }
  updateGlobalProgress()
}

function updateConversations(saved, total, status, message) {
  syncProgress.conversations = { saved, total, status, message }
  updateGlobalProgress()
}

function updateMetaAds(synced, count, status, message, saved = 0, total = 0) {
  syncProgress.metaAds = { synced, count, saved, total, status, message }
  updateGlobalProgress()
}

function normalizeEstimateTotal(estimate = {}) {
  const total = Number(estimate?.total || 0)
  return Number.isFinite(total) && total > 0 ? total : 0
}

function describeConversationEstimate(estimate = {}) {
  const total = normalizeEstimateTotal(estimate)
  const unit = cleanString(estimate?.unit) || 'items'
  if (!total) return 'volumen no disponible'
  return `${total} ${unit === 'messages' ? 'mensajes' : unit === 'conversations' ? 'conversaciones' : unit}`
}

export function shouldRunHighLevelConversationsInBackground({ triggerSource = 'manual', estimate = {} } = {}) {
  if (cleanString(triggerSource).toLowerCase() !== 'manual') return false
  if (estimate?.unknown) return true
  if (estimate?.useConversationBackfill) return true
  return normalizeEstimateTotal(estimate) > HIGHLEVEL_CONVERSATION_BACKGROUND_THRESHOLD
}

function startHighLevelConversationSyncInBackground({ locationId, apiToken, estimate = {} }) {
  const estimatedTotal = normalizeEstimateTotal(estimate)

  if (backgroundConversationSyncRunning) {
    updateConversations(
      0,
      estimatedTotal,
      'running',
      'Ya hay una importación de chats en segundo plano'
    )
    return { started: false, alreadyRunning: true }
  }

  backgroundConversationSyncRunning = true
  updateConversations(
    0,
    estimatedTotal,
    'running',
    `Importando chats de HighLevel en segundo plano (${describeConversationEstimate(estimate)})`
  )

  setTimeout(() => {
    runHighLevelConversationSyncInBackground({ locationId, apiToken, estimate }).catch(error => {
      logger.error(`[GHL Conversations] Error inesperado en background sync: ${error.message}`)
    })
  }, 0)

  return { started: true, alreadyRunning: false }
}

async function runHighLevelConversationSyncInBackground({ locationId, apiToken, estimate = {} }) {
  try {
    const { syncHighLevelConversationHistory } = await import('./highlevelConversationsSyncService.js')
    const result = await syncHighLevelConversationHistory({
      locationId,
      apiToken,
      notifyNewInbound: false,
      onProgress: (saved, total, message) => {
        updateConversations(saved, total, 'running', `${message} (segundo plano)`)
      }
    })

    if (result.alreadyRunning) {
      updateConversations(
        0,
        normalizeEstimateTotal(estimate),
        'running',
        'La importación de chats ya estaba corriendo en segundo plano'
      )
      return
    }

    updateConversations(
      result.saved,
      Math.max(result.total, result.saved),
      'completed',
      `${result.saved} mensajes de chat sincronizados en segundo plano`
    )
    logger.info(`[GHL Conversations] Background sync completada: ${result.saved}/${result.total} mensajes`)
  } catch (error) {
    logger.error(`No se pudieron sincronizar conversaciones en segundo plano: ${error.message}`)
    updateConversations(0, normalizeEstimateTotal(estimate), 'error', `Error sincronizando chats en segundo plano: ${error.message}`)
  } finally {
    backgroundConversationSyncRunning = false
  }
}

function buildHighLevelUrl(pathOrUrl, params = {}) {
  const base = HIGHLEVEL_BASE_URL.endsWith('/') ? HIGHLEVEL_BASE_URL : `${HIGHLEVEL_BASE_URL}/`
  const url = pathOrUrl instanceof URL
    ? new URL(pathOrUrl.toString())
    : new URL(pathOrUrl.startsWith('http') ? pathOrUrl : pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`, base)

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      url.searchParams.delete(key)
    } else {
      url.searchParams.set(key, value)
    }
  })

  return url.toString()
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function cleanHighLevelContactName(value, ...phones) {
  return formatContactName(sanitizeContactName(value, ...phones) || '')
}

function isMaskedSecret(value) {
  return cleanString(value).startsWith(MASKED_SECRET_PREFIX)
}

function maskSecret(value) {
  const cleanValue = cleanString(value)
  return cleanValue ? `${MASKED_SECRET_PREFIX}${cleanValue.slice(-8)}` : ''
}

function normalizeAdAccountId(value) {
  return cleanString(value).replace(/^act_/i, '')
}

function isNonEmptyUnmasked(value) {
  const cleanValue = cleanString(value)
  return Boolean(cleanValue) && !isMaskedSecret(cleanValue)
}

function getCustomValue(customValues = [], names = []) {
  for (const name of names) {
    const match = customValues.find(customValue => customValue.name === name)
    const value = cleanString(match?.value)
    if (value) return value
  }

  return ''
}

function extractMetaCredentialsFromCustomValues(customValues = [], options = {}) {
  const maskSecrets = options.maskSecrets === true
  const credentials = {}

  META_CUSTOM_VALUE_FIELDS.forEach(field => {
    const value = getCustomValue(customValues, field.names)
    credentials[field.key] = field.secret && maskSecrets ? maskSecret(value) : value
  })

  credentials.adAccountId = normalizeAdAccountId(credentials.adAccountId)

  return credentials
}

function hasRequiredMetaCredentials(credentials = {}) {
  credentials = credentials || {}
  return Boolean(
    normalizeAdAccountId(credentials.adAccountId) &&
    isNonEmptyUnmasked(credentials.accessToken)
  )
}

function hasAnyMetaCredential(credentials = {}) {
  credentials = credentials || {}
  return META_CUSTOM_VALUE_FIELDS.some(field => Boolean(cleanString(credentials[field.key])))
}

function buildLocalMetaCredentials(metaConfig = {}, whatsappBusinessAccountId = '') {
  if (!metaConfig) return null

  return {
    connectionMode: cleanString(metaConfig.connection_mode) === 'oauth_user'
      ? 'oauth_bisu'
      : cleanString(metaConfig.connection_mode || 'manual_system_user'),
    adAccountId: normalizeAdAccountId(metaConfig.ad_account_id),
    accessToken: cleanString(metaConfig.access_token),
    pixelId: cleanString(metaConfig.pixel_id),
    pageId: cleanString(metaConfig.page_id),
    instagramAccountId: cleanString(metaConfig.instagram_account_id),
    whatsappBusinessAccountId: cleanString(whatsappBusinessAccountId)
  }
}

function maskMetaCredentials(credentials = {}) {
  credentials = credentials || {}
  return {
    adAccountId: normalizeAdAccountId(credentials.adAccountId),
    accessToken: maskSecret(credentials.accessToken),
    pixelId: cleanString(credentials.pixelId),
    pageId: cleanString(credentials.pageId),
    instagramAccountId: cleanString(credentials.instagramAccountId),
    whatsappBusinessAccountId: cleanString(credentials.whatsappBusinessAccountId)
  }
}

function mergeMetaCredentials(primary = {}, fallback = {}) {
  primary = primary || {}
  fallback = fallback || {}
  return {
    adAccountId: normalizeAdAccountId(primary.adAccountId || fallback.adAccountId),
    accessToken: cleanString(primary.accessToken || fallback.accessToken),
    pixelId: cleanString(primary.pixelId || fallback.pixelId),
    pageId: cleanString(primary.pageId || fallback.pageId),
    instagramAccountId: cleanString(primary.instagramAccountId || fallback.instagramAccountId),
    whatsappBusinessAccountId: cleanString(primary.whatsappBusinessAccountId || fallback.whatsappBusinessAccountId)
  }
}

function credentialsMissingValues(target = {}, source = {}) {
  target = target || {}
  source = source || {}
  return ['pixelId', 'pageId', 'instagramAccountId', 'whatsappBusinessAccountId'].some(key =>
    !cleanString(target[key]) && cleanString(source[key])
  )
}

async function fetchHighLevelCustomValues(locationId, apiToken) {
  const response = await fetch(`${HIGHLEVEL_BASE_URL}/locations/${locationId}/customValues`, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Version': HIGHLEVEL_API_VERSION
    }
  })

  if (!response.ok) {
    throw new Error(`No se pudieron obtener custom values de HighLevel (${response.status})`)
  }

  const data = await response.json()
  return data.customValues || []
}

async function getLocalMetaCredentials() {
  const [metaConfig, whatsappBusinessAccountId] = await Promise.all([
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer Meta local para reconciliación: ${error.message}`)
      return null
    }),
    getAppConfig('meta_whatsapp_business_account_id').catch(() => '')
  ])

  return buildLocalMetaCredentials(metaConfig, whatsappBusinessAccountId)
}

function getPaginationHints(data = {}) {
  const meta = data.meta || {}
  const pageInfo = data.pageInfo || {}
  const pagination = meta.pagination || data.pagination || {}

  const nextToken = pageInfo.nextPageToken
    || meta.nextPageToken
    || pagination.nextPageToken
    || pagination.nextToken
    || data.nextPageToken
    || data.nextCursor
    || meta.nextCursor

  let nextUrl = pageInfo.nextPageUrl
    || meta.nextPageUrl
    || meta.nextPageUri
    || pagination.nextPageUrl
    || pagination.nextPage
    || data.nextPageUrl
    || data.nextPageUri

  const hasMore = Boolean(
    pageInfo.hasNextPage
    ?? pagination.hasNextPage
    ?? pagination.hasMore
    ?? meta.hasNextPage
    ?? meta.hasMore
    ?? data.hasMore
    ?? false
  )

  return { nextToken, nextUrl, hasMore }
}

async function collectPaginatedData({
  initialUrl,
  headers,
  extractItems,
  limit,
  label = 'datos',
  rewriteUrlWithToken,
  rewriteUrlWithOffset,
  onPage,
  maxPages = 500
}) {
  const items = []
  const seenIds = new Set()
  const seenTokens = new Set()
  let url = initialUrl
  let page = 0

  while (url && page < maxPages) {
    page++
    const response = await fetch(url, { headers })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const error = new Error(`Error al obtener ${label}: ${response.status} ${response.statusText}`)
      error.status = response.status
      error.body = body
      throw error
    }

    const data = await response.json()
    const pageItems = extractItems(data) || []
    const before = items.length

    // Detectar items duplicados por ID
    let newItemsCount = 0
    if (Array.isArray(pageItems) && pageItems.length) {
      for (const item of pageItems) {
        const itemId = item.id || item._id || item.transactionId || item.contactId
        if (itemId && !seenIds.has(itemId)) {
          seenIds.add(itemId)
          items.push(item)
          newItemsCount++
        }
      }
    }

    if (onPage) {
      await onPage({ page, pageItems, total: items.length, data, url })
    }

    // Verificar si ya tenemos todos según totalCount de la API
    const totalCount = data.totalCount || data.total || data.meta?.total
    if (totalCount && items.length >= totalCount) {
      break
    }

    const { nextToken, nextUrl, hasMore } = getPaginationHints(data)

    let advanced = false

    if (nextToken && rewriteUrlWithToken && !seenTokens.has(nextToken)) {
      seenTokens.add(nextToken)
      url = rewriteUrlWithToken(nextToken)
      advanced = true
    } else if (nextUrl) {
      url = buildHighLevelUrl(nextUrl)
      advanced = true
    } else if (rewriteUrlWithOffset && limit) {
      const currentOffsetMatch = /[?&]offset=(\d+)/.exec(url)
      const currentOffset = currentOffsetMatch ? parseInt(currentOffsetMatch[1], 10) : 0
      if ((Array.isArray(pageItems) && pageItems.length === limit) || hasMore) {
        url = rewriteUrlWithOffset(currentOffset + limit)
        advanced = true
      }
    } else {
      url = null
    }

    // (GHL-012) Solo cortar por "página sin items nuevos" cuando la API NO
    // ofrece una forma real de avanzar. Antes se cortaba apenas una página
    // traía solo duplicados (p.ej. un item repetido en el borde de la página),
    // perdiendo todas las páginas posteriores aunque hubiera nextToken/
    // nextUrl/hasMore. Si todavía podemos avanzar, seguimos paginando.
    if (newItemsCount === 0 && pageItems.length > 0 && !advanced) {
      break
    }

    if (items.length === before && !advanced) {
      logger.warn(`Se detuvo la paginación de ${label} en la página ${page} porque no se encontraron nuevos registros.`)
      break
    }
  }

  return items
}

function normalizePaymentRecord(raw = {}) {
  const id = raw._id || raw.id || raw.transactionId || raw.paymentId || raw.invoicePaymentId
  const contactId = raw.contactId || raw.contact?.id

  const amount = typeof raw.amount === 'number'
    ? raw.amount
    : typeof raw.amount?.total === 'number'
      ? raw.amount.total
      : typeof raw.amount?.value === 'number'
        ? raw.amount.value
        : typeof raw.amountInCents === 'number'
          ? raw.amountInCents / 100
          : typeof raw.totalAmount === 'number'
            ? raw.totalAmount
            : typeof raw.price === 'number'
              ? raw.price
              : 0

  const currency = raw.currency
    || raw.currencyCode
    || raw.amount?.currency
    || raw.amount?.currencyCode
    || raw.currency_code
    || 'MXN'

  const status = raw.status || raw.transactionStatus || raw.paymentStatus || raw.state || raw.transaction_state

  // Extraer método de pago (puede venir como objeto o string)
  let paymentMethod = raw.paymentProviderType || raw.payment_mode || raw.method || raw.processor || raw.paymentMethodType
  if (!paymentMethod && raw.paymentMethod) {
    // Si paymentMethod es un objeto, extraer el tipo/nombre
    paymentMethod = typeof raw.paymentMethod === 'object'
      ? (raw.paymentMethod.type || raw.paymentMethod.name || raw.paymentMethod.method || 'manual')
      : raw.paymentMethod
  }
  paymentMethod = paymentMethod || 'manual'

  const reference = raw.reference || raw.referenceNumber || raw.transactionReference || raw.invoiceId || raw.invoiceNumber || raw.orderId
  const description = raw.description || raw.notes || raw.note || raw.title || raw.summary || null
  const createdAt = raw.date || raw.createdAt || raw.createdOn || raw.paymentDate || raw.transactionDate || raw.updatedAt
  const updatedAt = raw.updatedAt || createdAt

  return {
    id,
    contactId,
    amount,
    currency,
    status,
    paymentMethod,
    reference,
    description,
    date: createdAt,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || createdAt
  }
}

function normalizeAppointmentRecord(raw = {}, locationIdFallback) {
  const id = raw.id || raw.appointmentId
  const contactId = raw.contactId || raw.contact?.id || raw.customerId
  const calendarId = raw.calendarId || raw.calendar?.id
  const locationId = raw.locationId || raw.location?.id || locationIdFallback

  const title = raw.title || raw.name || raw.summary || raw.calendarEventName || 'Cita'
  const status = raw.status || raw.appointmentStatus || raw.state
  const appointmentStatus = raw.appointmentStatus || raw.status || raw.state
  const assignedUserId = raw.assignedUserId || raw.assignedTo || raw.userId || raw.teamMemberId
  const notes = raw.notes || raw.note || raw.description || null
  const address = raw.address || raw.location || raw.addressLine || null
  const startTime = raw.startTime || raw.startDateTime || raw.startAt || raw.start
  const endTime = raw.endTime || raw.endDateTime || raw.endAt || raw.end
  // IMPORTANTE: NO usar startTime como fallback, eso pone la fecha de la cita como fecha de creación
  // Prioridad: dateAdded de GHL > createdAt > fecha actual (como última opción)
  const dateAdded = raw.dateAdded || raw.createdAt || raw.createdOn || new Date().toISOString()
  const dateUpdated = raw.dateUpdated || raw.updatedAt || raw.updatedOn || dateAdded
  // (GHL-004) Capturar el id del evento de Google Calendar si HL lo provee, para
  // que upsertLocalAppointment pueda deduplicar contra la cita de Google (columna
  // google_event_id / match existingByGoogle) y no se dupliquen citas.
  const googleEventId = raw.googleEventId || raw.googleCalendarEventId || raw.gEventId || raw.externalId || null

  return {
    id,
    contactId,
    calendarId,
    locationId,
    title,
    status,
    appointmentStatus,
    assignedUserId,
    notes,
    address,
    startTime,
    endTime,
    dateAdded,
    dateUpdated,
    googleEventId // (GHL-004)
  }
}

async function fetchCalendarEventsByCalendar({
  locationId,
  apiToken,
  startTime,
  endTime,
  limit,
  onProgress,
  initialTotal = 0
}) {
  // Versiones correctas según la API de calendarios de HighLevel:
  // listar calendarios usa 2023-02-21 y /calendars/events usa 2021-04-15
  const calendarListHeaders = {
    'Authorization': `Bearer ${apiToken}`,
    'Version': '2023-02-21',
    'Accept': 'application/json'
  }
  const calendarEventsHeaders = {
    'Authorization': `Bearer ${apiToken}`,
    'Version': '2021-04-15',
    'Accept': 'application/json'
  }
  const calendarLimit = 200
  const calendarParams = { locationId, limit: calendarLimit }

  const calendars = await collectPaginatedData({
    initialUrl: buildHighLevelUrl('/calendars', calendarParams),
    headers: calendarListHeaders,
    limit: calendarLimit,
    label: 'calendarios',
    extractItems: data => Array.isArray(data.calendars) ? data.calendars : [],
    rewriteUrlWithToken: token => buildHighLevelUrl('/calendars', { ...calendarParams, pageToken: token }),
    rewriteUrlWithOffset: offset => buildHighLevelUrl('/calendars', { ...calendarParams, offset })
  })

  logger.info(`Se encontraron ${calendars.length} calendarios para sincronizar citas`)

  for (const calendar of calendars) {
    if (!calendar?.id) continue
    await upsertLocalCalendar(calendar, {
      source: 'ghl',
      ghlCalendarId: calendar.id,
      locationId,
      syncStatus: 'synced',
      rawJson: calendar
    })
  }

  const events = []
  let total = initialTotal

  for (const calendar of calendars) {
    if (!calendar?.id) {
      continue
    }

    const baseParams = {
      calendarId: calendar.id,
      locationId,
      startTime,
      endTime,
      includeAll: 'true',
      limit
    }

    const calendarEvents = await collectPaginatedData({
      initialUrl: buildHighLevelUrl('/calendars/events', baseParams),
      headers: calendarEventsHeaders,
      limit,
      label: `citas del calendario ${calendar.name || calendar.id}`,
      extractItems: data => Array.isArray(data.events) ? data.events : [],
      rewriteUrlWithToken: token => buildHighLevelUrl('/calendars/events', { ...baseParams, pageToken: token }),
      rewriteUrlWithOffset: offset => buildHighLevelUrl('/calendars/events', { ...baseParams, offset }),
      onPage: ({ page, pageItems }) => {
        total += pageItems.length
        if (onProgress) onProgress(total)
      }
    })

    events.push(...calendarEvents)
  }

  return { events, total }
}

export async function persistHighLevelAppointmentFromPull({
  rawEvent = {},
  normalized = null,
  localContactId = null,
  localCalendarId = null,
  locationId = null
} = {}) {
  const record = normalized || normalizeAppointmentRecord(rawEvent, locationId)
  return reconcileInboundHighLevelAppointment({
    ...record,
    contactId: localContactId || record.contactId || null,
    calendarId: localCalendarId || record.calendarId || null,
    locationId: locationId || record.locationId || null
  }, {
    observedRaw: rawEvent,
    ghlAppointmentId: record.id,
    contactId: localContactId || null,
    calendarId: localCalendarId || record.calendarId || null,
    locationId: locationId || record.locationId || null,
    lastWriteWins: true
  })
}

export async function resolveHighLevelPullAppointmentContact({
  remoteAppointmentId,
  remoteContactId,
  rawEvent = null,
  remoteCalendarId = null,
  apiToken,
  usePostgres = Boolean(process.env.DATABASE_URL),
  locationId,
  ensureContact = ensureContactExists
} = {}) {
  const claimedMirrorIntent = rawEvent
    ? await claimPreparedHighLevelMirrorIntent(rawEvent, {
        ghlAppointmentId: remoteAppointmentId,
        remoteCalendarId,
        remoteContactId
      })
    : null
  const inboundTarget = claimedMirrorIntent || await inspectInboundHighLevelAppointment(remoteAppointmentId)
  if (inboundTarget.ownership === 'ristak') {
    const resolvedRemoteContactId = remoteContactId
      ? await resolveContactIdByGhlId(remoteContactId)
      : null
    return {
      // Si el ID remoto no está ligado, conservarlo sólo como valor observado
      // permite detectar la divergencia sin crear ni relinkear una ficha.
      localContactId: resolvedRemoteContactId || cleanString(remoteContactId) || inboundTarget.appointment?.contactId || null,
      canonicalContactId: inboundTarget.appointment?.contactId || null,
      created: false,
      ownership: 'ristak'
    }
  }

  const ensuredContact = await ensureContact(remoteContactId, apiToken, usePostgres, locationId)
  return {
    localContactId: ensuredContact.localContactId || null,
    canonicalContactId: ensuredContact.localContactId || null,
    created: Boolean(ensuredContact.created),
    ownership: inboundTarget.ownership || 'ghl'
  }
}

// Garantiza que el contacto de HighLevel exista localmente.
// Devuelve { localContactId, created }: el ID local de Ristak (rstk_contact_*)
// resuelto vía ghl_contact_id (o id legacy), creándolo desde HighLevel si hace falta.
export async function ensureContactExists(contactId, apiToken, usePostgres, locationId) {
  if (!contactId) {
    return { localContactId: null, created: false }
  }

  const resolvedId = await resolveContactIdByGhlId(contactId)
  if (resolvedId) {
    return { localContactId: resolvedId, created: false }
  }

  try {
    logger.info(`Contacto ${contactId} no existe, obteniendo desde HighLevel...`)

    const contactUrl = buildHighLevelUrl(`/contacts/${contactId}`)
    const contactRes = await fetch(contactUrl, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': HIGHLEVEL_API_VERSION
      }
    })

    if (!contactRes.ok) {
      logger.warn(`No se pudo obtener contacto ${contactId} desde HighLevel (${contactRes.status})`)
      return { localContactId: null, created: false }
    }

    const contactData = await contactRes.json()
    const rawContact = contactData.contact || contactData
    const customFieldsResult = await resolveHighLevelContactCustomFields({
      contact: rawContact,
      apiToken,
      locationId: locationId || rawContact.locationId || rawContact.location_id || '',
      fetchDetailWhenEmpty: false
    })
    const contact = customFieldsResult.contact
    const customFieldsJson = customFieldsResult.customFieldsJson
    const highLevelContactId = contact.id || contactId
    // Resolver/crear el contacto local con ID propio; el ID de GHL queda ligado
    // en ghl_contact_id, nunca como primary key.
    const { contactId: localContactId, created } = await resolveOrCreateContactForGhl({
      ghlContactId: highLevelContactId,
      phone: contact.phone || contact.contactPhone,
      email: contact.email,
      fullName: contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      createdAt: contact.dateAdded || null
    })
    const phoneUpsert = await prepareContactPhoneUpsert({
      contactId: localContactId,
      phone: contact.phone || contact.contactPhone
    })

    // HighLevel puede enviar atribución en dos lugares: attributions[] o attributionSource
    // IMPORTANTE: SIEMPRE usar FIRST attribution, NUNCA lastAttributionSource
    const attribution = contact.attributions?.find(a => a.isFirst) || {}
    const attributionSource = contact.attributionSource || {}  // Solo FIRST attribution

    // Buscar visitor_id en sessions por email (si existe)
    let visitorId = null
    const email = contact.email
    if (email) {
      try {
        const session = await db.get(
          'SELECT visitor_id FROM sessions WHERE email = ? ORDER BY started_at ASC LIMIT 1',
          [email]
        )
        if (session?.visitor_id) {
          visitorId = session.visitor_id
        }
      } catch (err) {
        // Ignorar error, continuar sin visitor_id
      }
    }

    const query = usePostgres
      ? `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          visitor_id, custom_fields, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15::jsonb, '[]'::jsonb), $16, $17)
         ON CONFLICT (id) DO UPDATE SET
          ghl_contact_id = COALESCE(EXCLUDED.ghl_contact_id, contacts.ghl_contact_id),
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), contacts.full_name),
          first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), contacts.first_name),
          last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), contacts.last_name),
          source = EXCLUDED.source,
          attribution_url = EXCLUDED.attribution_url,
          attribution_session_source = EXCLUDED.attribution_session_source,
          attribution_medium = EXCLUDED.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), EXCLUDED.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), EXCLUDED.attribution_ad_name),
          visitor_id = COALESCE(EXCLUDED.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
          updated_at = EXCLUDED.updated_at`
      : `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          visitor_id, custom_fields, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?)
         ON CONFLICT (id) DO UPDATE SET
          ghl_contact_id = COALESCE(excluded.ghl_contact_id, contacts.ghl_contact_id),
          phone = excluded.phone,
          email = excluded.email,
          full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
          first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
          last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
          source = excluded.source,
          attribution_url = excluded.attribution_url,
          attribution_session_source = excluded.attribution_session_source,
          attribution_medium = excluded.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
          visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
          updated_at = excluded.updated_at`

    // No guardar el teléfono como nombre (HighLevel a veces devuelve el
    // teléfono en contactName cuando el contacto no tiene nombre real)
    const contactPhoneForName = phoneUpsert.phone || contact.phone || ''
    const safeFullName = cleanHighLevelContactName(
      contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contactPhoneForName
    )

    await db.run(query, [
      localContactId,
      highLevelContactId,
      phoneUpsert.phone || null,
      contact.email,
      safeFullName,
      cleanHighLevelContactName(contact.firstName, contactPhoneForName),
      cleanHighLevelContactName(contact.lastName, contactPhoneForName),
      contact.source || 'gohighlevel',
      attribution.pageUrl || attribution.url || attributionSource.url,
      attribution.utmSessionSource || attributionSource.utmSessionSource,
      attribution.medium || attributionSource.medium,
      attribution.utmAdId || attributionSource.adId || attributionSource.mediumId,  // Si no hay adId, usar mediumId
      attribution.adName || attributionSource.adName,
      visitorId,
      customFieldsJson,
      contact.dateAdded || new Date().toISOString(),
      contact.dateUpdated || contact.dateAdded || new Date().toISOString()
    ])
    await finalizePreparedPhoneUpsert(phoneUpsert, localContactId)

    return { localContactId, created }
  } catch (error) {
    logger.error(`Error obteniendo contacto ${contactId}: ${error.message}`)
    return { localContactId: null, created: false }
  }
}

// (GHL-002) Soft-delete SEGURO de contactos eliminados en HighLevel.
//
// La sync HL->local nunca marcaba como borrados los contactos que se eliminaron en
// HighLevel: quedaban "fantasma" para siempre. Esta función marca deleted_at (igual
// que el soft-delete de contacts de la migración 003) en los contactos LOCALES que:
//   - están ligados a HighLevel (ghl_contact_id no vacío), Y
//   - su ghl_contact_id NO apareció en una enumeración COMPLETA de HL.
//
// SOLO se invoca cuando la paginación de contactos recorrió TODAS las páginas hasta
// agotarlas SIN fallo (syncHighLevelContacts pagina hasta meta.nextPageUrl == null y
// lanza throw ante cualquier error no-429, así que llegar al final = enumeración
// completa). NUNCA se ejecuta en una sync parcial/incremental/abortada: eso sería un
// borrado masivo.
//
// Guardas duras anti-borrado-masivo (cualquiera que falle => NO se borra nada):
//   1. seenGhlIds debe ser un Set no vacío (una respuesta vacía de HL NO borra todo).
//   2. Se acota SOLO a filas con ghl_contact_id real (NUNCA toca contactos locales
//      o de WhatsApp que aún no están ligados a HL).
//   3. Solo afecta filas con deleted_at IS NULL (idempotente; no re-toca papelera).
// Reversible: es soft-delete; las lecturas ya filtran deleted_at IS NULL y existe
// papelera (deleted_at IS NOT NULL) para restaurar.
async function softDeleteMissingHighLevelContacts(seenGhlIds) {
  try {
    // Guarda 1: nunca borrar a partir de un set vacío (HL pudo devolver 0 por error
    // silencioso o cuenta recién conectada). Un wipe masivo sería catastrófico.
    if (!(seenGhlIds instanceof Set) || seenGhlIds.size === 0) {
      logger.warn('(GHL-002) Soft-delete de contactos OMITIDO: no hay IDs de HighLevel enumerados (set vacío). No se borra nada por seguridad.')
      return { softDeleted: 0, skipped: true }
    }

    // Set de ghl_contact_id realmente vistos en HL, como strings limpios.
    const ids = Array.from(seenGhlIds)
      .map(id => (id === null || id === undefined ? '' : String(id).trim()))
      .filter(Boolean)

    if (ids.length === 0) {
      logger.warn('(GHL-002) Soft-delete de contactos OMITIDO: los IDs enumerados quedaron vacíos tras normalizar.')
      return { softDeleted: 0, skipped: true }
    }

    // Timestamp comparable como texto en SQLite y Postgres ('YYYY-MM-DD HH:MM:SS').
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // UPDATE acotado: SOLO contactos ligados a HL (ghl_contact_id no vacío) cuyo id de
    // HL NO está en la lista enumerada, y que no estén ya en la papelera. Placeholders
    // posicionales (?) válidos en ambos motores vía la abstracción db.
    const placeholders = ids.map(() => '?').join(', ')
    const result = await db.run(
      `UPDATE contacts
         SET deleted_at = ?
       WHERE deleted_at IS NULL
         AND ghl_contact_id IS NOT NULL
         AND ghl_contact_id != ''
         AND ghl_contact_id NOT IN (${placeholders})`,
      [now, ...ids]
    )

    const softDeleted = result?.changes || 0
    if (softDeleted > 0) {
      logger.info(`(GHL-002) Soft-delete de contactos: ${softDeleted} contacto(s) eliminado(s) en HighLevel marcados como borrados localmente.`)
    } else {
      logger.info('(GHL-002) Soft-delete de contactos: ningún contacto fantasma por limpiar (todos los locales ligados siguen en HighLevel).')
    }

    return { softDeleted, skipped: false }
  } catch (error) {
    // Nunca tumbar la sync por el soft-delete: es un paso de limpieza, no crítico.
    logger.error(`(GHL-002) Error en soft-delete de contactos (se ignora, no se borró nada parcial peligroso): ${error.message}`)
    return { softDeleted: 0, skipped: true, error: error.message }
  }
}

/**
 * Sincroniza contactos desde HighLevel (con paginación)
 */
async function syncHighLevelContacts(locationId, apiToken) {
  logger.info('Sincronizando contactos desde HighLevel...')

  const allContacts = []
  let totalKnown = 0
  updateContacts(0, 0, 'running', 'Obteniendo contactos de HighLevel...')

  for await (const page of iterateHighLevelContactPages({ locationId, apiToken })) {
    allContacts.push(...page.contacts)
    totalKnown = Math.max(totalKnown, page.total || 0, allContacts.length)
    logger.info(
      `[GHL Contacts] Página ${page.pagesRead}: ${page.contacts.length} contactos ` +
      `(acumulado: ${allContacts.length}${page.total ? `/${page.total}` : ''})`
    )
    updateContacts(
      0,
      totalKnown,
      'running',
      `Obteniendo contactos... ${allContacts.length}${page.total ? `/${page.total}` : ''}`
    )
  }

  logger.info(`Total de contactos obtenidos: ${allContacts.length}`)
  updateContacts(0, allContacts.length, 'running', `Guardando ${allContacts.length} contactos en base de datos...`)

  let saved = 0
  const usePostgres = process.env.DATABASE_URL ? true : false
  const customFieldDefinitions = await fetchHighLevelContactCustomFieldDefinitions({ apiToken, locationId })

  // (GHL-002) Set de ghl_contact_id realmente enumerados desde HL en esta corrida
  // COMPLETA, para luego marcar como borrados localmente los que ya no existen.
  // Se construye a partir de allContacts (la enumeración completa), INDEPENDIENTE de
  // si el guardado local de cada contacto falla: el contacto existe en HL, así que
  // NO debe soft-borrarse aunque su upsert local truene.
  const seenGhlContactIds = new Set()
  for (const rawContact of allContacts) {
    const ghlId = rawContact?.id || rawContact?._id
    if (ghlId) seenGhlContactIds.add(String(ghlId).trim())
  }

  for (const rawContact of allContacts) {
    try {
      const customFieldsResult = await resolveHighLevelContactCustomFields({
        contact: rawContact,
        apiToken,
        locationId,
        definitions: customFieldDefinitions,
        fetchDetailWhenEmpty: !hasContactCustomFieldsPayload(rawContact)
      })
      const contact = customFieldsResult.contact
      const customFieldsJson = customFieldsResult.customFieldsJson
      const highLevelContactId = contact.id || rawContact.id || rawContact._id
      // Resolver/crear el contacto local con ID propio de Ristak; el ID de GHL
      // queda solo como referencia en ghl_contact_id.
      const { contactId: localContactId } = await resolveOrCreateContactForGhl({
        ghlContactId: highLevelContactId,
        phone: contact.phone || contact.contactPhone,
        email: contact.email,
        fullName: contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        createdAt: contact.dateAdded || null
      })
      const phoneUpsert = await prepareContactPhoneUpsert({
        contactId: localContactId,
        phone: contact.phone || contact.contactPhone
      })

      // HighLevel puede enviar atribución en dos lugares: attributions[] o attributionSource
      // IMPORTANTE: SIEMPRE usar FIRST attribution, NUNCA lastAttributionSource
      const attribution = contact.attributions?.find(a => a.isFirst) || {}
      const attributionSource = contact.attributionSource || {}  // Solo FIRST attribution

      // Buscar visitor_id en sessions por email (si existe)
      let visitorId = null
      const email = contact.email
      if (email) {
        try {
          const session = await db.get(
            'SELECT visitor_id FROM sessions WHERE email = ? ORDER BY started_at ASC LIMIT 1',
            [email]
          )
          if (session?.visitor_id) {
            visitorId = session.visitor_id
          }
        } catch (err) {
          // Ignorar error, continuar sin visitor_id
        }
      }

      const query = usePostgres
        ? `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            visitor_id, custom_fields, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15::jsonb, '[]'::jsonb), $16, $17)
           ON CONFLICT (id) DO UPDATE SET
            ghl_contact_id = COALESCE(EXCLUDED.ghl_contact_id, contacts.ghl_contact_id),
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), contacts.full_name),
            first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), contacts.first_name),
            last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), contacts.last_name),
            source = EXCLUDED.source,
            attribution_url = EXCLUDED.attribution_url,
            attribution_session_source = EXCLUDED.attribution_session_source,
            attribution_medium = EXCLUDED.attribution_medium,
            attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), EXCLUDED.attribution_ad_id),
            attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), EXCLUDED.attribution_ad_name),
            visitor_id = COALESCE(EXCLUDED.visitor_id, contacts.visitor_id),
            custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
            updated_at = EXCLUDED.updated_at`
        : `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            visitor_id, custom_fields, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?)
           ON CONFLICT (id) DO UPDATE SET
            ghl_contact_id = COALESCE(excluded.ghl_contact_id, contacts.ghl_contact_id),
            phone = excluded.phone,
            email = excluded.email,
            full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
            first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
            last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
            source = excluded.source,
            attribution_url = excluded.attribution_url,
            attribution_session_source = excluded.attribution_session_source,
            attribution_medium = excluded.attribution_medium,
            attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
            attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
            visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
            custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
            updated_at = excluded.updated_at`

      // No guardar el teléfono como nombre (HighLevel a veces devuelve el
      // teléfono en contactName cuando el contacto no tiene nombre real)
      const contactPhoneForName = phoneUpsert.phone || contact.phone || ''
      const safeFullName = cleanHighLevelContactName(
        contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        contactPhoneForName
      )

      await db.run(query, [
        localContactId,
        highLevelContactId,
        phoneUpsert.phone || null,
        contact.email,
        safeFullName,
        cleanHighLevelContactName(contact.firstName, contactPhoneForName),
        cleanHighLevelContactName(contact.lastName, contactPhoneForName),
        contact.source || 'gohighlevel',
        attribution.pageUrl || attribution.url || attributionSource.url,
        attribution.utmSessionSource || attributionSource.utmSessionSource,
        attribution.medium || attributionSource.medium,
        attribution.utmAdId || attributionSource.adId || attributionSource.mediumId,  // Si no hay adId, usar mediumId
        attribution.adName || attributionSource.adName,
        visitorId,
        customFieldsJson,
        contact.dateAdded || new Date().toISOString(),
        contact.dateUpdated || contact.dateAdded || new Date().toISOString()
      ])
      await finalizePreparedPhoneUpsert(phoneUpsert, localContactId)

      saved++

      // Actualizar progreso cada 50 contactos o si es el último
      if (saved % 50 === 0 || saved === allContacts.length) {
        updateContacts(saved, allContacts.length, 'running', `Guardando contactos: ${saved}/${allContacts.length}`)
      }
    } catch (err) {
      logger.error(`Error guardando contacto ${rawContact.id || rawContact._id || 'sin_id'}: ${err.message}`)
    }
  }

  logger.info(`✅ Sincronizados ${saved}/${allContacts.length} contactos desde HighLevel`)
  updateContacts(saved, allContacts.length, 'completed', `${saved} contactos sincronizados exitosamente`)

  // (GHL-002) Llegar hasta aquí significa que la paginación recorrió TODAS las
  // páginas hasta meta.nextPageUrl == null SIN throw (cualquier error no-429 aborta
  // la sync antes de este punto). Es decir: enumeración COMPLETA y EXITOSA. Solo en
  // ese caso es seguro marcar como borrados los contactos locales ligados a HL cuyo
  // id ya no aparece en HighLevel. El helper aplica sus propias guardas (set no
  // vacío, solo ghl_contact_id real, solo deleted_at IS NULL) y nunca tumba la sync.
  const softDeleteResult = await softDeleteMissingHighLevelContacts(seenGhlContactIds)

  return { saved, total: allContacts.length, softDeleted: softDeleteResult.softDeleted || 0 }
}

function serializeCustomFieldsForUpsert(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

async function getWhatsAppOnlyContactsForHighLevelUpload() {
  // Contactos creados por WhatsApp que todavía no están ligados a HighLevel.
  // El prefijo waapi_contact_ se conserva solo por compatibilidad con datos legacy.
  return db.all(`
    SELECT id, phone, email, full_name, first_name, last_name, source, visitor_id,
      attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
      attribution_ad_name, attribution_ad_id, custom_fields, created_at
    FROM contacts
    WHERE (id LIKE 'waapi_contact_%' OR LOWER(COALESCE(source, '')) = 'whatsapp_api')
      AND (ghl_contact_id IS NULL OR ghl_contact_id = '')
      AND phone IS NOT NULL
      AND phone != ''
    ORDER BY created_at ASC
  `)
}

async function findHighLevelContactForLocal(client, contact) {
  // (GHL-011) Antes se tomaba el PRIMER candidato HL con id devuelto por la
  // búsqueda por email o teléfono, sin corroborar el identificador. Dos
  // contactos HL con el mismo teléfono (líneas compartidas/familiares) podían
  // ligar el ghl_contact_id equivocado y disparar un merge de DOS personas
  // distintas. Ahora cada match exige que el identificador buscado coincida de
  // verdad en el candidato: email exacto, o dígitos de teléfono iguales.
  const localEmail = String(contact.email || '').trim().toLowerCase()
  const localPhoneDigits = normalizePhoneDigits(contact.phone || '')

  const candidateEmail = (candidate) => String(candidate.email || '').trim().toLowerCase()
  const candidatePhoneDigits = (candidate) => normalizePhoneDigits(candidate.phone || '')

  const searches = []
  if (localEmail) searches.push({ by: 'email', params: { email: contact.email } })
  if (localPhoneDigits) searches.push({ by: 'phone', params: { phone: contact.phone } })

  for (const search of searches) {
    try {
      const result = await client.searchContacts({ ...search.params, limit: 5 })
      const candidates = (result.contacts || []).filter(candidate => candidate.id)

      let match = null
      if (search.by === 'email') {
        // (GHL-011) Solo aceptar si el email del candidato coincide exactamente.
        match = candidates.find(candidate => candidateEmail(candidate) === localEmail)
      } else if (search.by === 'phone') {
        // (GHL-011) Exigir coincidencia real de dígitos de teléfono. Si hay
        // varios candidatos con el mismo teléfono, preferir el que además
        // corrobora el email; si siguen siendo ambiguos, no emparejar (no se
        // puede decidir con seguridad).
        const phoneMatches = candidates.filter(candidate => {
          const digits = candidatePhoneDigits(candidate)
          return digits && digits === localPhoneDigits
        })
        if (phoneMatches.length === 1) {
          match = phoneMatches[0]
        } else if (phoneMatches.length > 1) {
          const corroborated = localEmail
            ? phoneMatches.filter(candidate => candidateEmail(candidate) === localEmail)
            : []
          if (corroborated.length === 1) {
            match = corroborated[0]
          } else {
            logger.warn(`Match WhatsApp→HL ambiguo para contacto ${contact.id}: ${phoneMatches.length} contactos HL comparten teléfono; no se emparejará para evitar fusionar personas distintas.`)
          }
        }
      }

      if (match) return match
    } catch (error) {
      logger.warn(`No se pudo buscar contacto WhatsApp en HighLevel (${contact.id}): ${error.message}`)
    }
  }

  return null
}

async function upsertHighLevelContactLocallyFromWhatsApp({ localContact, highLevelContact }) {
  const ghlContactId = highLevelContact.id || highLevelContact._id
  if (!ghlContactId) throw new Error('HighLevel no devolvio id de contacto')

  // El contacto conserva su ID local de Ristak; el ID de GHL solo se liga.
  // Si otro contacto local ya estaba ligado/keyed con ese ID de GHL (datos
  // legacy o duplicados), se fusiona conservando el ID local de WhatsApp.
  let targetId = localContact.id
  const alreadyLinkedId = await resolveContactIdByGhlId(ghlContactId)
  if (alreadyLinkedId && alreadyLinkedId !== localContact.id) {
    targetId = await mergeContactIds({
      fromId: alreadyLinkedId,
      toId: localContact.id,
      canonicalPhone: localContact.phone || null
    })
  }

  // Nunca usar el teléfono como nombre: searchContacts rellena `name` con el
  // teléfono cuando el contacto de HighLevel no tiene nombre real.
  const contactPhoneForName = highLevelContact.phone || localContact.phone || ''
  const fullName = cleanHighLevelContactName(highLevelContact.contactName, contactPhoneForName) ||
    cleanHighLevelContactName(`${highLevelContact.firstName || ''} ${highLevelContact.lastName || ''}`.trim(), contactPhoneForName) ||
    cleanHighLevelContactName(highLevelContact.name, contactPhoneForName) ||
    cleanHighLevelContactName(localContact.full_name, contactPhoneForName)
  const fullNameParts = splitContactName(fullName)
  const firstName = cleanHighLevelContactName(highLevelContact.firstName, contactPhoneForName) ||
    cleanHighLevelContactName(localContact.first_name, contactPhoneForName) ||
    fullNameParts.firstName ||
    null
  const lastName = cleanHighLevelContactName(highLevelContact.lastName, contactPhoneForName) ||
    cleanHighLevelContactName(localContact.last_name, contactPhoneForName) ||
    fullNameParts.lastName ||
    null
  const phoneUpsert = await prepareContactPhoneUpsert({
    contactId: targetId,
    phone: highLevelContact.phone || localContact.phone
  })

  try {
    await db.run(`
      UPDATE contacts SET
        ghl_contact_id = ?,
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        full_name = COALESCE(?, full_name),
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        source = COALESCE(NULLIF(source, ''), ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      ghlContactId,
      phoneUpsert.phone || null,
      highLevelContact.email || localContact.email || null,
      fullName || null,
      firstName || null,
      lastName || null,
      localContact.source || highLevelContact.source || 'WhatsApp Business',
      targetId
    ])

    await finalizePreparedPhoneUpsert(phoneUpsert, targetId)
  } catch (error) {
    if (phoneUpsert.mergeFromContactId) {
      await db.run(
        'UPDATE contacts SET phone = COALESCE(phone, ?), email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [localContact.phone || null, localContact.email || null, phoneUpsert.mergeFromContactId]
      )
    }
    throw error
  }

  return targetId
}

async function syncWhatsAppContactsToHighLevel(locationId, apiToken) {
  const contacts = await getWhatsAppOnlyContactsForHighLevelUpload()
  const total = contacts.length

  if (!total) {
    updateWhatsAppContacts(0, 0, 'completed', 'Sin contactos WhatsApp pendientes')
    return { total: 0, synced: 0, created: 0, matched: 0, failed: 0 }
  }

  const client = new GHLClient(apiToken, locationId)
  let created = 0
  let matched = 0
  let failed = 0

  updateWhatsAppContacts(0, total, 'running', `Subiendo contactos WhatsApp: 0/${total}`)

  for (const contact of contacts) {
    try {
      let highLevelContact = await findHighLevelContactForLocal(client, contact)

      if (highLevelContact) {
        matched += 1
      } else {
        // Si el contacto WhatsApp no tiene nombre real, se crea sin nombre en
        // HighLevel (nunca con el teléfono como nombre)
        const fullName = cleanHighLevelContactName(
          contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
          contact.phone
        ) || ''
        const result = await client.createContact({
          name: fullName,
          email: contact.email || '',
          phone: contact.phone
        })
        highLevelContact = result.contact || result
        created += 1
      }

      await upsertHighLevelContactLocallyFromWhatsApp({
        localContact: contact,
        highLevelContact
      })

      const synced = created + matched
      if (synced % 25 === 0 || synced + failed === total) {
        updateWhatsAppContacts(synced, total, 'running', `Subiendo contactos WhatsApp: ${synced}/${total}`)
      }
    } catch (error) {
      failed += 1
      logger.warn(`No se pudo subir contacto WhatsApp ${contact.id} a HighLevel: ${error.message}`)
      updateWhatsAppContacts(created + matched, total, 'running', `Subiendo contactos WhatsApp: ${created + matched}/${total}`)
    }
  }

  const synced = created + matched
  const status = failed > 0 ? 'partial' : 'completed'
  const message = failed > 0
    ? `${synced}/${total} contactos WhatsApp sincronizados, ${failed} con error`
    : `${synced} contactos WhatsApp sincronizados con HighLevel`

  updateWhatsAppContacts(synced, total, status, message)
  logger.info(`✅ WhatsApp → HighLevel: ${created} creados, ${matched} emparejados, ${failed} fallidos`)

  return { total, synced, created, matched, failed }
}

/**
 * Sincroniza citas/appointments desde HighLevel (con paginación)
 * Si un contacto no existe, lo obtiene de HighLevel y lo crea
 */
async function syncHighLevelAppointments(locationId, apiToken) {
  logger.info('Sincronizando citas desde HighLevel...')

  const limit = 200
  let allEventsRaw = []

  const now = new Date()
  // El endpoint /calendars/events requiere startTime/endTime en milisegundos epoch
  const startTime = new Date(now.getFullYear() - 5, 0, 1).getTime() // Hace 5 años, enero 1
  const endTime = new Date(now.getFullYear() + 5, 11, 31).getTime() // Dentro de 5 años, diciembre 31

  logger.info(`Sincronizando citas desde ${formatDate(startTime)} hasta ${formatDate(endTime)}`)

  updateAppointments(0, 0, 'running', 'Obteniendo citas de HighLevel...')

  const progressUpdater = total => updateAppointments(0, total, 'running', `Obteniendo citas... ${total} encontradas`)

  const fetchResult = await fetchCalendarEventsByCalendar({
    locationId,
    apiToken,
    startTime,
    endTime,
    limit,
    onProgress: progressUpdater,
    initialTotal: 0
  })
  allEventsRaw = fetchResult.events

  logger.info(`Total de citas obtenidas: ${allEventsRaw.length}`)
  updateAppointments(0, allEventsRaw.length, 'running', `Guardando ${allEventsRaw.length} citas en base de datos...`)

  const eventsById = new Map()
  for (const rawEvent of allEventsRaw) {
    const normalized = normalizeAppointmentRecord(rawEvent, locationId)
    if (!normalized.id) {
      continue
    }

    if (!eventsById.has(normalized.id)) {
      eventsById.set(normalized.id, { raw: rawEvent, normalized })
    }
  }

  const uniqueEvents = Array.from(eventsById.values())
  logger.info(`Citas únicas por ID: ${uniqueEvents.length}`)
  updateAppointments(0, uniqueEvents.length, 'running', `Guardando ${uniqueEvents.length} citas en base de datos...`)

  let saved = 0
  let contactsCreated = 0
  const usePostgres = Boolean(process.env.DATABASE_URL)

  for (const { raw, normalized } of uniqueEvents) {
    try {
      // Un eco de una cita canónica no tiene autoridad para crear ni mezclar
      // contactos. Sólo resolvemos/importamos el contacto si la cita realmente
      // pertenece a HighLevel o todavía no existe localmente.
      const localCalendar = normalized.calendarId
        ? await getLocalCalendar(normalized.calendarId)
        : null
      const contactResolution = await resolveHighLevelPullAppointmentContact({
        remoteAppointmentId: normalized.id,
        remoteContactId: normalized.contactId,
        rawEvent: raw,
        remoteCalendarId: normalized.calendarId,
        apiToken,
        usePostgres,
        locationId
      })
      if (contactResolution.created) {
        contactsCreated++
      }
      const localContactId = contactResolution.localContactId

      const reconciliation = await persistHighLevelAppointmentFromPull({
        rawEvent: raw,
        normalized,
        localContactId,
        localCalendarId: localCalendar?.id || normalized.calendarId,
        locationId
      })

      // Actualizar appointment_date del contacto con la fecha de la cita más próxima
      const persistedAppointment = reconciliation.appointment
      if (
        reconciliation.ownership === 'ghl'
        && persistedAppointment?.contactId
        && persistedAppointment?.startTime
      ) {
        await db.run(`
          UPDATE contacts
          SET appointment_date = ?
          WHERE id = ?
          AND (appointment_date IS NULL OR appointment_date > ?)
        `, [persistedAppointment.startTime, persistedAppointment.contactId, persistedAppointment.startTime])
      }

      saved++

      // Actualizar progreso cada 20 citas o si es la última
      if (saved % 20 === 0 || saved === uniqueEvents.length) {
        updateAppointments(saved, uniqueEvents.length, 'running', `Guardando citas: ${saved}/${uniqueEvents.length}`)
      }
    } catch (err) {
      logger.error(`Error guardando cita ${normalized.id}: ${err.message}`)
    }
  }

  logger.info(`✅ Sincronizadas ${saved}/${uniqueEvents.length} citas desde HighLevel ${contactsCreated > 0 ? `(${contactsCreated} contactos creados)` : ''}`)
  updateAppointments(saved, uniqueEvents.length, 'completed', `${saved} citas sincronizadas exitosamente`)
  return { saved, total: uniqueEvents.length, contactsCreated }
}

/**
 * Sincroniza pagos/invoices desde HighLevel usando el servicio de invoices
 * que SÍ obtiene las descripciones correctas de los productos
 */
async function syncHighLevelPayments(locationId, apiToken) {
  logger.info('Sincronizando pagos desde HighLevel...')

  // Importar el servicio de invoices que YA tiene el fix para las descripciones
  const { syncAllInvoices } = await import('./invoicesSyncService.js')

  updatePayments(0, 0, 'running', 'Sincronizando invoices de HighLevel...')

  try {
    // Usar el servicio de invoices que YA obtiene las descripciones de invoiceItems[0].name
    const result = await syncAllInvoices()

    logger.info(`✅ Sincronizados ${result.created + result.updated} invoices desde HighLevel`)
    updatePayments(result.created + result.updated, result.totalFetched, 'completed', `${result.totalFetched} pagos sincronizados exitosamente`)

    return { saved: result.created + result.updated, total: result.totalFetched, contactsCreated: 0 }
  } catch (error) {
    logger.error(`Error sincronizando invoices: ${error.message}`)
    updatePayments(0, 0, 'failed', `Error: ${error.message}`)
    throw error
  }

  // El código viejo ya no se usa - comentado para referencia
  /*
  const limit = 200
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Version': HIGHLEVEL_API_VERSION,
    'Accept': 'application/json'
  }

  updatePayments(0, 0, 'running', 'Obteniendo pagos de HighLevel...')

  const baseParams = { altId: locationId, altType: 'location', limit }

  let paymentsRaw = []

  try {
    paymentsRaw = await collectPaginatedData({
      initialUrl: buildHighLevelUrl('/payments/transactions', baseParams),
      headers,
      limit,
      label: 'pagos',
      extractItems: data => {
        // La API devuelve { data: [...], totalCount: X }
        const items = Array.isArray(data.data) ? data.data : Array.isArray(data.transactions) ? data.transactions : []
        return items
      },
      rewriteUrlWithToken: token => buildHighLevelUrl('/payments/transactions', { ...baseParams, pageToken: token }),
      rewriteUrlWithOffset: offset => buildHighLevelUrl('/payments/transactions', { ...baseParams, offset }),
      onPage: ({ page, pageItems, total, data }) => {
        const totalCount = data.totalCount || total
        logger.info(`Página ${page}: ${pageItems.length} pagos (total acumulado: ${total}, totalCount API: ${data.totalCount || 'N/A'})`)
        updatePayments(0, totalCount, 'running', `Obteniendo pagos... ${total} encontrados de ${totalCount}`)
      }
    })
  } catch (error) {
    logger.error(`Error paginando pagos: ${error.message}`)
    throw error
  }
  */
}

/**
 * Configura Custom Values en HighLevel con URLs de webhooks
 * Y obtiene custom values de Meta si existen
 */
async function setupHighLevelWebhooks(locationId, apiToken, baseUrl) {
  logger.info('Configurando webhooks en HighLevel...')

  // IMPORTANTE: Usar los nombres EXACTOS que HighLevel espera para los webhooks
  const webhooks = {
    'webhook_contacts': `${baseUrl}/webhook/contact`,
    'webhook_payments': `${baseUrl}/webhook/payment`,
    'webhook_invoice': `${baseUrl}/webhook/invoice`,
    'webhook_refunds': `${baseUrl}/webhook/refund`,
    'webhook_appointments': `${baseUrl}/webhook/appointment`,
    'webhook_appointment_showed': `${baseUrl}/webhook/appointment/showed`,
    'webhook_whatsapp_attribution': `${baseUrl}/webhook/whatsapp/attribution`,
    'webhook_conversations': `${baseUrl}/webhook/conversation`
  }

  // Primero obtener todos los custom values existentes
  logger.info('Obteniendo custom values existentes...')
  const getUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues`
  const getResponse = await fetch(getUrl, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Version': '2021-07-28'
    }
  })

  let existingCustomValues = []
  if (getResponse.ok) {
    const getData = await getResponse.json()
    existingCustomValues = getData.customValues || []
  } else {
    logger.warn('No se pudieron obtener custom values existentes, se crearán nuevos')
  }

  // Para cada webhook, verificar si existe y actualizar o crear
  for (const [name, value] of Object.entries(webhooks)) {
    try {
      // Buscar si ya existe un custom value con este nombre
      const existing = existingCustomValues.find(cv => cv.name === name)

      if (existing) {
        // Actualizar existente con PUT
        logger.info(`Actualizando webhook existente: ${name}`)
        const updateUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${existing.id}`
        const updateResponse = await fetch(updateUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name, value })
        })

        const updateData = await updateResponse.json()

        if (!updateResponse.ok) {
          logger.error(`❌ Error actualizando webhook ${name}: ${updateResponse.status} - ${JSON.stringify(updateData)}`)
        } else {
          logger.info(`   ID: ${updateData.customValue?.id}`)
        }
      } else {
        // Crear nuevo con POST
        logger.info(`Creando webhook nuevo: ${name}`)
        const createUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues`
        const createResponse = await fetch(createUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name, value })
        })

        const createData = await createResponse.json()

        if (!createResponse.ok) {
          logger.error(`❌ Error creando webhook ${name}: ${createResponse.status} - ${JSON.stringify(createData)}`)
        } else {
          logger.info(`   ID creado: ${createData.customValue?.id}`)
        }
      }
    } catch (err) {
      logger.error(`❌ Error configurando webhook ${name}: ${err.message}`)
    }
  }

  // Reconciliar Meta/Facebook si existe localmente o dentro de HighLevel.
  const reconciliation = await reconcileMetaBusinessWithHighLevel(locationId, apiToken, { prefer: 'local' })
  if (reconciliation.success) {
    logger.info(`Reconciliación Meta/HighLevel: ${reconciliation.action} - ${reconciliation.message}`)
  } else {
    logger.warn(`No se pudo reconciliar Meta/HighLevel: ${reconciliation.message}`)
  }
}

/**
 * Guarda o actualiza los Custom Values de Meta en HighLevel
 * USA System User Token (no requiere App ID ni App Secret)
 * @param {string} locationId - ID del location de HighLevel
 * @param {string} apiToken - Token de API de HighLevel
 * @param {Object} metaCredentials - { adAccountId, accessToken, pixelId }
 * @returns {Promise<Object>} - { success: boolean, message: string }
 */
export async function saveMetaCustomValues(locationId, apiToken, metaCredentials) {
  try {
    if (['oauth_user', 'oauth_bisu'].includes(cleanString(metaCredentials?.connectionMode))) {
      return {
        success: true,
        skipped: true,
        message: 'El token OAuth de Meta se mantiene sólo en Ristak y no se exporta a HighLevel'
      }
    }
    logger.info('Guardando credenciales de Meta en HighLevel custom values...')

    // Primero obtener los custom values existentes
    const getUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues`
    const getResponse = await fetch(getUrl, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': '2021-07-28'
      }
    })

    if (!getResponse.ok) {
      throw new Error('No se pudieron obtener custom values de HighLevel')
    }

    const data = await getResponse.json()
    const existingCustomValues = data.customValues || []

    // Mapeo de campos: System User Token es la única credencial usada por Meta CAPI.
    const fieldsToSave = META_CUSTOM_VALUE_FIELDS.map(field => ({
      key: field.key,
      name: field.names[0],
      value: metaCredentials[field.key],
      secret: field.secret === true
    }))

    const results = []

    for (const field of fieldsToSave) {
      // Si el valor está vacío o es null, saltar (no guardar)
      if (!field.value || field.value.trim() === '') {
        logger.info(`Saltando ${field.name} (vacío)`)
        continue
      }

      if (field.secret && isMaskedSecret(field.value)) {
        logger.info(`Saltando ${field.name} (enmascarado)`)
        continue
      }

      try {
        // Buscar si ya existe
        const existing = existingCustomValues.find(cv => cv.name === field.name)

        if (existing) {
          // Actualizar existente con PUT
          logger.info(`Actualizando ${field.name}...`)
          const updateUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${existing.id}`
          const updateResponse = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: field.name, value: field.value })
          })

          const updateData = await updateResponse.json()

          if (!updateResponse.ok) {
            logger.error(`Error HTTP ${updateResponse.status} actualizando ${field.name}:`, updateData)
            throw new Error(`Error actualizando ${field.name}: ${updateResponse.status} - ${JSON.stringify(updateData)}`)
          }

          results.push({ field: field.key, action: 'updated', success: true })
          logger.info(`✅ ${field.name} actualizado exitosamente`)
        } else {
          // Crear nuevo con POST
          logger.info(`Creando ${field.name}...`)
          const createUrl = `https://services.leadconnectorhq.com/locations/${locationId}/customValues`
          const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: field.name, value: field.value })
          })

          const createData = await createResponse.json()

          if (!createResponse.ok) {
            logger.error(`Error HTTP ${createResponse.status} creando ${field.name}:`, createData)
            throw new Error(`Error creando ${field.name}: ${createResponse.status} - ${JSON.stringify(createData)}`)
          }

          results.push({ field: field.key, action: 'created', success: true })
          logger.info(`✅ ${field.name} creado exitosamente`)
        }
      } catch (err) {
        logger.error(`❌ Error con ${field.name}: ${err.message}`)
        results.push({ field: field.key, action: 'error', success: false, error: err.message })
      }
    }

    const successCount = results.filter(r => r.success).length
    const totalCount = results.length

    logger.info(`Credenciales guardadas en HighLevel: ${successCount}/${totalCount}`)

    return {
      success: successCount > 0,
      message: `${successCount}/${totalCount} credenciales guardadas en HighLevel`,
      results
    }
  } catch (error) {
    logger.error('Error guardando credenciales de Meta en HighLevel:', error.message)
    throw error
  }
}

/**
 * Reconciliación inteligente Meta <-> HighLevel.
 * - Si Meta local existe y HighLevel no tiene valores de Meta, empuja local a HighLevel.
 * - Si HighLevel tiene valores completos y Meta local no existe, configura Meta local.
 * - Si ambos existen con el mismo core, rellena campos opcionales faltantes sin borrar nada.
 * - Si ambos existen y el core difiere, gana la fuente indicada por `prefer`.
 */
export async function reconcileMetaBusinessWithHighLevel(locationId, apiToken, options = {}) {
  const prefer = options.prefer === 'highlevel' ? 'highlevel' : 'local'
  const fromHighLevelOnly = options.direction === 'from_highlevel'
  const result = {
    success: true,
    action: 'none',
    savedInHighLevel: false,
    savedInLocal: false,
    localConfigured: false,
    highLevelConfigured: false,
    highLevelHasAnyMetaValue: false,
    message: 'Sin cambios de Meta Business'
  }

  try {
    if (!locationId || !apiToken) {
      result.success = false
      result.message = 'La integración opcional de HighLevel no está configurada'
      return result
    }

    const localCredentials = await getLocalMetaCredentials()

    // Cortar ANTES de consultar/escribir HighLevel. Además de no exportar el
    // token OAuth, esto impide que un fallo o desconexión de HighLevel participe
    // siquiera en la reconciliación de una conexión OAuth.
    if (['oauth_user', 'oauth_bisu'].includes(cleanString(localCredentials?.connectionMode))) {
      result.localConfigured = hasRequiredMetaCredentials(localCredentials)
      result.action = 'oauth_isolated'
      result.message = 'Meta OAuth se mantiene aislado de HighLevel'
      return result
    }

    const customValues = await fetchHighLevelCustomValues(locationId, apiToken).catch(error => {
      logger.warn(`No se pudieron leer custom values para reconciliar Meta: ${error.message}`)
      return []
    })

    const highLevelCredentials = extractMetaCredentialsFromCustomValues(customValues, { maskSecrets: false })
    const localComplete = hasRequiredMetaCredentials(localCredentials)
    const highLevelComplete = hasRequiredMetaCredentials(highLevelCredentials)

    result.localConfigured = localComplete
    result.highLevelConfigured = highLevelComplete
    result.highLevelHasAnyMetaValue = hasAnyMetaCredential(highLevelCredentials)

    // Una importación explícita desde HighLevel nunca debe convertirse en una
    // exportación silenciosa si el proveedor no trae el contrato completo. Este
    // guard permite que /sync-from-highlevel haga exactamente una lectura remota
    // y corte sin escribir en ninguno de los dos lados.
    if (fromHighLevelOnly && !highLevelComplete) {
      result.action = result.highLevelHasAnyMetaValue
        ? 'skipped_incomplete_highlevel'
        : 'missing_highlevel_config'
      result.message = result.highLevelHasAnyMetaValue
        ? 'HighLevel tiene datos de Meta incompletos; no se alteró la configuración local'
        : 'HighLevel no tiene configuración de Meta para importar'
      return result
    }

    if (!localComplete && !highLevelComplete) {
      result.action = result.highLevelHasAnyMetaValue ? 'skipped_incomplete_highlevel' : 'none'
      result.message = result.highLevelHasAnyMetaValue
        ? 'HighLevel tiene datos de Meta incompletos; no se alteró la configuración local'
        : 'No hay configuración de Meta para reconciliar'
      return result
    }

    if (localComplete && !highLevelComplete) {
      await saveMetaCustomValues(locationId, apiToken, localCredentials)
      result.action = 'local_to_highlevel'
      result.savedInHighLevel = true
      result.message = 'Meta local sincronizado hacia HighLevel'
      return result
    }

    if (highLevelComplete && !localComplete) {
      // PRIORIDAD LOCAL: si Ristak ya tiene CUALQUIER credencial de Meta
      // configurada, no se sobrescribe con la de HighLevel. Solo se adopta
      // la configuración de HighLevel cuando no existe ninguna config local
      // previa (o cuando el usuario lo pide explícitamente con prefer=highlevel).
      if (prefer !== 'highlevel' && hasAnyMetaCredential(localCredentials)) {
        result.action = 'kept_local'
        result.message = 'Ya existe configuración local de Meta en Ristak; no se reemplazó con la de HighLevel'
        return result
      }

      const credentialsToSave = mergeMetaCredentials(highLevelCredentials)
      // GHL-009: solo se adopta la config de HighLevel porque NO existe ninguna
      // config local de Meta (el guard kept_local de arriba ya descartó el caso
      // con credenciales locales). No se pisa nada configurado por el usuario.
      // Aun así dejamos aviso explícito para que la escritura no sea silenciosa.
      logger.info('GHL-009: Meta local vacío; se adopta la configuración de HighLevel (no se sobrescribe ninguna config previa del usuario)')
      await saveMetaConfig(
        credentialsToSave.adAccountId,
        credentialsToSave.accessToken,
        credentialsToSave.pixelId || null,
        credentialsToSave.pageId || null,
        credentialsToSave.instagramAccountId || null
      )

      if (credentialsToSave.whatsappBusinessAccountId) {
        await setAppConfig('meta_whatsapp_business_account_id', credentialsToSave.whatsappBusinessAccountId)
      }

      result.action = 'highlevel_to_local'
      result.savedInLocal = true
      result.message = 'Meta configurado localmente desde HighLevel'
      return result
    }

    const sameCore =
      normalizeAdAccountId(localCredentials.adAccountId) === normalizeAdAccountId(highLevelCredentials.adAccountId) &&
      cleanString(localCredentials.accessToken) === cleanString(highLevelCredentials.accessToken)

    if (sameCore) {
      const localNeedsUpdate = credentialsMissingValues(localCredentials, highLevelCredentials)
      const highLevelNeedsUpdate = !fromHighLevelOnly && credentialsMissingValues(highLevelCredentials, localCredentials)

      if (localNeedsUpdate) {
        // GHL-009: mergeMetaCredentials(local, highLevel) prioriza SIEMPRE los
        // valores locales y solo rellena los campos que estaban vacíos en local.
        // Nunca se pisan campos que el usuario ya configuró. Dejamos aviso
        // explícito de qué campos opcionales se completaron desde HighLevel para
        // que la escritura en meta_config no sea silenciosa en cada corrida.
        const filledFields = ['pixelId', 'pageId', 'instagramAccountId', 'whatsappBusinessAccountId']
          .filter(key => !cleanString(localCredentials[key]) && cleanString(highLevelCredentials[key]))
        logger.info(`GHL-009: Se completan campos faltantes de Meta local desde HighLevel (sin sobrescribir lo configurado): ${filledFields.join(', ') || 'ninguno'}`)
        const mergedLocal = mergeMetaCredentials(localCredentials, highLevelCredentials)
        await saveMetaConfig(
          mergedLocal.adAccountId,
          mergedLocal.accessToken,
          mergedLocal.pixelId || null,
          mergedLocal.pageId || null,
          mergedLocal.instagramAccountId || null
        )

        if (mergedLocal.whatsappBusinessAccountId) {
          await setAppConfig('meta_whatsapp_business_account_id', mergedLocal.whatsappBusinessAccountId)
        }

        result.savedInLocal = true
      }

      if (highLevelNeedsUpdate) {
        const mergedHighLevel = mergeMetaCredentials(localCredentials, highLevelCredentials)
        await saveMetaCustomValues(locationId, apiToken, mergedHighLevel)
        result.savedInHighLevel = true
      }

      if (result.savedInLocal && result.savedInHighLevel) {
        result.action = 'merged_both'
        result.message = 'Meta y HighLevel quedaron completados en ambos lados'
      } else if (result.savedInLocal) {
        result.action = 'highlevel_completed_local'
        result.message = 'HighLevel completó campos faltantes de Meta local'
      } else if (result.savedInHighLevel) {
        result.action = 'local_completed_highlevel'
        result.message = 'Meta local completó campos faltantes en HighLevel'
      } else {
        result.action = 'already_synced'
        result.message = 'Meta y HighLevel ya estaban sincronizados'
      }

      return result
    }

    if (prefer === 'highlevel') {
      // GHL-009: única ruta que reemplaza el core (ad account + token) local con
      // el de HighLevel. Solo se alcanza con prefer='highlevel' explícito (acción
      // manual del usuario, NUNCA desde el cron que usa prefer='local'). Se deja
      // aviso explícito para que la sobrescritura no sea silenciosa.
      logger.warn('GHL-009: Sobrescritura EXPLÍCITA de Meta local con la config de HighLevel por prefer=highlevel (acción manual del usuario)')
      const credentialsToSave = mergeMetaCredentials(highLevelCredentials, localCredentials)
      await saveMetaConfig(
        credentialsToSave.adAccountId,
        credentialsToSave.accessToken,
        credentialsToSave.pixelId || null,
        credentialsToSave.pageId || null,
        credentialsToSave.instagramAccountId || null
      )

      if (credentialsToSave.whatsappBusinessAccountId) {
        await setAppConfig('meta_whatsapp_business_account_id', credentialsToSave.whatsappBusinessAccountId)
      }

      result.action = 'highlevel_to_local_conflict'
      result.savedInLocal = true
      result.message = 'HighLevel reemplazó la configuración local de Meta por preferencia explícita'
      return result
    }

    await saveMetaCustomValues(locationId, apiToken, localCredentials)
    result.action = 'local_to_highlevel_conflict'
    result.savedInHighLevel = true
    result.message = 'Meta local se mantuvo y se sincronizó hacia HighLevel'
    return result
  } catch (error) {
    logger.error(`Error reconciliando Meta Business con HighLevel: ${error.message}`)
    return {
      ...result,
      success: false,
      action: 'error',
      message: error.message
    }
  }
}

/**
 * Obtiene custom values de Meta desde HighLevel y los devuelve
 */
export async function fetchAndSaveMetaConfig(locationId, apiToken) {
  try {
    logger.info('Buscando configuración de Meta en custom values de HighLevel...')

    const customValues = await fetchHighLevelCustomValues(locationId, apiToken)

    // Debug: Ver todos los custom values recibidos
    logger.info(`Total de custom values encontrados: ${customValues.length}`)
    if (customValues.length > 0) {
      logger.info('Custom values disponibles:', customValues.map(cv => cv.name).join(', '))
    }

    const rawCredentials = extractMetaCredentialsFromCustomValues(customValues, { maskSecrets: false })
    const maskedCredentials = maskMetaCredentials(rawCredentials)

    // Debug: Ver qué valores se encontraron
    logger.info(`Valores encontrados - AdAccountId: ${rawCredentials.adAccountId ? 'SÍ' : 'NO'}, AccessToken: ${rawCredentials.accessToken ? 'SÍ' : 'NO'}, PixelId: ${rawCredentials.pixelId ? 'SÍ' : 'NO'}, PageId: ${rawCredentials.pageId ? 'SÍ' : 'NO'}, Instagram: ${rawCredentials.instagramAccountId ? 'SÍ' : 'NO'}, WABA: ${rawCredentials.whatsappBusinessAccountId ? 'SÍ' : 'NO'}`)

    if (rawCredentials.whatsappBusinessAccountId) {
      await setAppConfig('meta_whatsapp_business_account_id', rawCredentials.whatsappBusinessAccountId)
    }

    // Devolver los valores encontrados (enmascarar tokens para seguridad)
    // Solo se muestran los últimos 8 caracteres, el resto se oculta con ***
    return maskedCredentials
  } catch (error) {
    logger.error('Error obteniendo config de Meta desde HighLevel:', error.message)
    return null
  }
}

/**
 * Reparación única: limpia contactos cuyo nombre quedó guardado como el
 * número telefónico (o un email) por sincronizaciones anteriores. Al dejar
 * el nombre en NULL, la siguiente sincronización lo rellena con el nombre
 * real de HighLevel si existe, y la UI muestra el teléfono solo como fallback.
 */
export async function cleanupPhoneLikeContactNames() {
  const FLAG_KEY = 'contacts_phone_name_cleanup_v1'

  const alreadyDone = cleanString(await getAppConfig(FLAG_KEY).catch(() => ''))
  if (alreadyDone === '1') return { cleaned: 0, skipped: true }

  const rows = await db.all(`
    SELECT id, phone, full_name, first_name, last_name
    FROM contacts
    WHERE COALESCE(full_name, '') != '' OR COALESCE(first_name, '') != '' OR COALESCE(last_name, '') != ''
  `)

  let cleaned = 0
  for (const row of rows) {
    const safeFullName = sanitizeContactName(row.full_name, row.phone)
    const safeFirstName = sanitizeContactName(row.first_name, row.phone)
    const safeLastName = sanitizeContactName(row.last_name, row.phone)

    const needsUpdate =
      (cleanString(row.full_name) && !safeFullName) ||
      (cleanString(row.first_name) && !safeFirstName) ||
      (cleanString(row.last_name) && !safeLastName)

    if (!needsUpdate) continue

    await db.run(
      'UPDATE contacts SET full_name = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [safeFullName, safeFirstName, safeLastName, row.id]
    )
    cleaned++
  }

  await setAppConfig(FLAG_KEY, '1')
  return { cleaned, skipped: false }
}

/**
 * Sincronización principal que ejecuta todos los pasos
 * @param {string} locationId - ID del location de HighLevel
 * @param {string} apiToken - Token de API de HighLevel
 * @param {string} triggerSource - 'manual' o 'cron' - indica si se debe mostrar en UI
 */
async function runHighLevelDataSync(locationId, apiToken, triggerSource = 'manual') {
  try {
    syncProgress = {
      status: 'running',
      step: 'Iniciando sincronización...',
      total: 0,
      current: 0,
      message: 'Preparando sincronización de datos',
      triggerSource: triggerSource,
      contacts: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      whatsappContacts: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      appointments: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      products: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      payments: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      conversations: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      metaAds: { synced: false, count: 0, saved: 0, total: 0, status: 'pending', message: 'Esperando...' }
    }

    logger.info('===========================================')
    logger.info('INICIANDO SINCRONIZACIÓN COMPLETA HIGHLEVEL')
    logger.info('===========================================')

    // 0. Reparación única: contactos con el teléfono guardado como nombre
    try {
      const nameCleanup = await cleanupPhoneLikeContactNames()
      if (nameCleanup.cleaned > 0) {
        logger.info(`🧽 Limpieza de nombres: ${nameCleanup.cleaned} contactos tenían el teléfono/email como nombre`)
      }
    } catch (error) {
      logger.warn(`No se pudo ejecutar la limpieza de nombres de contactos: ${error.message}`)
    }

    // 1. Configurar webhooks y obtener config de Meta
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`
    await setupHighLevelWebhooks(locationId, apiToken, baseUrl)

    // 1.5. Subir calendarios creados en Ristak antes de tocar citas.
    syncProgress.step = 'Subiendo calendarios Ristak a HighLevel...'
    let localCalendarsResult = { total: 0, created: 0, updated: 0, failed: 0 }
    try {
      localCalendarsResult = await syncLocalCalendarsToHighLevel(locationId, apiToken)
      logger.info(`Calendarios Ristak → GHL: ${localCalendarsResult.created} creados, ${localCalendarsResult.updated} actualizados, ${localCalendarsResult.failed} fallidos`)
    } catch (error) {
      logger.warn(`No se pudieron subir calendarios Ristak a HighLevel: ${error.message}`)
    }

    // 1.75. Sincronizar productos en ambos sentidos. Primero GHL -> local para
    // emparejar IDs remotos, despues local -> GHL para subir pendientes sin duplicar.
    syncProgress.step = 'Sincronizando productos...'
    updateProducts(0, 0, 'running', 'Emparejando catalogo Ristak y HighLevel...')
    let productsResult = {
      pulled: { total: 0, savedProducts: 0, savedPrices: 0 },
      pushed: { total: 0, created: 0, updated: 0, matched: 0, failed: 0, pricesCreated: 0, pricesUpdated: 0, pricesMatched: 0, pricesFailed: 0 }
    }
    try {
      productsResult = await syncProductsWithHighLevel(locationId, apiToken)
      const savedProducts = (productsResult.pulled.savedProducts || 0) +
        (productsResult.pushed.created || 0) +
        (productsResult.pushed.updated || 0) +
        (productsResult.pushed.matched || 0)
      const savedPrices = (productsResult.pulled.savedPrices || 0) +
        (productsResult.pushed.pricesCreated || 0) +
        (productsResult.pushed.pricesUpdated || 0) +
        (productsResult.pushed.pricesMatched || 0)
      updateProducts(
        savedProducts + savedPrices,
        (productsResult.pulled.total || 0) + (productsResult.pushed.total || 0),
        'completed',
        `${savedProducts} productos y ${savedPrices} precios sincronizados`
      )
      logger.info(`Productos Ristak/GHL: ${savedProducts} productos, ${savedPrices} precios, ${productsResult.pushed.failed + productsResult.pushed.pricesFailed} fallidos`)
    } catch (error) {
      updateProducts(0, 0, 'error', error.message)
      logger.warn(`No se pudieron sincronizar productos: ${error.message}`)
    }

    // 2. Sincronizar contactos
    syncProgress.step = 'Sincronizando contactos...'
    const contactsResult = await syncHighLevelContacts(locationId, apiToken)

    // 2.5. Subir contactos creados por WhatsApp cuando HighLevel todavía no los tiene
    syncProgress.step = 'Subiendo contactos WhatsApp a HighLevel...'
    const whatsappContactsResult = await syncWhatsAppContactsToHighLevel(locationId, apiToken)

    // 2.75. Subir citas creadas/editadas en Ristak antes de bajar lo remoto.
    syncProgress.step = 'Subiendo citas Ristak a HighLevel...'
    let localAppointmentsResult = { total: 0, created: 0, updated: 0, deleted: 0, failed: 0 }
    try {
      localAppointmentsResult = await syncLocalAppointmentsToHighLevel(locationId, apiToken)
      logger.info(`Citas Ristak → GHL: ${localAppointmentsResult.created} creadas, ${localAppointmentsResult.updated} actualizadas, ${localAppointmentsResult.deleted} eliminadas, ${localAppointmentsResult.failed} fallidas`)
    } catch (error) {
      logger.warn(`No se pudieron subir citas Ristak a HighLevel: ${error.message}`)
    }

    // 3. Sincronizar citas desde HighLevel hacia Ristak
    syncProgress.step = 'Sincronizando citas...'
    let appointmentsResult = { saved: 0, total: 0, contactsCreated: 0 }
    try {
      appointmentsResult = await syncHighLevelAppointments(locationId, apiToken)
    } catch (error) {
      logger.error(`No se pudieron sincronizar citas: ${error.message}`)
      logger.info('Continuando con sincronización de pagos...')
      // Mostrar el error real para diagnosticar (token sin permisos de calendarios, etc.)
      updateAppointments(0, 0, 'error', `Error sincronizando citas: ${error.message}`)
    }

    // 4. Sincronizar pagos (si falla, continuar con el resto de módulos)
    syncProgress.step = 'Sincronizando pagos...'
    let paymentsResult = { saved: 0, total: 0, contactsCreated: 0 }
    try {
      paymentsResult = await syncHighLevelPayments(locationId, apiToken)
    } catch (error) {
      logger.error(`No se pudieron sincronizar pagos: ${error.message}`)
      logger.info('Continuando con sincronización de conversaciones...')
    }

    // 4.25. Sincronizar historial de conversaciones (chats) para la app
    syncProgress.step = 'Preparando sincronización de conversaciones...'
    let conversationsResult = { total: 0, saved: 0, skipped: 0, contactsCreated: 0 }
    try {
      updateConversations(0, 0, 'running', 'Revisando volumen de chats en HighLevel...')
      const {
        estimateHighLevelConversationSyncVolume,
        syncHighLevelConversationHistory
      } = await import('./highlevelConversationsSyncService.js')
      let conversationEstimate = null
      try {
        conversationEstimate = await estimateHighLevelConversationSyncVolume({
          locationId,
          apiToken,
          fullSync: false
        })
        logger.info(
          `[GHL Conversations] Estimación de sync: ${describeConversationEstimate(conversationEstimate)} ` +
          `(estrategia=${conversationEstimate.strategy})`
        )
      } catch (estimateError) {
        conversationEstimate = {
          total: 0,
          unit: 'messages',
          strategy: 'unknown',
          useConversationBackfill: true,
          unknown: true,
          error: estimateError.message
        }
        logger.warn(`[GHL Conversations] No se pudo estimar volumen; se moverá al background: ${estimateError.message}`)
      }

      if (shouldRunHighLevelConversationsInBackground({ triggerSource, estimate: conversationEstimate })) {
        const background = startHighLevelConversationSyncInBackground({ locationId, apiToken, estimate: conversationEstimate })
        conversationsResult = {
          total: normalizeEstimateTotal(conversationEstimate),
          saved: 0,
          skipped: 0,
          contactsCreated: 0,
          background: true,
          backgroundStarted: background.started,
          alreadyRunning: background.alreadyRunning,
          strategy: conversationEstimate.strategy,
          estimatedUnit: conversationEstimate.unit
        }
        updateConversations(
          0,
          0,
          'completed',
          background.alreadyRunning
            ? 'Los chats ya se estaban importando en segundo plano'
            : 'Los chats se seguirán importando en segundo plano'
        )
      } else {
        syncProgress.step = 'Sincronizando conversaciones...'
        updateConversations(0, 0, 'running', 'Importando historial de chats de HighLevel...')
        conversationsResult = await syncHighLevelConversationHistory({
          locationId,
          apiToken,
          notifyNewInbound: false,
          onProgress: (saved, total, message) => updateConversations(saved, total, 'running', message)
        })
        updateConversations(
          conversationsResult.saved,
          Math.max(conversationsResult.total, conversationsResult.saved),
          'completed',
          `${conversationsResult.saved} mensajes de chat sincronizados`
        )
      }
    } catch (error) {
      logger.error(`No se pudieron sincronizar conversaciones: ${error.message}`)
      updateConversations(0, 0, 'error', `Error sincronizando chats: ${error.message}`)
    }

    // 4.5. Las estadísticas de pagos se actualizan por contacto dentro de
    // syncAllInvoices(). Evitar un barrido global aquí mantiene la sync rápida
    // aunque la cuenta ya tenga cientos de miles de contactos.
    syncProgress.step = 'Estadísticas de contactos actualizadas'

    // 5. Completado
    syncProgress.status = 'completed'
    syncProgress.step = 'Sincronización completada'
    const conversationsSummary = conversationsResult.background
      ? `chats importándose en segundo plano (${describeConversationEstimate({ total: conversationsResult.total, unit: conversationsResult.estimatedUnit })})`
      : `${conversationsResult.saved} mensajes de chat`
    syncProgress.message = `✅ Sincronización completada: ${contactsResult.saved} contactos GHL, ${whatsappContactsResult.synced} contactos WhatsApp, ${localCalendarsResult.created + localCalendarsResult.updated} calendarios Ristak→GHL, ${syncProgress.products.saved} productos/precios, ${localAppointmentsResult.created + localAppointmentsResult.updated} citas Ristak→GHL, ${appointmentsResult.saved} citas GHL→Ristak, ${paymentsResult.saved} pagos, ${conversationsSummary}`

    logger.info('===========================================')
    logger.info('SINCRONIZACIÓN COMPLETADA EXITOSAMENTE')
    logger.info(`Contactos GHL: ${contactsResult.saved}/${contactsResult.total}`)
    logger.info(`Contactos WhatsApp → GHL: ${whatsappContactsResult.synced}/${whatsappContactsResult.total} (${whatsappContactsResult.created} creados, ${whatsappContactsResult.matched} emparejados, ${whatsappContactsResult.failed} fallidos)`)
    logger.info(`Calendarios Ristak → GHL: ${localCalendarsResult.created + localCalendarsResult.updated}/${localCalendarsResult.total} (${localCalendarsResult.failed} fallidos)`)
    logger.info(`Productos/precios: ${syncProgress.products.saved}/${syncProgress.products.total}`)
    logger.info(`Citas Ristak → GHL: ${localAppointmentsResult.created + localAppointmentsResult.updated + localAppointmentsResult.deleted}/${localAppointmentsResult.total} (${localAppointmentsResult.failed} fallidas)`)
    logger.info(`Citas: ${appointmentsResult.saved}/${appointmentsResult.total} (${appointmentsResult.contactsCreated} contactos creados)`)
    logger.info(`Pagos: ${paymentsResult.saved}/${paymentsResult.total} (${paymentsResult.contactsCreated} contactos creados)`)
    logger.info(conversationsResult.background
      ? `Chats: importación en segundo plano (${describeConversationEstimate({ total: conversationsResult.total, unit: conversationsResult.estimatedUnit })})`
      : `Chats: ${conversationsResult.saved}/${conversationsResult.total} mensajes (${conversationsResult.contactsCreated} contactos creados)`)
    logger.info('===========================================')

    // PASO 5: Sincronizar anuncios de Meta (últimos 35 meses)
    logger.info('===========================================')

    syncProgress.step = 'Sincronizando anuncios de Meta'
    syncProgress.message = 'Obteniendo configuración de Meta...'
    updateMetaAds(false, 0, 'processing', 'Verificando configuración de Meta...')

    let metaAdsResult = { synced: false, message: 'No configurado' }

    try {
      // Verificar si hay configuración de Meta
      const metaConfig = await getMetaConfig()

      if (metaConfig && metaConfig.access_token && metaConfig.ad_account_id) {
        logger.info(`Ad Account: ${metaConfig.ad_account_id}`)

        syncProgress.message = 'Sincronizando anuncios de Meta (últimos 35 meses)...'
        updateMetaAds(false, 0, 'syncing', 'Sincronizando anuncios de los últimos 35 meses...')

        // Calcular fecha de inicio (35 meses atrás)
        const startDate = new Date()
        startDate.setMonth(startDate.getMonth() - 35)

        logger.info(`Sincronizando anuncios desde: ${formatDate(startDate)}`)

        // Sincronizar anuncios con callback de progreso
        const metaResult = await syncMetaAds(startDate, (progress) => {
          // Reportar progreso de Meta en tiempo real
          updateMetaAds(
            progress.status === 'completed',
            progress.saved || 0,
            progress.status,
            progress.message,
            progress.saved || 0,
            progress.total || 0
          )
        })

        if (metaResult.success) {
          logger.success('✅ Anuncios de Meta sincronizados exitosamente')

          // Contar anuncios sincronizados
          const adsCount = await db.get(
            'SELECT COUNT(*) as count FROM meta_ads WHERE ad_account_id = ?',
            [metaConfig.ad_account_id]
          )

          metaAdsResult = {
            synced: true,
            count: adsCount.count,
            message: `${adsCount.count} anuncios sincronizados`
          }

          updateMetaAds(true, adsCount.count, 'completed', `${adsCount.count} anuncios sincronizados exitosamente`)
        } else {
          metaAdsResult = { synced: false, message: 'Error en sincronización' }
          updateMetaAds(false, 0, 'error', 'Error en sincronización de anuncios')
        }
      } else {
        logger.info('💡 Configure Meta primero para sincronizar anuncios publicitarios')
        updateMetaAds(false, 0, 'skipped', 'No hay configuración de Meta')
      }
    } catch (metaError) {
      logger.error('Error sincronizando anuncios de Meta:', metaError.message)
      metaAdsResult = { synced: false, message: `Error: ${metaError.message}` }
      updateMetaAds(false, 0, 'error', `Error: ${metaError.message}`)
    }

    logger.info('===========================================')
    logger.success('🎉 SINCRONIZACIÓN COMPLETA')
    logger.info('===========================================')

    return {
      success: true,
      contacts: contactsResult,
      whatsappContacts: whatsappContactsResult,
      localCalendars: localCalendarsResult,
      products: productsResult,
      localAppointments: localAppointmentsResult,
      appointments: appointmentsResult,
      payments: paymentsResult,
      conversations: conversationsResult,
      metaAds: metaAdsResult
    }

  } catch (error) {
    logger.error('Error en sincronización:', error.message)
    syncProgress.status = 'error'
    syncProgress.step = 'Error en sincronización'
    syncProgress.message = `Error: ${error.message}`
    throw error
  }
}

export function isHighLevelDataSyncRunning() {
  return runHighLevelSyncSingleFlight.isRunning()
}

export function syncHighLevelData(locationId, apiToken, triggerSource = 'manual') {
  return runHighLevelSyncSingleFlight(
    () => runHighLevelDataSync(locationId, apiToken, triggerSource)
  )
}
