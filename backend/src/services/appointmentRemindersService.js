import { DateTime } from 'luxon'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { createRistakId } from '../utils/idGenerator.js'
import {
  sendWhatsAppApiTemplateMessage,
  sendWhatsAppApiTextMessage
} from './whatsappApiService.js'
import { ensureDefaultAppointmentMessageTemplates } from './messageTemplatesService.js'
import { logger } from '../utils/logger.js'
import {
  DEFAULT_REMINDER_TEXT,
  DEFAULT_CONFIRMATION_TEXT,
  OFFSET_UNIT_MS,
  parseHHMM,
  formatOffsetLabel,
  offsetToMs,
  computeReminderSendAt,
  renderMessageText
} from './appointmentReminderLogic.js'

export { DEFAULT_REMINDER_TEXT, DEFAULT_CONFIRMATION_TEXT, formatOffsetLabel, computeReminderSendAt }

const SEEDED_CONFIG_KEY = 'appointment_reminders_seeded'

// Si un envío quedó pendiente demasiado tiempo (p.ej. cita creada después de
// que ya pasó la hora del recordatorio), se marca como omitido en vez de
// mandar un mensaje fuera de tiempo.
const SEND_GRACE_MS = 3 * 60 * 60 * 1000
// Un error de proveedor/configuración no debe bloquear para siempre el recordatorio:
// si el usuario corrige WhatsApp/plantilla, el cron reintenta sin spamear cada minuto.
const ERROR_RETRY_MS = 15 * 60 * 1000

const MESSAGE_TYPES = new Set(['reminder', 'confirmation'])
// Ancla de envío: 'before_appointment' = X antes del inicio de la cita (clásico);
// 'after_booking' = X después de agendar (avisos o confirmaciones de reservas por URL pública).
const TIMING_ANCHORS = new Set(['before_appointment', 'after_booking'])
const BEFORE_OFFSET_UNITS = new Set(['minutes', 'hours', 'days'])
// Después de agendar el tope es 24h, por eso se permiten segundos pero no días.
const AFTER_OFFSET_UNITS = new Set(['seconds', 'minutes', 'hours'])
const MAX_AFTER_BOOKING_MS = 24 * 60 * 60 * 1000
const SENDER_MODES = new Set(['contact', 'default', 'specific'])
const SMART_OVERFLOWS = new Set(['before', 'next_day'])
const NO_CONFIRM_ACTIONS = new Set(['no_action', 'cancel_appointment', 'notify_push'])
const CONFIRMATION_SUCCESS_ACTIONS = new Set(['mark_confirmed', 'chat_card', 'notify_push', 'chat_badge'])
const DEFAULT_TEMPLATE_NAME_BY_PURPOSE = {
  reminder: 'recordatorio_cita_un_dia_antes',
  notice: 'cita_programada',
  confirmation: 'confirmacion_cita_dia_anterior'
}
const APPROVED_TEMPLATE_STATUSES = new Set(['APPROVED'])
const FALLBACK_TEMPLATE_STATUSES = new Set([
  '',
  'DRAFT',
  'PENDING',
  'IN_REVIEW',
  'UNDER_REVIEW',
  'PENDING_REVIEW',
  'IN_APPEAL',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'ARCHIVED',
  'DELETED'
])

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeTemplateStatus(value) {
  return cleanString(value).toUpperCase()
}

function createServiceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function createReminderId() {
  return createRistakId('apt_reminder')
}

function createSendId() {
  return createRistakId('apt_reminder_send')
}

function nowIso() {
  return new Date().toISOString()
}

function parseStoredUtcDateTime(value) {
  const text = cleanString(value)
  if (!text) return null
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const parsed = DateTime.fromISO(normalized, { zone: 'utc' })
  return parsed.isValid ? parsed : null
}

function shouldHoldErroredSend(row, now) {
  const lastAttempt = parseStoredUtcDateTime(row.sent_at || row.created_at)
  if (!lastAttempt) return true
  return now.toMillis() - lastAttempt.toMillis() < ERROR_RETRY_MS
}

// Normaliza unidad/valor del offset según el ancla. Antes de la cita: minutos/horas/días,
// mínimo 1 (opcionalmente tope 60). Después de agendar: segundos/minutos/horas, permite 0
// (inmediato) y se recorta a 24h como máximo.
function normalizeOffsetForAnchor(timingAnchor, rawUnit, rawValue, { clampMax = false } = {}) {
  if (timingAnchor === 'after_booking') {
    const offsetUnit = AFTER_OFFSET_UNITS.has(cleanString(rawUnit)) ? cleanString(rawUnit) : 'minutes'
    let offsetValue = Math.max(0, Math.round(Number(rawValue) || 0))
    const unitMs = OFFSET_UNIT_MS[offsetUnit] || OFFSET_UNIT_MS.minutes
    if (clampMax && unitMs > 0 && offsetValue * unitMs > MAX_AFTER_BOOKING_MS) {
      offsetValue = Math.floor(MAX_AFTER_BOOKING_MS / unitMs)
    }
    return { timingAnchor, offsetUnit, offsetValue }
  }
  const offsetUnit = BEFORE_OFFSET_UNITS.has(cleanString(rawUnit)) ? cleanString(rawUnit) : 'days'
  const offsetValue = clampMax
    ? Math.max(1, Math.min(60, Math.round(Number(rawValue) || 1)))
    : Math.max(1, Math.round(Number(rawValue) || 1))
  return { timingAnchor: 'before_appointment', offsetUnit, offsetValue }
}

function normalizeReminderRow(row = {}) {
  if (!row) return null
  const { timingAnchor, offsetUnit, offsetValue } = normalizeOffsetForAnchor(
    TIMING_ANCHORS.has(cleanString(row.timing_anchor)) ? cleanString(row.timing_anchor) : 'before_appointment',
    row.offset_unit,
    row.offset_value
  )
  const templateName = cleanString(row.template_name || row.resolved_template_name)
  const templateLanguage = cleanString(row.template_language || row.resolved_template_language) || 'es_MX'
  return {
    id: cleanString(row.id),
    name: cleanString(row.name) || formatOffsetLabel(offsetValue, offsetUnit, timingAnchor),
    enabled: Number(row.enabled || 0) === 1,
    messageType: MESSAGE_TYPES.has(cleanString(row.message_type)) ? cleanString(row.message_type) : 'reminder',
    aiEnabled: Number(row.ai_enabled || 0) === 1,
    channel: cleanString(row.channel) || 'whatsapp',
    senderMode: SENDER_MODES.has(cleanString(row.sender_mode)) ? cleanString(row.sender_mode) : 'contact',
    senderPhoneNumberId: cleanString(row.sender_phone_number_id) || null,
    templateId: cleanString(row.template_id) || null,
    templateName: templateName || null,
    templateLanguage,
    timingAnchor,
    offsetValue,
    offsetUnit,
    messageText: cleanString(row.message_text),
    smartEnabled: Number(row.smart_enabled || 0) === 1,
    smartStart: cleanString(row.smart_start) || '09:00',
    smartEnd: cleanString(row.smart_end) || '21:00',
    smartOverflow: SMART_OVERFLOWS.has(cleanString(row.smart_overflow)) ? cleanString(row.smart_overflow) : 'before',
    noConfirmAction: NO_CONFIRM_ACTIONS.has(cleanString(row.no_confirm_action)) ? cleanString(row.no_confirm_action) : 'no_action',
    confirmationSuccessAction: CONFIRMATION_SUCCESS_ACTIONS.has(cleanString(row.confirmation_success_action)) ? cleanString(row.confirmation_success_action) : 'chat_card',
    bypassAutomations: Number(row.bypass_automations || 0) === 1,
    qrFallbackEnabled: Number(row.qr_fallback_enabled || 0) === 1,
    position: Number(row.position || 0),
    createdAt: cleanString(row.created_at),
    updatedAt: cleanString(row.updated_at)
  }
}

function mapReminderTemplateRow(row = {}) {
  if (!row) return null
  return {
    id: cleanString(row.id),
    name: cleanString(row.name),
    language: cleanString(row.language) || 'es_MX',
    status: cleanString(row.status) || 'draft',
    headerText: cleanString(row.header_text),
    bodyText: cleanString(row.body_text),
    footerText: cleanString(row.footer_text),
    buttons: parseJson(row.buttons_json, []),
    variableBindings: parseJson(row.variable_bindings_json, { headerText: {}, bodyText: {} }),
    ycloudTemplateName: cleanString(row.ycloud_template_name) || null,
    ycloudTemplateId: cleanString(row.ycloud_template_id) || null,
    ycloudStatus: normalizeTemplateStatus(row.ycloud_status)
  }
}

async function getReminderTemplateById(templateId) {
  const id = cleanString(templateId)
  if (!id) return null
  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  return row ? mapReminderTemplateRow(row) : null
}

async function getReminderTemplateByName(name, language = 'es_MX') {
  const cleanName = cleanString(name)
  if (!cleanName) return null
  const row = await db.get(`
    SELECT * FROM whatsapp_message_templates
    WHERE name = ? AND language = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [cleanName, cleanString(language) || 'es_MX'])
  return row ? mapReminderTemplateRow(row) : null
}

function getDefaultTemplateNameForReminder(data = {}) {
  const messageType = MESSAGE_TYPES.has(cleanString(data.messageType)) ? cleanString(data.messageType) : 'reminder'
  if (messageType === 'confirmation') return DEFAULT_TEMPLATE_NAME_BY_PURPOSE.confirmation

  const timingAnchor = TIMING_ANCHORS.has(cleanString(data.timingAnchor))
    ? cleanString(data.timingAnchor)
    : 'before_appointment'
  return timingAnchor === 'after_booking'
    ? DEFAULT_TEMPLATE_NAME_BY_PURPOSE.notice
    : DEFAULT_TEMPLATE_NAME_BY_PURPOSE.reminder
}

async function getDefaultReminderTemplate(data = {}) {
  const name = getDefaultTemplateNameForReminder(data)
  return getReminderTemplateByName(name, 'es_MX')
}

async function resolveReminderTemplateSelection(data = {}) {
  let template = await getReminderTemplateById(data.templateId)
  if (!template && data.templateName) {
    template = await getReminderTemplateByName(data.templateName, data.templateLanguage)
  }
  if (!template && !data.templateId) {
    template = await getDefaultReminderTemplate(data)
  }

  return {
    ...data,
    templateId: template?.id || cleanString(data.templateId) || null,
    templateName: template?.name || cleanString(data.templateName),
    templateLanguage: template?.language || cleanString(data.templateLanguage) || 'es_MX'
  }
}

async function backfillMissingReminderTemplates() {
  await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
  const rows = await db.all(`
    SELECT id, message_type, timing_anchor
    FROM appointment_reminders
    WHERE COALESCE(template_id, '') = ''
  `)

  for (const row of rows) {
    const messageType = MESSAGE_TYPES.has(cleanString(row.message_type)) ? cleanString(row.message_type) : 'reminder'
    const timingAnchor = TIMING_ANCHORS.has(cleanString(row.timing_anchor)) ? cleanString(row.timing_anchor) : 'before_appointment'
    const template = await getDefaultReminderTemplate({ messageType, timingAnchor })
    if (!template) continue
    await db.run(`
      UPDATE appointment_reminders
      SET template_id = ?, template_name = ?, template_language = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [template.id, template.name, template.language, row.id])
  }
}

async function listSenderOptions() {
  const rows = await db.all(`
    SELECT id, phone_number, display_phone_number, verified_name, label,
      is_default_sender, api_send_enabled, qr_send_enabled, qr_status
    FROM whatsapp_api_phone_numbers
    ORDER BY is_default_sender DESC, updated_at DESC, phone_number ASC
  `)

  return rows.map(row => ({
    id: cleanString(row.id),
    phone: cleanString(row.display_phone_number) || cleanString(row.phone_number),
    name: cleanString(row.verified_name) || cleanString(row.label),
    isDefault: Number(row.is_default_sender || 0) === 1,
    apiEnabled: Number(row.api_send_enabled || 0) === 1,
    qrConnected: Number(row.qr_send_enabled || 0) === 1 && cleanString(row.qr_status).toLowerCase() === 'connected'
  }))
}

// (NOTI-008) Antes los fallos de envío (p.ej. plantilla no APPROVED sin fallback QR) quedaban
// SOLO en logs/DB y la pantalla de recordatorios nunca los exponía: el usuario creía que sus
// recordatorios salían cuando ninguno salía. Aquí agregamos los fallos recientes (status='error')
// por recordatorio usando las columnas existentes, sin cambios de schema.
async function getRecentReminderFailures() {
  const rows = await db.all(`
    SELECT reminder_id,
      COUNT(*) AS error_count,
      MAX(COALESCE(sent_at, send_at, created_at)) AS last_error_at,
      MAX(id) AS latest_id
    FROM appointment_reminder_sends
    WHERE status = 'error'
    GROUP BY reminder_id
  `)

  const byReminder = new Map()
  for (const row of rows) {
    const reminderId = cleanString(row.reminder_id)
    if (!reminderId) continue
    // Trae el mensaje de error más reciente para mostrarlo en la UI.
    const latest = await db.get(`
      SELECT error_message, COALESCE(sent_at, send_at, created_at) AS occurred_at
      FROM appointment_reminder_sends
      WHERE reminder_id = ? AND status = 'error'
      ORDER BY COALESCE(sent_at, send_at, created_at) DESC, id DESC
      LIMIT 1
    `, [reminderId])
    byReminder.set(reminderId, {
      errorCount: Number(row.error_count || 0),
      lastErrorAt: cleanString(row.last_error_at) || null,
      lastErrorMessage: cleanString(latest?.error_message) || null
    })
  }
  return byReminder
}

async function getReminderTemplatesForOverview(reminders = []) {
  const templatesByReminder = new Map()
  const ids = [...new Set(reminders.map(reminder => cleanString(reminder.templateId)).filter(Boolean))]
  const templatesById = new Map()

  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await db.all(
      `SELECT * FROM whatsapp_message_templates WHERE id IN (${placeholders})`,
      ids
    )
    for (const row of rows) {
      const template = mapReminderTemplateRow(row)
      if (template?.id) templatesById.set(template.id, template)
    }
  }

  for (const reminder of reminders) {
    let template = templatesById.get(cleanString(reminder.templateId)) || null
    if (!template && reminder.templateName) {
      template = await getReminderTemplateByName(reminder.templateName, reminder.templateLanguage)
    }
    if (template) templatesByReminder.set(reminder.id, template)
  }

  return templatesByReminder
}

function describeTemplateStatus(status = '') {
  return normalizeTemplateStatus(status) || 'sin enviar a revisión'
}

function buildReminderDeliveryHealth(reminder, template, senders = []) {
  if (!reminder.enabled) {
    return {
      status: 'paused',
      message: 'Este mensaje automático está pausado.',
      details: []
    }
  }

  const errors = []
  const warnings = []
  const apiSenders = senders.filter(sender => sender.apiEnabled)
  const qrSenders = senders.filter(sender => sender.qrConnected)
  const selectedSender = reminder.senderMode === 'specific'
    ? senders.find(sender => sender.id === reminder.senderPhoneNumberId)
    : null
  const selectedQrPrimary = selectedSender && !selectedSender.apiEnabled && selectedSender.qrConnected
  const qrPrimaryAvailable = Boolean(selectedQrPrimary || (!apiSenders.length && qrSenders.length))

  if (!template) {
    errors.push('Selecciona una plantilla de WhatsApp para este recordatorio.')
  } else {
    const templateStatus = normalizeTemplateStatus(template.ycloudStatus)
    if (!APPROVED_TEMPLATE_STATUSES.has(templateStatus) && !qrPrimaryAvailable) {
      const statusLabel = describeTemplateStatus(templateStatus)
      if (reminder.qrFallbackEnabled && FALLBACK_TEMPLATE_STATUSES.has(templateStatus)) {
        if (qrSenders.length) {
          warnings.push(`La plantilla ${template.name} está ${statusLabel}; se usará QR como respaldo.`)
        } else {
          errors.push(`La plantilla ${template.name} está ${statusLabel} y no hay un número QR conectado para usar como respaldo.`)
        }
      } else {
        errors.push(`La plantilla ${template.name} está ${statusLabel}; debe estar APPROVED para enviarse por WhatsApp API.`)
      }
    }
  }

  if (reminder.senderMode === 'specific') {
    if (!selectedSender) {
      errors.push('El remitente elegido ya no está conectado.')
    } else if (!selectedSender.apiEnabled && !selectedSender.qrConnected) {
      errors.push('El remitente elegido no puede enviar por WhatsApp API ni QR.')
    }
  }

  if (!apiSenders.length && !qrSenders.length) {
    errors.push('Conecta un número de WhatsApp API o QR para enviar este recordatorio.')
  }

  if (reminder.qrFallbackEnabled && apiSenders.length && !qrSenders.length) {
    errors.push('El respaldo QR está activado, pero no hay un número QR conectado.')
  }

  const details = errors.length ? errors : warnings
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
    message: details[0] || 'Listo para enviar por WhatsApp.',
    details
  }
}

export async function getAppointmentRemindersOverview() {
  // (PANEL-FIX) El panel de "mensajes automáticos" no debe caerse entero por un fallo
  // en un paso de enriquecimiento (rellenar plantillas, remitentes de WhatsApp o el
  // historial de fallos). Lo ÚNICO crítico es leer los recordatorios; lo demás degrada
  // suave para que la lista siempre se muestre aunque WhatsApp/plantillas fallen.
  try {
    await backfillMissingReminderTemplates()
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudieron rellenar plantillas por defecto (no crítico): ${error.message}`)
  }

  const rows = await db.all('SELECT * FROM appointment_reminders ORDER BY position ASC, created_at ASC')
  const baseReminders = rows.map(normalizeReminderRow)

  let senders = []
  try {
    senders = await listSenderOptions()
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudieron cargar remitentes de WhatsApp (no crítico): ${error.message}`)
  }
  const whatsappConnected = senders.some(sender => sender.apiEnabled || sender.qrConnected)

  // (NOTI-008) Adjuntamos los fallos recientes a cada recordatorio para que la UI los exponga.
  let failuresByReminder = new Map()
  try {
    failuresByReminder = await getRecentReminderFailures()
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudo cargar el historial de fallos (no crítico): ${error.message}`)
  }

  let templatesByReminder = new Map()
  try {
    templatesByReminder = await getReminderTemplatesForOverview(baseReminders)
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudo cargar el estado de plantillas (no crítico): ${error.message}`)
  }

  const reminders = baseReminders.map(reminder => ({
    ...reminder,
    deliveryHealth: buildReminderDeliveryHealth(reminder, templatesByReminder.get(reminder.id) || null, senders),
    failures: failuresByReminder.get(reminder.id) || { errorCount: 0, lastErrorAt: null, lastErrorMessage: null }
  }))
  return {
    reminders,
    senders,
    channels: [
      { id: 'whatsapp', label: 'WhatsApp', connected: whatsappConnected }
    ]
  }
}

function sanitizeReminderInput(input = {}, base = {}) {
  const merged = { ...base, ...input }

  const messageType = MESSAGE_TYPES.has(cleanString(merged.messageType)) ? cleanString(merged.messageType) : 'reminder'
  const { timingAnchor, offsetUnit, offsetValue } = normalizeOffsetForAnchor(
    TIMING_ANCHORS.has(cleanString(merged.timingAnchor)) ? cleanString(merged.timingAnchor) : 'before_appointment',
    merged.offsetUnit,
    merged.offsetValue,
    { clampMax: true }
  )
  const smartStart = parseHHMM(merged.smartStart, null) ? cleanString(merged.smartStart) : '09:00'
  const smartEnd = parseHHMM(merged.smartEnd, null) ? cleanString(merged.smartEnd) : '21:00'
  const templateLanguage = cleanString(merged.templateLanguage) || 'es_MX'

  return {
    name: cleanString(merged.name) || formatOffsetLabel(offsetValue, offsetUnit, timingAnchor),
    enabled: merged.enabled === false ? 0 : 1,
    messageType,
    aiEnabled: merged.aiEnabled === false ? 0 : 1,
    channel: 'whatsapp',
    senderMode: SENDER_MODES.has(cleanString(merged.senderMode)) ? cleanString(merged.senderMode) : 'contact',
    senderPhoneNumberId: cleanString(merged.senderPhoneNumberId) || null,
    templateId: cleanString(merged.templateId) || null,
    templateName: cleanString(merged.templateName),
    templateLanguage,
    timingAnchor,
    offsetValue,
    offsetUnit,
    messageText: cleanString(merged.messageText) ||
      (messageType === 'confirmation' ? DEFAULT_CONFIRMATION_TEXT : DEFAULT_REMINDER_TEXT),
    smartEnabled: merged.smartEnabled === false ? 0 : 1,
    smartStart,
    smartEnd,
    smartOverflow: SMART_OVERFLOWS.has(cleanString(merged.smartOverflow)) ? cleanString(merged.smartOverflow) : 'before',
    noConfirmAction: NO_CONFIRM_ACTIONS.has(cleanString(merged.noConfirmAction)) ? cleanString(merged.noConfirmAction) : 'no_action',
    confirmationSuccessAction: CONFIRMATION_SUCCESS_ACTIONS.has(cleanString(merged.confirmationSuccessAction)) ? cleanString(merged.confirmationSuccessAction) : 'chat_card',
    bypassAutomations: merged.bypassAutomations === true ? 1 : 0,
    qrFallbackEnabled: merged.qrFallbackEnabled === true ? 1 : 0
  }
}

export async function createAppointmentReminder(input = {}) {
  await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
  const data = await resolveReminderTemplateSelection(sanitizeReminderInput(input))
  const id = createReminderId()
  const positionRow = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM appointment_reminders')

  await db.run(`
    INSERT INTO appointment_reminders (
      id, name, enabled, message_type, ai_enabled, channel, sender_mode,
      sender_phone_number_id, template_id, template_name, template_language,
      qr_fallback_enabled, timing_anchor, offset_value, offset_unit, message_text,
      smart_enabled, smart_start, smart_end, smart_overflow, no_confirm_action,
      confirmation_success_action, bypass_automations, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, data.name, data.enabled, data.messageType, data.aiEnabled, data.channel,
    data.senderMode, data.senderPhoneNumberId, data.templateId, data.templateName,
    data.templateLanguage, data.qrFallbackEnabled, data.timingAnchor, data.offsetValue, data.offsetUnit,
    data.messageText, data.smartEnabled, data.smartStart, data.smartEnd,
    data.smartOverflow, data.noConfirmAction, data.confirmationSuccessAction, data.bypassAutomations,
    Number(positionRow?.next || 0)
  ])

  return normalizeReminderRow(await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id]))
}

export async function updateAppointmentReminder(reminderId, input = {}) {
  const id = cleanString(reminderId)
  const existing = await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id])
  if (!existing) throw createServiceError('Mensaje automático no encontrado.', 404)

  const base = normalizeReminderRow(existing)
  const data = await resolveReminderTemplateSelection(sanitizeReminderInput(input, base))

  // Si cambia el tiempo/ancla y el nombre era el autogenerado, regenerarlo.
  const autoName = formatOffsetLabel(base.offsetValue, base.offsetUnit, base.timingAnchor)
  const name = (cleanString(input.name) || (base.name === autoName
    ? formatOffsetLabel(data.offsetValue, data.offsetUnit, data.timingAnchor)
    : data.name))

  await db.run(`
    UPDATE appointment_reminders
    SET name = ?, enabled = ?, message_type = ?, ai_enabled = ?, sender_mode = ?,
      sender_phone_number_id = ?, template_id = ?, template_name = ?, template_language = ?,
      qr_fallback_enabled = ?, timing_anchor = ?, offset_value = ?, offset_unit = ?, message_text = ?,
      smart_enabled = ?, smart_start = ?, smart_end = ?, smart_overflow = ?,
      no_confirm_action = ?, confirmation_success_action = ?, bypass_automations = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name, data.enabled, data.messageType, data.aiEnabled, data.senderMode,
    data.senderPhoneNumberId, data.templateId, data.templateName, data.templateLanguage,
    data.qrFallbackEnabled, data.timingAnchor, data.offsetValue, data.offsetUnit, data.messageText,
    data.smartEnabled, data.smartStart, data.smartEnd, data.smartOverflow,
    data.noConfirmAction, data.confirmationSuccessAction, data.bypassAutomations, id
  ])

  // Si cambió la configuración de tiempo, los envíos pendientes se recalculan
  // solos porque el cron computa la hora de envío al vuelo.
  return normalizeReminderRow(await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id]))
}

export async function deleteAppointmentReminder(reminderId) {
  const id = cleanString(reminderId)
  const existing = await db.get('SELECT id FROM appointment_reminders WHERE id = ?', [id])
  if (!existing) throw createServiceError('Mensaje automático no encontrado.', 404)

  await db.run('DELETE FROM appointment_reminders WHERE id = ?', [id])
  await db.run("DELETE FROM appointment_reminder_sends WHERE reminder_id = ? AND status != 'sent'", [id])
  return { id }
}

/**
 * Crea el recordatorio por defecto (1 día antes de la cita) una sola vez.
 * Usa una bandera en app_config para no recrearlo si el usuario lo borra.
 */
export async function ensureDefaultAppointmentReminder() {
  await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
  const seeded = await getAppConfig(SEEDED_CONFIG_KEY)
  if (seeded) {
    await backfillMissingReminderTemplates()
    return
  }

  const existing = await db.get('SELECT id FROM appointment_reminders LIMIT 1')
  if (!existing) {
    await createAppointmentReminder({
      name: '1 día antes',
      messageType: 'reminder',
      offsetValue: 1,
      offsetUnit: 'days',
      smartEnabled: true
    })
    logger.info('[Citas] Recordatorio por defecto creado (1 día antes)')
  }

  await backfillMissingReminderTemplates()
  await setAppConfig(SEEDED_CONFIG_KEY, '1')
}

async function resolveSenderPhone(reminder, contact) {
  const findById = async (id) => {
    if (!id) return null
    return db.get(`
      SELECT id, phone_number, api_send_enabled, qr_send_enabled, qr_status
      FROM whatsapp_api_phone_numbers WHERE id = ?
    `, [id])
  }

  let row = null
  if (reminder.senderMode === 'specific') {
    row = await findById(reminder.senderPhoneNumberId)
  } else if (reminder.senderMode === 'contact') {
    row = await findById(cleanString(contact.preferred_whatsapp_phone_number_id))
  }

  if (!row) {
    row = await db.get(`
      SELECT id, phone_number, api_send_enabled, qr_send_enabled, qr_status
      FROM whatsapp_api_phone_numbers
      WHERE api_send_enabled = 1 OR qr_send_enabled = 1 OR qr_status = 'connected'
      ORDER BY is_default_sender DESC, updated_at DESC
      LIMIT 1
    `)
  }

  if (!row) return {
    fromPhone: null,
    phoneNumberId: null,
    transport: 'api',
    apiEnabled: false,
    qrReady: false
  }

  const apiEnabled = Number(row.api_send_enabled || 0) === 1
  const qrReady = Number(row.qr_send_enabled || 0) === 1 && cleanString(row.qr_status).toLowerCase() === 'connected'
  return {
    fromPhone: cleanString(row.phone_number) || null,
    phoneNumberId: cleanString(row.id) || null,
    transport: apiEnabled ? 'api' : 'qr',
    apiEnabled,
    qrReady
  }
}

async function resolveQrFallbackSender(preferredSender = {}) {
  if (preferredSender.qrReady) return preferredSender

  const row = await db.get(`
    SELECT id, phone_number, api_send_enabled, qr_send_enabled, qr_status
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1 AND LOWER(COALESCE(qr_status, '')) = 'connected'
    ORDER BY is_default_sender DESC, updated_at DESC
    LIMIT 1
  `)

  if (!row) return null
  return {
    fromPhone: cleanString(row.phone_number) || null,
    phoneNumberId: cleanString(row.id) || null,
    transport: 'qr',
    apiEnabled: Number(row.api_send_enabled || 0) === 1,
    qrReady: true
  }
}

function extractNumericVariableIndexes(text = '') {
  const indexes = new Set()
  for (const match of cleanString(text).matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    indexes.add(Number(match[1]))
  }
  return [...indexes].filter(Number.isFinite).sort((a, b) => a - b)
}

function renderBindingValue(binding = {}, { appointment, timezone } = {}) {
  const mergeField = cleanString(binding.mergeField) ||
    (cleanString(binding.variableKey) ? `{{${cleanString(binding.variableKey)}}}` : '')
  if (!mergeField) return cleanString(binding.example)
  return renderMessageText(mergeField, { contact: appointment, appointment, timezone }) ||
    cleanString(binding.example)
}

function buildTemplateParameters(template, target, context) {
  const indexes = extractNumericVariableIndexes(template?.[target])
  if (!indexes.length) return []
  const bindings = template.variableBindings?.[target] || {}
  return indexes.map((index) => ({
    type: 'text',
    text: cleanString(renderBindingValue(bindings[String(index)], context))
  }))
}

function buildReminderTemplateComponents(template, context) {
  const components = []
  const headerParameters = buildTemplateParameters(template, 'headerText', context)
  if (headerParameters.length) {
    components.push({ type: 'header', parameters: headerParameters })
  }

  const bodyParameters = buildTemplateParameters(template, 'bodyText', context)
  if (bodyParameters.length) {
    components.push({ type: 'body', parameters: bodyParameters })
  }

  return components
}

function renderNumericTemplateText(text = '', bindings = {}, context) {
  return cleanString(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => (
    cleanString(renderBindingValue(bindings[String(index)], context)) || match
  ))
}

function renderReminderTemplateText(template, context) {
  const bindings = template.variableBindings || { headerText: {}, bodyText: {} }
  const parts = [
    renderNumericTemplateText(template.headerText, bindings.headerText || {}, context),
    renderNumericTemplateText(template.bodyText, bindings.bodyText || {}, context),
    cleanString(template.footerText)
  ].filter(Boolean)

  const buttonLabels = (Array.isArray(template.buttons) ? template.buttons : [])
    .map(button => cleanString(button.label || button.text || button.title))
    .filter(Boolean)
  if (buttonLabels.length) {
    parts.push(buttonLabels.map(label => `- ${label}`).join('\n'))
  }

  return parts.join('\n\n')
}

async function sendReminderViaQr({ reminder, appointment, sender, template, timezone, reason, primary = false }) {
  if (!primary && !reminder.qrFallbackEnabled) {
    throw new Error(reason || 'El respaldo por QR no está activado para este recordatorio.')
  }

  const qrSender = await resolveQrFallbackSender(sender)
  if (!qrSender?.qrReady) {
    throw new Error('El respaldo por QR está activado, pero no hay un número conectado por QR.')
  }

  const text = template
    ? renderReminderTemplateText(template, { appointment, timezone })
    : renderMessageText(reminder.messageText, { contact: appointment, appointment, timezone })

  return sendWhatsAppApiTextMessage({
    to: appointment.phone,
    text,
    from: qrSender.fromPhone || undefined,
    contactId: appointment.contact_id,
    phoneNumberId: qrSender.phoneNumberId || undefined,
    transport: 'qr'
  })
}

function shouldFallbackToQrAfterTemplateError(error) {
  const text = cleanString(error?.message)
  if (!text) return false
  return /WhatsApp[_\s-]*API no está conectado|WhatsApp Business no está conectado|Falta el número emisor|restricción|límite|limit|quality|sender|from|phone number|business account/i.test(text)
}

// (APT-003) Al reprogramar una cita (cambia start_time) hay que olvidar los envíos ya
// registrados para que el cron vuelva a calcular y reenviar el recordatorio en la nueva
// fecha. La llave de dedup es (reminder_id|appointment_id) y no incluye start_time, así que
// sin esto un recordatorio ya 'sent' nunca se recalcularía para la hora nueva.
//
// PERO solo aplica a los recordatorios anclados al inicio de la cita (before_appointment):
// reprogramar cambia start_time. Los avisos "después de agendar" se anclan a
// date_added (que NO cambia al reprogramar), así que sus envíos 'sent' se conservan; si los
// borráramos, el cron volvería a reclamar el par (reminder|cita) y reenviaría el MISMO
// mensaje al cliente.
export async function clearAppointmentReminderSends(appointmentId) {
  const id = cleanString(appointmentId)
  if (!id) return 0
  const res = await db.run(`
    DELETE FROM appointment_reminder_sends
    WHERE appointment_id = ?
      AND reminder_id IN (
        SELECT id FROM appointment_reminders
        WHERE COALESCE(timing_anchor, 'before_appointment') != 'after_booking'
      )
  `, [id])
  return Number(res?.changes || 0)
}

async function recordSend({ reminder, appointment, status, sendAt, sentMessageId = '', errorMessage = '' }) {
  await db.run(`
    INSERT INTO appointment_reminder_sends (
      id, reminder_id, appointment_id, contact_id, status, message_type,
      ai_enabled, sent_message_id, error_message, send_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    createSendId(), reminder.id, appointment.id, cleanString(appointment.contact_id) || null,
    status, reminder.messageType, reminder.aiEnabled ? 1 : 0,
    cleanString(sentMessageId) || null, cleanString(errorMessage) || null,
    sendAt ? sendAt.toISO() : null, ['sent', 'error', 'skipped'].includes(status) ? nowIso() : null
  ])
}

// (NOTI-002/CRON-003) Claim atómico ANTES de enviar el WhatsApp. Insertamos la fila en
// estado 'sending' aprovechando el UNIQUE(reminder_id, appointment_id); si otra instancia
// ya la insertó, el ON CONFLICT DO NOTHING deja changes=0 y NO enviamos (evita doble
// mensaje al cliente). Solo el proceso que gana el claim (changes>0) procede a enviar.
async function claimSend({ reminder, appointment, sendAt }) {
  const res = await db.run(`
    INSERT INTO appointment_reminder_sends (
      id, reminder_id, appointment_id, contact_id, status, message_type,
      ai_enabled, sent_message_id, error_message, send_at, sent_at
    ) VALUES (?, ?, ?, ?, 'sending', ?, ?, NULL, NULL, ?, NULL)
    ON CONFLICT (reminder_id, appointment_id) DO NOTHING
  `, [
    createSendId(), reminder.id, appointment.id, cleanString(appointment.contact_id) || null,
    reminder.messageType, reminder.aiEnabled ? 1 : 0,
    sendAt ? sendAt.toISO() : null
  ])
  if (Number(res?.changes || 0) > 0) return true

  // Si el intento anterior terminó en error y ya pasó el enfriamiento, reclamamos
  // la misma fila de forma atómica para reintentar. Los estados sent/skipped/sending
  // siguen siendo terminales para no duplicar mensajes.
  const retryCutoff = DateTime.utc().minus({ milliseconds: ERROR_RETRY_MS }).toISO()
  const retry = await db.run(`
    UPDATE appointment_reminder_sends
    SET status = 'sending',
        contact_id = ?,
        message_type = ?,
        ai_enabled = ?,
        sent_message_id = NULL,
        error_message = NULL,
        send_at = ?,
        sent_at = NULL
    WHERE reminder_id = ?
      AND appointment_id = ?
      AND status = 'error'
      AND datetime(COALESCE(sent_at, created_at)) <= datetime(?)
  `, [
    cleanString(appointment.contact_id) || null,
    reminder.messageType,
    reminder.aiEnabled ? 1 : 0,
    sendAt ? sendAt.toISO() : null,
    reminder.id,
    appointment.id,
    retryCutoff
  ])
  return Number(retry?.changes || 0) > 0
}

// (NOTI-002/CRON-003) Marca el resultado final del envío sobre la fila ya reclamada.
async function finalizeSend({ reminder, appointment, status, sentMessageId = '', errorMessage = '' }) {
  const finishedAt = nowIso()
  await db.run(`
    UPDATE appointment_reminder_sends
    SET status = ?,
        sent_message_id = ?,
        error_message = ?,
        sent_at = CASE WHEN ? IN ('sent', 'error', 'skipped') THEN ? ELSE sent_at END
    WHERE reminder_id = ? AND appointment_id = ?
  `, [
    status, cleanString(sentMessageId) || null, cleanString(errorMessage) || null,
    status, finishedAt, reminder.id, appointment.id
  ])
}

/**
 * Revisa las citas próximas y envía los mensajes automáticos que ya tocan.
 * Idempotente: cada par (recordatorio, cita) se envía una sola vez.
 */
export async function processDueAppointmentReminders({ batchSize = 25 } = {}) {
  const overview = await db.all("SELECT * FROM appointment_reminders WHERE enabled = 1")
  const reminders = overview.map(normalizeReminderRow)
  if (!reminders.length) return { sent: 0, errors: 0, skipped: 0 }

  const timezone = await getAccountTimezone()
  const now = DateTime.utc()

  // Dos anclas distintas exigen dos ventanas de búsqueda:
  //  - Antes de la cita: se busca por start_time próximo (clásico).
  //  - Después de agendar: se ancla a date_added (la reserva), así que se buscan
  //    reservas RECIENTES sin importar qué tan lejos esté la cita.
  const beforeReminders = reminders.filter(reminder => reminder.timingAnchor !== 'after_booking')
  const afterReminders = reminders.filter(reminder => reminder.timingAnchor === 'after_booking')

  const clauses = []
  const params = []

  if (beforeReminders.length) {
    // El ajuste inteligente puede mover el envío hasta ~1 día; margen de 2 días.
    const beforeLookaheadMs = Math.max(...beforeReminders.map(offsetToMs)) + 2 * 24 * 60 * 60 * 1000
    clauses.push('(a.start_time > ? AND a.start_time <= ?)')
    params.push(now.toISO(), now.plus({ milliseconds: beforeLookaheadMs }).toISO())
  }

  let afterSince = null
  if (afterReminders.length) {
    // Offset máx 24h + gracia de envío + 1 día de holgura por el envío inteligente.
    const afterWindowMs = Math.max(...afterReminders.map(offsetToMs)) + SEND_GRACE_MS + 24 * 60 * 60 * 1000
    afterSince = now.minus({ milliseconds: afterWindowMs })
    // Solo reservas hechas EN Ristak (URL pública/admin). Las citas sincronizadas desde
    // Google/GHL traen date_added = fecha de creación externa y la persona nunca agendó
    // con nosotros: no debe llegarles un aviso anclado a la reserva.
    clauses.push("(a.date_added IS NOT NULL AND a.date_added >= ? AND a.start_time > ? AND LOWER(COALESCE(a.source, 'ristak')) NOT IN ('google', 'ghl'))")
    params.push(afterSince.toISO(), now.toISO())
  }

  if (!clauses.length) return { sent: 0, errors: 0, skipped: 0 }

  const appointments = await db.all(`
    SELECT a.id, a.title, a.start_time, a.date_added, a.source, a.appointment_status, a.status, a.contact_id,
      c.phone, c.first_name, c.last_name, c.full_name, c.preferred_whatsapp_phone_number_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.deleted_at IS NULL
      AND COALESCE(c.phone, '') != ''
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
      AND (${clauses.join(' OR ')})
  `, params)

  if (!appointments.length) return { sent: 0, errors: 0, skipped: 0 }

  // (NOTI-006) Antes se cargaba TODA la tabla appointment_reminder_sends en memoria por tick,
  // lo que crece sin límite con el historial. Acotamos la consulta a solo las citas que estamos
  // procesando en este tick (las únicas cuyos sends nos interesan para deduplicar).
  const appointmentIds = appointments.map(appointment => appointment.id)
  const sendPlaceholders = appointmentIds.map(() => '?').join(', ')
  const sendRows = appointmentIds.length
    ? await db.all(
        `SELECT reminder_id, appointment_id, status, sent_at, created_at
         FROM appointment_reminder_sends
         WHERE appointment_id IN (${sendPlaceholders})`,
        appointmentIds
      )
    : []
  const alreadyHandled = new Set()
  for (const row of sendRows) {
    const key = `${row.reminder_id}|${row.appointment_id}`
    const status = cleanString(row.status).toLowerCase()
    if (status === 'error' && !shouldHoldErroredSend(row, now)) continue
    alreadyHandled.add(key)
  }

  let sent = 0
  let errors = 0
  let skipped = 0

  for (const appointment of appointments) {
    for (const reminder of reminders) {
      if (sent + errors >= batchSize) break
      if (alreadyHandled.has(`${reminder.id}|${appointment.id}`)) continue

      // Una confirmación ya no aplica si la cita está confirmada.
      const status = cleanString(appointment.appointment_status || appointment.status).toLowerCase()
      if (reminder.messageType === 'confirmation' && status === 'confirmed') continue

      // Los avisos "después de agendar" solo aplican a reservas hechas EN Ristak.
      // (La cita pudo entrar a la ventana por OTRO recordatorio anclado al inicio, así que
      // este guard es la verdad última, no solo el SQL.) Además, reservas viejas no las
      // disparan: evita marcar 'skipped' en masa para citas agendadas hace mucho.
      if (reminder.timingAnchor === 'after_booking') {
        const apptSource = cleanString(appointment.source).toLowerCase() || 'ristak'
        if (apptSource === 'google' || apptSource === 'ghl') continue
        const bookedAt = DateTime.fromISO(cleanString(appointment.date_added).replace(' ', 'T'), { zone: 'utc' })
        if (!bookedAt.isValid || (afterSince && bookedAt < afterSince)) continue
      }

      const sendAt = computeReminderSendAt(appointment.start_time, reminder, timezone, appointment.date_added)
      if (!sendAt || sendAt > now) continue

      // (NOTI-002/CRON-003) Reclamar ANTES de enviar. Si otra instancia ya reclamó este
      // par (reminder, cita) no enviamos para evitar el doble mensaje al cliente.
      const claimed = await claimSend({ reminder, appointment, sendAt })
      if (!claimed) {
        alreadyHandled.add(`${reminder.id}|${appointment.id}`)
        continue
      }
      alreadyHandled.add(`${reminder.id}|${appointment.id}`)

      if (now.toMillis() - sendAt.toMillis() > SEND_GRACE_MS) {
        await finalizeSend({ reminder, appointment, status: 'skipped', errorMessage: 'Fuera de la ventana de envío' })
        skipped += 1
        continue
      }

      try {
        const sender = await resolveSenderPhone(reminder, appointment)
        const template = await getReminderTemplateById(reminder.templateId)
        if (!template) {
          throw new Error('Selecciona una plantilla de WhatsApp para este recordatorio.')
        }

        const templateStatus = normalizeTemplateStatus(template.ycloudStatus)
        const useQrPrimary = !sender.apiEnabled && sender.qrReady
        let response
        if (useQrPrimary) {
          response = await sendReminderViaQr({
            reminder,
            appointment,
            sender,
            template,
            timezone,
            primary: true,
            reason: 'WhatsApp API no está disponible; se enviará por QR.'
          })
        } else if (!APPROVED_TEMPLATE_STATUSES.has(templateStatus)) {
          const statusLabel = templateStatus || 'sin enviar a revisión'
          if (!reminder.qrFallbackEnabled || !FALLBACK_TEMPLATE_STATUSES.has(templateStatus)) {
            throw new Error(`La plantilla ${template.name} está ${statusLabel}; solo se pueden enviar plantillas APPROVED por WhatsApp API.`)
          }
          response = await sendReminderViaQr({
            reminder,
            appointment,
            sender,
            template,
            timezone,
            reason: `La plantilla ${template.name} está ${statusLabel}; se usará QR como respaldo.`
          })
        } else if (!sender.apiEnabled && reminder.qrFallbackEnabled) {
          response = await sendReminderViaQr({
            reminder,
            appointment,
            sender,
            template,
            timezone,
            reason: 'WhatsApp API no está disponible para este remitente.'
          })
        } else {
          const components = buildReminderTemplateComponents(template, { appointment, timezone })
          try {
            response = await sendWhatsAppApiTemplateMessage({
              to: appointment.phone,
              from: sender.fromPhone || undefined,
              templateName: template.ycloudTemplateName || template.name,
              language: template.language,
              ...(components.length ? { components } : {}),
              contactId: appointment.contact_id,
              phoneNumberId: sender.phoneNumberId || undefined,
              allowQrFallback: reminder.qrFallbackEnabled === true
            })
          } catch (error) {
            if (reminder.qrFallbackEnabled && shouldFallbackToQrAfterTemplateError(error)) {
              response = await sendReminderViaQr({
                reminder,
                appointment,
                sender,
                template,
                timezone,
                reason: error.message
              })
            } else {
              throw error
            }
          }
        }

        await finalizeSend({ reminder, appointment, status: 'sent', sentMessageId: response?.id || '' })
        sent += 1
        const transport = response?.transport === 'qr' ? 'QR' : 'WhatsApp API'
        logger.info(`[Citas] Mensaje automático "${reminder.name}" enviado por ${transport} a ${appointment.phone} (cita ${appointment.id})`)
      } catch (error) {
        await finalizeSend({ reminder, appointment, status: 'error', errorMessage: error.message })
        errors += 1
        logger.warn(`[Citas] Falló mensaje automático "${reminder.name}" para la cita ${appointment.id}: ${error.message}`)
      }
    }
  }

  return { sent, errors, skipped }
}
