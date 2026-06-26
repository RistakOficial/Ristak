import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { normalizeToUtcIso, getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import {
  isRistakContactId,
  linkContactToGhl,
  // (GCAL-006) Reutilizamos los helpers de identidad de contacto para enlazar/crear
  // contacto a partir de un evento entrante de Google, sin duplicar lógica.
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert,
  finalizePreparedPhoneUpsert
} from './contactIdentityService.js'
import { normalizePhoneForAccount } from '../utils/accountLocale.js' // (GCAL-006)
import GHLClient from './ghlClient.js'
import * as highlevelCalendarService from './highlevelCalendarService.js'
import { getCalendarPublicBaseUrlStatus } from './sitesService.js'

const LOCAL_CALENDAR_PREFIX = 'rstk_cal'
const LOCAL_APPOINTMENT_PREFIX = 'rstk_appt'
const DEFAULT_EVENT_COLOR = '#3b82f6'
const DEFAULT_BOOKING_COMPLETION_MESSAGE = 'Listo. Tu cita quedo agendada.'
const DEFAULT_CALENDAR_META_EVENT_NAME = 'Schedule'
const DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const CALENDAR_CUSTOM_EVENT_CHANNELS = new Set(['site', 'whatsapp', 'smart'])
const CALENDAR_BOOKING_LAYOUTS = new Set(['classic', 'compact', 'stacked'])
const CALENDAR_BOOKING_FONT_FAMILIES = new Set(['system', 'modern', 'serif', 'mono'])
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
const DEFAULT_CALENDAR_CONFIG_KEY = 'default_calendar_id'
const ATTRIBUTION_CALENDAR_IDS_CONFIG_KEY = 'attribution_calendar_ids'
const SOURCE_PREFERENCE_CONFIG_KEY = 'calendar_source_preference'
export const CALENDAR_FORMS_FOLDER_ID = 'system-calendar-forms'
export const CALENDAR_DEFAULT_FORM_SITE_ID = 'system-calendar-booking-form'
const CALENDAR_DEFAULT_FORM_SLUG = 'system-calendar-booking-form'
const CALENDAR_DEFAULT_PAGE_ID = 'page-1'
const CALENDAR_FORM_FINAL_PAGE_IDS = new Set(['page-2', 'page-3'])
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
const CALENDAR_FORM_CONTENT_BLOCK_TYPES = new Set(['title', 'subtitle', 'text', 'image', 'video'])
const CALENDAR_FORM_ALL_BLOCK_TYPES = new Set([...CALENDAR_FORM_FIELD_TYPES, ...CALENDAR_FORM_CONTENT_BLOCK_TYPES])
const CALENDAR_SLUG_MAX_LENGTH = 80

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function cleanString(value) {
  return String(value ?? '').trim()
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
      enabled: source.notesEnabled ?? source.notes?.enabled ?? true,
      required: false
    }
  }
}

function normalizeCalendarBookingFormConfig(value = {}) {
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
    fontFamily: normalizeCalendarBookingFontFamily(displaySource.fontFamily || displaySource.font_family),
    allowTimezoneSelection: parseBoolean(displaySource.allowTimezoneSelection ?? displaySource.allow_timezone_selection, true),
    defaultTimezone: defaultTimezone && isValidTimezone(defaultTimezone) ? defaultTimezone : '',
    // (CAL-FLOW) Orden del flujo: 'after' (default) = calendario y luego formulario; 'before' =
    // primero el formulario (con su calificación) y al completarlo aparece el calendario.
    formPosition: cleanString(displaySource.formPosition || displaySource.form_position).toLowerCase() === 'before' ? 'before' : 'after',
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
    eventName: channel === 'whatsapp' ? whatsappEventName : siteEventName,
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

  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db.all(`
    SELECT calendar_id, COUNT(*) AS appointments_count
    FROM appointments
    WHERE calendar_id IN (${placeholders})
      AND deleted_at IS NULL
      AND COALESCE(sync_status, '') != 'pending_delete'
    GROUP BY calendar_id
  `, ids)

  return new Map(rows.map(row => [
    cleanString(row.calendar_id),
    toInt(row.appointments_count, 0)
  ]))
}

function calendarHasAppointments(calendar = {}, appointmentCounts = new Map()) {
  return toInt(appointmentCounts.get(cleanString(calendar.id)), 0) > 0
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

  const appointmentCounts = await getCalendarAppointmentCounts(calendars.map(calendar => calendar.id))
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
      || configuredDefaultCalendar?.source === 'google'
      || configuredDefaultCalendar?.source === 'ghl'

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

async function ristakPublicCalendarSlugExists(candidateSlug, calendarId) {
  const slug = cleanString(candidateSlug)
  if (!slug) return false

  const row = await db.get(`
    SELECT id
    FROM calendars
    WHERE id != ?
      AND LOWER(COALESCE(source, 'ristak')) = 'ristak'
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

  while (await ristakPublicCalendarSlugExists(candidate, calendarId)) {
    attempt += 1
    const suffix = attempt === 1
      ? idSuffix || String(attempt + 1)
      : `${idSuffix || 'cal'}${attempt + 1}`
    candidate = appendCalendarSlugSuffix(baseSlug, suffix)

    if (attempt > 25) {
      candidate = appendCalendarSlugSuffix(baseSlug, crypto.randomUUID().replace(/-/g, '').slice(0, 8))
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

function calendarRowToApi(row = {}) {
  const teamMembers = normalizeTeamMembers(row.team_members)
  const locationConfigurations = normalizeLocationConfigurations(row.location_configurations)
  const openHours = normalizeOpenHours(row.open_hours)
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
    appoinmentPerDay: toInt(row.appoinment_per_day, 0),
    allowBookingAfter: toInt(row.allow_booking_after, 0),
    allowBookingAfterUnit: row.allow_booking_after_unit || 'hours',
    allowBookingFor: toInt(row.allow_booking_for, 30),
    allowBookingForUnit: row.allow_booking_for_unit || 'days',
    openHours,
    autoConfirm: row.auto_confirm !== 0,
    allowReschedule: row.allow_reschedule !== 0,
    allowCancellation: row.allow_cancellation !== 0,
    notes: row.notes || '',
    bookingForm: normalizeCalendarBookingFormConfig(rawJson.bookingForm || rawJson.booking_form || rawJson),
    bookingCompletion: normalizeCalendarBookingCompletionConfig(rawJson.bookingCompletion || rawJson.booking_completion || rawJson),
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
    appoinmentPerSlot: toInt(calendar.appoinmentPerSlot ?? calendar.appoinment_per_slot ?? calendar.appointmentPerSlot, 1),
    appoinmentPerDay: toInt(calendar.appoinmentPerDay ?? calendar.appoinment_per_day ?? calendar.appointmentPerDay, 0),
    allowBookingAfter: toInt(calendar.allowBookingAfter ?? calendar.allow_booking_after, 0),
    allowBookingAfterUnit: cleanString(calendar.allowBookingAfterUnit || calendar.allow_booking_after_unit || 'hours') || 'hours',
    allowBookingFor: toInt(calendar.allowBookingFor ?? calendar.allow_booking_for, 30),
    allowBookingForUnit: cleanString(calendar.allowBookingForUnit || calendar.allow_booking_for_unit || 'days') || 'days',
    openHours: normalizeOpenHours(calendar.openHours || calendar.open_hours),
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

export async function upsertLocalCalendar(raw = {}, options = {}) {
  const normalized = normalizeCalendarRecord(raw, options)
  const existingByGhl = normalized.ghlCalendarId ? await getCalendarByGhlId(normalized.ghlCalendarId) : null
  if (existingByGhl?.id) {
    normalized.id = existingByGhl.id
  }

  if (normalizeCalendarSource(normalized.source) === 'ristak') {
    normalized.slug = await ensureUniqueRistakPublicSlug(normalized.slug, normalized.id)
    normalized.widgetSlug = normalized.widgetSlugWasExplicit
      ? await ensureUniqueRistakPublicSlug(normalized.widgetSlug, normalized.id)
      : normalized.slug
  }

  await db.run(`
    INSERT INTO calendars (
      id, ghl_calendar_id, location_id, name, description, slug, widget_slug,
      calendar_type, widget_type, event_title, event_color, is_active,
      team_members, location_configurations, slot_duration, slot_duration_unit,
      slot_interval, slot_interval_unit, slot_buffer, slot_buffer_unit,
      pre_buffer, pre_buffer_unit, appoinment_per_slot, appoinment_per_day,
      allow_booking_after, allow_booking_after_unit, allow_booking_for,
      allow_booking_for_unit, open_hours, auto_confirm, allow_reschedule,
      allow_cancellation, notes, availability_type, anti_tracking_enabled, source, sync_status,
      sync_error, last_synced_at, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
      appoinment_per_day = excluded.appoinment_per_day,
      allow_booking_after = excluded.allow_booking_after,
      allow_booking_after_unit = excluded.allow_booking_after_unit,
      allow_booking_for = excluded.allow_booking_for,
      allow_booking_for_unit = excluded.allow_booking_for_unit,
      open_hours = COALESCE(excluded.open_hours, calendars.open_hours),
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
    normalized.appoinmentPerDay,
    normalized.allowBookingAfter,
    normalized.allowBookingAfterUnit,
    normalized.allowBookingFor,
    normalized.allowBookingForUnit,
    jsonOrNull(normalized.openHours),
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

export async function createLocalCalendar(calendarData = {}) {
  return upsertLocalCalendar({
    ...calendarData,
    id: calendarData.id || makeId(LOCAL_CALENDAR_PREFIX),
    source: 'ristak'
  }, {
    source: 'ristak',
    syncStatus: 'pending'
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
      AND LOWER(COALESCE(source, 'ristak')) = 'ristak'
      AND (id = ? OR slug = ? OR widget_slug = ?)
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END,
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

function getDefaultCalendarBookingFields(config = {}) {
  const fields = []
  const defaults = normalizeCalendarBookingDefaultFields(config)

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

  if (defaults.phone.enabled) {
    fields.push({
      id: 'calendar_phone',
      blockType: 'phone',
      label: 'Telefono / WhatsApp',
      placeholder: '10 digitos',
      required: Boolean(defaults.phone.required),
      content: '',
      options: [],
      settings: { systemFieldKey: 'phone', validation: 'phone' },
      pageId: CALENDAR_DEFAULT_PAGE_ID,
      sortOrder: 1
    })
  }

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

  if (config.useCustomForm && config.customFormId) {
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
      const fields = rows
        .map(row => normalizeCalendarFormBlock(row, pages))
        .filter(Boolean)
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
          disqualification: formDisqualification,
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
    fields: getDefaultCalendarBookingFields(config.defaultFields),
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

function renderCalendarFieldInput(field = {}) {
  const id = escapeHtml(field.id)
  const placeholder = escapeHtml(field.placeholder || '')
  const required = field.required ? 'required' : ''
  const options = Array.isArray(field.options) ? field.options : []
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
    return `<input id="${id}" name="${id}" type="tel" inputmode="tel" autocomplete="tel" placeholder="${placeholder}" ${required}>`
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
  return ''
}

function renderCalendarBookingForm(bookingForm = {}) {
  const pages = Array.isArray(bookingForm.pages) && bookingForm.pages.length
    ? bookingForm.pages
    : [{ id: CALENDAR_DEFAULT_PAGE_ID, title: 'Tus datos', sortOrder: 0 }]
  const fields = Array.isArray(bookingForm.fields) ? bookingForm.fields : []
  const hasPages = pages.length > 1

  return `
    <form data-form data-form-mode="${escapeHtml(bookingForm.mode || 'default')}">
      <div class="formHeader">
        <h2>${bookingForm.mode === 'custom' ? escapeHtml(bookingForm.formName || 'Tus datos') : 'Tus datos'}</h2>
        ${hasPages ? `<p data-form-progress>Pantalla 1 de ${pages.length}</p>` : ''}
      </div>
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
            <section class="calendarQuestion" data-field-id="${escapeHtml(field.id)}" data-field-type="${escapeHtml(field.blockType)}" data-required="${field.required ? 'true' : 'false'}" data-validation="${escapeHtml(getCalendarFieldValidation(field))}">
              <label for="${escapeHtml(field.id)}">${escapeHtml(field.label || 'Pregunta')}${field.required ? '<span class="requiredMark">*</span>' : ''}</label>
              ${field.content ? `<p class="fieldHelp">${escapeHtml(field.content)}</p>` : ''}
              ${renderCalendarFieldInput(field)}
              <p class="fieldError" hidden>Esta respuesta es requerida.</p>
            </section>
          `}).join('')
          : '<p class="fieldHelp">Esta pantalla no tiene preguntas.</p>'

        return `
          <div class="formPage" data-form-page="${escapeHtml(page.id)}"${index === 0 ? '' : ' hidden'}>
            ${hasPages ? `<h3>${escapeHtml(page.title || `Pantalla ${index + 1}`)}</h3>` : ''}
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
  }

  const responseLines = fields
    .map(field => {
      const value = normalizedResponses[field.id]
      const text = valueAsText(value)
      return text ? `${field.label || field.id}: ${text}` : ''
    })
    .filter(Boolean)

  return {
    contact: { name: fullName, phone, email },
    notes,
    responses: normalizedResponses,
    responseSummary: responseLines.join('\n'),
    formId: bookingForm.formId || '',
    formName: bookingForm.formName || '',
    errors,
    disqualified,
    disqualifyMessage,
    disqualifyRedirectUrl
  }
}

export function renderPublicCalendarHtml(calendar, { host = '', embedded = false, style = {}, bookingForm = null, preview = false, metaPixelSnippet = '' } = {}) {
  const slug = publicCalendarSlug(calendar)
  const duration = Math.max(1, toInt(calendar.slotDuration, 60))
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
    formPosition: (useCustomStyle && (style.formPosition === 'before' || style.formPosition === 'after')) ? style.formPosition : bookingDisplay.formPosition
  }
  const fontStack = getCalendarBookingFontStack(effectiveBookingDisplay.fontFamily)
  const coverImage = safeCalendarImageUrl(style.coverImage, calendar.calendarCoverImage || calendar.calendar_cover_image || '')
  const bookingCompletion = normalizeCalendarBookingCompletionConfig(calendar.bookingCompletion || calendar.booking_completion || {})
  const customEvents = normalizeCalendarCustomEventsConfig(calendar.customEvents || calendar.custom_events || calendar.metaEvent || calendar.meta_event || {})
  const showSidebar = effectiveBookingDisplay.showSidebar !== false
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
    bookingDisplay: effectiveBookingDisplay,
    customEvents,
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
    body.rstk-calendar-embedded .page{width:100%;padding:0;place-items:stretch}
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
    .shell.layout-compact.bookingActive{grid-template-columns:minmax(320px,520px)}
    .shell.layout-stacked.bookingActive{grid-template-columns:1fr}
    .shell.bookingActive .calendarPane{display:none}
    .shell.bookingActive .timesPane{border-left:1px solid var(--line);max-width:520px;width:100%}
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
    .day{width:44px;height:44px;border:0;border-radius:999px;background:transparent;color:var(--muted);cursor:default;font-weight:450;font-size:.95rem;transition:background .15s,color .15s}
    .day.available{color:var(--heading);cursor:pointer;font-weight:500}
    .day.available:hover,.day.available:focus-visible{background:var(--accent-soft);color:var(--accent);outline:0}
    .day.selected{background:var(--accent);color:var(--selected-text)}
    .day.today:not(.selected){box-shadow:inset 0 0 0 1px var(--accent)}
    .day.outside{visibility:hidden}
    .day:disabled{opacity:.34}
    .timezone{display:flex;align-items:flex-start;gap:10px;color:var(--muted);font-size:.9rem;font-weight:450}
    .timezoneControl{display:grid;gap:8px;min-width:0}
    .timezoneControl strong{color:var(--ink)}
    .timezoneControl select{min-height:38px;max-width:min(320px,100%);font-size:.88rem}
    .timesPane{border-left:1px solid var(--line);padding:38px 24px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:18px}
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
    .formHeader{display:grid;gap:5px;margin-bottom:2px}
    .formHeader h2{margin:0}
    .formHeader p{font-size:.86rem;font-weight:450}
    .formPage{display:grid;gap:16px}
    .formPage h3{font-size:.95rem}
    .calendarQuestion{display:grid;gap:7px}
    .calendarContentBlock{display:grid;gap:6px}
    .calContentTitle{margin:0;color:var(--heading);font-size:1.05rem;font-weight:600;letter-spacing:-.01em}
    .calContentSubtitle{margin:0;color:var(--muted);font-size:.95rem;line-height:1.5}
    .calContentText{margin:0;color:var(--ink);font-size:.92rem;line-height:1.6;white-space:pre-line}
    .calContentImage{margin:0}
    .calContentImage img{display:block;width:100%;height:auto;border-radius:var(--field-radius);border:1px solid var(--line)}
    .calContentVideo{position:relative;width:100%;border-radius:var(--field-radius);overflow:hidden;background:#000;border:1px solid var(--line)}
    .calContentVideo video{display:block;width:100%;height:auto}
    .calContentVideoEmbed{aspect-ratio:16/9}
    .calContentVideoEmbed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
    .fieldHelp,.fieldError{margin:0;font-size:.82rem;line-height:1.4}
    .fieldHelp{color:var(--muted)}
    .fieldError{color:var(--danger);font-weight:500}
    .requiredMark{color:var(--accent);margin-left:3px;font-weight:500}
    label{display:block;font-size:.8rem;font-weight:500;letter-spacing:0;color:var(--heading)}
    input,textarea,select{width:100%;border:1px solid var(--field-border);border-radius:var(--field-radius);background:var(--field-bg);color:var(--field-text);font-size:.95rem;padding:12px 14px;min-height:46px;outline:none;transition:border-color .15s,box-shadow .15s}
    textarea{resize:vertical}
    input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
    .options{display:grid;gap:8px}
    .option{display:flex;align-items:center;gap:10px;min-height:44px;border:1px solid var(--field-border);border-radius:var(--field-radius);background:var(--field-bg);padding:9px 12px;font-size:.92rem;font-weight:450;cursor:pointer;transition:border-color .15s}
    .option:hover{border-color:var(--accent)}
    .option input{width:auto}
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
    .loading{opacity:.62;pointer-events:none}
    .successPane{display:none;grid-column:1 / -1;min-height:420px;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:clamp(36px,6vw,80px) clamp(24px,4vw,48px)}
    .shell.bookingDone{grid-template-columns:1fr}
    .shell.bookingDone .intro,.shell.bookingDone .calendarPane,.shell.bookingDone .timesPane{display:none}
    .shell.bookingDone .successPane{display:flex}
    .shell.bookingDisqualified{grid-template-columns:1fr}
    .shell.bookingDisqualified .intro,.shell.bookingDisqualified .calendarPane,.shell.bookingDisqualified .timesPane{display:none}
    .shell.bookingDisqualified .successPane{display:flex}
    .shell.bookingDisqualified .successIcon{background:var(--control-bg);color:var(--muted)}
    .shell.formGate .changeSlot{display:none}
    .shell.formCompleted .formHeader,.shell.formCompleted .formPage,.shell.formCompleted [data-form-next],.shell.formCompleted [data-form-back]{display:none}
    .successCard{max-width:480px;display:flex;flex-direction:column;align-items:center;gap:18px}
    .successCard .successIcon{width:74px;height:74px;border-radius:999px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
    .successCard .successMessage{margin:0;font-size:1.22rem;line-height:1.55;font-weight:600;color:var(--heading);white-space:pre-line}
    @media (max-width:1100px){.shell,.shell.dateSelected,.shell.bookingActive{grid-template-columns:300px minmax(0,1fr)}.shell.noIntro,.shell.noIntro.dateSelected,.shell.noIntro.bookingActive{grid-template-columns:minmax(0,1fr)}.shell.dateSelected .calendarPane{display:none}.timesPane{border-left:1px solid var(--line);border-top:0;max-width:none;width:auto}.shell.dateSelected .timesPane{padding:clamp(28px,3vw,38px) clamp(24px,2.5vw,30px)}.slotList{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
    @media (max-width:760px){.page{width:100%;padding:0;place-items:stretch}.shell,.shell.dateSelected,.shell.bookingActive,.shell.noIntro,.shell.noIntro.dateSelected,.shell.noIntro.bookingActive{grid-template-columns:1fr;min-height:100vh;border:0;border-radius:0;box-shadow:none}.shell.dateSelected .intro,.shell.dateSelected .calendarPane,.shell.bookingActive .intro,.shell.bookingActive .calendarPane{display:none}.shell.dateSelected .timesPane,.shell.bookingActive .timesPane{grid-column:auto;border-top:0}.intro,.calendarPane,.timesPane{padding:26px 22px;border-right:0;border-left:0}.intro{gap:14px}.calendarPane,.timesPane{border-top:1px solid var(--line)}.avatar{width:72px;height:72px;font-size:2rem;border-radius:16px}.days{gap:6px 2px}.day{width:40px;height:40px}.slotList{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));max-height:none}input,textarea,select{font-size:16px;min-height:48px}.formActions button.submit{flex:1 1 100%}}
    @media (max-width:430px){.page{padding:0}.intro,.calendarPane,.timesPane{padding:22px 18px}.day{width:38px;height:38px}.weekdays{font-size:.66rem}.slotList{grid-template-columns:1fr}h1{font-size:1.5rem}h2{font-size:1.2rem}}
  </style>
</head>
<body class="${[embedded ? 'rstk-calendar-embedded' : '', preview ? 'rstk-calendar-preview' : '', `rstk-calendar-layout-${layout}`].filter(Boolean).join(' ')}">
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
        <div class="timezone">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          <span class="timezoneControl">
            <span>Zona horaria</span>
            <strong data-timezone></strong>
            ${effectiveBookingDisplay.allowTimezoneSelection ? '<select data-timezone-select aria-label="Cambiar zona horaria"></select>' : ''}
          </span>
        </div>
      </section>

      <section class="timesPane">
        <div class="selectedDate">
          <h3 data-selected-title>Selecciona una fecha</h3>
          <p data-selected-subtitle>Los horarios aparecerán aquí.</p>
          <button class="changeSlot" type="button" data-change-slot aria-label="Cambiar fecha"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-change-label>Cambiar fecha</span></button>
        </div>
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
      };
      const calendarPane = document.querySelector('[data-calendar-pane]');
      const daysEl = document.querySelector('[data-days]');
      const slotsEl = document.querySelector('[data-slots]');
      const monthLabel = document.querySelector('[data-month-label]');
      const prevButton = document.querySelector('[data-prev]');
      const nextButton = document.querySelector('[data-next]');
      const timezoneLabel = document.querySelector('[data-timezone]');
      const timezoneSelect = document.querySelector('[data-timezone-select]');
      const selectedTitle = document.querySelector('[data-selected-title]');
      const selectedSubtitle = document.querySelector('[data-selected-subtitle]');
      const changeSlotButton = document.querySelector('[data-change-slot]');
      const form = document.querySelector('[data-form]');
      const submit = document.querySelector('[data-submit]');
      const message = document.querySelector('[data-message]');
      const successMessageEl = document.querySelector('[data-success-message]');
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
        : isSupportedTimezone(browserTimezone) ? browserTimezone : 'UTC';

      const pad = (value) => String(value).padStart(2, '0');
      const dateKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      const monthKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const setMessage = (text, type = '') => {
        message.textContent = text || '';
        message.className = 'message' + (type ? ' ' + type : '');
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

      const setStep = (step = 'calendar') => {
        if (!shell) return;
        shell.classList.toggle('dateSelected', step === 'slots');
        shell.classList.toggle('bookingActive', step === 'form');
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
      };

      const showSuccessScreen = (text, opts) => {
        const disqualified = !!(opts && opts.disqualified);
        if (successMessageEl) successMessageEl.textContent = text || '';
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
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) {}
      };

      const getFieldValue = (field) => {
        const type = field.getAttribute('data-field-type') || '';
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return checked.value;
        const input = field.querySelector('input, textarea, select');
        return input ? input.value : '';
      };

      const digits = (value) => String(value || '').replace(/\\D/g, '');
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

      const getPageFields = (pageIndex = formPageIndex) => {
        const page = formPages[pageIndex];
        return page ? Array.from(page.querySelectorAll('.calendarQuestion')) : Array.from(form.querySelectorAll('.calendarQuestion'));
      };

      const validateCurrentPage = () => getPageFields().every(validateField);

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

      const renderSlotsForDate = (key) => {
        const slots = slotsByDate.get(key) || [];
        resetForm(key ? 'slots' : 'calendar');

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
      const getMetaEventPayload = () => ({
        pageUrl: window.location.href,
        referrer: document.referrer,
        params: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
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
        submit.disabled = immediateDisqualified;
        submit.textContent = calendar.preview ? 'Vista previa sin agendar' : 'Agendar cita';
        selectedTitle.textContent = 'Confirma tu cita';
        selectedSubtitle.textContent = formatDay(selectedSlot) + ' a las ' + formatTime(selectedSlot);
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
            if (selectedDateKey && selectedDateKey.startsWith(monthKey(visibleMonth))) {
              renderSlotsForDate(selectedDateKey);
            } else {
              selectedDateKey = '';
              renderSlotsForDate('');
            }
          }
        } catch (error) {
          slotsByDate = new Map();
          renderMonth();
          slotsEl.innerHTML = '<div class="slotEmpty">No se pudieron cargar horarios. Intenta más tarde.</div>';
        } finally {
          setLoading(false);
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

      // (CAL-QUAL) Evaluación de calificación en el cliente (UX inmediata). El servidor SIEMPRE
      // revalida; esto solo mejora la experiencia bloqueando en cuanto eligen una respuesta que
      // descalifica ('disqualify'). Las de 'disqualify_after_submit' las resuelve el servidor.
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
          if (submit) submit.disabled = true;
          setMessage(rule.message || 'Por tus respuestas, por ahora no podemos agendar tu cita.', 'error');
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
        if (submit) { submit.hidden = false; submit.disabled = immediateDisqualified; submit.textContent = 'Continuar'; }
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        // (CAL-FLOW) GATE (formulario primero): "Continuar" valida + califica y revela el calendario.
        if (formFirst && !gatePassed) {
          if (!getPageFields(formPages.length - 1).every(validateField)) return;
          if (immediateDisqualified) {
            const rule = readSelectedDisqualifyRule();
            if (rule && rule.redirectUrl) {
              showSuccessScreen('Gracias por tus respuestas.', { disqualified: true });
              window.setTimeout(() => { try { window.location.assign(rule.redirectUrl); } catch (_) {} }, 1000);
              return;
            }
            showSuccessScreen((rule && rule.message) || 'Por ahora no podemos agendar tu cita.', { disqualified: true });
            return;
          }
          // Guardamos las respuestas del gate (el formulario se ocultará/reiniciará en los siguientes pasos).
          gateResponses = collectResponses();
          gateFormData = new FormData(form);
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
            window.setTimeout(() => { try { window.location.assign(rule.redirectUrl); } catch (_) {} }, 1000);
            return;
          }
          showSuccessScreen((rule && rule.message) || 'Por ahora no podemos agendar tu cita.', { disqualified: true });
          return;
        }

        // En "formulario primero" los datos ya se validaron y recolectaron en el gate.
        if (!formFirst && !getPageFields(formPages.length - 1).every(validateField)) return;
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
          const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/appointments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              startTime: selectedSlot,
              timezone,
              sourceUrl: window.location.href,
              name: formData.get('name'),
              phone: formData.get('phone'),
              email: formData.get('email'),
              notes: formData.get('notes'),
              responses,
              formId: calendar.bookingForm?.formId || '',
              formName: calendar.bookingForm?.formName || '',
              meta: getMetaEventPayload()
            })
          });
          const payload = await response.json();
          // (CAL-QUAL) El servidor descalificó: no se agendó. Mostramos el mensaje del
          // formulario (o redirigimos) en vez de un error rojo.
          if (payload && payload.disqualified) {
            selectedSlot = '';
            if (payload.redirectUrl) {
              showSuccessScreen('Gracias por tus respuestas.', { disqualified: true });
              window.setTimeout(() => { try { window.location.assign(payload.redirectUrl); } catch (_) {} }, 1200);
              return;
            }
            showSuccessScreen(payload.message || 'Gracias por tus respuestas. Por ahora no podemos agendar tu cita.', { disqualified: true });
            return;
          }
          if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudo agendar');
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
              window.location.assign(completionRedirectUrl);
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

  const appointmentCounts = await getCalendarAppointmentCounts(calendars.map(calendar => calendar.id))
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

export async function updateLocalCalendar(calendarId, updateData = {}, { syncStatus = 'pending' } = {}) {
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
    syncStatus: existing.source === 'ghl' && syncStatus === 'pending' ? 'synced' : syncStatus
  })
}

export async function deleteLocalCalendar(calendarId) {
  const existing = await getLocalCalendar(calendarId)
  if (!existing) return null

  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [existing.id])
  await db.run('DELETE FROM calendars WHERE id = ?', [existing.id])

  return existing
}

export async function ensureDefaultLocalCalendar() {
  const existing = await db.get('SELECT * FROM calendars LIMIT 1')
  if (existing) return calendarRowToApi(existing)

  return createLocalCalendar({
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
}

function appointmentRowToApi(row = {}) {
  return {
    id: row.id,
    ghlAppointmentId: row.ghl_appointment_id || null,
    googleEventId: row.google_event_id || null,
    calendarId: row.calendar_id || '',
    locationId: row.location_id || '',
    contactId: row.contact_id || undefined,
    title: row.title || '(Sin título)',
    status: row.status || row.appointment_status || 'confirmed',
    appointmentStatus: row.appointment_status || row.status || 'confirmed',
    assignedUserId: row.assigned_user_id || undefined,
    notes: row.notes || '',
    address: row.address || '',
    startTime: row.start_time,
    endTime: row.end_time || row.start_time,
    dateAdded: row.date_added || row.created_at || row.start_time,
    dateUpdated: row.date_updated || undefined,
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncError: row.sync_error || null,
    syncedAt: row.synced_at || null,
    googleSyncStatus: row.google_sync_status || null,
    googleSyncError: row.google_sync_error || null,
    googleSyncedAt: row.google_synced_at || null,
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
  const appointmentStatus = cleanString(appointment.appointmentStatus || appointment.appointment_status || appointment.status || 'confirmed') || 'confirmed'
  const id = cleanString(options.id || appointment.localId || appointment.local_id || appointment.id) || makeId(LOCAL_APPOINTMENT_PREFIX)

  return {
    id,
    ghlAppointmentId,
    googleEventId,
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
    syncStatus: options.syncStatus || appointment.syncStatus || appointment.sync_status || (source === 'ghl' ? 'synced' : 'pending'),
    syncError: options.syncError || appointment.syncError || appointment.sync_error || null,
    googleSyncStatus: options.googleSyncStatus || appointment.googleSyncStatus || appointment.google_sync_status || (source === 'google' ? 'synced' : null),
    googleSyncError: options.googleSyncError || appointment.googleSyncError || appointment.google_sync_error || null
  }
}

export async function upsertLocalAppointment(raw = {}, options = {}) {
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

  await db.run(`
    INSERT INTO appointments (
      id, ghl_appointment_id, google_event_id, calendar_id, contact_id, location_id, title, status,
      appointment_status, assigned_user_id, notes, address, start_time, end_time,
      date_added, date_updated, source, sync_status, sync_error, synced_at,
      google_sync_status, google_sync_error, google_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      ghl_appointment_id = COALESCE(excluded.ghl_appointment_id, appointments.ghl_appointment_id),
      google_event_id = COALESCE(excluded.google_event_id, appointments.google_event_id),
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
      sync_status = CASE WHEN ${lastWriteWins} = 1 AND appointments.sync_status IN ('pending','pending_delete') THEN appointments.sync_status ELSE excluded.sync_status END,
      sync_error = excluded.sync_error,
      synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.synced_at END,
      google_sync_status = COALESCE(excluded.google_sync_status, appointments.google_sync_status),
      google_sync_error = excluded.google_sync_error,
      google_synced_at = CASE WHEN excluded.google_sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.google_synced_at END,
      deleted_at = CASE WHEN ${lastWriteWins} = 1 AND (appointments.sync_status = 'pending_delete' OR appointments.date_updated >= excluded.date_updated) THEN appointments.deleted_at ELSE NULL END
  `, [
    normalized.id,
    normalized.ghlAppointmentId,
    normalized.googleEventId,
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
    normalized.syncStatus,
    normalized.syncError,
    normalized.syncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.googleSyncStatus,
    normalized.googleSyncError,
    normalized.googleSyncStatus === 'synced' ? new Date().toISOString() : null
  ])

  if (normalized.contactId) {
    await updateContactAppointmentDate(normalized.contactId)
  }

  const row = await getLocalAppointment(normalized.id)
  return row
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

  return upsertLocalAppointment({
    ...appointmentData,
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

  return row ? appointmentRowToApi(row) : null
}

export async function listLocalAppointments({ startTime, endTime, calendarId } = {}) {
  // IMPORTANTE: esta consulta hace JOIN con `contacts`, y AMBAS tablas (appointments y
  // contacts) tienen columnas `deleted_at`/`sync_status`. En Postgres, referenciarlas sin
  // el alias de tabla lanza «column reference "deleted_at" is ambiguous» y revienta el
  // listado de citas (admin) y el cálculo de horarios públicos (free-slots). Por eso TODAS
  // las condiciones van calificadas con `a.` (la tabla appointments). SQLite no se queja,
  // pero producción usa Postgres.
  const conditions = ["COALESCE(a.sync_status, '') != 'pending_delete'", 'a.deleted_at IS NULL']
  const params = []

  if (startTime) {
    conditions.push('a.start_time >= ?')
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
  `, params)

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
    await db.run('DELETE FROM appointments WHERE id = ?', [existing.id])
  }

  if (existing.contactId) {
    await updateContactAppointmentDate(existing.contactId)
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
    SELECT MIN(start_time) AS appointment_date
    FROM appointments
    WHERE contact_id = ?
      AND deleted_at IS NULL
      AND COALESCE(sync_status, '') != 'pending_delete'
      -- APT-010: excluir 'noshow' además de cancelladas/invalid para no fijar appointment_date sobre una cita a la que el contacto no asistió
      AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
  `, [contactId])

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
  const parts = cleanString(fullName).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

/**
 * (GCAL-006) Resuelve un contacto existente por teléfono/email o crea uno nuevo
 * para una cita entrante de Google Calendar. Devuelve el contactId o null si no
 * hay datos de contacto utilizables (degrada con seguridad: la cita entra sin
 * contacto, como hoy).
 */
export async function resolveOrCreateContactForGoogleAppointment({ email, name, phone } = {}) {
  const fullName = cleanString(name)
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

  const contactId = byPhone?.id || byEmail?.id || `rstk_contact_${crypto.randomUUID()}`
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
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n === 7) return 0
  return n >= 0 && n <= 6 ? n : null
}

function getCalendarOpenIntervals(calendar, date) {
  const openHours = normalizeOpenHours(calendar.openHours || calendar.open_hours)
  const jsDay = date.getDay()

  // Horario por defecto (Lun-Vie 9-17) cuando NO hay openHours configurados.
  const defaultIntervalsForDay = () =>
    (jsDay === 0 || jsDay === 6) ? [] : [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]

  if (!openHours.length) {
    return defaultIntervalsForDay()
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

  // Salvaguarda anti-bloqueo: si había openHours pero NINGUNA entrada tenía días
  // utilizables (formato no reconocido), degradamos al horario por defecto en vez de
  // dejar el calendario público sin un solo día agendable.
  if (!matchedAnyDay) {
    return defaultIntervalsForDay()
  }

  return intervals
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB
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

function isHighLevelCalendar(calendar = {}) {
  return normalizeCalendarSource(calendar.source) === 'ghl' || Boolean(cleanString(calendar.ghlCalendarId || calendar.ghl_calendar_id))
}

function getSlotAppointmentLimit(calendar = {}) {
  if (!isHighLevelCalendar(calendar)) return 1
  return Math.max(1, toInt(calendar.appoinmentPerSlot ?? calendar.appointmentPerSlot ?? calendar.appoinment_per_slot, 1))
}

function getEffectiveSlotAppointmentLimit(calendar = {}, options = {}) {
  if (options.ignoreAppointmentConflicts) return Number.POSITIVE_INFINITY

  const overrideLimit = Number(options.appointmentLimit)
  if (Number.isFinite(overrideLimit) && overrideLimit > 0) {
    return Math.max(1, Math.trunc(overrideLimit))
  }

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
  if (!Number.isFinite(limit)) return { available: true, limit, overlapping: 0 }

  const slotStartMs = new Date(startTime).getTime()
  const slotEndMs = new Date(endTime || startTime).getTime()
  if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs)) {
    return { available: true, limit, overlapping: 0 }
  }

  const excludeId = cleanString(options.excludeAppointmentId || '')
  const existing = await listLocalAppointments({ calendarId })
  const overlapping = existing.filter(event => {
    if (excludeId && cleanString(event.id) === excludeId) return false
    const status = cleanString(event.appointmentStatus || event.status).toLowerCase()
    if (['cancelled', 'canceled', 'noshow', 'invalid'].includes(status)) return false
    return overlaps(
      slotStartMs,
      slotEndMs,
      new Date(event.startTime).getTime(),
      new Date(event.endTime || event.startTime).getTime()
    )
  }).length

  // (APT-004) Bloqueos de horario nativos: si el slot cae sobre un horario bloqueado,
  // no está disponible (igual que una cita), aunque no haya HighLevel.
  const blockedOverlaps = await getOverlappingLocalBlockedSlots(calendarId, slotStartMs, slotEndMs)
  if (blockedOverlaps.length > 0) {
    return { available: false, limit, overlapping, blocked: true }
  }

  return { available: overlapping < limit, limit, overlapping }
}

// (APT-004) Bloqueos de horario NATIVOS (calendarios Ristak/Google, no solo HighLevel).
async function getOverlappingLocalBlockedSlots(calendarId, slotStartMs, slotEndMs) {
  if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs)) return []
  let rows = []
  try {
    rows = await db.all(
      `SELECT id, start_time, end_time FROM blocked_slots WHERE calendar_id = ? OR calendar_id IS NULL`,
      [calendarId]
    )
  } catch (error) {
    // Fail-open: si la tabla aún no existe (migración pendiente), no bloquear el agendado.
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

  // Las citas existentes están en UTC en la BD; comparamos por instante absoluto.
  const rangeStart = startDay.toUTC().toISO()
  const rangeEnd = endDay.endOf('day').toUTC().toISO()
  const existing = await listLocalAppointments({ startTime: rangeStart, endTime: rangeEnd, calendarId })

  const durationMinutes = Math.max(1, toInt(calendar.slotDuration, 60))
  const intervalMinutes = Math.max(1, toInt(calendar.slotInterval, durationMinutes))
  const appointmentLimit = getEffectiveSlotAppointmentLimit(calendar, options)
  const nowMs = Date.now()
  const slotsByDate = []

  for (let cursor = startDay; cursor <= endDay; cursor = cursor.plus({ days: 1 })) {
    const dateKey = cursor.toISODate()
    // getCalendarOpenIntervals usa getDay() (0=domingo); construir una Date con los
    // componentes de la fecha preserva el día de la semana correcto.
    const intervals = getCalendarOpenIntervals(calendar, new Date(cursor.year, cursor.month - 1, cursor.day))
    const slots = []
    const seenSlots = new Set()

    for (const interval of intervals) {
      const open = cursor.set({
        hour: toInt(interval.openHour, 9),
        minute: toInt(interval.openMinute, 0),
        second: 0,
        millisecond: 0
      })
      const close = cursor.set({
        hour: toInt(interval.closeHour, 17),
        minute: toInt(interval.closeMinute, 0),
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
        const hasConflict = Number.isFinite(appointmentLimit) && overlappingAppointments >= appointmentLimit

        if (!hasConflict && slotStartMs >= nowMs) {
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

function buildHighLevelCalendarPayload(calendar = {}, locationId) {
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
  if (normalizeOpenHours(calendar.openHours).length) payload.openHours = normalizeOpenHours(calendar.openHours)
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
    WHERE (
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_cal_%'
      )
      AND (
        COALESCE(ghl_calendar_id, '') = ''
        OR sync_status IN ('pending', 'error')
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
      if (!isRistakOwnedRow(row, LOCAL_CALENDAR_PREFIX)) {
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
        // Ya encontramos un calendario remoto equivalente; solo ligamos IDs.
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
        ...calendar,
        ...remoteCalendar,
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

export async function syncLocalAppointmentsToHighLevel(locationId, apiToken) {
  const rows = await db.all(`
    SELECT * FROM appointments
    WHERE (
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_appt_%'
      )
      AND sync_status IN ('pending', 'error', 'pending_delete')
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
      if (!isRistakOwnedRow(row, LOCAL_APPOINTMENT_PREFIX)) {
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

      if (!ghlAppointmentId) {
        const startMs = new Date(appointment.startTime).getTime()
        const endMs = new Date(appointment.endTime || appointment.startTime).getTime()
        const searchStart = Number.isFinite(startMs) ? startMs - 5 * 60000 : Date.now() - 5 * 60000
        const searchEnd = Number.isFinite(endMs) ? endMs + 5 * 60000 : searchStart + 15 * 60000
        const existingEvents = await highlevelCalendarService.getCalendarEvents(
          locationId,
          searchStart,
          searchEnd,
          apiToken,
          remoteCalendarId
        ).catch(error => {
          logger.warn(`No se pudo buscar cita existente antes de crear ${appointment.id}: ${error.message}`)
          return []
        })

        const existingRemote = existingEvents.find(event => (
          sameTime(event.startTime || event.start_time, appointment.startTime) &&
          (!contactId || !event.contactId || event.contactId === contactId) &&
          sameText(event.title || event.name || '', appointment.title || '')
        ))

        if (existingRemote?.id) {
          ghlAppointmentId = existingRemote.id
          response = existingRemote
          matched += 1
        }
      }

      if (response) {
        // Ya encontramos una cita remota equivalente; solo ligamos IDs.
      } else if (ghlAppointmentId) {
        response = await highlevelCalendarService.updateAppointment(ghlAppointmentId, payload, apiToken)
        updated += 1
      } else {
        response = await highlevelCalendarService.createAppointment(payload, locationId, apiToken)
        created += 1
      }

      const remoteAppointment = response?.appointment || response
      ghlAppointmentId = remoteAppointment?.id || ghlAppointmentId

      if (!ghlAppointmentId) {
        throw new Error('HighLevel no devolvió ID de cita; se detiene para evitar duplicados')
      }

      await upsertLocalAppointment({
        ...appointment,
        ...remoteAppointment,
        id: appointment.id,
        ghlAppointmentId,
        calendarId: appointment.calendarId,
        locationId,
        contactId
      }, {
        id: appointment.id,
        source: appointment.source || 'ristak',
        ghlAppointmentId,
        calendarId: appointment.calendarId,
        locationId,
        syncStatus: 'synced'
      })
    } catch (error) {
      failed += 1
      await db.run(
        "UPDATE appointments SET sync_status = 'error', sync_error = ?, date_updated = CURRENT_TIMESTAMP WHERE id = ?",
        [error.message, appointment.id]
      )
      logger.warn(`No se pudo sincronizar cita ${appointment.id} a HighLevel: ${error.message}`)
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
  listLocalAppointments,
  syncLocalAppointmentsToHighLevel,
  syncLocalCalendarsToHighLevel,
  updateLocalAppointment,
  upsertLocalAppointment
}
