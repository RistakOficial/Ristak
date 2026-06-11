import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { sendWhatsAppApiTextMessage } from './whatsappApiService.js'
import { logger } from '../utils/logger.js'
import {
  DEFAULT_REMINDER_TEXT,
  DEFAULT_CONFIRMATION_TEXT,
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

const MESSAGE_TYPES = new Set(['reminder', 'confirmation'])
const OFFSET_UNITS = new Set(['minutes', 'hours', 'days'])
const SENDER_MODES = new Set(['contact', 'default', 'specific'])
const SMART_OVERFLOWS = new Set(['before', 'next_day'])

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function createServiceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function createReminderId() {
  return `apt_reminder_${crypto.randomUUID()}`
}

function createSendId() {
  return `apt_reminder_send_${crypto.randomUUID()}`
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeReminderRow(row = {}) {
  if (!row) return null
  const offsetUnit = OFFSET_UNITS.has(cleanString(row.offset_unit)) ? cleanString(row.offset_unit) : 'days'
  const offsetValue = Math.max(1, Math.round(Number(row.offset_value) || 1))
  return {
    id: cleanString(row.id),
    name: cleanString(row.name) || formatOffsetLabel(offsetValue, offsetUnit),
    enabled: Number(row.enabled || 0) === 1,
    messageType: MESSAGE_TYPES.has(cleanString(row.message_type)) ? cleanString(row.message_type) : 'reminder',
    aiEnabled: Number(row.ai_enabled || 0) === 1,
    channel: cleanString(row.channel) || 'whatsapp',
    senderMode: SENDER_MODES.has(cleanString(row.sender_mode)) ? cleanString(row.sender_mode) : 'contact',
    senderPhoneNumberId: cleanString(row.sender_phone_number_id) || null,
    offsetValue,
    offsetUnit,
    messageText: cleanString(row.message_text),
    smartEnabled: Number(row.smart_enabled || 0) === 1,
    smartStart: cleanString(row.smart_start) || '09:00',
    smartEnd: cleanString(row.smart_end) || '21:00',
    smartOverflow: SMART_OVERFLOWS.has(cleanString(row.smart_overflow)) ? cleanString(row.smart_overflow) : 'before',
    position: Number(row.position || 0),
    createdAt: cleanString(row.created_at),
    updatedAt: cleanString(row.updated_at)
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
    qrConnected: cleanString(row.qr_status) === 'connected'
  }))
}

export async function getAppointmentRemindersOverview() {
  const rows = await db.all('SELECT * FROM appointment_reminders ORDER BY position ASC, created_at ASC')
  const senders = await listSenderOptions()
  const whatsappConnected = senders.some(sender => sender.apiEnabled || sender.qrConnected)
  return {
    reminders: rows.map(normalizeReminderRow),
    senders,
    channels: [
      { id: 'whatsapp', label: 'WhatsApp', connected: whatsappConnected }
    ]
  }
}

function sanitizeReminderInput(input = {}, base = {}) {
  const merged = { ...base, ...input }

  const messageType = MESSAGE_TYPES.has(cleanString(merged.messageType)) ? cleanString(merged.messageType) : 'reminder'
  const offsetUnit = OFFSET_UNITS.has(cleanString(merged.offsetUnit)) ? cleanString(merged.offsetUnit) : 'days'
  const offsetValue = Math.max(1, Math.min(60, Math.round(Number(merged.offsetValue) || 1)))
  const smartStart = parseHHMM(merged.smartStart, null) ? cleanString(merged.smartStart) : '09:00'
  const smartEnd = parseHHMM(merged.smartEnd, null) ? cleanString(merged.smartEnd) : '21:00'

  return {
    name: cleanString(merged.name) || formatOffsetLabel(offsetValue, offsetUnit),
    enabled: merged.enabled === false ? 0 : 1,
    messageType,
    aiEnabled: merged.aiEnabled === false ? 0 : 1,
    channel: 'whatsapp',
    senderMode: SENDER_MODES.has(cleanString(merged.senderMode)) ? cleanString(merged.senderMode) : 'contact',
    senderPhoneNumberId: cleanString(merged.senderPhoneNumberId) || null,
    offsetValue,
    offsetUnit,
    messageText: cleanString(merged.messageText) ||
      (messageType === 'confirmation' ? DEFAULT_CONFIRMATION_TEXT : DEFAULT_REMINDER_TEXT),
    smartEnabled: merged.smartEnabled === false ? 0 : 1,
    smartStart,
    smartEnd,
    smartOverflow: SMART_OVERFLOWS.has(cleanString(merged.smartOverflow)) ? cleanString(merged.smartOverflow) : 'before'
  }
}

export async function createAppointmentReminder(input = {}) {
  const data = sanitizeReminderInput(input)
  const id = createReminderId()
  const positionRow = await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM appointment_reminders')

  await db.run(`
    INSERT INTO appointment_reminders (
      id, name, enabled, message_type, ai_enabled, channel, sender_mode,
      sender_phone_number_id, offset_value, offset_unit, message_text,
      smart_enabled, smart_start, smart_end, smart_overflow, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, data.name, data.enabled, data.messageType, data.aiEnabled, data.channel,
    data.senderMode, data.senderPhoneNumberId, data.offsetValue, data.offsetUnit,
    data.messageText, data.smartEnabled, data.smartStart, data.smartEnd,
    data.smartOverflow, Number(positionRow?.next || 0)
  ])

  return normalizeReminderRow(await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id]))
}

export async function updateAppointmentReminder(reminderId, input = {}) {
  const id = cleanString(reminderId)
  const existing = await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id])
  if (!existing) throw createServiceError('Mensaje automático no encontrado.', 404)

  const base = normalizeReminderRow(existing)
  const data = sanitizeReminderInput(input, base)

  // Si cambia el tiempo y el nombre era el autogenerado, regenerarlo.
  const autoName = formatOffsetLabel(base.offsetValue, base.offsetUnit)
  const name = (cleanString(input.name) || (base.name === autoName
    ? formatOffsetLabel(data.offsetValue, data.offsetUnit)
    : data.name))

  await db.run(`
    UPDATE appointment_reminders
    SET name = ?, enabled = ?, message_type = ?, ai_enabled = ?, sender_mode = ?,
      sender_phone_number_id = ?, offset_value = ?, offset_unit = ?, message_text = ?,
      smart_enabled = ?, smart_start = ?, smart_end = ?, smart_overflow = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name, data.enabled, data.messageType, data.aiEnabled, data.senderMode,
    data.senderPhoneNumberId, data.offsetValue, data.offsetUnit, data.messageText,
    data.smartEnabled, data.smartStart, data.smartEnd, data.smartOverflow, id
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
  const seeded = await getAppConfig(SEEDED_CONFIG_KEY)
  if (seeded) return

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

  if (!row) return { fromPhone: null, phoneNumberId: null, transport: 'api' }

  const apiEnabled = Number(row.api_send_enabled || 0) === 1
  return {
    fromPhone: cleanString(row.phone_number) || null,
    phoneNumberId: cleanString(row.id) || null,
    transport: apiEnabled ? 'api' : 'qr'
  }
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
    sendAt ? sendAt.toISO() : null, status === 'sent' ? nowIso() : null
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
  // El ajuste inteligente puede mover el envío hasta ~1 día; margen de 2 días.
  const maxLookaheadMs = Math.max(...reminders.map(offsetToMs)) + 2 * 24 * 60 * 60 * 1000

  const appointments = await db.all(`
    SELECT a.id, a.title, a.start_time, a.appointment_status, a.status, a.contact_id,
      c.phone, c.first_name, c.last_name, c.full_name, c.preferred_whatsapp_phone_number_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.start_time > ? AND a.start_time <= ?
      AND a.deleted_at IS NULL
      AND COALESCE(c.phone, '') != ''
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
  `, [now.toISO(), now.plus({ milliseconds: maxLookaheadMs }).toISO()])

  if (!appointments.length) return { sent: 0, errors: 0, skipped: 0 }

  const sendRows = await db.all('SELECT reminder_id, appointment_id FROM appointment_reminder_sends')
  const alreadyHandled = new Set(sendRows.map(row => `${row.reminder_id}|${row.appointment_id}`))

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

      const sendAt = computeReminderSendAt(appointment.start_time, reminder, timezone)
      if (!sendAt || sendAt > now) continue

      alreadyHandled.add(`${reminder.id}|${appointment.id}`)

      if (now.toMillis() - sendAt.toMillis() > SEND_GRACE_MS) {
        await recordSend({ reminder, appointment, status: 'skipped', sendAt, errorMessage: 'Fuera de la ventana de envío' })
        skipped += 1
        continue
      }

      try {
        const sender = await resolveSenderPhone(reminder, appointment)
        const text = renderMessageText(reminder.messageText, { contact: appointment, appointment, timezone })
        let response
        try {
          response = await sendWhatsAppApiTextMessage({
            to: appointment.phone,
            text,
            from: sender.fromPhone || undefined,
            phoneNumberId: sender.phoneNumberId || undefined,
            transport: sender.transport
          })
        } catch (error) {
          // Si la API oficial no está conectada, intentar por WhatsApp Web (QR).
          if (sender.transport === 'api' && /no está conectado/i.test(error.message || '')) {
            response = await sendWhatsAppApiTextMessage({
              to: appointment.phone,
              text,
              from: sender.fromPhone || undefined,
              phoneNumberId: sender.phoneNumberId || undefined,
              transport: 'qr'
            })
          } else {
            throw error
          }
        }

        await recordSend({ reminder, appointment, status: 'sent', sendAt, sentMessageId: response?.id || '' })
        sent += 1
        logger.info(`[Citas] Mensaje automático "${reminder.name}" enviado a ${appointment.phone} (cita ${appointment.id})`)
      } catch (error) {
        await recordSend({ reminder, appointment, status: 'error', sendAt, errorMessage: error.message })
        errors += 1
        logger.warn(`[Citas] Falló mensaje automático "${reminder.name}" para la cita ${appointment.id}: ${error.message}`)
      }
    }
  }

  return { sent, errors, skipped }
}
