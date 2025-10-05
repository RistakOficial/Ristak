/**
 * HIGHLEVEL SYNC SERVICE
 * Sincroniza contactos, citas y pagos desde HighLevel
 */

import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { syncMetaAds } from './metaAdsService.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'

const HIGHLEVEL_BASE_URL = 'https://services.leadconnectorhq.com'
const HIGHLEVEL_API_VERSION = '2021-07-28'

// Variable global para trackear el estado de sincronización
let syncProgress = {
  status: 'idle',
  step: '',
  total: 0,
  current: 0,
  message: '',
  contacts: { saved: 0, total: 0, status: 'pending', message: '' },
  appointments: { saved: 0, total: 0, status: 'pending', message: '' },
  payments: { saved: 0, total: 0, status: 'pending', message: '' },
  metaAds: { synced: false, count: 0, status: 'pending', message: '' }
}

export function getSyncProgress() {
  return syncProgress
}

function updateContacts(saved, total, status, message) {
  syncProgress.contacts = { saved, total, status, message }
  logger.info(`Contactos: ${message}`)
}

function updateAppointments(saved, total, status, message) {
  syncProgress.appointments = { saved, total, status, message }
  logger.info(`Citas: ${message}`)
}

function updatePayments(saved, total, status, message) {
  syncProgress.payments = { saved, total, status, message }
  logger.info(`Pagos: ${message}`)
}

function updateMetaAds(synced, count, status, message) {
  syncProgress.metaAds = { synced, count, status, message }
  logger.info(`Meta Ads: ${message}`)
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
      logger.info(`Se detuvo la paginación de ${label} en la página ${page} porque todos los items ya existían (duplicados detectados)`)
      break
    }

    // Verificar si ya tenemos todos según totalCount de la API
    const totalCount = data.totalCount || data.total || data.meta?.total
    if (totalCount && items.length >= totalCount) {
      logger.info(`Se detuvo la paginación de ${label} porque ya se obtuvieron todos los registros (${items.length}/${totalCount})`)
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
  const id = raw._id || raw.id || raw.transactionId || raw.paymentId || raw.stripePaymentId || raw.invoicePaymentId
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
  const dateAdded = raw.dateAdded || raw.createdAt || raw.createdOn || startTime || new Date().toISOString()
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

    logger.info(`Sincronizando citas del calendario ${calendar.name || calendar.id}...`)

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
        logger.info(`Calendario ${calendar.name || calendar.id} - página ${page}: ${pageItems.length} citas (total acumulado: ${total})`)
        if (onProgress) onProgress(total)
      }
    })

    events.push(...calendarEvents)
  }

  return { events, total }
}

async function ensureContactExists(contactId, apiToken, usePostgres) {
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
    const contact = contactData.contact || contactData
    const attribution = contact.attributions?.find(a => a.isFirst) || {}

    const query = usePostgres
      ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`
      : `INSERT OR IGNORE INTO contacts (id, phone, email, full_name, first_name, last_name, source,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

    await db.run(query, [
      contact.id,
      contact.phone || contact.contactPhone,
      contact.email,
      contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contact.firstName,
      contact.lastName,
      contact.source || 'gohighlevel',
      attribution.pageUrl || attribution.url,
      attribution.utmSessionSource,
      attribution.medium,
      attribution.utmAdId,
      attribution.adName,
      contact.dateAdded || new Date().toISOString(),
      contact.dateUpdated || contact.dateAdded || new Date().toISOString()
    ])

    logger.info(`✅ Contacto ${contactId} creado/actualizado desde HighLevel`)
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

  while (nextPageUrl) {
    pageCount++
    logger.info(`Obteniendo página ${pageCount}...`)

    const response = await fetch(nextPageUrl, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      throw new Error(`Error obteniendo contactos: ${response.statusText}`)
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

  for (const contact of allContacts) {
    try {
      const attribution = contact.attributions?.find(a => a.isFirst) || {}

      const query = usePostgres
        ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            full_name = EXCLUDED.full_name,
            updated_at = EXCLUDED.updated_at`
        : `INSERT OR REPLACE INTO contacts (id, phone, email, full_name, first_name, last_name, source,
            attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

      await db.run(query, [
        contact.id,
        contact.phone || contact.contactPhone,
        contact.email,
        contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        contact.firstName,
        contact.lastName,
        contact.source || 'gohighlevel',
        attribution.pageUrl || attribution.url,
        attribution.utmSessionSource,
        attribution.medium,
        attribution.utmAdId,
        attribution.adName,
        contact.dateAdded || new Date().toISOString(),
        contact.dateUpdated || contact.dateAdded || new Date().toISOString()
      ])

      saved++

      // Actualizar progreso cada 50 contactos o si es el último
      if (saved % 50 === 0 || saved === allContacts.length) {
        updateContacts(saved, allContacts.length, 'running', `Guardando contactos: ${saved}/${allContacts.length}`)
      }
    } catch (err) {
      logger.error(`Error guardando contacto ${contact.id}: ${err.message}`)
    }
  }

  logger.info(`✅ Sincronizados ${saved}/${allContacts.length} contactos desde HighLevel`)
  updateContacts(saved, allContacts.length, 'completed', `${saved} contactos sincronizados exitosamente`)
  return { saved, total: allContacts.length }
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

  let fallbackNeeded = false

  try {
    allEventsRaw = await collectPaginatedData({
      initialUrl: buildHighLevelUrl('/calendars/calendar-events', {
        locationId,
        startTime,
        endTime,
        includeAll: 'true',
        limit
      }),
      headers,
      limit,
      label: 'citas',
      extractItems: data => Array.isArray(data.calendarEvents) ? data.calendarEvents : Array.isArray(data.events) ? data.events : [],
      rewriteUrlWithToken: token => buildHighLevelUrl('/calendars/calendar-events', {
        locationId,
        startTime,
        endTime,
        includeAll: 'true',
        limit,
        pageToken: token
      }),
      rewriteUrlWithOffset: offset => buildHighLevelUrl('/calendars/calendar-events', {
        locationId,
        startTime,
        endTime,
        includeAll: 'true',
        limit,
        offset
      }),
      onPage: ({ page, pageItems, total }) => {
        logger.info(`Página ${page}: ${pageItems.length} citas (total acumulado: ${total})`)
        progressUpdater(total)
      }
    })
  } catch (error) {
    logger.warn(`No fue posible usar /calendars/calendar-events (${error.status || 'sin código'}): ${error.message}`)
    fallbackNeeded = true
  }

  if (!fallbackNeeded && allEventsRaw.length === 0) {
    logger.warn('El endpoint /calendars/calendar-events no devolvió citas, intentando fallback por calendario...')
    fallbackNeeded = true
  }

  if (fallbackNeeded) {
    const fallback = await fetchCalendarEventsByCalendar({
      locationId,
      apiToken,
      headers,
      startTime,
      endTime,
      limit,
      onProgress: progressUpdater,
      initialTotal: allEventsRaw.length
    })
    allEventsRaw = fallback.events
  }

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
      const createdContact = await ensureContactExists(normalized.contactId, apiToken, usePostgres)
      if (createdContact) {
        contactsCreated++
      }

      // Ahora guardar la cita
      const query = usePostgres
        ? `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
            appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             appointment_status = EXCLUDED.appointment_status,
             start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time,
             notes = COALESCE(EXCLUDED.notes, appointments.notes),
             address = COALESCE(EXCLUDED.address, appointments.address),
             date_updated = EXCLUDED.date_updated`
        : `INSERT OR REPLACE INTO appointments (id, calendar_id, contact_id, location_id, title, status,
            appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

      await db.run(query, [
        normalized.id,
        normalized.calendarId,
        normalized.contactId,
        normalized.locationId,
        normalized.title,
        normalized.status,
        normalized.appointmentStatus,
        normalized.assignedUserId,
        normalized.notes,
        normalized.address,
        normalized.startTime,
        normalized.endTime,
        normalized.dateAdded,
        normalized.dateUpdated
      ])

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
 * Sincroniza pagos/transacciones desde HighLevel (con paginación)
 * Si un contacto no existe, lo obtiene de HighLevel y lo crea
 */
async function syncHighLevelPayments(locationId, apiToken) {
  logger.info('Sincronizando pagos desde HighLevel...')

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

  const paymentsById = new Map()
  for (const raw of paymentsRaw) {
    const normalized = normalizePaymentRecord(raw)
    if (!normalized.id) {
      logger.warn('Pago recibido sin ID, se omite')
      continue
    }
    if (!paymentsById.has(normalized.id)) {
      paymentsById.set(normalized.id, { raw, normalized })
    }
  }

  const allPayments = Array.from(paymentsById.values()).map(({ raw, normalized }) => ({ raw, normalized }))

  logger.info(`Total de pagos obtenidos: ${allPayments.length}`)
  updatePayments(0, allPayments.length, 'running', `Guardando ${allPayments.length} pagos en base de datos...`)

  let saved = 0
  let contactsCreated = 0
  const usePostgres = Boolean(process.env.DATABASE_URL)

  for (const { raw: payment, normalized } of allPayments) {
    try {
      const contactId = normalized.contactId
      const createdContact = await ensureContactExists(contactId, apiToken, usePostgres)
      if (createdContact) {
        contactsCreated++
      }

      // Ahora guardar el pago
      const query = usePostgres
        ? `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, reference, date, created_at, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             amount = EXCLUDED.amount,
             status = EXCLUDED.status,
             payment_method = EXCLUDED.payment_method,
             reference = EXCLUDED.reference,
             description = EXCLUDED.description,
             date = EXCLUDED.date`
        : `INSERT OR REPLACE INTO payments (id, contact_id, amount, currency, status, payment_method, reference, date, created_at, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

      await db.run(query, [
        normalized.id,
        normalized.contactId,
        normalized.amount,
        normalized.currency,
        normalized.status || payment.status || 'unknown',
        normalized.paymentMethod || payment.paymentProviderType || 'manual',
        normalized.reference || `${payment.entitySourceName || ''} - Invoice #${payment.entitySourceMeta?.invoiceNumber || ''}`.trim(),
        normalized.date || payment.fulfilledAt || payment.createdAt,
        normalized.createdAt,
        normalized.description
      ])
      saved++

      // Actualizar progreso cada 20 pagos o si es el último
      if (saved % 20 === 0 || saved === allPayments.length) {
        updatePayments(saved, allPayments.length, 'running', `Guardando pagos: ${saved}/${allPayments.length}`)
      }
    } catch (err) {
      logger.error(`Error guardando pago ${normalized.id}: ${err.message}`)
    }
  }

  logger.info(`✅ Sincronizados ${saved}/${allPayments.length} pagos desde HighLevel ${contactsCreated > 0 ? `(${contactsCreated} contactos creados)` : ''}`)
  updatePayments(saved, allPayments.length, 'completed', `${saved} pagos sincronizados exitosamente`)
  return { saved, total: allPayments.length, contactsCreated }
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
    'webhook_refunds': `${baseUrl}/webhook/refund`,
    'webhook_appointments': `${baseUrl}/webhook/appointment`,
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
    logger.info(`✅ Encontrados ${existingCustomValues.length} custom values existentes`)
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
          logger.info(`✅ Webhook actualizado: ${name} = ${value}`)
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
          logger.info(`✅ Webhook creado: ${name} = ${value}`)
          logger.info(`   ID creado: ${createData.customValue?.id}`)
        }
      }
    } catch (err) {
      logger.error(`❌ Error configurando webhook ${name}: ${err.message}`)
    }
  }

  // Obtener custom values de Meta/Facebook si existen
  await fetchAndSaveMetaConfig(locationId, apiToken)
}

/**
 * Obtiene custom values de Meta desde HighLevel y los guarda en meta_config
 */
async function fetchAndSaveMetaConfig(locationId, apiToken) {
  try {
    logger.info('Buscando configuración de Meta en custom values de HighLevel...')

    const url = `https://services.leadconnectorhq.com/locations/${locationId}/customValues`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      logger.warn('No se pudieron obtener custom values de HighLevel')
      return
    }

    const data = await response.json()
    const customValues = data.customValues || []

    // Debug: Ver todos los custom values recibidos
    logger.info(`Total de custom values encontrados: ${customValues.length}`)
    if (customValues.length > 0) {
      logger.info('Custom values disponibles:', customValues.map(cv => cv.name).join(', '))
    }

    // Buscar los custom values de Facebook (con los nombres reales de HighLevel)
    const fbAdAccountId = customValues.find(cv => cv.name === 'Facebook - Ad Account ID')?.value
    const fbAccessToken = customValues.find(cv => cv.name === 'Facebook - App Access Token')?.value
    const fbAppId = customValues.find(cv => cv.name === 'Facebook - App ID')?.value
    const fbAppSecret = customValues.find(cv => cv.name === 'Facebook - App Secret')?.value

    // Debug: Ver qué valores se encontraron
    logger.info(`Valores encontrados - AdAccountId: ${fbAdAccountId ? 'SÍ' : 'NO'}, AccessToken: ${fbAccessToken ? 'SÍ' : 'NO'}, AppId: ${fbAppId ? 'SÍ' : 'NO'}, AppSecret: ${fbAppSecret ? 'SÍ' : 'NO'}`)

    // Si tiene al menos ad_account_id y access_token, guardar config
    if (fbAdAccountId && fbAccessToken) {
      const usePostgres = process.env.DATABASE_URL ? true : false
      const query = usePostgres
        ? `INSERT INTO meta_config (ad_account_id, access_token, app_id, app_secret, updated_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (ad_account_id) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           app_id = EXCLUDED.app_id,
           app_secret = EXCLUDED.app_secret,
           updated_at = CURRENT_TIMESTAMP`
        : `INSERT OR REPLACE INTO meta_config (ad_account_id, access_token, app_id, app_secret, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`

      await db.run(query, [fbAdAccountId, fbAccessToken, fbAppId, fbAppSecret])
      logger.info('✅ Configuración de Meta obtenida desde HighLevel y guardada')
    } else {
      logger.info('No se encontró configuración completa de Meta en custom values')
    }
  } catch (error) {
    logger.error('Error obteniendo config de Meta desde HighLevel:', error.message)
  }
}

/**
 * Sincronización principal que ejecuta todos los pasos
 */
export async function syncHighLevelData(locationId, apiToken) {
  try {
    syncProgress = {
      status: 'running',
      step: 'Iniciando sincronización...',
      total: 0,
      current: 0,
      message: 'Preparando sincronización de datos',
      contacts: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      appointments: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' },
      payments: { saved: 0, total: 0, status: 'pending', message: 'Esperando...' }
    }

    logger.info('===========================================')
    logger.info('INICIANDO SINCRONIZACIÓN COMPLETA HIGHLEVEL')
    logger.info('===========================================')

    // 1. Configurar webhooks y obtener config de Meta
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`
    await setupHighLevelWebhooks(locationId, apiToken, baseUrl)

    // 2. Sincronizar contactos
    syncProgress.step = 'Sincronizando contactos...'
    const contactsResult = await syncHighLevelContacts(locationId, apiToken)

    // 3. Sincronizar citas
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
    logger.info('✅ Estadísticas de contactos actualizadas')

    // 5. Completado
    syncProgress.status = 'completed'
    syncProgress.step = 'Sincronización completada'
    syncProgress.message = `✅ Sincronización completada: ${contactsResult.saved} contactos, ${appointmentsResult.saved} citas, ${paymentsResult.saved} pagos`

    logger.info('===========================================')
    logger.info('SINCRONIZACIÓN COMPLETADA EXITOSAMENTE')
    logger.info(`Contactos: ${contactsResult.saved}/${contactsResult.total}`)
    logger.info(`Citas: ${appointmentsResult.saved}/${appointmentsResult.total} (${appointmentsResult.contactsCreated} contactos creados)`)
    logger.info(`Pagos: ${paymentsResult.saved}/${paymentsResult.total} (${paymentsResult.contactsCreated} contactos creados)`)
    logger.info('===========================================')

    // PASO 5: Sincronizar anuncios de Meta (últimos 35 meses)
    logger.info('📊 PASO 5: SINCRONIZACIÓN DE ANUNCIOS DE META')
    logger.info('===========================================')

    syncProgress.step = 'Sincronizando anuncios de Meta'
    syncProgress.message = 'Obteniendo configuración de Meta...'
    updateMetaAds(false, 0, 'processing', 'Verificando configuración de Meta...')

    let metaAdsResult = { synced: false, message: 'No configurado' }

    try {
      // Verificar si hay configuración de Meta
      const metaConfig = await db.get('SELECT * FROM meta_config LIMIT 1')

      if (metaConfig && metaConfig.access_token) {
        logger.info('✅ Configuración de Meta encontrada')
        logger.info(`Ad Account: ${metaConfig.ad_account_id}`)

        syncProgress.message = 'Sincronizando anuncios de Meta (últimos 35 meses)...'
        updateMetaAds(false, 0, 'syncing', 'Sincronizando anuncios de los últimos 35 meses...')

        // Calcular fecha de inicio (35 meses atrás)
        const startDate = new Date()
        startDate.setMonth(startDate.getMonth() - 35)

        logger.info(`Sincronizando anuncios desde: ${startDate.toISOString().split('T')[0]}`)

        // Sincronizar anuncios
        const metaResult = await syncMetaAds(startDate)

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
          logger.info(`📊 Total de anuncios sincronizados: ${adsCount.count}`)
        } else {
          logger.warn('⚠️ No se pudieron sincronizar los anuncios de Meta')
          metaAdsResult = { synced: false, message: 'Error en sincronización' }
          updateMetaAds(false, 0, 'error', 'Error en sincronización de anuncios')
        }
      } else {
        logger.info('⚠️ No hay configuración de Meta - saltando sincronización de anuncios')
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
