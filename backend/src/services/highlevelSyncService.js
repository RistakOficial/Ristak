/**
 * HIGHLEVEL SYNC SERVICE
 * Sincroniza contactos, citas y pagos desde HighLevel
 */

import fetch from 'node-fetch'
import { db, setAppConfig, getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig, saveMetaConfig, syncMetaAds } from './metaAdsService.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'
import {
  fetchHighLevelContactCustomFieldDefinitions,
  resolveHighLevelContactCustomFields
} from './highlevelCustomFieldsService.js'
import { hasContactCustomFieldsPayload } from '../utils/contactCustomFields.js'
import {
  finalizePreparedPhoneUpsert,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import GHLClient from './ghlClient.js'
import {
  getLocalCalendar,
  syncLocalAppointmentsToHighLevel,
  syncLocalCalendarsToHighLevel,
  upsertLocalAppointment,
  upsertLocalCalendar
} from './localCalendarService.js'
import { syncProductsWithHighLevel } from './localProductService.js'

const HIGHLEVEL_BASE_URL = 'https://services.leadconnectorhq.com'
const HIGHLEVEL_API_VERSION = '2021-07-28'
const MASKED_SECRET_PREFIX = '***'
const META_CUSTOM_VALUE_FIELDS = [
  { key: 'adAccountId', names: ['Facebook - Ad Account ID'] },
  { key: 'accessToken', names: ['Facebook - App Access Token'], secret: true },
  { key: 'pixelId', names: ['Facebook - Pixel ID', 'pixel_id'] },
  { key: 'pageId', names: ['Facebook - Page ID'] },
  { key: 'instagramAccountId', names: ['Facebook - Instagram Account ID', 'Instagram Account ID'] },
  { key: 'pixelApiToken', names: ['Facebook - Pixel API Token'], secret: true },
  { key: 'whatsappBusinessAccountId', names: ['Facebook - WhatsApp Business Account ID', 'WhatsApp Business Account ID', 'WABA ID'] }
]

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
    (syncProgress.metaAds?.total || 0)

  const currentGlobal =
    (syncProgress.contacts.saved || 0) +
    (syncProgress.whatsappContacts?.saved || 0) +
    (syncProgress.appointments.saved || 0) +
    (syncProgress.products?.saved || 0) +
    (syncProgress.payments.saved || 0) +
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

function updateMetaAds(synced, count, status, message, saved = 0, total = 0) {
  syncProgress.metaAds = { synced, count, saved, total, status, message }
  updateGlobalProgress()
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
    adAccountId: normalizeAdAccountId(metaConfig.ad_account_id),
    accessToken: cleanString(metaConfig.access_token),
    pixelId: cleanString(metaConfig.pixel_id),
    pageId: cleanString(metaConfig.page_id),
    instagramAccountId: cleanString(metaConfig.instagram_account_id),
    pixelApiToken: cleanString(metaConfig.pixel_api_token),
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
    pixelApiToken: maskSecret(credentials.pixelApiToken),
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
    pixelApiToken: cleanString(primary.pixelApiToken || fallback.pixelApiToken),
    whatsappBusinessAccountId: cleanString(primary.whatsappBusinessAccountId || fallback.whatsappBusinessAccountId)
  }
}

function credentialsMissingValues(target = {}, source = {}) {
  target = target || {}
  source = source || {}
  return ['pixelId', 'pageId', 'instagramAccountId', 'pixelApiToken', 'whatsappBusinessAccountId'].some(key =>
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

    // Si no se agregaron items nuevos, es porque son duplicados - detenerse
    if (newItemsCount === 0 && pageItems.length > 0) {
      break
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
    dateUpdated
  }
}

async function fetchCalendarEventsByCalendar({
  locationId,
  apiToken,
  headers,
  startTime,
  endTime,
  limit,
  onProgress,
  initialTotal = 0
}) {
  const calendarLimit = 200
  const calendarParams = { locationId, limit: calendarLimit }

  const calendars = await collectPaginatedData({
    initialUrl: buildHighLevelUrl('/calendars', calendarParams),
    headers,
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
      headers,
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

async function ensureContactExists(contactId, apiToken, usePostgres, locationId) {
  if (!contactId) {
    return false
  }

  const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
  if (contactExists) {
    return false
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
      return false
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
    const phoneUpsert = await prepareContactPhoneUpsert({
      contactId: highLevelContactId,
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
      ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          visitor_id, custom_fields, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '[]'::jsonb), $15, $16)
         ON CONFLICT (id) DO UPDATE SET
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          source = EXCLUDED.source,
          attribution_url = EXCLUDED.attribution_url,
          attribution_session_source = EXCLUDED.attribution_session_source,
          attribution_medium = EXCLUDED.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), EXCLUDED.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), EXCLUDED.attribution_ad_name),
          visitor_id = COALESCE(EXCLUDED.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
          updated_at = EXCLUDED.updated_at`
      : `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          visitor_id, custom_fields, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?)
         ON CONFLICT (id) DO UPDATE SET
          phone = excluded.phone,
          email = excluded.email,
          full_name = excluded.full_name,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          source = excluded.source,
          attribution_url = excluded.attribution_url,
          attribution_session_source = excluded.attribution_session_source,
          attribution_medium = excluded.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
          visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
          updated_at = excluded.updated_at`

    await db.run(query, [
      highLevelContactId,
      phoneUpsert.phone || null,
      contact.email,
      contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contact.firstName,
      contact.lastName,
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
    await finalizePreparedPhoneUpsert(phoneUpsert, highLevelContactId)

    return true
  } catch (error) {
    logger.error(`Error obteniendo contacto ${contactId}: ${error.message}`)
    return false
  }
}

/**
 * Sincroniza contactos desde HighLevel (con paginación)
 */
async function syncHighLevelContacts(locationId, apiToken) {
  logger.info('Sincronizando contactos desde HighLevel...')

  let allContacts = []
  let nextPageUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}`
  let pageCount = 0

  // Paginar hasta obtener todos los contactos
  updateContacts(0, 0, 'running', 'Obteniendo contactos de HighLevel...')

  const MAX_429_RETRIES = 5
  const DEFAULT_RETRY_WAIT_MS = 60000 // 60 segundos por defecto si no hay Retry-After

  while (nextPageUrl) {
    pageCount++
    logger.info(`Obteniendo página ${pageCount}...`)

    let response = null
    let retries429 = 0

    while (retries429 <= MAX_429_RETRIES) {
      response = await fetch(nextPageUrl, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Version': '2021-07-28'
        }
      })

      if (response.status === 429) {
        if (retries429 >= MAX_429_RETRIES) {
          let errorBody = ''
          try { errorBody = await response.text() } catch (_) {}
          throw new Error(`Error ${response.status} obteniendo contactos: ${response.statusText}. Detalle: ${errorBody}`)
        }

        const retryAfterHeader = response.headers.get('Retry-After')
        const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : DEFAULT_RETRY_WAIT_MS
        const waitSec = Math.round(waitMs / 1000)

        retries429++
        logger.warn(`Rate limit alcanzado (429) en página ${pageCount}. Esperando ${waitSec}s antes de reintentar (intento ${retries429}/${MAX_429_RETRIES})...`)
        updateContacts(0, allContacts.length, 'running', `Rate limit de HighLevel. Esperando ${waitSec}s... (intento ${retries429})`)

        await new Promise(resolve => setTimeout(resolve, waitMs))
        continue
      }

      break // Respuesta distinta de 429, salir del loop de reintentos
    }

    if (!response.ok) {
      let errorBody = ''
      try { errorBody = await response.text() } catch (_) {}
      throw new Error(`Error ${response.status} obteniendo contactos: ${response.statusText}. Detalle: ${errorBody}`)
    }

    const data = await response.json()
    const contacts = data.contacts || []
    allContacts = allContacts.concat(contacts)

    logger.info(`Página ${pageCount}: ${contacts.length} contactos (total acumulado: ${allContacts.length})`)

    // Actualizar progreso en tiempo real
    updateContacts(0, allContacts.length, 'running', `Obteniendo contactos... ${allContacts.length} encontrados`)

    // Verificar si hay más páginas
    nextPageUrl = data.meta?.nextPageUrl || null
  }

  logger.info(`Total de contactos obtenidos: ${allContacts.length}`)
  updateContacts(0, allContacts.length, 'running', `Guardando ${allContacts.length} contactos en base de datos...`)

  let saved = 0
  const usePostgres = process.env.DATABASE_URL ? true : false
  const customFieldDefinitions = await fetchHighLevelContactCustomFieldDefinitions({ apiToken, locationId })

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
      const phoneUpsert = await prepareContactPhoneUpsert({
        contactId: highLevelContactId,
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
        ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            visitor_id, custom_fields, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '[]'::jsonb), $15, $16)
           ON CONFLICT (id) DO UPDATE SET
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            full_name = EXCLUDED.full_name,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            source = EXCLUDED.source,
            attribution_url = EXCLUDED.attribution_url,
            attribution_session_source = EXCLUDED.attribution_session_source,
            attribution_medium = EXCLUDED.attribution_medium,
            attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), EXCLUDED.attribution_ad_id),
            attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), EXCLUDED.attribution_ad_name),
            visitor_id = COALESCE(EXCLUDED.visitor_id, contacts.visitor_id),
            custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
            updated_at = EXCLUDED.updated_at`
        : `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            visitor_id, custom_fields, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?)
           ON CONFLICT (id) DO UPDATE SET
            phone = excluded.phone,
            email = excluded.email,
            full_name = excluded.full_name,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            source = excluded.source,
            attribution_url = excluded.attribution_url,
            attribution_session_source = excluded.attribution_session_source,
            attribution_medium = excluded.attribution_medium,
            attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
            attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
            visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
            custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
            updated_at = excluded.updated_at`

      await db.run(query, [
        highLevelContactId,
        phoneUpsert.phone || null,
        contact.email,
        contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        contact.firstName,
        contact.lastName,
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
      await finalizePreparedPhoneUpsert(phoneUpsert, highLevelContactId)

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
  return { saved, total: allContacts.length }
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
  return db.all(`
    SELECT id, phone, email, full_name, first_name, last_name, source, visitor_id,
      attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
      attribution_ad_name, attribution_ad_id, custom_fields, created_at
    FROM contacts
    WHERE id LIKE 'waapi_contact_%'
      AND phone IS NOT NULL
      AND phone != ''
    ORDER BY created_at ASC
  `)
}

async function findHighLevelContactForLocal(client, contact) {
  const searches = []
  if (contact.email) searches.push({ email: contact.email })
  if (contact.phone) searches.push({ phone: contact.phone })

  for (const search of searches) {
    try {
      const result = await client.searchContacts({ ...search, limit: 5 })
      const match = (result.contacts || []).find(candidate => candidate.id)
      if (match) return match
    } catch (error) {
      logger.warn(`No se pudo buscar contacto WhatsApp en HighLevel (${contact.id}): ${error.message}`)
    }
  }

  return null
}

async function upsertHighLevelContactLocallyFromWhatsApp({ localContact, highLevelContact }) {
  const targetId = highLevelContact.id || highLevelContact._id
  if (!targetId) throw new Error('HighLevel no devolvio id de contacto')

  const fullName = highLevelContact.name ||
    highLevelContact.contactName ||
    `${highLevelContact.firstName || ''} ${highLevelContact.lastName || ''}`.trim() ||
    localContact.full_name ||
    localContact.phone
  const firstName = highLevelContact.firstName || localContact.first_name || fullName?.split(' ')?.[0] || null
  const lastName = highLevelContact.lastName || localContact.last_name || null
  const phoneUpsert = await prepareContactPhoneUpsert({
    contactId: targetId,
    phone: highLevelContact.phone || localContact.phone
  })
  const usePostgres = process.env.DATABASE_URL ? true : false
  const customFieldsPlaceholder = usePostgres ? '?::jsonb' : '?'

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, first_name, last_name, source, visitor_id,
        attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
        attribution_ad_name, attribution_ad_id, custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        phone = COALESCE(excluded.phone, contacts.phone),
        email = COALESCE(excluded.email, contacts.email),
        full_name = COALESCE(excluded.full_name, contacts.full_name),
        first_name = COALESCE(excluded.first_name, contacts.first_name),
        last_name = COALESCE(excluded.last_name, contacts.last_name),
        source = COALESCE(excluded.source, contacts.source),
        visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
        attribution_url = COALESCE(excluded.attribution_url, contacts.attribution_url),
        attribution_session_source = COALESCE(excluded.attribution_session_source, contacts.attribution_session_source),
        attribution_medium = COALESCE(excluded.attribution_medium, contacts.attribution_medium),
        attribution_ctwa_clid = COALESCE(excluded.attribution_ctwa_clid, contacts.attribution_ctwa_clid),
        attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
        attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
        custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
        updated_at = CURRENT_TIMESTAMP
    `, [
      targetId,
      phoneUpsert.phone || null,
      highLevelContact.email || localContact.email || null,
      fullName || null,
      firstName || null,
      lastName || null,
      localContact.source || highLevelContact.source || 'WhatsApp Business',
      localContact.visitor_id || null,
      localContact.attribution_url || null,
      localContact.attribution_session_source || null,
      localContact.attribution_medium || null,
      localContact.attribution_ctwa_clid || null,
      localContact.attribution_ad_name || null,
      localContact.attribution_ad_id || null,
      serializeCustomFieldsForUpsert(localContact.custom_fields),
      localContact.created_at || null
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
        const fullName = contact.full_name ||
          `${contact.first_name || ''} ${contact.last_name || ''}`.trim() ||
          contact.phone ||
          'Contacto WhatsApp'
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

  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Version': HIGHLEVEL_API_VERSION,
    'Accept': 'application/json'
  }

  const limit = 200
  let allEventsRaw = []

  const now = new Date()
  const startTime = new Date(now.getFullYear() - 5, 0, 1).toISOString() // Hace 5 años, enero 1
  const endTime = new Date(now.getFullYear() + 5, 11, 31).toISOString() // Dentro de 5 años, diciembre 31

  logger.info(`Sincronizando citas desde ${startTime.split('T')[0]} hasta ${endTime.split('T')[0]}`)

  updateAppointments(0, 0, 'running', 'Obteniendo citas de HighLevel...')

  const progressUpdater = total => updateAppointments(0, total, 'running', `Obteniendo citas... ${total} encontradas`)

  // El endpoint /calendars/calendar-events no existe en HighLevel API v2
  // Usar directamente el método correcto: obtener calendarios primero
  // y luego las citas de cada calendario usando /calendars/events con calendarId

  logger.info('Usando método correcto: obteniendo calendarios y luego sus eventos...')

  const fetchResult = await fetchCalendarEventsByCalendar({
    locationId,
    apiToken,
    headers,
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

  for (const { normalized } of uniqueEvents) {
    try {
      // Verificar si el contacto existe
      const createdContact = await ensureContactExists(normalized.contactId, apiToken, usePostgres, locationId)
      if (createdContact) {
        contactsCreated++
      }

      const localCalendar = normalized.calendarId
        ? await getLocalCalendar(normalized.calendarId)
        : null

      await upsertLocalAppointment({
        ...normalized,
        id: normalized.id,
        ghlAppointmentId: normalized.id,
        calendarId: localCalendar?.id || normalized.calendarId
      }, {
        source: 'ghl',
        ghlAppointmentId: normalized.id,
        calendarId: localCalendar?.id || normalized.calendarId,
        locationId,
        syncStatus: 'synced'
      })

      // Actualizar appointment_date del contacto con la fecha de la cita más próxima
      if (normalized.contactId && normalized.startTime) {
        await db.run(`
          UPDATE contacts
          SET appointment_date = ?
          WHERE id = ?
          AND (appointment_date IS NULL OR appointment_date > ?)
        `, [normalized.startTime, normalized.contactId, normalized.startTime])
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
    'webhook_whatsapp_attribution': `${baseUrl}/webhook/whatsapp/attribution`
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

    // Mapeo de campos (System User - solo necesita Access Token + Ad Account + Pixel + Page ID + Pixel API Token)
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
      result.message = 'HighLevel no está configurado'
      return result
    }

    const [customValues, localCredentials] = await Promise.all([
      fetchHighLevelCustomValues(locationId, apiToken).catch(error => {
        logger.warn(`No se pudieron leer custom values para reconciliar Meta: ${error.message}`)
        return []
      }),
      getLocalMetaCredentials()
    ])

    const highLevelCredentials = extractMetaCredentialsFromCustomValues(customValues, { maskSecrets: false })
    const localComplete = hasRequiredMetaCredentials(localCredentials)
    const highLevelComplete = hasRequiredMetaCredentials(highLevelCredentials)

    result.localConfigured = localComplete
    result.highLevelConfigured = highLevelComplete
    result.highLevelHasAnyMetaValue = hasAnyMetaCredential(highLevelCredentials)

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
      const credentialsToSave = mergeMetaCredentials(highLevelCredentials)
      await saveMetaConfig(
        credentialsToSave.adAccountId,
        credentialsToSave.accessToken,
        credentialsToSave.pixelId || null,
        credentialsToSave.pixelApiToken || null,
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
      const highLevelNeedsUpdate = credentialsMissingValues(highLevelCredentials, localCredentials)

      if (localNeedsUpdate) {
        const mergedLocal = mergeMetaCredentials(localCredentials, highLevelCredentials)
        await saveMetaConfig(
          mergedLocal.adAccountId,
          mergedLocal.accessToken,
          mergedLocal.pixelId || null,
          mergedLocal.pixelApiToken || null,
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
      const credentialsToSave = mergeMetaCredentials(highLevelCredentials, localCredentials)
      await saveMetaConfig(
        credentialsToSave.adAccountId,
        credentialsToSave.accessToken,
        credentialsToSave.pixelId || null,
        credentialsToSave.pixelApiToken || null,
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
    logger.info(`Valores encontrados - AdAccountId: ${rawCredentials.adAccountId ? 'SÍ' : 'NO'}, AccessToken: ${rawCredentials.accessToken ? 'SÍ' : 'NO'}, PixelId: ${rawCredentials.pixelId ? 'SÍ' : 'NO'}, PageId: ${rawCredentials.pageId ? 'SÍ' : 'NO'}, Instagram: ${rawCredentials.instagramAccountId ? 'SÍ' : 'NO'}, PixelApiToken: ${rawCredentials.pixelApiToken ? 'SÍ' : 'NO'}, WABA: ${rawCredentials.whatsappBusinessAccountId ? 'SÍ' : 'NO'}`)

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
 * Sincronización principal que ejecuta todos los pasos
 * @param {string} locationId - ID del location de HighLevel
 * @param {string} apiToken - Token de API de HighLevel
 * @param {string} triggerSource - 'manual' o 'cron' - indica si se debe mostrar en UI
 */
export async function syncHighLevelData(locationId, apiToken, triggerSource = 'manual') {
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
      metaAds: { synced: false, count: 0, saved: 0, total: 0, status: 'pending', message: 'Esperando...' }
    }

    logger.info('===========================================')
    logger.info('INICIANDO SINCRONIZACIÓN COMPLETA HIGHLEVEL')
    logger.info('===========================================')

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
      logger.warn(`No se pudieron sincronizar citas: ${error.message}`)
      logger.info('Continuando con sincronización de pagos...')
      updateAppointments(0, 0, 'skipped', 'No hay calendarios configurados o sin permisos')
    }

    // 4. Sincronizar pagos
    syncProgress.step = 'Sincronizando pagos...'
    const paymentsResult = await syncHighLevelPayments(locationId, apiToken)

    // 4.5. Actualizar estadísticas de contactos (total_paid, purchases_count, etc.)
    syncProgress.step = 'Actualizando estadísticas de contactos...'
    logger.info('Actualizando estadísticas de contactos basadas en pagos y citas...')
    await updateContactsStats()

    // 5. Completado
    syncProgress.status = 'completed'
    syncProgress.step = 'Sincronización completada'
    syncProgress.message = `✅ Sincronización completada: ${contactsResult.saved} contactos GHL, ${whatsappContactsResult.synced} contactos WhatsApp, ${localCalendarsResult.created + localCalendarsResult.updated} calendarios Ristak→GHL, ${syncProgress.products.saved} productos/precios, ${localAppointmentsResult.created + localAppointmentsResult.updated} citas Ristak→GHL, ${appointmentsResult.saved} citas GHL→Ristak, ${paymentsResult.saved} pagos`

    logger.info('===========================================')
    logger.info('SINCRONIZACIÓN COMPLETADA EXITOSAMENTE')
    logger.info(`Contactos GHL: ${contactsResult.saved}/${contactsResult.total}`)
    logger.info(`Contactos WhatsApp → GHL: ${whatsappContactsResult.synced}/${whatsappContactsResult.total} (${whatsappContactsResult.created} creados, ${whatsappContactsResult.matched} emparejados, ${whatsappContactsResult.failed} fallidos)`)
    logger.info(`Calendarios Ristak → GHL: ${localCalendarsResult.created + localCalendarsResult.updated}/${localCalendarsResult.total} (${localCalendarsResult.failed} fallidos)`)
    logger.info(`Productos/precios: ${syncProgress.products.saved}/${syncProgress.products.total}`)
    logger.info(`Citas Ristak → GHL: ${localAppointmentsResult.created + localAppointmentsResult.updated + localAppointmentsResult.deleted}/${localAppointmentsResult.total} (${localAppointmentsResult.failed} fallidas)`)
    logger.info(`Citas: ${appointmentsResult.saved}/${appointmentsResult.total} (${appointmentsResult.contactsCreated} contactos creados)`)
    logger.info(`Pagos: ${paymentsResult.saved}/${paymentsResult.total} (${paymentsResult.contactsCreated} contactos creados)`)
    logger.info('===========================================')

    // PASO 5: Sincronizar anuncios de Meta (últimos 35 meses)
    logger.info('===========================================')

    syncProgress.step = 'Sincronizando anuncios de Meta'
    syncProgress.message = 'Obteniendo configuración de Meta...'
    updateMetaAds(false, 0, 'processing', 'Verificando configuración de Meta...')

    let metaAdsResult = { synced: false, message: 'No configurado' }

    try {
      // Verificar si hay configuración de Meta
      const metaConfig = await db.get('SELECT * FROM meta_config LIMIT 1')

      if (metaConfig && metaConfig.access_token && metaConfig.ad_account_id) {
        logger.info(`Ad Account: ${metaConfig.ad_account_id}`)

        syncProgress.message = 'Sincronizando anuncios de Meta (últimos 35 meses)...'
        updateMetaAds(false, 0, 'syncing', 'Sincronizando anuncios de los últimos 35 meses...')

        // Calcular fecha de inicio (35 meses atrás)
        const startDate = new Date()
        startDate.setMonth(startDate.getMonth() - 35)

        logger.info(`Sincronizando anuncios desde: ${startDate.toISOString().split('T')[0]}`)

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
