import { DateTime } from 'luxon'
import crypto from 'node:crypto'
import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { DEFAULT_TIMEZONE, normalizeToUtcIso, getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import {
  isRistakContactId,
  linkContactToGhl,
  generateContactId,
  // (GCAL-006) Reutilizamos los helpers de identidad de contacto para enlazar/crear
  // contacto a partir de un evento entrante de Google, sin duplicar lógica.
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert,
  finalizePreparedPhoneUpsert
} from './contactIdentityService.js'
import {
  COUNTRY_OPTIONS,
  getAccountLocaleSettings,
  getCountryDefaults,
  getPhoneCountryOptions,
  normalizePhoneForAccount
} from '../utils/accountLocale.js' // (GCAL-006)
import GHLClient from './ghlClient.js'
import * as highlevelCalendarService from './highlevelCalendarService.js'
import { getCalendarPublicBaseUrlStatus } from './sitesService.js'
import { hasFeature } from './licenseService.js'
import { isPaymentGateEnabled, normalizePaymentGateConfig } from './publicPaymentGateService.js'
import { hasConnectedMetaDatasetConfig } from './metaAdsService.js'
import { createEntityId, generateShortId } from '../utils/idGenerator.js'
import { formatContactName, splitContactName } from '../utils/contactNameFormatter.js'
import { getConversationalTestMode } from '../agents/conversational/nativeRuntimeConfig.js'
import { hashPaginationCursorScope } from '../utils/paginationCursorScope.js'

const LOCAL_CALENDAR_PREFIX = 'rstk_cal'
const LOCAL_APPOINTMENT_PREFIX = 'rstk_appt'
const DEFAULT_EVENT_COLOR = '#3b82f6'
const DEFAULT_CALENDAR_OPEN_HOURS = [
  {
    daysOfTheWeek: [1, 2, 3, 4, 5],
    hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
  }
]
const DEFAULT_BOOKING_COMPLETION_MESSAGE = 'Listo. Tu cita quedo agendada.'
const DEFAULT_CALENDAR_META_EVENT_NAME = 'Schedule'
const DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const CALENDAR_CUSTOM_EVENT_CHANNELS = new Set(['site', 'whatsapp', 'messenger', 'instagram', 'smart'])
const APPOINTMENT_BOOKING_CHANNELS = new Set(['whatsapp', 'whatsapp_qr', 'messenger', 'instagram', 'email'])
const APPOINTMENT_PARTICIPANT_ROLES = new Set(['requester', 'primary_attendee', 'guest'])
const TEST_APPOINTMENT_PROVIDER_RECEIPT_PROVIDERS = new Set(['google', 'highlevel'])
const HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER = '[remote_outcome_unknown]'
const MAX_APPOINTMENT_PARTICIPANTS = 25
const CALENDAR_BOOKING_LAYOUTS = new Set(['classic', 'compact', 'stacked'])
const CALENDAR_BOOKING_FONT_FAMILIES = new Set(['system', 'modern', 'serif', 'mono'])
const CALENDAR_BOOKING_WIDGET_THEMES = new Set(['ristak', 'night', 'agenda', 'minimal'])
const DEFAULT_CALENDAR_BOOKING_DISPLAY_COLORS = {
  accent: DEFAULT_EVENT_COLOR,
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  controlBg: '#ffffff',
  slotBg: '#ffffff',
  slotText: DEFAULT_EVENT_COLOR,
  selectedText: '#ffffff',
  fieldBg: '#ffffff',
  fieldText: '#1f2937',
  fieldBorder: '#e5e7eb',
  buttonText: '#ffffff'
}
const CALENDAR_SITE_META_EVENTS = new Set([
  'Lead',
  'Schedule',
  'Purchase',
  'FormSubmitted',
  'ViewContent',
  'CompleteRegistration',
  'Contact',
  'SubmitApplication',
  'Subscribe',
  'StartTrial'
])
const GOOGLE_CALENDAR_CONFIG_KEY = 'google_calendar_service_account_config'
const DEFAULT_RISTAK_CALENDAR_NAME = 'calendario ristak'
const DEFAULT_RISTAK_CALENDAR_DESC = 'calendario principal creado en ristak'
const DEFAULT_LOCAL_CALENDAR_ID = 'rstk_cal_default'
const DEFAULT_LOCAL_CALENDAR_LOCK_KEY = 'ristak-default-local-calendar'
const DEFAULT_CALENDAR_CONFIG_KEY = 'default_calendar_id'
const ATTRIBUTION_CALENDAR_IDS_CONFIG_KEY = 'attribution_calendar_ids'
const SOURCE_PREFERENCE_CONFIG_KEY = 'calendar_source_preference'
export const CALENDAR_FORMS_FOLDER_ID = 'system-calendar-forms'
export const CALENDAR_DEFAULT_FORM_SITE_ID = 'system-calendar-booking-form'
const CALENDAR_DEFAULT_FORM_SLUG = 'system-calendar-booking-form'
const CALENDAR_DEFAULT_PAGE_ID = 'page-1'
const CALENDAR_FORM_THANK_YOU_PAGE_ID = 'page-2'
const CALENDAR_FORM_DISQUALIFIED_PAGE_ID = 'page-3'
const CALENDAR_FORM_FINAL_PAGE_IDS = new Set([CALENDAR_FORM_THANK_YOU_PAGE_ID, CALENDAR_FORM_DISQUALIFIED_PAGE_ID])
const CALENDAR_FORM_FIELD_TYPES = new Set([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])
// (CAL-CONTENT) Bloques de CONTENIDO (no-campos) que también se muestran en el formulario del
// calendario: título, subtítulo, texto, imagen y video. Mismo origen (Sitios) que los campos.
const CALENDAR_FORM_CONTENT_BLOCK_TYPES = new Set(['title', 'subtitle', 'text', 'image', 'video', 'payment'])
const CALENDAR_FORM_ALL_BLOCK_TYPES = new Set([...CALENDAR_FORM_FIELD_TYPES, ...CALENDAR_FORM_CONTENT_BLOCK_TYPES])
const CALENDAR_SLUG_MAX_LENGTH = 80
const DEFAULT_CALENDAR_PHONE_LOCALE = { countryCode: 'MX', dialCode: '52' }
const UPCOMING_APPOINTMENTS_DEFAULT_LIMIT = 20
const UPCOMING_APPOINTMENTS_MAX_LIMIT = 100
const UPCOMING_APPOINTMENTS_CURSOR_KIND = 'upcoming-appointments'
const VISIBLE_APPOINTMENTS_DEFAULT_LIMIT = 100
const VISIBLE_APPOINTMENTS_MAX_LIMIT = 200
const VISIBLE_APPOINTMENTS_CURSOR_KIND = 'visible-appointments'
const MONTH_APPOINTMENT_PREVIEW_DEFAULT_LIMIT = 3
const MONTH_APPOINTMENT_PREVIEW_MAX_LIMIT = 5
const APPOINTMENTS_OVERVIEW_DEFAULT_LIMIT = 5
const APPOINTMENTS_OVERVIEW_MAX_LIMIT = 20
const isPostgresDatabase = databaseDialect === 'postgres'
let defaultLocalCalendarBootstrapPromise = null

export function createDefaultCalendarOpenHours() {
  return DEFAULT_CALENDAR_OPEN_HOURS.map(schedule => ({
    daysOfTheWeek: [...schedule.daysOfTheWeek],
    hours: schedule.hours.map(hours => ({ ...hours }))
  }))
}

function makeId(prefix) {
  return createEntityId(prefix)
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function cleanSnapshot(value, maxLength) {
  return cleanString(value).slice(0, maxLength)
}

function normalizeParticipantEmail(value) {
  const email = cleanSnapshot(value, 254).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function normalizeTestFlag(value) {
  if (value === true || value === 1) return true
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(cleanString(value).toLowerCase())
}

function validateAppointmentParticipantInputs(participants = []) {
  if (!Array.isArray(participants)) return
  if (participants.length > MAX_APPOINTMENT_PARTICIPANTS) {
    const error = new Error(`Una cita admite hasta ${MAX_APPOINTMENT_PARTICIPANTS} participantes`)
    error.status = 400
    error.code = 'too_many_appointment_participants'
    throw error
  }

  const singularRoles = new Set()
  for (const raw of participants) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const role = cleanString(raw.role || raw.participantRole || raw.participant_role).toLowerCase()
    if (!APPOINTMENT_PARTICIPANT_ROLES.has(role)) {
      const error = new Error('El rol de un participante no es válido')
      error.status = 400
      error.code = 'invalid_appointment_participant_role'
      throw error
    }
    if (role !== 'guest') {
      if (singularRoles.has(role)) {
        const error = new Error(`La cita sólo admite un participante con rol ${role}`)
        error.status = 400
        error.code = 'duplicate_appointment_participant_role'
        throw error
      }
      singularRoles.add(role)
    }

    const rawEmail = cleanString(raw.email)
    if (rawEmail && !normalizeParticipantEmail(rawEmail)) {
      const error = new Error('El correo de un participante no es válido')
      error.status = 400
      error.code = 'invalid_appointment_participant_email'
      throw error
    }
  }
}

export function normalizeAppointmentParticipants(participants = []) {
  if (!Array.isArray(participants)) return []

  const rolePositions = new Map()
  const seenByRole = new Set()
  const normalized = []

  for (const raw of participants.slice(0, MAX_APPOINTMENT_PARTICIPANTS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    const role = cleanString(raw.role || raw.participantRole || raw.participant_role).toLowerCase()
    if (!APPOINTMENT_PARTICIPANT_ROLES.has(role)) continue
    if (role !== 'guest' && normalized.some(participant => participant.role === role)) continue

    const contactId = cleanSnapshot(raw.contactId || raw.contact_id, 160) || null
    const name = cleanSnapshot(raw.name || raw.fullName || raw.full_name || raw.displayName, 200)
    const phone = cleanSnapshot(raw.phone || raw.phoneNumber || raw.phone_number, 50)
    const email = normalizeParticipantEmail(raw.email)
    const relation = cleanSnapshot(raw.relation || raw.relationship, 120)
    if (!contactId && !name && !phone && !email) continue

    const identity = `${role}:${contactId || ''}:${email}:${phone}:${name.toLowerCase()}`
    if (seenByRole.has(identity)) continue
    seenByRole.add(identity)

    const position = rolePositions.get(role) || 0
    rolePositions.set(role, position + 1)
    normalized.push({
      role,
      position,
      contactId,
      name,
      phone,
      email,
      relation
    })
  }

  return normalized
}

function normalizeAppointmentBookingChannel(value) {
  const channel = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (!channel) return null
  if (channel.includes('whatsapp_qr') || channel === 'qr' || channel.includes('baileys') || channel.includes('bailey')) return 'whatsapp_qr'
  if (channel.includes('whatsapp') || channel === 'wa' || channel.includes('waba') || channel.includes('ycloud')) return 'whatsapp'
  if (channel.includes('instagram') || channel === 'ig' || channel === 'instagram_dm') return 'instagram'
  if (channel.includes('messenger') || channel.includes('facebook') || channel === 'fb') return 'messenger'
  if (channel.includes('email') || channel.includes('correo') || channel === 'mail') return 'email'
  return APPOINTMENT_BOOKING_CHANNELS.has(channel) ? channel : null
}

function normalizePhoneDialCode(value) {
  return cleanString(value).replace(/\D/g, '').slice(0, 4)
}

function getCalendarPhoneCountryOption(countryCode) {
  const normalized = cleanString(countryCode).toUpperCase()
  return COUNTRY_OPTIONS.find(country => country.value === normalized) || null
}

function getCalendarPhoneCountryOptionByDialCode(dialCode) {
  const normalized = normalizePhoneDialCode(dialCode)
  return COUNTRY_OPTIONS.find(country => country.dialCode === normalized) || null
}

function normalizeCalendarPhoneLocale(locale = {}) {
  const dialCode = normalizePhoneDialCode(locale.dialCode || locale.dial_code)
  const country = getCalendarPhoneCountryOption(locale.countryCode || locale.country_code || locale.country)
    || getCalendarPhoneCountryOptionByDialCode(dialCode)
    || getCountryDefaults(DEFAULT_CALENDAR_PHONE_LOCALE.countryCode)

  return {
    countryCode: country.value,
    dialCode: dialCode || country.dialCode || DEFAULT_CALENDAR_PHONE_LOCALE.dialCode
  }
}

async function getCalendarPhoneLocale() {
  return normalizeCalendarPhoneLocale(
    await getAccountLocaleSettings().catch(() => DEFAULT_CALENDAR_PHONE_LOCALE)
  )
}

function applyCalendarPhoneLocaleDefaults(field = {}, phoneLocale = DEFAULT_CALENDAR_PHONE_LOCALE) {
  if (field.blockType !== 'phone') return field

  const settings = field.settings && typeof field.settings === 'object' && !Array.isArray(field.settings)
    ? field.settings
    : {}
  const locale = normalizeCalendarPhoneLocale({
    countryCode: settings.defaultCountryCode || settings.countryCode || phoneLocale.countryCode,
    dialCode: settings.defaultDialCode || settings.dialCode || phoneLocale.dialCode
  })

  return {
    ...field,
    settings: {
      ...settings,
      phoneCountrySelectorEnabled: settings.phoneCountrySelectorEnabled ?? true,
      defaultCountryCode: cleanString(settings.defaultCountryCode || settings.countryCode || locale.countryCode).toUpperCase(),
      defaultDialCode: normalizePhoneDialCode(settings.defaultDialCode || settings.dialCode || locale.dialCode)
    }
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === '') return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const normalized = cleanString(value).toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled', 'activo'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled', 'inactivo'].includes(normalized)) return false
  return defaultValue
}

function isSafeCssColor(value) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return false
  if (raw === 'transparent') return true
  if (/^#[0-9a-f]{6}$/i.test(raw)) return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const channels = match.slice(1, 4).map(Number)
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1
}

function safeCssColor(value, fallback) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(255, 255, 255, 0)'
  return isSafeCssColor(raw) ? raw : fallback
}

function safeCssNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(cleanString(value))
  if (!match) return null
  const int = parseInt(match[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

function rgbToHex({ r, g, b }) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function colorLuminance(rgb) {
  const transform = (value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * transform(rgb.r) + 0.7152 * transform(rgb.g) + 0.0722 * transform(rgb.b)
}

function mixHexColors(fromHex, toHex, ratio) {
  const from = parseHexColor(fromHex)
  const to = parseHexColor(toHex)
  if (!from || !to) return fromHex
  return rgbToHex({
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio
  })
}

// Elige el color de texto (oscuro o claro) que da mayor contraste sobre `hex`,
// comparando la relación de contraste real WCAG en vez de un umbral fijo.
function readableTextOn(hex, darkText = '#111827', lightText = '#ffffff') {
  const rgb = parseHexColor(hex)
  if (!rgb) return darkText
  const base = colorLuminance(rgb)
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const darkRgb = parseHexColor(darkText)
  const lightRgb = parseHexColor(lightText)
  const darkContrast = contrast(base, darkRgb ? colorLuminance(darkRgb) : 0)
  const lightContrast = contrast(base, lightRgb ? colorLuminance(lightRgb) : 1)
  return darkContrast >= lightContrast ? darkText : lightText
}

// Texto sobre el color de acento (botones, día/horario seleccionado). Los acentos
// de marca (azul, rojo, violeta) conservan texto blanco; solo los acentos claros
// (ámbar, verde, lima, cian) usan texto oscuro para mantener legibilidad.
function onAccentText(hex) {
  const rgb = parseHexColor(hex)
  if (!rgb) return '#ffffff'
  return colorLuminance(rgb) > 0.42 ? '#111827' : '#ffffff'
}

// Deriva la paleta completa del widget a partir de solo dos colores: el acento
// (bolita seleccionada, fechas, horarios, botones) y el fondo. El resto de colores
// (texto, superficie, líneas, campos) se calculan para mantener contraste y se
// invierten automáticamente cuando el fondo es claro u oscuro.
function deriveCalendarBookingPalette(accentInput, backgroundInput) {
  const accent = safeCssColor(accentInput, DEFAULT_EVENT_COLOR)
  const background = safeCssColor(backgroundInput, DEFAULT_CALENDAR_BOOKING_DISPLAY_COLORS.background)
  const text = readableTextOn(background, '#111827', '#f8fafc')
  const isDark = text !== '#111827'
  const muted = isDark ? mixHexColors(text, background, 0.42) : '#6b7280'
  const surface = isDark ? mixHexColors(background, '#ffffff', 0.08) : '#ffffff'
  const line = isDark ? mixHexColors(background, '#ffffff', 0.16) : '#e5e7eb'
  const onAccent = onAccentText(accent)
  return {
    accent,
    background,
    surface,
    text,
    muted,
    line,
    controlBg: surface,
    slotBg: surface,
    slotText: accent,
    selectedText: onAccent,
    fieldBg: surface,
    fieldText: text,
    fieldBorder: line,
    buttonText: onAccent
  }
}

function normalizeCalendarEmbedLayout(value) {
  const raw = cleanString(value).toLowerCase()
  return ['classic', 'compact', 'stacked'].includes(raw) ? raw : 'classic'
}

function getCalendarBookingFontStack(value) {
  const family = normalizeCalendarBookingFontFamily(value)
  if (family === 'modern') return '"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
  if (family === 'serif') return 'Georgia,"Times New Roman",serif'
  if (family === 'mono') return '"SFMono-Regular","Roboto Mono","Cascadia Code",monospace'
  return '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
}

function safeCalendarImageUrl(value, fallback = '') {
  const raw = cleanString(value || fallback)
  if (!raw) return ''
  if (/^\/(?!\/)/.test(raw)) return raw
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function toInt(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function calendarDurationToMinutes(value, unit = 'mins', fallback = 60) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return Math.max(1, Number(fallback) || 60)
  const normalizedUnit = cleanString(unit || 'mins').toLowerCase()
  if (['hour', 'hours', 'hr', 'hrs', 'hora', 'horas'].includes(normalizedUnit)) return amount * 60
  if (['day', 'days', 'día', 'días', 'dia', 'dias'].includes(normalizedUnit)) return amount * 24 * 60
  if (['week', 'weeks', 'semana', 'semanas'].includes(normalizedUnit)) return amount * 7 * 24 * 60
  if (['second', 'seconds', 'sec', 'secs', 'segundo', 'segundos'].includes(normalizedUnit)) {
    return Math.max(1, Math.ceil(amount / 60))
  }
  return amount
}

function addCalendarRuleDuration(dateTime, value, unit) {
  const amount = Number(value)
  if (!dateTime?.isValid || !Number.isFinite(amount) || amount <= 0) return dateTime
  const normalizedUnit = cleanString(unit).toLowerCase()
  if (['month', 'months', 'mes', 'meses'].includes(normalizedUnit)) return dateTime.plus({ months: amount })
  if (['week', 'weeks', 'semana', 'semanas'].includes(normalizedUnit)) return dateTime.plus({ weeks: amount })
  if (['day', 'days', 'día', 'días', 'dia', 'dias'].includes(normalizedUnit)) return dateTime.plus({ days: amount })
  if (['minute', 'minutes', 'min', 'mins', 'minuto', 'minutos'].includes(normalizedUnit)) return dateTime.plus({ minutes: amount })
  return dateTime.plus({ hours: amount })
}

function getCalendarBookingWindow(calendar, zone, currentTimeMs = Date.now()) {
  const now = DateTime.fromMillis(Number(currentTimeMs), { zone })
  if (!now.isValid) return { nowMs: Date.now(), earliestStartMs: Date.now(), latestStartMs: null }

  const earliest = addCalendarRuleDuration(
    now,
    calendar.allowBookingAfter,
    calendar.allowBookingAfterUnit || 'hours'
  )
  const horizonAmount = Number(calendar.allowBookingFor)
  const latest = Number.isFinite(horizonAmount) && horizonAmount > 0
    ? addCalendarRuleDuration(now, horizonAmount, calendar.allowBookingForUnit || 'days')
    : null

  return {
    nowMs: now.toMillis(),
    earliestStartMs: earliest.toMillis(),
    latestStartMs: latest?.isValid ? latest.toMillis() : null
  }
}

function toBoolInt(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value ? 1 : 0
  return ['1', 'true', 'yes', 'on', 'active'].includes(String(value).trim().toLowerCase()) ? 1 : 0
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

function applyConnectedMetaDefaultsToCalendarRawJson(rawJson = {}) {
  const source = rawJson && typeof rawJson === 'object' && !Array.isArray(rawJson)
    ? rawJson
    : {}
  const customEvents = normalizeCalendarCustomEventsConfig(
    source.customEvents ||
    source.custom_events ||
    source.metaEvent ||
    source.meta_event ||
    {}
  )

  return {
    ...source,
    customEvents: {
      ...customEvents,
      enabled: true,
      eventName: customEvents.eventName || DEFAULT_CALENDAR_META_EVENT_NAME
    }
  }
}

function normalizeCalendarBookingDefaultFields(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const phoneEnabled = source.phoneEnabled ?? source.phone?.enabled ?? source.phone !== false
  const emailEnabled = source.emailEnabled ?? source.email?.enabled ?? source.email !== false
  const hasContactChannel = Boolean(phoneEnabled || emailEnabled)

  return {
    name: { enabled: true, required: true },
    phone: {
      enabled: hasContactChannel ? Boolean(phoneEnabled) : true,
      required: hasContactChannel ? Boolean(phoneEnabled) : true
    },
    email: {
      enabled: Boolean(emailEnabled),
      required: Boolean(emailEnabled)
    },
    notes: {
      // Apagado por defecto: solo prendido si el calendario lo guardó explícitamente.
      enabled: source.notesEnabled ?? source.notes?.enabled ?? false,
      required: false
    }
  }
}

export function normalizeCalendarBookingFormConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const formSource = source.bookingForm && typeof source.bookingForm === 'object'
    ? source.bookingForm
    : source.booking_form && typeof source.booking_form === 'object'
      ? source.booking_form
      : source
  const useCustomForm = Boolean(
    formSource.useCustomForm ??
    formSource.use_custom_form ??
    formSource.customFormEnabled ??
    formSource.custom_form_enabled
  )
  const customFormId = cleanString(
    formSource.customFormId ||
    formSource.custom_form_id ||
    formSource.formSiteId ||
    formSource.form_site_id ||
    formSource.formId ||
    formSource.form_id
  )

  return {
    useCustomForm: Boolean(useCustomForm && customFormId),
    customFormId,
    defaultFields: normalizeCalendarBookingDefaultFields(
      formSource.defaultFields ||
      formSource.default_fields ||
      formSource
    )
  }
}

async function canUseCalendarCustomForms() {
  return (await hasFeature('forms')) && (await hasFeature('sites'))
}

export function normalizeCalendarBookingCompletionConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const completionSource = source.bookingCompletion && typeof source.bookingCompletion === 'object'
    ? source.bookingCompletion
    : source.booking_completion && typeof source.booking_completion === 'object'
      ? source.booking_completion
      : source
  const action = cleanString(
    completionSource.action ||
    completionSource.bookingCompletionAction ||
    completionSource.booking_completion_action ||
    completionSource.type
  ).toLowerCase()
  const message = cleanString(
    completionSource.message ||
    completionSource.successMessage ||
    completionSource.success_message ||
    completionSource.thankYouMessage ||
    completionSource.thank_you_message
  )
  const redirectUrl = cleanString(
    completionSource.redirectUrl ||
    completionSource.redirect_url ||
    completionSource.url
  )

  return {
    action: action === 'redirect' && redirectUrl ? 'redirect' : 'message',
    message: message || DEFAULT_BOOKING_COMPLETION_MESSAGE,
    redirectUrl
  }
}

function normalizeCalendarBookingLayout(value) {
  const raw = cleanString(value).toLowerCase()
  return CALENDAR_BOOKING_LAYOUTS.has(raw) ? raw : 'classic'
}

function normalizeCalendarBookingFontFamily(value) {
  const raw = cleanString(value).toLowerCase()
  return CALENDAR_BOOKING_FONT_FAMILIES.has(raw) ? raw : 'system'
}

function normalizeCalendarBookingWidgetTheme(value) {
  const raw = cleanString(value).toLowerCase()
  return CALENDAR_BOOKING_WIDGET_THEMES.has(raw) ? raw : 'ristak'
}

function normalizeCalendarBookingPaymentPosition(value) {
  return cleanString(value).toLowerCase() === 'before_form' ? 'before_form' : 'after_form'
}

function normalizeCalendarBookingDisplayConfig(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const displaySource = source.bookingDisplay && typeof source.bookingDisplay === 'object'
    ? source.bookingDisplay
    : source.booking_display && typeof source.booking_display === 'object'
      ? source.booking_display
      : source.publicDisplay && typeof source.publicDisplay === 'object'
        ? source.publicDisplay
        : source.public_display && typeof source.public_display === 'object'
          ? source.public_display
          : source
  const colorSource = displaySource.colors && typeof displaySource.colors === 'object'
    ? displaySource.colors
    : {}
  const fallbackAccent = safeCssColor(
    fallback.accent || fallback.eventColor || fallback.event_color || source.eventColor || source.event_color,
    DEFAULT_EVENT_COLOR
  )
  const pickColor = (key, ...aliases) => safeCssColor(
    [colorSource[key], ...aliases.map(alias => colorSource[alias]), displaySource[key], ...aliases.map(alias => displaySource[alias])]
      .find(value => value !== undefined && value !== null && value !== ''),
    DEFAULT_CALENDAR_BOOKING_DISPLAY_COLORS[key]
  )
  const defaultTimezone = cleanString(
    displaySource.defaultTimezone ||
    displaySource.default_timezone ||
    displaySource.timezone ||
    displaySource.timeZone
  )

  return {
    showSidebar: parseBoolean(displaySource.showSidebar ?? displaySource.show_sidebar, true),
    showIcon: parseBoolean(displaySource.showIcon ?? displaySource.show_icon, true),
    showEventTitle: parseBoolean(displaySource.showEventTitle ?? displaySource.show_event_title, true),
    showCalendarName: parseBoolean(displaySource.showCalendarName ?? displaySource.show_calendar_name, true),
    showDescription: parseBoolean(displaySource.showDescription ?? displaySource.show_description, true),
    showDuration: parseBoolean(displaySource.showDuration ?? displaySource.show_duration, true),
    showConfirmation: parseBoolean(displaySource.showConfirmation ?? displaySource.show_confirmation, true),
    layout: normalizeCalendarBookingLayout(displaySource.layout),
    widgetTheme: normalizeCalendarBookingWidgetTheme(displaySource.widgetTheme || displaySource.widget_theme),
    fontFamily: normalizeCalendarBookingFontFamily(displaySource.fontFamily || displaySource.font_family),
    allowTimezoneSelection: parseBoolean(displaySource.allowTimezoneSelection ?? displaySource.allow_timezone_selection, true),
    defaultTimezone: defaultTimezone && isValidTimezone(defaultTimezone) ? defaultTimezone : '',
    // (CAL-FLOW) Orden del flujo: 'after' (default) = calendario y luego formulario; 'before' =
    // primero el formulario (con su calificación) y al completarlo aparece el calendario.
    formPosition: cleanString(displaySource.formPosition || displaySource.form_position).toLowerCase() === 'before' ? 'before' : 'after',
    paymentPosition: normalizeCalendarBookingPaymentPosition(displaySource.paymentPosition || displaySource.payment_position),
    colors: deriveCalendarBookingPalette(
      fallbackAccent,
      pickColor('background', 'backgroundColor', 'background_color')
    )
  }
}

function normalizeCalendarCustomEventParameterKey(value = '') {
  const key = cleanString(value)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)

  if (!key) return ''
  return /^[a-zA-Z_]/.test(key) ? key : `param_${key}`
}

function normalizeCalendarCustomEventParameters(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const normalized = {}
  ;[
    'value',
    'predictedLtv',
    'currency',
    'status',
    'contentName',
    'contentCategory',
    'contentIds',
    'contentType',
    'numItems',
    'orderId'
  ].forEach(key => {
    const snakeKey = key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)
    const parameterValue = cleanString(source[key] || source[snakeKey])
    if (!parameterValue) return
    normalized[key] = key === 'currency' ? parameterValue.toUpperCase().slice(0, 3) : parameterValue
  })

  const customSource = Array.isArray(source.custom)
    ? source.custom
    : Array.isArray(source.customParameters)
      ? source.customParameters
      : Array.isArray(source.custom_parameters)
        ? source.custom_parameters
        : []

  const custom = customSource
    .map(parameter => ({
      id: cleanString(parameter?.id) || makeId('rstk_meta_param'),
      key: normalizeCalendarCustomEventParameterKey(parameter?.key || parameter?.name),
      value: cleanString(parameter?.value)
    }))
    .filter(parameter => parameter.key || parameter.value)
    .slice(0, 12)

  if (custom.length) normalized.custom = custom

  return normalized
}

export function normalizeCalendarCustomEventsConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const eventSource = source.customEvents && typeof source.customEvents === 'object'
    ? source.customEvents
    : source.custom_events && typeof source.custom_events === 'object'
      ? source.custom_events
      : source.metaEvent && typeof source.metaEvent === 'object'
        ? source.metaEvent
        : source.meta_event && typeof source.meta_event === 'object'
          ? source.meta_event
          : source
  const channelInput = cleanString(
    eventSource.channel ||
    eventSource.conversionChannel ||
    eventSource.conversion_channel ||
    eventSource.source
  ).toLowerCase()
  const channel = CALENDAR_CUSTOM_EVENT_CHANNELS.has(channelInput) ? channelInput : 'site'
  const eventNameInput = cleanString(
    eventSource.eventName ||
    eventSource.event_name ||
    eventSource.metaEventName ||
    eventSource.meta_event_name
  )
  const siteEventName = CALENDAR_SITE_META_EVENTS.has(eventNameInput) ? eventNameInput : DEFAULT_CALENDAR_META_EVENT_NAME
  const whatsappEventName = DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME

  return {
    enabled: parseBoolean(
      eventSource.enabled ??
      eventSource.metaEnabled ??
      eventSource.meta_enabled ??
      eventSource.customEventsEnabled ??
      eventSource.custom_events_enabled,
      false
    ),
    channel,
    eventName: ['whatsapp', 'messenger', 'instagram'].includes(channel) ? whatsappEventName : siteEventName,
    parameters: normalizeCalendarCustomEventParameters(
      eventSource.parameters ||
      eventSource.eventParameters ||
      eventSource.event_parameters ||
      eventSource.metaEventParameters ||
      eventSource.meta_event_parameters ||
      {}
    )
  }
}

function getCalendarRawJsonWithBookingForm(calendar = {}, options = {}) {
  const rawSource = options.rawJson || calendar.raw_json || calendar.rawJson || {}
  const parsedRaw = parseJson(rawSource, {})
  const baseRaw = parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw) ? parsedRaw : {}
  const firstDefined = (...values) => values.find(value => value !== undefined)

  return {
    ...baseRaw,
    googleCalendarId: cleanString(firstDefined(
      calendar.googleCalendarId,
      calendar.google_calendar_id,
      baseRaw.googleCalendarId,
      baseRaw.google_calendar_id
    )),
    googleAccessRole: cleanString(firstDefined(
      calendar.googleAccessRole,
      calendar.google_access_role,
      calendar.accessRole,
      calendar.access_role,
      baseRaw.googleAccessRole,
      baseRaw.google_access_role,
      baseRaw.accessRole,
      baseRaw.access_role
    )),
    googleCalendarSummary: cleanString(firstDefined(
      calendar.googleCalendarSummary,
      calendar.google_calendar_summary,
      calendar.summary,
      baseRaw.googleCalendarSummary,
      baseRaw.google_calendar_summary,
      baseRaw.summary
    )),
    googleCalendarTimeZone: cleanString(firstDefined(
      calendar.googleCalendarTimeZone,
      calendar.google_calendar_time_zone,
      calendar.timeZone,
      calendar.time_zone,
      baseRaw.googleCalendarTimeZone,
      baseRaw.google_calendar_time_zone,
      baseRaw.timeZone,
      baseRaw.time_zone
    )),
    bookingForm: normalizeCalendarBookingFormConfig(
      calendar.bookingForm ||
      calendar.booking_form ||
      baseRaw.bookingForm ||
      baseRaw.booking_form ||
      calendar
    ),
    bookingCompletion: normalizeCalendarBookingCompletionConfig(
      calendar.bookingCompletion ||
      calendar.booking_completion ||
      baseRaw.bookingCompletion ||
      baseRaw.booking_completion ||
      calendar
    ),
    bookingPayment: normalizePaymentGateConfig(
      calendar.bookingPayment ||
      calendar.booking_payment ||
      baseRaw.bookingPayment ||
      baseRaw.booking_payment ||
      {}
    ),
    bookingDisplay: normalizeCalendarBookingDisplayConfig(
      calendar.bookingDisplay ||
      calendar.booking_display ||
      baseRaw.bookingDisplay ||
      baseRaw.booking_display ||
      calendar,
      { eventColor: calendar.eventColor || calendar.event_color || baseRaw.eventColor || baseRaw.event_color }
    ),
    customEvents: normalizeCalendarCustomEventsConfig(
      calendar.customEvents ||
      calendar.custom_events ||
      calendar.metaEvent ||
      calendar.meta_event ||
      baseRaw.customEvents ||
      baseRaw.custom_events ||
      baseRaw.metaEvent ||
      baseRaw.meta_event ||
      {}
    )
  }
}

function parseConfigArray(value, fallback = []) {
  const parsed = parseJson(value, fallback)
  if (!Array.isArray(parsed)) return fallback

  const normalized = parsed
    .map(item => cleanString(item))
    .filter(Boolean)

  return [...new Set(normalized)]
}

function normalizeSqlConfigValue(value) {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

async function getAppConfigValue(configKey) {
  const normalizedKey = cleanString(configKey)
  if (!normalizedKey) return null

  const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [normalizedKey])
  return row ? row.config_value : null
}

async function setAppConfigValue(configKey, value) {
  const normalizedKey = cleanString(configKey)
  if (!normalizedKey) return

  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [normalizedKey, normalizeSqlConfigValue(value)])
}

function normalizeCalendarSource(value) {
  const normalized = cleanString(value || '').toLowerCase()

  if (['ghl', 'google', 'ristak'].includes(normalized)) {
    return normalized
  }

  return 'ristak'
}

function normalizeCalendarSourcePreference(value) {
  const normalized = cleanString(value).toLowerCase()
  if (normalized === 'google') return 'combined'
  if (['combined', 'ristak', 'ghl'].includes(normalized)) {
    return normalized
  }
  return 'combined'
}

function isLikelySeedRistakCalendar(calendar = {}) {
  const source = normalizeCalendarSource(calendar.source)
  const id = cleanString(calendar.id)
  const name = cleanString(calendar.name).toLowerCase()
  const description = cleanString(calendar.description).toLowerCase()
  const slug = cleanString(calendar.slug).toLowerCase()

  if (!id.startsWith(LOCAL_CALENDAR_PREFIX) || source !== 'ristak') return false

  return (
    name.includes(DEFAULT_RISTAK_CALENDAR_NAME)
    || description.includes(DEFAULT_RISTAK_CALENDAR_DESC)
    || slug === 'calendario-ristak'
  )
}

function sanitizeCalendarConfigValue(value, fallback = null) {
  if (value === undefined || value === null) return fallback
  return typeof value === 'string' ? value : String(value)
}

async function getConnectedSourceFlags() {
  const [googleConfig, highlevelConfig] = await Promise.all([
    db.get('SELECT config_value FROM app_config WHERE config_key = ?', [GOOGLE_CALENDAR_CONFIG_KEY]),
    db.get('SELECT 1 FROM highlevel_config LIMIT 1')
  ])
  const googleConfigValue = sanitizeCalendarConfigValue(googleConfig?.config_value, '').trim()
  const googleConfigData = parseJson(googleConfigValue, {})
  const googleCalendarId = cleanString(googleConfigData?.calendarId)
  const googleConnected = googleConfigData?.connectionMode === 'oauth' && Boolean(googleConfigData?.refreshTokenEncrypted)

  return {
    google: googleConnected,
    googleCalendarId,
    ghl: Boolean(highlevelConfig)
  }
}

function filterCalendarsByConnection(calendars = []) {
  return calendars.map(calendar => ({
    ...calendar,
    source: normalizeCalendarSource(calendar.source)
  }))
}

function isConfiguredGoogleCalendar(calendar = {}, connectedSources = {}) {
  if (calendar.source !== 'google') return true

  const configuredGoogleCalendarId = cleanString(connectedSources.googleCalendarId).toLowerCase()
  if (!configuredGoogleCalendarId) return true

  return cleanString(calendar.googleCalendarId || calendar.id).toLowerCase() === configuredGoogleCalendarId
}

function pickCalendarByPreference(calendars = [], sourcePreference = 'combined', { includeInactive = false } = {}) {
  const normalizedPreference = normalizeCalendarSourcePreference(sourcePreference)

  const sourceOrder = normalizedPreference === 'ghl'
    ? ['ghl']
    : normalizedPreference === 'google'
      ? ['google']
      : normalizedPreference === 'ristak'
        ? ['ristak']
        : ['ghl', 'google', 'ristak']

  const isUsable = calendar => includeInactive || calendar.isActive !== false

  for (const source of sourceOrder) {
    const calendar = calendars.find(item => item.source === source && isUsable(item))
    if (calendar) return calendar
  }

  if (!includeInactive) {
    return null
  }

  for (const source of sourceOrder) {
    const calendar = calendars.find(item => item.source === source)
    if (calendar) return calendar
  }

  return null
}

function shouldHideSeedCalendarForCombined(calendars = [], connectedSources = { google: false, ghl: false }) {
  return (connectedSources.google || connectedSources.ghl)
    && calendars.some(calendar => ['google', 'ghl'].includes(calendar.source))
}

async function getCalendarAppointmentCounts(calendarIds = []) {
  const ids = [...new Set(calendarIds.map(id => cleanString(id)).filter(Boolean))]
  if (!ids.length) return new Map()

  // Los únicos consumidores preguntan si un calendario semilla está vacío; no
  // necesitan contar todas sus citas. COUNT(*) degradaba GET /calendars de forma
  // lineal con el histórico. EXISTS se detiene en la primera cita visible y usa
  // el índice parcial idx_appointments_upcoming_page.
  const calendarProjection = isPostgresDatabase ? 'CAST(? AS TEXT)' : '?'
  const clauses = ids.map(() => `
    SELECT ${calendarProjection} AS calendar_id
    WHERE EXISTS (
      SELECT 1
      FROM appointments a
      WHERE a.calendar_id = ?
        AND a.start_time IS NOT NULL
        AND a.deleted_at IS NULL
        AND COALESCE(a.sync_status, '') != 'pending_delete'
      LIMIT 1
    )
  `)
  const params = ids.flatMap(id => [id, id])
  const rows = await db.all(clauses.join('\nUNION ALL\n'), params)

  return new Map(rows.map(row => [cleanString(row.calendar_id), 1]))
}

function calendarHasAppointments(calendar = {}, appointmentCounts = new Map()) {
  return toInt(appointmentCounts.get(cleanString(calendar.id)), 0) > 0
}

function isLocallyUsableCalendar(calendar = {}) {
  return Boolean(cleanString(calendar.id)) && calendar.isActive !== false
}

function isEmptySeedRistakCalendar(calendar = {}, appointmentCounts = new Map()) {
  return isLikelySeedRistakCalendar(calendar) && !calendarHasAppointments(calendar, appointmentCounts)
}

export async function reconcileCalendarDefaults({ sourcePreference = null } = {}) {
  await ensureDefaultLocalCalendar()

  const rows = await db.all('SELECT * FROM calendars ORDER BY is_active DESC, LOWER(name) ASC')
  const connectedSources = await getConnectedSourceFlags()
  const calendars = filterCalendarsByConnection(rows.map(calendarRowToApi))
    .filter(calendar => isConfiguredGoogleCalendar(calendar, connectedSources))
  const hasConnectedExternalSources = Boolean(connectedSources.google || connectedSources.ghl)

  if (!calendars.length) {
    return {
      changed: false,
      defaultCalendarId: null,
      previousDefaultCalendarId: null,
      hasExternalCalendars: false
    }
  }

  const preference = normalizeCalendarSourcePreference(sourcePreference || sanitizeCalendarConfigValue(
    await getAppConfigValue(SOURCE_PREFERENCE_CONFIG_KEY),
    'combined'
  ))

  const configuredDefaultCalendarId = sanitizeCalendarConfigValue(await getAppConfigValue(DEFAULT_CALENDAR_CONFIG_KEY), '').trim()
  const configuredDefaultCalendar = configuredDefaultCalendarId
    ? calendars.find(calendar => calendar.id === configuredDefaultCalendarId)
    : null

  const hasExternalCalendars = hasConnectedExternalSources
    && calendars.some(calendar => ['google', 'ghl'].includes(calendar.source))
  let nextDefaultCalendarId = configuredDefaultCalendar?.id || null

  const seedCalendarIds = calendars.filter(isLikelySeedRistakCalendar).map(calendar => calendar.id)
  const appointmentCounts = await getCalendarAppointmentCounts(seedCalendarIds)
  const officialSeedCalendar = calendars.find(calendar => (
    isLikelySeedRistakCalendar(calendar) && calendarHasAppointments(calendar, appointmentCounts)
  ))

  if (hasExternalCalendars && !nextDefaultCalendarId && officialSeedCalendar?.id) {
    nextDefaultCalendarId = officialSeedCalendar.id
  }

  if (hasExternalCalendars && (!nextDefaultCalendarId || isEmptySeedRistakCalendar(configuredDefaultCalendar || {}, appointmentCounts))) {
    const externalPreference = preference === 'google'
      ? 'google'
      : preference === 'ghl'
        ? 'ghl'
        : preference === 'ristak'
          ? 'ristak'
          : 'combined'

    const externalCandidate = pickCalendarByPreference(
      calendars.filter(calendar => ['google', 'ghl'].includes(calendar.source)),
      externalPreference,
      { includeInactive: true }
    ) || pickCalendarByPreference(calendars, externalPreference, { includeInactive: true })

    if (externalCandidate?.id) {
      nextDefaultCalendarId = externalCandidate.id
    }
  }

  if (!hasExternalCalendars) {
    const shouldUseLocalFallback = !nextDefaultCalendarId
      || !isLocallyUsableCalendar(configuredDefaultCalendar)

    if (shouldUseLocalFallback) {
      const localCandidate = calendars.find(calendar => isLikelySeedRistakCalendar(calendar))
        || calendars.find(calendar => calendar.source === 'ristak')
        || calendars[0]

      nextDefaultCalendarId = localCandidate?.id || null
    }
  }

  const updates = {}
  if (nextDefaultCalendarId && nextDefaultCalendarId !== configuredDefaultCalendarId) {
    updates.default_calendar_id = nextDefaultCalendarId
  }

  if (Object.keys(updates).length > 0) {
    await setAppConfigValue(DEFAULT_CALENDAR_CONFIG_KEY, updates.default_calendar_id)

    const attributionRaw = await getAppConfigValue(ATTRIBUTION_CALENDAR_IDS_CONFIG_KEY)
    const attributionIds = parseConfigArray(attributionRaw)
    if (!attributionIds.length) {
      await setAppConfigValue(ATTRIBUTION_CALENDAR_IDS_CONFIG_KEY, [updates.default_calendar_id])
    }
  }

  return {
    changed: Object.keys(updates).length > 0,
    defaultCalendarId: nextDefaultCalendarId,
    previousDefaultCalendarId: configuredDefaultCalendarId,
    hasExternalCalendars,
    sourcePreference: preference
  }
}

function jsonOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function slugify(value, fallback = '') {
  const raw = cleanString(value || fallback || 'calendario')
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CALENDAR_SLUG_MAX_LENGTH) || `calendario-${Date.now()}`
}

function calendarSlugIdSuffix(calendarId = '') {
  return cleanString(calendarId)
    .replace(new RegExp(`^${LOCAL_CALENDAR_PREFIX}_?`, 'i'), '')
    .replace(/[^a-z0-9]+/gi, '')
    .slice(0, 8)
    .toLowerCase()
}

function normalizeSlugSuffix(value = '') {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16)
}

function appendCalendarSlugSuffix(baseSlug, suffix) {
  const normalizedBase = slugify(baseSlug)
  const normalizedSuffix = normalizeSlugSuffix(suffix)
  if (!normalizedSuffix) return normalizedBase
  if (normalizedBase.endsWith(`-${normalizedSuffix}`)) return normalizedBase

  const maxBaseLength = Math.max(1, CALENDAR_SLUG_MAX_LENGTH - normalizedSuffix.length - 1)
  const truncatedBase = normalizedBase
    .slice(0, maxBaseLength)
    .replace(/-+$/g, '') || 'calendario'

  return `${truncatedBase}-${normalizedSuffix}`.slice(0, CALENDAR_SLUG_MAX_LENGTH)
}

async function publicCalendarSlugExists(candidateSlug, calendarId) {
  const slug = cleanString(candidateSlug)
  if (!slug) return false

  const row = await db.get(`
    SELECT id
    FROM calendars
    WHERE id != ?
      AND COALESCE(source, 'ristak') IN ('ristak', 'ghl')
      AND (
        LOWER(COALESCE(slug, '')) = LOWER(?)
        OR LOWER(COALESCE(widget_slug, '')) = LOWER(?)
      )
    LIMIT 1
  `, [calendarId, slug, slug])

  return Boolean(row)
}

async function ensureUniqueRistakPublicSlug(value, calendarId) {
  const baseSlug = slugify(value, calendarId)
  const idSuffix = calendarSlugIdSuffix(calendarId)
  let candidate = baseSlug
  let attempt = 0

  while (await publicCalendarSlugExists(candidate, calendarId)) {
    attempt += 1
    const suffix = attempt === 1
      ? idSuffix || String(attempt + 1)
      : `${idSuffix || 'cal'}${attempt + 1}`
    candidate = appendCalendarSlugSuffix(baseSlug, suffix)

    if (attempt > 25) {
      candidate = appendCalendarSlugSuffix(baseSlug, generateShortId(8))
      break
    }
  }

  return candidate
}

function decodeSegment(value) {
  try {
    return cleanString(decodeURIComponent(String(value || '')))
  } catch {
    return cleanString(value)
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function publicCalendarSlug(calendar = {}) {
  return cleanString(calendar.slug || calendar.widgetSlug || calendar.id) || slugify(calendar.name || calendar.id)
}

function publicCalendarPath(calendar = {}) {
  return `/calendar/${encodeURIComponent(publicCalendarSlug(calendar))}`
}

export async function getCalendarPublicUrlStatus() {
  return getCalendarPublicBaseUrlStatus()
}

export function attachPublicCalendarUrl(calendar = {}, status = null) {
  const path = publicCalendarPath(calendar)
  const enabled = Boolean(status?.enabled && calendar.isActive !== false)
  return {
    ...calendar,
    publicBookingPath: path,
    publicBaseDomain: status?.domain || '',
    publicUrlEnabled: enabled,
    publicUrl: enabled ? `${String(status.baseUrl || `https://${status.domain}`).replace(/\/+$/, '')}${path}` : '',
    publicUrlSource: status?.source || '',
    publicUrlLockedToPublicCalendar: Boolean(status?.lockedToPublicCalendar),
    publicUrlUnavailableReason: calendar.isActive === false
      ? 'Este calendario esta inactivo.'
      : status?.reason || ''
  }
}

export async function attachPublicCalendarUrls(calendars = []) {
  const status = await getCalendarPublicUrlStatus()
  return calendars.map(calendar => attachPublicCalendarUrl(calendar, status))
}

function normalizeTeamMembers(value) {
  const parsed = parseJson(value, value)
  if (!Array.isArray(parsed)) return []

  return parsed
    .map((member, index) => {
      const userId = cleanString(member?.userId || member?.user_id || member?.id || member?.user?.id)
      if (!userId) return null
      return {
        userId,
        priority: Number.isFinite(Number(member.priority)) ? Number(member.priority) : 0.5,
        isPrimary: member.isPrimary !== undefined ? Boolean(member.isPrimary) : index === 0,
        ...(Array.isArray(member.locationConfigurations) ? { locationConfigurations: member.locationConfigurations } : {})
      }
    })
    .filter(Boolean)
}

function normalizeLocationConfigurations(value) {
  const parsed = parseJson(value, value)
  return Array.isArray(parsed) ? parsed : []
}

function normalizeOpenHours(value) {
  const parsed = parseJson(value, value)
  return Array.isArray(parsed) ? parsed : []
}

function calendarAvailabilityRecord(value = {}) {
  return value?.calendar && typeof value.calendar === 'object' ? value.calendar : value
}

function hasExplicitCalendarOpenHours(value = {}) {
  const calendar = calendarAvailabilityRecord(value)
  return Boolean(
    calendar
    && typeof calendar === 'object'
    && (
      Object.prototype.hasOwnProperty.call(calendar, 'openHours')
      || Object.prototype.hasOwnProperty.call(calendar, 'open_hours')
    )
  )
}

function hasExplicitCalendarOverlapSetting(value = {}) {
  const calendar = calendarAvailabilityRecord(value)
  return Boolean(
    calendar
    && typeof calendar === 'object'
    && (
      Object.prototype.hasOwnProperty.call(calendar, 'allowOverlaps')
      || Object.prototype.hasOwnProperty.call(calendar, 'allow_overlaps')
    )
  )
}

function calendarAvailabilityInputError(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_calendar_open_hours'
  return error
}

function calendarOpenIntervalMinuteBounds(interval) {
  return {
    start: interval.openHour * 60 + interval.openMinute,
    end: interval.closeHour * 60 + interval.closeMinute
  }
}

/**
 * Contrato estricto para escrituras desde Configuración/API.
 * Devuelve una entrada canónica por día (0=domingo) y conserva múltiples rangos.
 * Lecturas/importaciones históricas siguen siendo tolerantes y fallan cerrado al
 * calcular slots si el proveedor trae un formato que no se puede interpretar.
 */
export function normalizeCalendarOpenHoursForWrite(value) {
  const parsed = parseJson(value, value)
  if (!Array.isArray(parsed)) {
    throw calendarAvailabilityInputError('La disponibilidad semanal debe ser una lista de días y horarios.')
  }
  if (!parsed.length) return []

  const rangesByDay = new Map()
  for (const schedule of parsed) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
      throw calendarAvailabilityInputError('Hay un día de disponibilidad con formato inválido.')
    }

    const rawDays = Array.isArray(schedule.daysOfTheWeek)
      ? schedule.daysOfTheWeek
      : schedule.day !== undefined
        ? [schedule.day]
        : schedule.dayOfWeek !== undefined
          ? [schedule.dayOfWeek]
          : []
    const normalizedDays = rawDays.map(normalizeWeekDay)
    if (normalizedDays.some(day => day === null)) {
      throw calendarAvailabilityInputError('La disponibilidad contiene un día de la semana inválido.')
    }
    const days = [...new Set(normalizedDays)]
    if (!days.length) {
      throw calendarAvailabilityInputError('Cada horario disponible debe indicar al menos un día válido.')
    }

    const rawHours = Array.isArray(schedule.hours) ? schedule.hours : [schedule]
    if (!rawHours.length) {
      throw calendarAvailabilityInputError('Cada día activo debe tener al menos un rango de horas.')
    }

    const hours = rawHours.map((rawInterval) => {
      const interval = normalizeCalendarOpenInterval(rawInterval, { allowFallback: false })
      if (!interval) {
        throw calendarAvailabilityInputError('Cada rango debe tener una hora inicial y final válidas dentro del mismo día.')
      }
      if (interval.closeHour === 24) {
        throw calendarAvailabilityInputError('La hora final máxima es 11:59 PM para mantener compatibilidad con los calendarios conectados.')
      }
      return interval
    })

    for (const day of days) {
      const current = rangesByDay.get(day) || []
      current.push(...hours.map(interval => ({ ...interval })))
      rangesByDay.set(day, current)
    }
  }

  return [...rangesByDay.entries()]
    .sort(([dayA], [dayB]) => dayA - dayB)
    .map(([day, hours]) => {
      const sorted = hours.sort((a, b) => {
        const boundsA = calendarOpenIntervalMinuteBounds(a)
        const boundsB = calendarOpenIntervalMinuteBounds(b)
        return boundsA.start - boundsB.start || boundsA.end - boundsB.end
      })
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = calendarOpenIntervalMinuteBounds(sorted[index - 1])
        const current = calendarOpenIntervalMinuteBounds(sorted[index])
        if (current.start < previous.end) {
          throw calendarAvailabilityInputError('Los rangos de un mismo día no pueden empalmarse.')
        }
      }
      return { daysOfTheWeek: [day], hours: sorted }
    })
}

function calendarRowToApi(row = {}) {
  const teamMembers = normalizeTeamMembers(row.team_members)
  const locationConfigurations = normalizeLocationConfigurations(row.location_configurations)
  const openHours = normalizeOpenHours(row.open_hours)
  const availabilityScheduleConfigured = Number(row.availability_schedule_configured) === 1 || openHours.length > 0
  const rawJson = parseJson(row.raw_json, {})

  return {
    id: row.id,
    ghlCalendarId: row.ghl_calendar_id || null,
    googleCalendarId: rawJson?.googleCalendarId || rawJson?.google_calendar_id || '',
    googleAccessRole: rawJson?.googleAccessRole || rawJson?.google_access_role || rawJson?.accessRole || rawJson?.access_role || '',
    googleCalendarSummary: rawJson?.googleCalendarSummary || rawJson?.google_calendar_summary || rawJson?.summary || '',
    googleCalendarTimeZone: rawJson?.googleCalendarTimeZone || rawJson?.google_calendar_time_zone || rawJson?.timeZone || rawJson?.time_zone || '',
    googleSyncEnabled: Boolean(rawJson?.googleCalendarId || rawJson?.google_calendar_id),
    locationId: row.location_id || '',
    groupId: row.group_id || undefined,
    name: row.name || 'Calendario',
    description: row.description || '',
    slug: row.slug || '',
    widgetSlug: row.widget_slug || row.slug || '',
    calendarType: row.calendar_type || 'event',
    widgetType: row.widget_type || 'classic',
    eventTitle: row.event_title || row.name || 'Cita',
    eventColor: row.event_color || DEFAULT_EVENT_COLOR,
    isActive: row.is_active !== 0,
    teamMembers,
    locationConfigurations,
    slotDuration: toInt(row.slot_duration, 60),
    slotDurationUnit: row.slot_duration_unit || 'mins',
    slotInterval: toInt(row.slot_interval, toInt(row.slot_duration, 60)),
    slotIntervalUnit: row.slot_interval_unit || 'mins',
    slotBuffer: toInt(row.slot_buffer, 0),
    slotBufferUnit: row.slot_buffer_unit || 'mins',
    preBuffer: toInt(row.pre_buffer, 0),
    preBufferUnit: row.pre_buffer_unit || 'mins',
    appoinmentPerSlot: toInt(row.appoinment_per_slot, 1),
    allowOverlaps: Number(row.allow_overlaps) === 1,
    appoinmentPerDay: toInt(row.appoinment_per_day, 0),
    allowBookingAfter: toInt(row.allow_booking_after, 0),
    allowBookingAfterUnit: row.allow_booking_after_unit || 'hours',
    allowBookingFor: toInt(row.allow_booking_for, 30),
    allowBookingForUnit: row.allow_booking_for_unit || 'days',
    openHours,
    availabilityScheduleConfigured,
    autoConfirm: row.auto_confirm !== 0,
    allowReschedule: row.allow_reschedule !== 0,
    allowCancellation: row.allow_cancellation !== 0,
    notes: row.notes || '',
    bookingForm: normalizeCalendarBookingFormConfig(rawJson.bookingForm || rawJson.booking_form || rawJson),
    bookingCompletion: normalizeCalendarBookingCompletionConfig(rawJson.bookingCompletion || rawJson.booking_completion || rawJson),
    bookingPayment: normalizePaymentGateConfig(rawJson.bookingPayment || rawJson.booking_payment || {}),
    bookingDisplay: normalizeCalendarBookingDisplayConfig(rawJson.bookingDisplay || rawJson.booking_display || rawJson, { eventColor: row.event_color }),
    customEvents: normalizeCalendarCustomEventsConfig(rawJson.customEvents || rawJson.custom_events || rawJson.metaEvent || rawJson.meta_event || {}),
    availabilityType: toInt(row.availability_type, 0),
    antiTrackingEnabled: row.anti_tracking_enabled !== 0,
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncError: row.sync_error || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function normalizeCalendarRecord(raw = {}, options = {}) {
  const calendar = raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : raw
  const source = normalizeCalendarSource(options.source || calendar.source || (calendar.id && !String(calendar.id).startsWith(LOCAL_CALENDAR_PREFIX) ? 'ghl' : 'ristak'))
  const ghlCalendarId = cleanString(options.ghlCalendarId || calendar.ghlCalendarId || calendar.ghl_calendar_id || (source === 'ghl' ? calendar.id : '')) || null
  const id = cleanString(options.id || calendar.localId || calendar.local_id || calendar.ristakCalendarId || calendar.id) ||
    makeId(LOCAL_CALENDAR_PREFIX)
  const name = cleanString(calendar.name || calendar.title || calendar.calendarName || 'Calendario Ristak')
  const slotDuration = toInt(calendar.slotDuration ?? calendar.slot_duration, 60)
  const openHours = normalizeOpenHours(calendar.openHours ?? calendar.open_hours)
  const availabilityScheduleConfigured = toBoolInt(
    calendar.availabilityScheduleConfigured ?? calendar.availability_schedule_configured,
    hasExplicitCalendarOpenHours(calendar) || openHours.length > 0
  )
  const explicitSlug = cleanString(calendar.slug || '')
  const explicitWidgetSlug = cleanString(calendar.widgetSlug || calendar.widget_slug || '')
  const generatedSlug = slugify(name, id)

  const rawJson = getCalendarRawJsonWithBookingForm(calendar, options)
  const hasAntiTrackingInput = Object.prototype.hasOwnProperty.call(calendar, 'antiTrackingEnabled') ||
    Object.prototype.hasOwnProperty.call(calendar, 'anti_tracking_enabled')

  return {
    id,
    ghlCalendarId,
    locationId: cleanString(options.locationId || calendar.locationId || calendar.location_id || ''),
    name,
    description: cleanString(calendar.description || ''),
    slug: explicitSlug || generatedSlug,
    widgetSlug: explicitWidgetSlug || explicitSlug || generatedSlug,
    slugWasExplicit: Boolean(explicitSlug),
    widgetSlugWasExplicit: Boolean(explicitWidgetSlug),
    calendarType: cleanString(calendar.calendarType || calendar.calendar_type || 'event') || 'event',
    widgetType: cleanString(calendar.widgetType || calendar.widget_type || 'classic') || 'classic',
    eventTitle: cleanString(calendar.eventTitle || calendar.event_title || name || 'Cita'),
    eventColor: cleanString(calendar.eventColor || calendar.event_color || DEFAULT_EVENT_COLOR) || DEFAULT_EVENT_COLOR,
    isActive: toBoolInt(calendar.isActive ?? calendar.is_active, true),
    teamMembers: normalizeTeamMembers(calendar.teamMembers || calendar.team_members),
    locationConfigurations: normalizeLocationConfigurations(calendar.locationConfigurations || calendar.location_configurations),
    slotDuration,
    slotDurationUnit: cleanString(calendar.slotDurationUnit || calendar.slot_duration_unit || 'mins') || 'mins',
    slotInterval: toInt(calendar.slotInterval ?? calendar.slot_interval, slotDuration),
    slotIntervalUnit: cleanString(calendar.slotIntervalUnit || calendar.slot_interval_unit || 'mins') || 'mins',
    slotBuffer: toInt(calendar.slotBuffer ?? calendar.slot_buffer, 0),
    slotBufferUnit: cleanString(calendar.slotBufferUnit || calendar.slot_buffer_unit || 'mins') || 'mins',
    preBuffer: toInt(calendar.preBuffer ?? calendar.pre_buffer, 0),
    preBufferUnit: cleanString(calendar.preBufferUnit || calendar.pre_buffer_unit || 'mins') || 'mins',
    appoinmentPerSlot: toInt(
      calendar.appoinmentPerSlot ?? calendar.appoinment_per_slot ?? calendar.appointmentPerSlot,
      1
    ),
    allowOverlaps: toBoolInt(
      calendar.allowOverlaps ?? calendar.allow_overlaps,
      false
    ),
    appoinmentPerDay: toInt(calendar.appoinmentPerDay ?? calendar.appoinment_per_day ?? calendar.appointmentPerDay, 0),
    allowBookingAfter: toInt(calendar.allowBookingAfter ?? calendar.allow_booking_after, 0),
    allowBookingAfterUnit: cleanString(calendar.allowBookingAfterUnit || calendar.allow_booking_after_unit || 'hours') || 'hours',
    allowBookingFor: toInt(calendar.allowBookingFor ?? calendar.allow_booking_for, 30),
    allowBookingForUnit: cleanString(calendar.allowBookingForUnit || calendar.allow_booking_for_unit || 'days') || 'days',
    openHours,
    availabilityScheduleConfigured,
    autoConfirm: toBoolInt(calendar.autoConfirm ?? calendar.auto_confirm, true),
    allowReschedule: toBoolInt(calendar.allowReschedule ?? calendar.allow_reschedule, true),
    allowCancellation: toBoolInt(calendar.allowCancellation ?? calendar.allow_cancellation, true),
    notes: cleanString(calendar.notes || ''),
    availabilityType: toInt(calendar.availabilityType ?? calendar.availability_type, 0),
    antiTrackingEnabled: hasAntiTrackingInput
      ? toBoolInt(calendar.antiTrackingEnabled ?? calendar.anti_tracking_enabled, true)
      : null,
    source,
    syncStatus: options.syncStatus || calendar.syncStatus || calendar.sync_status || (source === 'ghl' ? 'synced' : 'pending'),
    syncError: options.syncError || calendar.syncError || calendar.sync_error || null,
    rawJson: jsonOrNull(rawJson)
  }
}

async function getCalendarByGhlId(ghlCalendarId) {
  if (!ghlCalendarId) return null
  return db.get('SELECT * FROM calendars WHERE ghl_calendar_id = ?', [ghlCalendarId])
}

function googleCalendarIdFromCalendarRecord(calendar = {}) {
  calendar = calendar || {}
  const rawJson = parseJson(calendar.rawJson || calendar.raw_json, {})
  return cleanString(
    calendar.googleCalendarId || calendar.google_calendar_id ||
    rawJson?.googleCalendarId || rawJson?.google_calendar_id
  )
}

function hasExplicitGoogleCalendarLinkInput(calendar = {}, options = {}) {
  const keys = [
    'googleCalendarId', 'google_calendar_id',
    'googleAccessRole', 'google_access_role',
    'googleCalendarSummary', 'google_calendar_summary',
    'googleCalendarTimeZone', 'google_calendar_time_zone'
  ]
  if (keys.some(key => Object.prototype.hasOwnProperty.call(calendar || {}, key))) return true
  const raw = parseJson(calendar?.rawJson || calendar?.raw_json, {})
  const optionsRaw = parseJson(options?.rawJson, {})
  return keys.some(key => (
    Object.prototype.hasOwnProperty.call(raw || {}, key) ||
    Object.prototype.hasOwnProperty.call(optionsRaw || {}, key)
  ))
}

function preserveExistingGoogleCalendarMetadata(normalized = {}, existing = {}) {
  const existingRaw = parseJson(existing?.rawJson || existing?.raw_json, {})
  const normalizedRaw = parseJson(normalized?.rawJson || normalized?.raw_json, {})
  const googleKeys = [
    'googleCalendarId', 'googleAccessRole',
    'googleCalendarSummary', 'googleCalendarTimeZone'
  ]
  const merged = { ...normalizedRaw }
  for (const key of googleKeys) {
    if (existingRaw?.[key] !== undefined) merged[key] = existingRaw[key]
  }
  normalized.rawJson = jsonOrNull(merged)
}

async function assertGoogleCalendarLinkPersistenceSafety({ normalized, existing, allowMutation = false } = {}) {
  const desiredGoogleCalendarId = googleCalendarIdFromCalendarRecord(normalized)
  const existingGoogleCalendarId = googleCalendarIdFromCalendarRecord(existing)
  const linkChanged = desiredGoogleCalendarId.toLowerCase() !== existingGoogleCalendarId.toLowerCase()
  if (linkChanged && !allowMutation) {
    const error = new Error('El vínculo con Google sólo puede cambiarse desde la configuración de sincronización del calendario.')
    error.status = 409
    error.code = 'google_calendar_link_requires_sync_route'
    throw error
  }
  if (!desiredGoogleCalendarId) return

  const rows = await db.all('SELECT id, raw_json FROM calendars')
  const conflictingOwner = rows.find(row => (
    cleanString(row.id) !== cleanString(normalized?.id) &&
    googleCalendarIdFromCalendarRecord(row).toLowerCase() === desiredGoogleCalendarId.toLowerCase()
  ))
  if (conflictingOwner?.id) {
    const error = new Error('Ese calendario de Google ya está ligado a otra agenda de Ristak.')
    error.status = 409
    error.code = 'duplicate_google_calendar_owner'
    throw error
  }
}

export async function upsertLocalCalendar(raw = {}, options = {}) {
  const normalized = normalizeCalendarRecord(raw, options)
  const existingByGhl = normalized.ghlCalendarId ? await getCalendarByGhlId(normalized.ghlCalendarId) : null
  if (existingByGhl?.id) {
    normalized.id = existingByGhl.id
  }
  const existingById = existingByGhl?.id
    ? existingByGhl
    : await db.get('SELECT * FROM calendars WHERE id = ?', [normalized.id])

  const pendingLocalWrite = existingById
    && ['pending', 'error'].includes(cleanString(existingById.sync_status).toLowerCase())
  const incomingMirrorWithoutWriteAck = pendingLocalWrite
    && cleanString(options.syncStatus).toLowerCase() === 'synced'
    && options.acknowledgeLocalWrite !== true
  if (incomingMirrorWithoutWriteAck) {
    // Un GET/refresh de HighLevel no es confirmación de nuestro PUT pendiente.
    // Ignorarlo completo evita que una respuesta vieja borre horarios, duración
    // u otras ediciones locales y, además, conserva vivo el retry.
    return calendarRowToApi(existingById)
  }

  // Respuestas de espejos externos pueden omitir `openHours`. Esa omisión no
  // autoriza a borrar la agenda semanal que el negocio configuró en Ristak.
  // Una escritura explícita sí debe reemplazarla aunque el calendario siga
  // pendiente de sincronizar; ese es el estado normal de un calendario Ristak.
  if (existingById && !hasExplicitCalendarOpenHours(raw)) {
    normalized.openHours = normalizeOpenHours(existingById.open_hours)
    normalized.availabilityScheduleConfigured = (
      Number(existingById.availability_schedule_configured) === 1
      || normalized.openHours.length > 0
    ) ? 1 : 0
  }

  if (
    existingById
    && !hasExplicitCalendarOverlapSetting(raw)
  ) {
    normalized.allowOverlaps = Number(existingById.allow_overlaps) === 1 ? 1 : 0
  }

  if (existingById && !hasExplicitGoogleCalendarLinkInput(raw, options)) {
    preserveExistingGoogleCalendarMetadata(normalized, existingById)
  }

  await assertGoogleCalendarLinkPersistenceSafety({
    normalized,
    existing: existingById,
    allowMutation: options.allowGoogleSyncMetadata === true
  })

  if (normalizeCalendarSource(normalized.source) === 'ristak') {
    normalized.slug = await ensureUniqueRistakPublicSlug(normalized.slug, normalized.id)
    normalized.widgetSlug = normalized.widgetSlugWasExplicit
      ? await ensureUniqueRistakPublicSlug(normalized.widgetSlug, normalized.id)
      : normalized.slug
  }

  if (!existingById && await hasConnectedMetaDatasetConfig()) {
    normalized.rawJson = jsonOrNull(applyConnectedMetaDefaultsToCalendarRawJson(
      parseJson(normalized.rawJson, {})
    ))
  }

  await db.run(`
    INSERT INTO calendars (
      id, ghl_calendar_id, location_id, name, description, slug, widget_slug,
      calendar_type, widget_type, event_title, event_color, is_active,
      team_members, location_configurations, slot_duration, slot_duration_unit,
      slot_interval, slot_interval_unit, slot_buffer, slot_buffer_unit,
      pre_buffer, pre_buffer_unit, appoinment_per_slot, allow_overlaps, appoinment_per_day,
      allow_booking_after, allow_booking_after_unit, allow_booking_for,
      allow_booking_for_unit, open_hours, availability_schedule_configured,
      auto_confirm, allow_reschedule,
      allow_cancellation, notes, availability_type, anti_tracking_enabled, source, sync_status,
      sync_error, last_synced_at, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      ghl_calendar_id = COALESCE(excluded.ghl_calendar_id, calendars.ghl_calendar_id),
      location_id = COALESCE(excluded.location_id, calendars.location_id),
      name = excluded.name,
      description = excluded.description,
      slug = excluded.slug,
      widget_slug = excluded.widget_slug,
      calendar_type = excluded.calendar_type,
      widget_type = excluded.widget_type,
      event_title = excluded.event_title,
      event_color = excluded.event_color,
      is_active = excluded.is_active,
      team_members = COALESCE(excluded.team_members, calendars.team_members),
      location_configurations = COALESCE(excluded.location_configurations, calendars.location_configurations),
      slot_duration = excluded.slot_duration,
      slot_duration_unit = excluded.slot_duration_unit,
      slot_interval = excluded.slot_interval,
      slot_interval_unit = excluded.slot_interval_unit,
      slot_buffer = excluded.slot_buffer,
      slot_buffer_unit = excluded.slot_buffer_unit,
      pre_buffer = excluded.pre_buffer,
      pre_buffer_unit = excluded.pre_buffer_unit,
      appoinment_per_slot = excluded.appoinment_per_slot,
      allow_overlaps = excluded.allow_overlaps,
      appoinment_per_day = excluded.appoinment_per_day,
      allow_booking_after = excluded.allow_booking_after,
      allow_booking_after_unit = excluded.allow_booking_after_unit,
      allow_booking_for = excluded.allow_booking_for,
      allow_booking_for_unit = excluded.allow_booking_for_unit,
      open_hours = COALESCE(excluded.open_hours, calendars.open_hours),
      availability_schedule_configured = excluded.availability_schedule_configured,
      auto_confirm = excluded.auto_confirm,
      allow_reschedule = excluded.allow_reschedule,
      allow_cancellation = excluded.allow_cancellation,
      notes = excluded.notes,
      availability_type = excluded.availability_type,
      anti_tracking_enabled = CASE
        WHEN CAST(? AS INTEGER) IS NULL THEN COALESCE(calendars.anti_tracking_enabled, 1)
        ELSE excluded.anti_tracking_enabled
      END,
      source = excluded.source,
      sync_status = excluded.sync_status,
      sync_error = excluded.sync_error,
      last_synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE calendars.last_synced_at END,
      raw_json = COALESCE(excluded.raw_json, calendars.raw_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    normalized.id,
    normalized.ghlCalendarId,
    normalized.locationId || null,
    normalized.name,
    normalized.description || null,
    normalized.slug,
    normalized.widgetSlug,
    normalized.calendarType,
    normalized.widgetType,
    normalized.eventTitle,
    normalized.eventColor,
    normalized.isActive,
    jsonOrNull(normalized.teamMembers),
    jsonOrNull(normalized.locationConfigurations),
    normalized.slotDuration,
    normalized.slotDurationUnit,
    normalized.slotInterval,
    normalized.slotIntervalUnit,
    normalized.slotBuffer,
    normalized.slotBufferUnit,
    normalized.preBuffer,
    normalized.preBufferUnit,
    normalized.appoinmentPerSlot,
    normalized.allowOverlaps,
    normalized.appoinmentPerDay,
    normalized.allowBookingAfter,
    normalized.allowBookingAfterUnit,
    normalized.allowBookingFor,
    normalized.allowBookingForUnit,
    jsonOrNull(normalized.openHours),
    normalized.availabilityScheduleConfigured,
    normalized.autoConfirm,
    normalized.allowReschedule,
    normalized.allowCancellation,
    normalized.notes || null,
    normalized.availabilityType,
    normalized.antiTrackingEnabled,
    normalized.source,
    normalized.syncStatus,
    normalized.syncError,
    normalized.syncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.rawJson,
    normalized.antiTrackingEnabled
  ])

  const row = await getLocalCalendar(normalized.id)
  return row
}

export async function createLocalCalendar(calendarData = {}, { allowGoogleSyncMetadata = false } = {}) {
  const connectedMetaDataset = await hasConnectedMetaDatasetConfig()
  const hasAvailabilityInput = hasExplicitCalendarOpenHours(calendarData)
  const openHours = hasAvailabilityInput
    ? normalizeOpenHours(calendarData.openHours ?? calendarData.open_hours)
    : createDefaultCalendarOpenHours()
  const customEvents = connectedMetaDataset
    ? {
        ...normalizeCalendarCustomEventsConfig(
          calendarData.customEvents ||
          calendarData.custom_events ||
          calendarData.metaEvent ||
          calendarData.meta_event ||
          {}
        ),
        enabled: true
      }
    : calendarData.customEvents

  return upsertLocalCalendar({
    ...calendarData,
    ...(connectedMetaDataset ? { customEvents } : {}),
    openHours,
    availabilityScheduleConfigured: calendarData.availabilityScheduleConfigured
      ?? calendarData.availability_schedule_configured
      ?? true,
    id: calendarData.id || makeId(LOCAL_CALENDAR_PREFIX),
    source: 'ristak'
  }, {
    source: 'ristak',
    syncStatus: 'pending',
    allowGoogleSyncMetadata
  })
}

export async function getLocalCalendar(calendarId) {
  if (!calendarId) return null
  const row = await db.get(
    'SELECT * FROM calendars WHERE id = ? OR ghl_calendar_id = ? LIMIT 1',
    [calendarId, calendarId]
  )
  return row ? calendarRowToApi(row) : null
}

export async function getPublicCalendarBySlug(slugOrId) {
  const value = decodeSegment(slugOrId)
  if (!value) return null

  const row = await db.get(`
    SELECT *
    FROM calendars
    WHERE COALESCE(is_active, 1) != 0
      AND COALESCE(source, 'ristak') IN ('ristak', 'ghl')
      AND (id = ? OR slug = ? OR widget_slug = ?)
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END,
      CASE COALESCE(source, 'ristak') WHEN 'ristak' THEN 0 WHEN 'ghl' THEN 1 ELSE 2 END,
      LOWER(name) ASC
    LIMIT 1
  `, [value, value, value, value])

  return row ? calendarRowToApi(row) : null
}

function normalizeCalendarFormPages(theme = {}) {
  const rawPages = Array.isArray(theme.pages) ? theme.pages : []
  const normalized = rawPages
    .map((page, index) => ({
      id: cleanString(page?.id) || (index === 0 ? CALENDAR_DEFAULT_PAGE_ID : `page-${index + 1}`),
      title: cleanString(page?.title) || `Pantalla ${index + 1}`,
      sortOrder: Number.isFinite(Number(page?.sortOrder ?? page?.sort_order)) ? Number(page.sortOrder ?? page.sort_order) : index
    }))
    .filter(page => page.id && !CALENDAR_FORM_FINAL_PAGE_IDS.has(page.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)

  return normalized.length ? normalized : [{ id: CALENDAR_DEFAULT_PAGE_ID, title: 'Formulario', sortOrder: 0 }]
}

// (CAL-QUAL) Acciones de calificación que SÍ bloquean el agendado (espejo del motor de
// Sitios). Solo nos importan las de descalificación; las de lead (frío/tibio/caliente) y
// "continue" no impiden agendar. Aceptamos alias en español como en sitesService.
const CALENDAR_DISQUALIFY_ACTIONS = new Set(['disqualify', 'disqualify_after_submit'])
const CALENDAR_OPTION_ACTION_ALIASES = {
  descalificar: 'disqualify',
  descalificar_contacto: 'disqualify',
  descalificar_inmediatamente: 'disqualify',
  no_calificado: 'disqualify',
  no_califica: 'disqualify',
  descalificar_al_finalizar: 'disqualify_after_submit',
  descalificar_al_finalizar_formulario: 'disqualify_after_submit'
}

function normalizeCalendarOptionAction(value) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return ''
  const resolved = CALENDAR_OPTION_ACTION_ALIASES[raw] || raw
  return CALENDAR_DISQUALIFY_ACTIONS.has(resolved) ? resolved : ''
}

function safeCalendarRedirectUrl(value) {
  const raw = cleanString(value)
  if (!raw || raw.length > 1200 || /[<>"']/.test(raw)) return ''
  if (/^\/(?!\/)/.test(raw)) return raw // ruta relativa del mismo sitio
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

// Resuelve si una opción descalifica (soporta { action } único o { actions:[...] } de Sitios).
function resolveCalendarOptionDisqualify(option = {}) {
  const single = normalizeCalendarOptionAction(option?.action)
  if (single) {
    return {
      action: single,
      message: cleanString(option?.message),
      redirectUrl: safeCalendarRedirectUrl(option?.redirectUrl || option?.redirect_url || option?.url || option?.siteUrl || option?.site_url)
    }
  }
  if (Array.isArray(option?.actions)) {
    for (const entry of option.actions) {
      const act = normalizeCalendarOptionAction(entry?.action)
      if (act) {
        return {
          action: act,
          message: cleanString(entry?.message || option?.message),
          redirectUrl: safeCalendarRedirectUrl(entry?.redirectUrl || entry?.redirect_url || entry?.url || option?.redirectUrl)
        }
      }
    }
  }
  return null
}

function normalizeCalendarFormBlock(row = {}, pages = []) {
  const blockType = cleanString(row.block_type || row.blockType)
  if (!CALENDAR_FORM_ALL_BLOCK_TYPES.has(blockType)) return null
  const isContent = CALENDAR_FORM_CONTENT_BLOCK_TYPES.has(blockType)

  const settings = parseJson(row.settings_json || row.settings, {})
  const options = parseJson(row.options_json || row.options, [])
  const pageId = cleanString(settings.pageId || settings.page_id)
  if (CALENDAR_FORM_FINAL_PAGE_IDS.has(pageId)) return null
  const resolvedPageId = pages.some(page => page.id === pageId) ? pageId : pages[0]?.id || CALENDAR_DEFAULT_PAGE_ID

  return {
    id: cleanString(row.id),
    blockType,
    isContent,
    label: cleanString(row.label) || (isContent ? '' : 'Pregunta'),
    placeholder: cleanString(row.placeholder),
    required: Boolean(Number(row.required || 0)),
    content: cleanString(row.content),
    options: Array.isArray(options)
      ? options.map((option, index) => {
        const out = {
          label: cleanString(option?.label || option?.value || `Opcion ${index + 1}`),
          value: cleanString(option?.value || option?.label || `opcion_${index + 1}`)
        }
        // (CAL-QUAL) Preservamos la regla de descalificación de la opción para poder
        // evaluarla en el cliente (UX inmediata) y revalidarla en el servidor (seguridad).
        const dq = resolveCalendarOptionDisqualify(option)
        if (dq) {
          out.action = dq.action
          out.disqualifyMessage = dq.message
          out.disqualifyRedirectUrl = dq.redirectUrl
        }
        return out
      }).filter(option => option.label)
      : [],
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    pageId: resolvedPageId,
    sortOrder: Number.isFinite(Number(row.sort_order ?? row.sortOrder)) ? Number(row.sort_order ?? row.sortOrder) : 0
  }
}

function normalizeCalendarResultContentBlock(row = {}, targetPageId = '') {
  const settings = parseJson(row.settings_json || row.settings, {})
  if (cleanString(settings.pageId || settings.page_id) !== targetPageId) return null

  const blockType = cleanString(row.block_type || row.blockType)
  if (!CALENDAR_FORM_CONTENT_BLOCK_TYPES.has(blockType)) return null

  return {
    id: cleanString(row.id),
    blockType,
    isContent: true,
    label: cleanString(row.label),
    placeholder: cleanString(row.placeholder),
    required: false,
    content: cleanString(row.content),
    options: [],
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    pageId: targetPageId,
    sortOrder: Number.isFinite(Number(row.sort_order ?? row.sortOrder)) ? Number(row.sort_order ?? row.sortOrder) : 0
  }
}

function getDefaultCalendarBookingFields(config = {}, phoneLocale = DEFAULT_CALENDAR_PHONE_LOCALE) {
  const fields = []
  const defaults = normalizeCalendarBookingDefaultFields(config)
  const locale = normalizeCalendarPhoneLocale(phoneLocale)

  fields.push({
    id: 'calendar_name',
    blockType: 'short_text',
    label: 'Nombre completo',
    placeholder: 'Tu nombre',
    required: true,
    content: '',
    options: [],
    settings: { systemFieldKey: 'full_name' },
    pageId: CALENDAR_DEFAULT_PAGE_ID,
    sortOrder: 0
  })

  if (defaults.email.enabled) {
    fields.push({
      id: 'calendar_email',
      blockType: 'email',
      label: 'Correo',
      placeholder: 'tu@email.com',
      required: Boolean(defaults.email.required),
      content: '',
      options: [],
      settings: { systemFieldKey: 'email', validation: 'email' },
      pageId: CALENDAR_DEFAULT_PAGE_ID,
      sortOrder: 1
    })
  }

  if (defaults.phone.enabled) {
    fields.push({
      id: 'calendar_phone',
      blockType: 'phone',
      label: 'Telefono / WhatsApp',
      placeholder: '10 digitos',
      required: Boolean(defaults.phone.required),
      content: '',
      options: [],
      settings: {
        systemFieldKey: 'phone',
        validation: 'phone',
        phoneCountrySelectorEnabled: true,
        defaultCountryCode: locale.countryCode,
        defaultDialCode: locale.dialCode
      },
      pageId: CALENDAR_DEFAULT_PAGE_ID,
      sortOrder: 2
    })
  }

  if (defaults.notes.enabled) {
    fields.push({
      id: 'calendar_notes',
      blockType: 'paragraph',
      label: 'Notas',
      placeholder: 'Algo que debamos saber',
      required: false,
      content: '',
      options: [],
      settings: { systemFieldKey: 'notes' },
      pageId: CALENDAR_DEFAULT_PAGE_ID,
      sortOrder: 3
    })
  }

  return fields
}

export async function getCalendarBookingFormDefinition(calendar = {}) {
  const config = normalizeCalendarBookingFormConfig(calendar.bookingForm || calendar.booking_form || {})
  const phoneLocale = await getCalendarPhoneLocale()

  if (config.useCustomForm && config.customFormId && await canUseCalendarCustomForms()) {
    const site = await db.get(`
      SELECT id, name, site_type, theme_json
      FROM public_sites
      WHERE id = ?
        AND COALESCE(status, 'draft') != 'archived'
        AND site_type IN ('standard_form', 'interactive_form')
      LIMIT 1
    `, [config.customFormId]).catch(() => null)

    if (site?.id) {
      const theme = parseJson(site.theme_json, {})
      const pages = normalizeCalendarFormPages(theme)
      // (CAL-QUAL) Config de descalificación a nivel formulario (respeta lo que dice el
      // formulario de Sitios): si está en "redirigir", usamos esa URL como fallback cuando
      // la opción no trae su propia redirección/mensaje.
      const dqCompletion = cleanString(theme.formDisqualifiedCompletionAction || theme.form_disqualified_completion_action).toLowerCase()
      const formDisqualification = {
        action: dqCompletion === 'redirect_url' ? 'redirect' : 'message',
        redirectUrl: dqCompletion === 'redirect_url'
          ? safeCalendarRedirectUrl(theme.formDisqualifiedRedirectUrl || theme.form_disqualified_redirect_url)
          : '',
        message: cleanString(theme.formDisqualifiedMessage || theme.form_disqualified_message)
      }
      const rows = await db.all(`
        SELECT id, block_type, label, content, placeholder, required, options_json, settings_json, sort_order
        FROM public_site_blocks
        WHERE site_id = ?
          AND block_type IN (${Array.from(CALENDAR_FORM_ALL_BLOCK_TYPES).map(() => '?').join(',')})
        ORDER BY sort_order ASC, created_at ASC
      `, [site.id, ...Array.from(CALENDAR_FORM_ALL_BLOCK_TYPES)]).catch(() => [])
      const blockPaymentGate = getCalendarFormPaymentGateFromRows(rows)
      const disqualificationBlocks = rows
        .map(row => normalizeCalendarResultContentBlock(row, CALENDAR_FORM_DISQUALIFIED_PAGE_ID))
        .filter(Boolean)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      const fields = rows
        .map(row => normalizeCalendarFormBlock(row, pages))
        .filter(Boolean)
        .map(field => applyCalendarPhoneLocaleDefaults(field, phoneLocale))
        .sort((a, b) => {
          const pageA = pages.findIndex(page => page.id === a.pageId)
          const pageB = pages.findIndex(page => page.id === b.pageId)
          return pageA - pageB || a.sortOrder - b.sortOrder
        })

      if (fields.length) {
        return {
          mode: 'custom',
          formId: site.id,
          formName: site.name || 'Formulario',
          siteType: site.site_type || 'standard_form',
          pages,
          fields,
          disqualification: {
            ...formDisqualification,
            html: renderCalendarResultContentBlocks(disqualificationBlocks)
          },
          paymentGate: isPaymentGateEnabled(blockPaymentGate)
            ? blockPaymentGate
            : normalizePaymentGateConfig(theme.paymentGate || theme.payment_gate || {}),
          defaultFields: config.defaultFields
        }
      }
    }
  }

  return {
    mode: 'default',
    formId: CALENDAR_DEFAULT_FORM_SITE_ID,
    formName: 'Formulario de calendario',
    siteType: 'standard_form',
    pages: [{ id: CALENDAR_DEFAULT_PAGE_ID, title: 'Tus datos', sortOrder: 0 }],
    fields: getDefaultCalendarBookingFields(config.defaultFields, phoneLocale),
    paymentGate: normalizePaymentGateConfig({}),
    defaultFields: config.defaultFields
  }
}

function getCalendarFieldValidation(field = {}) {
  const explicit = cleanString(field.settings?.validation || field.settings?.fieldValidation || field.settings?.field_validation).toLowerCase()
  if (['email', 'phone', 'number', 'currency', 'date', 'url'].includes(explicit)) return explicit
  if (field.blockType === 'email') return 'email'
  if (field.blockType === 'phone') return 'phone'
  if (field.blockType === 'number') return 'number'
  if (field.blockType === 'currency') return 'currency'
  if (field.blockType === 'date') return 'date'
  return ''
}

function isCalendarPhoneCountrySelectorEnabled(field = {}) {
  const settings = field.settings || {}
  return settings.phoneCountrySelectorEnabled !== false &&
    settings.countrySelectorEnabled !== false &&
    settings.phoneCountrySelector !== false
}

function renderCalendarPhoneCountryOptions(defaultCountryCode) {
  const selectedCountry = getCalendarPhoneCountryOption(defaultCountryCode)
    || getCountryDefaults(DEFAULT_CALENDAR_PHONE_LOCALE.countryCode)

  return getPhoneCountryOptions().map(country => {
    const selected = country.value === selectedCountry.value ? 'selected' : ''
    return `<option value="${escapeHtml(country.value)}" data-dial-code="${escapeHtml(country.dialCode)}" data-timezones="${escapeHtml((country.timezones || []).join(','))}" ${selected}>${escapeHtml(country.label)}</option>`
  }).join('')
}

function renderCalendarFieldInput(field = {}) {
  const id = escapeHtml(field.id)
  const placeholder = escapeHtml(field.placeholder || '')
  const required = field.required ? 'required' : ''
  const options = Array.isArray(field.options) ? field.options : []
  const settings = field.settings || {}
  const validation = getCalendarFieldValidation(field)
  // (CAL-QUAL) Adjunta la regla de descalificación a cada opción que la tenga, para que el
  // cliente la evalúe al seleccionarla. El servidor SIEMPRE revalida (no confía en el cliente).
  const optionRuleAttr = (option) => option && option.action
    ? ` data-rule="${escapeHtml(JSON.stringify({ action: option.action, message: option.disqualifyMessage || '', redirectUrl: option.disqualifyRedirectUrl || '' }))}"`
    : ''

  if (field.blockType === 'paragraph') {
    return `<textarea id="${id}" name="${id}" rows="3" placeholder="${placeholder}" ${required}></textarea>`
  }
  if (field.blockType === 'currency') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${placeholder || '0.00'}" ${required}>`
  }
  if (field.blockType === 'number') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" placeholder="${placeholder}" ${required}>`
  }
  if (field.blockType === 'email') {
    return `<input id="${id}" name="${id}" type="email" inputmode="email" autocomplete="email" placeholder="${placeholder}" ${required}>`
  }
  if (field.blockType === 'phone') {
    const selectorEnabled = isCalendarPhoneCountrySelectorEnabled(field)
    const locale = normalizeCalendarPhoneLocale({
      countryCode: settings.defaultCountryCode || settings.countryCode || DEFAULT_CALENDAR_PHONE_LOCALE.countryCode,
      dialCode: settings.defaultDialCode || settings.dialCode || DEFAULT_CALENDAR_PHONE_LOCALE.dialCode
    })
    const hiddenAttr = selectorEnabled ? '' : ' data-phone-country-hidden'
    const selectHiddenAttrs = selectorEnabled ? '' : ' aria-hidden="true" tabindex="-1"'
    return `
      <div class="rstk-phone-input" data-phone-country-field${hiddenAttr}>
        <select id="${id}__country" name="${id}__country" data-phone-country-select aria-label="Pais y lada"${selectHiddenAttrs}>
          ${renderCalendarPhoneCountryOptions(locale.countryCode)}
        </select>
        <input id="${id}" name="${id}" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="${placeholder || 'Numero'}" data-phone-number-input ${required}>
      </div>
    `
  }
  if (field.blockType === 'date') {
    return `<input id="${id}" name="${id}" type="date" placeholder="${placeholder}" ${required}>`
  }
  if (field.blockType === 'dropdown') {
    return `
      <select id="${id}" name="${id}" ${required}>
        <option value="">Selecciona una opcion</option>
        ${options.map(option => `<option value="${escapeHtml(option.value)}"${optionRuleAttr(option)}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    `
  }
  if (field.blockType === 'radio') {
    return `
      <div class="options">
        ${options.map((option, index) => `
          <label class="option">
            <input type="radio" name="${id}" value="${escapeHtml(option.value)}" ${required && index === 0 ? 'required' : ''}${optionRuleAttr(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }
  if (field.blockType === 'checkboxes') {
    return `
      <div class="options">
        ${options.map(option => `
          <label class="option">
            <input type="checkbox" name="${id}" value="${escapeHtml(option.value)}" data-checkbox-group="${id}"${optionRuleAttr(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }
  if (validation === 'url') {
    return `<input id="${id}" name="${id}" type="url" inputmode="url" placeholder="${placeholder}" ${required}>`
  }
  return `<input id="${id}" name="${id}" type="text" placeholder="${placeholder}" ${required}>`
}

// (CAL-CONTENT) Convierte una URL de video a su embed (YouTube/Vimeo) o detecta video directo.
function calendarVideoEmbedUrl(rawUrl) {
  const url = cleanString(rawUrl)
  if (!url) return ''
  try {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol)) return ''
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0]
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : ''
    }
    if (host.endsWith('youtube.com')) {
      if (u.pathname.startsWith('/embed/')) return `https://www.youtube.com${u.pathname}`
      const id = u.searchParams.get('v')
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : ''
    }
    if (host.endsWith('vimeo.com')) {
      if (u.pathname.startsWith('/video/') || host.startsWith('player.')) return `https://player.vimeo.com${u.pathname.startsWith('/video/') ? u.pathname : `/video${u.pathname}`}`
      const id = u.pathname.split('/').filter(Boolean).pop()
      return /^\d+$/.test(id || '') ? `https://player.vimeo.com/video/${id}` : ''
    }
    return ''
  } catch {
    return ''
  }
}

function renderCalendarVideoBlock(rawUrl, label = '') {
  const url = cleanString(rawUrl)
  if (!url) return ''
  // Video directo (archivo): se reproduce con <video>.
  if (/\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url)) {
    const safe = safeCalendarImageUrl(url)
    return safe
      ? `<div class="calContentVideo"><video src="${escapeHtml(safe)}" controls playsinline preload="metadata"></video></div>`
      : ''
  }
  // YouTube / Vimeo: embed en iframe.
  const embed = calendarVideoEmbedUrl(url)
  return embed
    ? `<div class="calContentVideo calContentVideoEmbed"><iframe src="${escapeHtml(embed)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"></iframe></div>`
    : ''
}

function getCalendarPaymentGatewayLabel(gateway = '') {
  const raw = cleanString(gateway).toLowerCase()
  if (raw === 'mercadopago') return 'Mercado Pago'
  if (raw === 'conekta') return 'Conekta'
  if (raw === 'clip') return 'CLIP'
  if (raw === 'rebill') return 'Rebill'
  return 'Stripe'
}

function formatCalendarPaymentAmount(amount, currency = 'MXN') {
  const numeric = Number(amount)
  const safeCurrency = /^[A-Z]{3}$/.test(cleanString(currency).toUpperCase()) ? cleanString(currency).toUpperCase() : 'MXN'
  if (!Number.isFinite(numeric) || numeric <= 0) return 'Monto pendiente'
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: safeCurrency }).format(numeric)
  } catch {
    return `${numeric.toFixed(2)} ${safeCurrency}`
  }
}

function getCalendarFormPaymentGateFromBlock(block = {}) {
  const settings = block?.settings && typeof block.settings === 'object' ? block.settings : {}
  return normalizePaymentGateConfig(settings.paymentGate || settings.payment_gate || {})
}

function getCalendarFormPaymentGateFromRows(rows = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const blockType = cleanString(row.block_type || row.blockType)
    if (blockType !== 'payment') continue
    const settings = parseJson(row.settings_json || row.settings, {})
    const paymentGate = normalizePaymentGateConfig(settings.paymentGate || settings.payment_gate || {})
    if (isPaymentGateEnabled(paymentGate)) return paymentGate
  }
  return normalizePaymentGateConfig({})
}

// (CAL-CONTENT) Renderiza un bloque de contenido (no-campo) del formulario en el calendario.
function renderCalendarContentBlock(block = {}) {
  const type = block.blockType
  const settings = block.settings || {}
  const content = cleanString(block.content)
  const label = cleanString(block.label)
  const text = content || label

  if (type === 'title') return text ? `<h3 class="calContentTitle">${escapeHtml(text)}</h3>` : ''
  if (type === 'subtitle') return text ? `<p class="calContentSubtitle">${escapeHtml(text)}</p>` : ''
  if (type === 'text') return text ? `<p class="calContentText">${escapeHtml(text)}</p>` : ''
  if (type === 'image') {
    const url = safeCalendarImageUrl(settings.mediaUrl || settings.media_url || content)
    return url
      ? `<figure class="calContentImage"><img src="${escapeHtml(url)}" alt="${escapeHtml(label || 'Imagen')}" loading="lazy"></figure>`
    : ''
  }
  if (type === 'video') return renderCalendarVideoBlock(settings.mediaUrl || settings.media_url || content, label)
  if (type === 'payment') {
    const paymentGate = getCalendarFormPaymentGateFromBlock(block)
    if (!isPaymentGateEnabled(paymentGate)) return ''
    const productName = cleanString(paymentGate.productName || content || label) || 'Pago requerido'
    const description = cleanString(paymentGate.description || paymentGate.pendingMessage) || 'Completa el pago para agendar.'
    return `
      <div class="calPaymentBlock">
        <div>
          <small>${escapeHtml(getCalendarPaymentGatewayLabel(paymentGate.gateway))}</small>
          <strong>${escapeHtml(productName)}</strong>
          <p>${escapeHtml(description)}</p>
        </div>
        <span>${escapeHtml(formatCalendarPaymentAmount(paymentGate.amount, paymentGate.currency))}</span>
      </div>
    `
  }
  return ''
}

function renderCalendarResultContentBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(block => {
      const html = renderCalendarContentBlock(block)
      return html ? `<div class="calendarContentBlock" data-block-type="${escapeHtml(block.blockType)}">${html}</div>` : ''
    })
    .filter(Boolean)
    .join('')
}

function renderCalendarBookingForm(bookingForm = {}) {
  const pages = Array.isArray(bookingForm.pages) && bookingForm.pages.length
    ? bookingForm.pages
    : [{ id: CALENDAR_DEFAULT_PAGE_ID, title: 'Tus datos', sortOrder: 0 }]
  const fields = Array.isArray(bookingForm.fields) ? bookingForm.fields : []
  const hasPages = pages.length > 1
  const isCustom = bookingForm.mode === 'custom'
  const showHeader = !isCustom || hasPages
  const headerHtml = showHeader
    ? `<div class="formHeader" data-form-header="${isCustom ? 'minimal' : 'full'}">
        ${isCustom ? '' : `<h2>${escapeHtml(bookingForm.formName || 'Tus datos')}</h2>`}
        ${hasPages ? `<p data-form-progress aria-live="polite">Pantalla 1 de ${pages.length}</p>` : ''}
      </div>`
    : ''

  return `
    <form data-form data-form-mode="${escapeHtml(bookingForm.mode || 'default')}">
      ${headerHtml}
      ${pages.map((page, index) => {
        const pageFields = fields.filter(field => field.pageId === page.id)
        const pageQuestions = pageFields.length
          ? pageFields.map(field => {
            // (CAL-CONTENT) Bloques de contenido (título/texto/imagen/video): sin label ni input,
            // se muestran tal cual en el orden definido en el formulario.
            if (field.isContent) {
              const html = renderCalendarContentBlock(field)
              return html ? `<div class="calendarContentBlock" data-block-type="${escapeHtml(field.blockType)}">${html}</div>` : ''
            }
            return `
            <section class="calendarQuestion" data-field-id="${escapeHtml(field.id)}" data-field-type="${escapeHtml(field.blockType)}" data-required="${field.required ? 'true' : 'false'}" data-validation="${escapeHtml(getCalendarFieldValidation(field))}" data-system-field-key="${escapeHtml(cleanString(field.settings?.systemFieldKey || field.settings?.system_field_key || ''))}">
              <label for="${escapeHtml(field.id)}">${escapeHtml(field.label || 'Pregunta')}${field.required ? '<span class="requiredMark">*</span>' : ''}</label>
              ${field.content ? `<p class="fieldHelp">${escapeHtml(field.content)}</p>` : ''}
              ${renderCalendarFieldInput(field)}
              <p class="fieldError" hidden>Esta respuesta es requerida.</p>
            </section>
          `}).join('')
          : '<p class="fieldHelp">Esta pantalla no tiene preguntas.</p>'

        return `
          <div class="formPage" data-form-page="${escapeHtml(page.id)}"${index === 0 ? '' : ' hidden'}>
            ${pageQuestions}
          </div>
        `
      }).join('')}
      <div class="formActions">
        ${hasPages ? '<button class="secondary" type="button" data-form-back hidden>Anterior</button>' : ''}
        ${hasPages ? '<button class="submit" type="button" data-form-next>Siguiente</button>' : ''}
        <button class="submit" type="submit" ${hasPages ? 'hidden ' : ''}disabled data-submit>Selecciona un horario</button>
      </div>
      <p class="message" data-message role="status"></p>
    </form>
  `
}

export function normalizeCalendarBookingSubmission(bookingForm = {}, body = {}) {
  const fields = Array.isArray(bookingForm.fields) ? bookingForm.fields : []
  const responses = body.responses && typeof body.responses === 'object' && !Array.isArray(body.responses)
    ? body.responses
    : {}
  const normalizedResponses = {}
  const errors = []
  // (CAL-QUAL) Estado de calificación recalculado en el servidor (no confiamos en el cliente).
  let disqualified = false
  let disqualifyMessage = ''
  let disqualifyRedirectUrl = ''
  let disqualifyHtml = ''

  const getBodyValue = (field) => {
    if (Object.prototype.hasOwnProperty.call(responses, field.id)) return responses[field.id]
    if (Object.prototype.hasOwnProperty.call(body, field.id)) return body[field.id]
    if (field.id === 'calendar_name') return body.name || body.fullName || body.full_name
    if (field.id === 'calendar_phone') return body.phone
    if (field.id === 'calendar_email') return body.email
    if (field.id === 'calendar_notes') return body.notes
    return ''
  }

  const valueAsText = (value) => Array.isArray(value)
    ? value.map(item => cleanString(item)).filter(Boolean).join(', ')
    : cleanString(value)

  const matchesField = (field, patterns = []) => {
    const haystack = [
      field.id,
      field.label,
      field.blockType,
      field.settings?.systemFieldKey,
      field.settings?.system_field_key,
      field.settings?.customFieldKey,
      field.settings?.custom_field_key
    ].map(value => cleanString(value).toLowerCase()).join(' ')
    return patterns.some(pattern => pattern.test(haystack))
  }

  let fullName = cleanString(body.name || body.fullName || body.full_name)
  let phone = cleanString(body.phone)
  let email = cleanString(body.email)
  let notes = cleanString(body.notes)

  for (const field of fields) {
    // (CAL-CONTENT) Los bloques de contenido (video/texto/imagen) no son respuestas.
    if (field.isContent) continue
    const rawValue = getBodyValue(field)
    const value = Array.isArray(rawValue)
      ? rawValue.map(item => cleanString(item)).filter(Boolean)
      : cleanString(rawValue)
    const empty = Array.isArray(value) ? value.length === 0 : !value
    const validation = getCalendarFieldValidation(field)

    if (field.required && empty) {
      errors.push(`${field.label || 'Pregunta'} es requerido`)
      continue
    }
    if (!empty && validation === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valueAsText(value))) {
      errors.push(`${field.label || 'Correo'} no tiene un correo valido`)
      continue
    }
    if (!empty && validation === 'phone' && valueAsText(value).replace(/[^\d]/g, '').length < 7) {
      errors.push(`${field.label || 'Telefono'} no tiene un telefono valido`)
      continue
    }

    normalizedResponses[field.id] = value

    // (CAL-QUAL) Si el valor elegido cae sobre una opción descalificadora, la cita NO se agenda.
    if (!empty && Array.isArray(field.options) && field.options.length) {
      const chosen = (Array.isArray(value) ? value : [value]).map(item => cleanString(item).toLowerCase())
      for (const option of field.options) {
        if (!option.action) continue
        const optValue = cleanString(option.value).toLowerCase()
        const optLabel = cleanString(option.label).toLowerCase()
        if (chosen.includes(optValue) || chosen.includes(optLabel)) {
          disqualified = true
          if (!disqualifyMessage && option.disqualifyMessage) disqualifyMessage = option.disqualifyMessage
          if (!disqualifyRedirectUrl && option.disqualifyRedirectUrl) disqualifyRedirectUrl = option.disqualifyRedirectUrl
        }
      }
    }

    if (!fullName && matchesField(field, [/full.?name/, /nombre/, /name/])) fullName = valueAsText(value)
    if (!phone && (validation === 'phone' || matchesField(field, [/phone/, /tel[eé]fono/, /whatsapp/]))) phone = valueAsText(value)
    if (!email && (validation === 'email' || matchesField(field, [/email/, /correo/]))) email = valueAsText(value)
    if (!notes && matchesField(field, [/notes?/, /nota/, /comentario/, /mensaje/])) notes = valueAsText(value)
  }

  if (!fullName) errors.push('El nombre es requerido')
  if (!phone && !email) errors.push('Se requiere telefono o correo')

  // (CAL-QUAL) Fallback a la config de descalificación del formulario (Sitios) cuando la
  // opción no trae su propio mensaje/redirección.
  if (disqualified) {
    const formDq = bookingForm.disqualification || {}
    if (!disqualifyRedirectUrl && formDq.action === 'redirect' && formDq.redirectUrl) disqualifyRedirectUrl = formDq.redirectUrl
    if (!disqualifyMessage && formDq.message) disqualifyMessage = formDq.message
    disqualifyHtml = cleanString(formDq.html)
  }

  const responseLines = fields
    .map(field => {
      const value = normalizedResponses[field.id]
      const text = valueAsText(value)
      return text ? `${field.label || field.id}: ${text}` : ''
    })
    .filter(Boolean)

  return {
    contact: {
      contactId: cleanString(body.contactId || body.contact_id || body.meta?.contactId || body.meta?.contact_id),
      name: fullName,
      phone,
      email
    },
    notes,
    responses: normalizedResponses,
    responseSummary: responseLines.join('\n'),
    formId: bookingForm.formId || '',
    formName: bookingForm.formName || '',
    errors,
    disqualified,
    disqualifyMessage,
    disqualifyRedirectUrl,
    disqualifyHtml
  }
}

export function renderPublicCalendarHtml(calendar, { host = '', embedded = false, style = {}, bookingForm = null, preview = false, metaPixelSnippet = '' } = {}) {
  const slug = publicCalendarSlug(calendar)
  const duration = Math.max(1, calendarDurationToMinutes(
    calendar.slotDuration,
    calendar.slotDurationUnit,
    60
  ))
  const title = calendar.eventTitle || calendar.name || 'Cita'
  const bookingDisplay = normalizeCalendarBookingDisplayConfig(calendar.bookingDisplay || calendar.booking_display || {}, {
    eventColor: calendar.eventColor || calendar.event_color
  })
  const displayColors = bookingDisplay.colors || DEFAULT_CALENDAR_BOOKING_DISPLAY_COLORS
  const designMode = cleanString(style.designMode).toLowerCase() === 'original' ? 'original' : 'custom'
  const useCustomStyle = designMode === 'custom'
  const accent = useCustomStyle ? safeCssColor(style.accent, displayColors.accent) : displayColors.accent
  const backgroundColor = useCustomStyle ? safeCssColor(style.background, displayColors.background) : displayColors.background
  const surfaceColor = useCustomStyle ? safeCssColor(style.surface, displayColors.surface) : displayColors.surface
  const textColor = useCustomStyle ? safeCssColor(style.text, displayColors.text) : displayColors.text
  const mutedColor = useCustomStyle ? safeCssColor(style.muted, displayColors.muted) : displayColors.muted
  const lineColor = useCustomStyle ? safeCssColor(style.line, displayColors.line) : displayColors.line
  const embeddedControlBg = 'rgba(255, 255, 255, 0)'
  const defaultControlBg = embedded ? embeddedControlBg : displayColors.controlBg
  const controlBg = useCustomStyle ? safeCssColor(style.controlBg, defaultControlBg) : defaultControlBg
  const slotBg = useCustomStyle ? safeCssColor(style.slotBg, displayColors.slotBg || defaultControlBg) : displayColors.slotBg
  const slotText = useCustomStyle ? safeCssColor(style.slotText, displayColors.slotText || accent) : displayColors.slotText
  const selectedText = useCustomStyle ? safeCssColor(style.selectedText, displayColors.selectedText) : displayColors.selectedText
  const fieldBg = useCustomStyle ? safeCssColor(style.fieldBg, displayColors.fieldBg || defaultControlBg) : displayColors.fieldBg
  const fieldText = useCustomStyle ? safeCssColor(style.fieldText, displayColors.fieldText) : displayColors.fieldText
  const fieldBorder = useCustomStyle ? safeCssColor(style.fieldBorder, displayColors.fieldBorder || lineColor) : displayColors.fieldBorder
  const buttonText = useCustomStyle ? safeCssColor(style.buttonText, selectedText) : selectedText
  const slotRadius = useCustomStyle ? safeCssNumber(style.slotRadius, 8, 0, 32) : 8
  const fieldRadius = useCustomStyle ? safeCssNumber(style.fieldRadius, 8, 0, 32) : 8
  const layout = normalizeCalendarEmbedLayout(style.layout || bookingDisplay.layout)
  // En modo "Personalizar para sitio" (custom) el bloque del sitio puede sobreescribir
  // qué elementos se muestran (mismos toggles que en "Estilos y diseños" del calendario)
  // y la tipografía. Si no llega override, se respeta la configuración del calendario.
  const resolveDisplayToggle = (key, fallback) => (
    useCustomStyle && style[key] !== undefined ? parseBoolean(style[key], fallback) : fallback
  )
  const overrideFontFamily = useCustomStyle ? cleanString(style.fontFamily || style.font_family) : ''
  const overrideWidgetTheme = useCustomStyle ? cleanString(style.widgetTheme || style.widget_theme) : ''
  const effectiveBookingDisplay = {
    ...bookingDisplay,
    showSidebar: resolveDisplayToggle('showSidebar', bookingDisplay.showSidebar !== false),
    showIcon: resolveDisplayToggle('showIcon', bookingDisplay.showIcon !== false),
    showEventTitle: resolveDisplayToggle('showEventTitle', bookingDisplay.showEventTitle !== false),
    showCalendarName: resolveDisplayToggle('showCalendarName', bookingDisplay.showCalendarName !== false),
    showDescription: resolveDisplayToggle('showDescription', bookingDisplay.showDescription !== false),
    showDuration: resolveDisplayToggle('showDuration', bookingDisplay.showDuration !== false),
    showConfirmation: resolveDisplayToggle('showConfirmation', bookingDisplay.showConfirmation !== false),
    allowTimezoneSelection: resolveDisplayToggle('allowTimezoneSelection', bookingDisplay.allowTimezoneSelection !== false),
    fontFamily: overrideFontFamily ? normalizeCalendarBookingFontFamily(overrideFontFamily) : bookingDisplay.fontFamily,
    widgetTheme: overrideWidgetTheme ? normalizeCalendarBookingWidgetTheme(overrideWidgetTheme) : bookingDisplay.widgetTheme,
    formPosition: (useCustomStyle && (style.formPosition === 'before' || style.formPosition === 'after')) ? style.formPosition : bookingDisplay.formPosition,
    paymentPosition: normalizeCalendarBookingPaymentPosition(useCustomStyle ? style.paymentPosition || style.payment_position || bookingDisplay.paymentPosition : bookingDisplay.paymentPosition)
  }
  const fontStack = getCalendarBookingFontStack(effectiveBookingDisplay.fontFamily)
  const widgetTheme = normalizeCalendarBookingWidgetTheme(effectiveBookingDisplay.widgetTheme)
  const coverImage = safeCalendarImageUrl(style.coverImage, calendar.calendarCoverImage || calendar.calendar_cover_image || '')
  const bookingCompletion = normalizeCalendarBookingCompletionConfig(calendar.bookingCompletion || calendar.booking_completion || {})
  const bookingPayment = normalizePaymentGateConfig(calendar.bookingPayment || calendar.booking_payment || {})
  const customEvents = normalizeCalendarCustomEventsConfig(calendar.customEvents || calendar.custom_events || calendar.metaEvent || calendar.meta_event || {})
  const showSidebar = effectiveBookingDisplay.showSidebar !== false
  const fallbackTimezone = [
    effectiveBookingDisplay.defaultTimezone,
    calendar.googleCalendarTimeZone,
    calendar.google_calendar_time_zone,
    calendar.timeZone,
    calendar.time_zone,
    DEFAULT_TIMEZONE
  ].find(value => isValidTimezone(cleanString(value))) || DEFAULT_TIMEZONE
  const payload = {
    slug,
    name: calendar.name || 'Calendario',
    description: calendar.description || '',
    eventTitle: title,
    duration,
    color: accent,
    host,
    preview: Boolean(preview),
    layout,
    coverImage,
    bookingCompletion,
    bookingPayment,
    bookingDisplay: effectiveBookingDisplay,
    customEvents,
    defaultTimezone: fallbackTimezone,
    styleDefaults: {
      accent,
      background: backgroundColor,
      surface: surfaceColor,
      text: textColor,
      muted: mutedColor,
      line: lineColor,
      controlBg,
      slotBg,
      slotText,
      selectedText,
      fieldBg,
      fieldText,
      fieldBorder,
      buttonText,
      slotRadius,
      fieldRadius,
      layout,
      widgetTheme,
      coverImage,
      fontFamily: effectiveBookingDisplay.fontFamily
    },
    bookingForm: bookingForm || {
      mode: 'default',
      formId: CALENDAR_DEFAULT_FORM_SITE_ID,
      formName: 'Formulario de calendario',
      pages: [{ id: CALENDAR_DEFAULT_PAGE_ID, title: 'Tus datos', sortOrder: 0 }],
      fields: getDefaultCalendarBookingFields()
    }
  }

  const introMetaItems = [
    effectiveBookingDisplay.showDuration
      ? `<span><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>${duration} min</span>`
      : '',
    effectiveBookingDisplay.showConfirmation
      ? `<span><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Confirmación ${calendar.autoConfirm ? 'automática' : 'pendiente'}</span>`
      : ''
  ].filter(Boolean).join('')
  const introHtml = showSidebar
    ? `<section class="intro">
        ${effectiveBookingDisplay.showIcon ? `<div class="avatar" aria-hidden="true" data-calendar-avatar>${coverImage ? `<img src="${escapeHtml(coverImage)}" alt="">` : `<span data-calendar-initial>${escapeHtml((calendar.name || 'R').trim()[0] || 'R')}</span>`}</div>` : ''}
        ${effectiveBookingDisplay.showEventTitle ? `<p class="host">${escapeHtml(calendar.eventTitle || 'Evento')}</p>` : ''}
        ${effectiveBookingDisplay.showCalendarName ? `<h1>${escapeHtml(calendar.name || 'Agenda tu cita')}</h1>` : ''}
        ${effectiveBookingDisplay.showDescription ? `<p class="description">${escapeHtml(calendar.description || 'Selecciona una fecha y horario disponible para confirmar tu cita.')}</p>` : ''}
        ${introMetaItems ? `<div class="meta">${introMetaItems}</div>` : ''}
      </section>`
    : ''

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(calendar.name || 'Calendario')}</title>
  <meta name="description" content="${escapeHtml(calendar.description || `Agenda ${title}`)}">
  ${metaPixelSnippet || ''}
  <style>
    :root{--accent:${escapeHtml(accent)};--accent-soft:color-mix(in srgb,var(--accent) 10%,transparent);--ink:${escapeHtml(fieldText)};--heading:${escapeHtml(textColor)};--muted:${escapeHtml(mutedColor)};--line:${escapeHtml(lineColor)};--bg:${embedded ? 'transparent' : escapeHtml(backgroundColor)};--surface:${embedded ? 'transparent' : escapeHtml(surfaceColor)};--control-bg:${escapeHtml(controlBg)};--slot-bg:${escapeHtml(slotBg)};--slot-text:${escapeHtml(slotText)};--selected-text:${escapeHtml(selectedText)};--field-bg:${escapeHtml(fieldBg)};--field-text:${escapeHtml(fieldText)};--field-border:${escapeHtml(fieldBorder)};--button-text:${escapeHtml(buttonText)};--slot-radius:${slotRadius}px;--field-radius:${fieldRadius}px;--font-family:${fontStack};--danger:#b42318;--ok:#047857}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--font-family);letter-spacing:0;line-height:1.55;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
    body.rstk-calendar-embedded{min-height:0;background:transparent}
    button,input,textarea{font:inherit}
    .page{min-height:100vh;width:min(1180px,calc(100% - 32px));margin:0 auto;padding:clamp(24px,4vw,54px) 0;display:grid;place-items:center}
    body.rstk-calendar-embedded .page{min-height:0;width:100%;padding:0;place-items:stretch}
    .shell{width:100%;min-height:min(760px,calc(100vh - 80px));display:grid;grid-template-columns:340px minmax(390px,1fr);background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 32px 90px -60px rgba(15,23,42,.45);overflow:hidden}
    body.rstk-calendar-embedded .shell{min-height:100vh;min-width:0;border:0;border-radius:0;box-shadow:none}
    body.rstk-calendar-embedded.rstk-calendar-layout-stacked .page{place-items:start center}
    .shell.dateSelected{grid-template-columns:340px minmax(390px,1fr) minmax(260px,300px)}
    .shell.noIntro,.shell.noIntro.dateSelected{grid-template-columns:minmax(390px,1fr)}
    .shell.noIntro.dateSelected{grid-template-columns:minmax(390px,1fr) minmax(260px,300px)}
    .shell.noIntro.bookingActive{grid-template-columns:minmax(320px,520px)}
    .shell.noIntro .intro{display:none}
    .shell:not(.dateSelected):not(.bookingActive) .timesPane{display:none}
    .shell.layout-compact{grid-template-columns:minmax(0,1fr)}
    .shell.layout-compact.dateSelected{grid-template-columns:minmax(0,1fr) minmax(240px,320px)}
    .shell.layout-compact .intro{grid-column:1/-1;grid-template-columns:auto minmax(0,1fr);align-items:center;border-right:0;border-bottom:1px solid var(--line);padding:26px 30px}
    .shell.layout-compact .avatar{width:78px;height:78px;font-size:2.2rem}
    .shell.layout-compact .calendarPane,.shell.layout-compact .timesPane{min-width:0}
    .shell.layout-stacked{width:100%;max-width:760px;margin:0 auto;grid-template-columns:minmax(0,1fr);min-height:0}
    body.rstk-calendar-embedded .shell.layout-stacked{max-width:min(760px,100%);min-height:0}
    .shell.layout-stacked .intro{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:16px;padding:24px 28px}
    .shell.layout-stacked .avatar{width:78px;height:78px;font-size:2.2rem}
    .shell.layout-stacked .intro,.shell.layout-stacked .calendarPane,.shell.layout-stacked .timesPane{border-right:0;border-left:0}
    .shell.layout-stacked .calendarPane,.shell.layout-stacked .timesPane{border-top:1px solid var(--line)}
    .shell.layout-stacked .calendarPane,.shell.layout-stacked .timesPane{padding:26px 28px}
    .shell.layout-stacked .timesPane{grid-template-rows:auto auto}
    .shell.layout-stacked .slotList{grid-template-columns:repeat(auto-fit,minmax(132px,1fr));max-height:none}
    .shell.bookingActive{grid-template-columns:340px minmax(320px,520px);justify-content:center}
    .shell.formGate{grid-template-columns:340px minmax(360px,620px)}
    .shell.noIntro.formGate{grid-template-columns:minmax(320px,620px)}
    .shell.layout-compact.bookingActive{grid-template-columns:minmax(320px,520px)}
    .shell.layout-compact.formGate{grid-template-columns:minmax(320px,620px)}
    .shell.layout-stacked.bookingActive{grid-template-columns:1fr}
    .shell.layout-stacked.formGate{grid-template-columns:1fr}
    .shell.bookingActive .calendarPane{display:none}
    .shell.bookingActive .timesPane{border-left:1px solid var(--line);max-width:520px;width:100%}
    .shell.formGate .timesPane{max-width:620px;padding:clamp(26px,3.4vw,40px) clamp(26px,3.2vw,44px);gap:14px}
    .shell.layout-compact.bookingActive .intro,.shell.layout-compact.bookingActive .timesPane,.shell.layout-stacked.bookingActive .timesPane{border-left:0}
    .shell.bookingActive .slotList{display:none}
    .intro{position:relative;padding:clamp(28px,3vw,40px) clamp(26px,2.6vw,36px);border-right:1px solid var(--line);display:grid;align-content:start;gap:18px}
    .avatar{width:84px;height:84px;border-radius:18px;background:linear-gradient(140deg,var(--accent-soft),var(--control-bg));border:1px solid var(--line);display:grid;place-items:center;color:var(--accent);font-size:2.3rem;font-weight:600;overflow:hidden}
    .avatar img{width:100%;height:100%;display:block;object-fit:cover}
    .host{margin:6px 0 0;color:var(--muted);font-size:.72rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase}
    h1{margin:0;color:var(--heading);font-size:clamp(1.55rem,2.6vw,2.05rem);line-height:1.12;letter-spacing:-.022em;font-weight:600}
    h2{margin:0;color:var(--heading);font-size:1.28rem;line-height:1.25;letter-spacing:-.012em;font-weight:600}
    h3{margin:0;color:var(--heading);font-size:1rem;font-weight:600;letter-spacing:-.005em}
    p{margin:0;color:var(--muted)}
    .description{font-size:.94rem;line-height:1.6}
    .meta{display:grid;gap:13px;margin-top:4px;color:var(--muted);font-size:.92rem;font-weight:450}
    .meta span{display:flex;align-items:center;gap:10px}
    .calendarPane{padding:38px 36px;display:grid;grid-template-rows:auto auto 1fr auto;gap:24px}
    .paneTitle{display:grid;gap:6px}
    .monthBar{display:grid;grid-template-columns:42px 1fr 42px;align-items:center;gap:12px}
    .monthBar strong{text-align:center;font-size:1.02rem;font-weight:600;letter-spacing:-.01em;color:var(--heading);text-transform:capitalize}
    .navBtn{width:40px;height:40px;border:0;border-radius:999px;background:var(--control-bg);color:var(--muted);display:grid;place-items:center;cursor:pointer;transition:background .15s,color .15s}
    .navBtn:hover,.navBtn:focus-visible{background:var(--accent-soft);color:var(--accent);outline:0}
    .weekdays,.days{display:grid;grid-template-columns:repeat(7,1fr);justify-items:center}
    .weekdays{gap:8px;color:var(--muted);font-size:.7rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
    .days{gap:8px 6px}
    .day{position:relative;width:44px;height:44px;border:0;border-radius:999px;background:transparent;color:var(--muted);cursor:default;font-weight:450;font-size:.95rem;transition:background .15s,color .15s}
    .day.available{color:var(--heading);cursor:pointer;font-weight:500}
    .day.available:hover,.day.available:focus-visible{background:var(--accent-soft);color:var(--accent);outline:0}
    .day.selected{background:var(--accent);color:var(--selected-text)}
    .day.today.available:not(.selected){box-shadow:inset 0 0 0 1px var(--accent)}
    .day.outside{visibility:hidden}
    .day:disabled{opacity:.34}
    .timezone{display:flex;align-items:flex-start;gap:10px;color:var(--muted);font-size:.9rem;font-weight:450}
    .timezone[hidden]{display:none}
    .timezoneControl{display:grid;gap:8px;min-width:0}
    .timezoneControl strong{color:var(--ink)}
    .timezoneControl select{min-height:38px;max-width:min(320px,100%);font-size:.88rem}
    .timezoneStep{display:grid;justify-items:center;text-align:center;gap:8px;padding:12px 0 2px}
    .timezoneStep .timezoneControl{width:min(320px,100%);justify-items:center}
    .timezoneStep .timezoneControl select{width:100%;max-width:280px}
    .timezoneStep .timezoneControl > span:first-child{color:var(--heading);font-weight:600}
    .timezoneStep[hidden]{display:none}
    .timesPane{border-left:1px solid var(--line);padding:38px 24px;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:18px}
    .selectedDate{display:grid;gap:6px;min-height:58px}
    .changeSlot{display:none;justify-self:start;align-items:center;gap:6px;min-height:34px;border:1px solid var(--line);border-radius:999px;background:var(--control-bg);color:var(--muted);font-size:.84rem;font-weight:500;padding:0 14px 0 10px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
    .changeSlot svg{width:16px;height:16px;flex:none}
    .changeSlot:hover{background:var(--accent-soft);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 30%,var(--line))}
    .shell.dateSelected .changeSlot,.shell.bookingActive .changeSlot{display:inline-flex;align-items:center;justify-content:center}
    .slotList{display:grid;align-content:start;gap:10px;min-height:0;overflow-y:auto;padding-right:6px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted) 32%,transparent) transparent}
    .slotList::-webkit-scrollbar{width:8px}
    .slotList::-webkit-scrollbar-track{background:transparent}
    .slotList::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 32%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
    .slotList::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--muted) 52%,transparent);background-clip:padding-box}
    .slot{width:100%;min-height:48px;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));border-radius:var(--slot-radius);background:var(--slot-bg);color:var(--slot-text);font-weight:550;font-size:.95rem;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
    .slot:hover,.slot.selected{background:var(--accent);border-color:var(--accent);color:var(--selected-text)}
    .slotEmpty{display:grid;place-items:center;min-height:160px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);text-align:center;padding:18px}
    form{display:none;gap:18px;border-top:1px solid var(--line);padding-top:22px}
    form.visible{display:grid}
    .formHeader{display:grid;justify-items:start;gap:8px;margin-bottom:6px}
    .formHeader h2{margin:0}
    .formHeader p{margin:0}
    .formHeader [data-form-progress]{display:inline-flex;align-items:center;justify-content:center;min-height:28px;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line));border-radius:999px;background:var(--accent-soft);color:var(--accent);padding:4px 10px;font-size:.74rem;font-weight:600;line-height:1;letter-spacing:.04em;text-transform:uppercase}
    .formHeader[data-form-header="minimal"]{margin-bottom:4px}
    .formPage{display:grid;gap:16px}
    .formPage[hidden]{display:none}
    .calendarQuestion{display:grid;gap:7px}
    .calendarContentBlock{display:grid;gap:6px}
    .calContentTitle{margin:0;color:var(--heading);font-size:1.05rem;font-weight:600;letter-spacing:-.01em}
    .calContentSubtitle{margin:0;color:var(--muted);font-size:.95rem;line-height:1.5}
    .calContentText{margin:0;color:var(--ink);font-size:.92rem;line-height:1.6;white-space:pre-line}
    .calContentImage{margin:0}
    .calContentImage img{display:block;width:100%;height:auto;border-radius:var(--field-radius);border:1px solid var(--line)}
    .calContentVideo{position:relative;width:100%;display:grid;place-items:center;border-radius:var(--field-radius);overflow:hidden;background:color-mix(in srgb,var(--heading) 92%,var(--surface));border:1px solid var(--line)}
    .calContentVideo video{display:block;width:auto;max-width:100%;height:auto;max-height:min(52vh,560px);object-fit:contain}
    .calContentVideoEmbed{aspect-ratio:16/9}
    .calContentVideoEmbed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
    .calPaymentBlock{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;border:1px solid var(--line);border-radius:var(--field-radius);background:var(--surface);padding:14px}
    .calPaymentBlock div{display:grid;gap:3px;min-width:0}
    .calPaymentBlock small{color:var(--muted);font-size:.72rem;font-weight:650;text-transform:uppercase}
    .calPaymentBlock strong{color:var(--heading);font-size:.98rem;font-weight:650}
    .calPaymentBlock p{margin:0;color:var(--muted);font-size:.84rem;line-height:1.4}
    .calPaymentBlock > span{color:var(--heading);font-size:1.05rem;font-weight:700;font-variant-numeric:tabular-nums}
    .fieldHelp,.fieldError{margin:0;font-size:.82rem;line-height:1.4}
    .fieldHelp{color:var(--muted)}
    .fieldError{color:var(--danger);font-weight:500}
    .requiredMark{color:var(--accent);margin-left:3px;font-weight:500}
    label{display:block;font-size:.8rem;font-weight:500;letter-spacing:0;color:var(--heading)}
    input,textarea,select{width:100%;border:1px solid var(--field-border);border-radius:var(--field-radius);background:var(--field-bg);color:var(--field-text);font-size:.95rem;padding:12px 14px;min-height:46px;outline:none;transition:border-color .15s,box-shadow .15s}
    .rstk-phone-input{display:grid;grid-template-columns:minmax(94px,116px) minmax(0,1fr);gap:8px;align-items:stretch}
    .rstk-phone-input select,.rstk-phone-input input{min-width:0}
    .rstk-phone-input select{padding-left:10px;padding-right:10px}
    .rstk-phone-input[data-phone-country-hidden]{grid-template-columns:minmax(0,1fr)}
    .rstk-phone-input[data-phone-country-hidden] select{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
    .timezoneStep .timezoneControl select{appearance:none;-webkit-appearance:none;padding-right:42px;line-height:1.2;background-image:linear-gradient(45deg,transparent 50%,var(--field-text) 50%),linear-gradient(135deg,var(--field-text) 50%,transparent 50%);background-position:calc(100% - 16px) calc(50% - 2px),calc(100% - 11px) calc(50% - 2px);background-size:5px 5px,5px 5px;background-repeat:no-repeat}
    textarea{resize:vertical}
    input:not([type='radio']):not([type='checkbox']):focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
    .options{display:grid;gap:8px}
    .option{display:flex;align-items:center;gap:10px;min-height:44px;border:1px solid var(--field-border);border-radius:var(--field-radius);background:var(--field-bg);padding:9px 12px;font-size:.92rem;font-weight:450;cursor:pointer;transition:border-color .15s}
    .option:hover{border-color:var(--accent)}
    .option:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--field-bg))}
    .option input[type='radio'],.option input[type='checkbox']{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:19px;min-width:19px;height:19px;min-height:19px;margin:0;padding:0;border:1.5px solid var(--field-border);background:var(--field-bg);box-shadow:none;flex:0 0 auto;display:inline-grid;place-content:center;cursor:pointer}
    .option input[type='radio']{border-radius:50%}
    .option input[type='checkbox']{border-radius:min(6px,var(--field-radius))}
    .option input[type='radio']::after{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent);transform:scale(0);transition:transform .15s}
    .option input[type='radio']:checked{border-color:var(--accent);background:var(--field-bg)}
    .option input[type='radio']:checked::after{transform:scale(1)}
    .option input[type='checkbox']:checked{border-color:var(--accent);background:var(--accent)}
    .option input[type='checkbox']:checked::after{content:'';width:5px;height:9px;border:solid var(--button-text);border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg)}
    .option input[type='radio']:focus,.option input[type='checkbox']:focus{outline:none;box-shadow:none}
    .formActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px}
    button.submit,button.secondary{min-height:48px;border-radius:var(--slot-radius);font-size:.95rem;font-weight:600;cursor:pointer;transition:filter .15s,opacity .15s}
    button.submit{border:1px solid var(--accent);background:var(--accent);color:var(--button-text);flex:1 1 180px}
    button.submit:not(:disabled):hover{filter:brightness(.95)}
    button.secondary{border:1px solid var(--line);background:var(--control-bg);color:var(--accent);padding:0 16px}
    button.secondary:hover{background:var(--accent-soft)}
    button:disabled{opacity:.5;cursor:not-allowed}
    .message{min-height:20px;font-size:.86rem;font-weight:450;color:var(--muted)}
    .message.error{color:var(--danger)}
    .message.ok{color:var(--ok)}
    .message.preview{color:var(--muted)}
    .message .paymentAction{display:inline-flex;align-items:center;justify-content:center;min-height:42px;margin:10px auto 0;border:1px solid var(--accent);border-radius:var(--slot-radius);background:var(--accent);color:var(--button-text);font-weight:650;text-decoration:none;padding:8px 16px}
    .loading{opacity:.62;pointer-events:none}
    .successPane{display:none;grid-column:1 / -1;min-height:420px;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:clamp(36px,6vw,80px) clamp(24px,4vw,48px)}
    .shell.bookingDone{grid-template-columns:1fr}
    .shell.bookingDone .intro,.shell.bookingDone .calendarPane,.shell.bookingDone .timesPane{display:none}
    .shell.bookingDone .successPane{display:flex}
    .shell.bookingDisqualified{grid-template-columns:1fr}
    .shell.bookingDisqualified .intro,.shell.bookingDisqualified .calendarPane,.shell.bookingDisqualified .timesPane{display:none}
    .shell.bookingDisqualified .successPane{display:flex}
    .shell.bookingDisqualified .successIcon{background:var(--control-bg);color:var(--muted)}
    .shell.formGate .selectedDate,.shell.formGate .changeSlot{display:none}
    .shell.formGate form{border-top:0;padding-top:0;gap:14px}
    .shell.formGate .formPage{gap:12px}
    .shell.formGate .calContentVideo video{max-height:min(48vh,520px)}
    .shell.formCompleted .formHeader,.shell.formCompleted .formPage,.shell.formCompleted [data-form-next],.shell.formCompleted [data-form-back]{display:none}
    .successCard{max-width:480px;display:flex;flex-direction:column;align-items:center;gap:18px}
    .successCard .successIcon{width:74px;height:74px;border-radius:999px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
    .successCard .successMessage{margin:0;font-size:1.22rem;line-height:1.55;font-weight:600;color:var(--heading);white-space:pre-line}
    .successContent{width:100%;display:grid;gap:14px;text-align:left}
    .successContent[hidden]{display:none}
    .successContent .calendarContentBlock{gap:10px}
    body.rstk-calendar-theme-night .shell{border-radius:16px;background:var(--surface);box-shadow:0 32px 90px -60px color-mix(in srgb,var(--heading) 42%,transparent)}
    body.rstk-calendar-theme-night .intro,body.rstk-calendar-theme-night .calendarPane,body.rstk-calendar-theme-night form{background:var(--surface)}
    body.rstk-calendar-theme-night .timesPane{background:var(--bg)}
    body.rstk-calendar-theme-night .avatar{border-radius:var(--field-radius)}
    body.rstk-calendar-theme-night .navBtn{width:40px;height:40px;border:1px solid var(--line);border-radius:var(--field-radius);background:var(--control-bg);color:var(--muted)}
    body.rstk-calendar-theme-night .day{width:44px;height:44px;border:1px solid transparent;border-radius:var(--field-radius);background:var(--control-bg);color:var(--muted);font-weight:650}
    body.rstk-calendar-theme-night .day.available{border-color:var(--accent);background:transparent;color:var(--heading)}
    body.rstk-calendar-theme-night .day.available::after{content:'';position:absolute;left:50%;bottom:7px;width:4px;height:4px;border-radius:999px;background:var(--accent);transform:translateX(-50%)}
    body.rstk-calendar-theme-night .day.selected{border-color:var(--accent);background:var(--accent);color:var(--selected-text)}
    body.rstk-calendar-theme-night .day.selected::after{background:var(--selected-text)}
    body.rstk-calendar-theme-night .slot{min-height:42px;border-color:var(--line);background:var(--slot-bg);color:var(--slot-text);font-weight:650}
    body.rstk-calendar-theme-agenda .shell{border-radius:0;box-shadow:none}
    body.rstk-calendar-theme-agenda .intro,body.rstk-calendar-theme-agenda .calendarPane,body.rstk-calendar-theme-agenda .timesPane{background:transparent}
    body.rstk-calendar-theme-agenda .calendarPane{gap:18px}
    body.rstk-calendar-theme-agenda .day{width:50px;height:50px;border-radius:4px;background:var(--control-bg);font-weight:600}
    body.rstk-calendar-theme-agenda .day.available{background:var(--slot-bg)}
    body.rstk-calendar-theme-agenda .day.selected{background:var(--heading);color:var(--surface)}
    body.rstk-calendar-theme-agenda .slot,body.rstk-calendar-theme-agenda input,body.rstk-calendar-theme-agenda textarea,body.rstk-calendar-theme-agenda select,body.rstk-calendar-theme-agenda .option,body.rstk-calendar-theme-agenda button.submit,body.rstk-calendar-theme-agenda button.secondary{border-radius:4px}
    body.rstk-calendar-theme-minimal .shell{border-color:transparent;background:transparent;box-shadow:none}
    body.rstk-calendar-theme-minimal .intro,body.rstk-calendar-theme-minimal .calendarPane,body.rstk-calendar-theme-minimal .timesPane{background:transparent}
    body.rstk-calendar-theme-minimal .intro{border-right:0}
    body.rstk-calendar-theme-minimal .timesPane{border-left-color:color-mix(in srgb,var(--line) 70%,transparent)}
    body.rstk-calendar-theme-minimal .day{border-radius:0}
    body.rstk-calendar-theme-minimal .day.available:hover,body.rstk-calendar-theme-minimal .day.available:focus-visible{background:transparent;box-shadow:inset 0 -2px 0 var(--accent)}
    body.rstk-calendar-theme-minimal .day.selected{background:transparent;color:var(--accent);box-shadow:inset 0 -2px 0 var(--accent)}
    body.rstk-calendar-theme-minimal .slot,body.rstk-calendar-theme-minimal input,body.rstk-calendar-theme-minimal textarea,body.rstk-calendar-theme-minimal select,body.rstk-calendar-theme-minimal .option{border-color:var(--line);border-radius:999px;background:transparent}
    @media (max-width:1100px){.shell,.shell.dateSelected,.shell.bookingActive{grid-template-columns:300px minmax(0,1fr)}.shell.noIntro,.shell.noIntro.dateSelected,.shell.noIntro.bookingActive{grid-template-columns:minmax(0,1fr)}.shell.dateSelected .calendarPane{display:none}.timesPane{border-left:1px solid var(--line);border-top:0;max-width:none;width:auto}.shell.dateSelected .timesPane{padding:clamp(28px,3vw,38px) clamp(24px,2.5vw,30px)}.slotList{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
    @media (max-width:760px){.page{width:100%;padding:0;place-items:stretch}.shell,.shell.dateSelected,.shell.bookingActive,.shell.noIntro,.shell.noIntro.dateSelected,.shell.noIntro.bookingActive{grid-template-columns:1fr;min-height:100vh;border:0;border-radius:0;box-shadow:none}.shell.dateSelected .intro,.shell.dateSelected .calendarPane,.shell.bookingActive .intro,.shell.bookingActive .calendarPane{display:none}.shell.dateSelected .timesPane,.shell.bookingActive .timesPane{grid-column:auto;border-top:0}.intro,.calendarPane,.timesPane{padding:26px 22px;border-right:0;border-left:0}.intro{gap:14px}.calendarPane,.timesPane{border-top:1px solid var(--line)}.avatar{width:72px;height:72px;font-size:2rem;border-radius:16px}.days{gap:6px 2px}.day,body.rstk-calendar-theme-agenda .day{width:40px;height:40px;max-width:100%}.slotList{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));max-height:none}input,textarea,select{font-size:16px;min-height:48px}.rstk-phone-input{grid-template-columns:minmax(0,1fr)}.calPaymentBlock{grid-template-columns:1fr}.formActions button.submit{flex:1 1 100%}}
    @media (max-width:430px){.page{padding:0}.intro,.calendarPane,.timesPane{padding:22px 18px}.day,body.rstk-calendar-theme-agenda .day{width:38px;height:38px;max-width:100%}.weekdays{font-size:.66rem}.slotList{grid-template-columns:1fr}h1{font-size:1.5rem}h2{font-size:1.2rem}}
    .shell.bookingActive,.shell.formGate{width:min(100%,640px);min-height:0;grid-template-columns:minmax(0,1fr);align-content:start;justify-content:center;overflow:visible}
    body.rstk-calendar-embedded .shell.bookingActive,body.rstk-calendar-embedded .shell.formGate{min-height:0}
    .shell.bookingActive .intro,.shell.formGate .intro,.shell.bookingActive .calendarPane,.shell.formGate .calendarPane{display:none}
    .shell.bookingActive .timesPane,.shell.formGate .timesPane{grid-column:1;border-left:0;border-top:0;max-width:none;width:100%;padding:clamp(22px,3vw,32px) clamp(22px,3vw,34px);gap:12px}
    .shell.bookingActive .selectedDate{min-height:0;gap:5px}
    .shell.bookingActive .selectedDate p{line-height:1.45}
    .shell.bookingActive form,.shell.formGate form{border-top:0;padding-top:0;gap:13px}
    .shell.bookingActive .formHeader,.shell.formGate .formHeader{margin-bottom:2px;gap:6px}
    .shell.bookingActive .formPage,.shell.formGate .formPage{gap:12px}
    .shell.bookingActive .calendarQuestion,.shell.formGate .calendarQuestion{gap:6px}
    .shell.bookingActive textarea,.shell.formGate textarea{min-height:88px}
    @media (max-width:760px){.shell.bookingActive,.shell.formGate,.shell.noIntro.bookingActive,.shell.noIntro.formGate{width:100%;min-height:0;grid-template-columns:1fr}.shell.bookingActive .timesPane,.shell.formGate .timesPane{padding:22px 18px;border-top:0}.shell.bookingActive form,.shell.formGate form{gap:12px}}
  </style>
</head>
<body class="${[embedded ? 'rstk-calendar-embedded' : '', preview ? 'rstk-calendar-preview' : '', `rstk-calendar-layout-${layout}`, `rstk-calendar-theme-${widgetTheme}`].filter(Boolean).join(' ')}">
  <main class="page">
    <div class="shell layout-${escapeHtml(layout)}${showSidebar ? '' : ' noIntro'}">
      ${introHtml}

      <section class="calendarPane" data-calendar-pane>
        <div class="paneTitle">
          <h2>Selecciona fecha</h2>
          <p>Elige un día disponible para continuar.</p>
        </div>
        <div class="monthBar">
          <button class="navBtn" type="button" data-prev aria-label="Mes anterior">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <strong data-month-label></strong>
          <button class="navBtn" type="button" data-next aria-label="Mes siguiente">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="weekdays" aria-hidden="true">
          <span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span>
        </div>
        <div class="days" data-days></div>
        <div class="timezone" data-calendar-timezone${effectiveBookingDisplay.allowTimezoneSelection ? ' hidden' : ''}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          <span class="timezoneControl">
            <span>Zona horaria</span>
            <strong data-timezone></strong>
          </span>
        </div>
      </section>

      <section class="timesPane">
        <div class="selectedDate">
          <h3 data-selected-title>Selecciona una fecha</h3>
          <p data-selected-subtitle>Los horarios aparecerán aquí.</p>
          <button class="changeSlot" type="button" data-change-slot aria-label="Cambiar fecha"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-change-label>Cambiar fecha</span></button>
        </div>
        ${effectiveBookingDisplay.allowTimezoneSelection ? `<div class="timezone timezoneStep" data-timezone-step hidden>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          <span class="timezoneControl">
            <span>Confirma tu zona horaria</span>
            <select data-timezone-select aria-label="Confirmar zona horaria"></select>
          </span>
        </div>` : ''}
        <div class="slotList" data-slots>
          <div class="slotEmpty">Elige un día con disponibilidad.</div>
        </div>
        ${renderCalendarBookingForm(payload.bookingForm)}
      </section>

      <section class="successPane" data-success-pane>
        <div class="successCard">
          <div class="successIcon" data-success-icon aria-hidden="true">
            <svg viewBox="0 0 24 24" width="36" height="36"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <p class="successMessage" data-success-message></p>
          <div class="successContent" data-success-content hidden></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    (() => {
      const calendar = ${jsonForInlineScript(payload)};
      const shell = document.querySelector('.shell');
      const rootStyle = document.documentElement.style;
      const avatar = document.querySelector('[data-calendar-avatar]');
      const styleDefaults = calendar.styleDefaults || {};
      const styleVarMap = {
        accent: '--accent',
        background: '--bg',
        surface: '--surface',
        text: '--heading',
        muted: '--muted',
        line: '--line',
        controlBg: '--control-bg',
        slotBg: '--slot-bg',
        slotText: '--slot-text',
        selectedText: '--selected-text',
        fieldBg: '--field-bg',
        fieldText: '--field-text',
        fieldBorder: '--field-border',
        buttonText: '--button-text'
      };
      const styleLayouts = ['classic', 'compact', 'stacked'];
      const isEmbeddedCalendar = document.body.classList.contains('rstk-calendar-embedded');
      let embedHeightFrame = 0;
      const notifyEmbedHeight = () => {
        if (!isEmbeddedCalendar || window.parent === window) return;
        if (embedHeightFrame) window.cancelAnimationFrame(embedHeightFrame);
        embedHeightFrame = window.requestAnimationFrame(() => {
          embedHeightFrame = 0;
          const shellRect = shell ? shell.getBoundingClientRect() : null;
          const height = Math.ceil(Math.max(
            document.documentElement ? document.documentElement.scrollHeight : 0,
            document.body ? document.body.scrollHeight : 0,
            shell ? shell.scrollHeight : 0,
            shellRect ? shellRect.height : 0
          ));
          if (height > 0) {
            window.parent.postMessage({ type: 'ristak:calendar-embed-height', height: height + 2 }, '*');
          }
        });
      };
      const cleanStyleValue = (value) => {
        const text = String(value || '').trim();
        return text && text.length < 180 && !/[;{}<>]/.test(text) ? text : '';
      };
      const cleanLayout = (value) => {
        const text = String(value || '').trim().toLowerCase();
        return styleLayouts.includes(text) ? text : 'classic';
      };
      const fontStacks = {
        system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        modern: '"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        serif: 'Georgia,"Times New Roman",serif',
        mono: '"SFMono-Regular","Roboto Mono","Cascadia Code",monospace'
      };
      const cleanFontFamily = (value) => {
        const text = String(value || '').trim().toLowerCase();
        return fontStacks[text] || fontStacks.system;
      };
      const cleanImageUrl = (value) => {
        const text = String(value || '').trim();
        if (!text || text.length > 1200 || /[<>"']/g.test(text)) return '';
        if (/^\\/(?!\\/)/.test(text)) return text;
        try {
          const parsed = new URL(text);
          return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
        } catch {
          return '';
        }
      };
      const getCompletionRedirectUrl = () => {
        const completion = calendar.bookingCompletion || {};
        if (completion.action !== 'redirect') return '';
        const text = String(completion.redirectUrl || '').trim();
        if (!text) return '';
        if (/^\\/(?!\\/)/.test(text)) return text;
        try {
          const parsed = new URL(text, window.location.origin);
          return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch {
          return '';
        }
      };
      const setAvatarImage = (value) => {
        if (!avatar) return;
        const imageUrl = cleanImageUrl(value);
        avatar.textContent = '';
        if (imageUrl) {
          const image = document.createElement('img');
          image.alt = '';
          image.src = imageUrl;
          avatar.appendChild(image);
          return;
        }
        const initial = document.createElement('span');
        initial.dataset.calendarInitial = 'true';
        initial.textContent = String(calendar.name || 'R').trim()[0] || 'R';
        avatar.appendChild(initial);
      };
      const applyEmbedStyle = (style = {}) => {
        const designMode = style.designMode === 'original' ? 'original' : 'custom';
        const isEmbeddedCalendar = document.body.classList.contains('rstk-calendar-embedded');
        Object.entries(styleVarMap).forEach(([key, variable]) => {
          const hasExplicitValue = Object.prototype.hasOwnProperty.call(style, key);
          if (isEmbeddedCalendar && (key === 'background' || key === 'surface') && !hasExplicitValue) return;
          const fallback = cleanStyleValue(styleDefaults[key]);
          const value = designMode === 'custom' ? cleanStyleValue(style[key]) || fallback : fallback;
          if (value) rootStyle.setProperty(variable, value);
        });
        const slotRadius = designMode === 'custom' ? Number(style.slotRadius || styleDefaults.slotRadius || 8) : Number(styleDefaults.slotRadius || 8);
        const fieldRadius = designMode === 'custom' ? Number(style.fieldRadius || styleDefaults.fieldRadius || 8) : Number(styleDefaults.fieldRadius || 8);
        rootStyle.setProperty('--slot-radius', Math.min(32, Math.max(0, Number.isFinite(slotRadius) ? slotRadius : 8)) + 'px');
        rootStyle.setProperty('--field-radius', Math.min(32, Math.max(0, Number.isFinite(fieldRadius) ? fieldRadius : 8)) + 'px');
        rootStyle.setProperty('--font-family', cleanFontFamily(style.fontFamily || style.font_family || styleDefaults.fontFamily));
        const layout = cleanLayout(style.layout || styleDefaults.layout || calendar.layout);
        if (shell) {
          styleLayouts.forEach(name => shell.classList.toggle('layout-' + name, name === layout));
        }
        setAvatarImage(style.coverImage || styleDefaults.coverImage || calendar.coverImage);
        notifyEmbedHeight();
      };
      const calendarPane = document.querySelector('[data-calendar-pane]');
      const daysEl = document.querySelector('[data-days]');
      const slotsEl = document.querySelector('[data-slots]');
      const monthLabel = document.querySelector('[data-month-label]');
      const prevButton = document.querySelector('[data-prev]');
      const nextButton = document.querySelector('[data-next]');
      const timezoneLabel = document.querySelector('[data-timezone]');
      const timezoneSelect = document.querySelector('[data-timezone-select]');
      const timezoneStep = document.querySelector('[data-timezone-step]');
      const selectedTitle = document.querySelector('[data-selected-title]');
      const selectedSubtitle = document.querySelector('[data-selected-subtitle]');
      const changeSlotButton = document.querySelector('[data-change-slot]');
      const form = document.querySelector('[data-form]');
      const submit = document.querySelector('[data-submit]');
      const message = document.querySelector('[data-message]');
      const successMessageEl = document.querySelector('[data-success-message]');
      const successContentEl = document.querySelector('[data-success-content]');
      const formPages = Array.from(form ? form.querySelectorAll('[data-form-page]') : []);
      const formBackButton = form ? form.querySelector('[data-form-back]') : null;
      const formNextButton = form ? form.querySelector('[data-form-next]') : null;
      const formProgress = form ? form.querySelector('[data-form-progress]') : null;
      const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      let selectedSlot = '';
      let selectedDateKey = '';
      let visibleMonth = new Date();
      let formPageIndex = 0;
      let immediateDisqualified = false;
      // (CAL-FLOW) Formulario primero: el formulario es un "gate" antes del calendario.
      const formFirst = !!(calendar.bookingDisplay && calendar.bookingDisplay.formPosition === 'before');
      let gatePassed = false;
      let gateResponses = {};
      let gateFormData = null;
      visibleMonth.setDate(1);
      let slotsByDate = new Map();
      const displayConfig = calendar.bookingDisplay || {};
      const fallbackTimezones = ['America/Mexico_City','America/Ciudad_Juarez','America/Monterrey','America/Tijuana','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Bogota','America/Lima','America/Santiago','America/Argentina/Buenos_Aires','Europe/Madrid','UTC'];
      const isSupportedTimezone = (value) => {
        try {
          if (!value) return false;
          new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
          return true;
        } catch {
          return false;
        }
      };
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      let timezone = isSupportedTimezone(displayConfig.defaultTimezone)
        ? displayConfig.defaultTimezone
        : isSupportedTimezone(calendar.defaultTimezone) ? calendar.defaultTimezone : 'UTC';

      const pad = (value) => String(value).padStart(2, '0');
      const dateKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      const monthKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const setMessage = (text, type = '') => {
        message.textContent = text || '';
        message.className = 'message' + (type ? ' ' + type : '');
      };

      const renderPaymentMessage = (payment, onStartPolling) => {
        if (!message) return;
        message.textContent = '';
        message.className = 'message';
        const text = document.createElement('span');
        text.textContent = payment.pendingMessage || payment.message || 'Completa el pago para agendar.';
        message.appendChild(text);
        if (!payment.paymentUrl) return;
        const link = document.createElement('a');
        link.href = payment.paymentUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'paymentAction';
        link.textContent = payment.buttonText || 'Completar pago';
        link.addEventListener('click', () => { onStartPolling(); }, { once: true });
        message.appendChild(link);
      };

      const getPaymentStatus = async (publicPaymentId) => {
        const response = await fetch('/api/sites/public/payments/' + encodeURIComponent(publicPaymentId) + '/status', {
          headers: { 'Accept': 'application/json' }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || 'No se pudo verificar el pago');
        }
        return payload && payload.data ? payload.data : {};
      };

      const waitForCalendarPayment = (payment) => new Promise((resolve, reject) => {
        if (!payment || !payment.publicPaymentId || !payment.paymentUrl) {
          reject(new Error('No se pudo preparar el pago. Intenta de nuevo.'));
          return;
        }
        let started = false;
        let finished = false;
        let attempts = 0;
        const checkStatus = async () => {
          if (finished) return;
          try {
            const status = await getPaymentStatus(payment.publicPaymentId);
            if (status.paid) {
              finished = true;
              setMessage(payment.paidMessage || 'Pago confirmado. Agendando...', 'ok');
              resolve(status);
              return;
            }
            attempts += 1;
            setMessage('Esperando confirmación del pago...');
            window.setTimeout(checkStatus, 2500);
          } catch (error) {
            attempts += 1;
            if (attempts > 80) {
              finished = true;
              reject(error);
              return;
            }
            window.setTimeout(checkStatus, 2500);
          }
        };
        const startPolling = () => {
          if (started || finished) return;
          started = true;
          setMessage('Esperando confirmación del pago...');
          checkStatus();
        };
        renderPaymentMessage(payment, startPolling);
      });

      const getDisqualificationContent = (rule) => {
        const formDq = (calendar.bookingForm && calendar.bookingForm.disqualification) || {};
        const messageText = (rule && rule.message) || formDq.message || 'Por ahora no podemos agendar tu cita.';
        const html = rule && rule.message ? '' : (formDq.html || '');
        return { message: messageText, html };
      };

      const getSupportedTimezones = () => {
        let supported = [];
        try {
          supported = typeof Intl.supportedValuesOf === 'function'
            ? Intl.supportedValuesOf('timeZone')
            : [];
        } catch {
          supported = [];
        }
        return Array.from(new Set([timezone, browserTimezone, ...supported, ...fallbackTimezones]))
          .filter(isSupportedTimezone)
          .sort((a, b) => a.localeCompare(b));
      };

      const renderTimezoneControl = () => {
        if (timezoneLabel) timezoneLabel.textContent = timezone;
        if (!timezoneSelect) return;
        const options = getSupportedTimezones();
        timezoneSelect.innerHTML = options
          .map(option => '<option value="' + option + '"' + (option === timezone ? ' selected' : '') + '>' + option + '</option>')
          .join('');
        timezoneSelect.value = timezone;
      };
      const setTimezoneConfirmationVisible = (visible) => {
        if (timezoneStep) timezoneStep.hidden = !visible;
      };

      const setStep = (step = 'calendar') => {
        if (!shell) return;
        shell.classList.toggle('dateSelected', step === 'slots');
        shell.classList.toggle('bookingActive', step === 'form');
        if (step !== 'slots') setTimezoneConfirmationVisible(false);
        if (changeSlotButton) {
          // Botón contextual para regresar un paso (intuitivo: dice QUÉ vas a cambiar):
          //  - en el formulario → "Cambiar fecha y hora" (regresa a elegir horario)
          //  - en los horarios   → "Cambiar fecha" (regresa al calendario)
          // Solo tocamos el <span> del texto para NO borrar el ícono de flecha (SVG).
          const backText = step === 'form' ? 'Cambiar fecha y hora' : 'Cambiar fecha';
          const labelEl = changeSlotButton.querySelector('[data-change-label]');
          if (labelEl) labelEl.textContent = backText;
          changeSlotButton.setAttribute('aria-label', backText);
        }
        notifyEmbedHeight();
      };

      const showSuccessScreen = (text, opts) => {
        const disqualified = !!(opts && opts.disqualified);
        const html = opts && opts.html ? String(opts.html) : '';
        if (successContentEl) {
          successContentEl.hidden = !html;
          successContentEl.innerHTML = html;
        }
        if (successMessageEl) {
          successMessageEl.hidden = !!html;
          successMessageEl.textContent = text || '';
        }
        const iconEl = document.querySelector('[data-success-icon]');
        if (iconEl) {
          iconEl.innerHTML = disqualified
            ? '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5v5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.3" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        if (form) {
          form.reset();
          form.classList.remove('visible');
        }
        if (shell) {
          shell.classList.remove('dateSelected', 'bookingActive', 'bookingDone', 'bookingDisqualified');
          shell.classList.add(disqualified ? 'bookingDisqualified' : 'bookingDone');
        }
        notifyEmbedHeight();
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) {}
      };

      const phoneDigits = (value) => String(value || '').replace(/\\D/g, '');
      const stripInternationalPrefix = (digits) => digits.startsWith('00') ? digits.slice(2) : digits;
      const normalizeMexicoPhoneDigits = (digits) => {
        const national = digits.slice(-10);
        if (national.length !== 10) return '';
        if (digits.startsWith('521') && digits.length >= 13) return '52' + national;
        if (digits.startsWith('52') && digits.length >= 12) return '52' + national;
        return '';
      };
      const composePhoneValue = (value, dialCode) => {
        const raw = String(value || '').trim();
        const digits = stripInternationalPrefix(phoneDigits(raw));
        const countryCode = phoneDigits(dialCode).slice(0, 4);
        if (digits.length < 7) return '';
        const mexicoPhone = countryCode === '52' ? normalizeMexicoPhoneDigits(digits) : '';
        if (mexicoPhone) return '+' + mexicoPhone;
        if (!countryCode || raw.startsWith('+') || raw.startsWith('00')) return '+' + digits;
        if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) return '+' + digits;
        return '+' + countryCode + digits;
      };
      const getPhoneOptionDialCode = (option) => phoneDigits(option ? option.dataset.dialCode || option.getAttribute('data-dial-code') : '').slice(0, 4);
      const getSelectedPhoneOption = (select) => select && select.selectedOptions && select.selectedOptions[0] ? select.selectedOptions[0] : null;
      const getSelectedPhoneDialCode = (select) => getPhoneOptionDialCode(getSelectedPhoneOption(select));
      const findPhoneOptionByDialPrefix = (select, digits) => {
        const options = Array.from(select && select.options ? select.options : [])
          .map(option => ({ option, dialCode: getPhoneOptionDialCode(option) }))
          .filter(item => item.dialCode && digits.startsWith(item.dialCode) && digits.length > item.dialCode.length + 6)
          .sort((a, b) => b.dialCode.length - a.dialCode.length);
        return options.length ? options[0] : null;
      };
      const stripDialCodeForInput = (digits, dialCode) => {
        const countryCode = phoneDigits(dialCode).slice(0, 4);
        if (!countryCode) return digits;
        if (countryCode === '52') {
          if (digits.startsWith('521') && digits.length >= 13) return digits.slice(3).slice(-10);
          if (digits.startsWith('52') && digits.length >= 12) return digits.slice(2).slice(-10);
        }
        if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) return digits.slice(countryCode.length);
        return digits;
      };
      const splitPhonePrefillValue = (value, select) => {
        const raw = String(value || '').trim();
        const digits = stripInternationalPrefix(phoneDigits(raw));
        if (!digits) return { countryValue: '', number: '' };
        const selectedDialCode = getSelectedPhoneDialCode(select);
        if (selectedDialCode) {
          const selectedNumber = stripDialCodeForInput(digits, selectedDialCode);
          if (selectedNumber !== digits) return { countryValue: '', number: selectedNumber };
        }
        const matched = findPhoneOptionByDialPrefix(select, digits);
        if (!matched) return { countryValue: '', number: digits };
        const number = stripDialCodeForInput(digits, matched.dialCode);
        // Legacy/autofill values often carried an accidental +1 before a LATAM local
        // number. Do not flip the account-selected LADA to +1; strip it from the input.
        const keepSelectedCountry = selectedDialCode && matched.dialCode === '1' && selectedDialCode !== '1';
        return {
          countryValue: keepSelectedCountry ? '' : matched.option.value,
          number
        };
      };
      const setPhonePrefillValue = (field, value) => {
        const input = field ? field.querySelector('[data-phone-number-input]') || field.querySelector('input[type="tel"], input') : null;
        const select = field ? field.querySelector('[data-phone-country-select]') : null;
        if (!input || String(input.value || '').trim()) return false;
        const parsed = splitPhonePrefillValue(value, select);
        if (!parsed.number) return false;
        if (select && parsed.countryValue && select.value !== parsed.countryValue) {
          select.value = parsed.countryValue;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        input.value = parsed.number;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        validateField(field);
        return true;
      };
      const optionExists = (select, countryCode) => Boolean(countryCode && select && select.querySelector('option[value="' + String(countryCode).replace(/["\\\\]/g, '\\\\$&') + '"]'));
      const detectPhoneCountry = (select) => {
        const locales = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
        for (const locale of locales) {
          const match = String(locale || '').match(/[-_]([A-Za-z]{2})\\b/);
          const country = match && match[1] ? match[1].toUpperCase() : '';
          if (optionExists(select, country)) return country;
        }
        const timezone = typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
        if (!timezone) return '';
        for (const option of Array.from(select.options || [])) {
          const timezones = String(option.dataset.timezones || '').split(',').filter(Boolean);
          if (timezones.indexOf(timezone) >= 0) return option.value;
        }
        return '';
      };
      const initPhoneCountryFields = () => {
        Array.from(form ? form.querySelectorAll('.calendarQuestion[data-field-type="phone"]') : []).forEach((field) => {
          const select = field.querySelector('[data-phone-country-select]');
          if (!select) return;
          const detectedCountry = detectPhoneCountry(select);
          if (detectedCountry) select.value = detectedCountry;
        });
      };

      const getFieldValue = (field) => {
        const type = field.getAttribute('data-field-type') || '';
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        }
        if (type === 'phone') {
          const input = field.querySelector('[data-phone-number-input]') || field.querySelector('input[type="tel"], input');
          const select = field.querySelector('[data-phone-country-select]');
          const dialCode = select && select.selectedOptions && select.selectedOptions[0]
            ? select.selectedOptions[0].dataset.dialCode || ''
            : '';
          return composePhoneValue(input ? input.value : '', dialCode);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return checked.value;
        const input = field.querySelector('input, textarea, select');
        return input ? input.value : '';
      };

      const digits = phoneDigits;
      const isValidValue = (validation, value) => {
        const text = Array.isArray(value) ? value.join(',') : String(value || '').trim();
        if (!text) return true;
        if (validation === 'email') return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(text);
        if (validation === 'phone') return digits(text).length >= 7;
        if (validation === 'number') return Number.isFinite(Number(text));
        if (validation === 'currency') return Number.isFinite(Number(text)) && Number(text) >= 0;
        if (validation === 'date') return !Number.isNaN(Date.parse(text));
        if (validation === 'url') {
          try {
            const parsed = new URL(/^https?:\\/\\//i.test(text) ? text : 'https://' + text);
            return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
          } catch {
            return false;
          }
        }
        return true;
      };

      const validationMessage = (validation) => {
        if (validation === 'email') return 'Ingresa un correo valido.';
        if (validation === 'phone') return 'Ingresa un telefono valido.';
        if (validation === 'number') return 'Ingresa un numero valido.';
        if (validation === 'currency') return 'Ingresa un monto valido.';
        if (validation === 'date') return 'Ingresa una fecha valida.';
        if (validation === 'url') return 'Ingresa una URL valida.';
        return 'Revisa esta respuesta.';
      };

      const validateField = (field) => {
        const required = field.getAttribute('data-required') === 'true';
        const validation = field.getAttribute('data-validation') || '';
        const value = getFieldValue(field);
        const empty = Array.isArray(value) ? value.length === 0 : String(value || '').trim() === '';
        const valid = (!required || !empty) && (empty || isValidValue(validation, value));
        const error = field.querySelector('.fieldError');
        if (error) {
          error.textContent = !required || !empty ? validationMessage(validation) : 'Esta respuesta es requerida.';
          error.hidden = valid;
        }
        return valid;
      };

      const cleanPrefillText = (value) => {
        const text = String(value || '').trim();
        return text.length > 240 ? text.slice(0, 240) : text;
      };
      const readStoredJson = (storage, key) => {
        try {
          const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : '';
          const parsed = raw ? JSON.parse(raw) : {};
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
          return {};
        }
      };
      const writeStoredJson = (storage, key, value) => {
        try {
          if (storage && typeof storage.setItem === 'function') storage.setItem(key, JSON.stringify(value || {}));
        } catch (_) {}
      };
      const readUrlContact = () => {
        let params = null;
        try {
          params = new URLSearchParams(window.location.search || '');
        } catch (_) {
          params = null;
        }
        const pick = (keys) => {
          if (!params) return '';
          for (const key of keys) {
            const value = cleanPrefillText(params.get(key));
            if (value) return value;
          }
          return '';
        };
        return {
          contactId: pick(['rstk_contact_id', 'contact_id', 'contactId']),
          name: pick(['full_name', 'fullName', 'full-name', 'fullname', 'name', 'nombre', 'nombre_completo', 'contact_name', 'contactName', 'rstk_name', 'rstk_full_name']),
          email: pick(['email', 'mail', 'correo', 'correo_electronico', 'contact_email', 'contactEmail', 'rstk_email']),
          phone: pick(['phone_number', 'phoneNumber', 'phone-number', 'phone', 'telefono', 'celular', 'whatsapp', 'contact_phone', 'contactPhone', 'rstk_phone'])
        };
      };
      const hasContactDraft = (contact) => Boolean(contact && (
        contact.contactId ||
        contact.name ||
        contact.fullName ||
        contact.email ||
        contact.phone
      ));
      const readStoredContact = () => {
        const local = readStoredJson(window.localStorage, 'ristak');
        const session = readStoredJson(window.sessionStorage, 'ristak');
        const urlContact = readUrlContact();
        const urlHasContact = hasContactDraft(urlContact);
        const sessionContact = {
          contactId: cleanPrefillText(session.contact_id || session.contactId),
          name: cleanPrefillText(session.contact_name || session.contactName || session.fullName || session.name),
          email: cleanPrefillText(session.contact_email || session.contactEmail || session.email),
          phone: cleanPrefillText(session.contact_phone || session.contactPhone || session.phone)
        };
        const source = urlHasContact
          ? urlContact
          : (hasContactDraft(sessionContact) ? sessionContact : local);
        return {
          contactId: cleanPrefillText(source.contactId || source.contact_id || source.contactId),
          name: cleanPrefillText(source.name || source.contact_name || source.contactName || source.fullName || source.full_name),
          email: cleanPrefillText(source.email || source.contact_email || source.contactEmail),
          phone: cleanPrefillText(source.phone || source.contact_phone || source.contactPhone),
          visitorId: cleanPrefillText(local.visitor_id || local.visitorId || session.visitor_id || session.visitorId),
          sessionId: cleanPrefillText(session.session_id || session.sessionId)
        };
      };
      const rememberCalendarContact = (contact) => {
        if (!hasContactDraft(contact)) return;
        const local = readStoredJson(window.localStorage, 'ristak');
        const session = readStoredJson(window.sessionStorage, 'ristak');
        const contactId = cleanPrefillText(contact.contactId || contact.contact_id);
        const sameContact = contactId && local.contact_id === contactId;
        const sameSessionContact = contactId && session.contact_id === contactId;
        const name = cleanPrefillText(contact.name || contact.fullName || contact.full_name);
        const email = cleanPrefillText(contact.email);
        const phone = cleanPrefillText(contact.phone);
        const apply = (target, same) => {
          if (contactId) target.contact_id = contactId;
          if (name) target.contact_name = name;
          else if (contactId && !same) target.contact_name = null;
          if (email) target.contact_email = email;
          else if (contactId && !same) target.contact_email = null;
          if (phone) target.contact_phone = phone;
          else if (contactId && !same) target.contact_phone = null;
          if (contactId) target.contact_synced_at = new Date().toISOString();
          target.contact_draft_at = new Date().toISOString();
        };
        apply(local, sameContact);
        apply(session, sameSessionContact);
        writeStoredJson(window.localStorage, 'ristak', local);
        writeStoredJson(window.sessionStorage, 'ristak', session);
      };
      const getPrefillKeyForField = (field) => {
        if (!field) return '';
        const label = field.querySelector('label');
        const haystack = [
          field.getAttribute('data-system-field-key'),
          field.getAttribute('data-field-id'),
          field.getAttribute('data-field-type'),
          field.getAttribute('data-validation'),
          label ? label.textContent : ''
        ].map(value => String(value || '').toLowerCase()).join(' ');

        if (
          haystack.includes('email') ||
          haystack.includes('correo') ||
          haystack.includes('calendar_email')
        ) return 'email';
        if (
          haystack.includes('phone_number') ||
          haystack.includes('phone-number') ||
          haystack.includes('phone number') ||
          haystack.includes('phone') ||
          haystack.includes('teléfono') ||
          haystack.includes('telefono') ||
          haystack.includes('celular') ||
          haystack.includes('mobile') ||
          haystack.includes('whatsapp') ||
          haystack.includes('calendar_phone')
        ) return 'phone';
        if (
          haystack.includes('full_name') ||
          haystack.includes('full-name') ||
          haystack.includes('full name') ||
          haystack.includes('fullname') ||
          haystack.includes('nombre completo') ||
          haystack.includes('nombre') ||
          haystack.includes('calendar_name')
        ) return 'name';
        return '';
      };
      const setPrefillValue = (field, value) => {
        if (field && (field.getAttribute('data-field-type') || '') === 'phone') return setPhonePrefillValue(field, value);
        const input = field ? field.querySelector('input:not([type="radio"]):not([type="checkbox"]), textarea') : null;
        const text = cleanPrefillText(value);
        if (!input || !text || String(input.value || '').trim()) return false;
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        validateField(field);
        return true;
      };
      const applyContactPrefill = (contact) => {
        if (!form || !contact) return false;
        const normalized = {
          name: cleanPrefillText(contact.name || contact.fullName || contact.full_name),
          email: cleanPrefillText(contact.email),
          phone: cleanPrefillText(contact.phone)
        };
        let changed = false;
        Array.from(form.querySelectorAll('.calendarQuestion')).forEach((field) => {
          const key = getPrefillKeyForField(field);
          if (!key || !normalized[key]) return;
          changed = setPrefillValue(field, normalized[key]) || changed;
        });
        if (changed) evaluateDisqualification();
        return changed;
      };
      const rememberCalendarContactDraft = () => {
        const draft = {};
        Array.from(form.querySelectorAll('.calendarQuestion')).forEach((field) => {
          const key = getPrefillKeyForField(field);
          if (!key) return;
          const value = getFieldValue(field);
          const text = cleanPrefillText(Array.isArray(value) ? value.join(', ') : value);
          if (!text) return;
          if (key === 'name') {
            draft.name = text;
            draft.fullName = text;
          } else {
            draft[key] = text;
          }
        });
        rememberCalendarContact(draft);
        return draft;
      };
      const appendContactPrefillParams = (rawUrl) => {
        const raw = String(rawUrl || '');
        if (!raw || raw.charAt(0) === '#') return raw;
        const formDraft = rememberCalendarContactDraft() || {};
        const stored = readStoredContact();
        const contact = Object.assign({}, stored, formDraft);
        if (!hasContactDraft(contact)) return raw;
        let target;
        try {
          target = new URL(raw, window.location.href);
        } catch (_) {
          return raw;
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return raw;
        let changed = false;
        const addParam = (key, value) => {
          const text = cleanPrefillText(value);
          if (!text) {
            if (target.searchParams.has(key)) {
              target.searchParams.delete(key);
              changed = true;
            }
            return;
          }
          if (target.searchParams.get(key) === text) return;
          target.searchParams.set(key, text);
          changed = true;
        };
        addParam('rstk_contact_id', contact.contactId);
        addParam('full_name', contact.fullName || contact.name);
        addParam('email', contact.email);
        addParam('phone', contact.phone);
        addParam('phone_number', contact.phone);
        addParam('rstk_name', contact.fullName || contact.name);
        addParam('rstk_email', contact.email);
        addParam('rstk_phone', contact.phone);
        if (!changed) return raw;
        if (target.origin === window.location.origin && !/^https?:/i.test(raw) && raw.slice(0, 2) !== '//') {
          return target.pathname + target.search + target.hash;
        }
        return target.toString();
      };
      const initContactPrefill = async () => {
        const urlContact = readUrlContact();
        const urlHasContact = hasContactDraft(urlContact);
        if (urlHasContact) rememberCalendarContact(urlContact);
        rememberCalendarContactDraft();
        const stored = readStoredContact();
        applyContactPrefill(stored);
        if (urlHasContact && !stored.contactId) return;
        if (!stored.contactId && !stored.visitorId && !stored.sessionId) return;

        const params = new URLSearchParams();
        if (stored.contactId) params.set('contactId', stored.contactId);
        if (stored.visitorId) params.set('visitorId', stored.visitorId);
        if (stored.sessionId) params.set('sessionId', stored.sessionId);

        try {
          const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/contact-prefill?' + params.toString(), {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.success === false || !payload.data) return;
          const resolved = urlHasContact
            ? Object.assign({}, payload.data, stored)
            : Object.assign({}, stored, payload.data);
          rememberCalendarContact(resolved);
          applyContactPrefill(resolved);
        } catch (_) {}
      };

      const getPageFields = (pageIndex = formPageIndex) => {
        const page = formPages[pageIndex];
        return page ? Array.from(page.querySelectorAll('.calendarQuestion')) : Array.from(form.querySelectorAll('.calendarQuestion'));
      };

      const findFirstInvalidPageIndex = (endIndex = formPages.length - 1) => {
        const maxIndex = Math.max(0, Math.min(endIndex, formPages.length - 1));
        for (let index = 0; index <= maxIndex; index += 1) {
          if (!getPageFields(index).every(validateField)) return index;
        }
        return -1;
      };

      const validatePagesThrough = (endIndex = formPages.length - 1) => {
        const invalidPageIndex = findFirstInvalidPageIndex(endIndex);
        if (invalidPageIndex < 0) return true;
        formPageIndex = invalidPageIndex;
        renderFormPage();
        const firstInvalid = getPageFields(invalidPageIndex).find(field => !validateField(field));
        const focusTarget = firstInvalid ? firstInvalid.querySelector('input, textarea, select, button') : null;
        if (focusTarget && typeof focusTarget.focus === 'function') {
          try { focusTarget.focus({ preventScroll: true }); } catch (_) { focusTarget.focus(); }
        }
        try { form.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
        return false;
      };

      const validateCurrentPage = () => validatePagesThrough(formPageIndex);
      const validateAllPages = () => validatePagesThrough(formPages.length - 1);

      const renderFormPage = () => {
        if (!formPages.length) return;
        formPageIndex = Math.max(0, Math.min(formPageIndex, formPages.length - 1));
        formPages.forEach((page, index) => {
          page.hidden = index !== formPageIndex;
        });
        if (formBackButton) formBackButton.hidden = formPageIndex === 0;
        if (formNextButton) formNextButton.hidden = formPageIndex >= formPages.length - 1;
        if (submit) submit.hidden = formPages.length > 1 && formPageIndex < formPages.length - 1;
        if (formProgress) formProgress.textContent = 'Pantalla ' + (formPageIndex + 1) + ' de ' + formPages.length;
        notifyEmbedHeight();
      };

      const collectResponses = () => {
        const responses = {};
        Array.from(form.querySelectorAll('.calendarQuestion')).forEach((field) => {
          responses[field.getAttribute('data-field-id')] = getFieldValue(field);
        });
        return responses;
      };

      const getZonedParts = (value) => {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).formatToParts(new Date(value));
        const record = {};
        parts.forEach(part => {
          if (part.type !== 'literal') record[part.type] = part.value;
        });
        return record.year + '-' + record.month + '-' + record.day;
      };

      const formatDay = (iso) => new Intl.DateTimeFormat('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: timezone
      }).format(new Date(iso));

      const formatCalendarDate = (date) => new Intl.DateTimeFormat('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(date);

      const formatTime = (iso) => new Intl.DateTimeFormat('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: timezone
      }).format(new Date(iso));

      const setLoading = (loading) => {
        calendarPane.classList.toggle('loading', loading);
        slotsEl.classList.toggle('loading', loading);
      };

      const resetForm = (step = 'calendar') => {
        selectedSlot = '';
        setStep(step);
        form.classList.remove('visible');
        form.reset();
        // Availability reloads reset the form; restore known contact data immediately after.
        applyContactPrefill(readStoredContact());
        formPageIndex = 0;
        renderFormPage();
        submit.disabled = true;
        submit.textContent = 'Selecciona un horario';
        setMessage('');
      };

      const renderMonth = () => {
        monthLabel.textContent = monthNames[visibleMonth.getMonth()] + ' ' + visibleMonth.getFullYear();
        const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
        const last = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0);
        const cells = [];

        for (let i = 0; i < first.getDay(); i += 1) cells.push(null);
        for (let day = 1; day <= last.getDate(); day += 1) {
          cells.push(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), day));
        }
        while (cells.length % 7 !== 0) cells.push(null);

        daysEl.innerHTML = cells.map((date) => {
          if (!date) return '<span class="day outside"></span>';
          const key = dateKey(date);
          const hasSlots = (slotsByDate.get(key) || []).length > 0;
          const isPast = date < today;
          const classes = [
            'day',
            hasSlots && !isPast ? 'available' : '',
            key === selectedDateKey ? 'selected' : '',
            key === dateKey(today) ? 'today' : ''
          ].filter(Boolean).join(' ');
          return '<button type="button" class="' + classes + '" data-date="' + key + '"' + (!hasSlots || isPast ? ' disabled' : '') + '>' + date.getDate() + '</button>';
        }).join('');
      };

      const isSelectableDateKey = (key) => {
        if (!key || !key.startsWith(monthKey(visibleMonth))) return false;
        const slots = slotsByDate.get(key) || [];
        if (!slots.length) return false;
        const [year, month, day] = key.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setHours(0, 0, 0, 0);
        return date >= today;
      };

      const getNearestAvailableDateKey = () => Array.from(slotsByDate.keys())
        .filter(isSelectableDateKey)
        .sort()[0] || '';

      const renderSlotsForDate = (key) => {
        const slots = slotsByDate.get(key) || [];
        resetForm(key ? 'slots' : 'calendar');
        setTimezoneConfirmationVisible(!!key);

        if (!key) {
          selectedTitle.textContent = 'Selecciona una fecha';
          selectedSubtitle.textContent = 'Los horarios aparecerán aquí.';
          slotsEl.innerHTML = '<div class="slotEmpty">Elige un día con disponibilidad.</div>';
          return;
        }

        const [year, month, day] = key.split('-').map(Number);
        const selectedDate = new Date(year, month - 1, day);
        selectedTitle.textContent = formatCalendarDate(selectedDate);
        selectedSubtitle.textContent = slots.length ? 'Elige un horario disponible.' : 'No hay horarios en este día.';

        if (!slots.length) {
          slotsEl.innerHTML = '<div class="slotEmpty">No hay horarios disponibles este día.</div>';
          return;
        }

        slotsEl.innerHTML = slots.map(slot => '<button type="button" class="slot" data-slot="' + slot + '">' + formatTime(slot) + '</button>').join('');
        notifyEmbedHeight();
      };

      const ingestSlots = (days) => {
        const next = new Map();
        (Array.isArray(days) ? days : []).forEach(day => {
          (Array.isArray(day.slots) ? day.slots : []).forEach(slot => {
            const key = getZonedParts(slot);
            if (!next.has(key)) next.set(key, []);
            next.get(key).push(slot);
          });
        });
        slotsByDate = next;
        renderTimezoneControl();
      };
      const readCookie = (name) => {
        const prefix = name + '=';
        const entry = document.cookie.split('; ').find(item => item.indexOf(prefix) === 0);
        return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
      };
      const readSiteMetaParameters = () => {
        try {
          const raw = new URL(window.location.href).searchParams.get('metaCalData') || '';
          const parsed = raw ? JSON.parse(raw) : {};
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
          return {};
        }
      };
      const getMetaEventPayload = () => ({
        pageUrl: window.location.href,
        referrer: document.referrer,
        params: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
        // Override del evento Meta propagado por el sitio (sitio = master del calendario embebido).
        siteEventName: new URL(window.location.href).searchParams.get('metaCalEvent') || '',
        siteEventParameters: readSiteMetaParameters(),
        fbp: readCookie('_fbp'),
        fbc: readCookie('_fbc')
      });
      const trackCalendarMetaEvent = (metaEvent = {}) => {
        if (!window.ristakMetaTrackCalendarEvent || !metaEvent || !metaEvent.eventId) return;
        window.ristakMetaTrackCalendarEvent(metaEvent.eventName, metaEvent.eventId, {
          status: metaEvent.status || 'booked',
          conversion_type: 'appointment_booked',
          appointment_id: metaEvent.appointmentId || ''
        });
      };

      window.addEventListener('message', (event) => {
        const data = event.data || {};
        if (!data || data.type !== 'ristak:calendar-embed-style') return;
        applyEmbedStyle(data.style || {});
      });
      applyEmbedStyle(styleDefaults);

      slotsEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-slot]');
        if (!button) return;
        selectedSlot = button.getAttribute('data-slot') || '';
        slotsEl.querySelectorAll('.slot').forEach(item => item.classList.remove('selected'));
        button.classList.add('selected');
        setStep('form');
        form.classList.add('visible');
        formPageIndex = 0;
        renderFormPage();
        evaluateDisqualification();
        if (formFirst && gatePassed && submit) submit.hidden = false;
        submit.disabled = false;
        submit.textContent = calendar.preview ? 'Vista previa sin agendar' : 'Agendar cita';
        selectedTitle.textContent = 'Confirma tu cita';
        selectedSubtitle.textContent = formatDay(selectedSlot) + ' a las ' + formatTime(selectedSlot) + ' | Zona horaria: ' + timezone;
        setMessage('');
      });

      changeSlotButton && changeSlotButton.addEventListener('click', () => {
        setMessage('');
        if (shell && shell.classList.contains('bookingActive')) {
          form.classList.remove('visible');
          if (selectedDateKey) {
            renderSlotsForDate(selectedDateKey);
          } else {
            renderSlotsForDate('');
          }
          return;
        }
        resetForm('calendar');
      });

      formNextButton && formNextButton.addEventListener('click', () => {
        if (!validateCurrentPage()) return;
        formPageIndex = Math.min(formPageIndex + 1, formPages.length - 1);
        renderFormPage();
      });

      formBackButton && formBackButton.addEventListener('click', () => {
        formPageIndex = Math.max(formPageIndex - 1, 0);
        renderFormPage();
      });

      const handleCalendarContactDraftEdit = (event) => {
        const target = event.target;
        if (!target || !target.closest || !target.closest('.calendarQuestion')) return;
        rememberCalendarContactDraft();
      };
      form.addEventListener('input', handleCalendarContactDraftEdit);
      form.addEventListener('change', handleCalendarContactDraftEdit);

      daysEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-date]');
        if (!button || button.disabled) return;
        selectedDateKey = button.getAttribute('data-date') || '';
        renderMonth();
        renderSlotsForDate(selectedDateKey);
      });

      const loadSlots = async () => {
        renderMonth();
        setLoading(true);
        try {
          const start = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
          const end = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0);
          const params = new URLSearchParams({
            startDate: dateKey(start),
            endDate: dateKey(end),
            timezone
          });
          const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/free-slots?' + params.toString());
          const payload = await response.json();
          if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudieron cargar horarios');
          ingestSlots(payload.data || []);
          renderMonth();
          // (CAL-FLOW) Durante el "gate" (formulario primero sin completar) no cambiamos de paso.
          if (!(formFirst && !gatePassed)) {
            if (isSelectableDateKey(selectedDateKey)) {
              renderSlotsForDate(selectedDateKey);
            } else {
              selectedDateKey = getNearestAvailableDateKey();
              renderMonth();
              renderSlotsForDate('');
            }
          } else if (!isSelectableDateKey(selectedDateKey)) {
            selectedDateKey = getNearestAvailableDateKey();
            renderMonth();
          }
        } catch (error) {
          slotsByDate = new Map();
          renderMonth();
          slotsEl.innerHTML = '<div class="slotEmpty">No se pudieron cargar horarios. Intenta más tarde.</div>';
        } finally {
          setLoading(false);
          notifyEmbedHeight();
        }
      };

      prevButton.addEventListener('click', () => {
        visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
        selectedDateKey = '';
        loadSlots();
      });

      nextButton.addEventListener('click', () => {
        visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
        selectedDateKey = '';
        loadSlots();
      });

      timezoneSelect && timezoneSelect.addEventListener('change', () => {
        const nextTimezone = timezoneSelect.value;
        if (!isSupportedTimezone(nextTimezone) || nextTimezone === timezone) return;
        timezone = nextTimezone;
        selectedDateKey = '';
        selectedSlot = '';
        renderTimezoneControl();
        loadSlots();
      });

      // (CAL-QUAL) Evaluación de calificación en el cliente. El servidor SIEMPRE revalida;
      // aquí solo marcamos la salida para mostrar la pantalla final al terminar el formulario.
      const parseDisqualifyRule = (raw) => {
        if (!raw) return null;
        try { const r = JSON.parse(raw); return r && r.action ? r : null; } catch (_) { return null; }
      };
      const readSelectedDisqualifyRule = () => {
        if (!form) return null;
        const selected = Array.from(form.querySelectorAll('input[data-rule]:checked'));
        form.querySelectorAll('select').forEach((select) => {
          const opt = select.selectedOptions && select.selectedOptions[0];
          if (opt && opt.dataset && opt.dataset.rule) selected.push(opt);
        });
        for (const el of selected) {
          const rule = parseDisqualifyRule(el.dataset.rule);
          if (rule && rule.action === 'disqualify') return rule;
        }
        return null;
      };
      const evaluateDisqualification = () => {
        const rule = readSelectedDisqualifyRule();
        if (rule) {
          immediateDisqualified = true;
          if (submit) submit.disabled = false;
          setMessage('');
        } else if (immediateDisqualified) {
          immediateDisqualified = false;
          // En el "gate" (formulario primero) el botón "Continuar" no depende del horario.
          if (submit) submit.disabled = (formFirst && !gatePassed) ? false : !selectedSlot;
          setMessage('');
        }
      };
      form && form.addEventListener('change', evaluateDisqualification);

      // (CAL-FLOW) Muestra el formulario PRIMERO (gate). Al completarlo (Continuar) se revela el calendario.
      const enterGate = () => {
        if (!shell || !form) return;
        gatePassed = false;
        setStep('form');
        shell.classList.add('formGate');
        shell.classList.remove('formCompleted');
        form.classList.add('visible');
        formPageIndex = 0;
        renderFormPage();
        if (selectedTitle) selectedTitle.textContent = 'Cuéntanos un poco de ti';
        if (selectedSubtitle) selectedSubtitle.textContent = 'Completa para ver los horarios disponibles.';
        evaluateDisqualification();
        if (submit) { submit.disabled = false; submit.textContent = 'Continuar'; }
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        // (CAL-FLOW) GATE (formulario primero): "Continuar" valida + califica y revela el calendario.
        if (formFirst && !gatePassed) {
          if (!validateAllPages()) return;
          if (immediateDisqualified) {
            const rule = readSelectedDisqualifyRule();
            if (rule && rule.redirectUrl) {
              showSuccessScreen('Gracias por tus respuestas.', { disqualified: true });
              window.setTimeout(() => { try { window.location.assign(appendContactPrefillParams(rule.redirectUrl)); } catch (_) {} }, 1000);
              return;
            }
            const content = getDisqualificationContent(rule);
            showSuccessScreen(content.message, { disqualified: true, html: content.html });
            return;
          }
          // Guardamos las respuestas del gate (el formulario se ocultará/reiniciará en los siguientes pasos).
          gateResponses = collectResponses();
          gateFormData = new FormData(form);
          rememberCalendarContactDraft();
          gatePassed = true;
          shell.classList.remove('formGate');
          shell.classList.add('formCompleted');
          setStep('calendar');
          setMessage('');
          if (selectedTitle) selectedTitle.textContent = 'Selecciona una fecha';
          if (selectedSubtitle) selectedSubtitle.textContent = 'Elige un día disponible para continuar.';
          try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
          return;
        }

        if (!selectedSlot) {
          setMessage('Selecciona un horario primero.', 'error');
          return;
        }

        // No calificó (descalificación inmediata): mostramos el mensaje y no agendamos.
        if (immediateDisqualified) {
          const rule = readSelectedDisqualifyRule();
          if (rule && rule.redirectUrl) {
            showSuccessScreen('Gracias por tus respuestas.', { disqualified: true });
            window.setTimeout(() => { try { window.location.assign(appendContactPrefillParams(rule.redirectUrl)); } catch (_) {} }, 1000);
            return;
          }
          const content = getDisqualificationContent(rule);
          showSuccessScreen(content.message, { disqualified: true, html: content.html });
          return;
        }

        // En "formulario primero" los datos ya se validaron y recolectaron en el gate.
        if (!formFirst && !validateAllPages()) return;
        const responses = formFirst ? gateResponses : collectResponses();
        const formData = formFirst ? (gateFormData || new FormData(form)) : new FormData(form);

        if (calendar.preview) {
          setMessage('Vista previa del sitio: no se creo ninguna cita.', 'preview');
          submit.disabled = false;
          submit.textContent = 'Vista previa sin agendar';
          return;
        }

        submit.disabled = true;
        submit.textContent = 'Agendando...';
        setMessage('');

        try {
          const activeContact = readStoredContact();
          const appointmentPayload = {
            startTime: selectedSlot,
            timezone,
            sourceUrl: window.location.href,
            contactId: activeContact.contactId || '',
            visitorId: activeContact.visitorId || '',
            sessionId: activeContact.sessionId || '',
            name: formData.get('name'),
            phone: formData.get('phone'),
            email: formData.get('email'),
            notes: formData.get('notes'),
            responses,
            formId: calendar.bookingForm?.formId || '',
            formName: calendar.bookingForm?.formName || '',
            meta: Object.assign({}, getMetaEventPayload(), {
              contactId: activeContact.contactId || '',
              visitorId: activeContact.visitorId || '',
              sessionId: activeContact.sessionId || ''
            })
          };
          const postAppointment = async (payloadInput) => {
            const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/appointments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payloadInput)
            });
            const payload = await response.json().catch(() => ({}));
            return { response, payload };
          };
          let { response, payload } = await postAppointment(appointmentPayload);
          // (CAL-QUAL) El servidor descalificó: no se agendó. Mostramos el mensaje del
          // formulario (o redirigimos) en vez de un error rojo.
          if (payload && payload.disqualified) {
            selectedSlot = '';
            if (payload.redirectUrl) {
              showSuccessScreen('Gracias por tus respuestas.', { disqualified: true });
              window.setTimeout(() => { try { window.location.assign(appendContactPrefillParams(payload.redirectUrl)); } catch (_) {} }, 1200);
              return;
            }
            const fallbackContent = getDisqualificationContent(null);
            showSuccessScreen(payload.message || 'Gracias por tus respuestas. Por ahora no podemos agendar tu cita.', {
              disqualified: true,
              html: payload.html || fallbackContent.html
            });
            return;
          }
          if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudo agendar');
          if (payload.data?.paymentRequired) {
            const paymentStatus = await waitForCalendarPayment(payload.data);
            ({ response, payload } = await postAppointment({
              ...appointmentPayload,
              paymentPublicId: payload.data.publicPaymentId,
              meta: {
                ...appointmentPayload.meta,
                paymentPublicId: payload.data.publicPaymentId,
                paymentStatus: paymentStatus.status || ''
              }
            }));
            if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudo agendar');
          }
          rememberCalendarContact(payload.data?.contact);
          rememberCalendarContactDraft();
          trackCalendarMetaEvent(payload.data?.metaEvent);
          const completionRedirectUrl = getCompletionRedirectUrl();
          selectedSlot = '';
          setMessage('');
          let bookingBridge = false;
          try { bookingBridge = new URL(window.location.href).searchParams.get('bookingBridge') === '1'; } catch (_) {}
          if (bookingBridge && window.parent && window.parent !== window) {
            showSuccessScreen('Te estamos redirigiendo...');
            try { window.parent.postMessage({ type: 'ristak:calendar-booked' }, '*'); } catch (_) {}
            return;
          }
          if (completionRedirectUrl) {
            showSuccessScreen('Te estamos redirigiendo...');
            window.setTimeout(() => {
              window.location.assign(appendContactPrefillParams(completionRedirectUrl));
            }, 600);
            return;
          }
          const successText = payload.data?.message || calendar.bookingCompletion?.message || 'Listo. Tu cita quedo agendada.';
          showSuccessScreen(successText);
        } catch (error) {
          setMessage(error.message || 'No se pudo agendar la cita.', 'error');
        } finally {
          submit.disabled = !selectedSlot;
          submit.textContent = selectedSlot ? 'Agendar cita' : 'Selecciona un horario';
        }
      });

      renderTimezoneControl();
      initPhoneCountryFields();
      initContactPrefill();
      loadSlots();
      // (CAL-FLOW) Si el formulario va primero, mostramos el gate al cargar.
      if (formFirst) enterGate();
    })();
  </script>
</body>
</html>`
}

export async function listLocalCalendars({ sourcePreference = 'combined' } = {}) {
  const filters = []
  const params = []
  const normalizedSourcePreference = normalizeCalendarSourcePreference(sourcePreference)
  const connectedSources = await getConnectedSourceFlags()

  if (normalizedSourcePreference === 'ristak') {
    filters.push("source = 'ristak'")
  } else if (normalizedSourcePreference === 'ghl') {
    filters.push("source = 'ghl'")
  } else if (normalizedSourcePreference === 'google') {
    filters.push("source = 'google'")
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const rows = await db.all(`
    SELECT * FROM calendars
    ${where}
    ORDER BY is_active DESC, LOWER(name) ASC
  `, params)

  const calendars = filterCalendarsByConnection(rows.map(calendarRowToApi))
    .filter(calendar => isConfiguredGoogleCalendar(calendar, connectedSources))
  const shouldHideSeed = normalizedSourcePreference === 'combined'
    && shouldHideSeedCalendarForCombined(calendars, connectedSources)

  if (!shouldHideSeed) {
    return calendars
  }

  const seedCalendarIds = calendars.filter(isLikelySeedRistakCalendar).map(calendar => calendar.id)
  const appointmentCounts = await getCalendarAppointmentCounts(seedCalendarIds)
  const visibleCalendars = calendars.filter(calendar => !isEmptySeedRistakCalendar(calendar, appointmentCounts))
  return visibleCalendars.length ? visibleCalendars : calendars
}

export async function listGoogleLinkedLocalCalendars({ includeInactive = false } = {}) {
  const rows = await db.all(`
    SELECT *
    FROM calendars
    ${includeInactive ? '' : 'WHERE COALESCE(is_active, 1) != 0'}
    ORDER BY is_active DESC, LOWER(name) ASC
  `)

  return rows
    .map(calendarRowToApi)
    .filter(calendar => cleanString(calendar.googleCalendarId))
}

export async function updateLocalCalendar(calendarId, updateData = {}, {
  syncStatus = 'pending',
  allowGoogleSyncMetadata = false
} = {}) {
  const existing = await getLocalCalendar(calendarId)
  if (!existing) return null

  return upsertLocalCalendar({
    ...existing,
    ...updateData,
    id: existing.id,
    ghlCalendarId: existing.ghlCalendarId,
    source: existing.source
  }, {
    source: existing.source,
    syncStatus,
    allowGoogleSyncMetadata
  })
}

export async function deleteLocalCalendar(calendarId) {
  const existing = await getLocalCalendar(calendarId)
  if (!existing) return null

  const affectedContacts = await db.all(`
    SELECT contact_id
    FROM appointments
    WHERE calendar_id = ? AND contact_id IS NOT NULL
    UNION
    SELECT ap.contact_id
    FROM appointment_participants ap
    INNER JOIN appointments a ON a.id = ap.appointment_id
    WHERE a.calendar_id = ? AND ap.contact_id IS NOT NULL
  `, [existing.id, existing.id])

  await db.transaction(async () => {
    await db.run(`
      DELETE FROM appointment_participants
      WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)
    `, [existing.id])
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [existing.id])
    await db.run('DELETE FROM calendars WHERE id = ?', [existing.id])
  })

  for (const row of affectedContacts) {
    if (row.contact_id) await updateContactAppointmentDate(row.contact_id)
  }

  return existing
}

export async function ensureDefaultLocalCalendar() {
  if (defaultLocalCalendarBootstrapPromise) return defaultLocalCalendarBootstrapPromise

  const operation = db.transaction(async transaction => {
    // SQLite ya entra con BEGIN IMMEDIATE. PostgreSQL necesita un fence para el
    // predicado "si no existe ningún calendario" porque no hay fila que pueda
    // bloquearse todavía. El id fijo conserva además la PK como segunda defensa.
    if (isPostgresDatabase) {
      await transaction.get(
        'SELECT pg_advisory_xact_lock(hashtext(?)) AS default_calendar_locked',
        [DEFAULT_LOCAL_CALENDAR_LOCK_KEY]
      )
    }

    const existing = await transaction.get(`
      SELECT *
      FROM calendars
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `)
    if (existing) return calendarRowToApi(existing)

    return createLocalCalendar({
      id: DEFAULT_LOCAL_CALENDAR_ID,
      name: 'Calendario Ristak',
      description: 'Calendario principal creado en Ristak',
      eventTitle: 'Cita',
      calendarType: 'event',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1, 2, 3, 4, 5],
          hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
        }
      ]
    })
  })
  defaultLocalCalendarBootstrapPromise = operation

  try {
    return await operation
  } finally {
    if (defaultLocalCalendarBootstrapPromise === operation) {
      defaultLocalCalendarBootstrapPromise = null
    }
  }
}

function appointmentRowToApi(row = {}) {
  const startTime = normalizeToUtcIso(row.start_time, 'UTC')
  const endTime = normalizeToUtcIso(row.end_time || row.start_time, 'UTC')
  return {
    id: row.id,
    ghlAppointmentId: row.ghl_appointment_id || null,
    googleEventId: row.google_event_id || null,
    googleProviderCalendarId: row.google_provider_calendar_id || null,
    googleMirrorGeneration: Math.max(0, Number(row.google_mirror_generation || 0)),
    calendarId: row.calendar_id || '',
    locationId: row.location_id || '',
    contactId: row.contact_id || undefined,
    title: row.title || '(Sin título)',
    status: row.status || row.appointment_status || 'confirmed',
    appointmentStatus: row.appointment_status || row.status || 'confirmed',
    assignedUserId: row.assigned_user_id || undefined,
    notes: row.notes || '',
    address: row.address || '',
    startTime,
    endTime,
    dateAdded: normalizeToUtcIso(row.date_added || row.created_at || row.start_time, 'UTC'),
    dateUpdated: normalizeToUtcIso(row.date_updated, 'UTC') || undefined,
    source: row.source || 'ristak',
    bookingChannel: normalizeAppointmentBookingChannel(row.booking_channel),
    syncStatus: row.sync_status || 'pending',
    syncError: row.sync_error || null,
    syncedAt: normalizeToUtcIso(row.synced_at, 'UTC') || null,
    googleSyncStatus: row.google_sync_status || null,
    googleSyncError: row.google_sync_error || null,
    googleSyncedAt: normalizeToUtcIso(row.google_synced_at, 'UTC') || null,
    isTest: Number(row.is_test || 0) === 1,
    testRunId: row.test_run_id || null,
    testEffectId: row.test_effect_id || null,
    testExpiresAt: normalizeToUtcIso(row.test_expires_at, 'UTC') || null,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || ''
  }
}

function normalizeAppointmentRecord(raw = {}, options = {}) {
  const appointment = raw.appointment && typeof raw.appointment === 'object' ? raw.appointment : raw
  const source = options.source || appointment.source || (appointment.id && !String(appointment.id).startsWith(LOCAL_APPOINTMENT_PREFIX) ? 'ghl' : 'ristak')
  const ghlAppointmentId = cleanString(options.ghlAppointmentId || appointment.ghlAppointmentId || appointment.ghl_appointment_id || (source === 'ghl' ? appointment.id : '')) || null
  const googleEventId = cleanString(options.googleEventId || appointment.googleEventId || appointment.google_event_id || (source === 'google' ? appointment.id : '')) || null
  const googleProviderCalendarId = cleanString(
    options.googleProviderCalendarId || options.google_provider_calendar_id ||
    appointment.googleProviderCalendarId || appointment.google_provider_calendar_id
  ) || null
  const googleMirrorGeneration = Math.max(0, Math.trunc(Number(
    options.googleMirrorGeneration ?? options.google_mirror_generation ??
    appointment.googleMirrorGeneration ?? appointment.google_mirror_generation ?? 0
  ) || 0))
  const appointmentStatus = cleanString(appointment.appointmentStatus || appointment.appointment_status || appointment.status || 'confirmed') || 'confirmed'
  const id = cleanString(options.id || appointment.localId || appointment.local_id || appointment.id) || makeId(LOCAL_APPOINTMENT_PREFIX)
  const isTest = normalizeTestFlag(options.isTest ?? options.is_test ?? appointment.isTest ?? appointment.is_test)
  const testRunId = isTest
    ? cleanString(options.testRunId || options.test_run_id || appointment.testRunId || appointment.test_run_id) || null
    : null
  const testEffectId = isTest
    ? cleanString(options.testEffectId || options.test_effect_id || appointment.testEffectId || appointment.test_effect_id) || null
    : null
  const testExpiresAt = isTest
    ? (options.testExpiresAt || options.test_expires_at || appointment.testExpiresAt || appointment.test_expires_at || null)
    : null

  return {
    id,
    ghlAppointmentId,
    googleEventId,
    googleProviderCalendarId,
    googleMirrorGeneration,
    calendarId: cleanString(options.calendarId || appointment.calendarId || appointment.calendar_id || ''),
    contactId: cleanString(appointment.contactId || appointment.contact_id || '') || null,
    locationId: cleanString(options.locationId || appointment.locationId || appointment.location_id || '') || null,
    title: cleanString(appointment.title || appointment.name || appointment.summary || 'Cita') || 'Cita',
    status: cleanString(appointment.status || appointmentStatus) || appointmentStatus,
    appointmentStatus,
    assignedUserId: cleanString(appointment.assignedUserId || appointment.assigned_user_id || '') || null,
    notes: cleanString(appointment.notes || appointment.description || '') || null,
    address: cleanString(appointment.address || appointment.location || '') || null,
    startTime: appointment.startTime || appointment.start_time || appointment.start || null,
    endTime: appointment.endTime || appointment.end_time || appointment.end || appointment.startTime || appointment.start_time || null,
    dateAdded: appointment.dateAdded || appointment.date_added || appointment.createdAt || appointment.created_at || new Date().toISOString(),
    dateUpdated: appointment.dateUpdated || appointment.date_updated || appointment.updatedAt || appointment.updated_at || new Date().toISOString(),
    source,
    bookingChannel: normalizeAppointmentBookingChannel(
      options.bookingChannel || options.booking_channel || options.sourceChannel || options.source_channel ||
      options.channel || options.origin || appointment.bookingChannel || appointment.booking_channel ||
      appointment.sourceChannel || appointment.source_channel || appointment.channel || appointment.origin ||
      options.source || appointment.source
    ),
    syncStatus: options.syncStatus || appointment.syncStatus || appointment.sync_status || (source === 'ghl' ? 'synced' : 'pending'),
    syncError: options.syncError || appointment.syncError || appointment.sync_error || null,
    googleSyncStatus: options.googleSyncStatus || appointment.googleSyncStatus || appointment.google_sync_status || (source === 'google' ? 'synced' : null),
    googleSyncError: options.googleSyncError || appointment.googleSyncError || appointment.google_sync_error || null,
    isTest,
    testRunId,
    testEffectId,
    testExpiresAt
  }
}

function testAppointmentAuthorityError(message, code, status = 409) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.statusCode = status
  return error
}

function parseDatabaseUtcInstant(value) {
  const text = cleanString(value)
  if (!text) return NaN
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  return Date.parse(normalized)
}

function sameExactInstant(left, right) {
  const leftMs = parseDatabaseUtcInstant(left)
  const rightMs = parseDatabaseUtcInstant(right)
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) < 1000
}

function participantAuthoritySnapshot(value) {
  return normalizeAppointmentParticipants(value).map((participant) => ({
    role: participant.role,
    position: participant.position,
    contactId: participant.contactId || null,
    name: participant.name || '',
    phone: participant.phone || '',
    email: participant.email || '',
    relation: participant.relation || ''
  }))
}

async function loadTestAppointmentAuthority(testEffectId) {
  const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  return db.get(`
    SELECT e.id, e.run_id, e.effect_type, e.status AS effect_status,
           e.entity_id, e.payload_json, e.claim_token, e.lease_until_at,
           r.agent_id, r.requested_by_user_id, r.contact_id,
           r.status AS run_status, r.expires_at,
           a.capabilities_config
    FROM conversational_agent_test_effects e
    INNER JOIN conversational_agent_test_runs r ON r.id = e.run_id
    INNER JOIN conversational_agents a ON a.id = r.agent_id
    WHERE e.id = ?
    LIMIT 1${lockSuffix}
  `, [testEffectId])
}

/**
 * La marca de cita de prueba no se autoriza con campos del request. Su autoridad
 * es el efecto durable que el tester reservó antes de llamar al controller.
 */
async function assertConversationalTestAppointmentAuthority({ normalized, appointmentPayload }) {
  const effectId = cleanString(normalized.testEffectId)
  const runId = cleanString(normalized.testRunId)
  const authority = await loadTestAppointmentAuthority(effectId)
  if (!authority || cleanString(authority.effect_type) !== 'appointment') {
    throw testAppointmentAuthorityError(
      'La cita de prueba no tiene un efecto durable autorizado.',
      'test_appointment_effect_required',
      403
    )
  }
  if (cleanString(authority.run_id) !== runId) {
    throw testAppointmentAuthorityError('La cita y la sesión de prueba no coinciden.', 'test_appointment_run_mismatch', 403)
  }

  const existing = await db.get(
    'SELECT id, is_test, test_run_id, test_effect_id, contact_id FROM appointments WHERE id = ?',
    [normalized.id]
  )
  if (existing) {
    if (
      Number(existing.is_test || 0) !== 1 ||
      cleanString(existing.test_run_id) !== runId ||
      cleanString(existing.test_effect_id) !== effectId ||
      cleanString(existing.contact_id) !== cleanString(authority.contact_id)
    ) {
      throw testAppointmentAuthorityError(
        'Una cita existente no puede convertirse ni cambiarse a otra identidad de prueba.',
        'test_appointment_existing_identity_mismatch',
        403
      )
    }
    if (authority.entity_id && cleanString(authority.entity_id) !== cleanString(existing.id)) {
      throw testAppointmentAuthorityError('El efecto durable pertenece a otra cita.', 'test_appointment_entity_mismatch', 403)
    }
    return authority
  }

  if (
    cleanString(authority.run_status) !== 'active' ||
    parseDatabaseUtcInstant(authority.expires_at) <= Date.now() ||
    cleanString(authority.effect_status) !== 'processing' ||
    !cleanString(authority.claim_token)
  ) {
    throw testAppointmentAuthorityError(
      'La reserva durable de esta cita de prueba ya no está activa.',
      'test_appointment_effect_not_active',
      409
    )
  }
  if (!getConversationalTestMode({ capabilitiesConfig: authority.capabilities_config }).enabled) {
    throw testAppointmentAuthorityError(
      'Modo test fue desactivado antes de crear la cita.',
      'test_appointment_mode_disabled',
      409
    )
  }
  if (cleanString(normalized.contactId) !== cleanString(authority.contact_id)) {
    throw testAppointmentAuthorityError(
      'La cita de prueba sólo puede usar el contacto ligado a su sesión.',
      'test_appointment_contact_mismatch',
      403
    )
  }
  if (authority.entity_id && cleanString(authority.entity_id) !== cleanString(normalized.id)) {
    throw testAppointmentAuthorityError('El efecto durable ya pertenece a otra cita.', 'test_appointment_entity_mismatch', 403)
  }

  const request = parseJson(authority.payload_json, {})
  const requestedParticipants = participantAuthoritySnapshot(request.participants)
  const actualParticipants = participantAuthoritySnapshot(appointmentPayload.participants)
  if (
    cleanString(request.bookingOwner) !== 'ai' ||
    cleanString(request.calendarId) !== cleanString(normalized.calendarId) ||
    !sameExactInstant(request.startTime, normalized.startTime) ||
    !sameExactInstant(request.endTime, normalized.endTime) ||
    JSON.stringify(requestedParticipants) !== JSON.stringify(actualParticipants)
  ) {
    throw testAppointmentAuthorityError(
      'Los datos de la cita no coinciden con la acción que reservó el tester.',
      'test_appointment_payload_mismatch',
      403
    )
  }
  return authority
}

async function assertTestAppointmentProviderCommandAuthority({
  appointmentId,
  testEffectId,
  testRunId,
  provider,
  calendarId = '',
  cleanupDueAt = ''
} = {}) {
  const cleanAppointmentId = cleanString(appointmentId)
  const cleanEffectId = cleanString(testEffectId)
  const cleanRunId = cleanString(testRunId)
  const cleanProvider = cleanString(provider).toLowerCase()
  if (!cleanAppointmentId || !cleanEffectId || !cleanRunId || !TEST_APPOINTMENT_PROVIDER_RECEIPT_PROVIDERS.has(cleanProvider)) {
    throw testAppointmentAuthorityError('El recibo externo de la cita de prueba está incompleto.', 'test_appointment_provider_receipt_invalid', 400)
  }

  const [authority, appointment] = await Promise.all([
    loadTestAppointmentAuthority(cleanEffectId),
    db.get(`
      SELECT id, calendar_id, contact_id, is_test, test_run_id, test_effect_id, test_expires_at
      FROM appointments WHERE id = ?
    `, [cleanAppointmentId])
  ])
  if (
    !authority || cleanString(authority.effect_type) !== 'appointment' ||
    cleanString(authority.run_id) !== cleanRunId ||
    cleanString(authority.contact_id) !== cleanString(appointment?.contact_id) ||
    !appointment || Number(appointment.is_test || 0) !== 1 ||
    cleanString(appointment.test_run_id) !== cleanRunId ||
    cleanString(appointment.test_effect_id) !== cleanEffectId
  ) {
    throw testAppointmentAuthorityError(
      'El proveedor devolvió un evento sin una cita de prueba durable que lo autorice.',
      'test_appointment_provider_receipt_authority_mismatch',
      403
    )
  }
  if (authority.entity_id && cleanString(authority.entity_id) !== cleanAppointmentId) {
    throw testAppointmentAuthorityError('El efecto durable apunta a otra cita.', 'test_appointment_entity_mismatch', 403)
  }

  const dueAt = cleanupDueAt || appointment.test_expires_at
  if (!Number.isFinite(parseDatabaseUtcInstant(dueAt))) {
    throw testAppointmentAuthorityError('El recibo externo no tiene una fecha de limpieza válida.', 'test_appointment_provider_receipt_expiry_invalid', 409)
  }
  return {
    appointment,
    authority,
    appointmentId: cleanAppointmentId,
    testEffectId: cleanEffectId,
    testRunId: cleanRunId,
    provider: cleanProvider,
    calendarId: cleanString(calendarId || appointment.calendar_id) || null,
    cleanupDueAt: new Date(parseDatabaseUtcInstant(dueAt)).toISOString()
  }
}

/**
 * Outbox durable para citas externas de Modo test. Se crea ANTES del POST remoto:
 * si el proceso pierde la respuesta, cleanup/retry todavía sabe exactamente qué
 * comando reconciliar y jamás depende de una excepción en memoria.
 */
export async function prepareConversationalTestAppointmentProviderCommand({
  appointmentId,
  testEffectId,
  testRunId,
  provider,
  externalId,
  commandKey,
  idempotencyMarker = '',
  commandPayload = {},
  calendarId = '',
  cleanupDueAt = ''
} = {}) {
  const identity = await assertTestAppointmentProviderCommandAuthority({
    appointmentId,
    testEffectId,
    testRunId,
    provider,
    calendarId,
    cleanupDueAt
  })
  const cleanExternalId = cleanString(externalId)
  const cleanCommandKey = cleanString(commandKey)
  if (!cleanExternalId || !cleanCommandKey) {
    throw testAppointmentAuthorityError(
      'El comando externo de la cita de prueba necesita identidad durable.',
      'test_appointment_provider_command_invalid',
      400
    )
  }

  await db.run(`
    INSERT INTO conversational_appointment_test_provider_receipts (
      id, test_effect_id, test_run_id, appointment_id, provider, external_id,
      command_key, idempotency_marker, command_json, remote_status,
      calendar_id, cleanup_due_at, cleanup_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'command_pending', ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(test_effect_id, provider) DO NOTHING
  `, [
    createEntityId('conv_appt_test_receipt'),
    identity.testEffectId,
    identity.testRunId,
    identity.appointmentId,
    identity.provider,
    cleanExternalId,
    cleanCommandKey,
    cleanString(idempotencyMarker) || null,
    JSON.stringify(commandPayload && typeof commandPayload === 'object' ? commandPayload : {}),
    identity.calendarId,
    identity.cleanupDueAt
  ])
  const receipt = await db.get(`
    SELECT * FROM conversational_appointment_test_provider_receipts
    WHERE test_effect_id = ? AND provider = ?
  `, [identity.testEffectId, identity.provider])
  if (
    !receipt || cleanString(receipt.test_run_id) !== identity.testRunId ||
    cleanString(receipt.appointment_id) !== identity.appointmentId ||
    (cleanString(receipt.command_key) && cleanString(receipt.command_key) !== cleanCommandKey)
  ) {
    throw testAppointmentAuthorityError(
      'El comando externo ya estaba ligado a otra cita o payload.',
      'test_appointment_provider_receipt_conflict',
      409
    )
  }
  return receipt
}

export async function markConversationalTestAppointmentProviderRemoteStatus({
  receiptId,
  testEffectId,
  provider,
  externalId = '',
  remoteStatus,
  remoteError = null,
  reconciled = false
} = {}) {
  const allowed = new Set(['command_pending', 'posting', 'created', 'remote_outcome_unknown', 'failed', 'absent'])
  const status = cleanString(remoteStatus).toLowerCase()
  if (!allowed.has(status)) {
    throw testAppointmentAuthorityError('Estado remoto de cita de prueba inválido.', 'test_appointment_provider_remote_status_invalid', 400)
  }
  const cleanReceiptId = cleanString(receiptId)
  const cleanEffectId = cleanString(testEffectId)
  const cleanProvider = cleanString(provider).toLowerCase()
  if (!cleanReceiptId && (!cleanEffectId || !TEST_APPOINTMENT_PROVIDER_RECEIPT_PROVIDERS.has(cleanProvider))) {
    throw testAppointmentAuthorityError('Falta la identidad del comando remoto.', 'test_appointment_provider_receipt_invalid', 400)
  }

  const where = cleanReceiptId ? 'id = ?' : 'test_effect_id = ? AND provider = ?'
  const whereParams = cleanReceiptId ? [cleanReceiptId] : [cleanEffectId, cleanProvider]
  const result = await db.run(`
    UPDATE conversational_appointment_test_provider_receipts
    SET external_id = CASE WHEN ? != '' THEN ? ELSE external_id END,
        remote_status = ?, remote_error = ?,
        remote_attempt_count = remote_attempt_count + 1,
        remote_reconciled_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE remote_reconciled_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE ${where}
  `, [
    cleanString(externalId),
    cleanString(externalId),
    status,
    remoteError ? cleanString(remoteError).slice(0, 1200) : null,
    reconciled ? 1 : 0,
    ...whereParams
  ])
  if (Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    throw testAppointmentAuthorityError('No existe el comando remoto que se intentó actualizar.', 'test_appointment_provider_receipt_missing', 404)
  }
  return db.get(`SELECT * FROM conversational_appointment_test_provider_receipts WHERE ${where}`, whereParams)
}

function testHighLevelCommandFromAppointment({ appointment, locationId, remoteCalendarId, contactId }) {
  const marker = highlevelCalendarService.highLevelTestAppointmentMarker(appointment.testEffectId)
  return {
    marker,
    locationId: cleanString(locationId),
    calendarId: cleanString(remoteCalendarId),
    contactId: cleanString(contactId),
    startTime: appointment.startTime,
    endTime: appointment.endTime
  }
}

async function reconcileHighLevelTestAppointment({ command, apiToken }) {
  const startMs = new Date(command.startTime).getTime()
  const endMs = new Date(command.endTime).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw testAppointmentAuthorityError('El comando HighLevel tiene fechas inválidas.', 'test_appointment_provider_command_invalid', 400)
  }
  const events = await highlevelCalendarService.getCalendarEvents(
    command.locationId,
    startMs - 5 * 60_000,
    endMs + 5 * 60_000,
    apiToken,
    command.calendarId
  )
  return highlevelCalendarService.findHighLevelTestAppointmentByCommand(events, command)
}

/**
 * HighLevel no ofrece idempotency-key al crear citas. El sustituto seguro es un
 * outbox previo con marcador único y reconciliación EXACTA antes de cada POST.
 */
export async function createConversationalTestHighLevelAppointment({
  appointment,
  appointmentData = {},
  locationId,
  remoteCalendarId,
  contactId,
  apiToken
} = {}) {
  if (!appointment?.isTest) {
    throw testAppointmentAuthorityError('Esta ruta sólo acepta citas reales de Modo test.', 'test_appointment_provider_command_invalid', 400)
  }
  const command = testHighLevelCommandFromAppointment({ appointment, locationId, remoteCalendarId, contactId })
  if (!command.locationId || !command.calendarId || !command.contactId) {
    throw testAppointmentAuthorityError(
      'HighLevel necesita ubicación, calendario y contacto para reconciliar la cita de prueba.',
      'test_appointment_highlevel_identity_incomplete',
      409
    )
  }
  const commandKey = `highlevel:${appointment.testEffectId}:${command.calendarId}:${command.contactId}`
  const placeholderId = `outbox${crypto.createHash('sha256').update(commandKey).digest('hex')}`
  const receipt = await prepareConversationalTestAppointmentProviderCommand({
    appointmentId: appointment.id,
    testEffectId: appointment.testEffectId,
    testRunId: appointment.testRunId,
    provider: 'highlevel',
    externalId: placeholderId,
    commandKey,
    idempotencyMarker: command.marker,
    commandPayload: command,
    calendarId: appointment.calendarId,
    cleanupDueAt: appointment.testExpiresAt
  })

  // Antes de cualquier POST, incluso el primero, buscamos el marcador. Esto
  // cierra la ventana crash-después-de-POST/antes-de-guardar-respuesta.
  let existingRemote
  try {
    existingRemote = await reconcileHighLevelTestAppointment({ command, apiToken })
  } catch (reconcileError) {
    await markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      remoteStatus: 'remote_outcome_unknown',
      remoteError: `Reconciliación previa: ${reconcileError.message}`,
      reconciled: true
    })
    throw Object.assign(new Error(`HighLevel no permitió reconciliar la cita de prueba: ${reconcileError.message}`, { cause: reconcileError }), {
      code: 'test_appointment_remote_outcome_unknown',
      status: 503
    })
  }
  if (existingRemote?.id) {
    await markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      externalId: existingRemote.id,
      remoteStatus: 'created',
      reconciled: true
    })
    return existingRemote
  }

  const priorRemoteStatus = cleanString(receipt.remote_status).toLowerCase() || 'command_pending'
  if (priorRemoteStatus !== 'command_pending') {
    if (priorRemoteStatus === 'posting') {
      await markConversationalTestAppointmentProviderRemoteStatus({
        receiptId: receipt.id,
        remoteStatus: 'remote_outcome_unknown',
        remoteError: 'El proceso anterior quedó entre el POST y su confirmación; no se reintentará a ciegas.',
        reconciled: true
      })
    }
    throw Object.assign(new Error(
      priorRemoteStatus === 'failed'
        ? 'El intento HighLevel anterior falló de forma definitiva; crea una prueba nueva para reintentarlo.'
        : 'HighLevel todavía no permite confirmar si la cita de prueba existe; no se enviará otro POST.'
    ), {
      code: priorRemoteStatus === 'failed'
        ? 'test_appointment_provider_failed'
        : 'test_appointment_remote_outcome_unknown',
      status: priorRemoteStatus === 'failed' ? 409 : 503
    })
  }

  try {
    // Este checkpoint se persiste ANTES del POST. Si el proceso muere justo al
    // recibir HighLevel el comando, el siguiente intento verá `posting`,
    // reconciliará y nunca repetirá el POST por intuición.
    await markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      remoteStatus: 'posting'
    })
    const response = await highlevelCalendarService.createAppointment({
      ...appointment,
      ...appointmentData,
      calendarId: command.calendarId,
      contactId: command.contactId,
      locationId: command.locationId,
      isTest: true,
      testEffectId: appointment.testEffectId,
      notes: appointmentData.notes ?? appointment.notes
    }, command.locationId, apiToken)
    const remote = response?.appointment || response
    if (!remote?.id) throw Object.assign(new Error('HighLevel no devolvió ID de cita; se requiere reconciliación.'), { remoteOutcomeAmbiguous: true })
    await markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      externalId: remote.id,
      remoteStatus: 'created'
    })
    return response
  } catch (writeError) {
    if (!highlevelCalendarService.isAmbiguousHighLevelAppointmentWriteError(writeError) && !writeError.remoteOutcomeAmbiguous) {
      await markConversationalTestAppointmentProviderRemoteStatus({
        receiptId: receipt.id,
        remoteStatus: 'failed',
        remoteError: writeError.message
      })
      throw writeError
    }

    try {
      existingRemote = await reconcileHighLevelTestAppointment({ command, apiToken })
    } catch (reconcileError) {
      await markConversationalTestAppointmentProviderRemoteStatus({
        receiptId: receipt.id,
        remoteStatus: 'remote_outcome_unknown',
        remoteError: `${writeError.message} | reconcile: ${reconcileError.message}`,
        reconciled: true
      })
      throw Object.assign(new Error(`HighLevel no confirmó si creó la cita de prueba: ${reconcileError.message}`, { cause: writeError }), {
        code: 'test_appointment_remote_outcome_unknown',
        status: 503
      })
    }
    if (!existingRemote?.id) {
      await markConversationalTestAppointmentProviderRemoteStatus({
        receiptId: receipt.id,
        remoteStatus: 'remote_outcome_unknown',
        remoteError: writeError.message,
        reconciled: true
      })
      throw Object.assign(new Error(
        'HighLevel no devolvió la cita tras un resultado ambiguo; no se repetirá el POST a ciegas.',
        { cause: writeError }
      ), {
        code: 'test_appointment_remote_outcome_unknown',
        status: 503
      })
    }
    await markConversationalTestAppointmentProviderRemoteStatus({
      receiptId: receipt.id,
      externalId: existingRemote.id,
      remoteStatus: 'created',
      reconciled: true
    })
    return existingRemote
  }
}

/** Guarda un ID ya confirmado; compatibilidad para rutas que no necesitan outbox previo. */
export async function recordConversationalTestAppointmentProviderReceipt(input = {}) {
  const receipt = await prepareConversationalTestAppointmentProviderCommand({
    ...input,
    commandKey: input.commandKey || `confirmed:${cleanString(input.testEffectId)}:${cleanString(input.provider).toLowerCase()}`,
    commandPayload: input.commandPayload || {}
  })
  return markConversationalTestAppointmentProviderRemoteStatus({
    receiptId: receipt.id,
    externalId: input.externalId,
    remoteStatus: 'created'
  })
}

async function hydrateAppointmentParticipantSnapshots(participants = []) {
  const contactIds = [...new Set(participants.map(participant => participant.contactId).filter(Boolean))]
  const contacts = new Map()

  if (contactIds.length) {
    const placeholders = contactIds.map(() => '?').join(', ')
    const rows = await db.all(`
      SELECT id, full_name, first_name, last_name, phone, email
      FROM contacts
      WHERE id IN (${placeholders})
    `, contactIds)
    for (const row of rows) contacts.set(cleanString(row.id), row)
  }

  return participants.map(participant => {
    const contact = participant.contactId ? contacts.get(participant.contactId) : null
    const contactName = cleanString(contact?.full_name)
      || [cleanString(contact?.first_name), cleanString(contact?.last_name)].filter(Boolean).join(' ')
    return {
      ...participant,
      name: participant.name || cleanSnapshot(contactName, 200),
      phone: participant.phone || cleanSnapshot(contact?.phone, 50),
      email: participant.email || normalizeParticipantEmail(contact?.email)
    }
  })
}

async function assertAppointmentParticipantContactsExist(participants = []) {
  const contactIds = [...new Set(
    normalizeAppointmentParticipants(participants).map(participant => participant.contactId).filter(Boolean)
  )]
  if (!contactIds.length) return

  const placeholders = contactIds.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT id FROM contacts WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    contactIds
  )
  const found = new Set(rows.map(row => cleanString(row.id)))
  const missing = contactIds.filter(contactId => !found.has(contactId))
  if (!missing.length) return

  const error = new Error('Uno de los contactos ligados a los participantes ya no existe')
  error.status = 409
  error.code = 'appointment_participant_contact_not_found'
  throw error
}

export async function replaceAppointmentParticipants(appointmentId, participants = []) {
  const normalizedAppointmentId = cleanString(appointmentId)
  if (!normalizedAppointmentId) throw new Error('appointmentId requerido para guardar participantes')
  validateAppointmentParticipantInputs(participants)

  const normalized = await hydrateAppointmentParticipantSnapshots(
    normalizeAppointmentParticipants(participants)
  )

  await db.transaction(async () => {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [normalizedAppointmentId])
    for (const participant of normalized) {
      await db.run(`
        INSERT INTO appointment_participants (
          id, appointment_id, role, position, contact_id,
          name_snapshot, phone_snapshot, email_snapshot, relation_snapshot,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        makeId('appointment_participant'),
        normalizedAppointmentId,
        participant.role,
        participant.position,
        participant.contactId,
        participant.name || null,
        participant.phone || null,
        participant.email || null,
        participant.relation || null
      ])
    }
  })

  return getAppointmentParticipants(normalizedAppointmentId)
}

export async function getAppointmentParticipants(appointmentId) {
  const normalizedAppointmentId = cleanString(appointmentId)
  if (!normalizedAppointmentId) return []

  const rows = await db.all(`
    SELECT id, appointment_id, role, position, contact_id,
      name_snapshot, phone_snapshot, email_snapshot, relation_snapshot,
      created_at, updated_at
    FROM appointment_participants
    WHERE appointment_id = ?
    ORDER BY
      CASE role WHEN 'requester' THEN 0 WHEN 'primary_attendee' THEN 1 ELSE 2 END,
      position ASC,
      created_at ASC
  `, [normalizedAppointmentId])

  return rows.map(row => ({
    id: row.id,
    appointmentId: row.appointment_id,
    role: row.role,
    position: Number(row.position || 0),
    contactId: row.contact_id || null,
    name: row.name_snapshot || '',
    phone: row.phone_snapshot || '',
    email: row.email_snapshot || '',
    relation: row.relation_snapshot || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
}

// Alias explícitos para consumidores que sólo necesitan el contrato crear/cargar.
export async function createAppointmentParticipants(appointmentId, participants = []) {
  return replaceAppointmentParticipants(appointmentId, participants)
}

export async function loadAppointmentParticipants(appointmentId) {
  return getAppointmentParticipants(appointmentId)
}

export async function upsertLocalAppointment(raw = {}, options = {}) {
  const appointmentPayload = raw.appointment && typeof raw.appointment === 'object' ? raw.appointment : raw
  const participantsProvided = Array.isArray(appointmentPayload.participants)
  if (participantsProvided) {
    validateAppointmentParticipantInputs(appointmentPayload.participants)
    await assertAppointmentParticipantContactsExist(appointmentPayload.participants)
  }
  const normalized = normalizeAppointmentRecord(raw, options)

  // (GCAL-003/GHL-003) Last-write-wins: cuando el upsert viene de un PULL de sincronización
  // (Google o HighLevel) activamos un candado de conflicto. Solo pisamos los campos de la
  // cita local si el remoto es realmente más nuevo (excluded.date_updated > local) y la
  // cita local NO tiene una edición pendiente de subir (sync_status pending/pending_delete).
  // Así un pull viejo deja de revertir una edición fresca hecha en Ristak.
  const lastWriteWins = options.lastWriteWins === true ? 1 : 0

  // Normalizar TODOS los instantes a UTC real antes de guardar.
  // GHL y el modal mandan ISO con offset (ej "...-06:00"); si la columna es
  // `timestamp` (sin zona) Postgres descartaría el offset y guardaría hora local.
  // Convirtiendo a UTC aquí el instante queda correcto en cualquier tipo de columna.
  const accountZone = await getAccountTimezone()
  normalized.startTime = normalizeToUtcIso(normalized.startTime, accountZone)
  normalized.endTime = normalizeToUtcIso(normalized.endTime, accountZone)
  normalized.dateAdded = normalizeToUtcIso(normalized.dateAdded, accountZone)
  normalized.dateUpdated = normalizeToUtcIso(normalized.dateUpdated, accountZone)
  normalized.testExpiresAt = normalized.isTest
    ? normalizeToUtcIso(normalized.testExpiresAt, accountZone)
    : null

  const existingByGhl = normalized.ghlAppointmentId
    ? await db.get('SELECT id FROM appointments WHERE ghl_appointment_id = ?', [normalized.ghlAppointmentId])
    : null

  if (existingByGhl?.id) {
    normalized.id = existingByGhl.id
  }

  const existingByGoogle = !existingByGhl && normalized.googleEventId
    ? await db.get('SELECT id FROM appointments WHERE google_event_id = ?', [normalized.googleEventId])
    : null

  if (existingByGoogle?.id) {
    normalized.id = existingByGoogle.id
  }

  if (normalized.isTest) {
    await assertConversationalTestAppointmentAuthority({ normalized, appointmentPayload })
  }

  await db.run(`
    INSERT INTO appointments (
      id, ghl_appointment_id, google_event_id, google_provider_calendar_id, google_mirror_generation,
      calendar_id, contact_id, location_id, title, status,
      appointment_status, assigned_user_id, notes, address, start_time, end_time,
      date_added, date_updated, source, booking_channel, sync_status, sync_error, synced_at,
      google_sync_status, google_sync_error, google_synced_at,
      is_test, test_run_id, test_effect_id, test_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      ghl_appointment_id = COALESCE(excluded.ghl_appointment_id, appointments.ghl_appointment_id),
      google_event_id = COALESCE(excluded.google_event_id, appointments.google_event_id),
      google_provider_calendar_id = COALESCE(excluded.google_provider_calendar_id, appointments.google_provider_calendar_id),
      google_mirror_generation = CASE
        WHEN COALESCE(excluded.google_mirror_generation, 0) > COALESCE(appointments.google_mirror_generation, 0)
          THEN excluded.google_mirror_generation
        ELSE COALESCE(appointments.google_mirror_generation, 0)
      END,
      calendar_id = COALESCE(excluded.calendar_id, appointments.calendar_id),
      contact_id = COALESCE(excluded.contact_id, appointments.contact_id),
      location_id = COALESCE(excluded.location_id, appointments.location_id),
      title = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.title ELSE COALESCE(excluded.title, appointments.title) END,
      status = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.status ELSE COALESCE(excluded.status, appointments.status) END,
      appointment_status = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.appointment_status ELSE COALESCE(excluded.appointment_status, appointments.appointment_status) END,
      assigned_user_id = COALESCE(excluded.assigned_user_id, appointments.assigned_user_id),
      notes = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.notes ELSE COALESCE(excluded.notes, appointments.notes) END,
      address = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.address ELSE COALESCE(excluded.address, appointments.address) END,
      start_time = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.start_time ELSE COALESCE(excluded.start_time, appointments.start_time) END,
      end_time = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.end_time ELSE COALESCE(excluded.end_time, appointments.end_time) END,
      date_added = COALESCE(appointments.date_added, excluded.date_added),
      date_updated = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status IN ('pending','pending_delete') OR appointments.date_updated >= excluded.date_updated) THEN appointments.date_updated ELSE excluded.date_updated END,
      source = COALESCE(excluded.source, appointments.source),
      booking_channel = COALESCE(excluded.booking_channel, appointments.booking_channel),
      sync_status = CASE WHEN ${lastWriteWins} = 1 AND appointments.sync_status IN ('pending','pending_delete') THEN appointments.sync_status ELSE excluded.sync_status END,
      sync_error = excluded.sync_error,
      synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.synced_at END,
      google_sync_status = COALESCE(excluded.google_sync_status, appointments.google_sync_status),
      google_sync_error = excluded.google_sync_error,
      google_synced_at = CASE WHEN excluded.google_sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.google_synced_at END,
      is_test = CASE WHEN appointments.is_test = 1 THEN 1 ELSE excluded.is_test END,
      test_run_id = COALESCE(appointments.test_run_id, excluded.test_run_id),
      test_effect_id = COALESCE(appointments.test_effect_id, excluded.test_effect_id),
      test_expires_at = COALESCE(appointments.test_expires_at, excluded.test_expires_at),
      deleted_at = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status = 'pending_delete' OR appointments.date_updated >= excluded.date_updated) THEN appointments.deleted_at ELSE NULL END
  `, [
    normalized.id,
    normalized.ghlAppointmentId,
    normalized.googleEventId,
    normalized.googleProviderCalendarId,
    normalized.googleMirrorGeneration,
    normalized.calendarId || null,
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
    normalized.dateUpdated,
    normalized.source,
    normalized.bookingChannel,
    normalized.syncStatus,
    normalized.syncError,
    normalized.syncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.googleSyncStatus,
    normalized.googleSyncError,
    normalized.googleSyncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.isTest ? 1 : 0,
    normalized.testRunId,
    normalized.testEffectId,
    normalized.testExpiresAt
  ])

  const persistedParticipants = participantsProvided
    ? await replaceAppointmentParticipants(normalized.id, appointmentPayload.participants)
    : []

  const affectedContactIds = [...new Set([
    normalized.contactId,
    ...persistedParticipants.map(participant => participant.contactId)
  ].filter(Boolean))]
  for (const contactId of affectedContactIds) {
    await updateContactAppointmentDate(contactId)
  }

  const row = await getLocalAppointment(normalized.id)
  return row
}

const HIGHLEVEL_MIRROR_DIVERGED_MARKER = '[ghl_mirror_diverged]'
const HIGHLEVEL_MIRROR_INTENT_TTL_MS = 15 * 60 * 1000

function normalizeHighLevelMirrorIntentTitle(value = '') {
  return cleanString(value).replace(/\s+/g, ' ').toLowerCase().slice(0, 500)
}

/**
 * Deja un contrato durable antes del POST a HighLevel. El webhook puede llegar
 * antes que la respuesta HTTP; este snapshot le permite reconocer la cita local
 * sin crear otra fila ni tocar la identidad del contacto.
 */
export async function prepareHighLevelAppointmentMirrorIntent({
  appointmentId,
  remoteCalendarId,
  remoteContactId,
  locationId = null
} = {}) {
  const normalizedAppointmentId = cleanString(appointmentId)
  const normalizedRemoteCalendarId = cleanString(remoteCalendarId)
  const normalizedRemoteContactId = cleanString(remoteContactId)
  if (!normalizedAppointmentId || !normalizedRemoteCalendarId || !normalizedRemoteContactId) {
    throw new Error('La intención del espejo HighLevel requiere cita, calendario y contacto remotos')
  }

  const row = await db.get('SELECT * FROM appointments WHERE id = ? LIMIT 1', [normalizedAppointmentId])
  if (!row || !isRistakOwnedRow(row, LOCAL_APPOINTMENT_PREFIX)) {
    throw new Error('Sólo una cita canónica de Ristak puede preparar un espejo HighLevel')
  }
  if (cleanString(row.ghl_appointment_id)) {
    return { prepared: false, alreadyLinked: true, appointmentId: row.id }
  }
  const startTime = normalizeToUtcIso(row.start_time, 'UTC')
  const endTime = normalizeToUtcIso(row.end_time, 'UTC')
  if (!startTime || !endTime) throw new Error('La cita local no conserva horas válidas para preparar su espejo HighLevel')

  const now = new Date()
  const expiresAt = new Date(now.getTime() + HIGHLEVEL_MIRROR_INTENT_TTL_MS).toISOString()
  await db.run(`
    INSERT INTO appointment_highlevel_mirror_intents (
      appointment_id, appointment_date_updated, local_calendar_id,
      remote_calendar_id, local_contact_id, remote_contact_id, location_id,
      start_time, end_time, normalized_title, status, remote_appointment_id,
      prepared_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?)
    ON CONFLICT (appointment_id) DO UPDATE SET
      appointment_date_updated = excluded.appointment_date_updated,
      local_calendar_id = excluded.local_calendar_id,
      remote_calendar_id = excluded.remote_calendar_id,
      local_contact_id = excluded.local_contact_id,
      remote_contact_id = excluded.remote_contact_id,
      location_id = excluded.location_id,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      normalized_title = excluded.normalized_title,
      status = 'prepared',
      remote_appointment_id = NULL,
      prepared_at = excluded.prepared_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `, [
    row.id,
    row.date_updated,
    row.calendar_id,
    normalizedRemoteCalendarId,
    row.contact_id || null,
    normalizedRemoteContactId,
    cleanString(locationId || row.location_id) || null,
    startTime,
    endTime,
    normalizeHighLevelMirrorIntentTitle(row.title),
    now.toISOString(),
    expiresAt,
    now.toISOString()
  ])
  return { prepared: true, appointmentId: row.id, expiresAt }
}

export async function completeHighLevelAppointmentMirrorIntent(appointmentId, remoteAppointmentId) {
  const normalizedAppointmentId = cleanString(appointmentId)
  const normalizedRemoteAppointmentId = cleanString(remoteAppointmentId)
  if (!normalizedAppointmentId || !normalizedRemoteAppointmentId) return false
  const result = await db.run(`
    UPDATE appointment_highlevel_mirror_intents
    SET status = 'linked', remote_appointment_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE appointment_id = ?
      AND (remote_appointment_id IS NULL OR remote_appointment_id = ?)
  `, [normalizedRemoteAppointmentId, normalizedAppointmentId, normalizedRemoteAppointmentId])
  return Number(result?.changes ?? result?.rowCount ?? 0) === 1
}

function highLevelInboundValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key]
    if (value !== undefined && value !== null && cleanString(value)) return value
  }
  return null
}

function normalizeHighLevelMirrorStatus(value) {
  const status = cleanString(value).toLowerCase()
  if (!status) return ''
  if (status === 'pending' || status === 'rescheduled') return 'confirmed'
  if (status === 'canceled') return 'cancelled'
  if (status === 'no-show' || status === 'no_show') return 'noshow'
  return status
}

function normalizeHighLevelMirrorNotes(value) {
  return cleanString(value)
    .replace(/\[RISTAK-TEST:[^\]]+\]/gi, '')
    .trim()
}

function buildHighLevelMirrorObservation(raw = {}, options = {}) {
  const observedRaw = options.observedRaw && typeof options.observedRaw === 'object'
    ? options.observedRaw
    : raw
  const appointment = observedRaw.appointment && typeof observedRaw.appointment === 'object'
    ? observedRaw.appointment
    : observedRaw

  return {
    calendarId: cleanString(options.calendarId) || cleanString(highLevelInboundValue(appointment, ['calendarId', 'calendar_id'])) || null,
    contactId: cleanString(options.contactId) || cleanString(highLevelInboundValue(appointment, ['contactId', 'contact_id'])) || null,
    locationId: cleanString(options.locationId) || cleanString(highLevelInboundValue(appointment, ['locationId', 'location_id'])) || null,
    title: highLevelInboundValue(appointment, ['title', 'name', 'summary', 'calendarEventName']),
    appointmentStatus: highLevelInboundValue(appointment, ['appointmentStatus', 'appointment_status', 'status', 'state']),
    assignedUserId: highLevelInboundValue(appointment, ['assignedUserId', 'assigned_user_id', 'assignedTo', 'userId', 'teamMemberId']),
    notes: highLevelInboundValue(appointment, ['notes', 'note', 'description']),
    address: highLevelInboundValue(appointment, ['address', 'addressLine']),
    startTime: highLevelInboundValue(appointment, ['startTime', 'start_time', 'startDateTime', 'startAt', 'start']),
    endTime: highLevelInboundValue(appointment, ['endTime', 'end_time', 'endDateTime', 'endAt', 'end'])
  }
}

function compareHighLevelMirrorWithCanonical(row = {}, observation = {}) {
  const changedFields = []
  const compareText = (field, remoteValue, localValue, normalizer = cleanString) => {
    if (remoteValue === null || remoteValue === undefined || !cleanString(remoteValue)) return
    if (normalizer(remoteValue) !== normalizer(localValue)) changedFields.push(field)
  }

  compareText('calendar_id', observation.calendarId, row.calendar_id)
  compareText('contact_id', observation.contactId, row.contact_id)
  compareText('location_id', observation.locationId, row.location_id)
  compareText('title', observation.title, row.title, value => cleanString(value).toLowerCase())
  compareText(
    'appointment_status',
    observation.appointmentStatus,
    row.appointment_status || row.status,
    normalizeHighLevelMirrorStatus
  )
  compareText('assigned_user_id', observation.assignedUserId, row.assigned_user_id)
  compareText('notes', observation.notes, row.notes, normalizeHighLevelMirrorNotes)
  compareText('address', observation.address, row.address, value => cleanString(value).toLowerCase())

  if (observation.startTime && !sameExactInstant(observation.startTime, row.start_time)) {
    changedFields.push('start_time')
  }
  if (observation.endTime && !sameExactInstant(observation.endTime, row.end_time)) {
    changedFields.push('end_time')
  }

  const hasCompleteEcho = Boolean(
    observation.title
    && observation.appointmentStatus
    && observation.startTime
    && observation.endTime
  )

  return { changedFields, hasCompleteEcho }
}

async function findHighLevelInboundAppointmentRow(remoteAppointmentId) {
  const normalizedRemoteId = cleanString(remoteAppointmentId)
  if (!normalizedRemoteId) return null
  return db.get(`
    SELECT *
    FROM appointments
    WHERE ghl_appointment_id = ? OR id = ?
    ORDER BY CASE WHEN ghl_appointment_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `, [normalizedRemoteId, normalizedRemoteId, normalizedRemoteId])
}

/**
 * Reclama un webhook adelantado usando la intención preparada antes del POST.
 * La coincidencia exige calendario, contacto y ambos instantes remotos exactos;
 * si fuera ambigua, falla cerrado en vez de adjudicar propiedad al proveedor.
 */
export async function claimPreparedHighLevelMirrorIntent(raw = {}, options = {}) {
  const appointmentPayload = raw.appointment && typeof raw.appointment === 'object' ? raw.appointment : raw
  const remoteAppointmentId = cleanString(
    options.ghlAppointmentId || options.remoteAppointmentId ||
    appointmentPayload.ghlAppointmentId || appointmentPayload.ghl_appointment_id ||
    appointmentPayload.appointmentId || appointmentPayload.appointment_id || appointmentPayload.id
  )
  const remoteCalendarId = cleanString(
    options.remoteCalendarId || appointmentPayload.remoteCalendarId ||
    appointmentPayload.calendarId || appointmentPayload.calendar_id
  )
  const remoteContactId = cleanString(
    options.remoteContactId || appointmentPayload.remoteContactId ||
    appointmentPayload.contactId || appointmentPayload.contact_id
  )
  const startTime = normalizeToUtcIso(
    options.startTime || highLevelInboundValue(appointmentPayload, ['startTime', 'start_time', 'startDateTime', 'startAt', 'start']),
    'UTC'
  )
  const endTime = normalizeToUtcIso(
    options.endTime || highLevelInboundValue(appointmentPayload, ['endTime', 'end_time', 'endDateTime', 'endAt', 'end']),
    'UTC'
  )
  if (!remoteAppointmentId || !remoteCalendarId || !remoteContactId || !startTime || !endTime) return null

  return db.transaction(async () => {
    if (process.env.DATABASE_URL) {
      await db.get(
        'SELECT pg_advisory_xact_lock(hashtext(?)) AS highlevel_appointment_locked',
        [`highlevel-inbound:${remoteAppointmentId}`]
      )
    }

    const alreadyLinked = await findHighLevelInboundAppointmentRow(remoteAppointmentId)
    if (alreadyLinked) {
      return {
        appointment: appointmentRowToApi(alreadyLinked),
        ownership: isRistakOwnedRow(alreadyLinked, LOCAL_APPOINTMENT_PREFIX) ? 'ristak' : 'ghl',
        claimedIntent: false
      }
    }

    let candidates = await db.all(`
      SELECT i.*, a.date_updated AS current_date_updated, a.source AS appointment_source,
             a.ghl_appointment_id AS current_remote_appointment_id,
             a.deleted_at AS appointment_deleted_at
      FROM appointment_highlevel_mirror_intents i
      JOIN appointments a ON a.id = i.appointment_id
      WHERE i.status = 'prepared'
        AND i.expires_at > ?
        AND LOWER(i.remote_calendar_id) = LOWER(?)
        AND LOWER(i.remote_contact_id) = LOWER(?)
        AND i.start_time = ?
        AND i.end_time = ?
        AND (a.ghl_appointment_id IS NULL OR a.ghl_appointment_id = '')
      ORDER BY i.prepared_at DESC, i.appointment_id ASC
      ${process.env.DATABASE_URL ? 'FOR UPDATE' : ''}
    `, [new Date().toISOString(), remoteCalendarId, remoteContactId, startTime, endTime])

    if (candidates.length > 1) {
      const normalizedTitle = normalizeHighLevelMirrorIntentTitle(
        options.title || highLevelInboundValue(appointmentPayload, ['title', 'name', 'summary', 'calendarEventName'])
      )
      const titleMatches = normalizedTitle
        ? candidates.filter(candidate => candidate.normalized_title === normalizedTitle)
        : []
      if (titleMatches.length === 1) candidates = titleMatches
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        const error = new Error('Más de una cita Ristak coincide con el webhook adelantado de HighLevel; no se importó ninguna fila externa.')
        error.code = 'highlevel_mirror_intent_ambiguous'
        error.status = 409
        error.statusCode = 409
        throw error
      }
      return null
    }

    const intent = candidates[0]
    let claimed
    try {
      claimed = await db.run(`
        UPDATE appointments
        SET ghl_appointment_id = ?,
            sync_status = CASE WHEN sync_status = 'pending_delete' THEN 'pending_delete' ELSE 'pending' END,
            sync_error = ?,
            synced_at = synced_at
        WHERE id = ?
          AND (ghl_appointment_id IS NULL OR ghl_appointment_id = '')
      `, [
        remoteAppointmentId,
        `${HIGHLEVEL_MIRROR_DIVERGED_MARKER} HighLevel adelantó el webhook; Ristak todavía debe validar el eco completo.`,
        intent.appointment_id
      ])
    } catch (error) {
      const winner = await findHighLevelInboundAppointmentRow(remoteAppointmentId)
      if (!winner) throw error
      return {
        appointment: appointmentRowToApi(winner),
        ownership: isRistakOwnedRow(winner, LOCAL_APPOINTMENT_PREFIX) ? 'ristak' : 'ghl',
        claimedIntent: false
      }
    }
    if (Number(claimed?.changes ?? claimed?.rowCount ?? 0) !== 1) {
      const winner = await findHighLevelInboundAppointmentRow(remoteAppointmentId)
      if (winner) {
        return {
          appointment: appointmentRowToApi(winner),
          ownership: isRistakOwnedRow(winner, LOCAL_APPOINTMENT_PREFIX) ? 'ristak' : 'ghl',
          claimedIntent: false
        }
      }
      throw Object.assign(new Error('La cita local cambió de dueño remoto mientras se reclamaba el webhook de HighLevel.'), {
        code: 'highlevel_mirror_intent_claim_conflict',
        status: 409,
        statusCode: 409
      })
    }

    await db.run(`
      UPDATE appointment_highlevel_mirror_intents
      SET status = 'linked', remote_appointment_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE appointment_id = ? AND status = 'prepared'
    `, [remoteAppointmentId, intent.appointment_id])
    return {
      appointment: await getLocalAppointment(intent.appointment_id),
      ownership: 'ristak',
      claimedIntent: true
    }
  })
}

export async function inspectInboundHighLevelAppointment(remoteAppointmentId) {
  const row = await findHighLevelInboundAppointmentRow(remoteAppointmentId)
  if (!row) return { appointment: null, ownership: null }
  return {
    appointment: appointmentRowToApi(row),
    ownership: isRistakOwnedRow(row, LOCAL_APPOINTMENT_PREFIX) ? 'ristak' : 'ghl'
  }
}

/**
 * Puerta única para cualquier cita que entra desde HighLevel.
 *
 * - Si el ID remoto ya está ligado a una cita canónica de Ristak, HighLevel es
 *   sólo un espejo: jamás puede cambiar sus campos, source ni primary key.
 * - Si el remoto difiere, la cita queda pending para que Ristak vuelva a
 *   publicar su estado canónico.
 * - Si el evento nació en HighLevel, sí se importa como ocupación source=ghl.
 */
export async function reconcileInboundHighLevelAppointment(raw = {}, options = {}) {
  const appointmentPayload = raw.appointment && typeof raw.appointment === 'object' ? raw.appointment : raw
  const remoteAppointmentId = cleanString(
    options.ghlAppointmentId || options.ghl_appointment_id ||
    appointmentPayload.ghlAppointmentId || appointmentPayload.ghl_appointment_id ||
    appointmentPayload.appointmentId || appointmentPayload.appointment_id || appointmentPayload.id
  )
  if (!remoteAppointmentId) {
    const error = new Error('HighLevel no envió el ID remoto de la cita')
    error.code = 'highlevel_appointment_id_required'
    error.status = 400
    throw error
  }

  // Segunda compuerta común para pulls, refreshes y webhooks que no pasaron por
  // el preflight de identidad. La intención sólo liga el ID; esta reconciliación
  // sigue siendo la única que puede declarar el eco completo como sincronizado.
  await claimPreparedHighLevelMirrorIntent(options.observedRaw || raw, {
    ghlAppointmentId: remoteAppointmentId,
    remoteCalendarId: options.remoteCalendarId,
    remoteContactId: options.remoteContactId
  })

  const inboundPayload = {
    ...appointmentPayload,
    id: remoteAppointmentId,
    ghlAppointmentId: remoteAppointmentId,
    ...(cleanString(options.calendarId) ? { calendarId: cleanString(options.calendarId) } : {}),
    ...(cleanString(options.contactId) ? { contactId: cleanString(options.contactId) } : {}),
    ...(cleanString(options.locationId) ? { locationId: cleanString(options.locationId) } : {}),
    source: 'ghl'
  }
  const observation = buildHighLevelMirrorObservation(raw, options)

  return db.transaction(async () => {
    if (process.env.DATABASE_URL) {
      await db.get(
        'SELECT pg_advisory_xact_lock(hashtext(?)) AS highlevel_appointment_locked',
        [`highlevel-inbound:${remoteAppointmentId}`]
      )
    }

    const existing = await findHighLevelInboundAppointmentRow(remoteAppointmentId)

    if (existing && isRistakOwnedRow(existing, LOCAL_APPOINTMENT_PREFIX)) {
      const { changedFields, hasCompleteEcho } = compareHighLevelMirrorWithCanonical(existing, observation)
      const previousSyncStatus = cleanString(existing.sync_status).toLowerCase() || 'pending'
      const preservesPendingDelete = previousSyncStatus === 'pending_delete'
      const shouldStayPending = changedFields.length > 0
        || (['pending', 'error'].includes(previousSyncStatus) && !hasCompleteEcho)
      const nextSyncStatus = preservesPendingDelete
        ? 'pending_delete'
        : (shouldStayPending ? 'pending' : 'synced')
      const nextSyncError = changedFields.length > 0
        ? `${HIGHLEVEL_MIRROR_DIVERGED_MARKER} HighLevel difiere en: ${changedFields.join(', ')}`
        : (nextSyncStatus === 'synced' ? null : existing.sync_error)

      const result = await db.run(`
        UPDATE appointments
        SET ghl_appointment_id = ?,
            sync_status = ?,
            sync_error = ?,
            synced_at = CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE synced_at END
        WHERE id = ?
          AND date_updated = ?
      `, [remoteAppointmentId, nextSyncStatus, nextSyncError, nextSyncStatus, existing.id, existing.date_updated])

      if (Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
        const error = new Error('La cita local cambió mientras se reconciliaba el eco de HighLevel; se conservó la versión más reciente.')
        error.status = 409
        error.statusCode = 409
        error.code = 'appointment_provider_response_stale'
        throw error
      }

      return {
        appointment: await getLocalAppointment(existing.id),
        previous: appointmentRowToApi(existing),
        ownership: 'ristak',
        imported: false,
        mirrorMatched: changedFields.length === 0,
        mirrorDiverged: changedFields.length > 0,
        changedFields,
        syncStatus: nextSyncStatus
      }
    }

    const imported = await upsertLocalAppointment(inboundPayload, {
      source: 'ghl',
      ghlAppointmentId: remoteAppointmentId,
      calendarId: cleanString(options.calendarId) || inboundPayload.calendarId,
      locationId: cleanString(options.locationId) || inboundPayload.locationId,
      syncStatus: 'synced',
      lastWriteWins: options.lastWriteWins !== false
    })

    return {
      appointment: imported,
      previous: existing ? appointmentRowToApi(existing) : null,
      ownership: 'ghl',
      imported: !existing,
      mirrorMatched: false,
      mirrorDiverged: false,
      changedFields: [],
      syncStatus: imported.syncStatus
    }
  })
}

function highLevelMirrorFence(expectedAppointment = null) {
  const fencedAppointment = expectedAppointment && typeof expectedAppointment === 'object'
    ? expectedAppointment
    : null
  const fenceSql = fencedAppointment
    ? `
        AND date_updated = ?
        AND start_time = ?
        AND end_time = ?
        AND COALESCE(calendar_id, '') = ?
        AND COALESCE(contact_id, '') = ?
        AND COALESCE(location_id, '') = ?
        AND COALESCE(title, '') = ?
        AND COALESCE(status, '') = ?
        AND COALESCE(appointment_status, '') = ?
        AND COALESCE(assigned_user_id, '') = ?
        AND COALESCE(notes, '') = ?
        AND COALESCE(address, '') = ?
      `
    : ''
  const fenceParams = fencedAppointment
    ? [
        normalizeToUtcIso(fencedAppointment.dateUpdated || fencedAppointment.date_updated, 'UTC'),
        normalizeToUtcIso(fencedAppointment.startTime || fencedAppointment.start_time, 'UTC'),
        normalizeToUtcIso(fencedAppointment.endTime || fencedAppointment.end_time, 'UTC'),
        cleanString(fencedAppointment.calendarId || fencedAppointment.calendar_id),
        cleanString(fencedAppointment.contactId || fencedAppointment.contact_id),
        cleanString(fencedAppointment.locationId || fencedAppointment.location_id),
        cleanString(fencedAppointment.title),
        cleanString(fencedAppointment.status || fencedAppointment.appointmentStatus || fencedAppointment.appointment_status),
        cleanString(fencedAppointment.appointmentStatus || fencedAppointment.appointment_status || fencedAppointment.status),
        cleanString(fencedAppointment.assignedUserId || fencedAppointment.assigned_user_id),
        cleanString(fencedAppointment.notes),
        cleanString(fencedAppointment.address)
      ]
    : []

  if (fencedAppointment && fenceParams.slice(0, 3).some(value => !value)) {
    throw new Error('La versión local esperada de la cita no es válida')
  }

  return { fencedAppointment, fenceSql, fenceParams }
}

function highLevelMirrorResponseStaleError() {
  const error = new Error('La cita volvió a cambiar mientras respondía el calendario externo. Se conservó la versión más reciente.')
  error.status = 409
  error.statusCode = 409
  error.code = 'appointment_provider_response_stale'
  return error
}

async function preserveHighLevelMirrorPendingAfterStale(
  appointmentId,
  remoteAppointmentId = '',
  pendingMessage = ''
) {
  const normalizedRemoteId = cleanString(remoteAppointmentId)
  const safePendingMessage = cleanString(pendingMessage).includes(HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER)
    ? cleanString(pendingMessage).slice(0, 1000)
    : ''
  await db.run(`
    UPDATE appointments
    SET ghl_appointment_id = CASE
          WHEN COALESCE(ghl_appointment_id, '') = '' THEN ?
          ELSE ghl_appointment_id
        END,
        sync_status = CASE
          WHEN sync_status = 'pending_delete' THEN 'pending_delete'
          ELSE 'pending'
        END,
        sync_error = CASE WHEN ? != '' THEN ? ELSE sync_error END
    WHERE id = ?
  `, [normalizedRemoteId || null, safePendingMessage, safePendingMessage, appointmentId])
  return getLocalAppointment(appointmentId)
}

// HighLevel sólo recibe una copia de la cita local. Confirmar esa copia nunca
// debe mezclar campos de negocio devueltos por el proveedor sobre Ristak.
export async function markHighLevelAppointmentMirrorSynced(
  appointmentId,
  ghlAppointmentId,
  { expectedAppointment = null } = {}
) {
  const normalizedAppointmentId = cleanString(appointmentId)
  const normalizedRemoteId = cleanString(ghlAppointmentId)
  if (!normalizedAppointmentId || !normalizedRemoteId) {
    throw new Error('La cita local y el ID del espejo HighLevel son requeridos')
  }
  const { fencedAppointment, fenceSql, fenceParams } = highLevelMirrorFence(expectedAppointment)

  const result = await db.run(`
    UPDATE appointments
    SET ghl_appointment_id = ?,
        sync_status = 'synced',
        sync_error = NULL,
        synced_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (
        COALESCE(ghl_appointment_id, '') = ''
        OR ghl_appointment_id = ?
      )
    ${fenceSql}
  `, [normalizedRemoteId, normalizedAppointmentId, normalizedRemoteId, ...fenceParams])

  if (Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    await preserveHighLevelMirrorPendingAfterStale(normalizedAppointmentId, normalizedRemoteId)
    throw highLevelMirrorResponseStaleError()
  }

  return getLocalAppointment(normalizedAppointmentId)
}

export async function markHighLevelAppointmentMirrorError(
  appointmentId,
  message,
  { expectedAppointment = null } = {}
) {
  const normalizedAppointmentId = cleanString(appointmentId)
  if (!normalizedAppointmentId) return null
  const { fencedAppointment, fenceSql, fenceParams } = highLevelMirrorFence(expectedAppointment)
  const safeMessage = cleanString(message || 'HighLevel no confirmó el espejo.').slice(0, 1000)
  const result = await db.run(`
    UPDATE appointments
    SET sync_status = 'error',
        sync_error = ?
    WHERE id = ?
    ${fenceSql}
  `, [safeMessage, normalizedAppointmentId, ...fenceParams])

  if (fencedAppointment && Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
    await preserveHighLevelMirrorPendingAfterStale(normalizedAppointmentId, '', safeMessage)
    throw highLevelMirrorResponseStaleError()
  }

  return getLocalAppointment(normalizedAppointmentId)
}

export async function createLocalAppointment(appointmentData = {}, { locationId = null, syncStatus = 'pending' } = {}) {
  const startDate = new Date(appointmentData.startTime || appointmentData.start_time)
  const endDate = new Date(appointmentData.endTime || appointmentData.end_time)

  if (Number.isNaN(startDate.getTime())) {
    throw new Error('Fecha de inicio inválida')
  }

  if (Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    throw new Error('La fecha de fin debe ser posterior al inicio')
  }

  const isTest = normalizeTestFlag(appointmentData.isTest ?? appointmentData.is_test)
  const testRunId = cleanString(appointmentData.testRunId || appointmentData.test_run_id)
  const testEffectId = cleanString(appointmentData.testEffectId || appointmentData.test_effect_id)
  const testExpiresAt = appointmentData.testExpiresAt || appointmentData.test_expires_at

  if (isTest && (!testRunId || !testEffectId || !testExpiresAt)) {
    throw new Error('Una cita de prueba requiere testRunId, testEffectId y testExpiresAt')
  }
  if (isTest && Number.isNaN(new Date(testExpiresAt).getTime())) {
    throw new Error('La fecha de expiración de la cita de prueba no es válida')
  }

  const contactId = cleanString(appointmentData.contactId || appointmentData.contact_id)
  const participants = Array.isArray(appointmentData.participants)
    ? appointmentData.participants
    : (contactId
        ? [
            { role: 'requester', contactId },
            { role: 'primary_attendee', contactId }
          ]
        : [])

  return upsertLocalAppointment({
    ...appointmentData,
    participants,
    id: appointmentData.id || makeId(LOCAL_APPOINTMENT_PREFIX),
    locationId: appointmentData.locationId || appointmentData.location_id || locationId,
    source: appointmentData.source || 'ristak'
  }, {
    source: appointmentData.source || 'ristak',
    syncStatus
  })
}

export async function getLocalAppointment(appointmentId) {
  if (!appointmentId) return null
  const row = await db.get(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ? OR a.ghl_appointment_id = ? OR a.google_event_id = ?
    LIMIT 1
  `, [appointmentId, appointmentId, appointmentId])

  if (!row) return null
  const appointment = appointmentRowToApi(row)
  appointment.participants = await getAppointmentParticipants(appointment.id)
  return appointment
}

function upcomingAppointmentsCursorError() {
  const error = new Error('Cursor de próximas citas inválido')
  error.status = 400
  error.code = 'invalid_upcoming_appointments_cursor'
  return error
}

function upcomingAppointmentsCursorScope(calendarId) {
  return hashPaginationCursorScope(UPCOMING_APPOINTMENTS_CURSOR_KIND, {
    v: 1,
    calendarId: cleanString(calendarId),
    sort: 'start_time:asc,id:asc',
    source: 'local'
  })
}

function encodeUpcomingAppointmentsCursor(row, scope) {
  const startTime = cleanString(row?._cursor_start_time || row?.start_time)
  const id = cleanString(row?.id)
  if (!startTime || !id) return null

  return Buffer.from(JSON.stringify({
    v: 2,
    kind: UPCOMING_APPOINTMENTS_CURSOR_KIND,
    scope,
    startTime,
    id
  }), 'utf8').toString('base64url')
}

function decodeUpcomingAppointmentsCursor(value, expectedScope) {
  const cursor = cleanString(value)
  if (!cursor) return null
  if (cursor.length > 600) throw upcomingAppointmentsCursorError()

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const startTime = cleanString(parsed?.startTime)
    const id = cleanString(parsed?.id)
    if (
      parsed?.v !== 2 ||
      parsed?.kind !== UPCOMING_APPOINTMENTS_CURSOR_KIND ||
      parsed?.scope !== expectedScope ||
      !startTime ||
      !id ||
      !Number.isFinite(Date.parse(startTime))
    ) {
      throw upcomingAppointmentsCursorError()
    }
    return { startTime, id }
  } catch (error) {
    if (error?.code === 'invalid_upcoming_appointments_cursor') throw error
    throw upcomingAppointmentsCursorError()
  }
}

function normalizeUpcomingAppointmentsLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return UPCOMING_APPOINTMENTS_DEFAULT_LIMIT
  return Math.min(parsed, UPCOMING_APPOINTMENTS_MAX_LIMIT)
}

function visibleAppointmentsCursorError() {
  const error = new Error('Cursor de citas visibles inválido')
  error.status = 400
  error.code = 'invalid_visible_appointments_cursor'
  return error
}

function normalizeVisibleAppointmentsLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return VISIBLE_APPOINTMENTS_DEFAULT_LIMIT
  return Math.min(parsed, VISIBLE_APPOINTMENTS_MAX_LIMIT)
}

function normalizeMonthAppointmentPreviewLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return MONTH_APPOINTMENT_PREVIEW_DEFAULT_LIMIT
  return Math.min(parsed, MONTH_APPOINTMENT_PREVIEW_MAX_LIMIT)
}

function normalizeAppointmentsOverviewLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return APPOINTMENTS_OVERVIEW_DEFAULT_LIMIT
  return Math.min(parsed, APPOINTMENTS_OVERVIEW_MAX_LIMIT)
}

function normalizeAppointmentInstant(value) {
  if (value instanceof Date) return new Date(value.getTime())
  const raw = cleanString(value)
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return new Date(Number(raw))
  return new Date(raw)
}

function upcomingAppointmentSqlExpressions(alias = 'a') {
  if (isPostgresDatabase) {
    return {
      sort: `${alias}.start_time`,
      parameter: 'CAST(? AS TIMESTAMP)',
      cursorProjection: `${alias}.start_time::text`,
      cursorPredicate: `(${alias}.start_time, ${alias}.id) > (CAST(? AS TIMESTAMP), ?)`
    }
  }

  return {
    sort: `julianday(${alias}.start_time)`,
    parameter: 'julianday(?)',
    cursorProjection: `${alias}.start_time`,
    cursorPredicate: `(julianday(${alias}.start_time), ${alias}.id) > (julianday(?), ?)`
  }
}

function normalizeVisibleAppointmentRange({ startTime, endTime } = {}) {
  const start = normalizeAppointmentInstant(startTime)
  const end = normalizeAppointmentInstant(endTime)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    const error = new Error('Rango visible de citas inválido')
    error.status = 400
    throw error
  }
  return { start, end }
}

async function resolveAppointmentBusinessTimezone(timezone = '') {
  if (isValidTimezone(timezone)) return timezone
  return getAccountTimezone()
}

/**
 * Divide un rango de instantes en días del negocio. Los límites UTC se calculan
 * con Luxon para conservar transiciones DST reales; SQLite nunca intenta
 * interpretar una zona IANA por su cuenta.
 */
export async function buildAppointmentBusinessDayBounds({ startTime, endTime, timezone = '' } = {}) {
  const { start, end } = normalizeVisibleAppointmentRange({ startTime, endTime })
  const businessTimezone = await resolveAppointmentBusinessTimezone(timezone)
  const startInstant = DateTime.fromJSDate(start, { zone: 'utc' })
  const endInstant = DateTime.fromJSDate(end, { zone: 'utc' })
  let day = startInstant.setZone(businessTimezone).startOf('day')
  const lastDay = endInstant.setZone(businessTimezone).startOf('day')
  const exclusiveRangeEndMillis = end.getTime() + 1
  const bounds = []

  while (day <= lastDay) {
    const nextDay = day.plus({ days: 1 }).startOf('day')
    const startMillis = Math.max(start.getTime(), day.toUTC().toMillis())
    const endMillis = Math.min(exclusiveRangeEndMillis, nextDay.toUTC().toMillis())
    if (endMillis > startMillis) {
      bounds.push({
        date: day.toISODate(),
        startUtc: DateTime.fromMillis(startMillis, { zone: 'utc' }).toISO({ suppressMilliseconds: false }),
        endUtc: DateTime.fromMillis(endMillis, { zone: 'utc' }).toISO({ suppressMilliseconds: false })
      })
    }
    day = nextDay
    if (bounds.length > 370) {
      const error = new Error('El rango visible de citas permite hasta 370 días')
      error.status = 400
      throw error
    }
  }

  return { timezone: businessTimezone, bounds }
}

async function countAppointmentsByBusinessDay({ calendarId, bounds, signal } = {}) {
  if (!bounds?.length) return []
  const valuesRow = isPostgresDatabase
    ? '(CAST(? AS TEXT), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP))'
    : '(?, ?, ?)'
  const values = bounds.map(() => valuesRow).join(', ')
  const boundParams = bounds.flatMap(bound => [bound.date, bound.startUtc, bound.endUtc])
  const lowerBound = isPostgresDatabase
    ? 'a.start_time >= day_bounds.start_utc'
    : 'julianday(a.start_time) >= julianday(day_bounds.start_utc)'
  const upperBound = isPostgresDatabase
    ? 'a.start_time < day_bounds.end_utc'
    : 'julianday(a.start_time) < julianday(day_bounds.end_utc)'

  const rows = await db.all(`
    WITH day_bounds(day_key, start_utc, end_utc) AS (
      VALUES ${values}
    )
    SELECT day_bounds.day_key, COUNT(a.id) AS total
    FROM day_bounds
    LEFT JOIN appointments a
      ON a.calendar_id = ?
     AND a.start_time IS NOT NULL
     AND ${lowerBound}
     AND ${upperBound}
     AND COALESCE(a.sync_status, '') != 'pending_delete'
     AND a.deleted_at IS NULL
    GROUP BY day_bounds.day_key
    ORDER BY day_bounds.day_key ASC
  `, [...boundParams, calendarId], { signal })

  return rows.map(row => ({
    date: cleanString(row.day_key),
    total: Math.max(0, Number(row.total || 0))
  }))
}

async function listAppointmentPreviewsByBusinessDay({ calendarId, bounds, previewLimit, signal } = {}) {
  if (!bounds?.length || previewLimit <= 0) return []
  const sql = upcomingAppointmentSqlExpressions('a')
  const dayKeyProjection = isPostgresDatabase ? 'CAST(? AS TEXT)' : '?'
  const clauses = []
  const params = []

  bounds.forEach((bound, index) => {
    clauses.push(`
      SELECT * FROM (
        SELECT
          ${dayKeyProjection} AS _calendar_day,
          a.*,
          c.full_name AS contact_name,
          c.email AS contact_email,
          c.phone AS contact_phone,
          ${sql.cursorProjection} AS _cursor_start_time
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.calendar_id = ?
          AND a.start_time IS NOT NULL
          AND ${sql.sort} >= ${sql.parameter}
          AND ${sql.sort} < ${sql.parameter}
          AND COALESCE(a.sync_status, '') != 'pending_delete'
          AND a.deleted_at IS NULL
        ORDER BY ${sql.sort} ASC, a.id ASC
        LIMIT ?
      ) preview_day_${index}
    `)
    params.push(bound.date, calendarId, bound.startUtc, bound.endUtc, previewLimit)
  })

  return db.all(clauses.join('\nUNION ALL\n'), params, { signal })
}

function visibleAppointmentsCursorScope({ calendarId, startTime, endTime, timezone }) {
  return hashPaginationCursorScope(VISIBLE_APPOINTMENTS_CURSOR_KIND, {
    v: 1,
    calendarId,
    startTime,
    endTime,
    timezone,
    sort: 'start_time:asc,id:asc',
    source: 'local'
  })
}

function encodeVisibleAppointmentsCursor(row, scope) {
  const startTime = cleanString(row?._cursor_start_time || row?.start_time)
  const id = cleanString(row?.id)
  if (!startTime || !id) return null
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: VISIBLE_APPOINTMENTS_CURSOR_KIND,
    scope,
    startTime,
    id
  }), 'utf8').toString('base64url')
}

function decodeVisibleAppointmentsCursor(value, expectedScope) {
  const cursor = cleanString(value)
  if (!cursor) return null
  if (cursor.length > 600) throw visibleAppointmentsCursorError()
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const startTime = cleanString(parsed?.startTime)
    const id = cleanString(parsed?.id)
    if (
      parsed?.v !== 1 ||
      parsed?.kind !== VISIBLE_APPOINTMENTS_CURSOR_KIND ||
      parsed?.scope !== expectedScope ||
      !startTime ||
      !id ||
      !Number.isFinite(Date.parse(startTime))
    ) {
      throw visibleAppointmentsCursorError()
    }
    return { startTime, id }
  } catch (error) {
    if (error?.code === 'invalid_visible_appointments_cursor') throw error
    throw visibleAppointmentsCursorError()
  }
}

/** Conteos exactos por día del negocio, sin devolver ninguna cita. */
export async function getLocalAppointmentDayCounts({
  calendarId,
  startTime,
  endTime,
  timezone = '',
  signal
} = {}) {
  const normalizedCalendarId = cleanString(calendarId)
  if (!normalizedCalendarId) {
    const error = new Error('Se requiere calendarId')
    error.status = 400
    throw error
  }
  const range = normalizeVisibleAppointmentRange({ startTime, endTime })
  const dayBounds = await buildAppointmentBusinessDayBounds({
    startTime: range.start,
    endTime: range.end,
    timezone
  })
  const days = await countAppointmentsByBusinessDay({
    calendarId: normalizedCalendarId,
    bounds: dayBounds.bounds,
    signal
  })
  return {
    timezone: dayBounds.timezone,
    total: days.reduce((sum, day) => sum + day.total, 0),
    days
  }
}

/**
 * Vista mensual: como máximo N previews por día y conteo exacto independiente.
 * El proceso Node materializa a lo sumo 45 * 5 filas aunque el mes tenga
 * cientos de miles de citas.
 */
export async function listLocalAppointmentMonthPreview({
  calendarId,
  startTime,
  endTime,
  previewLimit = MONTH_APPOINTMENT_PREVIEW_DEFAULT_LIMIT,
  timezone = '',
  signal
} = {}) {
  const normalizedCalendarId = cleanString(calendarId)
  if (!normalizedCalendarId) {
    const error = new Error('Se requiere calendarId')
    error.status = 400
    throw error
  }
  const range = normalizeVisibleAppointmentRange({ startTime, endTime })
  const normalizedPreviewLimit = normalizeMonthAppointmentPreviewLimit(previewLimit)
  const dayBounds = await buildAppointmentBusinessDayBounds({
    startTime: range.start,
    endTime: range.end,
    timezone
  })
  if (dayBounds.bounds.length > 45) {
    const error = new Error('La vista mensual permite hasta 45 días')
    error.status = 400
    throw error
  }

  const [counts, previewRows] = await Promise.all([
    countAppointmentsByBusinessDay({
      calendarId: normalizedCalendarId,
      bounds: dayBounds.bounds,
      signal
    }),
    listAppointmentPreviewsByBusinessDay({
      calendarId: normalizedCalendarId,
      bounds: dayBounds.bounds,
      previewLimit: normalizedPreviewLimit,
      signal
    })
  ])
  const previewsByDay = new Map(dayBounds.bounds.map(bound => [bound.date, []]))
  for (const row of previewRows) {
    const date = cleanString(row._calendar_day)
    if (!previewsByDay.has(date)) previewsByDay.set(date, [])
    previewsByDay.get(date).push(appointmentRowToApi(row))
  }
  for (const items of previewsByDay.values()) {
    items.sort((left, right) => (
      Date.parse(left.startTime) - Date.parse(right.startTime) || left.id.localeCompare(right.id)
    ))
  }
  const countByDay = new Map(counts.map(day => [day.date, day.total]))
  const days = dayBounds.bounds.map(bound => ({
    date: bound.date,
    total: countByDay.get(bound.date) || 0,
    items: previewsByDay.get(bound.date) || []
  }))

  return {
    timezone: dayBounds.timezone,
    previewLimit: normalizedPreviewLimit,
    total: days.reduce((sum, day) => sum + day.total, 0),
    days
  }
}

/** Página keyset exacta para las vistas de día y semana. */
export async function listVisibleLocalAppointmentsPage({
  calendarId,
  startTime,
  endTime,
  cursor = '',
  limit = VISIBLE_APPOINTMENTS_DEFAULT_LIMIT,
  includeCounts = true,
  timezone = '',
  signal
} = {}) {
  const normalizedCalendarId = cleanString(calendarId)
  if (!normalizedCalendarId) {
    const error = new Error('Se requiere calendarId')
    error.status = 400
    throw error
  }
  const range = normalizeVisibleAppointmentRange({ startTime, endTime })
  const businessTimezone = await resolveAppointmentBusinessTimezone(timezone)
  const normalizedStart = range.start.toISOString()
  const normalizedEnd = range.end.toISOString()
  // El frontend expresa el final inclusivo con precisión de milisegundo. La DB
  // PostgreSQL conserva microsegundos, así que comparar <= .999 perdería filas
  // válidas como .999500. Convertimos una sola vez a límite exclusivo.
  const normalizedExclusiveEnd = new Date(range.end.getTime() + 1).toISOString()
  const scope = visibleAppointmentsCursorScope({
    calendarId: normalizedCalendarId,
    startTime: normalizedStart,
    endTime: normalizedEnd,
    timezone: businessTimezone
  })
  const decodedCursor = decodeVisibleAppointmentsCursor(cursor, scope)
  const normalizedLimit = normalizeVisibleAppointmentsLimit(limit)
  const sql = upcomingAppointmentSqlExpressions('a')
  const conditions = [
    'a.calendar_id = ?',
    'a.start_time IS NOT NULL',
    `${sql.sort} >= ${sql.parameter}`,
    `${sql.sort} < ${sql.parameter}`,
    "COALESCE(a.sync_status, '') != 'pending_delete'",
    'a.deleted_at IS NULL'
  ]
  const params = [normalizedCalendarId, normalizedStart, normalizedExclusiveEnd]
  if (decodedCursor) {
    conditions.push(sql.cursorPredicate)
    params.push(decodedCursor.startTime, decodedCursor.id)
  }

  const pagePromise = db.all(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      ${sql.cursorProjection} AS _cursor_start_time
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sql.sort} ASC, a.id ASC
    LIMIT ?
  `, [...params, normalizedLimit + 1], { signal })
  const countsPromise = includeCounts
    ? getLocalAppointmentDayCounts({
        calendarId: normalizedCalendarId,
        startTime: range.start,
        endTime: range.end,
        timezone: businessTimezone,
        signal
      })
    : Promise.resolve(null)
  const [rows, counts] = await Promise.all([pagePromise, countsPromise])
  const hasNext = rows.length > normalizedLimit
  const pageRows = hasNext ? rows.slice(0, normalizedLimit) : rows
  const lastRow = pageRows[pageRows.length - 1]

  return {
    timezone: businessTimezone,
    items: pageRows.map(appointmentRowToApi),
    ...(counts ? { total: counts.total, days: counts.days } : {}),
    pagination: {
      limit: normalizedLimit,
      hasNext,
      nextCursor: hasNext ? encodeVisibleAppointmentsCursor(lastRow, scope) : null
    }
  }
}

/**
 * Página local y acotada para el panel "Próximas citas". No contacta a
 * HighLevel/Google y el cursor queda ligado al calendario seleccionado.
 */
export async function listUpcomingLocalAppointmentsPage({
  calendarId,
  cursor = '',
  limit = UPCOMING_APPOINTMENTS_DEFAULT_LIMIT,
  now = new Date()
} = {}) {
  const normalizedCalendarId = cleanString(calendarId)
  if (!normalizedCalendarId) {
    const error = new Error('Se requiere calendarId')
    error.status = 400
    throw error
  }

  const normalizedNow = normalizeAppointmentInstant(now)
  if (Number.isNaN(normalizedNow.getTime())) {
    const error = new Error('El instante actual es inválido')
    error.status = 400
    throw error
  }

  const normalizedLimit = normalizeUpcomingAppointmentsLimit(limit)
  const cursorScope = upcomingAppointmentsCursorScope(normalizedCalendarId)
  const decodedCursor = decodeUpcomingAppointmentsCursor(cursor, cursorScope)
  const sql = upcomingAppointmentSqlExpressions('a')
  const conditions = [
    'a.calendar_id = ?',
    'a.start_time IS NOT NULL',
    `${sql.sort} >= ${sql.parameter}`,
    "COALESCE(a.sync_status, '') != 'pending_delete'",
    'a.deleted_at IS NULL'
  ]
  const params = [normalizedCalendarId, normalizedNow.toISOString()]

  if (decodedCursor) {
    conditions.push(sql.cursorPredicate)
    params.push(decodedCursor.startTime, decodedCursor.id)
  }

  const rows = await db.all(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      ${sql.cursorProjection} AS _cursor_start_time
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sql.sort} ASC, a.id ASC
    LIMIT ?
  `, [...params, normalizedLimit + 1])

  const hasNext = rows.length > normalizedLimit
  const pageRows = hasNext ? rows.slice(0, normalizedLimit) : rows
  const lastRow = pageRows[pageRows.length - 1]

  return {
    items: pageRows.map(appointmentRowToApi),
    pagination: {
      limit: normalizedLimit,
      hasNext,
      nextCursor: hasNext ? encodeUpcomingAppointmentsCursor(lastRow, cursorScope) : null
    }
  }
}

function appointmentStatsFromRows(rows = []) {
  const stats = {
    pending: 0,
    cancelled: 0,
    confirmed: 0,
    rescheduled: 0,
    showed: 0,
    noshow: 0
  }

  for (const row of rows) {
    const status = cleanString(row.appointment_status).toLowerCase()
    const total = Number(row.total || 0)
    if (status === 'confirmed') {
      const future = Number(row.future_confirmed || 0)
      stats.pending += future
      stats.confirmed += Math.max(total - future, 0)
    } else if (Object.prototype.hasOwnProperty.call(stats, status) && status !== 'pending') {
      stats[status] += total
    }
  }

  return stats
}

/** Agregado mensual local para KPIs; evita descargar todas las citas del mes. */
export async function getLocalAppointmentStats({
  calendarId,
  startTime,
  endTime,
  now = new Date(),
  signal
} = {}) {
  const normalizedCalendarId = cleanString(calendarId)
  const normalizedStart = normalizeAppointmentInstant(startTime)
  const normalizedEnd = normalizeAppointmentInstant(endTime)
  const normalizedNow = normalizeAppointmentInstant(now)
  if (
    !normalizedCalendarId ||
    Number.isNaN(normalizedStart.getTime()) ||
    Number.isNaN(normalizedEnd.getTime()) ||
    Number.isNaN(normalizedNow.getTime()) ||
    normalizedEnd < normalizedStart
  ) {
    const error = new Error('Rango de resumen de citas inválido')
    error.status = 400
    throw error
  }

  const sql = upcomingAppointmentSqlExpressions('a')
  const statusExpression = "LOWER(COALESCE(a.appointment_status, a.status, ''))"
  const normalizedExclusiveEnd = new Date(normalizedEnd.getTime() + 1).toISOString()
  const rows = await db.all(`
    SELECT
      ${statusExpression} AS appointment_status,
      COUNT(*) AS total,
      SUM(CASE
        WHEN ${statusExpression} = 'confirmed' AND ${sql.sort} >= ${sql.parameter}
        THEN 1 ELSE 0
      END) AS future_confirmed
    FROM appointments a
    WHERE a.calendar_id = ?
      AND a.start_time IS NOT NULL
      AND ${sql.sort} >= ${sql.parameter}
      AND ${sql.sort} < ${sql.parameter}
      AND COALESCE(a.sync_status, '') != 'pending_delete'
      AND a.deleted_at IS NULL
    GROUP BY ${statusExpression}
  `, [
    normalizedNow.toISOString(),
    normalizedCalendarId,
    normalizedStart.toISOString(),
    normalizedExclusiveEnd
  ], { signal })

  return appointmentStatsFromRows(rows)
}

/**
 * Resumen multi-calendario para la portada móvil: KPIs exactos del rango y sólo
 * las próximas N citas. Sustituye la descarga histórica completa de PhoneApp.
 */
export async function getLocalAppointmentsOverview({
  startTime,
  endTime,
  now = new Date(),
  limit = APPOINTMENTS_OVERVIEW_DEFAULT_LIMIT,
  signal
} = {}) {
  const range = normalizeVisibleAppointmentRange({ startTime, endTime })
  const normalizedNow = normalizeAppointmentInstant(now)
  if (Number.isNaN(normalizedNow.getTime())) {
    const error = new Error('El instante actual es inválido')
    error.status = 400
    throw error
  }

  const sql = upcomingAppointmentSqlExpressions('a')
  const statusExpression = "LOWER(COALESCE(a.appointment_status, a.status, ''))"
  const normalizedStart = range.start.toISOString()
  const normalizedExclusiveEnd = new Date(range.end.getTime() + 1).toISOString()
  const normalizedLimit = normalizeAppointmentsOverviewLimit(limit)
  const upcomingStart = new Date(Math.max(range.start.getTime(), normalizedNow.getTime())).toISOString()

  const statsPromise = db.all(`
    SELECT
      ${statusExpression} AS appointment_status,
      COUNT(*) AS total,
      SUM(CASE
        WHEN ${statusExpression} = 'confirmed' AND ${sql.sort} >= ${sql.parameter}
        THEN 1 ELSE 0
      END) AS future_confirmed
    FROM appointments a
    WHERE a.start_time IS NOT NULL
      AND ${sql.sort} >= ${sql.parameter}
      AND ${sql.sort} < ${sql.parameter}
      AND COALESCE(a.sync_status, '') != 'pending_delete'
      AND a.deleted_at IS NULL
    GROUP BY ${statusExpression}
  `, [
    normalizedNow.toISOString(),
    normalizedStart,
    normalizedExclusiveEnd
  ], { signal })

  const upcomingPromise = normalizedNow.getTime() > range.end.getTime()
    ? Promise.resolve([])
    : db.all(`
        SELECT
          a.*,
          ${sql.cursorProjection} AS _cursor_start_time
        FROM appointments a
        WHERE a.start_time IS NOT NULL
          AND ${sql.sort} >= ${sql.parameter}
          AND ${sql.sort} < ${sql.parameter}
          AND COALESCE(a.sync_status, '') != 'pending_delete'
          AND a.deleted_at IS NULL
        ORDER BY ${sql.sort} ASC, a.id ASC
        LIMIT ?
      `, [upcomingStart, normalizedExclusiveEnd, normalizedLimit], { signal })

  const [statsRows, upcomingRows] = await Promise.all([statsPromise, upcomingPromise])
  return {
    stats: appointmentStatsFromRows(statsRows),
    upcoming: upcomingRows.map(appointmentRowToApi),
    limit: normalizedLimit
  }
}

export async function listLocalAppointments({ startTime, endTime, calendarId, includeOverlapping = false, signal } = {}) {
  // IMPORTANTE: esta consulta hace JOIN con `contacts`, y AMBAS tablas (appointments y
  // contacts) tienen columnas `deleted_at`/`sync_status`. En Postgres, referenciarlas sin
  // el alias de tabla lanza «column reference "deleted_at" is ambiguous» y revienta el
  // listado de citas (admin) y el cálculo de horarios públicos (free-slots). Por eso TODAS
  // las condiciones van calificadas con `a.` (la tabla appointments). SQLite no se queja,
  // pero producción usa Postgres.
  const conditions = ["COALESCE(a.sync_status, '') != 'pending_delete'", 'a.deleted_at IS NULL']
  const params = []

  if (startTime) {
    conditions.push(includeOverlapping ? 'COALESCE(a.end_time, a.start_time) >= ?' : 'a.start_time >= ?')
    params.push(new Date(Number(startTime) || startTime).toISOString())
  }

  if (endTime) {
    conditions.push('a.start_time <= ?')
    params.push(new Date(Number(endTime) || endTime).toISOString())
  }

  if (calendarId) {
    conditions.push('a.calendar_id = ?')
    params.push(calendarId)
  }

  const rows = await db.all(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.start_time ASC
  `, params, { signal })

  return rows.map(appointmentRowToApi)
}

export async function updateLocalAppointment(appointmentId, updates = {}, { syncStatus = 'pending' } = {}) {
  const existing = await getLocalAppointment(appointmentId)
  if (!existing) return null

  const result = await upsertLocalAppointment({
    ...existing,
    ...updates,
    id: existing.id,
    ghlAppointmentId: existing.ghlAppointmentId,
    calendarId: updates.calendarId || updates.calendar_id || existing.calendarId,
    contactId: updates.contactId || updates.contact_id || existing.contactId,
    locationId: updates.locationId || updates.location_id || existing.locationId,
    source: existing.source || 'ristak',
    dateUpdated: new Date().toISOString()
  }, {
    syncStatus
  })

  // (APT-003) Si la cita se reprogramó (cambió start_time), olvidamos los recordatorios ya
  // registrados para que el cron recalcule y reenvíe en la nueva fecha. Sin esto el dedup
  // por (reminder_id|appointment_id) deja el recordatorio congelado en la hora vieja.
  const prevStart = sameTime(existing.startTime, result?.startTime, 0) ? null : existing.startTime
  if (prevStart && result?.startTime) {
    try {
      const { clearAppointmentReminderSends } = await import('./appointmentRemindersService.js')
      await clearAppointmentReminderSends(result.id)
    } catch (error) {
      logger.warn(`No se pudieron limpiar recordatorios tras reprogramar la cita ${result?.id}: ${error.message}`)
    }
  }

  return result
}

export async function deleteLocalAppointment(appointmentId, { markPendingDelete = false } = {}) {
  const existing = await getLocalAppointment(appointmentId)
  if (!existing) return false

  const affectedContactIds = [...new Set([
    existing.contactId,
    ...(Array.isArray(existing.participants) ? existing.participants.map(participant => participant.contactId) : [])
  ].filter(Boolean))]

  if (markPendingDelete && existing.ghlAppointmentId) {
    await db.run(`
      UPDATE appointments
      SET sync_status = 'pending_delete',
          appointment_status = 'cancelled',
          status = 'cancelled',
          date_updated = CURRENT_TIMESTAMP,
          deleted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [existing.id])
  } else {
    // SQLite local puede correr con foreign_keys desactivado. Borramos los
    // participantes explícitamente y dentro de la misma transacción para no
    // dejar snapshots huérfanos.
    await db.transaction(async () => {
      await db.run('DELETE FROM appointment_highlevel_mirror_intents WHERE appointment_id = ?', [existing.id])
      await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [existing.id])
      await db.run('DELETE FROM appointments WHERE id = ?', [existing.id])
    })
  }

  for (const contactId of affectedContactIds) {
    await updateContactAppointmentDate(contactId)
  }

  return true
}

// (GCAL-001) Marca una cita como cancelada SIN borrarla. Se usa cuando un evento de
// Google se cancela: conservamos el registro local (notas, contacto, trazabilidad) en
// lugar de hacer hard-delete. No reescribe Google (el evento ya viene cancelado de allá).
export async function cancelLocalAppointment(appointmentId) {
  const existing = await getLocalAppointment(appointmentId)
  if (!existing) return false

  await db.run(`
    UPDATE appointments
    SET appointment_status = 'cancelled',
        status = 'cancelled',
        date_updated = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [existing.id])

  if (existing.contactId) {
    await updateContactAppointmentDate(existing.contactId)
  }

  return true
}

export async function updateContactAppointmentDate(contactId) {
  if (!contactId) return

  const row = await db.get(`
    SELECT MIN(a.start_time) AS appointment_date
    FROM appointments a
    WHERE (
        a.contact_id = ?
        OR EXISTS (
          SELECT 1
          FROM appointment_participants ap
          WHERE ap.appointment_id = a.id AND ap.contact_id = ?
        )
      )
      AND a.deleted_at IS NULL
      AND COALESCE(a.sync_status, '') != 'pending_delete'
      -- APT-010: excluir 'noshow' además de cancelladas/invalid para no fijar appointment_date sobre una cita a la que el contacto no asistió
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
  `, [contactId, contactId])

  await db.run(
    'UPDATE contacts SET appointment_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [row?.appointment_date || null, contactId]
  )

  await updateSingleContactStats(contactId).catch(error => {
    logger.warn(`No se pudieron actualizar stats del contacto ${contactId}: ${error.message}`)
  })
}

// (GCAL-006) Helpers locales para resolver/crear contacto desde un evento de Google.
// Misma lógica que upsertPublicCalendarContact del controller, pero EXPORTADA aquí
// (el controller es privado y no se puede importar). Reutiliza findContactByPhoneCandidates,
// el match por email LOWER(email)=LOWER(?), y prepare/finalize del teléfono.
function normalizeGoogleContactEmail(value) {
  const email = cleanString(value).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function splitGoogleContactName(fullName = '') {
  return splitContactName(fullName)
}

/**
 * (GCAL-006) Resuelve un contacto existente por teléfono/email o crea uno nuevo
 * para una cita entrante de Google Calendar. Devuelve el contactId o null si no
 * hay datos de contacto utilizables (degrada con seguridad: la cita entra sin
 * contacto, como hoy).
 */
export async function resolveOrCreateContactForGoogleAppointment({ email, name, phone } = {}) {
  const fullName = formatContactName(cleanString(name))
  const normalizedEmail = normalizeGoogleContactEmail(email)
  const rawPhone = cleanString(phone)
  // (GCAL-006) Normaliza el teléfono según la cuenta (mismo helper que el controller público).
  const normalizedPhone = rawPhone
    ? (await normalizePhoneForAccount(rawPhone).catch(() => null)) || rawPhone
    : ''

  const hasUsablePhone = Boolean(normalizedPhone && normalizedPhone.replace(/[^\d]/g, '').length >= 7)

  // (GCAL-006) Sin teléfono utilizable ni email: no hay forma fiable de identificar
  // al invitado. Degradar con seguridad dejando la cita sin contacto.
  if (!hasUsablePhone && !normalizedEmail) {
    return null
  }

  // (GCAL-006) Match primero por teléfono, luego por email (misma prioridad que el controller).
  const byPhone = hasUsablePhone
    ? await findContactByPhoneCandidates(normalizedPhone).catch(() => null)
    : null
  const byEmail = !byPhone && normalizedEmail
    ? await db.get(
        'SELECT id FROM contacts WHERE LOWER(email) = LOWER(?) ORDER BY updated_at DESC LIMIT 1',
        [normalizedEmail]
      ).catch(() => null)
    : null

  const contactId = byPhone?.id || byEmail?.id || generateContactId()
  const names = splitGoogleContactName(fullName)
  // (GCAL-006) Si el invitado no trajo nombre, usar el email como etiqueta legible.
  const displayName = fullName || normalizedEmail || normalizedPhone || 'Invitado de Google'

  const phoneUpsert = hasUsablePhone
    ? await prepareContactPhoneUpsert({ contactId, phone: normalizedPhone })
    : { phone: null }

  // (GCAL-006) INSERT ... ON CONFLICT(id) DO UPDATE funciona en SQLite y Postgres.
  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(excluded.phone, contacts.phone),
      email = COALESCE(excluded.email, contacts.email),
      full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
      first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
      last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
      source = COALESCE(NULLIF(contacts.source, ''), excluded.source),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    phoneUpsert.phone || normalizedPhone || null,
    normalizedEmail || null,
    displayName,
    names.firstName || null,
    names.lastName || null,
    'google_calendar' // (GCAL-006) source del contacto creado desde un evento de Google
  ])

  if (hasUsablePhone) await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
  return contactId
}

// Normaliza un día a número 0..6 (igual que Date.getDay(): 0=domingo).
// Acepta number o string ("1") y la convención ISO 7=domingo -> 0.
function normalizeWeekDay(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || cleanString(value) === '') return null
  const n = Number(value)
  if (!Number.isInteger(n)) return null
  if (n === 7) return 0
  return n >= 0 && n <= 6 ? n : null
}

function getCalendarOpenIntervals(calendar, date, { allowDefault = true } = {}) {
  const openHours = normalizeOpenHours(calendar.openHours || calendar.open_hours)
  const availabilityScheduleConfigured = (
    calendar.availabilityScheduleConfigured === true
    || Number(calendar.availability_schedule_configured) === 1
    || openHours.length > 0
  )
  const jsDay = date.getDay()

  // Compatibilidad exclusiva para registros legacy que todavía no pasaron por el
  // backfill. Una agenda explícitamente configurada como [] significa cerrada.
  const defaultIntervalsForDay = () =>
    (jsDay === 0 || jsDay === 6) ? [] : [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]

  if (!openHours.length) {
    return allowDefault && !availabilityScheduleConfigured ? defaultIntervalsForDay() : []
  }

  let matchedAnyDay = false
  const intervals = []
  for (const schedule of openHours) {
    if (!schedule || typeof schedule !== 'object') continue
    // Días: soporta { daysOfTheWeek:[...] } y la forma plana { day } / { dayOfWeek }.
    // OJO: los valores pueden venir como strings ("1") desde selects/JSON; por eso
    // normalizamos a número antes de comparar (antes esto dejaba el calendario sin
    // NINGÚN horario disponible, "todos los días en gris").
    const rawDays = Array.isArray(schedule.daysOfTheWeek)
      ? schedule.daysOfTheWeek
      : (schedule.day !== undefined ? [schedule.day]
        : (schedule.dayOfWeek !== undefined ? [schedule.dayOfWeek] : []))
    const days = rawDays.map(normalizeWeekDay).filter(day => day !== null)
    matchedAnyDay = matchedAnyDay || days.length > 0
    if (!days.includes(jsDay)) continue
    // Horas: { hours:[...] } o la propia entrada plana con openHour/closeHour.
    const hours = Array.isArray(schedule.hours) && schedule.hours.length
      ? schedule.hours
      : [schedule]
    intervals.push(...hours)
  }

  // Un formato configurado pero ilegible falla cerrado. No inventamos 9–17 si el
  // usuario o un proveedor guardó una agenda explícita que no podemos interpretar.
  if (!matchedAnyDay) {
    return allowDefault && !availabilityScheduleConfigured ? defaultIntervalsForDay() : []
  }

  return intervals
}

function normalizeCalendarOpenInterval(interval, { allowFallback = true } = {}) {
  if (!interval || typeof interval !== 'object') return null

  if (allowFallback) {
    return {
      openHour: toInt(interval.openHour, 9),
      openMinute: toInt(interval.openMinute, 0),
      closeHour: toInt(interval.closeHour, 17),
      closeMinute: toInt(interval.closeMinute, 0)
    }
  }

  const rawParts = [
    interval.openHour,
    interval.openMinute,
    interval.closeHour,
    interval.closeMinute
  ]
  if (rawParts.some(value => (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || cleanString(value) === ''
  ))) return null

  const normalized = {
    openHour: Number(interval.openHour),
    openMinute: Number(interval.openMinute),
    closeHour: Number(interval.closeHour),
    closeMinute: Number(interval.closeMinute)
  }
  if (!Object.values(normalized).every(Number.isInteger)) return null
  if (normalized.openHour < 0 || normalized.openHour > 23) return null
  if (normalized.closeHour < 0 || normalized.closeHour > 24) return null
  if (normalized.openMinute < 0 || normalized.openMinute > 59) return null
  if (normalized.closeMinute < 0 || normalized.closeMinute > 59) return null
  if (normalized.closeHour === 24 && normalized.closeMinute !== 0) return null

  const openMinuteOfDay = normalized.openHour * 60 + normalized.openMinute
  const closeMinuteOfDay = normalized.closeHour * 60 + normalized.closeMinute
  return closeMinuteOfDay > openMinuteOfDay ? normalized : null
}

function checkStrictSlotOpenHours(calendar, slotStartMs, slotEndMs, zone) {
  const slotStart = DateTime.fromMillis(slotStartMs, { zone })
  const slotEnd = DateTime.fromMillis(slotEndMs, { zone })
  if (!slotStart.isValid || !slotEnd.isValid) {
    return { available: false, reason: 'invalid_slot' }
  }

  const expectedDurationMinutes = Math.max(1, calendarDurationToMinutes(
    calendar.slotDuration,
    calendar.slotDurationUnit,
    60
  ))
  const expectedDurationMs = expectedDurationMinutes * 60 * 1000
  const actualDurationMs = slotEndMs - slotStartMs
  if (actualDurationMs !== expectedDurationMs) {
    return {
      available: false,
      reason: 'slot_duration_mismatch',
      expectedDurationMinutes,
      actualDurationMinutes: actualDurationMs / (60 * 1000)
    }
  }

  const intervals = getCalendarOpenIntervals(
    calendar,
    { getDay: () => slotStart.weekday % 7 },
    { allowDefault: false }
  )
    .map(interval => normalizeCalendarOpenInterval(interval, { allowFallback: false }))
    .filter(Boolean)

  const localDay = slotStart.startOf('day')
  const containingIntervals = intervals
    .map((interval) => ({
      open: localDay.set({
        hour: interval.openHour,
        minute: interval.openMinute,
        second: 0,
        millisecond: 0
      }),
      close: localDay.set({
        hour: interval.closeHour,
        minute: interval.closeMinute,
        second: 0,
        millisecond: 0
      })
    }))
    .filter(({ open, close }) => (
      open.isValid
      && close.isValid
      && slotStartMs >= open.toMillis()
      && slotEndMs <= close.toMillis()
    ))

  if (!containingIntervals.length) {
    return { available: false, reason: 'outside_open_hours' }
  }

  const intervalMinutes = Math.max(1, calendarDurationToMinutes(
    calendar.slotInterval,
    calendar.slotIntervalUnit,
    calendarDurationToMinutes(calendar.slotDuration, calendar.slotDurationUnit, 60)
  ))
  const intervalMs = intervalMinutes * 60 * 1000
  const aligned = containingIntervals.some(({ open }) => (
    (slotStartMs - open.toMillis()) % intervalMs === 0
  ))

  return aligned
    ? { available: true }
    : { available: false, reason: 'slot_not_aligned' }
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB
}

const NON_BLOCKING_APPOINTMENT_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'deleted'
])

function isBlockingCalendarAppointment(appointment = {}) {
  const status = cleanString(appointment.appointmentStatus || appointment.status).toLowerCase()
  return !NON_BLOCKING_APPOINTMENT_STATUSES.has(status)
}

function appointmentStartsOnBusinessDate(appointment = {}, dateKey, zone) {
  const start = DateTime.fromISO(cleanString(appointment.startTime), { setZone: true })
  return start.isValid && start.setZone(zone).toISODate() === dateKey
}

function getCalendarBufferMinutes(calendar = {}) {
  const toBufferMinutes = (value, unit) => {
    const amount = Number(value)
    return Number.isFinite(amount) && amount > 0
      ? Math.max(0, calendarDurationToMinutes(amount, unit, 0))
      : 0
  }
  return {
    before: toBufferMinutes(calendar.preBuffer, calendar.preBufferUnit),
    after: toBufferMinutes(calendar.slotBuffer, calendar.slotBufferUnit)
  }
}

function bufferedAppointmentOverlaps(
  slotStartMs,
  slotEndMs,
  eventStartMs,
  eventEndMs,
  { before = 0, after = 0 } = {}
) {
  if (![slotStartMs, slotEndMs, eventStartMs, eventEndMs].every(Number.isFinite)) return false
  const beforeMs = Math.max(0, Number(before) || 0) * 60 * 1000
  const afterMs = Math.max(0, Number(after) || 0) * 60 * 1000
  return overlaps(
    slotStartMs - beforeMs,
    slotEndMs + afterMs,
    eventStartMs - beforeMs,
    eventEndMs + afterMs
  )
}

function sameText(a, b) {
  return cleanString(a).toLowerCase() === cleanString(b).toLowerCase()
}

function sameTime(a, b, toleranceMs = 60000) {
  const timeA = new Date(a).getTime()
  const timeB = new Date(b).getTime()
  if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) return false
  return Math.abs(timeA - timeB) <= toleranceMs
}

function isRistakOwnedRow(row = {}, prefix = '') {
  const source = cleanString(row.source).toLowerCase()
  const id = cleanString(row.id)
  return source === 'ristak' || (prefix && id.startsWith(prefix))
}

function isPendingHighLevelLinkedRow(row = {}, remoteIdColumn = '') {
  const status = cleanString(row.sync_status).toLowerCase()
  const source = cleanString(row.source).toLowerCase()
  const remoteId = cleanString(row[remoteIdColumn])

  return Boolean(
    remoteId
    && source === 'ghl'
    && ['pending', 'error', 'pending_delete'].includes(status)
  )
}

function isHighLevelCalendar(calendar = {}) {
  return normalizeCalendarSource(calendar.source) === 'ghl' || Boolean(cleanString(calendar.ghlCalendarId || calendar.ghl_calendar_id))
}

function getSlotAppointmentLimit(calendar = {}) {
  return Number(calendar.allowOverlaps ?? calendar.allow_overlaps) === 1 || calendar.allowOverlaps === true
    ? Number.POSITIVE_INFINITY
    : 1
}

function getEffectiveSlotAppointmentLimit(calendar = {}, options = {}) {
  if (options.ignoreAppointmentConflicts) return Number.POSITIVE_INFINITY
  return getSlotAppointmentLimit(calendar)
}

// (APT-001) Verifica que el slot solicitado todavía tenga cupo antes de crear una cita
// desde el admin. Reusa la misma lógica de límite/solapamiento que los slots públicos
// (overlaps + getEffectiveSlotAppointmentLimit) para evitar doble-booking silencioso.
// Devuelve { available, limit, overlapping }. `excludeAppointmentId` permite ignorar la
// propia cita al reprogramar.
export async function checkSlotAvailability(calendarId, startTime, endTime, options = {}) {
  const calendar = await getLocalCalendar(calendarId)
  if (!calendar) return { available: true, limit: Number.POSITIVE_INFINITY, overlapping: 0 }

  const limit = getEffectiveSlotAppointmentLimit(calendar, options)
  const slotStartMs = new Date(startTime).getTime()
  const slotEndMs = new Date(endTime || startTime).getTime()
  if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs) || slotEndMs <= slotStartMs) {
    return { available: false, limit, overlapping: 0, reason: 'invalid_slot' }
  }

  const zone = isValidTimezone(options.timezone) ? options.timezone : await getAccountTimezone()
  const enforceCalendarRules = options.enforceCalendarRules === true
  if (enforceCalendarRules) {
    const bookingWindow = getCalendarBookingWindow(calendar, zone, options.currentTimeMs)
    if (
      slotStartMs < bookingWindow.earliestStartMs
      || (Number.isFinite(bookingWindow.latestStartMs) && slotStartMs > bookingWindow.latestStartMs)
    ) {
      return {
        available: false,
        limit,
        overlapping: 0,
        reason: 'outside_booking_window',
        earliestStart: new Date(bookingWindow.earliestStartMs).toISOString(),
        latestStart: Number.isFinite(bookingWindow.latestStartMs)
          ? new Date(bookingWindow.latestStartMs).toISOString()
          : null
      }
    }

    const openHoursCheck = checkStrictSlotOpenHours(calendar, slotStartMs, slotEndMs, zone)
    if (!openHoursCheck.available) {
      return {
        available: false,
        limit,
        overlapping: 0,
        reason: openHoursCheck.reason,
        ...(openHoursCheck.expectedDurationMinutes !== undefined
          ? { expectedDurationMinutes: openHoursCheck.expectedDurationMinutes }
          : {}),
        ...(openHoursCheck.actualDurationMinutes !== undefined
          ? { actualDurationMinutes: openHoursCheck.actualDurationMinutes }
          : {})
      }
    }
  }

  const excludeId = cleanString(options.excludeAppointmentId || '')
  const existing = (await listLocalAppointments({ calendarId }))
    .filter(event => (
      (!excludeId || cleanString(event.id) !== excludeId)
      && isBlockingCalendarAppointment(event)
    ))
  const buffers = enforceCalendarRules && Number.isFinite(limit)
    ? getCalendarBufferMinutes(calendar)
    : { before: 0, after: 0 }
  const overlapping = existing.filter(event => overlaps(
    slotStartMs,
    slotEndMs,
    new Date(event.startTime).getTime(),
    new Date(event.endTime || event.startTime).getTime()
  )).length
  const bufferConflict = existing.some(event => {
    const eventStartMs = new Date(event.startTime).getTime()
    const eventEndMs = new Date(event.endTime || event.startTime).getTime()
    return (
      !overlaps(slotStartMs, slotEndMs, eventStartMs, eventEndMs)
      && bufferedAppointmentOverlaps(slotStartMs, slotEndMs, eventStartMs, eventEndMs, buffers)
    )
  })

  const dailyLimit = Math.max(0, toInt(calendar.appoinmentPerDay, 0))
  if (enforceCalendarRules && dailyLimit > 0) {
    const slotDateKey = DateTime.fromMillis(slotStartMs, { zone }).toISODate()
    const appointmentsOnDay = existing.filter(event => (
      appointmentStartsOnBusinessDate(event, slotDateKey, zone)
    )).length
    if (appointmentsOnDay >= dailyLimit) {
      return {
        available: false,
        limit,
        overlapping,
        dailyLimit,
        appointmentsOnDay,
        reason: 'daily_limit_reached'
      }
    }
  }

  // (APT-004) Bloqueos de horario nativos: si el slot cae sobre un horario bloqueado,
  // no está disponible (igual que una cita), aunque no haya HighLevel.
  const blockedOverlaps = await getOverlappingLocalBlockedSlots(
    calendarId,
    slotStartMs - buffers.before * 60 * 1000,
    slotEndMs + buffers.after * 60 * 1000,
    {
      // Los flujos que prometen disponibilidad real (Por defecto y
      // Personalizado) jamás deben asumir que no hay ausencias cuando la
      // lectura de blocked_slots falló. Sólo el alta legacy conserva el
      // comportamiento fail-open de compatibilidad.
      failClosed: enforceCalendarRules || options.ignoreAppointmentConflicts === true
    }
  )
  if (blockedOverlaps.length > 0) {
    return { available: false, limit, overlapping, blocked: true, reason: 'blocked' }
  }

  return {
    available: (!Number.isFinite(limit) || overlapping < limit) && !bufferConflict,
    limit,
    overlapping,
    ...(bufferConflict ? { bufferConflict: true, reason: 'buffer_conflict' } : {}),
    ...(!bufferConflict && Number.isFinite(limit) && overlapping >= limit ? { reason: 'slot_conflict' } : {})
  }
}

// (APT-004) Bloqueos de horario NATIVOS (calendarios Ristak/Google, no solo HighLevel).
async function getOverlappingLocalBlockedSlots(
  calendarId,
  slotStartMs,
  slotEndMs,
  { failClosed = false } = {}
) {
  if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs)) return []
  let rows = []
  try {
    rows = await db.all(
      `SELECT id, start_time, end_time FROM blocked_slots WHERE calendar_id = ? OR calendar_id IS NULL`,
      [calendarId]
    )
  } catch (error) {
    if (failClosed) throw error
    // Compatibilidad legacy: si la tabla aún no existe (migración pendiente),
    // el alta ordinaria conserva su comportamiento histórico.
    return []
  }
  return rows.filter(b => overlaps(
    slotStartMs,
    slotEndMs,
    new Date(b.start_time).getTime(),
    new Date(b.end_time || b.start_time).getTime()
  ))
}

export async function createLocalBlockedSlot({ calendarId = null, startTime, endTime, title = null } = {}) {
  const zone = await getAccountTimezone()
  const startIso = normalizeToUtcIso(startTime, zone)
  const endIso = normalizeToUtcIso(endTime || startTime, zone)
  if (!startIso || !endIso) throw new Error('Horario de bloqueo inválido')
  const id = makeId('rstk_block')
  await db.run(
    `INSERT INTO blocked_slots (id, calendar_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)`,
    [id, calendarId ? cleanString(calendarId) : null, startIso, endIso, title ? cleanString(title) : null]
  )
  return { id, calendarId: calendarId || null, startTime: startIso, endTime: endIso, title: title || null }
}

export async function listLocalBlockedSlots({ calendarId = null, startTime = null, endTime = null } = {}) {
  const conditions = []
  const params = []
  if (calendarId) { conditions.push('(calendar_id = ? OR calendar_id IS NULL)'); params.push(cleanString(calendarId)) }
  if (startTime) { conditions.push('end_time >= ?'); params.push(startTime) }
  if (endTime) { conditions.push('start_time <= ?'); params.push(endTime) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.all(
    `SELECT id, calendar_id AS "calendarId", start_time AS "startTime", end_time AS "endTime", title
     FROM blocked_slots ${where} ORDER BY start_time ASC`,
    params
  )
}

export async function updateLocalBlockedSlot({ id, startTime = null, endTime = null, title } = {}) {
  const cleanId = cleanString(id)
  if (!cleanId) throw new Error('Se requiere el id del bloqueo')
  const zone = await getAccountTimezone()
  const sets = []
  const params = []
  if (startTime != null) {
    const startIso = normalizeToUtcIso(startTime, zone)
    if (!startIso || Number.isNaN(new Date(startIso).getTime())) throw new Error('Horario de bloqueo inválido')
    sets.push('start_time = ?'); params.push(startIso)
  }
  if (endTime != null) {
    const endIso = normalizeToUtcIso(endTime, zone)
    if (!endIso || Number.isNaN(new Date(endIso).getTime())) throw new Error('Horario de bloqueo inválido')
    sets.push('end_time = ?'); params.push(endIso)
  }
  if (title !== undefined) {
    sets.push('title = ?')
    params.push(title ? cleanString(title) : null)
  }
  if (!sets.length) return false
  params.push(cleanId)
  const result = await db.run(`UPDATE blocked_slots SET ${sets.join(', ')} WHERE id = ?`, params)
  return result.changes > 0
}

export async function deleteLocalBlockedSlot(id) {
  const result = await db.run('DELETE FROM blocked_slots WHERE id = ?', [cleanString(id)])
  return result.changes > 0
}

export async function getLocalFreeSlots(calendarId, startDate, endDate, timezone, options = {}) {
  const calendar = await getLocalCalendar(calendarId)
  if (!calendar) return []

  // Generar los horarios en la ZONA DE LA CUENTA, no en la del servidor (UTC en Render).
  // Así "9:00–17:00" significan 9–17 en la zona del negocio y no 9–17 UTC.
  const zone = isValidTimezone(timezone) ? timezone : await getAccountTimezone()

  const startDay = DateTime.fromISO(startDate, { zone }).startOf('day')
  const endDay = DateTime.fromISO(endDate, { zone }).startOf('day')
  if (!startDay.isValid || !endDay.isValid || endDay < startDay) return []

  const requestedDurationMinutes = Number(options.durationMinutes)
  const durationMinutes = Number.isFinite(requestedDurationMinutes) && requestedDurationMinutes > 0
    ? requestedDurationMinutes
    : Math.max(1, calendarDurationToMinutes(calendar.slotDuration, calendar.slotDurationUnit, 60))
  const intervalMinutes = Math.max(1, calendarDurationToMinutes(
    calendar.slotInterval,
    calendar.slotIntervalUnit,
    durationMinutes
  ))
  const appointmentLimit = getEffectiveSlotAppointmentLimit(calendar, options)
  const dailyLimit = Math.max(0, toInt(calendar.appoinmentPerDay, 0))
  const buffers = Number.isFinite(appointmentLimit)
    ? getCalendarBufferMinutes(calendar)
    : { before: 0, after: 0 }
  const bookingWindow = getCalendarBookingWindow(calendar, zone, options.currentTimeMs)
  const conflictMarginMs = (buffers.before + buffers.after) * 60 * 1000

  // Las citas existentes están en UTC en la BD; comparamos por instante absoluto.
  // Extendemos la consulta por los buffers para no perder una cita que termina antes
  // de medianoche pero todavía consume el tiempo libre configurado del día siguiente.
  const rangeStart = DateTime.fromMillis(startDay.toUTC().toMillis() - conflictMarginMs, { zone: 'utc' }).toISO()
  const rangeEnd = DateTime.fromMillis(endDay.endOf('day').toUTC().toMillis() + conflictMarginMs, { zone: 'utc' }).toISO()
  const excludedAppointmentId = cleanString(options.excludeAppointmentId || '')
  const existing = (await listLocalAppointments({
    startTime: rangeStart,
    endTime: rangeEnd,
    calendarId,
    includeOverlapping: true
  }))
    .filter((appointment) => (
      (!excludedAppointmentId || cleanString(appointment.id) !== excludedAppointmentId)
      && isBlockingCalendarAppointment(appointment)
    ))

  // (APT-004) Excluir los horarios bloqueados nativos del listado de slots libres.
  // Sin esto, el calendario público seguiría ofreciendo horarios que el dueño bloqueó
  // (el admin ya lo validaba en checkSlotAvailability, pero el booking público no).
  let blockedRanges = []
  try {
    const blocks = await listLocalBlockedSlots({ calendarId, startTime: rangeStart, endTime: rangeEnd })
    blockedRanges = blocks.map(b => [
      new Date(b.startTime).getTime(),
      new Date(b.endTime || b.startTime).getTime()
    ])
  } catch (error) {
    // Fail-open: si la migración de blocked_slots aún no corre, no filtrar nada.
    blockedRanges = []
  }

  const slotsByDate = []

  for (let cursor = startDay; cursor <= endDay; cursor = cursor.plus({ days: 1 })) {
    const dateKey = cursor.toISODate()
    const appointmentsOnDay = existing.filter(event => (
      appointmentStartsOnBusinessDate(event, dateKey, zone)
    )).length
    // getCalendarOpenIntervals usa getDay() (0=domingo); construir una Date con los
    // componentes de la fecha preserva el día de la semana correcto.
    const intervals = getCalendarOpenIntervals(
      calendar,
      new Date(cursor.year, cursor.month - 1, cursor.day),
      { allowDefault: options.allowDefaultOpenHours !== false }
    )
    const slots = []
    const seenSlots = new Set()

    for (const interval of intervals) {
      const normalizedInterval = normalizeCalendarOpenInterval(interval, {
        allowFallback: options.allowDefaultOpenHours !== false
      })
      if (!normalizedInterval) continue
      const open = cursor.set({
        hour: normalizedInterval.openHour,
        minute: normalizedInterval.openMinute,
        second: 0,
        millisecond: 0
      })
      const close = cursor.set({
        hour: normalizedInterval.closeHour,
        minute: normalizedInterval.closeMinute,
        second: 0,
        millisecond: 0
      })

      for (let slot = open; slot.plus({ minutes: durationMinutes }) <= close; slot = slot.plus({ minutes: intervalMinutes })) {
        const slotStartMs = slot.toMillis()
        const slotEndMs = slot.plus({ minutes: durationMinutes }).toMillis()
        const overlappingAppointments = existing.filter(event => overlaps(
          slotStartMs,
          slotEndMs,
          new Date(event.startTime).getTime(),
          new Date(event.endTime || event.startTime).getTime()
        )).length
        const hasBufferConflict = existing.some(event => {
          const eventStartMs = new Date(event.startTime).getTime()
          const eventEndMs = new Date(event.endTime || event.startTime).getTime()
          return (
            !overlaps(slotStartMs, slotEndMs, eventStartMs, eventEndMs)
            && bufferedAppointmentOverlaps(slotStartMs, slotEndMs, eventStartMs, eventEndMs, buffers)
          )
        })
        const hasConflict = (
          Number.isFinite(appointmentLimit) && overlappingAppointments >= appointmentLimit
        ) || hasBufferConflict
        const reachedDailyLimit = dailyLimit > 0 && appointmentsOnDay >= dailyLimit
        const bufferedSlotStartMs = slotStartMs - buffers.before * 60 * 1000
        const bufferedSlotEndMs = slotEndMs + buffers.after * 60 * 1000
        const isBlocked = blockedRanges.some(([blockStart, blockEnd]) => (
          overlaps(bufferedSlotStartMs, bufferedSlotEndMs, blockStart, blockEnd)
        ))
        const outsideBookingWindow = (
          slotStartMs < bookingWindow.earliestStartMs
          || (Number.isFinite(bookingWindow.latestStartMs) && slotStartMs > bookingWindow.latestStartMs)
        )

        if (!hasConflict && !reachedDailyLimit && !isBlocked && !outsideBookingWindow) {
          const slotIso = slot.toUTC().toISO()
          if (!seenSlots.has(slotIso)) {
            slots.push(slotIso)
            seenSlots.add(slotIso)
          }
        }
      }
    }

    slotsByDate.push({ date: dateKey, slots, timezone: zone })
  }

  return slotsByDate
}

export function buildHighLevelCalendarPayload(calendar = {}, locationId) {
  const teamMembers = normalizeTeamMembers(calendar.teamMembers)
  const locationConfigurations = normalizeLocationConfigurations(calendar.locationConfigurations)
  const payload = {
    isActive: calendar.isActive !== false,
    locationId,
    name: calendar.name,
    description: calendar.description || '',
    slug: calendar.slug || slugify(calendar.name),
    calendarType: calendar.calendarType || 'event',
    widgetType: calendar.widgetType || 'classic',
    eventTitle: calendar.eventTitle || calendar.name || 'Cita',
    eventColor: calendar.eventColor || DEFAULT_EVENT_COLOR,
    slotDuration: toInt(calendar.slotDuration, 60),
    slotDurationUnit: calendar.slotDurationUnit || 'mins',
    slotInterval: toInt(calendar.slotInterval, toInt(calendar.slotDuration, 60)),
    slotIntervalUnit: calendar.slotIntervalUnit || 'mins',
    appoinmentPerSlot: toInt(calendar.appoinmentPerSlot, 1),
    appoinmentPerDay: toInt(calendar.appoinmentPerDay, 0),
    allowBookingAfter: toInt(calendar.allowBookingAfter, 0),
    allowBookingAfterUnit: calendar.allowBookingAfterUnit || 'hours',
    allowBookingFor: toInt(calendar.allowBookingFor, 30),
    allowBookingForUnit: calendar.allowBookingForUnit || 'days'
  }

  if (teamMembers.length) payload.teamMembers = teamMembers
  if (locationConfigurations.length) payload.locationConfigurations = locationConfigurations
  // HighLevel v3 exige días 0..6 y rangos completos. Los calendarios locales
  // pueden conservar formatos legacy tolerados en lectura (incluido domingo=7),
  // así que se canonizan justo antes de cruzar la frontera del proveedor.
  const rawOpenHours = normalizeOpenHours(calendar.openHours)
  const openHours = rawOpenHours.length
    ? normalizeCalendarOpenHoursForWrite(rawOpenHours)
    : []
  if (
    calendar.availabilityScheduleConfigured === true
    || Number(calendar.availability_schedule_configured) === 1
    || Number(calendar.availabilityScheduleConfigured) === 1
    || openHours.length
  ) {
    payload.openHours = openHours
  }
  if (calendar.notes) payload.notes = calendar.notes
  if (calendar.availabilityType !== undefined) payload.availabilityType = calendar.availabilityType
  if (calendar.preBuffer) payload.preBuffer = calendar.preBuffer
  if (calendar.preBufferUnit) payload.preBufferUnit = calendar.preBufferUnit
  if (calendar.slotBuffer) payload.slotBuffer = calendar.slotBuffer
  if (calendar.slotBufferUnit) payload.slotBufferUnit = calendar.slotBufferUnit

  return payload
}

async function getFallbackTeamMembers(client, locationId) {
  try {
    const users = await client.getLocationUsers(locationId)
    const user = users.find(candidate => candidate.id || candidate.userId)
    const userId = user?.id || user?.userId
    return userId ? [{ userId, priority: 0.5, isPrimary: true }] : []
  } catch (error) {
    logger.warn(`No se pudo resolver usuario default para calendario GHL: ${error.message}`)
    return []
  }
}

export async function syncLocalCalendarsToHighLevel(locationId, apiToken) {
  const rows = await db.all(`
    SELECT * FROM calendars
    WHERE ((
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_cal_%'
      )
      AND (
        COALESCE(ghl_calendar_id, '') = ''
        OR sync_status IN ('pending', 'error')
      ))
      OR (
        COALESCE(source, '') = 'ghl'
        AND COALESCE(ghl_calendar_id, '') != ''
        AND sync_status IN ('pending', 'error')
      )
    ORDER BY created_at ASC
  `)

  const client = new GHLClient(apiToken, locationId)
  let remoteCalendarsCache = null
  let created = 0
  let updated = 0
  let matched = 0
  let failed = 0

  for (const row of rows) {
    const calendar = calendarRowToApi(row)
    try {
      if (!isRistakOwnedRow(row, LOCAL_CALENDAR_PREFIX) && !isPendingHighLevelLinkedRow(row, 'ghl_calendar_id')) {
        logger.warn(`Saltando calendario no local para evitar duplicado en HighLevel: ${calendar.id}`)
        continue
      }

      let teamMembers = normalizeTeamMembers(calendar.teamMembers)
      if (!teamMembers.length) {
        teamMembers = await getFallbackTeamMembers(client, locationId)
      }

      const payload = buildHighLevelCalendarPayload({ ...calendar, teamMembers }, locationId)
      let response
      let ghlCalendarId = calendar.ghlCalendarId

      if (!ghlCalendarId) {
        if (!remoteCalendarsCache) {
          remoteCalendarsCache = await highlevelCalendarService.getCalendars(locationId, apiToken)
        }

        const slug = payload.slug || slugify(payload.name)
        const existingRemote = remoteCalendarsCache.find(remote => (
          sameText(remote.slug || remote.widgetSlug, slug) ||
          sameText(remote.name, payload.name)
        ))

        if (existingRemote?.id) {
          ghlCalendarId = existingRemote.id
          matched += 1
          response = existingRemote
        }
      }

      if (response) {
        // El match evita duplicar, pero todavía debemos aplicar la versión local
        // antes de reconocer el write como sincronizado.
        response = await highlevelCalendarService.updateCalendar(ghlCalendarId, payload, apiToken)
        updated += 1
      } else if (ghlCalendarId) {
        response = await highlevelCalendarService.updateCalendar(ghlCalendarId, payload, apiToken)
        updated += 1
      } else {
        response = await highlevelCalendarService.createCalendar(payload, apiToken)
        created += 1
      }

      const remoteCalendar = response?.calendar || response
      ghlCalendarId = remoteCalendar?.id || ghlCalendarId

      if (!ghlCalendarId) {
        throw new Error('HighLevel no devolvió ID de calendario; se detiene para evitar duplicados')
      }

      await upsertLocalCalendar({
        ...remoteCalendar,
        ...calendar,
        id: calendar.id,
        ghlCalendarId,
        locationId,
        teamMembers: remoteCalendar?.teamMembers || teamMembers,
        source: calendar.source || 'ristak'
      }, {
        id: calendar.id,
        source: calendar.source || 'ristak',
        ghlCalendarId,
        locationId,
        syncStatus: 'synced',
        acknowledgeLocalWrite: true,
        rawJson: remoteCalendar
      })
    } catch (error) {
      failed += 1
      await db.run(
        "UPDATE calendars SET sync_status = 'error', sync_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [error.message, calendar.id]
      )
      logger.warn(`No se pudo sincronizar calendario ${calendar.id} a HighLevel: ${error.message}`)
    }
  }

  return { total: rows.length, created, updated, matched, failed }
}

// Devuelve el ID de HighLevel a usar en el payload remoto de la cita.
// La cita y el contacto conservan SIEMPRE su ID local de Ristak; el ID de GHL
// solo se liga en contacts.ghl_contact_id.
export async function ensureHighLevelContactForAppointment(client, appointment = {}) {
  if (!appointment.contactId) return null

  const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [appointment.contactId])
  if (!contact) {
    // Datos legacy: la cita puede traer directamente un ID de GHL
    return appointment.contactId
  }

  if (String(contact.ghl_contact_id || '').trim()) {
    return contact.ghl_contact_id
  }

  if (!isRistakContactId(contact.id)) {
    // Legacy: la primary key era el ID de GHL
    return contact.id
  }

  const searches = []
  if (contact.email) searches.push({ email: contact.email })
  if (contact.phone) searches.push({ phone: contact.phone })

  for (const search of searches) {
    const result = await client.searchContacts({ ...search, limit: 5 }).catch(() => null)
    const match = result?.contacts?.find(candidate => candidate.id)
    if (match?.id) {
      await linkContactToGhl(contact.id, match.id)
      return match.id
    }
  }

  const fullName = contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.email || contact.phone || 'Contacto Ristak'
  const created = await client.createContact({
    name: fullName,
    email: contact.email || '',
    phone: normalizePhoneForStorage(contact.phone) || contact.phone || ''
  })
  const highLevelContact = created.contact || created
  const targetId = highLevelContact.id

  if (targetId) {
    await linkContactToGhl(contact.id, targetId)
    return targetId
  }

  return null
}

/**
 * Modo test nunca crea ni liga contactos en HighLevel: esa mutación sobreviviría
 * a la limpieza de cinco minutos. Sólo reutiliza una identidad remota que ya
 * estaba ligada o una coincidencia exacta y no ambigua encontrada en lectura.
 */
export async function resolveExistingHighLevelContactForTestAppointment(client, appointment = {}) {
  if (!appointment.contactId) return null

  const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [appointment.contactId])
  if (!contact) {
    if (!isRistakContactId(appointment.contactId)) return appointment.contactId
    const error = new Error('El contacto de prueba no existe en Ristak.')
    error.status = 409
    error.code = 'test_appointment_highlevel_contact_missing'
    throw error
  }

  if (String(contact.ghl_contact_id || '').trim()) return String(contact.ghl_contact_id).trim()
  if (!isRistakContactId(contact.id)) return contact.id

  const expectedEmail = String(contact.email || '').trim().toLowerCase()
  const expectedPhone = normalizePhoneForStorage(contact.phone) || String(contact.phone || '').trim()
  const candidateIds = new Set()

  const collectExactMatches = async (search, predicate) => {
    const result = await client.searchContacts({ ...search, limit: 10 }).catch(() => null)
    for (const candidate of Array.isArray(result?.contacts) ? result.contacts : []) {
      if (candidate?.id && predicate(candidate)) candidateIds.add(String(candidate.id).trim())
    }
  }

  if (expectedEmail) {
    await collectExactMatches({ email: expectedEmail }, (candidate) => (
      String(candidate.email || candidate.emailAddress || '').trim().toLowerCase() === expectedEmail
    ))
  }
  if (expectedPhone) {
    await collectExactMatches({ phone: expectedPhone }, (candidate) => {
      const candidatePhone = normalizePhoneForStorage(
        candidate.phone || candidate.phoneNumber || candidate.mobile || ''
      ) || String(candidate.phone || candidate.phoneNumber || candidate.mobile || '').trim()
      return candidatePhone === expectedPhone
    })
  }

  if (candidateIds.size === 1) return [...candidateIds][0]

  const error = new Error(candidateIds.size > 1
    ? 'La búsqueda encontró más de un contacto exacto en HighLevel. Liga el contacto manualmente antes de probar la agenda.'
    : 'Este contacto todavía no está ligado a HighLevel. El Modo test no crea contactos productivos; sincronízalo primero o usa otro contacto.')
  error.status = 409
  error.code = candidateIds.size > 1
    ? 'test_appointment_highlevel_contact_ambiguous'
    : 'test_appointment_highlevel_contact_not_synced'
  throw error
}

export async function syncLocalAppointmentsToHighLevel(locationId, apiToken) {
  const rows = await db.all(`
    SELECT * FROM appointments
    WHERE ((
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_appt_%'
      )
      AND sync_status IN ('pending', 'error', 'pending_delete'))
      OR (
        COALESCE(source, '') = 'ghl'
        AND COALESCE(ghl_appointment_id, '') != ''
        AND sync_status IN ('pending', 'error', 'pending_delete')
      )
    ORDER BY date_added ASC
  `)

  const client = new GHLClient(apiToken, locationId)
  let created = 0
  let updated = 0
  let matched = 0
  let deleted = 0
  let failed = 0

  for (const row of rows) {
    const appointment = appointmentRowToApi(row)
    try {
      if (!isRistakOwnedRow(row, LOCAL_APPOINTMENT_PREFIX) && !isPendingHighLevelLinkedRow(row, 'ghl_appointment_id')) {
        logger.warn(`Saltando cita no local para evitar duplicado en HighLevel: ${appointment.id}`)
        continue
      }

      const calendar = await getLocalCalendar(appointment.calendarId)
      const remoteCalendarId = calendar?.ghlCalendarId || appointment.calendarId

      if (!remoteCalendarId) {
        throw new Error(`El calendario ${appointment.calendarId} todavía no tiene ID de HighLevel`)
      }

      if (appointment.syncStatus === 'pending_delete') {
        if (appointment.ghlAppointmentId) {
          await highlevelCalendarService.deleteEvent(appointment.ghlAppointmentId, apiToken)
        }
        await deleteLocalAppointment(appointment.id)
        deleted += 1
        continue
      }

      const contactId = await ensureHighLevelContactForAppointment(client, appointment)
      const payload = {
        ...appointment,
        calendarId: remoteCalendarId,
        contactId,
        locationId,
        appointmentStatus: appointment.appointmentStatus || appointment.status || 'confirmed'
      }

      let response
      let ghlAppointmentId = appointment.ghlAppointmentId

      if (!ghlAppointmentId && !appointment.isTest) {
        const startMs = new Date(appointment.startTime).getTime()
        const endMs = new Date(appointment.endTime || appointment.startTime).getTime()
        const searchStart = Number.isFinite(startMs) ? startMs - 5 * 60000 : Date.now() - 5 * 60000
        const searchEnd = Number.isFinite(endMs) ? endMs + 5 * 60000 : searchStart + 15 * 60000
        let existingEvents
        try {
          existingEvents = await highlevelCalendarService.getCalendarEvents(
            locationId,
            searchStart,
            searchEnd,
            apiToken,
            remoteCalendarId
          )
        } catch (error) {
          // Un fallo de lectura no significa "no existe". Después de un POST
          // ambiguo podríamos duplicar el espejo si degradáramos a lista vacía.
          throw new Error(
            `No se pudo reconciliar el espejo HighLevel de ${appointment.id}; no se enviará otro POST: ${error.message}`,
            { cause: error }
          )
        }

        const existingRemote = existingEvents.find(event => (
          sameTime(event.startTime || event.start_time, appointment.startTime) &&
          (!contactId || !event.contactId || event.contactId === contactId) &&
          sameText(event.title || event.name || '', appointment.title || '')
        ))

        if (existingRemote?.id) {
          ghlAppointmentId = existingRemote.id
          response = existingRemote
          matched += 1
        } else if (String(appointment.syncError || '').includes(HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER)) {
          // Un timeout o una respuesta sin ID puede haber creado el evento aunque
          // todavía no aparezca en la lectura. Reconciliamos en corridas futuras,
          // pero jamás enviamos un segundo POST a ciegas.
          throw new Error(
            `${HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER} El resultado remoto de HighLevel para ${appointment.id} sigue ambiguo; no se enviará otro POST hasta poder reconciliarlo`
          )
        }
      }

      if (response) {
        // Ya encontramos una cita remota equivalente; solo ligamos IDs.
      } else if (ghlAppointmentId) {
        response = await highlevelCalendarService.updateAppointment(ghlAppointmentId, payload, apiToken)
        updated += 1
      } else {
        if (appointment.isTest) {
          response = await createConversationalTestHighLevelAppointment({
              appointment,
              appointmentData: payload,
              locationId,
              remoteCalendarId,
              contactId,
              apiToken
            })
        } else {
          await prepareHighLevelAppointmentMirrorIntent({
            appointmentId: appointment.id,
            remoteCalendarId,
            remoteContactId: contactId,
            locationId
          })
          response = await highlevelCalendarService.createAppointment(payload, locationId, apiToken)
        }
        created += 1
      }

      const remoteAppointment = response?.appointment || response
      ghlAppointmentId = remoteAppointment?.id || ghlAppointmentId

      if (!ghlAppointmentId) {
        throw new Error('HighLevel no devolvió ID de cita; se detiene para evitar duplicados')
      }

      if (appointment.isTest && !cleanString((await db.get(
        'SELECT command_key FROM conversational_appointment_test_provider_receipts WHERE test_effect_id = ? AND provider = ?',
        [appointment.testEffectId, 'highlevel']
      ))?.command_key)) {
        try {
          await recordConversationalTestAppointmentProviderReceipt({
            appointmentId: appointment.id,
            testEffectId: appointment.testEffectId,
            testRunId: appointment.testRunId,
            provider: 'highlevel',
            externalId: ghlAppointmentId,
            calendarId: appointment.calendarId,
            cleanupDueAt: appointment.testExpiresAt
          })
        } catch (receiptError) {
          const fallback = await db.run(`
            UPDATE appointments
            SET ghl_appointment_id = ?, sync_error = ?
            WHERE id = ? AND is_test = 1 AND test_run_id = ? AND test_effect_id = ?
              AND date_updated = ?
          `, [
            ghlAppointmentId,
            `Recibo HighLevel pendiente: ${cleanString(receiptError.message).slice(0, 800)}`,
            appointment.id,
            appointment.testRunId,
            appointment.testEffectId,
            normalizeToUtcIso(appointment.dateUpdated, 'UTC')
          ]).catch(() => null)
          if (Number(fallback?.changes ?? fallback?.rowCount ?? 0) !== 1) {
            try {
              await highlevelCalendarService.deleteEvent(ghlAppointmentId, apiToken)
            } catch (compensationError) {
              const error = new Error(
                `HighLevel creó ${ghlAppointmentId}, pero no se pudo guardar su recibo ni compensarlo: ${compensationError.message}`
              )
              error.cause = receiptError
              throw error
            }
            throw receiptError
          }
          logger.warn(`[Calendario local] El recibo HighLevel ${ghlAppointmentId} se ancló en la cita ${appointment.id} como fallback durable.`)
        }
      }

      await markHighLevelAppointmentMirrorSynced(appointment.id, ghlAppointmentId, {
        expectedAppointment: appointment
      })
      if (!appointment.isTest) {
        await completeHighLevelAppointmentMirrorIntent(appointment.id, ghlAppointmentId)
      }
    } catch (error) {
      failed += 1
      const stickyRemoteOutcomeUnknown = String(appointment.syncError || '').includes(HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER)
      const syncErrorMessage = stickyRemoteOutcomeUnknown && !String(error.message || '').includes(HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER)
        ? `${HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER} ${error.message}`
        : error.message
      if (error?.code !== 'appointment_provider_response_stale') {
        await markHighLevelAppointmentMirrorError(appointment.id, syncErrorMessage, {
          expectedAppointment: appointment
        }).catch((markError) => {
          if (markError?.code !== 'appointment_provider_response_stale') throw markError
        })
      }
      logger.warn(`No se pudo sincronizar cita ${appointment.id} a HighLevel: ${syncErrorMessage}`)
    }
  }

  return { total: rows.length, created, updated, matched, deleted, failed }
}

export default {
  createLocalCalendar,
  reconcileCalendarDefaults,
  ensureDefaultLocalCalendar,
  getLocalCalendar,
  listLocalCalendars,
  upsertLocalCalendar,
  updateLocalCalendar,
  createLocalAppointment,
  deleteLocalAppointment,
  getLocalAppointment,
  getLocalFreeSlots,
  getLocalAppointmentStats,
  getLocalAppointmentsOverview,
  listUpcomingLocalAppointmentsPage,
  listLocalAppointments,
  syncLocalAppointmentsToHighLevel,
  syncLocalCalendarsToHighLevel,
  updateLocalAppointment,
  upsertLocalAppointment,
  prepareHighLevelAppointmentMirrorIntent,
  claimPreparedHighLevelMirrorIntent,
  completeHighLevelAppointmentMirrorIntent,
  inspectInboundHighLevelAppointment,
  reconcileInboundHighLevelAppointment,
  markHighLevelAppointmentMirrorSynced,
  markHighLevelAppointmentMirrorError
}
