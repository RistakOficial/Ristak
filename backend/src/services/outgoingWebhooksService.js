import crypto from 'crypto'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

export const OUTGOING_WEBHOOK_EVENT_OPTIONS = [
  {
    id: 'contacts',
    label: 'Contactos',
    description: 'Envía datos del contacto, atribución y campos personalizados.'
  },
  {
    id: 'appointments',
    label: 'Citas',
    description: 'Envía citas con estados como confirmed, cancelled, showed, noshow y pending.'
  },
  {
    id: 'payments',
    label: 'Pagos',
    description: 'Envía pagos con estados como succeeded, paid, refunded, partial, failed y void.'
  },
  {
    id: 'payment_plans',
    label: 'Planes de pago',
    description: 'Envía planes, parcialidades y cambios de estado.'
  },
  {
    id: 'refunds',
    label: 'Reembolsos',
    description: 'Envía reembolsos cuando un pago queda marcado como refunded.'
  }
]

const VALID_EVENT_IDS = new Set(OUTGOING_WEBHOOK_EVENT_OPTIONS.map(event => event.id))
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_TIMEOUT_MS = 10000
const MAX_RESPONSE_BODY_LENGTH = 4000

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return ['1', 'true', 'yes', 'si', 'activo', 'active'].includes(String(value).toLowerCase())
}

function normalizeScopeType(value) {
  return String(value || 'clinic').toLowerCase() === 'user' ? 'user' : 'clinic'
}

function normalizeEvents(events) {
  const source = Array.isArray(events) ? events : safeJsonParse(events, [])
  const normalized = [...new Set(source.map(event => String(event || '').trim()).filter(event => VALID_EVENT_IDS.has(event)))]
  return normalized.length > 0 ? normalized : ['contacts']
}

function parseDestination(row) {
  if (!row) return null

  return {
    id: row.id,
    name: row.name || 'Webhook saliente',
    url: row.url || '',
    isActive: Number(row.is_active ?? 1) === 1,
    scopeType: normalizeScopeType(row.scope_type),
    scopeId: row.scope_id || '',
    events: normalizeEvents(row.events_json),
    hasSecret: Boolean(row.secret),
    maxRetries: Number(row.max_retries ?? DEFAULT_MAX_RETRIES),
    timeoutMs: Number(row.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    createdByUserId: row.created_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function parseDelivery(row) {
  if (!row) return null

  return {
    id: row.id,
    destinationId: row.destination_id || null,
    destinationName: row.destination_name || row.current_destination_name || 'Destino eliminado',
    eventType: row.event_type,
    eventCategory: row.event_category,
    entityId: row.entity_id || null,
    entityTable: row.entity_table || null,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    maxRetries: Number(row.max_retries || DEFAULT_MAX_RETRIES),
    nextRetryAt: row.next_retry_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    httpStatus: row.http_status || null,
    responseBody: row.response_body || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function parseAttempt(row) {
  if (!row) return null

  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNumber: Number(row.attempt_number || 0),
    status: row.status,
    httpStatus: row.http_status || null,
    responseBody: row.response_body || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at || null
  }
}

function validateUrl(value) {
  const url = String(value || '').trim()
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Usa una URL que empiece con http:// o https://')
    }
    return parsed.toString()
  } catch (error) {
    const err = new Error(error.message || 'URL invalida')
    err.status = 400
    throw err
  }
}

function truncateValue(value, limit = MAX_RESPONSE_BODY_LENGTH) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function normalizeStatusForEvent(status, fallback = 'updated') {
  const normalized = String(status || fallback)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')

  if (normalized === 'succed') return 'succeeded'
  if (normalized === 'partial_payment' || normalized === 'partially_paid') return 'partial'
  if (normalized === 'canceled') return 'cancelled'
  return normalized || fallback
}

export function eventForPaymentStatus(status) {
  return `payment.${normalizeStatusForEvent(status)}`
}

export function eventForAppointmentStatus(status) {
  return `appointment.${normalizeStatusForEvent(status, 'updated')}`
}

export function eventForPaymentPlanStatus(status) {
  return `payment_plan.${normalizeStatusForEvent(status, 'updated')}`
}

async function getCurrentClinicScopeId() {
  const config = await db.get('SELECT location_id FROM highlevel_config LIMIT 1').catch(() => null)
  return config?.location_id || 'default'
}

export async function listOutgoingWebhookScopes() {
  const users = await db.all(
    `SELECT id, username, full_name, email
     FROM users
     WHERE is_active = 1
     ORDER BY COALESCE(full_name, username), id`
  ).catch(() => [])

  const clinicScopeId = await getCurrentClinicScopeId()

  return {
    clinic: {
      id: clinicScopeId,
      label: clinicScopeId === 'default' ? 'Clínica actual' : `Clínica ${clinicScopeId}`
    },
    users: users.map(user => ({
      id: String(user.id),
      label: user.full_name || user.username || user.email || `Usuario ${user.id}`,
      email: user.email || ''
    }))
  }
}

async function resolveScope({ scopeType, scopeId, userId }) {
  const type = normalizeScopeType(scopeType)

  if (type === 'user') {
    return {
      scopeType: 'user',
      scopeId: String(scopeId || userId || '').trim()
    }
  }

  return {
    scopeType: 'clinic',
    scopeId: String(scopeId || await getCurrentClinicScopeId()).trim() || 'default'
  }
}

export async function listOutgoingWebhookDestinations() {
  const rows = await db.all(
    `SELECT *
     FROM outgoing_webhook_destinations
     ORDER BY is_active DESC, updated_at DESC, created_at DESC`
  ).catch(() => [])

  return rows.map(parseDestination)
}

export async function getOutgoingWebhookDestination(id) {
  const row = await db.get('SELECT * FROM outgoing_webhook_destinations WHERE id = ?', [id])
  return parseDestination(row)
}

export async function saveOutgoingWebhookDestination(payload = {}, userId = null, destinationId = null) {
  const name = String(payload.name || '').trim()
  if (!name) {
    const error = new Error('Ponle un nombre al destino')
    error.status = 400
    throw error
  }

  const url = validateUrl(payload.url)
  const events = normalizeEvents(payload.events)
  const { scopeType, scopeId } = await resolveScope({
    scopeType: payload.scopeType || payload.scope_type,
    scopeId: payload.scopeId || payload.scope_id,
    userId
  })

  if (!scopeId) {
    const error = new Error('Elige usuario o clínica para este destino')
    error.status = 400
    throw error
  }

  const secret = payload.secret === undefined ? undefined : String(payload.secret || '').trim()
  const maxRetries = Math.max(0, Math.min(8, Number(payload.maxRetries ?? payload.max_retries ?? DEFAULT_MAX_RETRIES)))
  const timeoutMs = Math.max(2000, Math.min(30000, Number(payload.timeoutMs ?? payload.timeout_ms ?? DEFAULT_TIMEOUT_MS)))
  const isActive = normalizeBoolean(payload.isActive ?? payload.is_active, true) ? 1 : 0
  const id = destinationId || createId('owd')

  const existing = destinationId ? await db.get('SELECT secret FROM outgoing_webhook_destinations WHERE id = ?', [destinationId]) : null
  const nextSecret = secret === undefined ? (existing?.secret || null) : (secret || null)

  await db.run(
    `INSERT INTO outgoing_webhook_destinations (
      id, name, url, is_active, scope_type, scope_id, events_json, secret,
      max_retries, timeout_ms, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      is_active = excluded.is_active,
      scope_type = excluded.scope_type,
      scope_id = excluded.scope_id,
      events_json = excluded.events_json,
      secret = excluded.secret,
      max_retries = excluded.max_retries,
      timeout_ms = excluded.timeout_ms,
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      name,
      url,
      isActive,
      scopeType,
      scopeId,
      JSON.stringify(events),
      nextSecret,
      maxRetries,
      timeoutMs,
      userId || null
    ]
  )

  return getOutgoingWebhookDestination(id)
}

export async function deleteOutgoingWebhookDestination(id) {
  const destination = await getOutgoingWebhookDestination(id)
  if (!destination) return null

  await db.run('DELETE FROM outgoing_webhook_destinations WHERE id = ?', [id])
  return destination
}

function destinationMatchesEvent(destination, { category, userId, locationId }) {
  if (!destination.isActive) return false
  if (!destination.events.includes(category)) return false

  if (destination.scopeType === 'user') {
    return Boolean(userId) && String(destination.scopeId) === String(userId)
  }

  return !destination.scopeId ||
    destination.scopeId === 'default' ||
    !locationId ||
    String(destination.scopeId) === String(locationId)
}

async function getActiveDestinationsForEvent({ category, userId, locationId }) {
  const destinations = await listOutgoingWebhookDestinations()
  return destinations.filter(destination => destinationMatchesEvent(destination, { category, userId, locationId }))
}

function customFieldsByKey(customFields) {
  if (!Array.isArray(customFields)) return {}

  return customFields.reduce((acc, field) => {
    if (!field || typeof field !== 'object') return acc
    const key = field.field_key || field.key || field.id || field.name || field.label
    if (!key) return acc
    acc[String(key)] = field.value ?? field.field_value ?? field.values ?? null
    return acc
  }, {})
}

async function getContactSnapshot(contactId) {
  if (!contactId) return null
  const row = await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]).catch(() => null)
  if (!row) return null

  const customFields = safeJsonParse(row.custom_fields, [])

  return {
    id: row.id,
    phone: row.phone || null,
    email: row.email || null,
    fullName: row.full_name || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    source: row.source || null,
    visitorId: row.visitor_id || null,
    attribution: {
      url: row.attribution_url || null,
      sessionSource: row.attribution_session_source || null,
      medium: row.attribution_medium || null,
      ctwaClid: row.attribution_ctwa_clid || null,
      adName: row.attribution_ad_name || null,
      adId: row.attribution_ad_id || null
    },
    totalPaid: Number(row.total_paid || 0),
    purchasesCount: Number(row.purchases_count || 0),
    lastPurchaseDate: row.last_purchase_date || null,
    appointmentDate: row.appointment_date || null,
    customFields,
    customFieldsByKey: customFieldsByKey(customFields),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    raw: {
      ...row,
      custom_fields: customFields
    }
  }
}

async function getPaymentSnapshot(paymentId) {
  if (!paymentId) return null
  const row = await db.get('SELECT * FROM payments WHERE id = ? OR ghl_invoice_id = ? LIMIT 1', [paymentId, paymentId]).catch(() => null)
  if (!row) return null

  return {
    id: row.id,
    contactId: row.contact_id || null,
    amount: Number(row.amount || 0),
    currency: row.currency || 'MXN',
    status: row.status || null,
    paymentMethod: row.payment_method || null,
    paymentMode: row.payment_mode || 'live',
    reference: row.reference || null,
    title: row.title || null,
    description: row.description || null,
    date: row.date || null,
    dueDate: row.due_date || null,
    invoiceId: row.ghl_invoice_id || null,
    invoiceNumber: row.invoice_number || null,
    contact: await getContactSnapshot(row.contact_id),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    raw: row
  }
}

async function getAppointmentSnapshot(appointmentId) {
  if (!appointmentId) return null
  const row = await db.get('SELECT * FROM appointments WHERE id = ? OR ghl_appointment_id = ? LIMIT 1', [appointmentId, appointmentId]).catch(async error => {
    if (String(error.message || '').includes('ghl_appointment_id')) {
      return db.get('SELECT * FROM appointments WHERE id = ? LIMIT 1', [appointmentId]).catch(() => null)
    }
    return null
  })
  if (!row) return null

  return {
    id: row.id,
    calendarId: row.calendar_id || null,
    contactId: row.contact_id || null,
    locationId: row.location_id || null,
    title: row.title || null,
    status: row.status || null,
    appointmentStatus: row.appointment_status || row.status || null,
    assignedUserId: row.assigned_user_id || null,
    notes: row.notes || null,
    address: row.address || null,
    startTime: row.start_time || null,
    endTime: row.end_time || null,
    dateAdded: row.date_added || null,
    dateUpdated: row.date_updated || null,
    contact: await getContactSnapshot(row.contact_id),
    raw: row
  }
}

async function getPaymentPlanSnapshot(planId) {
  if (!planId) return null
  const row = await db.get('SELECT * FROM payment_plans WHERE id = ? OR ghl_schedule_id = ? LIMIT 1', [planId, planId]).catch(() => null)
  if (!row) return null

  return {
    id: row.id || row.ghl_schedule_id,
    scheduleId: row.ghl_schedule_id || row.id,
    contactId: row.contact_id || null,
    contactName: row.contact_name || null,
    email: row.email || null,
    phone: row.phone || null,
    name: row.name || row.title || 'Plan de pago',
    title: row.title || row.name || 'Plan de pago',
    status: row.status || null,
    total: Number(row.total || 0),
    currency: row.currency || 'MXN',
    description: row.description || null,
    recurrenceLabel: row.recurrence_label || null,
    startDate: row.start_date || null,
    nextRunAt: row.next_run_at || null,
    endDate: row.end_date || null,
    liveMode: row.live_mode === undefined || row.live_mode === null ? null : Boolean(row.live_mode),
    itemCount: Number(row.item_count || 0),
    schedule: safeJsonParse(row.schedule_json, {}),
    contact: await getContactSnapshot(row.contact_id),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    raw: {
      ...row,
      schedule_json: safeJsonParse(row.schedule_json, {}),
      raw_json: safeJsonParse(row.raw_json, row.raw_json)
    }
  }
}

async function buildPayloadData(category, entityId, fallbackData = null) {
  if (category === 'contacts') return await getContactSnapshot(entityId) || fallbackData
  if (category === 'appointments') return await getAppointmentSnapshot(entityId) || fallbackData
  if (category === 'payments') return await getPaymentSnapshot(entityId) || fallbackData
  if (category === 'payment_plans') return await getPaymentPlanSnapshot(entityId) || fallbackData
  if (category === 'refunds') {
    const payment = await getPaymentSnapshot(entityId)
    return {
      id: entityId,
      status: 'refunded',
      payment,
      contact: payment?.contact || null
    }
  }
  return fallbackData
}

function getEntityTable(category) {
  return {
    contacts: 'contacts',
    appointments: 'appointments',
    payments: 'payments',
    payment_plans: 'payment_plans',
    refunds: 'payments'
  }[category] || null
}

function inferPayloadStatus(data) {
  if (!data || typeof data !== 'object') return null
  return data.status || data.paymentStatus || data.appointmentStatus || data.payment?.status || null
}

export async function enqueueOutgoingWebhookEvent({
  category,
  event,
  entityId,
  data = null,
  userId = null,
  locationId = null,
  source = 'ristak'
}) {
  const eventCategory = String(category || '').trim()
  if (!VALID_EVENT_IDS.has(eventCategory)) return []

  const resolvedLocationId = locationId || await getCurrentClinicScopeId()
  const payloadData = await buildPayloadData(eventCategory, entityId, data)
  const destinations = await getActiveDestinationsForEvent({
    category: eventCategory,
    userId,
    locationId: resolvedLocationId
  })

  if (destinations.length === 0) return []

  const deliveryIds = []

  for (const destination of destinations) {
    const deliveryId = createId('owh')
    const occurredAt = new Date().toISOString()
    const payload = {
      id: deliveryId,
      app: 'Ristak',
      event,
      category: eventCategory,
      status: inferPayloadStatus(payloadData),
      occurredAt,
      deliveryId,
      source,
      scope: {
        type: destination.scopeType,
        id: destination.scopeId
      },
      data: payloadData
    }

    await db.run(
      `INSERT INTO outgoing_webhook_deliveries (
        id, destination_id, destination_name, event_type, event_category,
        entity_id, entity_table, status, attempt_count, max_retries,
        request_body, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        deliveryId,
        destination.id,
        destination.name,
        event,
        eventCategory,
        entityId || null,
        getEntityTable(eventCategory),
        destination.maxRetries,
        JSON.stringify(payload)
      ]
    )

    deliveryIds.push(deliveryId)
    setTimeout(() => {
      sendOutgoingWebhookDelivery(deliveryId).catch(error => {
        logger.warn(`No se pudo enviar webhook saliente ${deliveryId}: ${error.message}`)
      })
    }, 0)
  }

  return deliveryIds
}

function getRetryDelayMs(attemptNumber) {
  const seconds = Math.min(30 * Math.pow(2, Math.max(0, attemptNumber - 1)), 30 * 60)
  return seconds * 1000
}

function buildSignature(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
}

export async function sendOutgoingWebhookDelivery(deliveryId, { force = false } = {}) {
  const row = await db.get(
    `SELECT d.*, w.url, w.secret, w.timeout_ms, w.is_active
     FROM outgoing_webhook_deliveries d
     LEFT JOIN outgoing_webhook_destinations w ON w.id = d.destination_id
     WHERE d.id = ?`,
    [deliveryId]
  )

  if (!row) return null
  if (!row.url) {
    await db.run(
      `UPDATE outgoing_webhook_deliveries
       SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['El destino ya no existe', deliveryId]
    )
    return parseDelivery(row)
  }

  if (Number(row.is_active ?? 1) !== 1 && !force) {
    return parseDelivery(row)
  }

  const maxRetries = Number(row.max_retries ?? DEFAULT_MAX_RETRIES)
  const nextAttempt = Number(row.attempt_count || 0) + 1

  if (!force && Number(row.attempt_count || 0) >= maxRetries) {
    return parseDelivery(row)
  }

  const body = row.request_body || '{}'
  const timestamp = new Date().toISOString()
  const controller = new AbortController()
  const timeoutMs = Math.max(2000, Math.min(30000, Number(row.timeout_ms || DEFAULT_TIMEOUT_MS)))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  await db.run(
    `UPDATE outgoing_webhook_deliveries
     SET status = 'sending',
         attempt_count = ?,
         last_attempt_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextAttempt, timestamp, deliveryId]
  )

  try {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Ristak-Outbox/1.0',
      'X-Ristak-Event': row.event_type,
      'X-Ristak-Delivery-Id': deliveryId,
      'X-Ristak-Timestamp': timestamp
    }

    if (row.secret) {
      headers['X-Ristak-Signature'] = `sha256=${buildSignature(row.secret, timestamp, body)}`
    }

    const response = await fetch(row.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    })
    const responseBody = truncateValue(await response.text().catch(() => ''))
    const sent = response.status >= 200 && response.status < 300
    const nextRetryAt = !sent && nextAttempt < maxRetries
      ? new Date(Date.now() + getRetryDelayMs(nextAttempt)).toISOString()
      : null
    const status = sent ? 'sent' : (nextRetryAt ? 'retrying' : 'failed')
    const errorMessage = sent ? null : `Respuesta HTTP ${response.status}`

    await db.run(
      `INSERT INTO outgoing_webhook_attempts (
        id, delivery_id, attempt_number, status, http_status, response_body,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        createId('owa'),
        deliveryId,
        nextAttempt,
        sent ? 'sent' : 'failed',
        response.status,
        responseBody,
        errorMessage
      ]
    )

    await db.run(
      `UPDATE outgoing_webhook_deliveries
       SET status = ?,
           http_status = ?,
           response_body = ?,
           error_message = ?,
           next_retry_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, response.status, responseBody, errorMessage, nextRetryAt, deliveryId]
    )

    return getOutgoingWebhookDelivery(deliveryId)
  } catch (error) {
    const errorMessage = error.name === 'AbortError'
      ? `Tiempo agotado despues de ${timeoutMs / 1000}s`
      : error.message
    const nextRetryAt = nextAttempt < maxRetries
      ? new Date(Date.now() + getRetryDelayMs(nextAttempt)).toISOString()
      : null
    const status = nextRetryAt ? 'retrying' : 'failed'

    await db.run(
      `INSERT INTO outgoing_webhook_attempts (
        id, delivery_id, attempt_number, status, error_message, created_at
      ) VALUES (?, ?, ?, 'failed', ?, CURRENT_TIMESTAMP)`,
      [createId('owa'), deliveryId, nextAttempt, errorMessage]
    )

    await db.run(
      `UPDATE outgoing_webhook_deliveries
       SET status = ?,
           error_message = ?,
           next_retry_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, errorMessage, nextRetryAt, deliveryId]
    )

    return getOutgoingWebhookDelivery(deliveryId)
  } finally {
    clearTimeout(timeout)
  }
}

export async function getOutgoingWebhookDelivery(id) {
  const row = await db.get(
    `SELECT d.*, w.name as current_destination_name
     FROM outgoing_webhook_deliveries d
     LEFT JOIN outgoing_webhook_destinations w ON w.id = d.destination_id
     WHERE d.id = ?`,
    [id]
  )
  return parseDelivery(row)
}

export async function listOutgoingWebhookDeliveries({ limit = 50, status = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)))
  const filters = []
  const params = []

  if (status) {
    filters.push('d.status = ?')
    params.push(status)
  }

  params.push(safeLimit)

  const rows = await db.all(
    `SELECT d.*, w.name as current_destination_name
     FROM outgoing_webhook_deliveries d
     LEFT JOIN outgoing_webhook_destinations w ON w.id = d.destination_id
     ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
     ORDER BY d.created_at DESC
     LIMIT ?`,
    params
  ).catch(() => [])

  return rows.map(parseDelivery)
}

export async function listOutgoingWebhookAttempts(deliveryId) {
  const rows = await db.all(
    `SELECT *
     FROM outgoing_webhook_attempts
     WHERE delivery_id = ?
     ORDER BY attempt_number DESC, created_at DESC`,
    [deliveryId]
  ).catch(() => [])

  return rows.map(parseAttempt)
}

export async function retryOutgoingWebhookDelivery(deliveryId) {
  const delivery = await getOutgoingWebhookDelivery(deliveryId)
  if (!delivery) return null

  await db.run(
    `UPDATE outgoing_webhook_deliveries
     SET status = 'pending',
         next_retry_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [deliveryId]
  )

  return sendOutgoingWebhookDelivery(deliveryId, { force: true })
}

export async function sendOutgoingWebhookTest(destinationId) {
  const destination = await getOutgoingWebhookDestination(destinationId)
  if (!destination) return null

  const deliveryId = createId('owh')
  const payload = {
    id: deliveryId,
    app: 'Ristak',
    event: 'webhook.test',
    category: 'test',
    status: 'test',
    occurredAt: new Date().toISOString(),
    deliveryId,
    source: 'settings',
    scope: {
      type: destination.scopeType,
      id: destination.scopeId
    },
    data: {
      message: 'Prueba enviada desde Ristak',
      destination: destination.name,
      example: {
        contact: {
          id: 'contacto_ejemplo',
          fullName: 'Cliente de ejemplo',
          customFields: [
            { field_key: 'interes', label: 'Interés', value: 'Consulta inicial' }
          ]
        }
      }
    }
  }

  await db.run(
    `INSERT INTO outgoing_webhook_deliveries (
      id, destination_id, destination_name, event_type, event_category,
      entity_id, entity_table, status, attempt_count, max_retries,
      request_body, created_at, updated_at
    ) VALUES (?, ?, ?, 'webhook.test', 'test', NULL, NULL, 'pending', 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      deliveryId,
      destination.id,
      destination.name,
      destination.maxRetries,
      JSON.stringify(payload)
    ]
  )

  return sendOutgoingWebhookDelivery(deliveryId, { force: true })
}

export async function processDueOutgoingWebhookRetries() {
  const rows = await db.all(
    `SELECT id, next_retry_at
     FROM outgoing_webhook_deliveries
     WHERE status = 'retrying'
       AND next_retry_at IS NOT NULL
     ORDER BY next_retry_at ASC
     LIMIT 20`
  ).catch(() => [])

  const now = Date.now()
  const dueRows = rows.filter(row => {
    const time = new Date(row.next_retry_at).getTime()
    return Number.isFinite(time) && time <= now
  })

  for (const row of dueRows) {
    await sendOutgoingWebhookDelivery(row.id).catch(error => {
      logger.warn(`Reintento de webhook saliente falló ${row.id}: ${error.message}`)
    })
  }

  return dueRows.length
}
