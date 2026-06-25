import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { sendWhatsAppApiTemplateMessage } from './whatsappApiService.js'

const MAX_BULK_CONTACTS = 1000
const DUE_BATCH_LIMIT = 50
const MIN_SCHEDULE_DELAY_MS = 5000

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function safeJson(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return fallback
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function serviceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  error.statusCode = status
  return error
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function nowIso() {
  return new Date().toISOString()
}

function contactDisplayName(row = {}) {
  return cleanString(row.full_name || row.first_name || row.name || row.phone || row.email || row.id || 'Contacto')
}

function normalizeContactIds(contactIds = []) {
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : [])
    .map(cleanString)
    .filter(Boolean))]

  if (ids.length === 0) throw serviceError('Selecciona al menos un contacto.')
  if (ids.length > MAX_BULK_CONTACTS) {
    throw serviceError(`Selecciona máximo ${MAX_BULK_CONTACTS} contactos por lote.`)
  }

  return ids
}

function normalizeSchedule(input = {}) {
  const mode = input.mode === 'scheduled' ? 'scheduled' : 'now'
  const rawScheduledAt = cleanString(input.scheduledAt)
  let scheduledAt = mode === 'scheduled' && rawScheduledAt
    ? new Date(rawScheduledAt)
    : new Date()

  if (Number.isNaN(scheduledAt.getTime())) {
    throw serviceError('Elige una fecha y hora válidas.')
  }

  if (mode === 'scheduled' && scheduledAt.getTime() < Date.now() + MIN_SCHEDULE_DELAY_MS) {
    throw serviceError('Elige una hora futura para programar el lote.')
  }

  const drip = input.drip || {}
  const dripEnabled = Boolean(drip.enabled)
  const dripIntervalMinutes = dripEnabled
    ? Math.max(1, Math.min(Number(drip.intervalMinutes) || 1, 1440))
    : 0

  return {
    mode,
    scheduledAt: scheduledAt.toISOString(),
    dripEnabled,
    dripIntervalMinutes
  }
}

function scheduledAtForIndex(schedule, index) {
  const base = new Date(schedule.scheduledAt).getTime()
  const offsetMs = schedule.dripEnabled ? schedule.dripIntervalMinutes * 60_000 * index : 0
  return new Date(base + offsetMs).toISOString()
}

async function getContactsByIds(contactIds) {
  const placeholders = contactIds.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT id, full_name, first_name, phone, email
     FROM contacts
     WHERE id IN (${placeholders})`,
    contactIds
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return contactIds.map((id) => byId.get(id)).filter(Boolean)
}

async function resolveSenderPhone({ phoneNumberId, fromPhone } = {}) {
  const direct = normalizePhoneForStorage(fromPhone) || cleanString(fromPhone)
  if (direct) return direct

  const id = cleanString(phoneNumberId)
  if (!id) return ''

  const row = await db.get(
    `SELECT phone_number, display_phone_number
     FROM whatsapp_api_phone_numbers
     WHERE id = ?`,
    [id]
  ).catch(() => null)

  return normalizePhoneForStorage(row?.phone_number || row?.display_phone_number) ||
    cleanString(row?.phone_number || row?.display_phone_number)
}

function mapBulkActionRow(row = {}) {
  const config = parseJson(row.config_json, {})
  return {
    id: row.id,
    actionType: row.action_type,
    title: row.title || '',
    status: row.status || 'scheduled',
    totalCount: Number(row.total_count || 0),
    processedCount: Number(row.processed_count || 0),
    successCount: Number(row.success_count || 0),
    errorCount: Number(row.error_count || 0),
    scheduledAt: row.scheduled_at || null,
    dripEnabled: Boolean(Number(row.drip_enabled || 0)),
    dripIntervalMinutes: Number(row.drip_interval_minutes || 0),
    config,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    pausedAt: row.paused_at || null,
    cancelledAt: row.cancelled_at || null
  }
}

function mapBulkActionItemRow(row = {}) {
  return {
    id: row.id,
    bulkActionId: row.bulk_action_id,
    contactId: row.contact_id,
    contactName: row.contact_name || 'Contacto',
    scheduledAt: row.scheduled_at || null,
    status: row.status || 'scheduled',
    result: parseJson(row.result_json, null),
    error: row.error || null,
    externalId: row.external_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    processedAt: row.processed_at || null
  }
}

async function refreshBulkActionCounters(bulkActionId) {
  const rows = await db.all(
    `SELECT status, COUNT(*) AS total
     FROM contact_bulk_action_items
     WHERE bulk_action_id = ?
     GROUP BY status`,
    [bulkActionId]
  )
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.total || 0)]))
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const success = counts.completed || 0
  const errors = counts.error || 0
  const cancelled = counts.cancelled || 0
  const processing = counts.processing || 0
  const scheduled = counts.scheduled || 0
  const processed = success + errors + cancelled

  const action = await db.get('SELECT status FROM contact_bulk_actions WHERE id = ?', [bulkActionId])
  if (!action) return null

  let nextStatus = action.status || 'scheduled'
  let completedAt = null
  if (!['paused', 'cancelled'].includes(nextStatus)) {
    if (processing > 0) nextStatus = 'processing'
    else if (scheduled > 0) nextStatus = 'scheduled'
    else {
      nextStatus = errors > 0 && success === 0 ? 'error' : 'completed'
      completedAt = nowIso()
    }
  }

  await db.run(
    `UPDATE contact_bulk_actions
     SET total_count = ?, processed_count = ?, success_count = ?, error_count = ?,
         status = ?, completed_at = COALESCE(completed_at, ?), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [total, processed, success, errors, nextStatus, completedAt, bulkActionId]
  )

  return getContactBulkAction(bulkActionId)
}

async function createBulkAction({ actionType, title, contactIds, schedule, config, userId }) {
  const ids = normalizeContactIds(contactIds)
  const contacts = await getContactsByIds(ids)
  if (contacts.length === 0) throw serviceError('No encontramos contactos válidos para este lote.', 404)

  const id = makeId('bulk')
  await db.run(
    `INSERT INTO contact_bulk_actions
       (id, action_type, title, status, total_count, scheduled_at, drip_enabled,
        drip_interval_minutes, config_json, created_by)
     VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      actionType,
      title,
      contacts.length,
      schedule.scheduledAt,
      schedule.dripEnabled ? 1 : 0,
      schedule.dripIntervalMinutes,
      safeJson(config),
      userId || null
    ]
  )

  for (let index = 0; index < contacts.length; index += 1) {
    const contact = contacts[index]
    await db.run(
      `INSERT INTO contact_bulk_action_items
         (id, bulk_action_id, contact_id, contact_name, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, 'scheduled')`,
      [
        makeId('bulkitem'),
        id,
        contact.id,
        contactDisplayName(contact),
        scheduledAtForIndex(schedule, index)
      ]
    )
  }

  return getContactBulkAction(id)
}

export async function createWhatsAppTemplateBulkAction(input = {}) {
  const schedule = normalizeSchedule(input.schedule || {})
  const templateId = cleanString(input.templateId)
  const templateName = cleanString(input.templateName)
  if (!templateId && !templateName) throw serviceError('Selecciona una plantilla de WhatsApp.')

  const phoneNumberId = cleanString(input.phoneNumberId)
  const fromPhone = await resolveSenderPhone({ phoneNumberId, fromPhone: input.fromPhone })
  if (!phoneNumberId && !fromPhone) throw serviceError('Elige el número de WhatsApp que mandará la plantilla.')

  // (CNT-006) Contar de antemano los contactos sin teléfono. Antes solo fallaban
  // ítem por ítem y en silencio después de mandar; ahora devolvemos el conteo en
  // la respuesta para que la UI pueda avisar cuántos no recibirán la plantilla.
  const requestedIds = normalizeContactIds(input.contactIds)
  let noPhoneCount = 0
  if (requestedIds.length > 0) {
    const requestedContacts = await getContactsByIds(requestedIds)
    noPhoneCount = requestedContacts.filter((contact) => !cleanString(contact?.phone)).length
  }

  const action = await createBulkAction({
    actionType: 'whatsapp_template',
    title: `WhatsApp: ${templateName || templateId}`,
    contactIds: input.contactIds,
    schedule,
    userId: input.userId,
    config: {
      templateId,
      templateName,
      language: cleanString(input.language),
      variables: input.variables || {},
      phoneNumberId,
      fromPhone
    }
  })

  if (schedule.mode === 'now') {
    processDueContactBulkActions({ bulkActionId: action.id, limit: DUE_BATCH_LIMIT }).catch((error) => {
      logger.error(`[Acciones masivas] No se pudo iniciar lote WhatsApp ${action.id}: ${error.message}`)
    })
  }

  // (CNT-006) Exponer cuántos contactos seleccionados no tienen teléfono para que
  // la UI lo advierta antes de mandar. Esos ítems fallarán al procesarse.
  return { ...action, skippedNoPhone: noPhoneCount }
}

export async function createAutomationBulkAction(input = {}) {
  const schedule = normalizeSchedule(input.schedule || {})
  const automationId = cleanString(input.automationId)
  if (!automationId) throw serviceError('Selecciona una automatización.')

  const automation = await db.get(
    `SELECT id, name, status
     FROM automations
     WHERE id = ?`,
    [automationId]
  )
  if (!automation) throw serviceError('Automatización no encontrada.', 404)
  if (automation.status !== 'published') {
    throw serviceError('Solo puedes agregar contactos a automatizaciones publicadas.')
  }

  const action = await createBulkAction({
    actionType: 'automation_enrollment',
    title: `Automatización: ${automation.name || automation.id}`,
    contactIds: input.contactIds,
    schedule,
    userId: input.userId,
    config: {
      automationId: automation.id,
      automationName: automation.name || 'Automatización'
    }
  })

  if (schedule.mode === 'now') {
    processDueContactBulkActions({ bulkActionId: action.id, limit: DUE_BATCH_LIMIT }).catch((error) => {
      logger.error(`[Acciones masivas] No se pudo iniciar lote de automatización ${action.id}: ${error.message}`)
    })
  }

  return action
}

export async function listContactBulkActions({ limit = 50 } = {}) {
  const rows = await db.all(
    `SELECT *
     FROM contact_bulk_actions
     ORDER BY created_at DESC
     LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 50, 200))]
  )
  return rows.map(mapBulkActionRow)
}

export async function getContactBulkAction(bulkActionId) {
  const id = cleanString(bulkActionId)
  if (!id) throw serviceError('Elige una acción masiva.')

  const [action, items] = await Promise.all([
    db.get('SELECT * FROM contact_bulk_actions WHERE id = ?', [id]),
    db.all(
      `SELECT *
       FROM contact_bulk_action_items
       WHERE bulk_action_id = ?
       ORDER BY scheduled_at ASC, created_at ASC`,
      [id]
    )
  ])

  if (!action) throw serviceError('Acción masiva no encontrada.', 404)
  return {
    ...mapBulkActionRow(action),
    items: items.map(mapBulkActionItemRow)
  }
}

async function claimBulkItem(itemId) {
  const result = await db.run(
    `UPDATE contact_bulk_action_items
     SET status = 'processing', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'scheduled'`,
    [itemId]
  )
  return Number(result?.changes || 0) > 0
}

async function markBulkItem(itemId, patch = {}) {
  await db.run(
    `UPDATE contact_bulk_action_items
     SET status = ?, result_json = ?, error = ?, external_id = ?,
         processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      patch.status,
      patch.result ? safeJson(patch.result, null) : null,
      patch.error || null,
      patch.externalId || null,
      itemId
    ]
  )
}

async function processWhatsAppTemplateItem({ action, item }) {
  const config = action.config || {}
  const contact = await db.get(
    'SELECT id, phone FROM contacts WHERE id = ?',
    [item.contactId]
  )
  if (!contact) throw serviceError('Contacto no encontrado.', 404)
  if (!cleanString(contact.phone)) throw serviceError('El contacto no tiene teléfono.')

  return sendWhatsAppApiTemplateMessage({
    to: contact.phone,
    from: config.fromPhone,
    templateId: config.templateId,
    templateName: config.templateName,
    language: config.language,
    variables: config.variables || {},
    contactId: contact.id,
    userId: action.createdBy,
    externalId: item.id,
    phoneNumberId: config.phoneNumberId
  })
}

async function processAutomationEnrollmentItem({ action, item }) {
  const config = action.config || {}
  const { enrollContactManually } = await import('./automationEngine.js')
  const enrollment = await enrollContactManually({
    automationId: config.automationId,
    contactId: item.contactId,
    source: `bulk-${action.id}`,
    scheduledFor: item.scheduledAt
  })
  return { enrollmentId: enrollment.id, status: enrollment.status }
}

async function processBulkItem(row) {
  const action = mapBulkActionRow({
    id: row.action_id,
    action_type: row.action_type,
    title: row.title,
    status: row.action_status,
    total_count: row.total_count,
    processed_count: row.processed_count,
    success_count: row.success_count,
    error_count: row.error_count,
    scheduled_at: row.action_scheduled_at,
    drip_enabled: row.drip_enabled,
    drip_interval_minutes: row.drip_interval_minutes,
    config_json: row.config_json,
    created_by: row.created_by,
    created_at: row.action_created_at,
    updated_at: row.action_updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    paused_at: row.paused_at,
    cancelled_at: row.cancelled_at
  })
  const item = mapBulkActionItemRow(row)
  if (action.status === 'paused' || action.status === 'cancelled') {
    return { skipped: true }
  }

  const claimed = await claimBulkItem(item.id)
  if (!claimed) return { skipped: true }

  await db.run(
    `UPDATE contact_bulk_actions
     SET status = 'processing', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('scheduled', 'error')`,
    [action.id]
  )

  try {
    const result = action.actionType === 'whatsapp_template'
      ? await processWhatsAppTemplateItem({ action, item })
      : await processAutomationEnrollmentItem({ action, item })

    await markBulkItem(item.id, {
      status: 'completed',
      result,
      externalId: cleanString(result?.id || result?.wamid || result?.messageId || result?.enrollmentId)
    })
    return { completed: true }
  } catch (error) {
    await markBulkItem(item.id, {
      status: 'error',
      error: error.message || 'No se pudo ejecutar la acción.',
      result: { error: error.message || String(error) }
    })
    logger.warn(`[Acciones masivas] Falló item ${item.id}: ${error.message}`)
    return { error: error.message || String(error) }
  } finally {
    await refreshBulkActionCounters(action.id).catch(() => undefined)
  }
}

export async function processDueContactBulkActions({ bulkActionId, limit = DUE_BATCH_LIMIT, referenceDate = new Date() } = {}) {
  const dueAt = referenceDate instanceof Date ? referenceDate.toISOString() : new Date(referenceDate).toISOString()
  const params = [dueAt]
  let actionClause = ''
  if (cleanString(bulkActionId)) {
    actionClause = 'AND b.id = ?'
    params.push(cleanString(bulkActionId))
  }
  params.push(Math.max(1, Math.min(Number(limit) || DUE_BATCH_LIMIT, 200)))

  const rows = await db.all(
    `SELECT
       i.*,
       b.id AS action_id,
       b.action_type,
       b.title,
       b.status AS action_status,
       b.total_count,
       b.processed_count,
       b.success_count,
       b.error_count,
       b.scheduled_at AS action_scheduled_at,
       b.drip_enabled,
       b.drip_interval_minutes,
       b.config_json,
       b.created_by,
       b.created_at AS action_created_at,
       b.updated_at AS action_updated_at,
       b.started_at,
       b.completed_at,
       b.paused_at,
       b.cancelled_at
     FROM contact_bulk_action_items i
     INNER JOIN contact_bulk_actions b ON b.id = i.bulk_action_id
     WHERE i.status = 'scheduled'
       AND i.scheduled_at <= ?
       AND b.status NOT IN ('paused', 'cancelled')
       ${actionClause}
     ORDER BY i.scheduled_at ASC, i.created_at ASC
     LIMIT ?`,
    params
  )

  const results = []
  const touchedActions = new Set()
  for (const row of rows) {
    touchedActions.add(row.bulk_action_id)
    results.push(await processBulkItem(row))
  }

  for (const actionId of touchedActions) {
    await refreshBulkActionCounters(actionId).catch(() => undefined)
  }

  return results
}

export async function pauseContactBulkAction(bulkActionId) {
  const id = cleanString(bulkActionId)
  const result = await db.run(
    `UPDATE contact_bulk_actions
     SET status = 'paused', paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
    [id]
  )
  if (Number(result?.changes || 0) === 0) throw serviceError('No se pudo detener esta acción.', 404)
  return getContactBulkAction(id)
}

export async function resumeContactBulkAction(bulkActionId) {
  const id = cleanString(bulkActionId)
  const result = await db.run(
    `UPDATE contact_bulk_actions
     SET status = 'scheduled', paused_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'paused'`,
    [id]
  )
  if (Number(result?.changes || 0) === 0) throw serviceError('No se pudo reanudar esta acción.', 404)
  processDueContactBulkActions({ bulkActionId: id }).catch((error) => {
    logger.error(`[Acciones masivas] No se pudo reanudar ${id}: ${error.message}`)
  })
  return getContactBulkAction(id)
}

export async function rescheduleContactBulkAction(bulkActionId, input = {}) {
  const id = cleanString(bulkActionId)
  const schedule = normalizeSchedule({ mode: 'scheduled', ...input.schedule })
  const action = await getContactBulkAction(id)
  const pending = action.items.filter((item) => ['scheduled', 'error', 'cancelled'].includes(item.status))

  for (let index = 0; index < pending.length; index += 1) {
    await db.run(
      `UPDATE contact_bulk_action_items
       SET status = 'scheduled', scheduled_at = ?, error = NULL,
           result_json = NULL, processed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [scheduledAtForIndex(schedule, index), pending[index].id]
    )
  }

  await db.run(
    `UPDATE contact_bulk_actions
     SET status = 'scheduled', scheduled_at = ?, drip_enabled = ?,
         drip_interval_minutes = ?, paused_at = NULL, cancelled_at = NULL,
         completed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [schedule.scheduledAt, schedule.dripEnabled ? 1 : 0, schedule.dripIntervalMinutes, id]
  )

  return refreshBulkActionCounters(id)
}

export async function cancelContactBulkAction(bulkActionId) {
  const id = cleanString(bulkActionId)
  await db.run(
    `UPDATE contact_bulk_action_items
     SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE bulk_action_id = ? AND status IN ('scheduled', 'error')`,
    [id]
  )
  await db.run(
    `UPDATE contact_bulk_actions
     SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [id]
  )
  return refreshBulkActionCounters(id)
}

export async function deleteContactBulkAction(bulkActionId) {
  const id = cleanString(bulkActionId)
  await db.run('DELETE FROM contact_bulk_action_items WHERE bulk_action_id = ?', [id])
  const result = await db.run('DELETE FROM contact_bulk_actions WHERE id = ?', [id])
  if (Number(result?.changes || 0) === 0) throw serviceError('Acción masiva no encontrada.', 404)
  return { deleted: true, id }
}
