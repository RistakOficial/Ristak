import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Modal,
  TabList,
  CustomSelect,
  NumberInput,
  PathInput,
  Switch,
  Loading,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/common'
import {
  ArrowLeft,
  Calendar,
  Loader2,
  CheckCircle,
  XCircle,
  Info,
  Plus,
  Copy,
  Globe2,
  KeyRound,
  TestTube2,
  Trash2,
  ShieldCheck,
  Star,
  ListChecks,
  SlidersHorizontal,
  RefreshCw,
  Pencil,
  ChevronDown,
  MoreHorizontal,
  Link2,
  Bell,
  BellOff,
  Smartphone,
  Sparkles
} from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import {
  calendarsService,
  type Calendar as CalendarType,
  type CalendarBookingCompletionConfig,
  type CalendarBookingDisplayColors,
  type CalendarBookingDisplayConfig,
  type CalendarBookingFontFamily,
  type CalendarBookingDefaultFields,
  type CalendarBookingFormConfig,
  type CalendarBookingLayout,
  type CalendarCustomEventChannel,
  type CalendarCustomEventParameter,
  type CalendarCustomEventParameters,
  type CalendarCustomEventsConfig,
  type GoogleCalendarOption,
  type GoogleCalendarIntegrationStatus,
  type GoogleCalendarMergePreview
} from '@/services/calendarsService'
import {
  appointmentRemindersService,
  formatReminderOffsetLabel,
  type AppointmentReminder,
  type AppointmentReminderInput,
  type ReminderChannelOption,
  type ReminderSenderOption
} from '@/services/appointmentRemindersService'
import {
  messageTemplatesService,
  type MessageTemplate
} from '@/services/messageTemplatesService'
import { sitesService, type PublicSite } from '@/services/sitesService'
import AppointmentReminderModal from '@/pages/Appointments/AppointmentReminderModal'
import {
  FlowVariablesContext,
  type FlowVariable
} from '@/pages/Automations/editor/variablesCatalog'
import {
  MessageComposer,
  VariableTextInput
} from '@/pages/Automations/editor/composer/MessageComposer'
import {
  ACCOUNT_CURRENCY_CONFIG_KEY,
  getDetectedAccountLocaleDefaults,
  normalizeCurrencyCode
} from '@/utils/accountLocale'
import styles from './HighLevelIntegration.module.css'
import pageStyles from './CalendarsConfiguration.module.css'

type CalendarSettingsView = 'calendars' | 'google'
type CalendarSourcePreference = 'combined' | 'ristak' | 'ghl' | 'google'
type CalendarWizardStepId = 'basics' | 'publicUrl' | 'availability' | 'rules' | 'form' | 'reminders' | 'advanced' | 'events' | 'design'
type CalendarPreviewStep = 'date' | 'time' | 'details'

const parseCalendarSettingsRoute = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const calendarsIndex = segments.indexOf('calendars')
  const routeSegments = calendarsIndex >= 0 ? segments.slice(calendarsIndex + 1) : []
  if (routeSegments[0] === 'google') return { view: 'google' as CalendarSettingsView, calendarId: '', create: false }
  if (routeSegments[0] === 'new') return { view: 'calendars' as CalendarSettingsView, calendarId: '', create: true }
  return {
    view: 'calendars' as CalendarSettingsView,
    calendarId: routeSegments[0] ? decodeURIComponent(routeSegments[0]) : '',
    create: false
  }
}

const buildCalendarSettingsPath = (view: CalendarSettingsView, calendarId?: string) => (
  view === 'google' ? '/settings/calendars/google' : calendarId ? `/settings/calendars/${encodeURIComponent(calendarId)}` : '/settings/calendars'
)

const GOOGLE_OAUTH_RETURN_PARAMS = ['google_handoff_token', 'connected']

const cleanGoogleOAuthReturnPath = (pathname: string, search: string, hash = '') => {
  const safePathname = pathname === '/settings/calendars' || pathname.startsWith('/settings/calendars/')
    ? pathname
    : '/settings/calendars/google'
  const params = new URLSearchParams(search)
  GOOGLE_OAUTH_RETURN_PARAMS.forEach(param => params.delete(param))
  const cleanedSearch = params.toString()
  return `${safePathname}${cleanedSearch ? `?${cleanedSearch}` : ''}${hash || ''}`
}

const CALENDAR_COLOR_PALETTE = [
  { label: 'Azul', value: '#3b82f6' },
  { label: 'Cielo', value: '#38bdf8' },
  { label: 'Menta', value: '#14b8a6' },
  { label: 'Verde', value: '#22c55e' },
  { label: 'Lima', value: '#84cc16' },
  { label: 'Amarillo', value: '#f59e0b' },
  { label: 'Naranja', value: '#f97316' },
  { label: 'Rojo', value: '#ef4444' },
  { label: 'Rosa', value: '#ec4899' },
  { label: 'Violeta', value: '#8b5cf6' },
  { label: 'Indigo', value: '#6366f1' },
  { label: 'Grafito', value: '#64748b' }
]

const CALENDAR_DEFAULT_COLOR = '#3b82f6'
const CALENDAR_BACKGROUND_PALETTE = [
  { label: 'Blanco', value: '#ffffff' },
  { label: 'Niebla', value: '#f8fafc' },
  { label: 'Arena', value: '#f5f0e8' },
  { label: 'Gris', value: '#eef1f5' },
  { label: 'Pizarra', value: '#1f2937' },
  { label: 'Carbón', value: '#0f172a' },
  { label: 'Marino', value: '#0b1f3a' },
  { label: 'Negro', value: '#111827' }
]
const CALENDAR_DEFAULT_FORM_SITE_ID = 'system-calendar-booking-form'
const CALENDAR_DEFAULT_COMPLETION_MESSAGE = 'Listo. Tu cita quedó agendada.'
const CALENDAR_DEFAULT_META_EVENT_NAME = 'Schedule'
const CALENDAR_DEFAULT_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS: CalendarBookingDisplayColors = {
  accent: '#3b82f6',
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  controlBg: '#ffffff',
  slotBg: '#ffffff',
  slotText: '#3b82f6',
  selectedText: '#ffffff',
  fieldBg: '#ffffff',
  fieldText: '#1f2937',
  fieldBorder: '#e5e7eb',
  buttonText: '#ffffff'
}
const CALENDAR_PUBLIC_LAYOUT_OPTIONS: Array<{ value: CalendarBookingLayout; label: string }> = [
  { value: 'classic', label: 'Panel izquierdo y calendario' },
  { value: 'compact', label: 'Encabezado compacto' },
  { value: 'stacked', label: 'Una columna' }
]
const CALENDAR_PUBLIC_FONT_OPTIONS: Array<{ value: CalendarBookingFontFamily; label: string }> = [
  { value: 'system', label: 'Sistema' },
  { value: 'modern', label: 'Moderna' },
  { value: 'serif', label: 'Editorial' },
  { value: 'mono', label: 'Monoespaciada' }
]
const CALENDAR_FALLBACK_TIMEZONES = [
  'America/Mexico_City',
  'America/Ciudad_Juarez',
  'America/Monterrey',
  'America/Tijuana',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'Europe/Madrid'
]
const getSupportedCalendarTimezones = () => {
  const supported = typeof Intl !== 'undefined' && typeof (Intl as any).supportedValuesOf === 'function'
    ? (Intl as any).supportedValuesOf('timeZone') as string[]
    : []
  return Array.from(new Set([...(supported || []), ...CALENDAR_FALLBACK_TIMEZONES])).sort((a, b) => a.localeCompare(b))
}
const CALENDAR_TIMEZONE_OPTIONS = getSupportedCalendarTimezones().map(timezone => ({
  value: timezone,
  label: timezone
}))
const CALENDAR_TIMEZONE_VALUES = new Set(CALENDAR_TIMEZONE_OPTIONS.map(option => option.value))
const CALENDAR_PREVIEW_AVAILABLE_DAYS = new Set([24, 25, 26, 29, 30])
const CALENDAR_PREVIEW_DAYS = Array.from({ length: 30 }, (_, index) => index + 1)
const CALENDAR_PREVIEW_DEFAULT_DAY = 24
const CALENDAR_PREVIEW_SLOTS = [
  { value: '09:00', label: '9:00 AM' },
  { value: '10:30', label: '10:30 AM' },
  { value: '12:00', label: '12:00 PM' },
  { value: '15:30', label: '3:30 PM' }
]
const CALENDAR_PREVIEW_TIMEZONE_OPTIONS = [
  'America/Ciudad_Juarez',
  'America/Mexico_City',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Madrid'
]
const CALENDAR_PREVIEW_FONT_STACKS: Record<CalendarBookingFontFamily, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  modern: '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SFMono-Regular", "Roboto Mono", "Cascadia Code", monospace'
}
const CALENDAR_META_EVENT_OPTIONS = [
  { value: 'Schedule', label: 'Schedule · cita agendada' },
  { value: 'Lead', label: 'Lead · lead nuevo' },
  { value: 'Contact', label: 'Contact · contacto iniciado' },
  { value: 'FormSubmitted', label: 'FormSubmitted · formulario enviado' },
  { value: 'CompleteRegistration', label: 'CompleteRegistration · registro completo' },
  { value: 'ViewContent', label: 'ViewContent · visita de contenido' },
  { value: 'Purchase', label: 'Purchase · compra' }
]
const CALENDAR_META_PARAMETER_FIELDS: Array<{
  key: 'value' | 'predictedLtv'
  label: string
  placeholder: string
}> = [
  { key: 'value', label: 'Valor monetario', placeholder: '1500' },
  { key: 'predictedLtv', label: 'LTV estimado', placeholder: '5000' }
]
const CALENDAR_CUSTOM_EVENT_CHANNEL_TABS = [
  {
    value: 'site',
    label: 'Sitios',
    description: 'Usa Meta Pixel y Conversions API cuando la cita venga de una página o formulario.'
  },
  {
    value: 'whatsapp',
    label: 'WhatsApp',
    description: 'Usa Business Messaging y manda LeadSubmitted para citas originadas en WhatsApp.'
  },
  {
    value: 'smart',
    label: 'Inteligente',
    description: 'Ristak decide entre Sitios y WhatsApp según el primer punto de contacto del cliente.'
  }
]
const CALENDAR_WIZARD_STEPS: Array<{
  id: CalendarWizardStepId
  label: string
  description: string
}> = [
  { id: 'basics', label: 'Detalles', description: 'Nombre, cita y estado.' },
  { id: 'publicUrl', label: 'URL pública', description: 'Link para compartir.' },
  { id: 'availability', label: 'Disponibilidad', description: 'Duración y espacios.' },
  { id: 'rules', label: 'Reglas', description: 'Límites de reserva.' },
  { id: 'form', label: 'Formulario', description: 'Preguntas y cierre.' },
  { id: 'reminders', label: 'Recordatorios', description: 'Mensajes automáticos.' },
  { id: 'advanced', label: 'Avanzado', description: 'Notas e integraciones.' },
  { id: 'events', label: 'Eventos', description: 'Meta Pixel y WhatsApp.' },
  { id: 'design', label: 'Estilos y diseños', description: 'Vista, colores y tipografía.' }
]
const CALENDAR_TEMPLATE_EXTRA_CATEGORIES = [
  { id: 'calendar', label: 'Calendario' }
]
const CALENDAR_TEMPLATE_EXTRA_VARIABLES: FlowVariable[] = [
  { fieldId: 'appointment.id', label: 'ID de la cita', category: 'appointment' },
  { fieldId: 'appointment.notes', label: 'Notas escritas en la cita', category: 'appointment' },
  { fieldId: 'calendar.id', label: 'ID del calendario', category: 'calendar' },
  { fieldId: 'calendar.name', label: 'Nombre del calendario', category: 'calendar' },
  { fieldId: 'calendar.google_calendar', label: 'Calendario de Google ligado', category: 'calendar' },
  { fieldId: 'calendar.google_calendar_id', label: 'ID del calendario de Google', category: 'calendar' }
]
const normalizeCalendarColor = (value?: string | null) => {
  const raw = String(value || '').trim()
  if (HEX_COLOR_PATTERN.test(raw)) return raw.toLowerCase()
  return CALENDAR_DEFAULT_COLOR
}

const normalizeCalendarDisplayColor = (
  value: unknown,
  fallback: string
) => {
  const raw = String(value || '').trim()
  if (HEX_COLOR_PATTERN.test(raw)) return raw.toLowerCase()
  return fallback
}

const parseHexColor = (value: unknown): { r: number; g: number; b: number } | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim())
  if (!match) return null
  const int = parseInt(match[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

const colorLuminance = (rgb: { r: number; g: number; b: number }) => {
  const transform = (value: number) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * transform(rgb.r) + 0.7152 * transform(rgb.g) + 0.0722 * transform(rgb.b)
}

const mixHexColors = (fromHex: string, toHex: string, ratio: number) => {
  const from = parseHexColor(fromHex)
  const to = parseHexColor(toHex)
  if (!from || !to) return fromHex
  return rgbToHex({
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio
  })
}

// Texto de la página según el fondo: elige el de mayor contraste real (claro u oscuro).
const readableTextOn = (hex: string, darkText = '#111827', lightText = '#f8fafc') => {
  const rgb = parseHexColor(hex)
  if (!rgb) return darkText
  const base = colorLuminance(rgb)
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const darkRgb = parseHexColor(darkText)
  const lightRgb = parseHexColor(lightText)
  const darkContrast = contrast(base, darkRgb ? colorLuminance(darkRgb) : 0)
  const lightContrast = contrast(base, lightRgb ? colorLuminance(lightRgb) : 1)
  return darkContrast >= lightContrast ? darkText : lightText
}

// Texto sobre el acento (botones, día/horario seleccionado): los acentos de marca
// conservan blanco; solo los claros (ámbar, lima, cian) usan texto oscuro.
const onAccentText = (hex: string) => {
  const rgb = parseHexColor(hex)
  if (!rgb) return '#ffffff'
  return colorLuminance(rgb) > 0.42 ? '#111827' : '#ffffff'
}

// Deriva los 14 colores del widget a partir de solo dos: acento + fondo.
const deriveCalendarBookingPalette = (
  accentInput: string,
  backgroundInput: string
): CalendarBookingDisplayColors => {
  const accent = normalizeCalendarDisplayColor(accentInput, CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS.accent)
  const background = normalizeCalendarDisplayColor(backgroundInput, CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS.background)
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

const normalizeCalendarBookingLayout = (value?: string | null): CalendarBookingLayout => (
  value === 'compact' || value === 'stacked' ? value : 'classic'
)

const normalizeCalendarBookingFontFamily = (value?: string | null): CalendarBookingFontFamily => (
  value === 'modern' || value === 'serif' || value === 'mono' ? value : 'system'
)

const normalizeCalendarTimezoneValue = (value?: string | null) => {
  const raw = String(value || '').trim()
  return CALENDAR_TIMEZONE_VALUES.has(raw) ? raw : ''
}

const detectCalendarPreviewTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const normalizeCalendarMatchValue = (value?: string | null) => String(value || '').trim().toLowerCase()

const createDefaultCalendarBookingFields = (): CalendarBookingDefaultFields => ({
  name: { enabled: true, required: true },
  phone: { enabled: true, required: true },
  email: { enabled: true, required: true },
  // Notas públicas ("detalles adicionales") apagadas por defecto: casi nadie las usa.
  notes: { enabled: false, required: false }
})

const normalizeCalendarBookingDefaultFields = (value?: Partial<CalendarBookingDefaultFields> | null): CalendarBookingDefaultFields => {
  const fields = value || {}
  const phoneEnabled = fields.phone?.enabled !== false
  const emailEnabled = fields.email?.enabled !== false
  const hasContactChannel = phoneEnabled || emailEnabled

  return {
    name: { enabled: true, required: true },
    phone: {
      enabled: hasContactChannel ? phoneEnabled : true,
      required: hasContactChannel ? phoneEnabled : true
    },
    email: {
      enabled: emailEnabled,
      required: emailEnabled
    },
    notes: {
      // Apagado por defecto: solo se muestra si el calendario lo prendió explícitamente.
      enabled: fields.notes?.enabled === true,
      required: false
    }
  }
}

const createDefaultCalendarBookingForm = (): CalendarBookingFormConfig => ({
  useCustomForm: false,
  customFormId: '',
  defaultFields: createDefaultCalendarBookingFields()
})

const normalizeCalendarBookingForm = (value?: Partial<CalendarBookingFormConfig> | null): CalendarBookingFormConfig => {
  const defaultFields = normalizeCalendarBookingDefaultFields(value?.defaultFields)
  const customFormId = String(value?.customFormId || '').trim()

  return {
    useCustomForm: Boolean(value?.useCustomForm && customFormId),
    customFormId,
    defaultFields
  }
}

const createDefaultCalendarBookingCompletion = (): CalendarBookingCompletionConfig => ({
  action: 'message',
  message: CALENDAR_DEFAULT_COMPLETION_MESSAGE,
  redirectUrl: ''
})

const normalizeCalendarBookingCompletion = (value?: Partial<CalendarBookingCompletionConfig> | null): CalendarBookingCompletionConfig => {
  const redirectUrl = String(value?.redirectUrl || '').trim()
  const action = value?.action === 'redirect' ? 'redirect' : 'message'
  const message = String(value?.message || '').trim() || CALENDAR_DEFAULT_COMPLETION_MESSAGE

  return {
    action,
    message,
    redirectUrl
  }
}

const createDefaultCalendarBookingDisplay = (): CalendarBookingDisplayConfig => ({
  showSidebar: true,
  showIcon: true,
  showEventTitle: true,
  showCalendarName: true,
  showDescription: true,
  showDuration: true,
  showConfirmation: true,
  layout: 'classic',
  fontFamily: 'system',
  allowTimezoneSelection: true,
  defaultTimezone: '',
  colors: { ...CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS }
})

const normalizeCalendarBookingDisplay = (
  value?: Partial<CalendarBookingDisplayConfig> | null,
  fallbackAccent = CALENDAR_DEFAULT_COLOR
): CalendarBookingDisplayConfig => {
  const defaults = createDefaultCalendarBookingDisplay()
  const source = value || {}
  const sourceColors = (source.colors || {}) as Partial<CalendarBookingDisplayColors>
  const accent = normalizeCalendarDisplayColor(fallbackAccent, CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS.accent)
  const background = normalizeCalendarDisplayColor(sourceColors.background, CALENDAR_BOOKING_DISPLAY_COLOR_DEFAULTS.background)
  const colors = deriveCalendarBookingPalette(accent, background)

  return {
    showSidebar: source.showSidebar !== false,
    showIcon: source.showIcon !== false,
    showEventTitle: source.showEventTitle !== false,
    showCalendarName: source.showCalendarName !== false,
    showDescription: source.showDescription !== false,
    showDuration: source.showDuration !== false,
    showConfirmation: source.showConfirmation !== false,
    layout: normalizeCalendarBookingLayout(source.layout || defaults.layout),
    fontFamily: normalizeCalendarBookingFontFamily(source.fontFamily || defaults.fontFamily),
    allowTimezoneSelection: source.allowTimezoneSelection !== false,
    defaultTimezone: normalizeCalendarTimezoneValue(source.defaultTimezone),
    colors
  }
}

const createCalendarCustomEventParameter = (): CalendarCustomEventParameter => ({
  id: `param-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  key: '',
  value: ''
})

const createDefaultCalendarCustomEvents = (): CalendarCustomEventsConfig => ({
  enabled: false,
  channel: 'site',
  eventName: CALENDAR_DEFAULT_META_EVENT_NAME,
  parameters: {
    custom: []
  }
})

const normalizeCalendarCustomEventParameters = (value?: Partial<CalendarCustomEventParameters> | null): CalendarCustomEventParameters => {
  const source = value || {}
  const custom = Array.isArray(source.custom)
    ? source.custom
        .map(parameter => ({
          id: String(parameter.id || `param-${Date.now()}-${Math.random().toString(16).slice(2)}`),
          key: String(parameter.key || '').trim(),
          value: String(parameter.value || '').trim()
        }))
        .slice(0, 12)
    : []

  return {
    value: String(source.value || '').trim(),
    predictedLtv: String(source.predictedLtv || '').trim(),
    currency: String(source.currency || '').trim().toUpperCase().slice(0, 3),
    status: String(source.status || '').trim(),
    contentName: String(source.contentName || '').trim(),
    contentCategory: String(source.contentCategory || '').trim(),
    contentIds: String(source.contentIds || '').trim(),
    contentType: String(source.contentType || '').trim(),
    numItems: String(source.numItems || '').trim(),
    orderId: String(source.orderId || '').trim(),
    custom
  }
}

const normalizeCalendarCustomEvents = (value?: Partial<CalendarCustomEventsConfig> | null): CalendarCustomEventsConfig => {
  const channel: CalendarCustomEventChannel = value?.channel === 'whatsapp'
    ? 'whatsapp'
    : value?.channel === 'smart'
      ? 'smart'
      : 'site'
  const rawEventName = String(value?.eventName || '').trim()
  const siteEventName = CALENDAR_META_EVENT_OPTIONS.some(option => option.value === rawEventName)
    ? rawEventName
    : CALENDAR_DEFAULT_META_EVENT_NAME

  return {
    enabled: Boolean(value?.enabled),
    channel,
    eventName: channel === 'whatsapp' ? CALENDAR_DEFAULT_WHATSAPP_EVENT_NAME : siteEventName,
    parameters: normalizeCalendarCustomEventParameters(value?.parameters)
  }
}

const hasCalendarCustomEventParameters = (parameters?: CalendarCustomEventParameters | null) => {
  const normalized = normalizeCalendarCustomEventParameters(parameters)
  return CALENDAR_META_PARAMETER_FIELDS.some(field => Boolean(String(normalized[field.key] || '').trim())) ||
    Boolean(normalized.custom?.some(parameter => parameter.key || parameter.value))
}

const getSavableCalendarCustomEvents = (
  value: Partial<CalendarCustomEventsConfig> | null | undefined,
  accountCurrency: string
): CalendarCustomEventsConfig => {
  const normalized = normalizeCalendarCustomEvents(value)
  const custom = (normalized.parameters.custom || [])
    .filter(parameter => parameter.key || parameter.value)
    .slice(0, 12)

  return {
    ...normalized,
    parameters: {
      ...normalized.parameters,
      currency: normalized.channel === 'whatsapp' ? '' : accountCurrency,
      status: '',
      custom
    }
  }
}

const normalizeCalendarSlugInput = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)

const getCalendarSharePath = (calendar?: Partial<CalendarType> | null) => {
  const slug = calendar?.slug || calendar?.widgetSlug || calendar?.id || ''
  return slug ? `/calendar/${encodeURIComponent(slug)}` : '/calendar/...'
}

const buildCalendarShareUrl = (calendar?: Partial<CalendarType> | null) => {
  if (!calendar) return ''
  const path = getCalendarSharePath(calendar)
  if (calendar.publicUrlEnabled && calendar.publicBaseDomain) return `https://${calendar.publicBaseDomain}${path}`
  return calendar.publicUrl || ''
}

const appendNoTrackToUrl = (url: string) => {
  if (!url) return url
  try {
    const parsed = new URL(url, window.location.origin)
    parsed.searchParams.set('no_track', '1')
    return parsed.toString()
  } catch {
    const [base, hash = ''] = url.split('#')
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}no_track=1${hash ? `#${hash}` : ''}`
  }
}

const buildCalendarOpenUrl = (calendar?: Partial<CalendarType> | null) => {
  const url = buildCalendarShareUrl(calendar)
  return calendar?.antiTrackingEnabled === false ? url : appendNoTrackToUrl(url)
}

const isValidCalendarRedirectUrl = (value: string) => {
  const text = value.trim()
  if (!text) return false
  if (/^\/(?!\/)/.test(text)) return true
  try {
    const parsed = new URL(text)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

const canWriteGoogleCalendarOption = (calendar: GoogleCalendarOption) => (
  ['owner', 'writer'].includes(String(calendar.accessRole || '').toLowerCase())
)

const googleDefaultPromptKey = (calendar?: CalendarType | null) => (
  normalizeCalendarMatchValue(calendar?.googleCalendarId || calendar?.id)
)

const googleMergePromptKey = (preview?: GoogleCalendarMergePreview | null) => (
  normalizeCalendarMatchValue(preview?.googleCalendar?.googleCalendarId || preview?.googleCalendar?.id)
)

export const CalendarsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeState = useMemo(() => parseCalendarSettingsRoute(location.pathname), [location.pathname])
  const { showToast, showConfirm } = useNotification()
  const { locationId, accessToken, user } = useAuth()
  const detectedAccountLocaleDefaults = useMemo(() => getDetectedAccountLocaleDefaults(), [])

  // Estados de configuración (usa sistema híbrido)
  const [defaultCalendarId, setDefaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [attributionCalendarIds, setAttributionCalendarIds] = useAppConfig<string[]>('attribution_calendar_ids', [])
  const [calendarSourcePreference, setCalendarSourcePreference] = useAppConfig<CalendarSourcePreference>('calendar_source_preference', 'combined')
  const [googleDefaultPromptHandledIds, setGoogleDefaultPromptHandledIds] = useAppConfig<string[]>('google_default_calendar_prompt_handled_ids', [])
  const [calendarPushEnabled, setCalendarPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [calendarPushNotificationIds, setCalendarPushNotificationIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])
  const [googleMergePromptHandledIds, setGoogleMergePromptHandledIds] = useAppConfig<string[]>('google_calendar_merge_prompt_handled_ids', [])
  const [accountCurrencyConfig] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedAccountLocaleDefaults.currency)
  const accountCurrency = normalizeCurrencyCode(accountCurrencyConfig, detectedAccountLocaleDefaults.currency)

  // El origen de calendarios solo tiene sentido con una integración de terceros
  // (HighLevel). Sin ella, Ristak es la única fuente posible.
  const { connected: highLevelConnected, loading: highLevelLoading } = useHighLevelConnected()

  // Estados locales
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [loadingCalendars, setLoadingCalendars] = useState(true)
  const [activeView, setActiveView] = useState<CalendarSettingsView>(routeState.view)
  const [googleIntegration, setGoogleIntegration] = useState<GoogleCalendarIntegrationStatus | null>(null)
  const [googleCalendarOptions, setGoogleCalendarOptions] = useState<GoogleCalendarOption[]>([])
  const [loadingGoogleCalendarOptions, setLoadingGoogleCalendarOptions] = useState(false)
  const [loadingGoogleIntegration, setLoadingGoogleIntegration] = useState(true)
  const [savingGoogleIntegration, setSavingGoogleIntegration] = useState(false)
  const [testingGoogleIntegration, setTestingGoogleIntegration] = useState(false)
  const [syncingGoogleIntegration, setSyncingGoogleIntegration] = useState(false)
  const [disconnectingGoogleIntegration, setDisconnectingGoogleIntegration] = useState(false)
  const [googleDefaultPromptCalendar, setGoogleDefaultPromptCalendar] = useState<CalendarType | null>(null)
  const [savingGoogleDefaultPrompt, setSavingGoogleDefaultPrompt] = useState(false)
  const [googleMergePrompt, setGoogleMergePrompt] = useState<GoogleCalendarMergePreview | null>(null)
  const [savingGoogleMergePrompt, setSavingGoogleMergePrompt] = useState(false)
  const [googleCalendarId, setGoogleCalendarId] = useState('')
  const [savingGoogleSyncCalendarId, setSavingGoogleSyncCalendarId] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showNotificationsModal, setShowNotificationsModal] = useState(false)
  const [creatingCalendar, setCreatingCalendar] = useState(false)
  const [newCalendar, setNewCalendar] = useState<Partial<CalendarType>>({
    name: '',
    calendarType: 'event',
    eventTitle: 'Cita',
    notes: '',
    eventColor: '#3b82f6',
    isActive: true,
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    appoinmentPerSlot: 1,
    appoinmentPerDay: 0,
    allowBookingAfter: 0,
    allowBookingAfterUnit: 'hours',
    allowBookingFor: 30,
    allowBookingForUnit: 'days',
    bookingForm: createDefaultCalendarBookingForm(),
    bookingCompletion: createDefaultCalendarBookingCompletion(),
    bookingDisplay: createDefaultCalendarBookingDisplay(),
    customEvents: createDefaultCalendarCustomEvents(),
    antiTrackingEnabled: true
  })

  // Estados del wizard de edición de calendario
  const [expandedCalendarId, setExpandedCalendarId] = useState<string | null>(null)
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarType | null>(null)
  const [calendarWizardStep, setCalendarWizardStep] = useState<CalendarWizardStepId>('basics')
  const [calendarPreviewStep, setCalendarPreviewStep] = useState<CalendarPreviewStep>('date')
  const [calendarPreviewDate, setCalendarPreviewDate] = useState(CALENDAR_PREVIEW_DEFAULT_DAY)
  const [calendarPreviewSlot, setCalendarPreviewSlot] = useState(CALENDAR_PREVIEW_SLOTS[1].value)
  const [calendarPreviewTimezone, setCalendarPreviewTimezone] = useState(() => detectCalendarPreviewTimezone())
  const [calendarMetaParamsOpen, setCalendarMetaParamsOpen] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingActiveCalendarId, setSavingActiveCalendarId] = useState<string | null>(null)
  const [deletingCalendarId, setDeletingCalendarId] = useState<string | null>(null)
  const [formSites, setFormSites] = useState<PublicSite[]>([])
  const [loadingFormSites, setLoadingFormSites] = useState(false)
  const [appointmentReminders, setAppointmentReminders] = useState<AppointmentReminder[]>([])
  const [reminderSenders, setReminderSenders] = useState<ReminderSenderOption[]>([])
  const [reminderChannels, setReminderChannels] = useState<ReminderChannelOption[]>([])
  const [reminderTemplates, setReminderTemplates] = useState<MessageTemplate[]>([])
  const [selectedAppointmentReminder, setSelectedAppointmentReminder] = useState<AppointmentReminder | null>(null)
  const [isAppointmentReminderModalOpen, setIsAppointmentReminderModalOpen] = useState(false)
  const [loadingAppointmentReminders, setLoadingAppointmentReminders] = useState(false)
  const [creatingAppointmentReminder, setCreatingAppointmentReminder] = useState(false)

  // Cargar calendarios al montar
  useEffect(() => {
    loadCalendars()
  }, [locationId, accessToken, calendarSourcePreference])

  useEffect(() => {
    loadCalendarForms()
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadAppointmentReminderSettings = async () => {
      setLoadingAppointmentReminders(true)
      try {
        const [overview, templateBundle] = await Promise.all([
          appointmentRemindersService.getOverview(),
          messageTemplatesService.getBundle()
        ])
        if (cancelled) return
        setAppointmentReminders(overview.reminders)
        setReminderSenders(overview.senders)
        setReminderChannels(overview.channels)
        setReminderTemplates(templateBundle.templates)
      } catch {
        if (!cancelled) {
          showToast('error', 'Recordatorios automáticos', 'No se pudieron cargar los mensajes automáticos.')
        }
      } finally {
        if (!cancelled) {
          setLoadingAppointmentReminders(false)
        }
      }
    }

    void loadAppointmentReminderSettings()

    return () => {
      cancelled = true
    }
  }, [showToast])

  useEffect(() => {
    loadGoogleIntegration()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const handoffToken = params.get('google_handoff_token') || ''
    const connected = params.get('connected') === '1'
    if (!handoffToken && !connected) return

    const finishGoogleReturn = async () => {
      setSavingGoogleIntegration(true)
      try {
        if (!handoffToken) {
          throw new Error('Google autorizó, pero no regresó el handoff para guardar la conexión local.')
        }
        const data = await calendarsService.claimGoogleOAuth(handoffToken)
        setGoogleIntegration(data)
        setGoogleCalendarId(data.calendarId || '')
        await loadGoogleCalendarOptions(data)
        await loadCalendars()
        showToast('success', 'Google Calendar conectado', 'La cuenta quedó lista para sincronizar calendarios desde esta instalación.')
      } catch (error: any) {
        await loadGoogleIntegration()
        showToast('warning', 'Google autorizó, falta guardar', error.message || 'Vuelve a conectar Google Calendar desde esta pantalla.')
      } finally {
        setSavingGoogleIntegration(false)
        navigate(cleanGoogleOAuthReturnPath(location.pathname, location.search, location.hash), { replace: true })
      }
    }

    void finishGoogleReturn()
  }, [location.hash, location.pathname, location.search, navigate, showToast])

  useEffect(() => {
    if (googleIntegration?.connected) {
      loadGoogleCalendarOptions()
    } else {
      setGoogleCalendarOptions([])
    }
  }, [googleIntegration?.connected])

  useEffect(() => {
    setActiveView(current => current === routeState.view ? current : routeState.view)
    setShowCreateModal(routeState.create)

    if (routeState.calendarId && calendars.length) {
      const calendar = calendars.find(item => item.id === routeState.calendarId)
      if (calendar) {
        setSelectedCalendar({
          ...calendar,
          bookingForm: normalizeCalendarBookingForm(calendar.bookingForm),
          bookingCompletion: normalizeCalendarBookingCompletion(calendar.bookingCompletion),
          bookingDisplay: normalizeCalendarBookingDisplay(calendar.bookingDisplay, calendar.eventColor),
          customEvents: normalizeCalendarCustomEvents(calendar.customEvents)
        })
        if (expandedCalendarId !== calendar.id) {
          setCalendarWizardStep('basics')
          setCalendarMetaParamsOpen(false)
        }
        setExpandedCalendarId(calendar.id)
      }
    } else if (!routeState.calendarId && expandedCalendarId) {
      setExpandedCalendarId(null)
      setSelectedCalendar(null)
      setCalendarMetaParamsOpen(false)
    }
  }, [calendars, expandedCalendarId, routeState.calendarId, routeState.create, routeState.view])

  // Sin integración conectada el selector de origen queda oculto. Si había quedado
  // en "Solo HighLevel", se volvería a Ristak para no esconder sus calendarios
  // (de lo contrario no habría forma de recuperarlos sin el selector).
  useEffect(() => {
    if (!highLevelLoading && !highLevelConnected && calendarSourcePreference === 'ghl') {
      setCalendarSourcePreference('ristak').catch(() => {})
    }
    if (!loadingGoogleIntegration && calendarSourcePreference === 'google') {
      setCalendarSourcePreference(highLevelConnected ? 'combined' : 'ristak').catch(() => {})
    }
  }, [highLevelLoading, highLevelConnected, loadingGoogleIntegration, googleIntegration?.connected, calendarSourcePreference, setCalendarSourcePreference])

  // Con un único calendario, ese es el predeterminado: no tiene sentido pedir
  // selección manual cuando solo existe la opción de Ristak.
  useEffect(() => {
    if (!loadingCalendars && calendars.length === 1 && !defaultCalendarId) {
      setDefaultCalendarId(calendars[0].id).catch(() => {})
    }
  }, [loadingCalendars, calendars, defaultCalendarId, setDefaultCalendarId])

  const loadCalendars = async () => {
    try {
      setLoadingCalendars(true)
      const data = await calendarsService.getCalendars(locationId, accessToken)
      const normalizedCalendars = data.map(calendar => ({
        ...calendar,
        bookingForm: normalizeCalendarBookingForm(calendar.bookingForm),
        bookingCompletion: normalizeCalendarBookingCompletion(calendar.bookingCompletion),
        bookingDisplay: normalizeCalendarBookingDisplay(calendar.bookingDisplay, calendar.eventColor),
        customEvents: normalizeCalendarCustomEvents(calendar.customEvents)
      }))
      setCalendars(normalizedCalendars)
      return normalizedCalendars
    } catch (error: any) {
      showToast('error', 'Error al cargar calendarios', error.message)
      return []
    } finally {
      setLoadingCalendars(false)
    }
  }

  const loadCalendarForms = async () => {
    try {
      setLoadingFormSites(true)
      const data = await sitesService.listSites()
      const forms = data
        .filter(site => (
          (site.siteType === 'standard_form' || site.siteType === 'interactive_form') &&
          site.status !== 'archived'
        ))
        .sort((left, right) => {
          const leftSystem = left.id === CALENDAR_DEFAULT_FORM_SITE_ID ? 0 : 1
          const rightSystem = right.id === CALENDAR_DEFAULT_FORM_SITE_ID ? 0 : 1
          if (leftSystem !== rightSystem) return leftSystem - rightSystem
          return String(left.name || '').localeCompare(String(right.name || ''), 'es')
        })
      setFormSites(forms)
      return forms
    } catch (error: any) {
      setFormSites([])
      showToast('warning', 'No se pudieron cargar formularios', error.message || 'El calendario usará el formulario predeterminado')
      return []
    } finally {
      setLoadingFormSites(false)
    }
  }

  const loadGoogleIntegration = async () => {
    try {
      setLoadingGoogleIntegration(true)
      const data = await calendarsService.getGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || '')
    } catch (error: any) {
      showToast('error', 'Error al cargar Google Calendar', error.message || 'No se pudo leer la integración')
    } finally {
      setLoadingGoogleIntegration(false)
    }
  }

  const handleToggleAppointmentReminder = async (reminder: AppointmentReminder, enabled: boolean) => {
    setAppointmentReminders(current => current.map(item => (
      item.id === reminder.id ? { ...item, enabled } : item
    )))

    try {
      const updated = await appointmentRemindersService.updateReminder(reminder.id, { enabled })
      setAppointmentReminders(current => current.map(item => (
        item.id === updated.id ? updated : item
      )))
    } catch {
      setAppointmentReminders(current => current.map(item => (
        item.id === reminder.id ? { ...item, enabled: !enabled } : item
      )))
      showToast('error', 'Recordatorios automáticos', 'No se pudo actualizar el mensaje automático.')
    }
  }

  const handleAddAppointmentReminder = async () => {
    if (creatingAppointmentReminder) return
    setCreatingAppointmentReminder(true)
    try {
      const created = await appointmentRemindersService.createReminder({})
      setAppointmentReminders(current => [...current, created])
      setSelectedAppointmentReminder(created)
      setIsAppointmentReminderModalOpen(true)
    } catch {
      showToast('error', 'Recordatorios automáticos', 'No se pudo crear el mensaje automático.')
    } finally {
      setCreatingAppointmentReminder(false)
    }
  }

  const handleSaveAppointmentReminder = async (reminderId: string, input: AppointmentReminderInput) => {
    try {
      const updated = await appointmentRemindersService.updateReminder(reminderId, input)
      setAppointmentReminders(current => current.map(item => (
        item.id === updated.id ? updated : item
      )))
      showToast('success', 'Recordatorios automáticos', 'Cambios guardados.')
    } catch (error) {
      showToast('error', 'Recordatorios automáticos', 'No se pudieron guardar los cambios.')
      throw error
    }
  }

  const handleDeleteAppointmentReminder = async (reminderId: string) => {
    try {
      await appointmentRemindersService.deleteReminder(reminderId)
      setAppointmentReminders(current => current.filter(item => item.id !== reminderId))
      showToast('success', 'Recordatorios automáticos', 'Mensaje automático eliminado.')
    } catch (error) {
      showToast('error', 'Recordatorios automáticos', 'No se pudo eliminar el mensaje automático.')
      throw error
    }
  }

  const loadGoogleCalendarOptions = async (integrationStatus: GoogleCalendarIntegrationStatus | null = googleIntegration) => {
    if (!integrationStatus?.connected) {
      setGoogleCalendarOptions([])
      return []
    }

    try {
      setLoadingGoogleCalendarOptions(true)
      const data = await calendarsService.getGoogleCalendarOptions()
      setGoogleCalendarOptions(data)
      return data
    } catch (error: any) {
      setGoogleCalendarOptions([])
      showToast('warning', 'No se pudieron cargar calendarios Google', error.message || 'Vuelve a conectar Google Calendar y acepta los permisos.')
      return []
    } finally {
      setLoadingGoogleCalendarOptions(false)
    }
  }

  const getGoogleLinkedCalendars = (items: CalendarType[] = calendars) => (
    items.filter((calendar) => calendar.source !== 'google' && Boolean(calendar.googleCalendarId))
  )

  const calendarTemplateVariableCatalog = useMemo(() => ({
    categories: CALENDAR_TEMPLATE_EXTRA_CATEGORIES,
    variables: CALENDAR_TEMPLATE_EXTRA_VARIABLES
  }), [])

  const findConnectedGoogleCalendar = (
    calendarList: CalendarType[] = calendars,
    integrationStatus: GoogleCalendarIntegrationStatus | null = googleIntegration
  ) => {
    const connectedCalendarId = normalizeCalendarMatchValue(integrationStatus?.calendarId || googleCalendarId)
    const googleCalendars = calendarList.filter((calendar) => calendar.source === 'google')

    if (!googleCalendars.length) return null

    return googleCalendars.find((calendar) => (
      normalizeCalendarMatchValue(calendar.googleCalendarId) === connectedCalendarId ||
      normalizeCalendarMatchValue(calendar.name) === connectedCalendarId
    )) || (googleCalendars.length === 1 ? googleCalendars[0] : null)
  }

  const maybeShowGoogleDefaultPrompt = (
    calendarList: CalendarType[],
    integrationStatus: GoogleCalendarIntegrationStatus | null
  ) => {
    const importedCalendar = findConnectedGoogleCalendar(calendarList, integrationStatus)
    if (!importedCalendar) return false

    const promptKey = googleDefaultPromptKey(importedCalendar)
    if (!promptKey || googleDefaultPromptHandledIds.includes(promptKey)) return false

    const alreadyConfigured = defaultCalendarId === importedCalendar.id && attributionCalendarIds.includes(importedCalendar.id)
    if (alreadyConfigured) return false

    setGoogleDefaultPromptCalendar(importedCalendar)
    return true
  }

  const maybeShowGoogleDefaultPromptFromCalendars = async (
    calendarList: CalendarType[],
    integrationStatus: GoogleCalendarIntegrationStatus | null
  ) => {
    if (findConnectedGoogleCalendar(calendarList, integrationStatus)) {
      return maybeShowGoogleDefaultPrompt(calendarList, integrationStatus)
    }

    const allCalendars = await calendarsService.getCalendars(locationId, accessToken, 'combined')
    return maybeShowGoogleDefaultPrompt(allCalendars, integrationStatus)
  }

  const markGoogleDefaultPromptHandled = async (calendar: CalendarType) => {
    const promptKey = googleDefaultPromptKey(calendar)
    if (!promptKey || googleDefaultPromptHandledIds.includes(promptKey)) return

    await setGoogleDefaultPromptHandledIds([...googleDefaultPromptHandledIds, promptKey])
  }

  const maybeShowGoogleMergePrompt = async () => {
    try {
      const preview = await calendarsService.getGoogleMergePreview()
      const promptKey = googleMergePromptKey(preview)

      if (!preview.mergeAvailable || !promptKey || googleMergePromptHandledIds.includes(promptKey)) {
        return false
      }

      setGoogleMergePrompt(preview)
      return true
    } catch (error: any) {
      showToast('warning', 'No se pudo revisar combinación', error.message || 'Puedes intentar sincronizar manualmente después')
      return false
    }
  }

  const maybeShowGooglePostConnectPrompts = async (
    calendarList: CalendarType[],
    integrationStatus: GoogleCalendarIntegrationStatus | null
  ) => {
    const defaultPromptOpened = await maybeShowGoogleDefaultPromptFromCalendars(calendarList, integrationStatus)
    if (!defaultPromptOpened) {
      await maybeShowGoogleMergePrompt()
    }
  }

  const markGoogleMergePromptHandled = async (preview: GoogleCalendarMergePreview) => {
    const promptKey = googleMergePromptKey(preview)
    if (!promptKey || googleMergePromptHandledIds.includes(promptKey)) return

    await setGoogleMergePromptHandledIds([...googleMergePromptHandledIds, promptKey])
  }

  const handleConnectGoogleOAuth = async () => {
    setSavingGoogleIntegration(true)
    try {
      const data = await calendarsService.getGoogleConnectUrl()
      if (!data.url) {
        throw new Error('El portal no devolvió la URL de conexión')
      }
      window.location.assign(data.url)
    } catch (error: any) {
      showToast('error', 'No se pudo abrir Google Calendar', error.message || 'Intenta de nuevo en unos minutos')
    } finally {
      setSavingGoogleIntegration(false)
    }
  }

  const handleTestGoogleIntegration = async () => {
    setTestingGoogleIntegration(true)
    try {
      const data = await calendarsService.testGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || googleCalendarId)
      await loadGoogleCalendarOptions(data)
      showToast('success', 'Google Calendar probado', data.lastTestMessage || 'Permisos validados correctamente')
    } catch (error: any) {
      await loadGoogleIntegration()
      showToast('error', 'La prueba falló', error.message || 'Revisa permisos del calendario')
    } finally {
      setTestingGoogleIntegration(false)
    }
  }

  const handleSyncGoogleIntegration = async () => {
    const calendarSnapshot = calendars.length ? calendars : await loadCalendars()
    if (googleIntegration?.connected && getGoogleLinkedCalendars(calendarSnapshot).length === 0) {
      setActiveView('calendars')
      navigate(buildCalendarSettingsPath('calendars'))
      showToast(
        'warning',
        'Elige calendario de Google',
        'Abre un calendario de Ristak y selecciona con qué calendario de Google se va a sincronizar.'
      )
      return
    }

    setSyncingGoogleIntegration(true)
    try {
      const data = await calendarsService.syncGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || googleCalendarId)
      await loadCalendars()
      showToast('success', 'Google Calendar sincronizado', data.lastSyncMessage || 'Citas sincronizadas en calendarios vinculados')
    } catch (error: any) {
      await loadGoogleIntegration()
      showToast('error', 'No se pudo sincronizar Google Calendar', error.message || 'Vuelve a conectar Google Calendar y acepta los permisos.')
    } finally {
      setSyncingGoogleIntegration(false)
    }
  }

  const handleAcceptGoogleDefaultPrompt = async () => {
    if (!googleDefaultPromptCalendar) return

    setSavingGoogleDefaultPrompt(true)
    try {
      await setDefaultCalendarId(googleDefaultPromptCalendar.id)

      if (!attributionCalendarIds.includes(googleDefaultPromptCalendar.id)) {
        await setAttributionCalendarIds([...attributionCalendarIds, googleDefaultPromptCalendar.id])
      }

      await markGoogleDefaultPromptHandled(googleDefaultPromptCalendar)
      setGoogleDefaultPromptCalendar(null)
      await maybeShowGoogleMergePrompt()
      showToast(
        'success',
        'Calendario predeterminado actualizado',
        `${googleDefaultPromptCalendar.name} quedó como calendario de citas y conversión`
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el calendario predeterminado', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleDefaultPrompt(false)
    }
  }

  const handleDismissGoogleDefaultPrompt = async () => {
    if (!googleDefaultPromptCalendar) return

    setSavingGoogleDefaultPrompt(true)
    try {
      await markGoogleDefaultPromptHandled(googleDefaultPromptCalendar)
      setGoogleDefaultPromptCalendar(null)
      await maybeShowGoogleMergePrompt()
      showToast('info', 'Sin cambios', 'El calendario se queda conectado sin hacerlo predeterminado')
    } catch (error: any) {
      showToast('error', 'No se pudo cerrar la pregunta', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleDefaultPrompt(false)
    }
  }

  const handleCloseGoogleDefaultPromptModal = () => {
    if (savingGoogleDefaultPrompt) return
    void handleDismissGoogleDefaultPrompt()
  }

  const handleAcceptGoogleMergePrompt = async () => {
    if (!googleMergePrompt) return

    setSavingGoogleMergePrompt(true)
    try {
      const sourceCalendarIds = googleMergePrompt.sourceCalendars.map((calendar) => calendar.id)
      const result = await calendarsService.mergeGoogleAppointments(sourceCalendarIds)
      const googleCalendar = result.googleCalendar || googleMergePrompt.googleCalendar

      if (googleCalendar?.id) {
        await setDefaultCalendarId(googleCalendar.id)
        await setAttributionCalendarIds([googleCalendar.id])
      }

      await markGoogleMergePromptHandled(googleMergePrompt)
      setGoogleMergePrompt(null)
      await loadCalendars()
      showToast(
        result.failed > 0 ? 'warning' : 'success',
        'Calendarios combinados',
        `${result.moved || 0} cita${result.moved === 1 ? '' : 's'} se movieron a Google Calendar${result.failed > 0 ? `; ${result.failed} quedaron pendientes` : ''}`
      )
    } catch (error: any) {
      showToast('error', 'No se pudieron combinar calendarios', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleMergePrompt(false)
    }
  }

  const handleDismissGoogleMergePrompt = async () => {
    if (!googleMergePrompt) return

    setSavingGoogleMergePrompt(true)
    try {
      await markGoogleMergePromptHandled(googleMergePrompt)
      setGoogleMergePrompt(null)
      showToast('info', 'Calendarios separados', 'Ristak y Google Calendar se quedan como calendarios independientes')
    } catch (error: any) {
      showToast('error', 'No se pudo cerrar la pregunta', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleMergePrompt(false)
    }
  }

  const handleCloseGoogleMergePromptModal = () => {
    if (savingGoogleMergePrompt) return
    void handleDismissGoogleMergePrompt()
  }

  const handleDisconnectGoogleIntegration = async () => {
    showConfirm(
      'Desconectar Google Calendar',
      'Las citas locales se conservan, pero esta instalación dejará de sincronizar con Google Calendar.',
      () => {
        const disconnectGoogleIntegration = async () => {
          setDisconnectingGoogleIntegration(true)
          try {
            const data = await calendarsService.deleteGoogleIntegration()
            setGoogleIntegration(data)
            setGoogleCalendarId('')
            setGoogleCalendarOptions([])
            await loadCalendars()
            showToast('success', 'Google Calendar desconectado', 'La integración quedó removida de esta instalación')
          } catch (error: any) {
            showToast('error', 'No se pudo desconectar', error.message || 'Intenta nuevamente')
          } finally {
            setDisconnectingGoogleIntegration(false)
          }
        }

        void disconnectGoogleIntegration()
      },
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  // Guardado automático: Calendario predeterminado
  const handleDefaultCalendarChange = async (calendarId: string) => {
    try {
      await setDefaultCalendarId(calendarId)
      showToast('success', 'Calendario predeterminado guardado', calendarId ? 'Se seleccionará automáticamente al abrir Citas' : 'Deberás seleccionar manualmente')
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    }
  }

  // Guardado automático: Toggle individual de atribución
  const handleAttributionToggle = async (calendarId: string) => {
    const newSelection = attributionCalendarIds.includes(calendarId)
      ? attributionCalendarIds.filter(id => id !== calendarId)
      : [...attributionCalendarIds, calendarId]

    try {
      await setAttributionCalendarIds(newSelection)
      showToast('success', 'Calendarios de atribución actualizados', `${newSelection.length} calendario${newSelection.length !== 1 ? 's' : ''} seleccionado${newSelection.length !== 1 ? 's' : ''}`)
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    }
  }

  const handleCalendarActiveToggle = async (calendar: CalendarType) => {
    const nextActive = !calendar.isActive
    setSavingActiveCalendarId(calendar.id)

    try {
      await calendarsService.updateCalendar(calendar.id, { isActive: nextActive }, accessToken || undefined)
      setCalendars(current => current.map(item => (
        item.id === calendar.id ? { ...item, isActive: nextActive } : item
      )))
      setSelectedCalendar(current => (
        current?.id === calendar.id ? { ...current, isActive: nextActive } : current
      ))
      showToast(
        'success',
        nextActive ? 'Calendario disponible' : 'Calendario pausado',
        nextActive ? 'La URL pública ya puede recibir citas.' : 'La URL pública dejará de aceptar nuevas citas.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el estado', error.message || 'Intenta nuevamente')
    } finally {
      setSavingActiveCalendarId(null)
    }
  }

  const handleCalendarPushEnabledToggle = async () => {
    try {
      await setCalendarPushEnabled(!calendarPushEnabled)
      showToast(
        'success',
        !calendarPushEnabled ? 'Notificaciones encendidas' : 'Notificaciones apagadas',
        !calendarPushEnabled
          ? 'Ristak enviará notificaciones a los celulares que ya dieron permiso.'
          : 'Ristak dejará de enviar notificaciones de nuevas citas.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleCalendarPushSelectionToggle = async (calendarId: string) => {
    const newSelection = calendarPushNotificationIds.includes(calendarId)
      ? calendarPushNotificationIds.filter(id => id !== calendarId)
      : [...calendarPushNotificationIds, calendarId]

    try {
      await setCalendarPushNotificationIds(newSelection)
      showToast(
        'success',
        'Calendarios de notificaciones actualizados',
        newSelection.length
          ? `${newSelection.length} calendario${newSelection.length !== 1 ? 's' : ''} enviarán notificaciones.`
          : 'Todos los calendarios enviarán notificaciones.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleUseAllCalendarPushNotifications = async () => {
    try {
      await setCalendarPushNotificationIds([])
      showToast('success', 'Notificaciones para todos', 'Todos los calendarios activos podrán notificar nuevas citas.')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleOpenCalendarEditor = (calendar: CalendarType) => {
    const bookingDisplay = normalizeCalendarBookingDisplay(calendar.bookingDisplay, calendar.eventColor)
    setSelectedCalendar({
      ...calendar,
      bookingForm: normalizeCalendarBookingForm(calendar.bookingForm),
      bookingCompletion: normalizeCalendarBookingCompletion(calendar.bookingCompletion),
      bookingDisplay,
      customEvents: normalizeCalendarCustomEvents(calendar.customEvents),
      antiTrackingEnabled: calendar.antiTrackingEnabled !== false
    })
    setExpandedCalendarId(calendar.id)
    setCalendarWizardStep('basics')
    setCalendarMetaParamsOpen(false)
    setCalendarPreviewStep('date')
    setCalendarPreviewDate(CALENDAR_PREVIEW_DEFAULT_DAY)
    setCalendarPreviewSlot(CALENDAR_PREVIEW_SLOTS[1].value)
    setCalendarPreviewTimezone(bookingDisplay.defaultTimezone || detectCalendarPreviewTimezone())
    if (googleIntegration?.connected && !loadingGoogleCalendarOptions && !googleCalendarOptions.length) {
      loadGoogleCalendarOptions()
    }
    navigate(buildCalendarSettingsPath('calendars', calendar.id))
  }

  const handleCloseCalendarEditor = () => {
    setExpandedCalendarId(null)
    setSelectedCalendar(null)
    setCalendarWizardStep('basics')
    setCalendarMetaParamsOpen(false)
    setCalendarPreviewStep('date')
    navigate(buildCalendarSettingsPath('calendars'), { replace: true })
  }

  const handleSaveCalendarConfig = async () => {
    if (!selectedCalendar) return

    setSavingConfig(true)
    setSavingGoogleSyncCalendarId(selectedCalendar.id)
    try {
      const previousGoogleCalendarId = calendars.find((item) => item.id === selectedCalendar.id)?.googleCalendarId || ''
      const nextGoogleCalendarId = selectedCalendar.googleCalendarId || ''
      const googleSyncChanged = nextGoogleCalendarId !== previousGoogleCalendarId

      // Construir payload con todos los campos editables
      const bookingForm = normalizeCalendarBookingForm(selectedCalendar.bookingForm)
      const bookingCompletion = normalizeCalendarBookingCompletion(selectedCalendar.bookingCompletion)
      const bookingDisplay = normalizeCalendarBookingDisplay(selectedCalendar.bookingDisplay, selectedCalendar.eventColor)
      const customEvents = getSavableCalendarCustomEvents(selectedCalendar.customEvents, accountCurrency)
      const nextSlug = normalizeCalendarSlugInput(selectedCalendar.slug || selectedCalendar.widgetSlug || selectedCalendar.name || selectedCalendar.id)
      const slugConflict = calendars.some(item => (
        item.id !== selectedCalendar.id &&
        [item.slug, item.widgetSlug].some(value => normalizeCalendarSlugInput(value || '') === nextSlug)
      ))

      if (!nextSlug) {
        showToast('error', 'URL pública incompleta', 'Escribe una ruta válida para compartir este calendario.')
        return
      }

      if (slugConflict) {
        showToast('error', 'URL pública repetida', 'Otro calendario ya usa esa ruta. Cambia el enlace antes de guardar.')
        return
      }

      if (bookingCompletion.action === 'redirect' && !isValidCalendarRedirectUrl(bookingCompletion.redirectUrl)) {
        showToast('error', 'Redirección inválida', 'Usa una URL completa con http/https o una ruta interna que empiece con /.')
        return
      }

      const updateData: any = {
        name: selectedCalendar.name?.trim() || 'Calendario',
        slug: nextSlug,
        widgetSlug: nextSlug,
        eventTitle: selectedCalendar.eventTitle?.trim() || selectedCalendar.name?.trim() || 'Cita',
        notes: selectedCalendar.notes?.trim() || '',
        eventColor: selectedCalendar.eventColor || '#3b82f6',
        isActive: selectedCalendar.isActive,
        slotDuration: selectedCalendar.slotDuration,
        slotDurationUnit: selectedCalendar.slotDurationUnit,
        slotInterval: selectedCalendar.slotInterval,
        slotIntervalUnit: selectedCalendar.slotIntervalUnit,
        preBuffer: selectedCalendar.preBuffer || 0,
        preBufferUnit: selectedCalendar.preBufferUnit || 'mins',
        slotBuffer: selectedCalendar.slotBuffer || 0,
        slotBufferUnit: selectedCalendar.slotBufferUnit || 'mins',
        allowBookingAfter: selectedCalendar.allowBookingAfter || 0,
        allowBookingAfterUnit: selectedCalendar.allowBookingAfterUnit || 'hours',
        allowBookingFor: selectedCalendar.allowBookingFor || 30,
        allowBookingForUnit: selectedCalendar.allowBookingForUnit || 'days',
        appoinmentPerSlot: selectedCalendar.appoinmentPerSlot,
        appoinmentPerDay: selectedCalendar.appoinmentPerDay,
        bookingForm,
        bookingCompletion,
        bookingDisplay,
        customEvents,
        antiTrackingEnabled: selectedCalendar.antiTrackingEnabled !== false
      }

      // Agregar lookBusyConfig si está configurado
      if (selectedCalendar.lookBusyConfig) {
        updateData.lookBusyConfig = {
          enabled: selectedCalendar.lookBusyConfig.enabled,
          LookBusyPercentage: selectedCalendar.lookBusyConfig.LookBusyPercentage
        }
      }

      // Agregar availabilityType si está configurado
      if (selectedCalendar.availabilityType !== undefined) {
        updateData.availabilityType = selectedCalendar.availabilityType
      }

      await calendarsService.updateCalendar(selectedCalendar.id, updateData, accessToken || undefined)

      if (googleSyncChanged) {
        await calendarsService.updateCalendarGoogleSync(selectedCalendar.id, nextGoogleCalendarId)
      }

      const syncMessage = googleSyncChanged
        ? nextGoogleCalendarId
          ? `Este calendario ya está ligado a ${googleCalendarOptions.find(option => option.id === nextGoogleCalendarId)?.summary || nextGoogleCalendarId}.`
          : 'Este calendario dejó de sincronizarse con Google Calendar.'
        : accessToken
          ? `Los cambios se guardaron en ${selectedCalendar.name}`
          : 'Los cambios quedaron guardados en Ristak y pendientes de sync'
      showToast('success', 'Configuración de calendario actualizada', syncMessage)
      handleCloseCalendarEditor()
      loadCalendars() // Recargar calendarios para ver cambios
    } catch (error: any) {
      showToast('error', 'Error al actualizar calendario', error.message)
    } finally {
      setSavingConfig(false)
      setSavingGoogleSyncCalendarId(null)
    }
  }

  const handleCreateCalendar = async () => {
    if (!newCalendar.name?.trim()) {
      showToast('error', 'Nombre requerido', 'Escribe un nombre para el calendario')
      return
    }

    setCreatingCalendar(true)
    try {
      const created = await calendarsService.createCalendar({
        ...newCalendar,
        name: newCalendar.name.trim(),
        eventTitle: newCalendar.eventTitle || newCalendar.name.trim(),
        notes: newCalendar.notes || ''
      }, accessToken || undefined)

      showToast(
        'success',
        'Calendario creado',
        accessToken
          ? 'Se guardó en Ristak y se intentó sincronizar con HighLevel'
          : 'Se guardó en Ristak y se sincronizará cuando conectes HighLevel'
      )

      if (created?.id && !defaultCalendarId) {
        await setDefaultCalendarId(created.id)
      }

      setShowCreateModal(false)
      if (created?.id) {
        navigate(buildCalendarSettingsPath('calendars', created.id), { replace: true })
      }
      setNewCalendar({
        name: '',
        calendarType: 'event',
        eventTitle: 'Cita',
        notes: '',
        eventColor: '#3b82f6',
        isActive: true,
        slotDuration: 60,
        slotDurationUnit: 'mins',
        slotInterval: 60,
        slotIntervalUnit: 'mins',
        appoinmentPerSlot: 1,
        appoinmentPerDay: 0,
        allowBookingAfter: 0,
        allowBookingAfterUnit: 'hours',
        allowBookingFor: 30,
        allowBookingForUnit: 'days',
        bookingForm: createDefaultCalendarBookingForm(),
        bookingCompletion: createDefaultCalendarBookingCompletion(),
        bookingDisplay: createDefaultCalendarBookingDisplay(),
        customEvents: createDefaultCalendarCustomEvents(),
        antiTrackingEnabled: true
      })
      await loadCalendars()
    } catch (error: any) {
      showToast('error', 'Error al crear calendario', error.message || 'Intenta nuevamente')
    } finally {
      setCreatingCalendar(false)
    }
  }

  const handleCopyPublicUrl = async (calendar: CalendarType) => {
    if (!calendar.publicUrl) {
      showToast('warning', 'URL no disponible', calendar.publicUrlUnavailableReason || 'Conecta y verifica el dominio público general primero')
      return
    }

    try {
      await navigator.clipboard.writeText(calendar.publicUrl)
      showToast('success', 'URL copiada', calendar.publicUrl)
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia la URL manualmente')
    }
  }

  const handleDeleteCalendar = (calendar: CalendarType) => {
    const isExternalCalendar = calendar.source === 'google' || calendar.source === 'ghl'

    showConfirm(
      'Eliminar calendario',
      isExternalCalendar
        ? `${calendar.name} viene de ${calendar.source === 'google' ? 'Google Calendar' : 'HighLevel'}. Para quitarlo de verdad hay que desconectarlo o quitarlo desde el origen; Ristak no lo va a borrar porque se volveria a sincronizar.`
        : `Se eliminará ${calendar.name} y sus citas locales asociadas. Esta acción no se puede deshacer.`,
      () => {
        const deleteCalendar = async () => {
          if (isExternalCalendar) {
            showToast('warning', 'Calendario sincronizado', 'Elimínalo o desconéctalo desde el origen para que no vuelva a aparecer.')
            return
          }

          setDeletingCalendarId(calendar.id)
          try {
            await calendarsService.deleteCalendar(calendar.id, accessToken || undefined)

            if (defaultCalendarId === calendar.id) {
              const nextDefault = calendars.find(item => item.id !== calendar.id)?.id || ''
              await setDefaultCalendarId(nextDefault)
            }

            if (attributionCalendarIds.includes(calendar.id)) {
              await setAttributionCalendarIds(attributionCalendarIds.filter(id => id !== calendar.id))
            }

            if (expandedCalendarId === calendar.id) {
              handleCloseCalendarEditor()
            }

            await loadCalendars()
            showToast('success', 'Calendario eliminado', `${calendar.name} ya no aparece en Ristak`)
          } catch (error: any) {
            showToast('error', 'No se pudo eliminar', error.message || 'Intenta nuevamente')
          } finally {
            setDeletingCalendarId(null)
          }
        }

        void deleteCalendar()
      },
      isExternalCalendar ? 'Entendido' : 'Eliminar',
      'Cancelar',
      undefined,
      isExternalCalendar ? undefined : { typeToConfirm: 'ELIMINAR' }
    )
  }

  const renderCalendarColorPicker = (
    value: string | undefined,
    onChange: (nextColor: string) => void,
    compact = false,
    palette: ReadonlyArray<{ label: string; value: string }> = CALENDAR_COLOR_PALETTE
  ) => {
    const currentColor = normalizeCalendarColor(value)
    const inputValue = value || currentColor

    return (
      <div className={`${pageStyles.calendarColorPicker} ${compact ? pageStyles.calendarColorPickerCompact : ''}`}>
        <div className={pageStyles.calendarColorRow} data-ristak-unstyled>
          <span
            className={pageStyles.calendarColorPreview}
            style={{ backgroundColor: currentColor }}
            aria-hidden="true"
          />
          <input
            className={pageStyles.calendarColorHex}
            value={inputValue}
            spellCheck={false}
            maxLength={7}
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => onChange(normalizeCalendarColor(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onChange(normalizeCalendarColor(event.currentTarget.value))
              }
            }}
            aria-label="Color del calendario en hexadecimal"
          />
        </div>

        <div className={pageStyles.calendarPalette} aria-label="Paleta de colores del calendario">
          {palette.map((color) => {
            const selected = currentColor === color.value
            return (
              <button
                key={color.value}
                type="button"
                className={`${pageStyles.calendarPaletteSwatch} ${selected ? pageStyles.calendarPaletteSwatchActive : ''}`}
                style={{ backgroundColor: color.value }}
                onClick={() => onChange(color.value)}
                aria-label={`Usar color ${color.label}`}
                aria-pressed={selected}
              />
            )
          })}
        </div>
      </div>
    )
  }

  const renderCalendarTemplateField = ({
    id,
    label,
    value,
    onChange,
    placeholder,
    help,
    multiline = false
  }: {
    id: string
    label: string
    value: string
    onChange: (nextValue: string) => void
    placeholder: string
    help: string
    multiline?: boolean
  }) => (
    <div className={`${pageStyles.editorField} ${pageStyles.calendarTemplateField}`}>
      <span id={`${id}-label`}>{label}</span>
      <FlowVariablesContext.Provider value={calendarTemplateVariableCatalog}>
        {multiline ? (
          <MessageComposer
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={label}
          />
        ) : (
          <VariableTextInput
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={label}
          />
        )}
      </FlowVariablesContext.Provider>
      <small>{help}</small>
    </div>
  )

  const renderCreateCalendarModal = () => showCreateModal ? createPortal(
    <Modal
      isOpen={showCreateModal}
      onClose={() => {
        setShowCreateModal(false)
        navigate(buildCalendarSettingsPath('calendars'), { replace: true })
      }}
      title="Crear calendario"
      size="md"
      flushContent
    >
      <div className={pageStyles.createCalendarForm} data-modal-panel="">
        <label className={pageStyles.editorField}>
          <span>Nombre del calendario</span>
          <input
            value={newCalendar.name || ''}
            onChange={(e) => setNewCalendar({ ...newCalendar, name: e.target.value, eventTitle: newCalendar.eventTitle || e.target.value })}
            placeholder="Ej. Consultas de ventas"
          />
        </label>

        {renderCalendarTemplateField({
          id: 'new-calendar-event-title',
          label: 'Título de la cita',
          value: newCalendar.eventTitle || '',
          onChange: (nextValue) => setNewCalendar({ ...newCalendar, eventTitle: nextValue }),
          placeholder: 'Ej. Cita con {{contact.full_name}}',
          help: 'Este texto será el título de cada cita nueva.'
        })}

        <div className={pageStyles.createTimingGrid}>
          <div className={styles.formField}>
            <label className={styles.label}>Cuánto dura la cita</label>
            <NumberInput
              className={styles.input}
              value={newCalendar.slotDuration || 60}
              min="1"
              onValueChange={(value) => setNewCalendar({ ...newCalendar, slotDuration: Math.trunc(value) || 60 })}
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.label}>Cada cuánto mostrar horarios</label>
            <NumberInput
              className={styles.input}
              value={newCalendar.slotInterval || 60}
              min="1"
              onValueChange={(value) => setNewCalendar({ ...newCalendar, slotInterval: Math.trunc(value) || 60 })}
            />
          </div>
        </div>

        <div className={styles.formField}>
          <label className={styles.label}>Color del calendario</label>
          {renderCalendarColorPicker(
            newCalendar.eventColor,
            (nextColor) => setNewCalendar({ ...newCalendar, eventColor: nextColor })
          )}
        </div>

        {renderCalendarTemplateField({
          id: 'new-calendar-notes',
          label: 'Notas',
          value: newCalendar.notes || '',
          onChange: (nextValue) => setNewCalendar({ ...newCalendar, notes: nextValue }),
          placeholder: 'Ej. Cliente: {{contact.full_name}}\nTeléfono: {{contact.phone}}\nNotas: {{appointment.notes}}',
          help: 'Estas notas se guardan como descripción de la cita cuando el calendario esté conectado.',
          multiline: true
        })}

        <div className={pageStyles.createActions}>
          <Button onClick={handleCreateCalendar} disabled={creatingCalendar}>
            {creatingCalendar ? (
              <>
                <Loader2 size={18} className={styles.spinIcon} />
                Creando...
              </>
            ) : (
              'Crear calendario'
            )}
          </Button>
          <Button variant="ghost" onClick={() => {
            setShowCreateModal(false)
            navigate(buildCalendarSettingsPath('calendars'), { replace: true })
          }} disabled={creatingCalendar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  ) : null

  const renderGoogleDefaultPromptModal = () => googleDefaultPromptCalendar ? createPortal(
    <Modal
      isOpen={Boolean(googleDefaultPromptCalendar)}
      onClose={handleCloseGoogleDefaultPromptModal}
      title="Calendario importado desde Google"
      size="md"
      showCloseButton={!savingGoogleDefaultPrompt}
      flushContent
    >
      <div className={pageStyles.defaultPromptModal} data-modal-panel="">
        <div className={pageStyles.defaultPromptIcon}>
          <Calendar size={24} />
        </div>
        <div className={pageStyles.defaultPromptBody}>
          <p className={pageStyles.defaultPromptEyebrow}>Google Calendar conectado</p>
          <h3>¿Quieres convertirlo en tu calendario personalizado y predeterminado de citas?</h3>
          <div className={pageStyles.defaultPromptCalendar}>
            <strong>{googleDefaultPromptCalendar.name}</strong>
            <span>{googleDefaultPromptCalendar.googleCalendarId || googleIntegration?.calendarId || 'Calendar ID pendiente'}</span>
          </div>
          <p>
            Si eliges que sí, Ristak lo pondrá como calendario personalizado predeterminado y también lo marcará como calendario de conversión.
            Si eliges que no, se queda conectado y puedes cambiarlo después desde la lista de calendarios.
          </p>
        </div>
        <div className={pageStyles.defaultPromptActions}>
          <Button
            onClick={handleAcceptGoogleDefaultPrompt}
            disabled={savingGoogleDefaultPrompt}
          >
            {savingGoogleDefaultPrompt ? (
              <>
                <Loader2 size={16} className={styles.spinIcon} />
                Guardando...
              </>
            ) : (
              <>
                <Star size={16} />
                Sí, convertirlo
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleDismissGoogleDefaultPrompt}
            disabled={savingGoogleDefaultPrompt}
          >
            No, dejarlo así
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  ) : null

  const renderGoogleMergePromptModal = () => googleMergePrompt ? createPortal(
    <Modal
      isOpen={Boolean(googleMergePrompt)}
      onClose={handleCloseGoogleMergePromptModal}
      title="Combinar calendarios"
      size="md"
      showCloseButton={!savingGoogleMergePrompt}
      flushContent
    >
      <div className={pageStyles.defaultPromptModal} data-modal-panel="">
        <div className={pageStyles.defaultPromptIcon}>
          <RefreshCw size={24} />
        </div>
        <div className={pageStyles.defaultPromptBody}>
          <p className={pageStyles.defaultPromptEyebrow}>Citas existentes en Ristak</p>
          <h3>¿Quieres combinar las citas actuales con el Google Calendar conectado?</h3>
          <div className={pageStyles.mergeCalendarStack}>
            <div className={pageStyles.defaultPromptCalendar}>
              <strong>
                {googleMergePrompt.sourceCalendars.map((calendar) => calendar.name).join(', ') || 'Calendario Ristak'}
              </strong>
              <span>{googleMergePrompt.totalAppointments} cita{googleMergePrompt.totalAppointments === 1 ? '' : 's'} existente{googleMergePrompt.totalAppointments === 1 ? '' : 's'}</span>
            </div>
            <div className={pageStyles.mergeArrow}>se combinará con</div>
            <div className={pageStyles.defaultPromptCalendar}>
              <strong>{googleMergePrompt.googleCalendar?.name || 'Google Calendar'}</strong>
              <span>{googleMergePrompt.googleCalendar?.googleCalendarId || googleIntegration?.calendarId || 'Calendar ID conectado'}</span>
            </div>
          </div>
          <p>
            Ejemplo: las citas de Calendario Ristak se moverán al calendario de Google conectado.
            Desde ese momento todo queda en un mismo calendario y las nuevas citas se crearán en Google Calendar.
          </p>
          <p>
            Si eliges que no, Calendario Ristak y Google Calendar se quedan separados.
          </p>
        </div>
        <div className={pageStyles.defaultPromptActions}>
          <Button
            onClick={handleAcceptGoogleMergePrompt}
            disabled={savingGoogleMergePrompt}
          >
            {savingGoogleMergePrompt ? (
              <>
                <Loader2 size={16} className={styles.spinIcon} />
                Combinando...
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                Sí, combinar
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleDismissGoogleMergePrompt}
            disabled={savingGoogleMergePrompt}
          >
            No, mantener separados
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  ) : null

  const handleCalendarSourcePreferenceChange = async (value: string) => {
    const nextValue = value as CalendarSourcePreference
    await setCalendarSourcePreference(nextValue)
    showToast(
      'success',
      'Origen guardado',
      nextValue === 'combined'
        ? 'Todos los calendarios se mostrarán juntos'
        : nextValue === 'ristak'
          ? 'Solo se mostrarán calendarios de Ristak'
          : 'Solo se mostrarán calendarios de HighLevel'
    )
    await loadCalendars()
  }

  const renderCalendarSourceSelect = () => {
    const showSourceSelector = highLevelConnected
    if (!showSourceSelector) return null

    const options = [
      { value: 'combined', label: 'Todos' },
      { value: 'ristak', label: 'Solo Ristak' },
      ...(highLevelConnected ? [{ value: 'ghl', label: 'Solo HighLevel' }] : [])
    ]

    return (
      <div className={pageStyles.sourceControl}>
        <SlidersHorizontal size={16} />
        <span className={pageStyles.sourceLabel}>Origen</span>
        <CustomSelect
          className={pageStyles.sourceDropdown}
          aria-label="Elegir origen de calendarios"
          value={calendarSourcePreference}
          onChange={(event) => void handleCalendarSourcePreferenceChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </CustomSelect>
      </div>
    )
  }

  const renderCalendarSourceBadge = (calendar: CalendarType) => (
    <span className={pageStyles.metaPill}>
      {calendar.source === 'ghl' ? 'HighLevel' : calendar.source === 'google' ? 'Google' : 'Ristak'}
    </span>
  )

  const renderCalendarInlineEditor = (calendar: CalendarType) => {
    if (expandedCalendarId !== calendar.id || !selectedCalendar || selectedCalendar.id !== calendar.id) {
      return null
    }

    const updateSelectedCalendar = (patch: Partial<CalendarType>) => {
      setSelectedCalendar({ ...selectedCalendar, ...patch })
    }

    const customFormSites = formSites.filter(site => site.id !== CALENDAR_DEFAULT_FORM_SITE_ID)
    const bookingFormConfig = normalizeCalendarBookingForm(selectedCalendar.bookingForm)
    const bookingCompletionConfig = normalizeCalendarBookingCompletion(selectedCalendar.bookingCompletion)
    const bookingDisplayConfig = normalizeCalendarBookingDisplay(selectedCalendar.bookingDisplay, selectedCalendar.eventColor)
    const customEventsConfig = normalizeCalendarCustomEvents(selectedCalendar.customEvents)
    const customEventsHasParameters = hasCalendarCustomEventParameters(customEventsConfig.parameters)
    const selectedCalendarAttributed = attributionCalendarIds.includes(selectedCalendar.id)
    const selectedCustomForm = customFormSites.find(site => site.id === bookingFormConfig.customFormId)
    const calendarFormOptions = customFormSites.map(site => ({
      value: site.id,
      label: `${site.name || site.title || 'Formulario'}${site.siteType === 'interactive_form' ? ' · multistep' : ''}`
    }))
    const selectedPublicPath = getCalendarSharePath(selectedCalendar)
    const selectedPublicUrl = buildCalendarShareUrl(selectedCalendar)
    const selectedPublicOpenUrl = buildCalendarOpenUrl(selectedCalendar)
    const currentStepIndex = CALENDAR_WIZARD_STEPS.findIndex(step => step.id === calendarWizardStep)
    const safeStepIndex = currentStepIndex >= 0 ? currentStepIndex : 0
    const currentStep = CALENDAR_WIZARD_STEPS[safeStepIndex]

    if (bookingFormConfig.customFormId && !selectedCustomForm) {
      calendarFormOptions.push({
        value: bookingFormConfig.customFormId,
        label: `Formulario guardado (${bookingFormConfig.customFormId})`
      })
    }

    const updateBookingFormConfig = (nextConfig: CalendarBookingFormConfig) => {
      updateSelectedCalendar({ bookingForm: normalizeCalendarBookingForm(nextConfig) })
    }

    const updateBookingCompletionConfig = (nextConfig: Partial<CalendarBookingCompletionConfig>) => {
      updateSelectedCalendar({
        bookingCompletion: normalizeCalendarBookingCompletion({
          ...bookingCompletionConfig,
          ...nextConfig
        })
      })
    }

    const updateBookingDisplayConfig = (nextConfig: Partial<CalendarBookingDisplayConfig>) => {
      updateSelectedCalendar({
        bookingDisplay: normalizeCalendarBookingDisplay({
          ...bookingDisplayConfig,
          ...nextConfig
        }, selectedCalendar.eventColor)
      })
    }

    const updateBookingDisplayColors = (nextColors: Partial<CalendarBookingDisplayColors>) => {
      updateBookingDisplayConfig({
        colors: {
          ...bookingDisplayConfig.colors,
          ...nextColors
        }
      })
    }

    const updateCustomEventsConfig = (nextConfig: Partial<CalendarCustomEventsConfig>) => {
      const channel = nextConfig.channel || customEventsConfig.channel
      updateSelectedCalendar({
        customEvents: normalizeCalendarCustomEvents({
          ...customEventsConfig,
          ...nextConfig,
          eventName: channel === 'whatsapp'
            ? CALENDAR_DEFAULT_WHATSAPP_EVENT_NAME
            : nextConfig.eventName || customEventsConfig.eventName || CALENDAR_DEFAULT_META_EVENT_NAME
        })
      })
    }

    const updateCustomEventParameters = (patch: Partial<CalendarCustomEventParameters>) => {
      updateCustomEventsConfig({
        parameters: normalizeCalendarCustomEventParameters({
          ...customEventsConfig.parameters,
          ...patch
        })
      })
    }

    const updateCustomEventParameterRow = (parameterId: string, patch: Partial<CalendarCustomEventParameter>) => {
      const custom = (customEventsConfig.parameters.custom || []).map(parameter => (
        parameter.id === parameterId ? { ...parameter, ...patch } : parameter
      ))
      updateCustomEventParameters({ custom })
    }

    const addCustomEventParameterRow = () => {
      setCalendarMetaParamsOpen(true)
      updateCustomEventParameters({
        custom: [...(customEventsConfig.parameters.custom || []), createCalendarCustomEventParameter()]
      })
    }

    const removeCustomEventParameterRow = (parameterId: string) => {
      updateCustomEventParameters({
        custom: (customEventsConfig.parameters.custom || []).filter(parameter => parameter.id !== parameterId)
      })
    }

    const goToRelativeStep = (offset: number) => {
      const nextIndex = Math.min(CALENDAR_WIZARD_STEPS.length - 1, Math.max(0, safeStepIndex + offset))
      setCalendarWizardStep(CALENDAR_WIZARD_STEPS[nextIndex].id)
    }

    const handleCustomBookingFormToggle = (enabled: boolean) => {
      if (enabled && !customFormSites.length) {
        showToast(
          'warning',
          'No hay formularios personalizados',
          loadingFormSites
            ? 'Ristak sigue cargando formularios; intenta otra vez en un momento.'
            : 'Crea un formulario en Sitios/Formularios y luego selecciónalo aquí.'
        )
        return
      }

      updateBookingFormConfig({
        ...bookingFormConfig,
        useCustomForm: enabled,
        customFormId: enabled ? bookingFormConfig.customFormId || customFormSites[0]?.id || '' : ''
      })
    }

    const handleDefaultBookingFieldToggle = (field: 'phone' | 'email' | 'notes', enabled: boolean) => {
      if ((field === 'phone' || field === 'email') && !enabled) {
        const otherField = field === 'phone' ? 'email' : 'phone'
        if (!bookingFormConfig.defaultFields[otherField].enabled) {
          showToast(
            'warning',
            'Falta un dato de contacto',
            'Deja teléfono o correo activo para que la cita se pueda confirmar.'
          )
          return
        }
      }

      updateBookingFormConfig({
        ...bookingFormConfig,
        defaultFields: {
          ...bookingFormConfig.defaultFields,
          [field]: {
            enabled,
            required: field === 'notes' ? false : enabled
          }
        }
      })
    }

    const showGoogleSyncSettings = Boolean(googleIntegration?.connected && calendar.source !== 'google')
    const currentGoogleCalendarId = selectedCalendar.googleCalendarId || ''
    const currentGoogleOption = googleCalendarOptions.find((option) => option.id === currentGoogleCalendarId)
    const googleAccountLabel = googleIntegration?.googleAccountEmail || googleIntegration?.googleAccountName || 'Cuenta Google conectada'
    const googleSyncBlocked = !googleIntegration?.canListCalendars || !googleIntegration?.canManageEvents
    const writableGoogleCalendarCount = googleCalendarOptions.filter(canWriteGoogleCalendarOption).length
    const googleSyncOptions = [
      ...googleCalendarOptions.map((option) => ({
        value: option.id,
        label: `${option.summary || option.id}${option.primary ? ' (principal)' : ''}${canWriteGoogleCalendarOption(option) ? '' : ' (solo lectura)'}`,
        disabled: !canWriteGoogleCalendarOption(option)
      }))
    ]

    if (currentGoogleCalendarId && !currentGoogleOption) {
      googleSyncOptions.push({
        value: currentGoogleCalendarId,
        label: selectedCalendar.googleCalendarSummary || `${currentGoogleCalendarId} (sin acceso actual)`,
        disabled: false
      })
    }

    const clearGoogleCalendarSync = () => {
      showConfirm(
        'Dejar de sincronizar Google Calendar',
        'Este calendario de Ristak se quedará local. Las citas ya guardadas no se borran, pero ya no se actualizarán con Google.',
        () => updateSelectedCalendar({ googleCalendarId: '' }),
        'Dejar de sincronizar',
        'Cancelar'
      )
    }

    const handlePreviewTimezoneChange = (timezone: string) => {
      const nextTimezone = normalizeCalendarTimezoneValue(timezone)
      setCalendarPreviewTimezone(nextTimezone || detectCalendarPreviewTimezone())
    }

    const handleBookingDisplayTimezoneChange = (timezone: string) => {
      const nextTimezone = normalizeCalendarTimezoneValue(timezone)
      setCalendarPreviewTimezone(nextTimezone || detectCalendarPreviewTimezone())
      updateBookingDisplayConfig({ defaultTimezone: nextTimezone })
    }

    const handlePreviewDayClick = (day: number) => {
      if (!CALENDAR_PREVIEW_AVAILABLE_DAYS.has(day)) return
      setCalendarPreviewDate(day)
      setCalendarPreviewStep('time')
    }

    const handlePreviewSlotClick = (slot: string) => {
      setCalendarPreviewSlot(slot)
      setCalendarPreviewStep('details')
    }

    const resetCalendarPreview = () => {
      setCalendarPreviewStep('date')
      setCalendarPreviewDate(CALENDAR_PREVIEW_DEFAULT_DAY)
      setCalendarPreviewSlot(CALENDAR_PREVIEW_SLOTS[1].value)
      setCalendarPreviewTimezone(bookingDisplayConfig.defaultTimezone || detectCalendarPreviewTimezone())
    }

    const openCalendarWidget = () => {
      if (!selectedPublicOpenUrl) return
      window.open(selectedPublicOpenUrl, '_blank', 'noopener,noreferrer')
    }

    const previewTimezone = bookingDisplayConfig.defaultTimezone || calendarPreviewTimezone || detectCalendarPreviewTimezone()
    const previewSlotLabel = CALENDAR_PREVIEW_SLOTS.find(slot => slot.value === calendarPreviewSlot)?.label || CALENDAR_PREVIEW_SLOTS[1].label
    const previewDuration = Math.max(1, Number(selectedCalendar.slotDuration || 60))
    const previewCalendarName = selectedCalendar.name || 'Mi calendario'
    const previewEventTitle = selectedCalendar.eventTitle || 'Cita'
    const previewDescription = selectedCalendar.description || 'Calendario principal creado en Ristak'
    const previewStyle = {
      '--calendar-preview-accent': bookingDisplayConfig.colors.accent,
      '--calendar-preview-bg': bookingDisplayConfig.colors.background,
      '--calendar-preview-surface': bookingDisplayConfig.colors.surface,
      '--calendar-preview-text': bookingDisplayConfig.colors.text,
      '--calendar-preview-muted': bookingDisplayConfig.colors.muted,
      '--calendar-preview-line': bookingDisplayConfig.colors.line,
      '--calendar-preview-control-bg': bookingDisplayConfig.colors.controlBg,
      '--calendar-preview-slot-bg': bookingDisplayConfig.colors.slotBg,
      '--calendar-preview-slot-text': bookingDisplayConfig.colors.slotText,
      '--calendar-preview-selected-text': bookingDisplayConfig.colors.selectedText,
      '--calendar-preview-field-bg': bookingDisplayConfig.colors.fieldBg,
      '--calendar-preview-field-text': bookingDisplayConfig.colors.fieldText,
      '--calendar-preview-field-border': bookingDisplayConfig.colors.fieldBorder,
      '--calendar-preview-button-text': bookingDisplayConfig.colors.buttonText,
      '--calendar-preview-font': CALENDAR_PREVIEW_FONT_STACKS[bookingDisplayConfig.fontFamily]
    } as React.CSSProperties

    const renderCalendarBookingPreview = () => (
      <div className={pageStyles.bookingPreviewPanel}>
        <div className={pageStyles.bookingPreviewHeader}>
          <div>
            <strong>Preview del calendario</strong>
            <span>{calendarPreviewStep === 'details' ? `Formulario · ${previewSlotLabel}` : calendarPreviewStep === 'time' ? `Horarios · junio ${calendarPreviewDate}` : 'Vista inicial'}</span>
          </div>
          <div className={pageStyles.bookingPreviewActions}>
            <Button
              variant="ghost"
              size="small"
              onClick={resetCalendarPreview}
            >
              <RefreshCw size={14} />
              Reiniciar
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={openCalendarWidget}
              disabled={!selectedPublicOpenUrl}
            >
              <Globe2 size={14} />
              Abrir widget
            </Button>
          </div>
        </div>

        <div
          className={pageStyles.bookingPreviewFrame}
          style={previewStyle}
          data-layout={bookingDisplayConfig.layout}
          data-sidebar={bookingDisplayConfig.showSidebar ? 'visible' : 'hidden'}
          data-stage={calendarPreviewStep}
        >
          {bookingDisplayConfig.showSidebar && (
            <aside className={pageStyles.bookingPreviewIntro}>
              {bookingDisplayConfig.showIcon && (
                <div className={pageStyles.bookingPreviewAvatar}>
                  {(previewCalendarName.trim()[0] || 'R').toUpperCase()}
                </div>
              )}
              {bookingDisplayConfig.showEventTitle && <span>{previewEventTitle}</span>}
              {bookingDisplayConfig.showCalendarName && <h4>{previewCalendarName}</h4>}
              {bookingDisplayConfig.showDescription && <p>{previewDescription}</p>}
              {(bookingDisplayConfig.showDuration || bookingDisplayConfig.showConfirmation) && (
                <div className={pageStyles.bookingPreviewMeta}>
                  {bookingDisplayConfig.showDuration && (
                    <small>
                      <Calendar size={14} />
                      {previewDuration} min
                    </small>
                  )}
                  {bookingDisplayConfig.showConfirmation && (
                    <small>
                      <CheckCircle size={14} />
                      Confirmación {selectedCalendar.autoConfirm ? 'automática' : 'pendiente'}
                    </small>
                  )}
                </div>
              )}
            </aside>
          )}

          {calendarPreviewStep !== 'details' && (
            <section className={pageStyles.bookingPreviewCalendar}>
              <div className={pageStyles.bookingPreviewPaneTitle}>
                <div>
                  <strong>Selecciona fecha</strong>
                  <span>Elige un día disponible para continuar.</span>
                </div>
              </div>
              <div className={pageStyles.bookingPreviewMonth}>
                <button type="button" aria-label="Mes anterior">‹</button>
                <strong>junio 2026</strong>
                <button type="button" aria-label="Mes siguiente">›</button>
              </div>
              <div className={pageStyles.bookingPreviewWeekdays}>
                {['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'].map(day => <span key={day}>{day}</span>)}
              </div>
              <div className={pageStyles.bookingPreviewDays}>
                {CALENDAR_PREVIEW_DAYS.map(day => {
                  const available = CALENDAR_PREVIEW_AVAILABLE_DAYS.has(day)
                  const selected = calendarPreviewDate === day
                  return (
                    <button
                      type="button"
                      key={day}
                      className={`${available ? pageStyles.bookingPreviewDayAvailable : ''} ${selected ? pageStyles.bookingPreviewDaySelected : ''}`}
                      onClick={() => handlePreviewDayClick(day)}
                      disabled={!available}
                      aria-pressed={selected}
                    >
                      {day}
                    </button>
                  )
                })}
              </div>
              <div className={pageStyles.bookingPreviewTimezone}>
                <Globe2 size={15} />
                <div>
                  <span>Zona horaria</span>
                  {bookingDisplayConfig.allowTimezoneSelection ? (
                    <select
                      value={previewTimezone}
                      onChange={(event) => handlePreviewTimezoneChange(event.target.value)}
                      aria-label="Zona horaria del preview"
                    >
                      {Array.from(new Set([previewTimezone, ...CALENDAR_PREVIEW_TIMEZONE_OPTIONS])).map(timezone => (
                        <option value={timezone} key={timezone}>{timezone}</option>
                      ))}
                    </select>
                  ) : (
                    <strong>{previewTimezone}</strong>
                  )}
                </div>
              </div>
            </section>
          )}

          {calendarPreviewStep === 'time' && (
            <section className={pageStyles.bookingPreviewTimes}>
              <div>
                <strong>junio {calendarPreviewDate}</strong>
                <span>Horarios disponibles</span>
              </div>
              <div className={pageStyles.bookingPreviewSlotList}>
                {CALENDAR_PREVIEW_SLOTS.map(slot => (
                  <button
                    type="button"
                    key={slot.value}
                    className={calendarPreviewSlot === slot.value ? pageStyles.bookingPreviewSlotSelected : ''}
                    onClick={() => handlePreviewSlotClick(slot.value)}
                    aria-pressed={calendarPreviewSlot === slot.value}
                  >
                    {slot.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {calendarPreviewStep === 'details' && (
            <section className={pageStyles.bookingPreviewForm}>
              <div>
                <strong>Tus datos</strong>
                <span>{previewSlotLabel} · {previewTimezone}</span>
              </div>
              <label>
                <span>Nombre</span>
                <input value="Claudia Ruiz" readOnly />
              </label>
              <label>
                <span>Teléfono</span>
                <input value="+52 656 000 0000" readOnly />
              </label>
              <button type="button">
                Agendar cita
              </button>
              <button
                type="button"
                className={pageStyles.bookingPreviewSecondaryAction}
                onClick={() => setCalendarPreviewStep('time')}
              >
                Cambiar horario
              </button>
            </section>
          )}
        </div>
      </div>
    )

    return (
      <Modal
        isOpen={expandedCalendarId === calendar.id}
        onClose={handleCloseCalendarEditor}
        title={`Editar ${selectedCalendar.name || calendar.name || 'calendario'}`}
        size="xl"
        flushContent
        className={pageStyles.calendarWizardModal}
      >
        <div className={pageStyles.calendarWizardShell}>
          <aside className={pageStyles.calendarWizardSteps} aria-label="Pasos de configuración">
            {CALENDAR_WIZARD_STEPS.map((step, index) => (
              <button
                key={step.id}
                type="button"
                className={`${pageStyles.calendarWizardStep} ${currentStep.id === step.id ? pageStyles.calendarWizardStepActive : ''}`}
                onClick={() => setCalendarWizardStep(step.id)}
                aria-current={currentStep.id === step.id ? 'step' : undefined}
              >
                <span>{index + 1}</span>
                <strong>{step.label}</strong>
                <small>{step.description}</small>
              </button>
            ))}
          </aside>

          <div className={pageStyles.calendarWizardMain}>
            <div className={pageStyles.calendarWizardTopbar}>
              <div>
                <span>Paso {safeStepIndex + 1} de {CALENDAR_WIZARD_STEPS.length}</span>
                <h3>{currentStep.label}</h3>
              </div>
              <Button
                variant="ghost"
                size="small"
                onClick={handleCloseCalendarEditor}
                disabled={savingConfig}
              >
                Cancelar
              </Button>
            </div>

            <div className={pageStyles.calendarWizardBody}>
              {currentStep.id === 'basics' && (
                <>
                  <section className={pageStyles.editorSection}>
                    <div className={pageStyles.editorSectionHeader}>
                      <strong>Lo básico</strong>
                      <span>Cómo se llama el calendario y cómo se registran sus citas.</span>
                    </div>
                    <div className={pageStyles.editorFields}>
                      <label className={pageStyles.editorField}>
                        <span>Nombre del calendario</span>
                        <input
                          value={selectedCalendar.name || ''}
                          onChange={(event) => updateSelectedCalendar({ name: event.target.value })}
                        />
                      </label>

                      {renderCalendarTemplateField({
                        id: `calendar-event-title-${calendar.id}`,
                        label: 'Título de la cita',
                        value: selectedCalendar.eventTitle || '',
                        onChange: (nextValue) => updateSelectedCalendar({ eventTitle: nextValue }),
                        placeholder: 'Ej. Cita con {{contact.full_name}}',
                        help: 'Este texto será el título de cada cita nueva. Puedes meter parámetros.'
                      })}

                      <div className={pageStyles.editorField}>
                        <span>Conversión</span>
                        <div className={styles.toggleContainer}>
                          <button
                            type="button"
                            className={`${styles.toggle} ${selectedCalendarAttributed ? styles.toggleActive : ''}`}
                            onClick={() => handleAttributionToggle(selectedCalendar.id)}
                            aria-pressed={selectedCalendarAttributed}
                            aria-label={selectedCalendarAttributed ? 'Quitar calendario de conversión' : 'Marcar calendario como conversión'}
                          >
                            <span className={styles.toggleThumb} />
                          </button>
                          <span className={`${styles.toggleLabel} ${selectedCalendarAttributed ? styles.toggleLabelActive : ''}`}>
                            {selectedCalendarAttributed ? 'Cuenta como conversión' : 'No cuenta como conversión'}
                          </span>
                        </div>
                        <small>
                          Enciéndelo para que las citas de este calendario alimenten reportes, campañas y eventos de Meta/WhatsApp. Si no marcas ninguno, Ristak toma todos los calendarios.
                        </small>
                      </div>
                    </div>
                  </section>

                  <section className={pageStyles.editorSection}>
                    <div className={pageStyles.editorSectionHeader}>
                      <strong>Agenda y zona horaria</strong>
                      <span>Define cómo se interpretan los horarios y la confirmación antes de mostrar el calendario público.</span>
                    </div>
                    <div className={pageStyles.editorFields}>
                      <label className={pageStyles.editorField}>
                        <span>Zona horaria base</span>
                        <CustomSelect
                          value={bookingDisplayConfig.defaultTimezone}
                          onValueChange={handleBookingDisplayTimezoneChange}
                          options={[
                            { value: '', label: 'Detectar automáticamente' },
                            ...CALENDAR_TIMEZONE_OPTIONS
                          ]}
                          dropdownMinHeight={320}
                        />
                        <small>Si la dejas automática, el calendario abre con la zona horaria detectada del visitante.</small>
                      </label>

                      <div className={pageStyles.editorField}>
                        <span>Zona horaria del visitante</span>
                        <div className={pageStyles.displaySwitchRow}>
                          <div>
                            <strong>Permitir cambio</strong>
                            <small>La persona que agenda podrá cambiar su zona antes de elegir horario.</small>
                          </div>
                          <Switch
                            checked={bookingDisplayConfig.allowTimezoneSelection}
                            onChange={(allowTimezoneSelection) => updateBookingDisplayConfig({ allowTimezoneSelection })}
                            aria-label="Permitir cambio de zona horaria"
                          />
                        </div>
                      </div>

                      <div className={pageStyles.editorField}>
                        <span>Confirmación de la cita</span>
                        <div className={pageStyles.displaySwitchRow}>
                          <div>
                            <strong>Mostrar confirmación</strong>
                            <small>Muestra si la cita queda automática o pendiente en la vista pública.</small>
                          </div>
                          <Switch
                            checked={bookingDisplayConfig.showConfirmation}
                            onChange={(showConfirmation) => updateBookingDisplayConfig({ showConfirmation })}
                            aria-label="Mostrar confirmación de la cita"
                          />
                        </div>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {currentStep.id === 'publicUrl' && (
                <section className={pageStyles.editorSection}>
                  <div className={pageStyles.editorSectionHeader}>
                    <strong>Enlace público del calendario</strong>
                    <span>Cada calendario tiene su propia URL para que cualquier persona pueda agendar.</span>
                  </div>
                  <div className={pageStyles.editorFields}>
                    <label className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                      <span>URL para compartir</span>
                      <div className={pageStyles.publicUrlControl}>
                        <input
                          className={styles.input}
                          value={selectedPublicUrl || selectedPublicPath}
                          readOnly
                        />
                        <Button
                          variant="secondary"
                          onClick={() => void handleCopyPublicUrl({
                            ...selectedCalendar,
                            publicUrl: selectedPublicUrl
                          })}
                          disabled={!selectedPublicUrl}
                        >
                          <Copy size={15} />
                          Copiar
                        </Button>
                        {selectedPublicUrl && (
                          <Button
                            variant="ghost"
                            onClick={() => window.open(selectedPublicOpenUrl, '_blank', 'noopener,noreferrer')}
                          >
                            <Globe2 size={15} />
                            Abrir
                          </Button>
                        )}
                      </div>
                      <small>
                        {selectedCalendar.publicUrlEnabled
                          ? 'Este enlace ya puede recibir reservas públicas.'
                          : selectedCalendar.publicUrlUnavailableReason || 'Conecta y verifica el dominio público de Sitios para activar el enlace completo.'}
                      </small>
                    </label>

                    <label className={pageStyles.editorField}>
                      <span>Ruta personalizada</span>
                      <PathInput
                        prefix="/calendar/"
                        value={selectedCalendar.slug || selectedCalendar.widgetSlug || ''}
                        aria-label="Ruta personalizada del calendario"
                        placeholder="consulta-ventas"
                        onChange={(value) => {
                          const slug = normalizeCalendarSlugInput(value)
                          updateSelectedCalendar({ slug, widgetSlug: slug })
                        }}
                      />
                      <small>Usa letras, números y guiones. Al guardar se valida que no choque con otro calendario.</small>
                    </label>

                    <div className={`${pageStyles.eventSwitchRow} ${pageStyles.editorFieldWide}`}>
                      <div>
                        <span>Antitracking</span>
                        <small>
                          Esto evita que el visitar tu propia página se cuente como un visitante real.
                        </small>
                      </div>
                      <Switch
                        checked={selectedCalendar.antiTrackingEnabled !== false}
                        onChange={(enabled) => updateSelectedCalendar({ antiTrackingEnabled: enabled })}
                        aria-label="Activar antitracking del calendario"
                      />
                    </div>

                    <div className={pageStyles.googleSyncHint}>
                      <Link2 size={16} />
                      <span>
                        La ruta pública usa el calendario específico, su disponibilidad, su formulario y la acción de confirmación configurada en este wizard.
                      </span>
                    </div>
                  </div>
                </section>
              )}

              {currentStep.id === 'availability' && (
                <>
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Tiempos de cita</strong>
              <span>Cuánto dura cada cita y cada cuánto se muestran horarios.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Cuánto dura la cita</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.slotDuration}
                    onValueChange={(value) => updateSelectedCalendar({ slotDuration: Math.trunc(value) || 0 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotDurationUnit}
                    onValueChange={(value) => updateSelectedCalendar({ slotDurationUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Cada cuánto mostrar horarios</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.slotInterval}
                    onValueChange={(value) => updateSelectedCalendar({ slotInterval: Math.trunc(value) || 0 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotIntervalUnit}
                    onValueChange={(value) => updateSelectedCalendar({ slotIntervalUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Qué horarios usar</span>
                <CustomSelect
                  value={selectedCalendar.availabilityType !== undefined ? String(selectedCalendar.availabilityType) : ''}
                  onValueChange={(value) => updateSelectedCalendar({
                    availabilityType: value === '' ? undefined : parseInt(value, 10)
                  })}
                  options={[
                    { value: '', label: 'Horarios abiertos y horarios especiales' },
                    { value: '0', label: 'Solo horarios abiertos' },
                    { value: '1', label: 'Solo horarios especiales' }
                  ]}
                />
              </label>
            </div>
          </section>
                </>
              )}

              {currentStep.id === 'rules' && (
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Reglas para agendar</strong>
              <span>Cuánto antes pueden agendar y cuántas citas permites.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Tiempo mínimo antes de la cita</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.allowBookingAfter || 0}
                    onValueChange={(value) => updateSelectedCalendar({ allowBookingAfter: Math.trunc(value) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingAfterUnit || 'hours'}
                    onValueChange={(value) => updateSelectedCalendar({ allowBookingAfterUnit: value })}
                    options={[
                      { value: 'hours', label: 'Horas' },
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Hasta cuándo se puede agendar</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.allowBookingFor || 30}
                    onValueChange={(value) => updateSelectedCalendar({ allowBookingFor: Math.trunc(value) || 1 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingForUnit || 'days'}
                    onValueChange={(value) => updateSelectedCalendar({ allowBookingForUnit: value })}
                    options={[
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Citas por horario</span>
                <NumberInput
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerSlot}
                  onValueChange={(value) => updateSelectedCalendar({ appoinmentPerSlot: Math.trunc(value) || 1 })}
                  min="1"
                />
              </label>

              <label className={pageStyles.editorField}>
                <span>Máximo de citas por día</span>
                <NumberInput
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerDay}
                  onValueChange={(value) => updateSelectedCalendar({ appoinmentPerDay: Math.trunc(value) || 0 })}
                  min="0"
                />
              </label>
            </div>
          </section>
              )}

              {currentStep.id === 'form' && (
                <>
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Formulario para agendar</strong>
              <span>Elige qué preguntas aparecen después de seleccionar fecha y hora.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <div className={pageStyles.editorField}>
                <span>Formulario personalizado</span>
                <div className={styles.toggleContainer}>
                  <button
                    type="button"
                    className={`${styles.toggle} ${bookingFormConfig.useCustomForm ? styles.toggleActive : ''}`}
                    onClick={() => handleCustomBookingFormToggle(!bookingFormConfig.useCustomForm)}
                    aria-pressed={bookingFormConfig.useCustomForm}
                    aria-label={bookingFormConfig.useCustomForm ? 'Usar formulario predeterminado' : 'Usar formulario personalizado'}
                  >
                    <span className={styles.toggleThumb} />
                  </button>
                  <span className={`${styles.toggleLabel} ${bookingFormConfig.useCustomForm ? styles.toggleLabelActive : ''}`}>
                    {bookingFormConfig.useCustomForm ? 'Sí, usar formulario' : 'No, usar predeterminado'}
                  </span>
                </div>
                <small>
                  Los formularios personalizados conservan preguntas y pasos, pero se ven con el diseño interno del calendario.
                </small>
              </div>

              {bookingFormConfig.useCustomForm ? (
                <>
                  <div className={pageStyles.editorField}>
                    <span>Formulario</span>
                    <CustomSelect
                      value={bookingFormConfig.customFormId}
                      onValueChange={(value) => updateBookingFormConfig({
                        ...bookingFormConfig,
                        useCustomForm: Boolean(value),
                        customFormId: value
                      })}
                      options={calendarFormOptions}
                      placeholder={loadingFormSites ? 'Cargando formularios...' : 'Elige un formulario'}
                      disabled={loadingFormSites || calendarFormOptions.length === 0}
                    />
                    <small>
                      {selectedCustomForm?.siteType === 'interactive_form'
                        ? 'Este formulario puede avanzar por pasos dentro del calendario.'
                        : selectedCustomForm
                          ? 'Este formulario se usará como preguntas de agenda.'
                          : 'Si no eliges uno, Ristak usará el formulario predeterminado.'}
                    </small>
                  </div>

                  <div className={pageStyles.googleSyncHint}>
                    <ListChecks size={16} />
                    <span>El estilo original del editor de formularios no se importa aquí; el calendario mantiene su propio diseño.</span>
                  </div>
                </>
              ) : (
                <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                  <span>Campos del formulario predeterminado</span>
                  <div className={pageStyles.lookBusyRow}>
                    <label>
                      <input type="checkbox" checked disabled />
                      Nombre completo obligatorio
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={bookingFormConfig.defaultFields.phone.enabled}
                        onChange={(event) => handleDefaultBookingFieldToggle('phone', event.target.checked)}
                      />
                      Teléfono / WhatsApp
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={bookingFormConfig.defaultFields.email.enabled}
                        onChange={(event) => handleDefaultBookingFieldToggle('email', event.target.checked)}
                      />
                      Correo electrónico
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={bookingFormConfig.defaultFields.notes.enabled}
                        onChange={(event) => handleDefaultBookingFieldToggle('notes', event.target.checked)}
                      />
                      Notas
                    </label>
                  </div>
                  <small>Nombre siempre es obligatorio. Teléfono o correo debe quedar activo para confirmar la cita.</small>
                </div>
              )}
            </div>
          </section>

          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Después de agendar</strong>
              <span>Define qué verá la persona cuando complete la cita desde la URL pública.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Acción final</span>
                <CustomSelect
                  value={bookingCompletionConfig.action}
                  onValueChange={(value) => updateBookingCompletionConfig({
                    action: value === 'redirect' ? 'redirect' : 'message'
                  })}
                  options={[
                    { value: 'message', label: 'Mostrar mensaje' },
                    { value: 'redirect', label: 'Redirigir a una página' }
                  ]}
                />
              </label>

              {bookingCompletionConfig.action === 'redirect' ? (
                <label className={pageStyles.editorField}>
                  <span>URL destino</span>
                  <input
                    className={styles.input}
                    value={bookingCompletionConfig.redirectUrl}
                    onChange={(event) => updateBookingCompletionConfig({ redirectUrl: event.target.value })}
                    placeholder="https://tudominio.com/gracias"
                  />
                  <small>También puedes usar una ruta interna como /gracias.</small>
                </label>
              ) : (
                <label className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                  <span>Mensaje de confirmación</span>
                  <textarea
                    className={styles.input}
                    value={bookingCompletionConfig.message}
                    onChange={(event) => updateBookingCompletionConfig({ message: event.target.value })}
                    placeholder="Listo. Tu cita quedó agendada."
                    rows={3}
                  />
                </label>
              )}
            </div>
          </section>
                </>
              )}

              {currentStep.id === 'reminders' && (
                <section className={pageStyles.editorSection}>
                  <div className={pageStyles.editorSectionHeader}>
                    <strong>Recordatorios automáticos</strong>
                    <span>Configura los mismos mensajes automáticos de la página de Citas desde este wizard.</span>
                  </div>
                  <div className={pageStyles.editorFields}>
                    <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                      <div className={pageStyles.remindersToolbar}>
                        <div>
                          <span>Mensajes activos para tus citas</span>
                          <small>Se usan plantillas aprobadas, remitentes y reglas de envío compartidas con Citas.</small>
                        </div>
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={handleAddAppointmentReminder}
                          disabled={creatingAppointmentReminder}
                        >
                          {creatingAppointmentReminder ? (
                            <Loader2 size={14} className={styles.spinIcon} />
                          ) : (
                            <Plus size={14} />
                          )}
                          Agregar
                        </Button>
                      </div>

                      {loadingAppointmentReminders ? (
                        <div className={pageStyles.remindersEmpty} role="status" aria-live="polite">
                          <Loader2 size={16} className={styles.spinIcon} />
                          Cargando mensajes automáticos...
                        </div>
                      ) : appointmentReminders.length ? (
                        <div className={pageStyles.remindersList}>
                          {appointmentReminders.map((reminder) => {
                            const ReminderIcon = reminder.messageType === 'confirmation' ? Sparkles : Bell
                            return (
                              <div key={reminder.id} className={pageStyles.reminderItem}>
                                <span className={pageStyles.reminderIcon}>
                                  <ReminderIcon size={16} aria-hidden="true" />
                                </span>
                                <div className={pageStyles.reminderCopy}>
                                  <strong>{formatReminderOffsetLabel(reminder.offsetValue, reminder.offsetUnit)}</strong>
                                  <span>
                                    {reminder.messageType === 'confirmation'
                                      ? `Confirmación de cita${reminder.aiEnabled ? ' · IA' : ''}`
                                      : 'Recordatorio de cita'}
                                  </span>
                                  <button
                                    type="button"
                                    className={pageStyles.reminderDetailsButton}
                                    onClick={() => {
                                      setSelectedAppointmentReminder(reminder)
                                      setIsAppointmentReminderModalOpen(true)
                                    }}
                                  >
                                    Ver detalles
                                  </button>
                                </div>
                                <Switch
                                  checked={reminder.enabled}
                                  onChange={(enabled) => void handleToggleAppointmentReminder(reminder, enabled)}
                                  aria-label={reminder.enabled ? 'Desactivar recordatorio' : 'Activar recordatorio'}
                                />
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className={pageStyles.remindersEmpty}>
                          <Bell size={17} />
                          Agrega un mensaje automático para recordar, confirmar o dar seguimiento a cada cita.
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {currentStep.id === 'availability' && (
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Espacios entre citas</strong>
              <span>Tiempo libre antes/después y opción para ocultar algunos horarios.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Tiempo libre antes</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.preBuffer || 0}
                    onValueChange={(value) => updateSelectedCalendar({ preBuffer: Math.trunc(value) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.preBufferUnit || 'mins'}
                    onValueChange={(value) => updateSelectedCalendar({ preBufferUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Tiempo libre después</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <NumberInput
                    className={styles.input}
                    value={selectedCalendar.slotBuffer || 0}
                    onValueChange={(value) => updateSelectedCalendar({ slotBuffer: Math.trunc(value) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotBufferUnit || 'mins'}
                    onValueChange={(value) => updateSelectedCalendar({ slotBufferUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <div className={pageStyles.editorField}>
                <span>Ocultar horarios al azar</span>
                <div className={pageStyles.lookBusyRow}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedCalendar.lookBusyConfig?.enabled || false}
                      onChange={(event) => updateSelectedCalendar({
                        lookBusyConfig: {
                          enabled: event.target.checked,
                          LookBusyPercentage: selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0
                        }
                      })}
                    />
                    Sí, ocultar algunos horarios
                  </label>

                  {selectedCalendar.lookBusyConfig?.enabled && (
                    <label className={pageStyles.lookBusyPercent}>
                      <span>Ocultar</span>
                      <NumberInput
                        className={styles.input}
                        value={selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0}
                        onValueChange={(value) => updateSelectedCalendar({
                          lookBusyConfig: {
                            enabled: true,
                            LookBusyPercentage: Math.trunc(value) || 0
                          }
                        })}
                        min="0"
                        max="100"
                      />
                      <span>%</span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          </section>
              )}

              {currentStep.id === 'advanced' && (
                <>
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Notas</strong>
              <span>Texto interno que acompaña cada cita y puede usar parámetros.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <div className={pageStyles.editorFieldWide}>
                {renderCalendarTemplateField({
                  id: `calendar-notes-${calendar.id}`,
                  label: 'Notas',
                  value: selectedCalendar.notes || '',
                  onChange: (nextValue) => updateSelectedCalendar({ notes: nextValue }),
                  placeholder: 'Ej. Cliente: {{contact.full_name}}\nTeléfono: {{contact.phone}}\nNotas: {{appointment.notes}}',
                  help: 'Estas notas se guardan como descripción de la cita cuando el calendario esté conectado.',
                  multiline: true
                })}
              </div>
            </div>
          </section>

          {showGoogleSyncSettings && (
            <section className={pageStyles.editorSection}>
              <div className={pageStyles.editorSectionHeader}>
                <strong>Conexión bidireccional</strong>
                <span>Elige dónde se guardan y actualizan las citas de este calendario.</span>
              </div>
              <div className={pageStyles.editorFields}>
                <div className={pageStyles.editorField}>
                  <span>Cuenta de Google</span>
                  <div className={pageStyles.googleLinkedAccount}>
                    <span className={pageStyles.googleLinkedAccountIcon}>
                      <Calendar size={15} />
                    </span>
                    <div>
                      <strong>Conexión segura de Google</strong>
                      <span>{googleAccountLabel}</span>
                    </div>
                  </div>
                </div>

                <div className={pageStyles.editorField}>
                  <div className={pageStyles.googleSyncFieldTop}>
                    <span>Dónde guardar las citas</span>
                    {currentGoogleCalendarId && (
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={clearGoogleCalendarSync}
                        disabled={savingGoogleSyncCalendarId === calendar.id}
                      >
                        <XCircle size={14} />
                        Dejar de sincronizar
                      </Button>
                    )}
                  </div>
                  <CustomSelect
                    value={currentGoogleCalendarId}
                    onValueChange={(value) => updateSelectedCalendar({ googleCalendarId: value })}
                    options={googleSyncOptions}
                    placeholder={googleCalendarOptions.length ? 'Elige el calendario de Google' : 'Sin calendarios disponibles'}
                    disabled={loadingGoogleCalendarOptions || savingGoogleSyncCalendarId === calendar.id || googleSyncBlocked || !googleSyncOptions.length}
                  />
                  <small>
                    {googleSyncBlocked
                      ? 'Vuelve a conectar Google Calendar aceptando permisos para leer calendarios y editar citas.'
                      : loadingGoogleCalendarOptions
                        ? ''
                        : currentGoogleCalendarId
                          ? `Se sincroniza con ${currentGoogleOption?.summary || selectedCalendar.googleCalendarSummary || currentGoogleCalendarId}.`
                          : googleCalendarOptions.length && !writableGoogleCalendarCount
                            ? 'Los calendarios disponibles están en solo lectura. Necesitas uno con permiso para editar eventos.'
                            : googleCalendarOptions.length
                              ? 'Elige el calendario de Google donde quieres que caigan estas citas.'
                              : 'No hay calendarios de Google disponibles para ligar.'}
                  </small>
                </div>

                <div className={pageStyles.googleSyncHint}>
                  <Link2 size={16} />
                  <span>
                    Al guardar, Ristak traerá citas de Google y también actualizará ese calendario cuando crees o edites citas aquí.
                  </span>
                </div>
              </div>
            </section>
          )}
                </>
              )}

              {currentStep.id === 'events' && (
                <>
                  <section className={pageStyles.editorSection}>
                    <div className={pageStyles.editorSectionHeader}>
                      <strong>Eventos personalizados de Meta</strong>
                      <span>Define qué conversión se manda cuando alguien agenda desde este calendario.</span>
                    </div>
                    <div className={pageStyles.editorFields}>
                      <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                        <div className={pageStyles.eventSwitchRow}>
                          <div>
                            <span>Enviar evento al agendar</span>
                            <small>
                              Si está apagado, este calendario conserva el comportamiento global de Meta/WhatsApp.
                            </small>
                          </div>
                          <Switch
                            checked={customEventsConfig.enabled}
                            onChange={(enabled) => updateCustomEventsConfig({ enabled })}
                            aria-label="Activar eventos personalizados del calendario"
                          />
                        </div>
                      </div>

                      {customEventsConfig.enabled && (
                        <>
                          <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                            <span className={pageStyles.eventFieldTitle}>Tipo de conversión</span>
                            <TabList
                              tabs={CALENDAR_CUSTOM_EVENT_CHANNEL_TABS}
                              activeTab={customEventsConfig.channel}
                              onTabChange={(value) => {
                                const channel = value as CalendarCustomEventChannel
                                updateCustomEventsConfig({
                                  channel,
                                  eventName: channel === 'whatsapp'
                                    ? CALENDAR_DEFAULT_WHATSAPP_EVENT_NAME
                                    : customEventsConfig.channel === 'whatsapp'
                                      ? CALENDAR_DEFAULT_META_EVENT_NAME
                                      : customEventsConfig.eventName
                                })
                              }}
                              fullWidth
                              variant="compact"
                              className={pageStyles.eventChannelControl}
                            />
                            <small>
                              Sitios usa Pixel + CAPI, WhatsApp usa LeadSubmitted y modo inteligente decide según el primer punto de contacto.
                            </small>
                          </div>

                          {customEventsConfig.channel !== 'whatsapp' ? (
                            <>
                              {customEventsConfig.channel === 'smart' && (
                                <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                                  <div className={pageStyles.eventSmartHint}>
                                    <Info size={16} />
                                    <div>
                                      <strong>Modo inteligente</strong>
                                      <small>
                                        Si el contacto nació por WhatsApp/Meta CTWA manda LeadSubmitted. Si nació por sitio, formulario o URL pública, manda Pixel + CAPI.
                                      </small>
                                    </div>
                                  </div>
                                </div>
                              )}

                              <label className={pageStyles.editorField}>
                                <span className={pageStyles.eventFieldTitle}>Evento de Meta</span>
                                <CustomSelect
                                  value={customEventsConfig.eventName}
                                  onValueChange={(value) => updateCustomEventsConfig({ eventName: value })}
                                  options={CALENDAR_META_EVENT_OPTIONS}
                                />
                                <small>Por defecto usa Schedule, el evento estándar de cita agendada.</small>
                              </label>

                              <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                                <button
                                  type="button"
                                  className={[
                                    pageStyles.eventInlineToggle,
                                    calendarMetaParamsOpen ? pageStyles.eventInlineToggleActive : '',
                                    customEventsHasParameters ? pageStyles.eventInlineToggleFilled : ''
                                  ].filter(Boolean).join(' ')}
                                  aria-expanded={calendarMetaParamsOpen}
                                  onClick={() => setCalendarMetaParamsOpen(open => !open)}
                                >
                                  <SlidersHorizontal size={14} />
                                  <span>Parámetros opcionales</span>
                                  <ChevronDown size={13} />
                                </button>

                                {calendarMetaParamsOpen && (
                                  <div className={pageStyles.eventParameterPanel}>
                                    <div className={pageStyles.eventCurrencyNote}>
                                      <span>Moneda de la cuenta</span>
                                      <strong>{accountCurrency}</strong>
                                      <small>Se manda automáticamente con el evento; no se edita por calendario.</small>
                                    </div>

                                    <div className={pageStyles.eventParameterGrid}>
                                      {CALENDAR_META_PARAMETER_FIELDS.map(field => (
                                        <label key={field.key}>
                                          <span className={pageStyles.eventParameterLabel}>{field.label}</span>
                                          <input
                                            className={styles.input}
                                            value={String(customEventsConfig.parameters[field.key] || '')}
                                            onChange={(event) => updateCustomEventParameters({ [field.key]: event.target.value } as Partial<CalendarCustomEventParameters>)}
                                            placeholder={field.placeholder}
                                          />
                                        </label>
                                      ))}
                                    </div>

                                    <div className={pageStyles.customParameterHeader}>
                                      <span className={pageStyles.eventFieldTitle}>Parámetros extra</span>
                                      <Button variant="secondary" size="small" onClick={addCustomEventParameterRow}>
                                        <Plus size={14} />
                                        Añadir parámetro
                                      </Button>
                                    </div>
                                    <div className={pageStyles.customParameterList}>
                                      {(customEventsConfig.parameters.custom || []).length ? (
                                        (customEventsConfig.parameters.custom || []).map(parameter => (
                                          <div key={parameter.id} className={pageStyles.customParameterRow}>
                                            <input
                                              className={styles.input}
                                              value={parameter.key}
                                              onChange={(event) => updateCustomEventParameterRow(parameter.id, { key: event.target.value })}
                                              placeholder="nombre_parametro"
                                            />
                                            <input
                                              className={styles.input}
                                              value={parameter.value}
                                              onChange={(event) => updateCustomEventParameterRow(parameter.id, { value: event.target.value })}
                                              placeholder="valor"
                                            />
                                            <Button
                                              variant="ghost"
                                              size="small"
                                              onClick={() => removeCustomEventParameterRow(parameter.id)}
                                              aria-label="Eliminar parámetro"
                                            >
                                              <Trash2 size={14} />
                                            </Button>
                                          </div>
                                        ))
                                      ) : (
                                        <p className={pageStyles.customParameterEmpty}>
                                          Sin parámetros extra. Los datos comunes de la cita se mandan automáticamente.
                                        </p>
                                      )}
                                    </div>

                                    <small>
                                      Si no escribes nada, Ristak manda calendario, cita, fecha, moneda, estado agendado y el ID de evento para deduplicar Pixel + CAPI.
                                    </small>
                                  </div>
                                )}
                              </div>
                            </>
                          ) : (
                            <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                              <span className={pageStyles.eventFieldTitle}>Evento enviado por WhatsApp</span>
                              <div className={pageStyles.whatsappEventSummary}>
                                <strong>{CALENDAR_DEFAULT_WHATSAPP_EVENT_NAME}</strong>
                                <small>
                                  Se envía por server-side como Business Messaging, con teléfono hasheado, ctwa_clid y datos de atribución cuando Meta los tenga disponibles.
                                </small>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </section>
                </>
              )}

              {currentStep.id === 'design' && (
                <section className={pageStyles.editorSection}>
                  <div className={pageStyles.editorSectionHeader}>
                    <strong>Estilos y diseños</strong>
                    <span>Controla la apariencia de la URL pública: panel izquierdo, textos, colores y tipografía.</span>
                  </div>
                  {renderCalendarBookingPreview()}
                  <div className={pageStyles.editorFields}>
                    <label className={pageStyles.editorField}>
                      <span>Vista pública</span>
                      <CustomSelect
                        value={bookingDisplayConfig.layout}
                        onValueChange={(value) => updateBookingDisplayConfig({ layout: normalizeCalendarBookingLayout(value) })}
                        options={CALENDAR_PUBLIC_LAYOUT_OPTIONS}
                      />
                    </label>

                    <label className={pageStyles.editorField}>
                      <span>Tipografía</span>
                      <CustomSelect
                        value={bookingDisplayConfig.fontFamily}
                        onValueChange={(value) => updateBookingDisplayConfig({ fontFamily: normalizeCalendarBookingFontFamily(value) })}
                        options={CALENDAR_PUBLIC_FONT_OPTIONS}
                      />
                    </label>

                    <div className={pageStyles.editorField}>
                      <span>Color principal</span>
                      <small>Acento de fechas, día y horario seleccionado, botones y resaltados.</small>
                      {renderCalendarColorPicker(
                        selectedCalendar.eventColor,
                        (nextColor) => updateSelectedCalendar({ eventColor: nextColor }),
                        true
                      )}
                    </div>

                    <div className={pageStyles.editorField}>
                      <span>Color de fondo</span>
                      <small>El texto se ajusta solo a claro u oscuro para mantener el contraste.</small>
                      {renderCalendarColorPicker(
                        bookingDisplayConfig.colors.background,
                        (nextColor) => updateBookingDisplayColors({ background: nextColor }),
                        true,
                        CALENDAR_BACKGROUND_PALETTE
                      )}
                    </div>

                    <div className={`${pageStyles.editorField} ${pageStyles.editorFieldWide}`}>
                      <span>Qué se muestra</span>
                      <div className={pageStyles.displayToggleGrid}>
                        {[
                          ['showSidebar', 'Panel izquierdo', 'Oculta toda la barra lateral para dejar solo el calendario.'],
                          ['showIcon', 'Icono o imagen', 'Muestra la inicial o imagen superior.'],
                          ['showEventTitle', 'Título corto', 'Muestra el texto tipo “Cita”.'],
                          ['showCalendarName', 'Nombre del calendario', 'Muestra el título grande público.'],
                          ['showDescription', 'Descripción', 'Muestra el texto descriptivo.'],
                          ['showDuration', 'Duración', 'Muestra los minutos de la cita.']
                        ].map(([key, label, description]) => (
                          <div className={pageStyles.displaySwitchRow} key={key}>
                            <div>
                              <strong>{label}</strong>
                              <small>{description}</small>
                            </div>
                            <Switch
                              checked={Boolean(bookingDisplayConfig[key as keyof CalendarBookingDisplayConfig])}
                              onChange={(checked) => updateBookingDisplayConfig({ [key]: checked } as Partial<CalendarBookingDisplayConfig>)}
                              aria-label={`Mostrar ${label}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                </section>
              )}
            </div>
            <div className={pageStyles.calendarWizardFooter}>
              <Button
                variant="secondary"
                onClick={() => goToRelativeStep(-1)}
                disabled={savingConfig || safeStepIndex === 0}
              >
                Anterior
              </Button>
              <Button
                variant="secondary"
                onClick={() => goToRelativeStep(1)}
                disabled={savingConfig || safeStepIndex === CALENDAR_WIZARD_STEPS.length - 1}
              >
                Siguiente
              </Button>
              <Button
                onClick={handleSaveCalendarConfig}
                disabled={savingConfig}
              >
                {savingConfig ? (
                  <>
                    <Loader2 size={16} className={styles.spinIcon} />
                    Guardando...
                  </>
                ) : (
                  'Guardar cambios'
                )}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    )
  }

  const getNotificationScopeLabel = () => {
    if (!calendarPushEnabled) return 'Apagadas'
    if (calendarPushNotificationIds.length === 0) return 'Todos los calendarios'
    return `${calendarPushNotificationIds.length} calendario${calendarPushNotificationIds.length === 1 ? '' : 's'}`
  }

  const renderNotificationsHeaderAction = () => (
    <button
      type="button"
      className={`${pageStyles.notificationsHeaderButton} ${calendarPushEnabled ? pageStyles.notificationsHeaderButtonActive : ''}`}
      onClick={() => setShowNotificationsModal(true)}
    >
      <span className={pageStyles.notificationsButtonMark}>
        {calendarPushEnabled ? <Bell size={16} /> : <BellOff size={16} />}
      </span>
      <span className={pageStyles.notificationsButtonText}>
        <strong>Notificaciones</strong>
        <small>{getNotificationScopeLabel()}</small>
      </span>
    </button>
  )

  const renderCalendarNotificationsModal = () => showNotificationsModal ? createPortal(
    <Modal
      isOpen={showNotificationsModal}
      onClose={() => setShowNotificationsModal(false)}
      title="Notificaciones"
      size="md"
      flushContent
    >
      <div className={pageStyles.notificationsModal} data-modal-panel="">
        <section className={pageStyles.notificationsHero}>
          <div className={pageStyles.notificationsTitle}>
            <span className={pageStyles.notificationsIcon}>
              {calendarPushEnabled ? <Bell size={18} /> : <BellOff size={18} />}
            </span>
            <div>
              <h3>Notificaciones en celulares</h3>
              <p>Cuando alguien agenda, Ristak notifica a los celulares que ya dieron permiso.</p>
            </div>
          </div>

          <div className={styles.toggleContainer}>
            <button
              type="button"
              className={`${styles.toggle} ${calendarPushEnabled ? styles.toggleActive : ''}`}
              onClick={handleCalendarPushEnabledToggle}
              aria-pressed={calendarPushEnabled}
              aria-label={calendarPushEnabled ? 'Desactivar notificaciones' : 'Activar notificaciones'}
            >
              <span className={styles.toggleThumb} />
            </button>
            <span className={`${styles.toggleLabel} ${calendarPushEnabled ? styles.toggleLabelActive : ''}`}>
              {calendarPushEnabled ? 'Encendidos' : 'Apagados'}
            </span>
          </div>
        </section>

        <section className={pageStyles.notificationSettingsSection}>
          <div className={pageStyles.notificationSectionHeader}>
            <strong>Quién recibirá notificaciones</strong>
            <span>Reciben notificaciones los celulares donde esta cuenta haya permitido notificaciones.</span>
          </div>

          <div className={pageStyles.notificationRecipientList}>
            <div className={pageStyles.notificationRecipientCard}>
              <span className={pageStyles.notificationRecipientIcon}>
                <Bell size={16} />
              </span>
              <div>
                <strong>{user?.name || user?.username || 'Cuenta actual'}</strong>
                <span>{user?.email || user?.username || 'Usuario conectado en Ristak'}</span>
              </div>
            </div>

            <div className={pageStyles.notificationRecipientCard}>
              <span className={pageStyles.notificationRecipientIcon}>
                <Smartphone size={16} />
              </span>
              <div>
                <strong>Celulares con permiso</strong>
                <span>Cada persona debe abrir Ristak desde el icono del celular y tocar “Activar” en Notificaciones.</span>
              </div>
            </div>
          </div>
        </section>

        <section className={pageStyles.notificationSettingsSection}>
          <div className={pageStyles.notificationPickerHeader}>
            <strong>Calendarios que mandan notificaciones</strong>
            <span>{calendarPushNotificationIds.length ? `${calendarPushNotificationIds.length} elegido${calendarPushNotificationIds.length === 1 ? '' : 's'}` : 'Todos'}</span>
          </div>

          <button
            type="button"
            className={`${pageStyles.notificationAllButton} ${calendarPushNotificationIds.length === 0 ? pageStyles.notificationAllButtonActive : ''}`}
            onClick={handleUseAllCalendarPushNotifications}
          >
            Todos los calendarios
          </button>

          {calendars.length > 0 && (
            <div className={pageStyles.notificationChips}>
              {calendars.map((calendar) => {
                const selected = calendarPushNotificationIds.includes(calendar.id)
                return (
                  <button
                    key={calendar.id}
                    type="button"
                    className={`${pageStyles.notificationChip} ${selected ? pageStyles.notificationChipActive : ''}`}
                    onClick={() => handleCalendarPushSelectionToggle(calendar.id)}
                  >
                    <span style={{ backgroundColor: calendar.eventColor || 'var(--color-primary)' }} />
                    {calendar.name}
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </Modal>,
    document.body
  ) : null

  const renderCalendarRow = (calendar: CalendarType) => {
    const isAttributed = attributionCalendarIds.includes(calendar.id)
    const isDefault = defaultCalendarId === calendar.id
    const handleRowClick = (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement
      if (target.closest('button, a, input, select, textarea, [role="menuitem"]')) return
      handleOpenCalendarEditor(calendar)
    }

    return (
      <div key={calendar.id} className={pageStyles.calendarItem}>
        <article
          className={`${pageStyles.calendarRow} ${isDefault ? pageStyles.calendarRowDefault : ''}`}
          onClick={handleRowClick}
        >
          <div className={pageStyles.calendarIdentity}>
            <span
              className={pageStyles.calendarColor}
              style={{ backgroundColor: calendar.eventColor || 'var(--color-primary)' }}
            />
            <div className={pageStyles.calendarMain}>
              <div className={pageStyles.calendarTitleLine}>
                <h3>{calendar.name}</h3>
                {isDefault && (
                  <span className={pageStyles.defaultPill}>
                    <Star size={12} fill="currentColor" />
                    Predeterminado
                  </span>
                )}
                {renderCalendarSourceBadge(calendar)}
              </div>

              <div className={pageStyles.calendarMeta}>
                <span>{calendar.slotDuration} {calendar.slotDurationUnit}</span>
                <span>Cada {calendar.slotInterval} {calendar.slotIntervalUnit}</span>
                {calendar.googleCalendarId && (
                  <span>Google: {calendar.googleCalendarSummary || calendar.googleCalendarId}</span>
                )}
              </div>
            </div>
          </div>

          <div className={pageStyles.calendarActions} onClick={(event) => event.stopPropagation()}>
            <div className={`${pageStyles.calendarStateControl} ${calendar.isActive ? pageStyles.calendarStateControlActive : ''}`}>
              <span className={`${styles.toggleLabel} ${calendar.isActive ? styles.toggleLabelActive : ''}`}>
                {calendar.isActive ? 'Activo' : 'Pausado'}
              </span>
              <button
                type="button"
                className={`${styles.toggle} ${calendar.isActive ? styles.toggleActive : ''}`}
                onClick={() => handleCalendarActiveToggle(calendar)}
                aria-pressed={calendar.isActive}
                aria-label={calendar.isActive ? `Pausar ${calendar.name}` : `Activar ${calendar.name}`}
                title={calendar.isActive ? 'Disponible para agendar' : 'Pausado para nuevas citas'}
                disabled={savingActiveCalendarId === calendar.id}
              >
                <span className={styles.toggleThumb} />
              </button>
            </div>
            <div className={pageStyles.rowActionColumn}>
              <span>Acciones</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={pageStyles.moreButton}
                    aria-label={`Acciones para ${calendar.name}`}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={pageStyles.actionsMenu}>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    disabled={isDefault}
                    onSelect={() => void handleDefaultCalendarChange(calendar.id)}
                  >
                    <Star size={15} />
                    Convertir en predeterminado
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    onSelect={() => handleOpenCalendarEditor(calendar)}
                  >
                    <Pencil size={15} />
                    Editar
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    onSelect={() => void handleCopyPublicUrl(calendar)}
                  >
                    <Link2 size={15} />
                    Enlace para compartir
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className={`${pageStyles.menuItem} ${pageStyles.dangerMenuItem}`}
                    disabled={deletingCalendarId === calendar.id}
                    onSelect={() => handleDeleteCalendar(calendar)}
                  >
                    {deletingCalendarId === calendar.id ? (
                      <Loader2 size={15} className={styles.spinIcon} />
                    ) : (
                      <Trash2 size={15} />
                    )}
                    Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </article>
        {renderCalendarInlineEditor(calendar)}
      </div>
    )
  }

  const renderCalendarsTab = () => (
    <div className={pageStyles.tabPanel}>
      <div className={pageStyles.panelToolbar}>
        {renderCalendarSourceSelect()}
        <Button
          className={pageStyles.toolbarCreate}
          variant="outline"
          size="small"
          onClick={() => {
            setShowCreateModal(true)
            navigate('/settings/calendars/new')
          }}
        >
          <Plus size={16} />
          Crear calendario
        </Button>
      </div>

      <details className={pageStyles.compactHelp}>
        <summary>¿Qué significa “conversión”?</summary>
        <p>Los calendarios marcados alimentan citas en reportes, campañas, viaje del cliente y eventos de Meta/WhatsApp. Si no marcas ninguno, Ristak toma todos.</p>
      </details>

      {calendars.length > 0 ? (
        <div className={pageStyles.calendarList}>
          {calendars.map(renderCalendarRow)}
        </div>
      ) : (
        <div className={pageStyles.emptyState}>
          <Calendar size={34} />
          <h3>No hay calendarios todavía</h3>
          <p>Crea el primero para empezar a agendar desde Ristak.</p>
          <Button onClick={() => {
            setShowCreateModal(true)
            navigate('/settings/calendars/new')
          }}>
            <Plus size={16} />
            Crear calendario
          </Button>
        </div>
      )}
    </div>
  )

  const renderGoogleCalendarTab = () => {
    const isConnected = Boolean(googleIntegration?.connected)
    const testFailed = googleIntegration?.lastTestStatus === 'error'
    const syncFailed = googleIntegration?.lastSyncStatus === 'error'
    const busyGoogleAction = savingGoogleIntegration || testingGoogleIntegration || syncingGoogleIntegration || disconnectingGoogleIntegration

    const renderCentralOAuthPanel = () => {
      const accountName = googleIntegration?.googleAccountName || googleIntegration?.googleAccountEmail || 'Google Calendar'
      const accountEmail = googleIntegration?.googleAccountEmail || 'Conecta tu cuenta para ver calendarios disponibles'
      const canConnect = googleIntegration?.configured !== false

      return (
        <div className={pageStyles.googleLayoutSingle}>
          <section className={pageStyles.connectionPanel}>
            <div className={pageStyles.connectionHeader}>
              <div>
                <h2>Google Calendar</h2>
                <p>Conecta tu cuenta con Google desde el portal de Ristak. No necesitas pegar JSON ni configurar cuentas técnicas.</p>
              </div>
              <span className={`${pageStyles.statusPill} ${isConnected ? pageStyles.statusOk : canConnect ? pageStyles.statusWarn : pageStyles.statusOff}`}>
                {isConnected ? <CheckCircle size={15} /> : canConnect ? <Info size={15} /> : <XCircle size={15} />}
                {isConnected ? 'Conectado' : canConnect ? 'Listo' : 'Pendiente'}
              </span>
            </div>

            <div className={pageStyles.oauthConnectionCard}>
              <div className={pageStyles.oauthAccountAvatar}>
                {googleIntegration?.googleAccountPictureUrl ? (
                  <img src={googleIntegration.googleAccountPictureUrl} alt="" />
                ) : (
                  <Calendar size={22} />
                )}
              </div>
              <div className={pageStyles.connectedMain}>
                <div className={pageStyles.connectedTitle}>
                  <h3>{isConnected ? accountName : 'Conectar con Google'}</h3>
                  {isConnected && <span>Conexión segura</span>}
                </div>
                <p>{isConnected ? accountEmail : 'Te vamos a llevar al portal seguro para autorizar Google Calendar con los permisos correctos.'}</p>
              </div>
            </div>

            {isConnected ? (
              <>
                <div className={pageStyles.oauthPermissionGrid}>
                  <span>
                    <ShieldCheck size={15} />
                    {googleIntegration?.canManageEvents ? 'Puede crear y editar citas' : 'Sin permiso para editar citas'}
                  </span>
                  <span>
                    <ListChecks size={15} />
                    {googleIntegration?.canListCalendars ? 'Puede leer tus calendarios' : 'Sin permiso para listar calendarios'}
                  </span>
                  <span>
                    <Calendar size={15} />
                    {loadingGoogleCalendarOptions
                      ? 'Leyendo calendarios...'
                      : `${googleCalendarOptions.length} calendario${googleCalendarOptions.length === 1 ? '' : 's'} disponible${googleCalendarOptions.length === 1 ? '' : 's'}`}
                  </span>
                </div>

                <div className={pageStyles.connectedActions}>
                  <Button onClick={handleSyncGoogleIntegration} disabled={busyGoogleAction}>
                    {syncingGoogleIntegration ? (
                      <>
                        <Loader2 size={16} className={styles.spinIcon} />
                        Sincronizando...
                      </>
                    ) : (
                      <>
                        <RefreshCw size={16} />
                        Sincronizar ahora
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={handleTestGoogleIntegration} disabled={busyGoogleAction}>
                    {testingGoogleIntegration ? (
                      <>
                        <Loader2 size={16} className={styles.spinIcon} />
                        Probando...
                      </>
                    ) : (
                      <>
                        <TestTube2 size={16} />
                        Probar conexión
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await loadGoogleIntegration()
                      await loadGoogleCalendarOptions()
                    }}
                    disabled={busyGoogleAction}
                  >
                    <RefreshCw size={16} />
                    Actualizar
                  </Button>
                  <Button variant="ghost" onClick={handleConnectGoogleOAuth} disabled={busyGoogleAction}>
                    {savingGoogleIntegration ? (
                      <>
                        <Loader2 size={16} className={styles.spinIcon} />
                        Abriendo...
                      </>
                    ) : (
                      <>
                        <KeyRound size={16} />
                        Cambiar cuenta
                      </>
                    )}
                  </Button>
                  <Button variant="ghost" onClick={handleDisconnectGoogleIntegration} disabled={busyGoogleAction}>
                    {disconnectingGoogleIntegration ? (
                      <>
                        <Loader2 size={16} className={styles.spinIcon} />
                        Desconectando...
                      </>
                    ) : (
                      <>
                        <Trash2 size={16} />
                        Desconectar
                      </>
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className={pageStyles.wizardIntro}>
                  <strong>{canConnect ? 'Conexión central' : 'Falta configuración del portal'}</strong>
                  <span>
                    {canConnect
                      ? 'Al continuar, Google te pedirá permiso para leer calendarios y crear eventos. La autorización se guarda cifrada en el portal.'
                      : 'Primero configura Google Calendar en el portal de Ristak para poder conectar calendarios desde las instalaciones.'}
                  </span>
                </div>

                <div className={pageStyles.formActions}>
                  <Button onClick={handleConnectGoogleOAuth} disabled={!canConnect || savingGoogleIntegration}>
                    {savingGoogleIntegration ? (
                      <>
                        <Loader2 size={16} className={styles.spinIcon} />
                        Abriendo...
                      </>
                    ) : (
                      <>
                        <KeyRound size={16} />
                        Conectar con Google
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}

            {(testFailed || syncFailed) && (
              <div className={pageStyles.resultStack}>
                {testFailed && (
                  <div className={`${pageStyles.testResult} ${pageStyles.testError}`}>
                    Última prueba fallida: {googleIntegration?.lastTestMessage}
                  </div>
                )}
                {syncFailed && (
                  <div className={`${pageStyles.testResult} ${pageStyles.testError}`}>
                    Última sincronización fallida: {googleIntegration?.lastSyncMessage}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )
    }

    if (loadingGoogleIntegration) {
      return (
        <div className={pageStyles.googleLayoutSingle}>
          <section className={pageStyles.connectionPanel}>
            <div className={pageStyles.connectionHeader}>
              <div>
                <h2>Google Calendar</h2>
                <p />
              </div>
              <span className={`${pageStyles.statusPill} ${pageStyles.statusWarn}`} role="status" aria-live="polite" aria-label="Cargando Google Calendar">
                <Loader2 size={15} className={styles.spinIcon} aria-hidden="true" />
              </span>
            </div>
          </section>
        </div>
      )
    }

    return renderCentralOAuthPanel()
  }

  const renderGoogleHeaderAction = () => {
    const isConnected = Boolean(googleIntegration?.connected)

    return (
      <button
        type="button"
        className={`${pageStyles.googleHeaderButton} ${isConnected ? pageStyles.googleHeaderButtonConnected : ''}`}
        onClick={() => {
          setActiveView('google')
          navigate(buildCalendarSettingsPath('google'))
        }}
      >
        <span className={pageStyles.googleCalendarMark}>
          <Calendar size={16} />
        </span>
        <span>{isConnected ? 'Conectado' : 'Integrar Google Calendar'}</span>
      </button>
    )
  }

  const renderCalendarHeaderActions = () => (
    <div className={pageStyles.headerActionGroup}>
      {renderGoogleHeaderAction()}
    </div>
  )

  if (loadingCalendars) {
    return <Loading message="Cargando calendarios..." page="calendar-settings" />
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={`${styles.mainCard} ${pageStyles.mainCard}`}>
        <div className={pageStyles.header}>
          <div className={pageStyles.headerIdentity}>
            {activeView === 'google' ? (
              <button
                type="button"
                className={pageStyles.backButton}
                onClick={() => {
                  setActiveView('calendars')
                  navigate(buildCalendarSettingsPath('calendars'))
                }}
                aria-label="Volver a calendarios"
              >
                <ArrowLeft size={18} />
              </button>
            ) : (
              <div className={pageStyles.headerIcon}>
                <Calendar size={20} />
              </div>
            )}
            <div>
              <h2>{activeView === 'google' ? 'Configuración de Google Calendar' : 'Configuración de calendario'}</h2>
              <p>
                {activeView === 'google'
                  ? 'Conecta, prueba y sincroniza Google Calendar con Ristak.'
                  : 'Administra calendarios, predeterminado y conversiones.'}
              </p>
            </div>
          </div>
          {activeView === 'calendars' && renderCalendarHeaderActions()}
        </div>

        {activeView === 'calendars' ? renderCalendarsTab() : renderGoogleCalendarTab()}
      </Card>

      {renderCreateCalendarModal()}
      <AppointmentReminderModal
        isOpen={isAppointmentReminderModalOpen}
        reminder={selectedAppointmentReminder}
        senders={reminderSenders}
        channels={reminderChannels}
        templates={reminderTemplates}
        onClose={() => {
          setIsAppointmentReminderModalOpen(false)
          setSelectedAppointmentReminder(null)
        }}
        onSave={handleSaveAppointmentReminder}
        onDelete={handleDeleteAppointmentReminder}
      />
    </div>
  )
}
