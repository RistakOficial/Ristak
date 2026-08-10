import { DateTime } from 'luxon'
import { databaseDialect, db, getAppConfig, setAppConfig } from '../config/database.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { createRistakId } from '../utils/idGenerator.js'
import {
  resolveWhatsAppOutboundRoute,
  sendWhatsAppApiTemplateMessage,
  sendWhatsAppApiTextMessage
} from './whatsappApiService.js'
import { getEmailStatus, sendEmailToContact } from './emailService.js'
import {
  isMetaSocialMessagingEnabled,
  sendMetaSocialTextMessage
} from './metaSocialMessagingService.js'
import {
  buildDefaultMessageTemplateFallbackText,
  buildDefaultMessageTemplateSendComponents,
  ensureDefaultAppointmentMessageTemplates,
  ensureOnlineMeetingMessageTemplate,
  getMessageTemplateProviderState
} from './messageTemplatesService.js'
import {
  renderTemplateVariables,
  renderTemplateVariablesInValue
} from './templateVariablesService.js'
import { logger } from '../utils/logger.js'
import { createInternalNotification } from './notificationsService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import {
  claimAppointmentTestAction,
  completeAppointmentTestAction,
  recordSimulatedAppointmentTestAction
} from './conversationalAppointmentTestAutomationAuditService.js'
import {
  DEFAULT_APPOINTMENT_NOTICE_TEXT,
  DEFAULT_REMINDER_TEXT,
  DEFAULT_CONFIRMATION_TEXT,
  OFFSET_UNIT_MS,
  parseHHMM,
  formatOffsetLabel,
  offsetToMs,
  computeConfirmationDeadline,
  computeReminderSendAt,
  renderMessageText,
  parseStoredUtcDateTime
} from './appointmentReminderLogic.js'
import {
  DEFAULT_CONFIRMATION_SUCCESS_ACTIONS,
  LEGACY_CONFIRMATION_SUCCESS_ACTIONS,
  normalizeConfirmationSuccessActions,
  serializeConfirmationSuccessActions
} from './appointmentConfirmationActions.js'
import {
  DEFAULT_ONE_HOUR_REMINDER_TEXT,
  LEGACY_DEFAULT_APPOINTMENT_NOTICE_TEXT
} from './appointmentMessageDefaults.js'
import { requireOpenAIApiKey } from './aiRuntimeService.js'

export {
  DEFAULT_APPOINTMENT_NOTICE_TEXT,
  DEFAULT_REMINDER_TEXT,
  DEFAULT_ONE_HOUR_REMINDER_TEXT,
  DEFAULT_CONFIRMATION_TEXT,
  DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT,
  formatOffsetLabel,
  computeReminderSendAt
}

export function appointmentReminderRetryCutoffExpression(dialect = databaseDialect) {
  return dialect === 'postgres'
    ? 'COALESCE(sent_at, created_at) <= ?::timestamp'
    : 'datetime(COALESCE(sent_at, created_at)) <= datetime(?)'
}

const SEEDED_CONFIG_KEY = 'appointment_reminders_seeded'
const DEFAULT_BOOKING_NOTICE_SYSTEM_KEY = 'default_on_booking'
const DEFAULT_ONE_HOUR_REMINDER_SYSTEM_KEY = 'default_one_hour_before'
const DEFAULT_CONFIRMATION_SYSTEM_KEY = 'default_one_day_before'
const ONLINE_MEETING_REMINDER_SYSTEM_KEY = 'online_meeting_join_link_10m'
const ONLINE_MEETING_TEMPLATE_NAME = 'acceso_videollamada_10_minutos_v2'
const ONLINE_MEETING_REMINDER_MESSAGE_TEXT = 'Aquí te paso el enlace para conectarnos:\n{{cita.enlace_ingreso}}\n\nYo me conecto en diez minutos. También te envié el enlace por correo electrónico, por si no puedes ingresar desde aquí.\n\nUn favor, ¿puedes ir ingresando para verificar que sí puedes entrar? Gracias.'
const REMINDER_SCHEDULE_CONFLICT_CODE = 'appointment_reminder_schedule_conflict'

// Si un envío quedó pendiente demasiado tiempo (p.ej. cita creada después de
// que ya pasó la hora del recordatorio), se marca como omitido en vez de
// mandar un mensaje fuera de tiempo.
const SEND_GRACE_MS = 3 * 60 * 60 * 1000
// Un error de proveedor/configuración no debe bloquear para siempre el recordatorio:
// si el usuario corrige WhatsApp/plantilla, el cron reintenta sin spamear cada minuto.
const ERROR_RETRY_MS = 15 * 60 * 1000
// Un intento inicial y un único reintento automático. Los errores históricos
// se migran como agotados porque no existe un contador fiable anterior.
const MAX_SEND_ATTEMPTS = 2
let automationAppointmentConfirmationSenderForTest = null

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
const CONTENT_MODES = new Set(['template', 'direct'])
const AUTOMATIC_REMINDER_CHANNELS = new Set(['booking_channel', 'available_channel'])
const REMINDER_CHANNELS = new Set(['booking_channel', 'available_channel', 'whatsapp', 'whatsapp_qr', 'email', 'messenger', 'instagram'])
const REAL_REMINDER_CHANNELS = ['whatsapp', 'whatsapp_qr', 'instagram', 'messenger', 'email']
const NO_CONFIRM_ACTIONS = new Set(['no_action', 'cancel_appointment'])
const LEGACY_NOTIFY_NO_CONFIRM_ACTION = 'notify_push'
const CONFIRMATION_TIMEOUT_UNITS = new Set(['minutes', 'hours', 'days'])
const CONFIRMATION_RESPONSE_WINDOW_UNITS = new Set(['minutes', 'hours'])
const CONFIRMATION_TIMEOUT_MODES = new Set(['elapsed', 'response_window'])
const MAX_CONFIRMATION_TIMEOUT_MS = 30 * OFFSET_UNIT_MS.days
const MAX_CONFIRMATION_REPLY_TEXT_LENGTH = 4096
const DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT =
  '¡Perfecto! Te esperamos en tu cita. Nos vemos pronto.'
const DEFAULT_CONFIRMATION_RESPONSE_START = '09:00'
const DEFAULT_CONFIRMATION_RESPONSE_END = '21:00'
const DEFAULT_TEMPLATE_NAME_BY_PURPOSE = {
  reminder: 'recordatorio_cita_un_dia_antes',
  oneHourReminder: 'recordatorio_cita_una_hora_simple',
  notice: 'cita_programada',
  confirmation: 'confirmacion_cita_dia_anterior'
}
const DEFAULT_APPOINTMENT_TEMPLATE_NAMES = new Set(Object.values(DEFAULT_TEMPLATE_NAME_BY_PURPOSE))
const APPROVED_TEMPLATE_STATUSES = new Set(['APPROVED'])
const LEGACY_CONFIRMATION_TEMPLATE_BODY =
  'Hola {{1}}, solo para confirmar tu cita mañana a las {{2}}. ¿Confirmamos?'
const TEMPLATE_EXPECTED_BODY_PARAMETER_PATTERNS = [
  /expected number of (?:localizable_)?params?\s*\(\s*(\d+)\s*\)/i,
  /expected\s+(\d+)\s+(?:localizable_)?params?\b/i
]
const CHANNEL_LABELS = {
  booking_channel: 'Por el canal que agendó',
  available_channel: 'Por canal disponible',
  whatsapp: 'WhatsApp API',
  whatsapp_qr: 'WhatsApp QR',
  email: 'correo electrónico',
  messenger: 'Messenger',
  instagram: 'Instagram DM'
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isWhatsAppReminderChannel(channel = '') {
  const normalized = cleanString(channel).toLowerCase()
  return normalized === 'whatsapp' || normalized === 'whatsapp_qr'
}

function isAutomaticReminderChannel(channel = '') {
  return AUTOMATIC_REMINDER_CHANNELS.has(cleanString(channel).toLowerCase())
}

function normalizeRealReminderChannel(channel = '') {
  const normalized = cleanString(channel).toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) return ''
  if (normalized.includes('whatsapp_qr') || normalized.includes('sms_qr') || normalized === 'qr' || normalized.includes('baileys') || normalized.includes('bailey')) return 'whatsapp_qr'
  if (normalized.includes('whatsapp') || normalized === 'wa' || normalized.includes('waba') || normalized.includes('ycloud')) return 'whatsapp'
  if (normalized.includes('instagram') || normalized === 'ig' || normalized.includes('instagram_dm')) return 'instagram'
  if (normalized.includes('messenger') || normalized.includes('facebook') || normalized === 'fb') return 'messenger'
  if (normalized.includes('email') || normalized.includes('correo') || normalized === 'mail') return 'email'
  return REAL_REMINDER_CHANNELS.includes(normalized) ? normalized : ''
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

async function resolveAppointmentReminderCalendarId(calendarId, {
  fallbackToDefault = true,
  allowMissing = false
} = {}) {
  const requestedId = cleanString(calendarId)
  if (requestedId) {
    const requestedCalendar = await db.get('SELECT id FROM calendars WHERE id = ?', [requestedId])
    if (!requestedCalendar) {
      throw createServiceError('El calendario seleccionado ya no existe.', 404)
    }
    return cleanString(requestedCalendar.id)
  }

  if (!fallbackToDefault) {
    if (allowMissing) return ''
    throw createServiceError('Selecciona un calendario para administrar sus mensajes automáticos.')
  }

  const defaultCalendarId = cleanString(await getAppConfig('default_calendar_id'))
  if (defaultCalendarId) {
    const defaultCalendar = await db.get('SELECT id FROM calendars WHERE id = ?', [defaultCalendarId])
    if (defaultCalendar) return cleanString(defaultCalendar.id)
  }

  const fallbackCalendar = await db.get(`
    SELECT id
    FROM calendars
    ORDER BY
      CASE WHEN COALESCE(is_active, 1) = 1 THEN 0 ELSE 1 END,
      created_at ASC,
      id ASC
    LIMIT 1
  `)
  if (fallbackCalendar?.id) return cleanString(fallbackCalendar.id)
  if (allowMissing) return ''
  throw createServiceError('Crea un calendario antes de configurar mensajes automáticos.')
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

function shouldHoldErroredSend(row, now) {
  const lastAttempt = parseStoredUtcDateTime(row.sent_at || row.created_at)
  if (!lastAttempt) return true
  return now.toMillis() - lastAttempt.toMillis() < ERROR_RETRY_MS
}

function normalizeResponseWindowTime(value, fallback) {
  const parts = parseHHMM(value, null)
  if (!parts) return fallback
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

function normalizeNoConfirmAction(value) {
  const action = cleanString(value)
  if (action === LEGACY_NOTIFY_NO_CONFIRM_ACTION) return 'no_action'
  return NO_CONFIRM_ACTIONS.has(action) ? action : 'no_action'
}

function emptyConfirmationTimeout(
  rawMode,
  rawResponseStart,
  rawResponseEnd
) {
  const normalizedMode = cleanString(rawMode)
  const mode = CONFIRMATION_TIMEOUT_MODES.has(normalizedMode)
    ? normalizedMode
    : 'elapsed'
  return {
    confirmationTimeoutValue: null,
    confirmationTimeoutUnit: null,
    confirmationTimeoutMode: mode,
    confirmationResponseStart: normalizeResponseWindowTime(
      rawResponseStart,
      DEFAULT_CONFIRMATION_RESPONSE_START
    ),
    confirmationResponseEnd: normalizeResponseWindowTime(
      rawResponseEnd,
      DEFAULT_CONFIRMATION_RESPONSE_END
    )
  }
}

function normalizeConfirmationTimeout(
  rawValue,
  rawUnit,
  rawMode,
  rawResponseStart,
  rawResponseEnd,
  { strict = false } = {}
) {
  const normalizedMode = cleanString(rawMode)
  const mode = CONFIRMATION_TIMEOUT_MODES.has(normalizedMode)
    ? normalizedMode
    : 'response_window'
  if (strict && rawMode !== undefined && rawMode !== null && !CONFIRMATION_TIMEOUT_MODES.has(normalizedMode)) {
    throw createServiceError('Elige una forma válida de contar el plazo de confirmación.')
  }

  if (
    strict &&
    mode === 'response_window' &&
    (
      (rawResponseStart !== undefined && rawResponseStart !== null && !parseHHMM(rawResponseStart, null)) ||
      (rawResponseEnd !== undefined && rawResponseEnd !== null && !parseHHMM(rawResponseEnd, null))
    )
  ) {
    throw createServiceError('Define horas válidas para el horario de respuesta.')
  }

  const responseStart = normalizeResponseWindowTime(
    rawResponseStart,
    DEFAULT_CONFIRMATION_RESPONSE_START
  )
  const responseEnd = normalizeResponseWindowTime(
    rawResponseEnd,
    DEFAULT_CONFIRMATION_RESPONSE_END
  )

  const parsedValue = Number(rawValue)
  const unit = cleanString(rawUnit)
  const unitAllowed = CONFIRMATION_TIMEOUT_UNITS.has(unit) &&
    (mode !== 'response_window' || CONFIRMATION_RESPONSE_WINDOW_UNITS.has(unit))
  const valid = Number.isFinite(parsedValue) &&
    Number.isInteger(parsedValue) &&
    parsedValue > 0 &&
    unitAllowed &&
    parsedValue * OFFSET_UNIT_MS[unit] <= MAX_CONFIRMATION_TIMEOUT_MS

  if (!valid) {
    if (strict) {
      throw createServiceError(
        mode === 'response_window'
          ? 'Define cuántos minutos u horas disponibles puede esperar Ristak la confirmación antes de aplicar la acción configurada (máximo 30 días de tiempo disponible).'
          : 'Define cuánto tiempo puede esperar Ristak la confirmación antes de aplicar la acción configurada (máximo 30 días).'
      )
    }
    return {
      confirmationTimeoutValue: null,
      confirmationTimeoutUnit: null,
      confirmationTimeoutMode: mode,
      confirmationResponseStart: responseStart,
      confirmationResponseEnd: responseEnd
    }
  }

  if (mode === 'response_window' && responseStart === responseEnd) {
    if (strict) {
      throw createServiceError(
        'Define un horario de respuesta válido: la hora de inicio y la hora de fin deben ser distintas.'
      )
    }
    return {
      confirmationTimeoutValue: null,
      confirmationTimeoutUnit: null,
      confirmationTimeoutMode: mode,
      confirmationResponseStart: responseStart,
      confirmationResponseEnd: responseEnd
    }
  }

  return {
    confirmationTimeoutValue: parsedValue,
    confirmationTimeoutUnit: unit,
    confirmationTimeoutMode: mode,
    confirmationResponseStart: responseStart,
    confirmationResponseEnd: responseEnd
  }
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

function getDefaultConfirmationTimeout(timingAnchor, offsetValue, offsetUnit) {
  const protectedWindowDefaults = {
    confirmationTimeoutMode: 'response_window',
    confirmationResponseStart: DEFAULT_CONFIRMATION_RESPONSE_START,
    confirmationResponseEnd: DEFAULT_CONFIRMATION_RESPONSE_END
  }
  if (timingAnchor === 'after_booking') {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 6,
      confirmationTimeoutUnit: 'hours'
    }
  }

  const leadMs = offsetValue * (OFFSET_UNIT_MS[offsetUnit] || OFFSET_UNIT_MS.days)
  if (leadMs > 12 * OFFSET_UNIT_MS.hours) {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 6,
      confirmationTimeoutUnit: 'hours'
    }
  }
  if (leadMs > 2 * OFFSET_UNIT_MS.hours) {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 1,
      confirmationTimeoutUnit: 'hours'
    }
  }

  const safeMinutes = leadMs > 30 * OFFSET_UNIT_MS.minutes
    ? 15
    : leadMs > 5 * OFFSET_UNIT_MS.minutes
      ? 5
      : 1
  return {
    ...protectedWindowDefaults,
    confirmationTimeoutValue: safeMinutes,
    confirmationTimeoutUnit: 'minutes'
  }
}

export function buildAppointmentReminderScheduleKey(reminder = {}) {
  const { timingAnchor, offsetUnit, offsetValue } = normalizeOffsetForAnchor(
    TIMING_ANCHORS.has(cleanString(reminder.timingAnchor))
      ? cleanString(reminder.timingAnchor)
      : 'before_appointment',
    reminder.offsetUnit,
    reminder.offsetValue,
    { clampMax: true }
  )
  const offsetMs = offsetValue * (OFFSET_UNIT_MS[offsetUnit] || OFFSET_UNIT_MS.days)
  return `${timingAnchor}:${offsetMs}`
}

function createReminderScheduleConflictError(existingReminder) {
  const label = formatOffsetLabel(
    existingReminder.offsetValue,
    existingReminder.offsetUnit,
    existingReminder.timingAnchor
  )
  const error = createServiceError(
    `Ya existe "${existingReminder.name}" configurado para ${label}. Elige otro momento para evitar mensajes repetidos.`,
    409
  )
  error.code = REMINDER_SCHEDULE_CONFLICT_CODE
  error.conflict = {
    id: existingReminder.id,
    name: existingReminder.name,
    timingAnchor: existingReminder.timingAnchor,
    offsetValue: existingReminder.offsetValue,
    offsetUnit: existingReminder.offsetUnit,
    label
  }
  return error
}

async function findReminderScheduleConflict(calendarId, scheduleKey, excludeReminderId = '') {
  const rows = await db.all(`
    SELECT *
    FROM appointment_reminders
    WHERE calendar_id = ?
      AND id != ?
    ORDER BY position ASC, created_at ASC
  `, [cleanString(calendarId), cleanString(excludeReminderId)])

  return rows
    .map(normalizeReminderRow)
    .find(reminder => buildAppointmentReminderScheduleKey(reminder) === scheduleKey) || null
}

async function assertReminderScheduleAvailable(data, excludeReminderId = '') {
  const scheduleKey = buildAppointmentReminderScheduleKey(data)
  const conflict = await findReminderScheduleConflict(data.calendarId, scheduleKey, excludeReminderId)
  if (conflict) throw createReminderScheduleConflictError(conflict)
  return scheduleKey
}

function isReminderScheduleUniqueConstraintError(error) {
  const message = cleanString(error?.message).toLowerCase()
  return error?.code === '23505' ||
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    message.includes('idx_appointment_reminders_calendar_schedule_key') ||
    message.includes('idx_appointment_reminders_schedule_key') ||
    message.includes('appointment_reminders.calendar_id, appointment_reminders.schedule_key') ||
    message.includes('appointment_reminders.schedule_key')
}

async function rethrowReminderScheduleConflict(error, calendarId, scheduleKey, excludeReminderId = '') {
  if (!isReminderScheduleUniqueConstraintError(error)) throw error
  const conflict = await findReminderScheduleConflict(calendarId, scheduleKey, excludeReminderId)
  if (conflict) throw createReminderScheduleConflictError(conflict)
  throw error
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
  const rawChannel = cleanString(row.channel).toLowerCase()
  const channel = REMINDER_CHANNELS.has(rawChannel) ? rawChannel : 'whatsapp'
  const rawContentMode = cleanString(row.content_mode).toLowerCase()
  const hasTemplate = Boolean(cleanString(row.template_id) || templateName)
  const contentMode = isWhatsAppReminderChannel(channel)
    ? (CONTENT_MODES.has(rawContentMode) ? rawContentMode : (hasTemplate ? 'template' : 'direct'))
    : 'direct'
  const confirmationSuccessActions = normalizeConfirmationSuccessActions(
    row.confirmation_success_action,
    LEGACY_CONFIRMATION_SUCCESS_ACTIONS
  )
  const messageType = MESSAGE_TYPES.has(cleanString(row.message_type)) ? cleanString(row.message_type) : 'reminder'
  const aiEnabled = messageType === 'confirmation' && Number(row.ai_enabled || 0) === 1
  const rawNoConfirmAction = cleanString(row.no_confirm_action)
  const noConfirmAction = normalizeNoConfirmAction(rawNoConfirmAction)
  const defaultConfirmationTimeout = getDefaultConfirmationTimeout(
    timingAnchor,
    offsetValue,
    offsetUnit
  )
  const preserveLegacyCancellationWithoutTimeout = (
    rawNoConfirmAction === 'cancel_appointment' &&
    (
      row.confirmation_timeout_value === null ||
      row.confirmation_timeout_value === undefined ||
      !cleanString(row.confirmation_timeout_unit)
    )
  )
  const confirmationTimeout = messageType === 'confirmation' &&
    aiEnabled &&
    !preserveLegacyCancellationWithoutTimeout
    ? normalizeConfirmationTimeout(
        row.confirmation_timeout_value ?? defaultConfirmationTimeout.confirmationTimeoutValue,
        row.confirmation_timeout_unit ?? defaultConfirmationTimeout.confirmationTimeoutUnit,
        row.confirmation_timeout_mode ?? defaultConfirmationTimeout.confirmationTimeoutMode,
        row.confirmation_response_start ?? defaultConfirmationTimeout.confirmationResponseStart,
        row.confirmation_response_end ?? defaultConfirmationTimeout.confirmationResponseEnd
      )
    : emptyConfirmationTimeout(
        row.confirmation_timeout_mode,
        row.confirmation_response_start,
        row.confirmation_response_end
      )
  return {
    id: cleanString(row.id),
    calendarId: cleanString(row.calendar_id),
    name: cleanString(row.name) || formatOffsetLabel(offsetValue, offsetUnit, timingAnchor),
    enabled: Number(row.enabled || 0) === 1,
    messageType,
    aiEnabled,
    channel,
    senderMode: SENDER_MODES.has(cleanString(row.sender_mode)) ? cleanString(row.sender_mode) : 'contact',
    senderPhoneNumberId: cleanString(row.sender_phone_number_id) || null,
    templateId: cleanString(row.template_id) || null,
    templateName: templateName || null,
    templateLanguage,
    contentMode,
    timingAnchor,
    offsetValue,
    offsetUnit,
    messageText: cleanString(row.message_text),
    smartEnabled: Number(row.smart_enabled || 0) === 1,
    smartStart: cleanString(row.smart_start) || '09:00',
    smartEnd: cleanString(row.smart_end) || '21:00',
    smartOverflow: SMART_OVERFLOWS.has(cleanString(row.smart_overflow)) ? cleanString(row.smart_overflow) : 'before',
    noConfirmAction,
    ...confirmationTimeout,
    confirmationReplyText: cleanString(row.confirmation_reply_text),
    confirmationSuccessActions,
    // Compatibilidad temporal para clientes anteriores que todavía esperan un
    // único valor. El backend nuevo usa siempre confirmationSuccessActions.
    confirmationSuccessAction: confirmationSuccessActions.find(action => action !== 'mark_confirmed') || 'mark_confirmed',
    bypassAutomations: messageType === 'confirmation' && Number(row.bypass_automations || 0) === 1,
    // Compatibilidad de API: el respaldo ya no es una preferencia manual. La
    // capa central lo habilita sólo para un QR conectado al mismo número.
    qrFallbackEnabled: channel === 'whatsapp',
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
    templateProvider: cleanString(row.template_provider) || null,
    providerTemplateName: cleanString(row.provider_template_name) || null,
    providerTemplateId: cleanString(row.provider_template_id) || null,
    providerStatus: normalizeTemplateStatus(row.provider_status),
    providerSubmittedAt: cleanString(row.provider_submitted_at) || null,
    providerSyncedAt: cleanString(row.provider_synced_at) || null,
    providerRawPayload: parseJson(row.provider_raw_payload_json, null)
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
  const timingAnchor = TIMING_ANCHORS.has(cleanString(data.timingAnchor))
    ? cleanString(data.timingAnchor)
    : 'before_appointment'
  if (timingAnchor === 'after_booking') return DEFAULT_TEMPLATE_NAME_BY_PURPOSE.notice

  const messageType = MESSAGE_TYPES.has(cleanString(data.messageType)) ? cleanString(data.messageType) : 'reminder'
  if (messageType === 'confirmation') return DEFAULT_TEMPLATE_NAME_BY_PURPOSE.confirmation

  const offsetUnit = cleanString(data.offsetUnit)
  const offsetValue = Number(data.offsetValue)
  const offsetMs = Number.isFinite(offsetValue) && OFFSET_UNIT_MS[offsetUnit]
    ? offsetValue * OFFSET_UNIT_MS[offsetUnit]
    : null
  return offsetMs === OFFSET_UNIT_MS.hours
    ? DEFAULT_TEMPLATE_NAME_BY_PURPOSE.oneHourReminder
    : DEFAULT_TEMPLATE_NAME_BY_PURPOSE.reminder
}

async function getDefaultReminderTemplate(data = {}) {
  const name = getDefaultTemplateNameForReminder(data)
  return getReminderTemplateByName(name, 'es_MX')
}

async function makeDefaultAppointmentTemplatePurposeCompatible(template, data = {}) {
  const selectedName = cleanString(template?.name || data.templateName)
  const expectedName = getDefaultTemplateNameForReminder(data)
  if (!DEFAULT_APPOINTMENT_TEMPLATE_NAMES.has(selectedName) || selectedName === expectedName) {
    return template
  }
  const expectedTemplate = await getDefaultReminderTemplate(data)
  if (!expectedTemplate) {
    throw createServiceError(`No se encontró la plantilla predeterminada ${expectedName} para este mensaje de cita.`, 500)
  }
  return expectedTemplate
}

async function getPurposeCompatibleReminderTemplate(reminder = {}) {
  let template = await getReminderTemplateById(reminder.templateId)
  if (!template && reminder.templateName) {
    template = await getReminderTemplateByName(reminder.templateName, reminder.templateLanguage)
  }
  return makeDefaultAppointmentTemplatePurposeCompatible(template, reminder)
}

async function resolveReminderTemplateSelection(data = {}) {
  if (data.contentMode === 'direct' || !isWhatsAppReminderChannel(data.channel)) {
    return {
      ...data,
      templateId: null,
      templateName: '',
      templateLanguage: cleanString(data.templateLanguage) || 'es_MX'
    }
  }

  let template = await getReminderTemplateById(data.templateId)
  if (!template && data.templateName) {
    template = await getReminderTemplateByName(data.templateName, data.templateLanguage)
  }
  template = await makeDefaultAppointmentTemplatePurposeCompatible(template, data)
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
  await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
  // Versiones anteriores podían guardar un recordatorio común con la IA de
  // confirmación encendida. Ese estado híbrido no confirma citas y deja que la
  // respuesta caiga al agente general. Lo apagamos de forma idempotente; sólo
  // message_type=confirmation puede habilitar estas dos banderas.
  await db.run(`
    UPDATE appointment_reminders
    SET ai_enabled = 0, bypass_automations = 0, updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(message_type, 'reminder') <> 'confirmation'
      AND (COALESCE(ai_enabled, 0) <> 0 OR COALESCE(bypass_automations, 0) <> 0)
  `)
  await db.run(`
    UPDATE appointment_reminders
    SET message_text = ?, updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(timing_anchor, 'before_appointment') = 'after_booking'
      AND TRIM(COALESCE(message_text, '')) = ?
  `, [DEFAULT_APPOINTMENT_NOTICE_TEXT, LEGACY_DEFAULT_APPOINTMENT_NOTICE_TEXT])

  const rows = await db.all(`
    SELECT id, message_type, timing_anchor, offset_value, offset_unit,
      template_id, template_name, template_language
    FROM appointment_reminders
    WHERE COALESCE(channel, 'whatsapp') IN ('whatsapp', 'whatsapp_qr')
      AND COALESCE(content_mode, 'template') = 'template'
  `)

  for (const row of rows) {
    const messageType = MESSAGE_TYPES.has(cleanString(row.message_type)) ? cleanString(row.message_type) : 'reminder'
    const timingAnchor = TIMING_ANCHORS.has(cleanString(row.timing_anchor)) ? cleanString(row.timing_anchor) : 'before_appointment'
    const offsetValue = Number(row.offset_value)
    const offsetUnit = cleanString(row.offset_unit)
    const expectedName = getDefaultTemplateNameForReminder({
      messageType,
      timingAnchor,
      offsetValue,
      offsetUnit
    })
    const storedTemplateId = cleanString(row.template_id)
    const storedTemplateName = cleanString(row.template_name)
    let selectedTemplate = storedTemplateId ? await getReminderTemplateById(storedTemplateId) : null
    if (!selectedTemplate && storedTemplateName) {
      selectedTemplate = await getReminderTemplateByName(storedTemplateName, row.template_language)
    }

    const selectedName = cleanString(selectedTemplate?.name || storedTemplateName)
    const hasNoSelection = !storedTemplateId && !storedTemplateName
    const hasMismatchedDefault = DEFAULT_APPOINTMENT_TEMPLATE_NAMES.has(selectedName) && selectedName !== expectedName
    const hasDanglingDefault = !selectedTemplate && DEFAULT_APPOINTMENT_TEMPLATE_NAMES.has(storedTemplateName)
    if (!hasNoSelection && !hasMismatchedDefault && !hasDanglingDefault) continue

    const template = await getDefaultReminderTemplate({
      messageType,
      timingAnchor,
      offsetValue,
      offsetUnit
    })
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

// (NOTI-008) La pantalla sólo debe mostrar fallos que siguen sin resolverse. Un envío
// correcto posterior demuestra que el recordatorio se recuperó; guardar una configuración
// nueva también invalida errores de la versión anterior. El historial completo permanece en
// appointment_reminder_sends para auditoría, pero no deja la tarjeta roja para siempre.
async function getRecentReminderFailures() {
  const rows = await db.all(`
    WITH send_state AS (
      SELECT reminder_id,
        MAX(
          CASE WHEN status = 'sent'
            THEN COALESCE(sent_at, send_at, created_at)
          END
        ) AS last_success_at
      FROM appointment_reminder_sends
      GROUP BY reminder_id
    ), ranked_failures AS (
      SELECT sends.reminder_id,
        sends.error_message,
        COALESCE(sends.sent_at, sends.send_at, sends.created_at) AS occurred_at,
        COUNT(*) OVER (PARTITION BY sends.reminder_id) AS error_count,
        ROW_NUMBER() OVER (
          PARTITION BY sends.reminder_id
          ORDER BY COALESCE(sends.sent_at, sends.send_at, sends.created_at) DESC, sends.id DESC
        ) AS latest_rank
      FROM appointment_reminder_sends sends
      INNER JOIN appointment_reminders reminder ON reminder.id = sends.reminder_id
      LEFT JOIN send_state state ON state.reminder_id = sends.reminder_id
      WHERE sends.status = 'error'
        AND COALESCE(sends.sent_at, sends.send_at, sends.created_at) >=
          COALESCE(reminder.updated_at, reminder.created_at)
        AND (
          state.last_success_at IS NULL OR
          COALESCE(sends.sent_at, sends.send_at, sends.created_at) > state.last_success_at
        )
    )
    SELECT reminder_id, error_count, occurred_at, error_message
    FROM ranked_failures
    WHERE latest_rank = 1
  `)

  const byReminder = new Map()
  for (const row of rows) {
    const reminderId = cleanString(row.reminder_id)
    if (!reminderId) continue
    byReminder.set(reminderId, {
      errorCount: Number(row.error_count || 0),
      lastErrorAt: cleanString(row.occurred_at) || null,
      lastErrorMessage: cleanString(row.error_message) || null
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

function buildReminderDeliveryHealth(reminder, template, senders = [], channelState = {}) {
  if (!reminder.enabled) {
    return {
      status: 'paused',
      message: 'Este mensaje automático está pausado.',
      details: []
    }
  }

  const errors = []
  const warnings = []
  const channel = REMINDER_CHANNELS.has(cleanString(reminder.channel)) ? cleanString(reminder.channel) : 'whatsapp'
  const contentMode = isWhatsAppReminderChannel(channel) && reminder.contentMode !== 'direct' ? 'template' : 'direct'

  if (contentMode === 'direct' && !cleanString(reminder.messageText)) {
    errors.push('Escribe el mensaje directo que se enviará en este recordatorio.')
  }

  const apiSenders = senders.filter(sender => sender.apiEnabled)
  const qrSenders = senders.filter(sender => sender.qrConnected)

  if (isAutomaticReminderChannel(channel)) {
    const hasAnyChannel = Boolean(
      apiSenders.length ||
      qrSenders.length ||
      channelState.instagramConnected ||
      channelState.messengerConnected ||
      channelState.emailConnected
    )
    if (!hasAnyChannel) {
      errors.push('Conecta al menos un canal de envío para usar el ruteo automático.')
    }
    const details = errors.length ? errors : warnings
    const readyMessage = channel === 'booking_channel'
      ? 'Listo para enviar por el canal que agendó, con respaldo por canal disponible.'
      : 'Listo para enviar por el primer canal disponible.'
    return {
      status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
      message: details[0] || readyMessage,
      details
    }
  }

  if (channel === 'email') {
    if (!channelState.emailConnected) {
      errors.push('Conecta el correo en Configuración > Correos para enviar este recordatorio.')
    }
    const details = errors.length ? errors : warnings
    return {
      status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
      message: details[0] || 'Listo para enviar por correo electrónico.',
      details
    }
  }

  if (channel === 'messenger' || channel === 'instagram') {
    const connected = channel === 'instagram'
      ? channelState.instagramConnected
      : channelState.messengerConnected
    if (!connected) {
      errors.push(`Activa ${CHANNEL_LABELS[channel]} en Configuración > Meta Ads > Redes sociales para enviar este recordatorio.`)
    }
    const details = errors.length ? errors : warnings
    return {
      status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
      message: details[0] || `Listo para enviar por ${CHANNEL_LABELS[channel]}.`,
      details
    }
  }

  const selectedSender = reminder.senderMode === 'specific'
    ? senders.find(sender => sender.id === reminder.senderPhoneNumberId)
    : null

  if (channel === 'whatsapp_qr') {
    if (contentMode === 'template' && !template) {
      errors.push('Selecciona un mensaje de WhatsApp para renderizarlo por QR.')
    }
    if (reminder.senderMode === 'specific') {
      if (!selectedSender) {
        errors.push('El remitente QR elegido ya no está conectado.')
      } else if (!selectedSender.qrConnected) {
        errors.push('El remitente elegido no está conectado por WhatsApp QR.')
      }
    }
    if (!qrSenders.length) {
      errors.push('Conecta un número de WhatsApp QR para enviar este recordatorio.')
    }

    const details = errors.length ? errors : warnings
    return {
      status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
      message: details[0] || 'Listo para enviar por WhatsApp QR.',
      details
    }
  }

  const selectedQrPrimary = selectedSender && !selectedSender.apiEnabled && selectedSender.qrConnected
  const qrPrimaryAvailable = Boolean(selectedQrPrimary || (!apiSenders.length && qrSenders.length))

  if (contentMode === 'direct' && apiSenders.length && !qrPrimaryAvailable) {
    warnings.push('Los mensajes directos por WhatsApp API sólo salen si el contacto tiene una conversación abierta de 24 horas; si no, usa una plantilla oficial. El QR sólo entra si la API deja de estar disponible.')
  }

  if (contentMode === 'template' && !template) {
    errors.push('Selecciona una plantilla de WhatsApp para este recordatorio.')
  } else if (contentMode === 'template') {
    const templateStatus = getMessageTemplateProviderState(template).status
    if (!APPROVED_TEMPLATE_STATUSES.has(templateStatus) && !qrPrimaryAvailable) {
      const statusLabel = describeTemplateStatus(templateStatus)
      errors.push(`La plantilla ${template.name} está ${statusLabel}; debe estar APPROVED para enviarse por WhatsApp API.`)
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

  const details = errors.length ? errors : warnings
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ready',
    message: details[0] || 'Listo para enviar por WhatsApp.',
    details
  }
}

export async function getAppointmentRemindersOverview(calendarId) {
  // (PANEL-FIX) El panel de "mensajes automáticos" no debe caerse entero por un fallo
  // en un paso de enriquecimiento (rellenar plantillas, remitentes de WhatsApp o el
  // historial de fallos). Lo ÚNICO crítico es leer los recordatorios; lo demás degrada
  // suave para que la lista siempre se muestre aunque WhatsApp/plantillas fallen.
  try {
    await backfillMissingReminderTemplates()
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudieron rellenar plantillas por defecto (no crítico): ${error.message}`)
  }

  const resolvedCalendarId = await resolveAppointmentReminderCalendarId(calendarId)
  const rows = await db.all(`
    SELECT *
    FROM appointment_reminders
    WHERE calendar_id = ?
    ORDER BY position ASC, created_at ASC
  `, [resolvedCalendarId])
  const baseReminders = rows.map(normalizeReminderRow)

  let senders = []
  try {
    senders = await listSenderOptions()
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudieron cargar remitentes de WhatsApp (no crítico): ${error.message}`)
  }
  const whatsappApiConnected = senders.some(sender => sender.apiEnabled)
  const whatsappQrConnected = senders.some(sender => sender.qrConnected)
  const channelState = {
    emailConnected: false,
    messengerConnected: false,
    instagramConnected: false
  }

  try {
    const status = await getEmailStatus()
    channelState.emailConnected = Boolean(status?.connected)
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudo cargar estado de correo (no crítico): ${error.message}`)
  }

  try {
    channelState.messengerConnected = await isMetaSocialMessagingEnabled('messenger')
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudo cargar estado de Messenger (no crítico): ${error.message}`)
  }

  try {
    channelState.instagramConnected = await isMetaSocialMessagingEnabled('instagram')
  } catch (error) {
    logger.warn(`[Recordatorios] No se pudo cargar estado de Instagram (no crítico): ${error.message}`)
  }

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
    deliveryHealth: buildReminderDeliveryHealth(reminder, templatesByReminder.get(reminder.id) || null, senders, channelState),
    failures: failuresByReminder.get(reminder.id) || { errorCount: 0, lastErrorAt: null, lastErrorMessage: null }
  }))
  return {
    calendarId: resolvedCalendarId,
    reminders,
    senders,
    channels: [
      { id: 'booking_channel', label: 'Por el canal que agendó', connected: whatsappApiConnected || whatsappQrConnected || channelState.instagramConnected || channelState.messengerConnected || channelState.emailConnected },
      { id: 'available_channel', label: 'Por canal disponible', connected: whatsappApiConnected || whatsappQrConnected || channelState.instagramConnected || channelState.messengerConnected || channelState.emailConnected },
      { id: 'whatsapp', label: 'WhatsApp API', connected: whatsappApiConnected },
      { id: 'whatsapp_qr', label: 'WhatsApp QR solo', connected: whatsappQrConnected },
      { id: 'email', label: 'Correo electrónico', connected: channelState.emailConnected },
      { id: 'messenger', label: 'Messenger', connected: channelState.messengerConnected },
      { id: 'instagram', label: 'Instagram DM', connected: channelState.instagramConnected }
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
  const rawChannel = cleanString(merged.channel).toLowerCase()
  const channel = REMINDER_CHANNELS.has(rawChannel) ? rawChannel : 'whatsapp'
  const rawContentMode = cleanString(merged.contentMode).toLowerCase()
  const whatsappChannel = isWhatsAppReminderChannel(channel)
  const contentMode = whatsappChannel && CONTENT_MODES.has(rawContentMode)
    ? rawContentMode
    : whatsappChannel
      ? 'template'
      : 'direct'
  const messageText = cleanString(merged.messageText) ||
    (timingAnchor === 'after_booking'
      ? DEFAULT_APPOINTMENT_NOTICE_TEXT
      : messageType === 'confirmation'
        ? DEFAULT_CONFIRMATION_TEXT
        : offsetValue * OFFSET_UNIT_MS[offsetUnit] === OFFSET_UNIT_MS.hours
          ? DEFAULT_ONE_HOUR_REMINDER_TEXT
          : DEFAULT_REMINDER_TEXT)
  const hasConfirmationSuccessActions = Object.prototype.hasOwnProperty.call(input, 'confirmationSuccessActions')
  const hasLegacyConfirmationSuccessAction = Object.prototype.hasOwnProperty.call(input, 'confirmationSuccessAction')
  const legacyActionIsUnchanged = (
    hasLegacyConfirmationSuccessAction &&
    Array.isArray(base.confirmationSuccessActions) &&
    cleanString(input.confirmationSuccessAction) === cleanString(base.confirmationSuccessAction)
  )
  const confirmationSuccessActionsSource = hasConfirmationSuccessActions
    ? input.confirmationSuccessActions
    : hasLegacyConfirmationSuccessAction && !legacyActionIsUnchanged
      ? input.confirmationSuccessAction
      : base.confirmationSuccessActions ?? base.confirmationSuccessAction ?? DEFAULT_CONFIRMATION_SUCCESS_ACTIONS
  const confirmationSuccessActions = normalizeConfirmationSuccessActions(
    confirmationSuccessActionsSource,
    DEFAULT_CONFIRMATION_SUCCESS_ACTIONS
  )
  const confirmationReplyTextWasSubmitted = Object.prototype.hasOwnProperty.call(
    input,
    'confirmationReplyText'
  )
  const isNewAiConfirmation = (
    Object.keys(base).length === 0 &&
    messageType === 'confirmation' &&
    merged.aiEnabled !== false
  )
  const confirmationReplyText = confirmationReplyTextWasSubmitted
    ? cleanString(input.confirmationReplyText)
    : cleanString(base.confirmationReplyText) || (
        isNewAiConfirmation
          ? DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT
          : ''
      )
  if (confirmationReplyText.length > MAX_CONFIRMATION_REPLY_TEXT_LENGTH) {
    throw createServiceError(
      `El mensaje de respuesta al confirmar no puede superar ${MAX_CONFIRMATION_REPLY_TEXT_LENGTH} caracteres.`
    )
  }
  const noConfirmAction = normalizeNoConfirmAction(merged.noConfirmAction)
  const timeoutConfigurationWasSubmitted = [
    'noConfirmAction',
    'confirmationTimeoutValue',
    'confirmationTimeoutUnit',
    'confirmationTimeoutMode',
    'confirmationResponseStart',
    'confirmationResponseEnd'
  ].some((field) => Object.hasOwn(input, field))
  const confirmationEnabled = messageType === 'confirmation' && merged.aiEnabled !== false
  const defaultConfirmationTimeout = getDefaultConfirmationTimeout(
    timingAnchor,
    offsetValue,
    offsetUnit
  )
  const preserveLegacyCancellationWithoutTimeout = (
    Object.keys(base).length > 0 &&
    base.messageType === 'confirmation' &&
    base.aiEnabled === true &&
    base.noConfirmAction === 'cancel_appointment' &&
    base.confirmationTimeoutValue === null &&
    !timeoutConfigurationWasSubmitted
  )
  const confirmationTimeout = confirmationEnabled && !preserveLegacyCancellationWithoutTimeout
    ? normalizeConfirmationTimeout(
        merged.confirmationTimeoutValue ?? defaultConfirmationTimeout.confirmationTimeoutValue,
        merged.confirmationTimeoutUnit ?? defaultConfirmationTimeout.confirmationTimeoutUnit,
        merged.confirmationTimeoutMode ?? defaultConfirmationTimeout.confirmationTimeoutMode,
        merged.confirmationResponseStart ?? defaultConfirmationTimeout.confirmationResponseStart,
        merged.confirmationResponseEnd ?? defaultConfirmationTimeout.confirmationResponseEnd,
        { strict: Object.keys(base).length === 0 || timeoutConfigurationWasSubmitted }
      )
    : emptyConfirmationTimeout(
        merged.confirmationTimeoutMode,
        merged.confirmationResponseStart,
        merged.confirmationResponseEnd
      )
  if (
    timingAnchor === 'before_appointment' &&
    confirmationTimeout.confirmationTimeoutValue !== null &&
    confirmationTimeout.confirmationTimeoutMode === 'elapsed'
  ) {
    const timeoutMs = confirmationTimeout.confirmationTimeoutValue *
      OFFSET_UNIT_MS[confirmationTimeout.confirmationTimeoutUnit]
    const reminderLeadMs = offsetValue * OFFSET_UNIT_MS[offsetUnit]
    if (timeoutMs >= reminderLeadMs) {
      throw createServiceError(
        'El plazo para confirmar debe terminar antes de que comience la cita.'
      )
    }
  }

  return {
    calendarId: cleanString(merged.calendarId),
    name: cleanString(merged.name) || formatOffsetLabel(offsetValue, offsetUnit, timingAnchor),
    enabled: merged.enabled === false ? 0 : 1,
    messageType,
    aiEnabled: confirmationEnabled && merged.aiEnabled !== false ? 1 : 0,
    channel,
    senderMode: whatsappChannel && SENDER_MODES.has(cleanString(merged.senderMode)) ? cleanString(merged.senderMode) : 'contact',
    senderPhoneNumberId: whatsappChannel ? cleanString(merged.senderPhoneNumberId) || null : null,
    templateId: contentMode === 'template' ? cleanString(merged.templateId) || null : null,
    templateName: contentMode === 'template' ? cleanString(merged.templateName) : '',
    templateLanguage,
    contentMode,
    timingAnchor,
    offsetValue,
    offsetUnit,
    messageText,
    smartEnabled: merged.smartEnabled === false ? 0 : 1,
    smartStart,
    smartEnd,
    smartOverflow: SMART_OVERFLOWS.has(cleanString(merged.smartOverflow)) ? cleanString(merged.smartOverflow) : 'before',
    noConfirmAction,
    ...confirmationTimeout,
    confirmationReplyText,
    confirmationSuccessActions,
    confirmationSuccessAction: serializeConfirmationSuccessActions(
      confirmationSuccessActions,
      DEFAULT_CONFIRMATION_SUCCESS_ACTIONS
    ),
    bypassAutomations: confirmationEnabled && merged.bypassAutomations === true ? 1 : 0,
    // Se conserva la columna para clientes anteriores, pero el ruteo real es
    // automático y siempre queda autorizado para WhatsApp API. La capa central
    // sólo usa un QR del mismo número y por indisponibilidad real de la API.
    qrFallbackEnabled: channel === 'whatsapp' ? 1 : 0
  }
}

async function insertAppointmentReminder(input = {}, { systemKey = null, ignoreConflict = false } = {}) {
  const calendarId = await resolveAppointmentReminderCalendarId(input.calendarId)
  const data = await resolveReminderTemplateSelection(sanitizeReminderInput({ ...input, calendarId }))
  const scheduleKey = buildAppointmentReminderScheduleKey(data)
  const id = createReminderId()
  const positionRow = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM appointment_reminders WHERE calendar_id = ?',
    [calendarId]
  )

  const result = await db.run(`
    INSERT INTO appointment_reminders (
      id, calendar_id, system_key, schedule_key, name, enabled, message_type, ai_enabled, channel, sender_mode,
      sender_phone_number_id, template_id, template_name, template_language,
      content_mode, qr_fallback_enabled, timing_anchor, offset_value, offset_unit, message_text,
      smart_enabled, smart_start, smart_end, smart_overflow, no_confirm_action,
      confirmation_timeout_value, confirmation_timeout_unit,
      confirmation_timeout_mode, confirmation_response_start, confirmation_response_end,
      confirmation_success_action, confirmation_reply_text, bypass_automations, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}
  `, [
    id, calendarId, cleanString(systemKey) || null, scheduleKey, data.name, data.enabled, data.messageType, data.aiEnabled, data.channel,
    data.senderMode, data.senderPhoneNumberId, data.templateId, data.templateName,
    data.templateLanguage, data.contentMode, data.qrFallbackEnabled, data.timingAnchor, data.offsetValue, data.offsetUnit,
    data.messageText, data.smartEnabled, data.smartStart, data.smartEnd,
    data.smartOverflow, data.noConfirmAction, data.confirmationTimeoutValue, data.confirmationTimeoutUnit,
    data.confirmationTimeoutMode, data.confirmationResponseStart, data.confirmationResponseEnd,
    data.confirmationSuccessAction, data.confirmationReplyText, data.bypassAutomations,
    Number(positionRow?.next || 0)
  ])

  if (!Number(result?.changes || 0) && systemKey) {
    return {
      reminder: normalizeReminderRow(await db.get(
        'SELECT * FROM appointment_reminders WHERE calendar_id = ? AND system_key = ?',
        [calendarId, systemKey]
      )),
      created: false
    }
  }
  return {
    reminder: normalizeReminderRow(await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id])),
    created: true
  }
}

export async function createAppointmentReminder(input = {}) {
  await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
  const calendarId = await resolveAppointmentReminderCalendarId(input.calendarId)
  const preparedInput = { ...input, calendarId }
  const sanitized = sanitizeReminderInput(preparedInput)
  const scheduleKey = await assertReminderScheduleAvailable(sanitized)
  try {
    const { reminder } = await insertAppointmentReminder(preparedInput)
    return reminder
  } catch (error) {
    await rethrowReminderScheduleConflict(error, calendarId, scheduleKey)
  }
}

export async function updateAppointmentReminder(reminderId, input = {}) {
  const id = cleanString(reminderId)
  const existing = await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id])
  if (!existing) throw createServiceError('Mensaje automático no encontrado.', 404)

  const base = normalizeReminderRow(existing)
  const calendarId = base.calendarId || await resolveAppointmentReminderCalendarId(input.calendarId)
  const requestedCalendarId = cleanString(input.calendarId)
  if (requestedCalendarId && requestedCalendarId !== calendarId) {
    throw createServiceError('El mensaje automático pertenece a otro calendario.', 404)
  }
  base.calendarId = calendarId
  const data = await resolveReminderTemplateSelection(sanitizeReminderInput(input, base))
  const scheduleKey = await assertReminderScheduleAvailable(data, id)

  // Si cambia el tiempo/ancla y el nombre era el autogenerado, regenerarlo.
  const autoName = formatOffsetLabel(base.offsetValue, base.offsetUnit, base.timingAnchor)
  const name = (cleanString(input.name) || (base.name === autoName
    ? formatOffsetLabel(data.offsetValue, data.offsetUnit, data.timingAnchor)
    : data.name))

  try {
    await db.run(`
      UPDATE appointment_reminders
      SET calendar_id = ?, schedule_key = ?, name = ?, enabled = ?, message_type = ?, ai_enabled = ?, channel = ?, sender_mode = ?,
        sender_phone_number_id = ?, template_id = ?, template_name = ?, template_language = ?,
        content_mode = ?, qr_fallback_enabled = ?, timing_anchor = ?, offset_value = ?, offset_unit = ?, message_text = ?,
        smart_enabled = ?, smart_start = ?, smart_end = ?, smart_overflow = ?,
        no_confirm_action = ?, confirmation_timeout_value = ?, confirmation_timeout_unit = ?,
        confirmation_timeout_mode = ?, confirmation_response_start = ?, confirmation_response_end = ?,
        confirmation_success_action = ?, confirmation_reply_text = ?, bypass_automations = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      calendarId, scheduleKey, name, data.enabled, data.messageType, data.aiEnabled, data.channel, data.senderMode,
      data.senderPhoneNumberId, data.templateId, data.templateName, data.templateLanguage,
      data.contentMode, data.qrFallbackEnabled, data.timingAnchor, data.offsetValue, data.offsetUnit, data.messageText,
      data.smartEnabled, data.smartStart, data.smartEnd, data.smartOverflow,
      data.noConfirmAction, data.confirmationTimeoutValue, data.confirmationTimeoutUnit,
      data.confirmationTimeoutMode, data.confirmationResponseStart, data.confirmationResponseEnd,
      data.confirmationSuccessAction, data.confirmationReplyText, data.bypassAutomations, id
    ])
  } catch (error) {
    await rethrowReminderScheduleConflict(error, calendarId, scheduleKey, id)
  }

  // Si cambió la configuración de tiempo, los envíos pendientes se recalculan
  // solos porque el cron computa la hora de envío al vuelo.
  return normalizeReminderRow(await db.get('SELECT * FROM appointment_reminders WHERE id = ?', [id]))
}

export async function deleteAppointmentReminder(reminderId, calendarId = '') {
  const id = cleanString(reminderId)
  const expectedCalendarId = cleanString(calendarId)
  await db.transaction(async (transaction) => {
    const existing = await transaction.get(`
      SELECT id, calendar_id
      FROM appointment_reminders
      WHERE id = ?
      ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
    `, [id])
    if (!existing) throw createServiceError('Mensaje automático no encontrado.', 404)
    if (expectedCalendarId && cleanString(existing.calendar_id) !== expectedCalendarId) {
      throw createServiceError('El mensaje automático pertenece a otro calendario.', 404)
    }

    // Borrar la regla desactiva cualquier ultimátum todavía pendiente en el
    // mismo commit que retira la configuración. Conservamos el envío realizado
    // como auditoría, pero una regla retirada jamás cancela después.
    await transaction.run(`
      UPDATE appointment_reminder_sends
      SET confirmation_timeout_status = 'disabled',
          confirmation_timeout_processed_at = ?
      WHERE reminder_id = ?
        AND confirmation_timeout_status = 'pending'
    `, [nowIso(), id])
    await transaction.run('DELETE FROM appointment_reminders WHERE id = ?', [id])
    await transaction.run(
      "DELETE FROM appointment_reminder_sends WHERE reminder_id = ? AND status != 'sent'",
      [id]
    )
  })
  return { id }
}

/**
 * Crea una sola vez los tres mensajes iniciales de una cuenta nueva: el aviso
 * inmediato al agendar, el recordatorio una hora antes y la confirmación un día
 * antes. Todos nacen pausados para
 * que el usuario revise canal y plantillas antes de enviar. La bandera en
 * app_config evita recrearlos si después los edita o elimina.
 */
export async function ensureDefaultAppointmentReminder() {
  await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
  const seeded = await getAppConfig(SEEDED_CONFIG_KEY)
  if (seeded) {
    await backfillMissingReminderTemplates()
    return
  }

  const calendarId = await resolveAppointmentReminderCalendarId('', { allowMissing: true })
  if (!calendarId) {
    logger.info('[Citas] Los mensajes automáticos iniciales esperan a que exista un calendario.')
    return
  }

  const existing = await db.get('SELECT id FROM appointment_reminders LIMIT 1')
  if (!existing) {
    const defaultReminders = [
      {
        systemKey: DEFAULT_BOOKING_NOTICE_SYSTEM_KEY,
        input: {
          name: 'Aviso al agendar',
          enabled: false,
          messageType: 'reminder',
          aiEnabled: false,
          timingAnchor: 'after_booking',
          offsetValue: 0,
          offsetUnit: 'minutes',
          smartEnabled: false
        },
        logMessage: '[Citas] Aviso por defecto creado y pausado (al momento de agendar)'
      },
      {
        systemKey: DEFAULT_ONE_HOUR_REMINDER_SYSTEM_KEY,
        input: {
          name: 'Recordatorio 1 hora antes',
          enabled: false,
          messageType: 'reminder',
          aiEnabled: false,
          timingAnchor: 'before_appointment',
          offsetValue: 1,
          offsetUnit: 'hours',
          messageText: DEFAULT_ONE_HOUR_REMINDER_TEXT,
          smartEnabled: false
        },
        logMessage: '[Citas] Recordatorio por defecto creado y pausado (1 hora antes, sin IA)'
      },
      {
        systemKey: DEFAULT_CONFIRMATION_SYSTEM_KEY,
        input: {
          name: 'Confirmación 1 día antes',
          enabled: false,
          messageType: 'confirmation',
          aiEnabled: false,
          timingAnchor: 'before_appointment',
          offsetValue: 1,
          offsetUnit: 'days',
          smartEnabled: true
        },
        logMessage: '[Citas] Confirmación por defecto creada y pausada (1 día antes, sin IA)'
      }
    ]

    for (const reminder of defaultReminders) {
      const { created } = await insertAppointmentReminder({
        ...reminder.input,
        calendarId
      }, {
        systemKey: reminder.systemKey,
        ignoreConflict: true
      })
      if (created) logger.info(reminder.logMessage)
    }
  }

  await backfillMissingReminderTemplates()
  await setAppConfig(SEEDED_CONFIG_KEY, '1')
}

export async function syncOnlineMeetingAppointmentReminder(calendarId, { enabled = true } = {}) {
  const resolvedCalendarId = await resolveAppointmentReminderCalendarId(calendarId, { fallbackToDefault: false })
  const existing = await db.get(
    'SELECT * FROM appointment_reminders WHERE calendar_id = ? AND system_key = ? LIMIT 1',
    [resolvedCalendarId, ONLINE_MEETING_REMINDER_SYSTEM_KEY]
  )

  if (!enabled) {
    if (existing?.id) {
      await db.run(
        'UPDATE appointment_reminders SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [existing.id]
      )
      return normalizeReminderRow(await db.get(
        'SELECT * FROM appointment_reminders WHERE id = ?',
        [existing.id]
      ))
    }
    return null
  }

  // Esta regla se administra al crearla y al prender/apagar el modo en línea,
  // pero su contenido sigue siendo configuración del usuario. Guardar el
  // calendario no debe reemplazar una plantilla aprobada, el remitente ni otros
  // ajustes que el usuario ya personalizó en Mensajes automáticos.
  if (existing?.id) {
    await db.run(
      'UPDATE appointment_reminders SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [existing.id]
    )
    return normalizeReminderRow(await db.get(
      'SELECT * FROM appointment_reminders WHERE id = ?',
      [existing.id]
    ))
  }

  const template = await ensureOnlineMeetingMessageTemplate()
  if (!template?.id) throw createServiceError('No se pudo preparar la plantilla para citas en línea.', 500)

  const input = {
    calendarId: resolvedCalendarId,
    name: 'Enlace de videollamada · 10 minutos antes',
    enabled: true,
    messageType: 'reminder',
    aiEnabled: false,
    channel: 'whatsapp',
    senderMode: 'contact',
    templateId: template.id,
    templateName: template.name || ONLINE_MEETING_TEMPLATE_NAME,
    templateLanguage: template.language,
    contentMode: 'template',
    timingAnchor: 'before_appointment',
    offsetValue: 10,
    offsetUnit: 'minutes',
    messageText: ONLINE_MEETING_REMINDER_MESSAGE_TEXT,
    smartEnabled: false,
    bypassAutomations: false
  }

  const inserted = await insertAppointmentReminder(input, {
    systemKey: ONLINE_MEETING_REMINDER_SYSTEM_KEY,
    ignoreConflict: true
  })
  if (inserted.reminder) return inserted.reminder

  logger.warn(`[Citas] El calendario ${resolvedCalendarId} ya tiene otro mensaje automático 10 minutos antes; no se reemplazó la configuración del usuario.`)
  return null
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
    qrReady: false,
    qrFallbackAvailable: false
  }

  const route = await resolveWhatsAppOutboundRoute({
    phoneNumberId: cleanString(row.id),
    fromPhone: cleanString(row.phone_number),
    preferredTransport: cleanString(reminder?.channel) === 'whatsapp_qr' ? 'qr' : undefined
  })
  return {
    fromPhone: route.fromPhone,
    phoneNumberId: route.phoneNumberId,
    transport: route.transport,
    apiEnabled: route.available && route.transport === 'api',
    qrReady: route.available && route.transport === 'qr',
    qrFallbackAvailable: route.qrFallbackAvailable
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

async function buildReminderTemplateVariableOptions(appointment, timezone) {
  const context = { contact: appointment, appointment, timezone }
  const appointmentVariableKeys = [
    'cita.titulo',
    'cita.fecha',
    'cita.hora',
    'cita.fecha_hora'
  ]
  const extraVariables = Object.fromEntries(
    appointmentVariableKeys.map(key => [
      key,
      renderMessageText(`{{${key}}}`, context)
    ])
  )
  extraVariables['cita.enlace_ingreso'] = ''
  if (appointment.meeting_trigger_link_public_id) {
    const { buildAppointmentMeetingJoinUrl } = await import('./calendarMeetingService.js')
    extraVariables['cita.enlace_ingreso'] = await buildAppointmentMeetingJoinUrl({
      appointment,
      contactId: appointment.contact_id,
      triggerLinkPublicId: appointment.meeting_trigger_link_public_id
    })
  }

  return {
    contactId: cleanString(appointment.contact_id),
    phone: cleanString(appointment.phone),
    contact: {
      id: cleanString(appointment.contact_id),
      first_name: cleanString(appointment.first_name),
      last_name: cleanString(appointment.last_name),
      full_name: cleanString(appointment.full_name),
      phone: cleanString(appointment.phone),
      email: cleanString(appointment.email)
    },
    extraVariables
  }
}

function parseExpectedTemplateBodyParameterCount(errorMessage = '') {
  const text = cleanString(errorMessage)
  if (!/\b(?:BODY|CUERPO|LOCALIZABLE_PARAMS?)\b/i.test(text)) return null
  for (const pattern of TEMPLATE_EXPECTED_BODY_PARAMETER_PATTERNS) {
    const match = pattern.exec(text)
    const count = Number(match?.[1])
    if (Number.isInteger(count) && count >= 0) return count
  }
  return null
}

function isCurrentThreeFieldConfirmationContract(template = {}) {
  const indexes = extractNumericVariableIndexes(template.bodyText)
  if (indexes.length !== 3 || indexes.some((index, position) => index !== position + 1)) {
    return false
  }

  const bindings = template.variableBindings?.bodyText || {}
  return cleanString(bindings['1']?.variableKey) === 'contact.first_name' &&
    cleanString(bindings['2']?.variableKey) === 'cita.fecha' &&
    cleanString(bindings['3']?.variableKey) === 'cita.hora'
}

function adaptTemplateToLearnedBodyParameterCount({
  template,
  templateName,
  expectedBodyParameterCount
} = {}) {
  const isLegacyConfirmationTemplate =
    cleanString(templateName).toLowerCase() === DEFAULT_TEMPLATE_NAME_BY_PURPOSE.confirmation
  if (
    !isLegacyConfirmationTemplate ||
    expectedBodyParameterCount !== 2 ||
    !isCurrentThreeFieldConfirmationContract(template)
  ) {
    return { template, adapted: false }
  }

  const bindings = template.variableBindings || { headerText: {}, bodyText: {} }
  return {
    adapted: true,
    template: {
      ...template,
      bodyText: LEGACY_CONFIRMATION_TEMPLATE_BODY,
      variableBindings: {
        ...bindings,
        bodyText: {
          1: bindings.bodyText?.['1'] || {},
          2: bindings.bodyText?.['3'] || {}
        }
      }
    }
  }
}

async function getLearnedTemplateBodyParameterCount({
  templateName,
  language,
  fromPhone
} = {}) {
  const cleanTemplateName = cleanString(templateName)
  const cleanLanguage = cleanString(language)
  const cleanFromPhone = cleanString(fromPhone)
  if (!cleanTemplateName || !cleanLanguage) return null

  // Cada identificador se resuelve por separado para que PostgreSQL pueda usar
  // su índice. Un JOIN con tres OR obligaba a recorrer whatsapp_api_messages y,
  // en cuentas con historial grande, agotaba el statement_timeout antes de
  // enviar el recordatorio.
  const rows = await db.all(`
    WITH matching_sends AS (
      SELECT provider_message_id, ycloud_message_id, wamid
      FROM whatsapp_api_template_sends
      WHERE LOWER(COALESCE(template_name, '')) = LOWER(?)
        AND LOWER(COALESCE(language, '')) = LOWER(?)
        AND (? = '' OR COALESCE(from_phone, '') = ?)
    ),
    matched_failures AS (
      SELECT m.error_message, m.updated_at
      FROM matching_sends s
      JOIN whatsapp_api_messages m
        ON m.provider_message_id = s.provider_message_id
      WHERE NULLIF(s.provider_message_id, '') IS NOT NULL
        AND LOWER(COALESCE(m.status, '')) = 'failed'

      UNION

      SELECT m.error_message, m.updated_at
      FROM matching_sends s
      JOIN whatsapp_api_messages m
        ON m.ycloud_message_id = s.ycloud_message_id
      WHERE NULLIF(s.ycloud_message_id, '') IS NOT NULL
        AND LOWER(COALESCE(m.status, '')) = 'failed'

      UNION

      SELECT m.error_message, m.updated_at
      FROM matching_sends s
      JOIN whatsapp_api_messages m
        ON m.wamid = s.wamid
      WHERE NULLIF(s.wamid, '') IS NOT NULL
        AND LOWER(COALESCE(m.status, '')) = 'failed'
    )
    SELECT error_message, updated_at
    FROM matched_failures
    ORDER BY updated_at DESC
    LIMIT 20
  `, [
    cleanTemplateName,
    cleanLanguage,
    cleanFromPhone,
    cleanFromPhone
  ])

  for (const row of rows) {
    const count = parseExpectedTemplateBodyParameterCount(row.error_message)
    if (count !== null) return count
  }
  return null
}

async function reconcileFailedTemplateReminderSends(appointmentIds = []) {
  const ids = [...new Set(appointmentIds.map(cleanString).filter(Boolean))]
  if (!ids.length) return 0

  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db.all(`
    WITH candidate_sends AS (
      SELECT reminder_id, appointment_id, sent_message_id
      FROM appointment_reminder_sends
      WHERE status = 'sent'
        AND appointment_id IN (${placeholders})
        AND NULLIF(sent_message_id, '') IS NOT NULL
    ),
    matched_failures AS (
      SELECT
        ars.reminder_id,
        ars.appointment_id,
        ars.sent_message_id,
        m.error_message,
        m.updated_at
      FROM candidate_sends ars
      JOIN whatsapp_api_messages m
        ON m.provider_message_id = ars.sent_message_id
      WHERE LOWER(COALESCE(m.status, '')) = 'failed'

      UNION

      SELECT
        ars.reminder_id,
        ars.appointment_id,
        ars.sent_message_id,
        m.error_message,
        m.updated_at
      FROM candidate_sends ars
      JOIN whatsapp_api_messages m
        ON m.ycloud_message_id = ars.sent_message_id
      WHERE LOWER(COALESCE(m.status, '')) = 'failed'

      UNION

      SELECT
        ars.reminder_id,
        ars.appointment_id,
        ars.sent_message_id,
        m.error_message,
        m.updated_at
      FROM candidate_sends ars
      JOIN whatsapp_api_messages m
        ON m.wamid = ars.sent_message_id
      WHERE LOWER(COALESCE(m.status, '')) = 'failed'
    )
    SELECT reminder_id, appointment_id, sent_message_id, error_message, updated_at
    FROM matched_failures
    ORDER BY updated_at DESC
  `, ids)

  let reconciled = 0
  const handled = new Set()
  for (const row of rows) {
    const key = `${row.reminder_id}|${row.appointment_id}`
    if (handled.has(key)) continue

    handled.add(key)
    const failedAt = parseStoredUtcDateTime(row.updated_at)?.toISO() || nowIso()
    const result = await db.run(`
      UPDATE appointment_reminder_sends
      SET status = 'error',
          error_message = ?,
          sent_at = ?,
          confirmation_deadline_at = NULL,
          confirmation_timeout_status = NULL,
          confirmation_timeout_processed_at = NULL
      WHERE reminder_id = ?
        AND appointment_id = ?
        AND status = 'sent'
        AND sent_message_id = ?
    `, [
      cleanString(row.error_message) || 'WhatsApp rechazó la estructura de la plantilla.',
      failedAt,
      row.reminder_id,
      row.appointment_id,
      row.sent_message_id
    ])
    reconciled += Number(result?.changes || 0)
  }

  return reconciled
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

function buildAppointmentReminderExternalId(reminder, appointment, attemptCount = 1) {
  const attempt = Math.max(1, Math.min(MAX_SEND_ATTEMPTS, Number(attemptCount) || 1))
  return `appointment-reminder:${reminder.id}:${appointment.id}:attempt:${attempt}`
}

async function sendReminderViaQr({ reminder, appointment, sender, template, timezone, attemptCount }) {
  if (!sender?.qrReady) {
    throw new Error('Conecta un número de WhatsApp QR para enviar este recordatorio.')
  }
  const text = await getReminderPlainText(reminder, appointment, timezone)

  const response = await sendWhatsAppApiTextMessage({
    to: appointment.phone,
    text,
    from: sender.fromPhone || undefined,
    contactId: appointment.contact_id,
    phoneNumberId: sender.phoneNumberId || undefined,
    externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
    transport: 'qr',
    allowQrFallback: false,
    variablesResolved: true
  })
  return response
}

function reminderUsesWhatsAppTemplate(reminder = {}) {
  return isWhatsAppReminderChannel(reminder.channel) && reminder.contentMode !== 'direct'
}

function getAppointmentReminderSubject(reminder = {}) {
  const name = cleanString(reminder.name)
  if (reminder.messageType === 'confirmation') return name || 'Confirma tu cita'
  if (reminder.timingAnchor === 'after_booking') return name || 'Cita agendada'
  return name || 'Recordatorio de cita'
}

function getSentMessageId(response = {}) {
  return cleanString(
    response?.id ||
      response?.localMessageId ||
      response?.messageId ||
      response?.remoteMessageId
  )
}

function getFailedMessageId(error = {}) {
  return cleanString(error?.localMessageId || error?.messageId)
}

function getReminderChannelLabel(reminder = {}) {
  return CHANNEL_LABELS[cleanString(reminder.channel)] || cleanString(reminder.channel) || 'canal'
}

async function getReminderPlainText(reminder, appointment, timezone) {
  const variableOptions = await buildReminderTemplateVariableOptions(appointment, timezone)
  if (reminder.contentMode === 'template') {
    const template = await getPurposeCompatibleReminderTemplate(reminder)
    if (!template) throw new Error('Selecciona un mensaje para renderizar el texto de este recordatorio.')
    return buildDefaultMessageTemplateFallbackText({
      templateId: template.id,
      templateName: getMessageTemplateProviderState(template).name || template.name,
      language: template.language,
      variableOptions
    })
  }
  return renderTemplateVariables(reminder.messageText, variableOptions)
}

function getMissingReminderTarget(reminder = {}, appointment = {}) {
  const channel = cleanString(reminder.channel) || 'whatsapp'
  if (isWhatsAppReminderChannel(channel) && !cleanString(appointment.phone)) {
    return 'El contacto no tiene teléfono para WhatsApp.'
  }
  if (channel === 'email' && !cleanString(appointment.email)) {
    return 'El contacto no tiene correo electrónico.'
  }
  if ((channel === 'messenger' || channel === 'instagram') && !cleanString(appointment.contact_id)) {
    return 'La cita no tiene contacto enlazado para enviar por Meta.'
  }
  return ''
}

function normalizeAppointmentSourceChannel(appointment = {}) {
  for (const source of [
    appointment.booking_channel,
    appointment.source_channel,
    appointment.channel,
    appointment.origin_channel,
    appointment.source,
    appointment.origin
  ]) {
    const channel = normalizeRealReminderChannel(source)
    if (channel) return channel
  }
  return ''
}

async function resolvePreferredWhatsAppSenderChannel(appointment = {}) {
  const preferredId = cleanString(appointment.preferred_whatsapp_phone_number_id)
  if (!preferredId) return ''
  const row = await db.get(`
    SELECT api_send_enabled, qr_send_enabled, qr_status
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [preferredId])
  if (!row) return ''
  if (Number(row.api_send_enabled || 0) === 1) return 'whatsapp'
  if (Number(row.qr_send_enabled || 0) === 1 && cleanString(row.qr_status).toLowerCase() === 'connected') return 'whatsapp_qr'
  return ''
}

async function resolveAppointmentBookedChannel(appointment = {}) {
  const sourceChannel = normalizeAppointmentSourceChannel(appointment)
  if (sourceChannel === 'whatsapp') {
    const preferredWhatsAppChannel = await resolvePreferredWhatsAppSenderChannel(appointment)
    if (preferredWhatsAppChannel) return preferredWhatsAppChannel
  }
  if (sourceChannel) return sourceChannel

  // No usamos el último chat como si fuera evidencia de dónde se agendó: puede
  // pertenecer a otra conversación. Si una cita vieja no guardó el canal, la
  // política correcta es caer al orden de canales disponibles.
  return ''
}

function buildAutomaticChannelOrder(mode, preferredChannel = '') {
  const priority = [...REAL_REMINDER_CHANNELS]
  const preferred = normalizeRealReminderChannel(preferredChannel)
  const ordered = mode === 'booking_channel' && preferred
    ? [preferred, ...priority]
    : priority
  return [...new Set(ordered)]
}

async function sendReminderByResolvedChannel({ reminder, appointment, timezone, channel, attemptCount }) {
  const resolvedChannel = normalizeRealReminderChannel(channel)
  if (!resolvedChannel) throw new Error('Canal de envío inválido.')
  const resolvedReminder = {
    ...reminder,
    channel: resolvedChannel,
    // El ruteo automático no implementa su propio salto API -> QR. Conserva
    // la preferencia sólo en el intento API y deja que la capa central valide
    // si la indisponibilidad realmente autoriza el respaldo del mismo número.
    qrFallbackEnabled: resolvedChannel === 'whatsapp',
    senderMode: isWhatsAppReminderChannel(resolvedChannel) ? reminder.senderMode : 'contact'
  }
  const missingTarget = getMissingReminderTarget(resolvedReminder, appointment)
  if (missingTarget) throw new Error(missingTarget)
  const response = await sendAppointmentReminderByChannel({
    reminder: resolvedReminder,
    appointment,
    timezone,
    attemptCount
  })
  return {
    ...response,
    resolvedChannel
  }
}

async function sendAppointmentReminderByAutomaticChannel({ reminder, appointment, timezone, attemptCount }) {
  const mode = cleanString(reminder.channel)
  const preferredChannel = mode === 'booking_channel'
    ? await resolveAppointmentBookedChannel(appointment)
    : ''
  const sender = await resolveSenderPhone(reminder, appointment)
  const channels = buildAutomaticChannelOrder(mode, preferredChannel).filter(channel => {
    // API y QR del mismo número son un solo intento de WhatsApp. Repetir ambos
    // como canales consecutivos podía ejecutar dos envíos físicos.
    if (sender.apiEnabled) return channel !== 'whatsapp_qr'
    if (sender.qrReady) return channel !== 'whatsapp'
    return true
  })
  const failures = []
  let failedMessageId = ''

  for (const channel of channels) {
    try {
      return await sendReminderByResolvedChannel({ reminder, appointment, timezone, channel, attemptCount })
    } catch (error) {
      failures.push(`${CHANNEL_LABELS[channel] || channel}: ${error.message}`)
      failedMessageId = getFailedMessageId(error) || failedMessageId
    }
  }

  const deliveryError = new Error(failures.length
    ? `No se pudo enviar por ningún canal disponible. ${failures.join(' | ')}`
    : 'No hay ningún canal disponible para este contacto.')
  if (failedMessageId) deliveryError.localMessageId = failedMessageId
  throw deliveryError
}

async function sendReminderViaWhatsAppDirect({ reminder, appointment, sender, timezone, attemptCount }) {
  const text = await getReminderPlainText(reminder, appointment, timezone)
  if (!text) throw new Error('Escribe el mensaje directo que se enviará en este recordatorio.')

  if (cleanString(reminder.channel) === 'whatsapp_qr') {
    if (!sender.qrReady) {
      throw new Error('Conecta WhatsApp QR para enviar este recordatorio por QR.')
    }
    return sendWhatsAppApiTextMessage({
      to: appointment.phone,
      text,
      from: sender.fromPhone || undefined,
      contactId: appointment.contact_id,
      phoneNumberId: sender.phoneNumberId || undefined,
      externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
      transport: 'qr',
      allowQrFallback: false,
      forceRequestedTransport: true,
      variablesResolved: true
    })
  }

  if (!sender.apiEnabled) {
    throw new Error('Conecta un número de WhatsApp API o QR para enviar este recordatorio.')
  }

  return sendWhatsAppApiTextMessage({
    to: appointment.phone,
    text,
    from: sender.fromPhone || undefined,
    contactId: appointment.contact_id,
    phoneNumberId: sender.phoneNumberId || undefined,
    externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
    allowQrFallback: true,
    variablesResolved: true
  })
}

async function sendReminderViaEmail({ reminder, appointment, timezone, attemptCount }) {
  const text = await getReminderPlainText(reminder, appointment, timezone)
  if (!text) throw new Error('Escribe el mensaje que se enviará por correo.')

  return sendEmailToContact({
    contactId: appointment.contact_id,
    to: appointment.email,
    subject: getAppointmentReminderSubject(reminder),
    text,
    externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
    includeSignature: true,
    variablesResolved: true
  })
}

async function sendReminderViaMetaSocial({ reminder, appointment, timezone, attemptCount }) {
  const channel = cleanString(reminder.channel) === 'instagram' ? 'instagram' : 'messenger'
  const text = await getReminderPlainText(reminder, appointment, timezone)
  if (!text) throw new Error(`Escribe el mensaje que se enviará por ${CHANNEL_LABELS[channel]}.`)

  return sendMetaSocialTextMessage({
    contactId: appointment.contact_id,
    platform: channel,
    message: text,
    externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
    variablesResolved: true
  })
}

async function sendReminderViaWhatsAppTemplate({ reminder, appointment, timezone, attemptCount }) {
  const sender = await resolveSenderPhone(reminder, appointment)
  const template = await getPurposeCompatibleReminderTemplate(reminder)
  if (!template) {
    throw new Error('Selecciona una plantilla de WhatsApp para este recordatorio.')
  }

  const providerState = getMessageTemplateProviderState(template)
  const templateStatus = providerState.status
  if (!sender.apiEnabled && sender.qrReady) {
    return sendReminderViaQr({
      reminder,
      appointment,
      sender,
      template,
      timezone,
      attemptCount
    })
  }

  if (!APPROVED_TEMPLATE_STATUSES.has(templateStatus)) {
    const statusLabel = templateStatus || 'sin enviar a revisión'
    throw new Error(`La plantilla ${template.name} está ${statusLabel}; solo se pueden enviar plantillas APPROVED por WhatsApp API.`)
  }

  if (!sender.apiEnabled) throw new Error('Conecta un número de WhatsApp API o QR para enviar este recordatorio.')

  const expectedBodyParameterCount = await getLearnedTemplateBodyParameterCount({
    templateName: providerState.name,
    language: template.language,
    fromPhone: sender.fromPhone
  })
  const deliveryContract = adaptTemplateToLearnedBodyParameterCount({
    template,
    templateName: providerState.name,
    expectedBodyParameterCount
  })
  if (deliveryContract.adapted) {
    logger.warn(
      `[Citas] Plantilla ${providerState.name}/${template.language} adaptada al contrato legacy ` +
      `de ${expectedBodyParameterCount} variables aprendido del rechazo de WhatsApp.`
    )
  }
  const deliveryContext = { appointment, timezone }
  // Las plantillas modernas pueden exigir parámetros no sólo en header/body,
  // sino también en botones URL. Reutilizar el constructor compartido evita
  // mandar a Meta una plantilla incompleta (error 131008). La adaptación legacy
  // conserva su objeto temporal de dos parámetros y por eso sigue usando el
  // constructor local.
  let components = deliveryContract.adapted
    ? buildReminderTemplateComponents(deliveryContract.template, deliveryContext)
    : await buildDefaultMessageTemplateSendComponents({
        templateId: template.id,
        templateName: providerState.name,
        language: template.language,
        variableOptions: await buildReminderTemplateVariableOptions(appointment, timezone)
      })
  let renderedTextOverride = deliveryContract.adapted
    ? renderReminderTemplateText(deliveryContract.template, deliveryContext)
    : ''
  if (deliveryContract.adapted) {
    const variableOptions = await buildReminderTemplateVariableOptions(appointment, timezone)
    ;[components, renderedTextOverride] = await Promise.all([
      renderTemplateVariablesInValue(components, variableOptions),
      renderTemplateVariables(renderedTextOverride, variableOptions)
    ])
  }
  return sendWhatsAppApiTemplateMessage({
    to: appointment.phone,
    from: sender.fromPhone || undefined,
    templateName: providerState.name,
    language: template.language,
    ...(components.length ? { components } : {}),
    contactId: appointment.contact_id,
    phoneNumberId: sender.phoneNumberId || undefined,
    externalId: buildAppointmentReminderExternalId(reminder, appointment, attemptCount),
    renderedTextOverride,
    allowQrFallback: true,
    variablesResolved: true
  })
}

async function sendAppointmentReminderByChannel({ reminder, appointment, timezone, attemptCount = 1 }) {
  const channel = cleanString(reminder.channel) || 'whatsapp'
  if (isAutomaticReminderChannel(channel)) {
    return sendAppointmentReminderByAutomaticChannel({ reminder, appointment, timezone, attemptCount })
  }
  if (channel === 'email') {
    return sendReminderViaEmail({ reminder, appointment, timezone, attemptCount })
  }
  if (channel === 'messenger' || channel === 'instagram') {
    return sendReminderViaMetaSocial({ reminder, appointment, timezone, attemptCount })
  }
  if (reminderUsesWhatsAppTemplate(reminder)) {
    return sendReminderViaWhatsAppTemplate({ reminder, appointment, timezone, attemptCount })
  }

  const sender = await resolveSenderPhone(reminder, appointment)
  return sendReminderViaWhatsAppDirect({ reminder, appointment, sender, timezone, attemptCount })
}

export function setAutomationAppointmentConfirmationSenderForTest(sender = null) {
  automationAppointmentConfirmationSenderForTest = typeof sender === 'function' ? sender : null
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

function reminderSendSourceSnapshot(reminder = {}) {
  const sourceType = cleanString(reminder.sourceType) || 'appointment_reminder'
  return {
    sourceType,
    sourceId: cleanString(reminder.sourceId || reminder.id) || null,
    sourceConfig: sourceType === 'automation'
      ? JSON.stringify({
          calendarId: cleanString(reminder.calendarId),
          channel: cleanString(reminder.channel) || 'whatsapp',
          noConfirmAction: normalizeNoConfirmAction(reminder.noConfirmAction),
          bypassAutomations: reminder.bypassAutomations === true || Number(reminder.bypassAutomations || 0) === 1,
          confirmationSuccessAction: serializeConfirmationSuccessActions(
            reminder.confirmationSuccessActions ?? reminder.confirmationSuccessAction,
            DEFAULT_CONFIRMATION_SUCCESS_ACTIONS
          ),
          confirmationReplyText: cleanString(reminder.confirmationReplyText)
        })
      : null
  }
}

async function recordSend({ reminder, appointment, status, sendAt, sentMessageId = '', errorMessage = '' }) {
  const source = reminderSendSourceSnapshot(reminder)
  await db.run(`
    INSERT INTO appointment_reminder_sends (
      id, reminder_id, appointment_id, contact_id, status, message_type,
      ai_enabled, sent_message_id, error_message, send_at, sent_at,
      source_type, source_id, source_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    createSendId(), reminder.id, appointment.id, cleanString(appointment.contact_id) || null,
    status, reminder.messageType, reminder.aiEnabled ? 1 : 0,
    cleanString(sentMessageId) || null, cleanString(errorMessage) || null,
    sendAt ? sendAt.toISO() : null, ['sent', 'error', 'skipped'].includes(status) ? nowIso() : null,
    source.sourceType, source.sourceId, source.sourceConfig
  ])
}

// (NOTI-002/CRON-003) Claim atómico ANTES de enviar el WhatsApp. Insertamos la fila en
// estado 'sending' aprovechando el UNIQUE(reminder_id, appointment_id); si otra instancia
// ya la insertó, el ON CONFLICT DO NOTHING deja changes=0 y NO enviamos (evita doble
// mensaje al cliente). Solo el proceso que gana el claim (changes>0) procede a enviar.
async function claimSend({ reminder, appointment, sendAt, retryCooldownMs = ERROR_RETRY_MS }) {
  const source = reminderSendSourceSnapshot(reminder)
  const res = await db.run(`
    INSERT INTO appointment_reminder_sends (
      id, reminder_id, appointment_id, contact_id, status, message_type,
      ai_enabled, sent_message_id, error_message, send_at, sent_at, attempt_count,
      source_type, source_id, source_config
    ) VALUES (?, ?, ?, ?, 'sending', ?, ?, NULL, NULL, ?, NULL, 1, ?, ?, ?)
    ON CONFLICT (reminder_id, appointment_id) DO NOTHING
  `, [
    createSendId(), reminder.id, appointment.id, cleanString(appointment.contact_id) || null,
    reminder.messageType, reminder.aiEnabled ? 1 : 0,
    sendAt ? sendAt.toISO() : null,
    source.sourceType, source.sourceId, source.sourceConfig
  ])
  if (Number(res?.changes || 0) > 0) {
    return { claimed: true, attemptCount: 1, previousMessageId: '', status: 'sending' }
  }

  const previous = await db.get(`
    SELECT status, sent_message_id, COALESCE(attempt_count, 1) AS attempt_count
    FROM appointment_reminder_sends
    WHERE reminder_id = ? AND appointment_id = ?
    LIMIT 1
  `, [reminder.id, appointment.id])
  const previousAttemptCount = Math.max(1, Number(previous?.attempt_count || 1))
  if (!previous || previousAttemptCount >= MAX_SEND_ATTEMPTS) {
    return {
      claimed: false,
      attemptCount: previousAttemptCount,
      previousMessageId: '',
      status: cleanString(previous?.status)
    }
  }

  // Si el intento anterior terminó en error y ya pasó el enfriamiento, reclamamos
  // la misma fila de forma atómica para reintentar. Los estados sent/skipped/sending
  // siguen siendo terminales para no duplicar mensajes.
  const retryCutoff = DateTime.utc().minus({ milliseconds: Math.max(0, Number(retryCooldownMs) || 0) }).toISO()
  const retryCutoffExpression = appointmentReminderRetryCutoffExpression()
  const retry = await db.run(`
    UPDATE appointment_reminder_sends
    SET status = 'sending',
        contact_id = ?,
        message_type = ?,
        ai_enabled = ?,
        error_message = NULL,
        send_at = ?,
        sent_at = NULL,
        attempt_count = COALESCE(attempt_count, 1) + 1,
        confirmation_deadline_at = NULL,
        confirmation_timeout_status = NULL,
        confirmation_timeout_processed_at = NULL,
        source_type = ?,
        source_id = ?,
        source_config = ?
    WHERE reminder_id = ?
      AND appointment_id = ?
      AND status = 'error'
      AND COALESCE(attempt_count, 1) < ?
      AND ${retryCutoffExpression}
  `, [
    cleanString(appointment.contact_id) || null,
    reminder.messageType,
    reminder.aiEnabled ? 1 : 0,
    sendAt ? sendAt.toISO() : null,
    source.sourceType,
    source.sourceId,
    source.sourceConfig,
    reminder.id,
    appointment.id,
    MAX_SEND_ATTEMPTS,
    retryCutoff
  ])
  if (Number(retry?.changes || 0) === 0) {
    return {
      claimed: false,
      attemptCount: previousAttemptCount,
      previousMessageId: '',
      status: cleanString(previous.status)
    }
  }
  return {
    claimed: true,
    attemptCount: previousAttemptCount + 1,
    previousMessageId: cleanString(previous.sent_message_id),
    status: 'sending'
  }
}

function buildConfirmationTimeoutDeliveryState({
  reminder,
  appointment,
  status,
  finishedAt,
  timezone
}) {
  if (
    status !== 'sent' ||
    reminder.messageType !== 'confirmation' ||
    reminder.aiEnabled === false
  ) {
    return {
      confirmationDeadlineAt: null,
      confirmationTimeoutStatus: null,
      confirmationTimeoutProcessedAt: null
    }
  }

  const timeout = normalizeConfirmationTimeout(
    reminder.confirmationTimeoutValue,
    reminder.confirmationTimeoutUnit,
    reminder.confirmationTimeoutMode,
    reminder.confirmationResponseStart,
    reminder.confirmationResponseEnd
  )
  if (timeout.confirmationTimeoutValue === null) {
    return {
      confirmationDeadlineAt: null,
      confirmationTimeoutStatus: null,
      confirmationTimeoutProcessedAt: null
    }
  }

  const sentAt = DateTime.fromISO(finishedAt, { zone: 'utc' })
  const appointmentStart = parseStoredUtcDateTime(appointment.start_time)
  const deadline = computeConfirmationDeadline({
    sentAt,
    timeoutValue: timeout.confirmationTimeoutValue,
    timeoutUnit: timeout.confirmationTimeoutUnit,
    timeoutMode: timeout.confirmationTimeoutMode,
    responseStart: timeout.confirmationResponseStart,
    responseEnd: timeout.confirmationResponseEnd,
    timezone,
    latestAt: appointmentStart
  })

  if (!appointmentStart || !deadline || deadline >= appointmentStart) {
    return {
      confirmationDeadlineAt: null,
      confirmationTimeoutStatus: 'skipped',
      confirmationTimeoutProcessedAt: finishedAt
    }
  }

  return {
    confirmationDeadlineAt: deadline.toISO(),
    confirmationTimeoutStatus: 'pending',
    confirmationTimeoutProcessedAt: null
  }
}

const WHATSAPP_MESSAGE_DELIVERY_ID_COLUMNS = Object.freeze([
  'provider_message_id',
  'ycloud_message_id',
  'meta_message_id',
  'wamid'
])

async function resolveWhatsAppMessageByDeliveryId(deliveryId, database = db) {
  const cleanDeliveryId = cleanString(deliveryId)
  if (!cleanDeliveryId) return null

  const selectColumns = `
    id, contact_id, provider, transport, direction, message_type,
    status, message_timestamp, created_at, hidden_from_chat
  `
  const byLocalId = await database.get(`
    SELECT ${selectColumns}
    FROM whatsapp_api_messages
    WHERE id = ?
    LIMIT 1
  `, [cleanDeliveryId])
  if (byLocalId) return byLocalId

  // Consultas separadas conservan los índices directos de cada proveedor. Un
  // OR sobre todo el historial ya provocó timeouts en cuentas grandes.
  for (const column of WHATSAPP_MESSAGE_DELIVERY_ID_COLUMNS) {
    const row = await database.get(`
      SELECT ${selectColumns}
      FROM whatsapp_api_messages
      WHERE ${column} = ?
      LIMIT 1
    `, [cleanDeliveryId])
    if (row) return row
  }
  return null
}

async function hideSupersededReminderFailure({
  previousMessageId,
  currentMessageId,
  database = db
} = {}) {
  const cleanPreviousMessageId = cleanString(previousMessageId)
  const cleanCurrentMessageId = cleanString(currentMessageId)
  if (!cleanPreviousMessageId || !cleanCurrentMessageId) return null

  const previous = await resolveWhatsAppMessageByDeliveryId(cleanPreviousMessageId, database)
  if (!previous || cleanString(previous.status).toLowerCase() !== 'failed') return null

  const current = await resolveWhatsAppMessageByDeliveryId(cleanCurrentMessageId, database)
  if (current?.id && cleanString(current.id) === cleanString(previous.id)) return null

  const result = await database.run(`
    UPDATE whatsapp_api_messages
    SET hidden_from_chat = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND LOWER(COALESCE(status, '')) = 'failed'
      AND COALESCE(hidden_from_chat, 0) = 0
  `, [previous.id])
  return Number(result?.changes || 0) > 0 ? previous : null
}

// (NOTI-002/CRON-003) Marca el resultado final del envío sobre la fila ya reclamada.
async function finalizeSend({
  reminder,
  appointment,
  status,
  sentMessageId = '',
  errorMessage = '',
  timezone,
  attemptCount = 1,
  previousMessageId = ''
}) {
  const finishedAt = nowIso()
  const confirmationTimeout = buildConfirmationTimeoutDeliveryState({
    reminder,
    appointment,
    status,
    finishedAt,
    timezone
  })
  let hiddenFailure = null
  await db.transaction(async (transaction) => {
    await transaction.run(`
      UPDATE appointment_reminder_sends
      SET status = ?,
          sent_message_id = ?,
          error_message = ?,
          sent_at = CASE WHEN ? IN ('sent', 'error', 'skipped') THEN ? ELSE sent_at END,
          confirmation_deadline_at = ?,
          confirmation_timeout_status = ?,
          confirmation_timeout_processed_at = ?
      WHERE reminder_id = ? AND appointment_id = ?
    `, [
      status, cleanString(sentMessageId) || null, cleanString(errorMessage) || null,
      status, finishedAt,
      confirmationTimeout.confirmationDeadlineAt,
      confirmationTimeout.confirmationTimeoutStatus,
      confirmationTimeout.confirmationTimeoutProcessedAt,
      reminder.id,
      appointment.id
    ])

    if (Number(attemptCount) > 1) {
      hiddenFailure = await hideSupersededReminderFailure({
        previousMessageId,
        currentMessageId: sentMessageId,
        database: transaction
      })
    }
  })

  if (hiddenFailure?.contact_id) {
    publishChatMessageEvent({
      contactId: hiddenFailure.contact_id,
      messageId: hiddenFailure.id,
      channel: 'whatsapp',
      provider: hiddenFailure.provider,
      transport: hiddenFailure.transport,
      direction: hiddenFailure.direction,
      messageType: hiddenFailure.message_type,
      messageTimestamp: hiddenFailure.message_timestamp || hiddenFailure.created_at,
      isNew: false
    })
  }
}

function automationConfirmationReminderId(automationId, nodeId) {
  const cleanAutomationId = cleanString(automationId)
  const cleanNodeId = cleanString(nodeId)
  if (!cleanAutomationId || !cleanNodeId) {
    throw createServiceError('La acción de confirmación no tiene una identidad válida.')
  }
  return `automation-confirmation:${cleanAutomationId}:${cleanNodeId}`
}

async function loadAutomationConfirmationAppointment(appointmentId) {
  const id = cleanString(appointmentId)
  if (!id) throw createServiceError('La acción de confirmación necesita una cita identificada.')
  const appointment = await db.get(`
    SELECT
      a.id, a.calendar_id, a.title, a.start_time, a.date_added, a.source,
      a.booking_channel, a.appointment_status, a.status, a.contact_id,
      a.deleted_at, COALESCE(a.is_test, 0) AS is_test,
      c.phone, c.email, c.first_name, c.last_name, c.full_name,
      c.preferred_whatsapp_phone_number_id,
      tl.public_id AS meeting_trigger_link_public_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN trigger_links tl
      ON tl.system_scope = 'calendar_meeting'
      AND tl.owner_id = a.calendar_id
      AND tl.active = 1
      AND tl.archived = 0
    WHERE a.id = ?
    LIMIT 1
  `, [id])
  if (!appointment || appointment.deleted_at) {
    throw createServiceError('La cita seleccionada ya no existe.', 404)
  }
  return appointment
}

function automationConfirmationReminderInput(config = {}, calendarId = '') {
  const timing = normalizeOffsetForAnchor(
    cleanString(config.timingAnchor) === 'after_booking' ? 'after_booking' : 'before_appointment',
    config.offsetUnit,
    config.offsetValue,
    { clampMax: true }
  )
  const timeoutDefaults = getDefaultConfirmationTimeout(
    timing.timingAnchor,
    timing.offsetValue,
    timing.offsetUnit
  )
  const configuredTimeoutValue = Number(config.confirmationTimeoutValue)
  const rawChannel = cleanString(config.channel).toLowerCase()
  const channel = REAL_REMINDER_CHANNELS.includes(rawChannel) ? rawChannel : 'whatsapp'
  const contentMode = channel === 'whatsapp' ? 'template' : 'direct'
  return {
    calendarId,
    name: cleanString(config.name) || 'Confirmación de cita desde automatización',
    enabled: true,
    messageType: 'confirmation',
    aiEnabled: true,
    channel,
    senderMode: cleanString(config.senderMode || config.sender) || 'contact',
    senderPhoneNumberId: cleanString(config.senderPhoneNumberId || config.senderNumberId) || null,
    templateId: contentMode === 'template' ? cleanString(config.template || config.templateId) || null : null,
    templateName: contentMode === 'template' ? cleanString(config.templateName || config.templateIdName) : '',
    templateLanguage: cleanString(config.templateLanguage) || 'es_MX',
    contentMode,
    messageText: cleanString(config.messageText) || DEFAULT_CONFIRMATION_TEXT,
    timingAnchor: timing.timingAnchor,
    offsetValue: timing.offsetValue,
    offsetUnit: timing.offsetUnit,
    smartEnabled: config.smartEnabled !== false,
    smartStart: cleanString(config.smartStart) || '09:00',
    smartEnd: cleanString(config.smartEnd) || '21:00',
    smartOverflow: cleanString(config.smartOverflow) || 'before',
    noConfirmAction: cleanString(config.noConfirmAction) || 'no_action',
    confirmationTimeoutValue: Number.isInteger(configuredTimeoutValue) && configuredTimeoutValue > 0
      ? configuredTimeoutValue
      : timeoutDefaults.confirmationTimeoutValue,
    confirmationTimeoutUnit: cleanString(config.confirmationTimeoutUnit) || timeoutDefaults.confirmationTimeoutUnit,
    confirmationTimeoutMode: cleanString(config.confirmationTimeoutMode) || timeoutDefaults.confirmationTimeoutMode,
    confirmationResponseStart: cleanString(config.confirmationResponseStart) || timeoutDefaults.confirmationResponseStart,
    confirmationResponseEnd: cleanString(config.confirmationResponseEnd) || timeoutDefaults.confirmationResponseEnd,
    confirmationReplyText: cleanString(config.confirmationReplyText),
    confirmationSuccessActions: [
      'mark_confirmed',
      ...(config.createChatCard !== false ? ['chat_card'] : []),
      ...(config.createChatBadge !== false ? ['chat_badge'] : [])
    ],
    bypassAutomations: config.bypassAutomations === true
  }
}

/**
 * Acción de Automatizaciones que combina programación y envío de una solicitud
 * de confirmación. Si todavía no toca, devuelve `scheduled`; el motor conserva
 * la inscripción en el mismo nodo y vuelve a evaluarlo en el instante indicado.
 */
export async function executeAutomationAppointmentConfirmation({
  automationId,
  nodeId,
  appointmentId,
  config = {}
} = {}) {
  const appointment = await loadAutomationConfirmationAppointment(appointmentId)
  const configuredCalendarId = cleanString(config.calendar)
  const calendarId = cleanString(appointment.calendar_id)
  if (configuredCalendarId && configuredCalendarId !== calendarId) {
    throw createServiceError('La cita seleccionada pertenece a otro calendario.', 409)
  }
  if (Number(appointment.is_test || 0) === 1) {
    return { status: 'skipped', reason: 'test_appointment', appointmentId: appointment.id }
  }

  const status = cleanString(appointment.appointment_status || appointment.status).toLowerCase()
  if (['cancelled', 'canceled', 'showed', 'noshow', 'no_show', 'invalid', 'deleted'].includes(status)) {
    return { status: 'skipped', reason: 'terminal_appointment', appointmentId: appointment.id }
  }

  const prepared = await resolveReminderTemplateSelection(sanitizeReminderInput(
    automationConfirmationReminderInput(config, calendarId)
  ))
  const reminder = {
    ...prepared,
    id: automationConfirmationReminderId(automationId, nodeId),
    sourceType: 'automation',
    sourceId: `${cleanString(automationId)}:${cleanString(nodeId)}`
  }
  const timezone = await getAccountTimezone()
  const sendAt = computeReminderSendAt(
    appointment.start_time,
    reminder,
    timezone,
    appointment.date_added
  )
  if (!sendAt?.isValid) {
    throw createServiceError('No se pudo calcular cuándo enviar la confirmación de cita.')
  }

  const now = DateTime.utc()
  if (sendAt > now) {
    return {
      status: 'scheduled',
      appointmentId: appointment.id,
      sendAt: sendAt.toISO(),
      timingAnchor: reminder.timingAnchor
    }
  }

  // No se pide al contacto que confirme si el clasificador que debe atender su
  // respuesta dejó de estar conectado después de publicar la automatización.
  if (!automationAppointmentConfirmationSenderForTest) {
    await requireOpenAIApiKey()
  }

  const claim = await claimSend({
    reminder,
    appointment,
    sendAt,
    retryCooldownMs: 0
  })
  if (!claim.claimed) {
    if (['sent', 'skipped'].includes(claim.status)) {
      return { status: 'duplicate', appointmentId: appointment.id, sendAt: sendAt.toISO() }
    }
    throw createServiceError('La confirmación de cita no pudo reclamar un nuevo intento de envío.')
  }

  const bookedAt = parseStoredUtcDateTime(appointment.date_added)
  const appointmentStart = parseStoredUtcDateTime(appointment.start_time)
  let skipReason = ''
  if (appointmentStart && appointmentStart <= now) {
    skipReason = 'La cita ya comenzó; no se envió la solicitud de confirmación.'
  } else if (reminder.timingAnchor !== 'after_booking' && bookedAt && sendAt < bookedAt) {
    skipReason = 'La cita se agendó después del momento programado para confirmar.'
  } else if (now.toMillis() - sendAt.toMillis() > SEND_GRACE_MS) {
    skipReason = 'La solicitud de confirmación quedó fuera de la ventana de envío.'
  }

  if (skipReason) {
    await finalizeSend({
      reminder,
      appointment,
      status: 'skipped',
      errorMessage: skipReason,
      timezone,
      attemptCount: claim.attemptCount,
      previousMessageId: claim.previousMessageId
    })
    return { status: 'skipped', reason: skipReason, appointmentId: appointment.id }
  }

  try {
    const missingTarget = getMissingReminderTarget(reminder, appointment)
    if (missingTarget) throw createServiceError(missingTarget)
    const sender = automationAppointmentConfirmationSenderForTest || sendAppointmentReminderByChannel
    const response = await sender({
      reminder,
      appointment,
      timezone,
      attemptCount: claim.attemptCount
    })
    const sentMessageId = getSentMessageId(response)
    await finalizeSend({
      reminder,
      appointment,
      status: 'sent',
      sentMessageId,
      timezone,
      attemptCount: claim.attemptCount,
      previousMessageId: claim.previousMessageId
    })
    return {
      status: 'sent',
      appointmentId: appointment.id,
      sendAt: sendAt.toISO(),
      sentMessageId
    }
  } catch (error) {
    await finalizeSend({
      reminder,
      appointment,
      status: 'error',
      sentMessageId: getFailedMessageId(error),
      errorMessage: error.message,
      timezone,
      attemptCount: claim.attemptCount,
      previousMessageId: claim.previousMessageId
    })
    throw error
  }
}

/**
 * Valida los recordatorios de una cita de Modo test sin mandar mensajes al
 * contacto. Cada recordatorio configurado se renderiza y se entrega realmente
 * como notificación interna/push sólo al usuario que inició la prueba. El canal
 * externo queda registrado como simulación porque WhatsApp, email o DM no se
 * pueden retirar cinco minutos después.
 */
export async function executeSafeTestAppointmentReminders(appointment = {}) {
  const isTest = Boolean(appointment.isTest ?? appointment.is_test)
  const testRunId = cleanString(appointment.testRunId || appointment.test_run_id)
  const testEffectId = cleanString(appointment.testEffectId || appointment.test_effect_id)
  const appointmentId = cleanString(appointment.id)
  if (!isTest || !testRunId || !testEffectId || !appointmentId) {
    return { executed: false, reason: 'not_test_appointment', reminders: [] }
  }

  const run = await db.get(
    'SELECT requested_by_user_id FROM conversational_agent_test_runs WHERE id = ?',
    [testRunId]
  )
  if (!run?.requested_by_user_id) {
    return { executed: false, reason: 'test_run_not_found', reminders: [] }
  }

  const storedAppointment = await db.get(`
    SELECT a.*, c.phone, c.email, c.first_name, c.last_name, c.full_name,
      c.preferred_whatsapp_phone_number_id
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ? AND a.is_test = 1 AND a.test_effect_id = ?
  `, [appointmentId, testEffectId])
  if (!storedAppointment) {
    return { executed: false, reason: 'test_appointment_not_found', reminders: [] }
  }

  const timezone = await getAccountTimezone()
  const rows = await db.all(`
    SELECT *
    FROM appointment_reminders
    WHERE enabled = 1 AND calendar_id = ?
    ORDER BY position ASC, created_at ASC
  `, [cleanString(storedAppointment.calendar_id)])
  const reminders = rows.map(normalizeReminderRow).filter(Boolean)
  const results = []

  for (const reminder of reminders) {
    const auditContext = {
      testMode: true,
      testRunId,
      testEffectId,
      appointmentId,
      eventType: 'appointment-reminder',
      testExpiresAt: appointment.testExpiresAt || appointment.test_expires_at
    }
    const baseAction = {
      nodeId: reminder.id,
      nodeType: 'appointment-reminder',
      request: {
        reminderId: reminder.id,
        reminderName: reminder.name,
        configuredChannel: reminder.channel,
        messageType: reminder.messageType,
        testMode: true
      }
    }

    let renderedText = ''
    let validationError = getMissingReminderTarget(reminder, storedAppointment)
    if (!validationError) {
      try {
        renderedText = await getReminderPlainText(reminder, storedAppointment, timezone)
      } catch (error) {
        validationError = error.message
      }
    }
    const externalReceipt = await recordSimulatedAppointmentTestAction(auditContext, {
      ...baseAction,
      actionType: 'reminder-external-message',
      detail: validationError
        ? `Recordatorio externo no enviado: ${validationError}`
        : `Recordatorio externo por ${getReminderChannelLabel(reminder)} simulado para no dejar un mensaje permanente.`,
      response: { valid: !validationError, routedOnlyToTestOwner: true }
    })
    if (validationError) {
      results.push({
        reminderId: reminder.id,
        status: 'invalid',
        detail: externalReceipt?.detail || validationError
      })
      continue
    }

    const claim = await claimAppointmentTestAction(auditContext, {
      ...baseAction,
      actionType: 'reminder-test-notification',
      detail: 'Notificación de prueba del recordatorio.'
    })
    if (!claim.claimed) {
      results.push({
        reminderId: reminder.id,
        status: claim.receipt?.status || 'unknown',
        idempotent: true,
        detail: claim.receipt?.detail || 'Recordatorio de prueba ya procesado; no se duplicó.'
      })
      continue
    }

    try {
      const channelLabel = getReminderChannelLabel(reminder)
      const notification = await createInternalNotification({
        recipientUserIds: [cleanString(run.requested_by_user_id)],
        source: 'Recordatorios · Modo test',
        severity: 'info',
        title: `Prueba · ${getAppointmentReminderSubject(reminder)}`.slice(0, 120),
        message: `[Canal configurado: ${channelLabel}]\n${renderedText}\n\nNo se envió al contacto; esta copia llegó sólo a quien inició la prueba.`.slice(0, 900),
        actionUrl: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`,
        actionLabel: 'Abrir cita de prueba',
        category: 'appointment_reminder_test',
        contactId: cleanString(storedAppointment.contact_id),
        metadata: {
          testMode: true,
          testRunId,
          testEffectId,
          appointmentId,
          reminderId: reminder.id,
          configuredChannel: reminder.channel,
          routedOnlyToTestOwner: true,
          externalDeliverySimulated: true
        }
      })
      const delivered = Number(notification.created || 0) + Number(notification.push?.sent || 0)
      const receipt = await completeAppointmentTestAction(claim.receipt.id, {
        status: delivered > 0 ? 'sent' : 'failed',
        detail: delivered > 0
          ? `Recordatorio de prueba entregado al dueño por notificación interna/push (${delivered}).`
          : 'El recordatorio se renderizó, pero no había transporte interno/push disponible.',
        response: {
          bellCreated: Number(notification.created || 0),
          pushSent: Number(notification.push?.sent || 0),
          routedOnlyToTestOwner: true,
          externalDeliverySimulated: true
        }
      })
      results.push({
        reminderId: reminder.id,
        status: receipt?.status || (delivered > 0 ? 'sent' : 'failed'),
        detail: receipt?.detail || '',
        auditReceiptId: receipt?.id || claim.receipt.id
      })
    } catch (error) {
      const receipt = await completeAppointmentTestAction(claim.receipt.id, {
        status: 'failed',
        detail: `No se pudo entregar la copia segura del recordatorio: ${error.message}`,
        response: { error: true, routedOnlyToTestOwner: true }
      })
      results.push({
        reminderId: reminder.id,
        status: 'failed',
        detail: receipt?.detail || error.message,
        auditReceiptId: receipt?.id || claim.receipt.id
      })
    }
  }

  return {
    executed: true,
    testMode: true,
    isolated: true,
    reminders: results,
    configuredCount: reminders.length,
    sentCount: results.filter((result) => result.status === 'sent').length,
    simulatedCount: results.filter((result) => result.status === 'simulated').length,
    failedCount: results.filter((result) => ['failed', 'invalid'].includes(result.status)).length
  }
}

/**
 * Revisa las citas próximas y envía los mensajes automáticos que ya tocan.
 * Idempotente: cada par (recordatorio, cita) se envía una sola vez.
 */
export async function processDueAppointmentReminders({ batchSize = 25 } = {}) {
  const overview = await db.all("SELECT * FROM appointment_reminders WHERE enabled = 1")
  const reminders = overview.map(normalizeReminderRow).filter(reminder => reminder?.calendarId)
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

  const calendarIds = [...new Set(reminders.map(reminder => reminder.calendarId))]
  const calendarPlaceholders = calendarIds.map(() => '?').join(', ')
  params.push(...calendarIds)

  const appointments = await db.all(`
    SELECT a.id, a.calendar_id, a.title, a.start_time, a.date_added, a.source, a.booking_channel, a.appointment_status, a.status, a.contact_id,
      c.phone, c.email, c.first_name, c.last_name, c.full_name, c.preferred_whatsapp_phone_number_id,
      tl.public_id AS meeting_trigger_link_public_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN trigger_links tl
      ON tl.system_scope = 'calendar_meeting'
      AND tl.owner_id = a.calendar_id
      AND tl.active = 1
      AND tl.archived = 0
    WHERE a.deleted_at IS NULL
      AND COALESCE(a.is_test, 0) = 0
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
      AND (${clauses.join(' OR ')})
      AND a.calendar_id IN (${calendarPlaceholders})
  `, params)

  if (!appointments.length) return { sent: 0, errors: 0, skipped: 0 }

  // (NOTI-006) Antes se cargaba TODA la tabla appointment_reminder_sends en memoria por tick,
  // lo que crece sin límite con el historial. Acotamos la consulta a solo las citas que estamos
  // procesando en este tick (las únicas cuyos sends nos interesan para deduplicar).
  const appointmentIds = appointments.map(appointment => appointment.id)
  const reconciledTemplateFailures = await reconcileFailedTemplateReminderSends(appointmentIds)
  if (reconciledTemplateFailures > 0) {
    logger.warn(
      `[Citas] ${reconciledTemplateFailures} envío(s) aceptado(s) inicialmente por el proveedor ` +
      'terminaron rechazados y regresaron a la cola de reintento.'
    )
  }
  const sendPlaceholders = appointmentIds.map(() => '?').join(', ')
  const sendRows = appointmentIds.length
    ? await db.all(
        `SELECT reminder_id, appointment_id, status, sent_at, created_at, attempt_count
         FROM appointment_reminder_sends
         WHERE appointment_id IN (${sendPlaceholders})`,
        appointmentIds
      )
    : []
  const alreadyHandled = new Set()
  for (const row of sendRows) {
    const key = `${row.reminder_id}|${row.appointment_id}`
    const status = cleanString(row.status).toLowerCase()
    if (status === 'error') {
      const attemptCount = Math.max(1, Number(row.attempt_count || 1))
      if (attemptCount < MAX_SEND_ATTEMPTS && !shouldHoldErroredSend(row, now)) continue
    }
    alreadyHandled.add(key)
  }

  let sent = 0
  let errors = 0
  let skipped = 0

  for (const appointment of appointments) {
    for (const reminder of reminders) {
      if (sent + errors >= batchSize) break
      if (reminder.calendarId !== cleanString(appointment.calendar_id)) continue
      if (alreadyHandled.has(`${reminder.id}|${appointment.id}`)) continue

      // Los avisos "después de agendar" solo aplican a reservas hechas EN Ristak.
      // (La cita pudo entrar a la ventana por OTRO recordatorio anclado al inicio, así que
      // este guard es la verdad última, no solo el SQL.) Además, reservas viejas no las
      // disparan: evita marcar 'skipped' en masa para citas agendadas hace mucho.
      if (reminder.timingAnchor === 'after_booking') {
        const apptSource = cleanString(appointment.source).toLowerCase() || 'ristak'
        if (apptSource === 'google' || apptSource === 'ghl') continue
        const bookedAt = parseStoredUtcDateTime(appointment.date_added)
        if (!bookedAt || (afterSince && bookedAt < afterSince)) continue
      }

      const sendAt = computeReminderSendAt(appointment.start_time, reminder, timezone, appointment.date_added)
      if (!sendAt || sendAt > now) continue

      // (NOTI-002/CRON-003) Reclamar ANTES de enviar. Si otra instancia ya reclamó este
      // par (reminder, cita) no enviamos para evitar el doble mensaje al cliente.
      const claim = await claimSend({ reminder, appointment, sendAt })
      if (!claim.claimed) {
        alreadyHandled.add(`${reminder.id}|${appointment.id}`)
        continue
      }
      alreadyHandled.add(`${reminder.id}|${appointment.id}`)

      // Un recordatorio previo a la cita no puede convertirse en el mensaje de
      // bienvenida de una reserva tardía. Si la persona agendó después del
      // momento en que ese recordatorio debía salir, la ventana nunca existió
      // para esta cita: se omite aunque todavía caiga dentro de la tolerancia de
      // reintento. Los avisos reales al agendar usan el ancla after_booking y la
      // plantilla cita_programada, que sí muestra la fecha y hora confirmadas.
      const bookedAt = parseStoredUtcDateTime(appointment.date_added)
      if (reminder.timingAnchor !== 'after_booking' && bookedAt && sendAt < bookedAt) {
        await finalizeSend({
          reminder,
          appointment,
          status: 'skipped',
          errorMessage: 'La cita se agendó después del momento programado para este recordatorio.',
          timezone,
          attemptCount: claim.attemptCount,
          previousMessageId: claim.previousMessageId
        })
        skipped += 1
        continue
      }

      if (now.toMillis() - sendAt.toMillis() > SEND_GRACE_MS) {
        await finalizeSend({
          reminder,
          appointment,
          status: 'skipped',
          errorMessage: 'Fuera de la ventana de envío',
          timezone,
          attemptCount: claim.attemptCount,
          previousMessageId: claim.previousMessageId
        })
        skipped += 1
        continue
      }

      try {
        const missingTarget = getMissingReminderTarget(reminder, appointment)
        if (missingTarget) {
          await finalizeSend({
            reminder,
            appointment,
            status: 'skipped',
            errorMessage: missingTarget,
            timezone,
            attemptCount: claim.attemptCount,
            previousMessageId: claim.previousMessageId
          })
          skipped += 1
          continue
        }

        const response = await sendAppointmentReminderByChannel({
          reminder,
          appointment,
          timezone,
          attemptCount: claim.attemptCount
        })

        await finalizeSend({
          reminder,
          appointment,
          status: 'sent',
          sentMessageId: getSentMessageId(response),
          timezone,
          attemptCount: claim.attemptCount,
          previousMessageId: claim.previousMessageId
        })
        sent += 1
        const transport = response?.transport === 'qr'
          ? 'WhatsApp QR'
          : response?.transport === 'api'
            ? 'WhatsApp API'
            : response?.transport || response?.channel || CHANNEL_LABELS[response?.resolvedChannel] || getReminderChannelLabel(reminder)
        const target = appointment.phone || appointment.email || appointment.contact_id
        logger.info(`[Citas] Mensaje automático "${reminder.name}" enviado por ${transport} a ${target} (cita ${appointment.id})`)
      } catch (error) {
        await finalizeSend({
          reminder,
          appointment,
          status: 'error',
          sentMessageId: getFailedMessageId(error),
          errorMessage: error.message,
          timezone,
          attemptCount: claim.attemptCount,
          previousMessageId: claim.previousMessageId
        })
        errors += 1
        logger.warn(`[Citas] Falló mensaje automático "${reminder.name}" para la cita ${appointment.id}: ${error.message}`)
      }
    }
  }

  return { sent, errors, skipped }
}
