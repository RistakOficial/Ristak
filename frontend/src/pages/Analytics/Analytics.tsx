import React, { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useDateRange } from '../../contexts/DateRangeContext'
import { useTimezone } from '../../contexts/TimezoneContext'
import { useLabels } from '../../contexts/LabelsContext'
import { useUrlDateRangeSync, useUrlFilterState } from '../../hooks'
import {
  PageContainer,
  PageHeader,
  Card,
  KpiCard,
  DateRangePicker,
  ViewSelector,
  TabList,
  Button,
  AreaChart,
  TreeFilter,
  OriginDistributionCard,
  SessionsTable,
  Loading,
  ContactDetailsModal
} from '../../components/common'
import { Eye, Users, UserCheck, Target, Smartphone, Monitor, Tablet, Globe, Minus, Plus, MessageCircle } from 'lucide-react'
import { FaFacebook, FaGoogle, FaInstagram, FaTiktok, FaTwitter, FaLinkedin, FaMicrosoft, FaChrome, FaFirefox, FaSafari, FaEdge, FaOpera, FaWindows, FaAndroid, FaLinux } from 'react-icons/fa'
import { SiMacos, SiIos } from 'react-icons/si'
import {
  getSessionsByDateRange,
  getSessionMetricsByDateRange,
  getContactsByDate,
  getContactConversionsByDate,
  getContactConversionContacts,
  getMessageAnalyticsSummary,
  type ContactsByDate,
  type ContactConversionListType,
  type ContactConversionsByDate,
  type MessageAnalyticsSummary
} from '../../services/analyticsService'
import { trackingService, type TrackingSession } from '../../services/trackingService'
import type { ContactListItem } from '../../services/reportsService'
import { formatDateToISO, normalizeDateInputToLocalDate, parseLocalDateString, formatUrlParameter, formatChartNumber } from '../../utils/format'
import { dateOnlyToLocalDate, todayDateOnlyInTimezone } from '../../utils/timezone'
import { normalizeTrafficSource } from '../../utils/trafficSourceNormalizer'
import { readNumberParam, setSearchParam } from '../../utils/urlState'

type ViewType = 'day' | 'month' | 'year'
type MonthPreset = 'last12' | 'thisYear' | 'all' | 'custom'
type AnalyticsMainChartView = 'traffic' | 'visitors-registrations' | 'sessions-visitors' | 'identity-returning'
type AnalyticsConversionChartView = 'registrations-customers' | 'appointments-attendances' | 'prospects-customers' | 'messages-appointments' | 'appointments-patients'

const monthNamesShort = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sept', 'oct', 'nov', 'dic'
]

const viewTabs: Array<{ value: ViewType; label: string }> = [
  { value: 'day', label: 'Día' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' }
]

const analyticsViewTypes: ViewType[] = ['day', 'month', 'year']
const analyticsMonthPresets: MonthPreset[] = ['last12', 'thisYear', 'all', 'custom']
const analyticsMainChartViews: AnalyticsMainChartView[] = ['traffic', 'visitors-registrations', 'sessions-visitors', 'identity-returning']
const analyticsConversionChartViews: AnalyticsConversionChartView[] = ['registrations-customers', 'appointments-attendances', 'prospects-customers', 'messages-appointments', 'appointments-patients']
const defaultAnalyticsViewType: ViewType = 'month'
const isAnalyticsViewType = (value?: string): value is ViewType => analyticsViewTypes.includes(value as ViewType)
const isAnalyticsMonthPreset = (value?: string | null): value is MonthPreset => analyticsMonthPresets.includes(value as MonthPreset)
const isAnalyticsMainChartView = (value?: string): value is AnalyticsMainChartView => analyticsMainChartViews.includes(value as AnalyticsMainChartView)
const isAnalyticsConversionChartView = (value?: string): value is AnalyticsConversionChartView => analyticsConversionChartViews.includes(value as AnalyticsConversionChartView)
const parseAnalyticsRoute = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const analyticsIndex = segments.indexOf('analytics')
  const routeSegments = analyticsIndex >= 0 ? segments.slice(analyticsIndex + 1) : []
  return {
    viewType: isAnalyticsViewType(routeSegments[0]) ? routeSegments[0] : defaultAnalyticsViewType,
    mainChart: isAnalyticsMainChartView(routeSegments[1]) ? routeSegments[1] : 'traffic',
    conversionChart: isAnalyticsConversionChartView(routeSegments[2]) ? routeSegments[2] : 'registrations-customers'
  }
}
const buildAnalyticsPath = (viewType: ViewType, mainChart: AnalyticsMainChartView, conversionChart: AnalyticsConversionChartView) =>
  `/analytics/${viewType}/${mainChart}/${conversionChart}`

const monthRangeOptions = [
  { value: 'last12', label: 'Últimos 12 meses' },
  { value: 'thisYear', label: 'Este año' },
  { value: 'all', label: 'Todo el tiempo' },
  { value: 'custom', label: 'Rango personalizado' }
]

const allTimeStartYear = 2020
const getBusinessToday = (timezone: string) => dateOnlyToLocalDate(todayDateOnlyInTimezone(timezone)) || new Date()
const getDefaultYearRange = (currentYear: number) => ({ start: currentYear - 2, end: currentYear })

const startOfMonth = (year: number, monthIndex: number) => new Date(year, monthIndex, 1, 0, 0, 0)
const endOfMonth = (year: number, monthIndex: number) => new Date(year, monthIndex + 1, 0, 23, 59, 59)
const startOfYear = (year: number) => new Date(year, 0, 1, 0, 0, 0)
const endOfYear = (year: number) => new Date(year, 11, 31, 23, 59, 59)
const allTimeStart = () => startOfYear(allTimeStartYear)

const computeRangeForView = (
  viewType: ViewType,
  baseRange: { start: Date; end: Date },
  monthPreset: MonthPreset,
  yearRange: { start: number; end: number },
  businessToday: Date
) => {
  const currentYear = businessToday.getFullYear()
  const currentMonth = businessToday.getMonth()

  if (viewType === 'day') {
    return {
      from: formatDateToISO(baseRange.start),
      to: formatDateToISO(baseRange.end)
    }
  }

  if (viewType === 'month') {
    if (monthPreset === 'thisYear') {
      const start = startOfYear(currentYear)
      const end = endOfMonth(currentYear, currentMonth)
      return { from: formatDateToISO(start), to: formatDateToISO(end) }
    }

    if (monthPreset === 'all') {
      const start = allTimeStart()
      const end = endOfMonth(currentYear, currentMonth)
      return { from: formatDateToISO(start), to: formatDateToISO(end) }
    }

    if (monthPreset === 'custom') {
      const start = startOfMonth(baseRange.start.getFullYear(), baseRange.start.getMonth())
      const end = endOfMonth(baseRange.end.getFullYear(), baseRange.end.getMonth())
      return { from: formatDateToISO(start), to: formatDateToISO(end) }
    }

    const end = endOfMonth(currentYear, currentMonth)
    const start = startOfMonth(currentYear, currentMonth - 11)
    return { from: formatDateToISO(start), to: formatDateToISO(end) }
  }

  if (monthPreset === 'all') {
    return {
      from: formatDateToISO(allTimeStart()),
      to: formatDateToISO(endOfYear(currentYear))
    }
  }

  const start = startOfYear(yearRange.start)
  const end = endOfYear(yearRange.end)
  return { from: formatDateToISO(start), to: formatDateToISO(end) }
}

// Helper para obtener icono de plataforma
const getPlatformIcon = (platformName: string) => {
  const name = platformName.toLowerCase()
  if (name.includes('facebook')) return FaFacebook
  if (name.includes('google')) return FaGoogle
  if (name.includes('instagram')) return FaInstagram
  if (name.includes('tiktok')) return FaTiktok
  if (name.includes('twitter')) return FaTwitter
  if (name.includes('linkedin')) return FaLinkedin
  if (name.includes('microsoft')) return FaMicrosoft
  return Globe
}

// Helper para obtener icono de navegador
const getBrowserIcon = (browserName: string) => {
  const name = browserName.toLowerCase()
  if (name.includes('chrome')) return FaChrome
  if (name.includes('firefox')) return FaFirefox
  if (name.includes('safari')) return FaSafari
  if (name.includes('edge')) return FaEdge
  if (name.includes('opera')) return FaOpera
  return Globe
}

// Helper para obtener icono de sistema operativo
const getOSIcon = (osName: string) => {
  const name = osName.toLowerCase()
  if (name.includes('windows')) return FaWindows
  if (name.includes('mac') || name.includes('macos')) return SiMacos
  if (name.includes('ios') || name.includes('iphone') || name.includes('ipad')) return SiIos
  if (name.includes('android')) return FaAndroid
  if (name.includes('linux')) return FaLinux
  return Monitor
}

// Helper para obtener icono de dispositivo
const getDeviceIcon = (deviceName: string) => {
  const name = deviceName.toLowerCase()
  if (name.includes('mobile') || name.includes('phone')) return Smartphone
  if (name.includes('tablet')) return Tablet
  if (name.includes('desktop')) return Monitor
  return Smartphone
}

// Helper para obtener icono de ubicación (placement)
const getPlacementIcon = (placementName: string) => {
  const name = placementName.toLowerCase()
  if (name.includes('facebook')) return FaFacebook
  if (name.includes('instagram')) return FaInstagram
  if (name.includes('tiktok')) return FaTiktok
  if (name.includes('google')) return FaGoogle
  if (name.includes('twitter')) return FaTwitter
  if (name.includes('linkedin')) return FaLinkedin
  if (name.includes('microsoft')) return FaMicrosoft
  return Target
}

// Helper para formatear placement de manera legible (Facebook Feed, Instagram Reels, etc.)
const formatPlacementName = (placement: string): string => {
  if (!placement || placement === 'Sin ubicación') return 'Sin ubicación'

  const cleaned = placement.toLowerCase().trim()

  // Mapeo de formatos conocidos a nombres legibles
  if (cleaned.includes('facebook') && cleaned.includes('feed')) return 'Facebook Feed'
  if (cleaned.includes('facebook') && cleaned.includes('reel')) return 'Facebook Reels'
  if (cleaned.includes('facebook') && cleaned.includes('story')) return 'Facebook Stories'
  if (cleaned.includes('facebook') && cleaned.includes('right_column')) return 'Facebook Columna Derecha'
  if (cleaned.includes('facebook') && cleaned.includes('video')) return 'Facebook Video'
  if (cleaned.includes('facebook') && cleaned.includes('marketplace')) return 'Facebook Marketplace'
  if (cleaned.includes('facebook') && cleaned.includes('search')) return 'Facebook Búsqueda'

  if (cleaned.includes('instagram') && cleaned.includes('feed')) return 'Instagram Feed'
  if (cleaned.includes('instagram') && cleaned.includes('reel')) return 'Instagram Reels'
  if (cleaned.includes('instagram') && cleaned.includes('story')) return 'Instagram Stories'
  if (cleaned.includes('instagram') && cleaned.includes('explore')) return 'Instagram Explorar'
  if (cleaned.includes('instagram') && cleaned.includes('profile')) return 'Instagram Perfil'
  if (cleaned.includes('instagram') && cleaned.includes('search')) return 'Instagram Búsqueda'

  if (cleaned.includes('messenger')) return 'Messenger'
  if (cleaned.includes('audience_network')) return 'Audience Network'
  if (cleaned.includes('instant_article')) return 'Artículo Instantáneo'
  if (cleaned.includes('instream')) return 'In-Stream Video'

  // Para placements solo con "fb" o "ig"
  if (cleaned === 'fb') return 'Facebook'
  if (cleaned === 'ig') return 'Instagram'

  // Si no hay match, limpiar y capitalizar
  return placement.replace(/_/g, ' ').split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Usar TrackingSession directamente (ya incluye todos los campos necesarios)
type Session = TrackingSession

// Helper para decodificar nombres URL-encoded (+ → espacio, %XX → carácter)
const decodeAdName = (name: string | null | undefined): string => {
  if (!name || name === 'null' || name === 'undefined') {
    return '(Tráfico orgánico)'
  }
  try {
    // Reemplazar + por espacios, luego decodificar
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
}

interface Metrics {
  pageViews: number
  uniqueVisitors: number
  registros: number
  conversionRate: number
  returningUsers: number
  avgPagePerSession: number
  trends: {
    pageViews: number
    uniqueVisitors: number
    registros: number
    conversionRate: number
    returningUsers: number
    avgPagePerSession: number
  }
}

type TrafficPoint = {
  label: string
  value: number
  value2: number
  periodKey?: string
  periodStart?: string
  periodEnd?: string
}

type SessionTrendPoint = {
  label: string
  periodKey: string
  periodStart: string
  periodEnd: string
  pageViews: number
  uniqueVisitors: number
  uniqueSessions: number
  identifiedContacts: number
  returningVisitors: number
}

type ConversionTrendPoint = {
  label: string
  periodKey: string
  periodStart: string
  periodEnd: string
  prospects: number
  registrations: number
  appointments: number
  attendances: number
  customers: number
}

type ConversionTrendBucket = Pick<ConversionTrendPoint, 'prospects' | 'registrations' | 'appointments' | 'attendances' | 'customers'>

type ChartMetricConfig = {
  title: string
  description: string
  label1: string
  label2?: string
  color: string
  color2: string
  data: TrafficPoint[]
  emptyMessage: string
}

type ChartSeriesKey = 'value' | 'value2'
type AnalyticsChartClickPoint = Omit<TrafficPoint, 'value2'> & { value2?: number }
type ContactModalType = 'interesados' | 'sales' | 'appointments' | 'attendances'

type AnalyticsContactModalState = {
  open: boolean
  title: string
  subtitle: string
  type: ContactModalType
  contacts: ContactListItem[]
  loading: boolean
}

const emptyContactModalState: AnalyticsContactModalState = {
  open: false,
  title: '',
  subtitle: '',
  type: 'interesados',
  contacts: [],
  loading: false
}

const ANALYTICS_CHART_COLORS = {
  traffic: '#22c55e',
  visitors: '#38bdf8',
  sessions: '#f59e0b',
  registrations: '#a78bfa',
  prospects: '#c084fc',
  identified: '#10b981',
  returning: '#f43f5e',
  messages: '#25d366',
  appointments: '#f59e0b',
  attendances: '#60a5fa',
  customers: '#34d399'
}

type ConversionStage = 'prospect' | 'appointment_scheduled' | 'appointment_attended' | 'customer'

const CONVERSION_STAGES: ConversionStage[] = [
  'prospect',
  'appointment_scheduled',
  'appointment_attended',
  'customer'
]

const MESSAGE_FILTER_FIELDS = new Set(['message_channel', 'message_source'])

const isMessageFilterField = (field: string) => MESSAGE_FILTER_FIELDS.has(field)

const hasSelectedFilters = (filters: Record<string, string[]>) =>
  Object.values(filters).some(values => values.length > 0)

const hasSelectedWebFilters = (filters: Record<string, string[]>) =>
  Object.entries(filters).some(([field, values]) => !isMessageFilterField(field) && values.length > 0)

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes'
  }
  return false
}

const getSessionConversionStage = (session: Session): ConversionStage | null => {
  const hasContact = Boolean(session.contact_id || session.contact_created_at)
  if (!hasContact) return null

  if (
    toNumber(session.contact_purchases_count) > 0 ||
    toNumber(session.contact_total_paid) > 0
  ) {
    return 'customer'
  }

  if (toBoolean(session.contact_has_attended_appointment)) {
    return 'appointment_attended'
  }

  if (
    toBoolean(session.contact_has_appointment) ||
    Boolean(session.contact_appointment_date)
  ) {
    return 'appointment_scheduled'
  }

  return 'prospect'
}

const TRACKING_VIEW_EVENTS = new Set(['session_start', 'page_view', 'native_site_view'])

const isTrackingViewEvent = (session: Session) =>
  TRACKING_VIEW_EVENTS.has(session.event_name || 'page_view')

const isNativeSiteSession = (session: Session) =>
  (session.tracking_source || '').toLowerCase() === 'native_site' || Boolean(session.site_id)

const getTrackingSourceValue = (session: Session) =>
  isNativeSiteSession(session) ? 'native_site' : 'external_pixel'

const getTrackingSourceLabel = (source: string) =>
  source === 'native_site' ? 'Sites nativos' : 'Pixel externo'

const getSiteTypeLabel = (siteType?: string | null) => {
  if (siteType === 'landing_page') return 'Landing'
  if (siteType === 'interactive_form') return 'Formulario interactivo'
  if (siteType === 'standard_form') return 'Formulario'
  return 'Sin tipo'
}

const normalizeTrafficChannelValue = (channel?: string | null) => {
  const normalized = String(channel || '').trim().toLowerCase()
  if (!normalized) return 'direct'
  if (['paid', 'cpc', 'ppc', 'sem', 'ads', 'ad'].some(token => normalized.includes(token))) return 'paid'
  if (normalized.includes('organic')) return 'organic'
  if (normalized.includes('social')) return 'social'
  if (normalized.includes('email') || normalized.includes('correo')) return 'email'
  if (normalized.includes('referral')) return 'referral'
  if (normalized.includes('direct')) return 'direct'
  return normalized
}

const getTrafficChannelLabel = (channel?: string | null) => {
  const value = normalizeTrafficChannelValue(channel)
  if (value === 'paid') return 'Pagado'
  if (value === 'organic') return 'Orgánico'
  if (value === 'social') return 'Social'
  if (value === 'email') return 'Email'
  if (value === 'referral') return 'Referido'
  if (value === 'direct') return 'Directo'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const getMessageFilterData = (summary?: MessageAnalyticsSummary | null) => ({
  messageChannels: summary?.filters?.channels || [],
  messageSources: summary?.filters?.sources || []
})

const hasAvailableFilterOptions = (data: Record<string, unknown>) =>
  Object.values(data).some(value => Array.isArray(value) && value.length > 0)

const getNativeFormId = (session: Session) => {
  if (session.form_site_id) return session.form_site_id
  if (session.site_type === 'standard_form' || session.site_type === 'interactive_form') return session.site_id || ''
  return ''
}

const getNativeFormName = (session: Session) => {
  if (session.form_site_name) return session.form_site_name
  if (session.site_type === 'standard_form' || session.site_type === 'interactive_form') return session.site_name || session.site_slug || 'Formulario'
  return ''
}

const getNativeConversionFilterValue = (session: Session) => {
  if (session.event_name !== 'native_site_conversion') return ''
  const formId = getNativeFormId(session)
  return formId ? `form:${formId}` : `site:${session.site_id || ''}`
}

const parseTimestamp = (timestamp?: string | null): Date | null => {
  if (!timestamp) return null

  const trimmed = timestamp.trim()
  if (!trimmed) return null

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')

  const direct = new Date(normalized)
  if (!Number.isNaN(direct.getTime())) {
    return direct
  }

  const utcFallback = new Date(`${normalized}Z`)
  if (!Number.isNaN(utcFallback.getTime())) {
    return utcFallback
  }

  return null
}

const formatPeriodLabel = (period: string, viewType: ViewType): string => {
  if (!period) return ''

  if (viewType === 'year') {
    return period
  }

  if (viewType === 'month') {
    const [year, month] = period.split('-')
    const monthIndex = Number(month) - 1
    if (!year || Number.isNaN(monthIndex)) return period
    return `${monthNamesShort[monthIndex] || month} ${year}`
  }

  const date = parseLocalDateString(period.includes('T') ? period.split('T')[0] : period)
  if (Number.isNaN(date.getTime())) return period
  return `${date.getDate()} ${monthNamesShort[date.getMonth()]} ${date.getFullYear()}`
}

const getPeriodKeyFromDate = (date: Date, viewType: ViewType): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')

  if (viewType === 'year') {
    return String(year)
  }

  if (viewType === 'month') {
    return `${year}-${month}`
  }

  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const getPeriodRange = (period: string, viewType: ViewType) => {
  if (viewType === 'year') {
    return { from: `${period}-01-01`, to: `${period}-12-31` }
  }

  if (viewType === 'month') {
    const [yearRaw, monthRaw] = period.split('-')
    const year = Number(yearRaw)
    const month = Number(monthRaw)
    const start = new Date(year, month - 1, 1)
    const end = new Date(year, month, 0)
    return { from: formatDateToISO(start), to: formatDateToISO(end) }
  }

  return { from: period, to: period }
}

const getPeriodPointMeta = (period: string, viewType: ViewType) => {
  const range = getPeriodRange(period, viewType)
  return {
    periodKey: period,
    periodStart: range.from,
    periodEnd: range.to
  }
}

const normalizePeriodKey = (period: string, viewType: ViewType): string | null => {
  if (!period) return null
  const sanitized = period.includes('T') ? period.split('T')[0] : period

  if (viewType === 'year') {
    const year = sanitized.slice(0, 4)
    return /^\d{4}$/.test(year) ? year : null
  }

  if (viewType === 'month') {
    const match = sanitized.match(/^(\d{4})-(\d{2})/)
    return match ? `${match[1]}-${match[2]}` : null
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(sanitized)) return sanitized
  const parsed = parseLocalDateString(sanitized)
  return Number.isNaN(parsed.getTime()) ? null : getPeriodKeyFromDate(parsed, viewType)
}

const buildCompletePeriodItems = (
  range: { from: string; to: string },
  viewType: ViewType
) => {
  const start = parseLocalDateString(range.from)
  const end = parseLocalDateString(range.to)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return []
  }

  const items: Array<{
    period: string
    label: string
    periodStart: string
    periodEnd: string
  }> = []

  const cursor = viewType === 'year'
    ? startOfYear(start.getFullYear())
    : viewType === 'month'
      ? startOfMonth(start.getFullYear(), start.getMonth())
      : new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const last = viewType === 'year'
    ? startOfYear(end.getFullYear())
    : viewType === 'month'
      ? startOfMonth(end.getFullYear(), end.getMonth())
      : new Date(end.getFullYear(), end.getMonth(), end.getDate())

  while (cursor <= last) {
    const period = getPeriodKeyFromDate(cursor, viewType)
    const meta = getPeriodPointMeta(period, viewType)
    items.push({
      period,
      label: formatPeriodLabel(period, viewType),
      periodStart: meta.periodStart,
      periodEnd: meta.periodEnd
    })

    if (viewType === 'year') {
      cursor.setFullYear(cursor.getFullYear() + 1)
    } else if (viewType === 'month') {
      cursor.setMonth(cursor.getMonth() + 1)
    } else {
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  return items
}

const completeTrafficPeriods = (
  data: TrafficPoint[],
  viewType: ViewType,
  range: { from: string; to: string }
): TrafficPoint[] => {
  const periods = buildCompletePeriodItems(range, viewType)
  if (periods.length === 0) return data

  const byPeriod = new Map(data.map(item => [item.periodKey || normalizePeriodKey(item.label, viewType) || item.label, item]))
  return periods.map(item => ({
    value: 0,
    value2: 0,
    ...getPeriodPointMeta(item.period, viewType),
    ...byPeriod.get(item.period),
    label: item.label
  }))
}

const completeSessionTrendPeriods = (
  data: SessionTrendPoint[],
  viewType: ViewType,
  range: { from: string; to: string }
): SessionTrendPoint[] => {
  const periods = buildCompletePeriodItems(range, viewType)
  if (periods.length === 0) return data

  const byPeriod = new Map(data.map(item => [item.periodKey || normalizePeriodKey(item.label, viewType) || item.label, item]))
  return periods.map(item => ({
    ...getPeriodPointMeta(item.period, viewType),
    pageViews: 0,
    uniqueVisitors: 0,
    uniqueSessions: 0,
    identifiedContacts: 0,
    returningVisitors: 0,
    ...byPeriod.get(item.period),
    label: item.label
  }))
}

const completeConversionTrendPeriods = (
  data: ConversionTrendPoint[],
  viewType: ViewType,
  range: { from: string; to: string }
): ConversionTrendPoint[] => {
  const periods = buildCompletePeriodItems(range, viewType)
  if (periods.length === 0) return data

  const byPeriod = new Map(data.map(item => [item.periodKey || normalizePeriodKey(item.label, viewType) || item.label, item]))
  return periods.map(item => ({
    ...getPeriodPointMeta(item.period, viewType),
    prospects: 0,
    registrations: 0,
    appointments: 0,
    attendances: 0,
    customers: 0,
    ...byPeriod.get(item.period),
    label: item.label
  }))
}

const buildMessageTrendData = (
  summary: MessageAnalyticsSummary | null,
  viewType: ViewType,
  range: { from: string; to: string }
): TrafficPoint[] => {
  const messagesByPeriod = new Map<string, number>()

  ;(summary?.trend || []).forEach(item => {
    const period = normalizePeriodKey(String(item.label || ''), viewType)
    if (!period) return
    messagesByPeriod.set(period, (messagesByPeriod.get(period) || 0) + Number(item.messages || 0))
  })

  return completeTrafficPeriods(
    Array.from(messagesByPeriod.entries()).map(([period, messages]) => ({
      label: formatPeriodLabel(period, viewType),
      value: messages,
      value2: 0,
      ...getPeriodPointMeta(period, viewType)
    })),
    viewType,
    range
  )
}

const countYearBucketsInRange = (range: { start: Date; end: Date }) => (
  Math.max(0, range.end.getFullYear() - range.start.getFullYear() + 1)
)

const shouldShowYearView = (
  monthPreset: MonthPreset,
  baseRange: { start: Date; end: Date },
  currentViewType: ViewType,
  datePreset?: string,
  selectedYearRange?: { start: number; end: number }
) => {
  const customDateRangeHasYears = countYearBucketsInRange(baseRange) > 1
  const explicitYearRangeHasYears = Boolean(selectedYearRange && selectedYearRange.end > selectedYearRange.start)

  return (
    monthPreset === 'all' ||
    (monthPreset === 'custom' && (customDateRangeHasYears || (currentViewType === 'year' && explicitYearRangeHasYears))) ||
    (currentViewType === 'day' && datePreset === 'custom' && customDateRangeHasYears)
  )
}

const formatRangeLabel = (from: string, to: string) => {
  if (from === to) return formatPeriodLabel(from, 'day')
  return `${formatPeriodLabel(from, 'day')} – ${formatPeriodLabel(to, 'day')}`
}

const getPeriodKeyFromTimestamp = (
  timestamp: string | null | undefined,
  viewType: ViewType,
  convertToLocalTime: (utcDate: string | Date) => Date
): string | null => {
  const parsed = parseTimestamp(timestamp)
  if (!parsed) return null
  const localDate = convertToLocalTime(parsed)
  if (Number.isNaN(localDate.getTime())) return null
  return getPeriodKeyFromDate(localDate, viewType)
}

const buildTrafficChartData = (
  sessions: Session[],
  viewType: ViewType,
  convertToLocalTime: (utcDate: string | Date) => Date
): TrafficPoint[] => {
  const stats: Record<string, { totalVisits: number; uniqueVisitors: Set<string> }> = {}

  sessions.forEach((session: Session) => {
    if (!isTrackingViewEvent(session)) return

    const periodKey = getPeriodKeyFromTimestamp(session.started_at, viewType, convertToLocalTime)
    if (!periodKey) return

    if (!stats[periodKey]) {
      stats[periodKey] = {
        totalVisits: 0,
        uniqueVisitors: new Set()
      }
    }

    stats[periodKey].totalVisits++
    stats[periodKey].uniqueVisitors.add(session.visitor_id)
  })

  return Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, item]) => ({
      label: formatPeriodLabel(period, viewType),
      value: item.totalVisits,
      value2: item.uniqueVisitors.size,
      ...getPeriodPointMeta(period, viewType)
    }))
}

const aggregateContactsByPeriod = (
  contacts: ContactsByDate[],
  viewType: ViewType
) => {
  const totals = new Map<string, number>()

  contacts.forEach((item) => {
    const date = parseLocalDateString(item.date)
    if (Number.isNaN(date.getTime())) return

    const periodKey = getPeriodKeyFromDate(date, viewType)
    totals.set(periodKey, (totals.get(periodKey) || 0) + item.count)
  })

  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count, ...getPeriodPointMeta(period, viewType) }))
}

const aggregateContactConversionsByPeriod = (
  rows: ContactConversionsByDate[],
  viewType: ViewType
): ConversionTrendPoint[] => {
  const totals = new Map<string, ConversionTrendBucket>()

  rows.forEach((item) => {
    const date = parseLocalDateString(item.date)
    if (Number.isNaN(date.getTime())) return

    const periodKey = getPeriodKeyFromDate(date, viewType)
    const bucket = totals.get(periodKey) || {
      prospects: 0,
      registrations: 0,
      appointments: 0,
      attendances: 0,
      customers: 0
    }

    bucket.prospects += Number(item.prospects || 0)
    bucket.registrations += Number(item.registrations || 0)
    bucket.appointments += Number(item.appointments || 0)
    bucket.attendances += Number(item.attendances || 0)
    bucket.customers += Number(item.customers || 0)

    totals.set(periodKey, bucket)
  })

  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, bucket]) => ({
      label: formatPeriodLabel(period, viewType),
      ...getPeriodPointMeta(period, viewType),
      prospects: bucket.prospects,
      registrations: bucket.registrations,
      appointments: bucket.appointments,
      attendances: bucket.attendances,
      customers: bucket.customers
    }))
}

const buildSessionTrendData = (
  sessions: Session[],
  viewType: ViewType,
  convertToLocalTime: (utcDate: string | Date) => Date
): SessionTrendPoint[] => {
  const stats = new Map<string, {
    pageViews: number
    visitors: Set<string>
    sessionIds: Set<string>
    contactIds: Set<string>
    visitorSessions: Map<string, Set<string>>
  }>()

  sessions.forEach((session) => {
    const periodKey = getPeriodKeyFromTimestamp(session.started_at, viewType, convertToLocalTime)
    if (!periodKey) return

    if (!stats.has(periodKey)) {
      stats.set(periodKey, {
        pageViews: 0,
        visitors: new Set(),
        sessionIds: new Set(),
        contactIds: new Set(),
        visitorSessions: new Map()
      })
    }

    const bucket = stats.get(periodKey)!
    if (isTrackingViewEvent(session)) {
      bucket.pageViews++
      bucket.visitors.add(session.visitor_id)
      bucket.sessionIds.add(session.session_id)
    }

    if (session.contact_id) {
      bucket.contactIds.add(session.contact_id)
    }

    if (!bucket.visitorSessions.has(session.visitor_id)) {
      bucket.visitorSessions.set(session.visitor_id, new Set())
    }
    bucket.visitorSessions.get(session.visitor_id)!.add(session.session_id)
  })

  return Array.from(stats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, bucket]) => ({
      label: formatPeriodLabel(period, viewType),
      ...getPeriodPointMeta(period, viewType),
      pageViews: bucket.pageViews,
      uniqueVisitors: bucket.visitors.size,
      uniqueSessions: bucket.sessionIds.size,
      identifiedContacts: bucket.contactIds.size,
      returningVisitors: Array.from(bucket.visitorSessions.values()).filter(sessionSet => sessionSet.size > 1).length
    }))
}

const hasCustomerConversion = (session: Session) =>
  toNumber(session.contact_purchases_count) > 0 || toNumber(session.contact_total_paid) > 0

const hasAttendedConversion = (session: Session) =>
  toBoolean(session.contact_has_attended_appointment)

const hasAppointmentConversion = (session: Session) =>
  toBoolean(session.contact_has_appointment) || Boolean(session.contact_appointment_date)

const buildConversionTrendData = (
  sessions: Session[],
  viewType: ViewType,
  convertToLocalTime: (utcDate: string | Date) => Date
): ConversionTrendPoint[] => {
  const stats = new Map<string, {
    prospects: Set<string>
    registrations: Set<string>
    appointments: Set<string>
    attendances: Set<string>
    customers: Set<string>
  }>()

  sessions.forEach((session) => {
    if (!session.contact_created_at) return

    const periodKey = getPeriodKeyFromTimestamp(
      session.contact_created_at,
      viewType,
      convertToLocalTime
    )
    if (!periodKey) return

    if (!stats.has(periodKey)) {
      stats.set(periodKey, {
        prospects: new Set(),
        registrations: new Set(),
        appointments: new Set(),
        attendances: new Set(),
        customers: new Set()
      })
    }

    const contactKey = session.contact_id || `${session.visitor_id}:${session.email || session.full_name || 'unknown'}`
    const bucket = stats.get(periodKey)!

    bucket.registrations.add(contactKey)

    if (hasAppointmentConversion(session)) {
      bucket.appointments.add(contactKey)
    }

    if (hasAttendedConversion(session)) {
      bucket.attendances.add(contactKey)
    }

    if (hasCustomerConversion(session)) {
      bucket.customers.add(contactKey)
      return
    }

    if (!hasAppointmentConversion(session) && !hasAttendedConversion(session)) {
      bucket.prospects.add(contactKey)
    }
  })

  return Array.from(stats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, bucket]) => ({
      label: formatPeriodLabel(period, viewType),
      ...getPeriodPointMeta(period, viewType),
      prospects: bucket.prospects.size,
      registrations: bucket.registrations.size,
      appointments: bucket.appointments.size,
      attendances: bucket.attendances.size,
      customers: bucket.customers.size
    }))
}

const mergeVisitorRegistrationData = (
  trafficData: TrafficPoint[],
  conversionData: Array<{ label: string; value: number; periodKey?: string; periodStart?: string; periodEnd?: string }>
): TrafficPoint[] => {
  const trafficByLabel = new Map(trafficData.map(item => [item.label, item]))
  const conversionByLabel = new Map(conversionData.map(item => [item.label, item]))
  const labels = [
    ...trafficData.map(item => item.label),
    ...conversionData.map(item => item.label).filter(label => !trafficByLabel.has(label))
  ]

  return labels.map(label => {
    const traffic = trafficByLabel.get(label)
    const conversion = conversionByLabel.get(label)
    return {
      label,
      value: traffic?.value2 || 0,
      value2: Number(conversion?.value || 0),
      periodKey: traffic?.periodKey || conversion?.periodKey,
      periodStart: traffic?.periodStart || conversion?.periodStart,
      periodEnd: traffic?.periodEnd || conversion?.periodEnd
    }
  })
}

const mergeMessagesWithAppointments = (
  waData: TrafficPoint[],
  convData: ConversionTrendPoint[]
): TrafficPoint[] => {
  const waByLabel = new Map(waData.map(item => [item.label, item]))
  const convByLabel = new Map(convData.map(item => [item.label, item]))
  const labels = [
    ...waData.map(item => item.label),
    ...convData.map(item => item.label).filter(label => !waByLabel.has(label))
  ]
  return labels.map(label => {
    const wa = waByLabel.get(label)
    const conversion = convByLabel.get(label)
    return {
      label,
      value: wa?.value || 0,
      value2: conversion?.appointments || 0,
      periodKey: conversion?.periodKey || wa?.periodKey,
      periodStart: conversion?.periodStart || wa?.periodStart,
      periodEnd: conversion?.periodEnd || wa?.periodEnd
    }
  })
}

const mapTrendToChartData = <T extends { label: string }>(
  trendData: T[],
  valueKey: keyof T,
  value2Key: keyof T
): TrafficPoint[] => trendData.map(item => {
  const point = item as T & Partial<Pick<TrafficPoint, 'periodKey' | 'periodStart' | 'periodEnd'>>
  return {
    label: item.label,
    value: Number(item[valueKey] || 0),
    value2: Number(item[value2Key] || 0),
    periodKey: point.periodKey,
    periodStart: point.periodStart,
    periodEnd: point.periodEnd
  }
})

const sessionMatchesContactConversionType = (session: Session, type: ContactConversionListType) => {
  if (type === 'registrations') return true
  if (type === 'customers') return hasCustomerConversion(session)
  if (type === 'appointments') return hasAppointmentConversion(session)
  if (type === 'attendances') return hasAttendedConversion(session)
  return !hasCustomerConversion(session) && !hasAppointmentConversion(session) && !hasAttendedConversion(session)
}

const optionalString = (value?: string | null) => value || undefined

const buildFilteredContactListFromSessions = (
  sessions: Session[],
  viewType: ViewType,
  convertToLocalTime: (utcDate: string | Date) => Date,
  periodKey: string,
  type: ContactConversionListType
): ContactListItem[] => {
  const contacts = new Map<string, ContactListItem>()

  sessions.forEach((session) => {
    if (!session.contact_created_at) return

    const contactPeriodKey = getPeriodKeyFromTimestamp(session.contact_created_at, viewType, convertToLocalTime)
    if (contactPeriodKey !== periodKey) return
    if (!sessionMatchesContactConversionType(session, type)) return

    const contactId = session.contact_id || `${session.visitor_id}:${session.email || session.full_name || session.contact_created_at}`
    if (contacts.has(contactId)) return

    const ltv = toNumber(session.contact_total_paid)
    const purchases = toNumber(session.contact_purchases_count)
    const source = optionalString(session.site_source_name || session.source_platform || session.utm_source)

    contacts.set(contactId, {
      id: contactId,
      name: session.full_name || '',
      email: session.email || '',
      phone: '',
      created_at: session.contact_created_at,
      ltv,
      purchases,
      attributed: Boolean(session.ad_id || session.campaign_id || session.utm_campaign),
      payments: [],
      appointments: [],
      source,
      ad_name: optionalString(session.ad_name),
      ad_id: optionalString(session.ad_id),
      campaign_id: optionalString(session.campaign_id),
      campaign_name: optionalString(session.campaign_name),
      adset_id: optionalString(session.adset_id),
      adset_name: optionalString(session.adset_name),
      lifetimeLtv: ltv,
      lifetimePurchases: purchases,
      isCustomer: hasCustomerConversion(session),
      hasAppointments: hasAppointmentConversion(session),
      hasShowedAppointment: hasAttendedConversion(session),
      hasAttendedAppointment: hasAttendedConversion(session),
      firstSession: {
        started_at: session.started_at,
        page_url: optionalString(session.page_url),
        referrer_url: optionalString(session.referrer_url),
        utm_source: optionalString(session.utm_source),
        utm_medium: optionalString(session.utm_medium),
        utm_campaign: optionalString(session.utm_campaign),
        utm_content: optionalString(session.utm_content),
        utm_term: optionalString(session.utm_term),
        source_platform: optionalString(session.source_platform),
        site_source_name: optionalString(session.site_source_name),
        campaign_name: optionalString(session.campaign_name),
        ad_name: optionalString(session.ad_name),
        ad_id: optionalString(session.ad_id),
        device_type: optionalString(session.device_type),
        browser: optionalString(session.browser),
        geo_city: optionalString(session.geo_city),
        geo_region: optionalString(session.geo_region),
        geo_country: optionalString(session.geo_country)
      }
    })
  })

  return Array.from(contacts.values()).sort((a, b) => {
    const dateA = parseTimestamp(a.created_at)?.getTime() ?? 0
    const dateB = parseTimestamp(b.created_at)?.getTime() ?? 0
    return dateB - dateA
  })
}

const Analytics: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeState = React.useMemo(() => parseAnalyticsRoute(location.pathname), [location.pathname])
  const routeMonthPreset = React.useMemo<MonthPreset>(
    () => isAnalyticsMonthPreset(searchParams.get('preset')) ? searchParams.get('preset') as MonthPreset : 'last12',
    [searchParams]
  )
  const { dateRange, setDateRange } = useDateRange()
  const { convertToLocalTime, timezone } = useTimezone()
  const businessToday = React.useMemo(() => getBusinessToday(timezone), [timezone])
  const defaultYearRange = React.useMemo(
    () => getDefaultYearRange(businessToday.getFullYear()),
    [businessToday]
  )
  const routeYearRange = React.useMemo(() => {
    const nextRange = {
      start: readNumberParam(searchParams, 'yearStart', defaultYearRange.start, { min: 2000, max: 2100 }),
      end: readNumberParam(searchParams, 'yearEnd', defaultYearRange.end, { min: 2000, max: 2100 })
    }

    return nextRange.start <= nextRange.end ? nextRange : defaultYearRange
  }, [defaultYearRange, searchParams])
  const { labels: appLabels } = useLabels()
  const [loading, setLoading] = useState(false)
  const [hasLoadedAnalytics, setHasLoadedAnalytics] = useState(false)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(false)
  const [messageAnalytics, setMessageAnalytics] = useState<MessageAnalyticsSummary | null>(null)

  const leadLabel = appLabels.lead?.trim() || 'Prospecto'
  const leadsLabel = appLabels.leads?.trim() || `${leadLabel}s`
  const customerLabel = appLabels.customer?.trim() || 'Cliente'
  const customersLabel = appLabels.customers?.trim() || `${customerLabel}s`
  const leadsLabelLower = leadsLabel.toLocaleLowerCase('es-MX')
  const customersLabelLower = customersLabel.toLocaleLowerCase('es-MX')
  const newContactsLabel = 'Contactos nuevos'
  const newContactsLabelLower = newContactsLabel.toLocaleLowerCase('es-MX')

  const conversionFilters = React.useMemo<Array<{ stage: ConversionStage; label: string }>>(() => [
    { stage: 'prospect', label: leadsLabel },
    { stage: 'appointment_scheduled', label: 'Agendaron cita' },
    { stage: 'appointment_attended', label: 'Citas asistidas' },
    { stage: 'customer', label: customersLabel }
  ], [customersLabel, leadsLabel])

  // Estado para filtros
  const [selectedFilters, setSelectedFilters] = useUrlFilterState('filters')
  const [availableFilterData, setAvailableFilterData] = useState<any>({})
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  // Estado para visualizaciones
  const [dailyTraffic, setDailyTraffic] = useState<TrafficPoint[]>([])
  const [dailyConversions, setDailyConversions] = useState<any[]>([])
  const [contactConversionsByDate, setContactConversionsByDate] = useState<ContactConversionsByDate[]>([])
  const [contactModalState, setContactModalState] = useState<AnalyticsContactModalState>(emptyContactModalState)
  const [platformsData, setPlatformsData] = useState<any[]>([])
  const [placementsData, setPlacementsData] = useState<any[]>([])
  const [devicesData, setDevicesData] = useState<any[]>([])
  const [osData, setOsData] = useState<any[]>([])
  const [browserData, setBrowserData] = useState<any[]>([])
  const [topVisitors, setTopVisitors] = useState<any[]>([])
  const [viewType, setViewType] = useState<ViewType>(routeState.viewType)
  const [monthPreset, setMonthPreset] = useState<MonthPreset>(routeMonthPreset)
  const [yearRange, setYearRange] = useState(routeYearRange)
  const [selectedMainChartView, setSelectedMainChartView] = useState<AnalyticsMainChartView>(routeState.mainChart)
  const [selectedConversionChartView, setSelectedConversionChartView] = useState<AnalyticsConversionChartView>(routeState.conversionChart)

  const navigateAnalyticsView = useCallback((next?: {
    viewType?: ViewType
    mainChart?: AnalyticsMainChartView
    conversionChart?: AnalyticsConversionChartView
    replace?: boolean
    search?: string
  }) => {
    navigate({
      pathname: buildAnalyticsPath(
      next?.viewType ?? viewType,
      next?.mainChart ?? selectedMainChartView,
      next?.conversionChart ?? selectedConversionChartView
      ),
      search: next?.search ?? location.search
    }, { replace: next?.replace })
  }, [location.search, navigate, selectedConversionChartView, selectedMainChartView, viewType])

  useEffect(() => {
    setViewType(current => current === routeState.viewType ? current : routeState.viewType)
    setSelectedMainChartView(current => current === routeState.mainChart ? current : routeState.mainChart)
    setSelectedConversionChartView(current => current === routeState.conversionChart ? current : routeState.conversionChart)
  }, [routeState.conversionChart, routeState.mainChart, routeState.viewType])

  useEffect(() => {
    setMonthPreset(current => current === routeMonthPreset ? current : routeMonthPreset)
    setYearRange(current => (
      current.start === routeYearRange.start && current.end === routeYearRange.end
        ? current
        : routeYearRange
    ))
  }, [routeMonthPreset, routeYearRange])

  useUrlDateRangeSync({
    dateRange,
    setDateRange,
    enabled: viewType === 'day' || (viewType === 'month' && monthPreset === 'custom')
  })

  // Guardar el valor ORIGINAL de registros para restaurar al quitar filtros
  const [originalRegistros, setOriginalRegistros] = useState<number>(0)

  const [metrics, setMetrics] = useState<Metrics>({
    pageViews: 0,
    uniqueVisitors: 0,
    registros: 0,
    conversionRate: 0,
    returningUsers: 0,
    avgPagePerSession: 0,
    trends: {
      pageViews: 0,
      uniqueVisitors: 0,
      registros: 0,
      conversionRate: 0,
      returningUsers: 0,
      avgPagePerSession: 0
    }
  })

  // Memoizar funciones de formato para evitar re-renders infinitos
  const formatTrafficAxis = useCallback((value: number) => formatChartNumber(value), [])

  const formatTrafficTooltipValue = useCallback((value: number) => value.toLocaleString('es-MX'), [])

  const formatTrafficTooltip = useCallback((value: number, _key: string) => formatTrafficTooltipValue(value), [formatTrafficTooltipValue])

  const baseRange = {
    start: normalizeDateInputToLocalDate(dateRange.start, { timezone }),
    end: normalizeDateInputToLocalDate(dateRange.end, { timezone })
  }

  const apiRange = computeRangeForView(viewType, baseRange, monthPreset, yearRange, businessToday)
  const canShowYearView = shouldShowYearView(monthPreset, baseRange, viewType, dateRange.preset, yearRange)
  const availableViewTabs = React.useMemo(
    () => canShowYearView ? viewTabs : viewTabs.filter(tab => tab.value !== 'year'),
    [canShowYearView]
  )
  useEffect(() => {
    if (viewType !== 'year' || canShowYearView) return
    setViewType('month')
    navigateAnalyticsView({ viewType: 'month', replace: true })
  }, [canShowYearView, navigateAnalyticsView, viewType])

  const messageSummaryFilters = React.useMemo(() => ({
    channels: selectedFilters.message_channel || [],
    sources: selectedFilters.message_source || []
  }), [selectedFilters.message_channel, selectedFilters.message_source])
  const messageSummaryFilterKey = React.useMemo(
    () => JSON.stringify(messageSummaryFilters),
    [messageSummaryFilters]
  )

  // Cargar datos cuando cambie el rango de fechas
  useEffect(() => {
    const fetchAnalytics = async () => {
      setLoading(true)
      try {
        // No agregar +1 día aquí, el backend ya lo maneja con INTERVAL '1 day'
        const startDate = apiRange.from
        const endDate = apiRange.to

        // Calcular período anterior para comparación
        const msPerDay = 24 * 60 * 60 * 1000
        const currentStart = parseLocalDateString(startDate)
        const currentEnd = parseLocalDateString(endDate)
        const periodLength = Math.round((currentEnd.getTime() - currentStart.getTime()) / msPerDay)
        const previousEnd = new Date(currentStart)
        previousEnd.setDate(previousEnd.getDate() - 1)
        const previousStart = new Date(previousEnd)
        previousStart.setDate(previousStart.getDate() - periodLength)

        const prevStartDate = formatDateToISO(previousStart)
        const prevEndDate = formatDateToISO(previousEnd)

        // Fetch datos del período actual y anterior
        const [
          currentSessions,
          prevSessionMetrics,
          contactsData,
          prevContactsData,
          contactConversionRows,
          trackingConfig,
          messageSummary
        ] = await Promise.all([
          getSessionsByDateRange(startDate, endDate, { payload: 'analytics' }),
          getSessionMetricsByDateRange(prevStartDate, prevEndDate),
          getContactsByDate(startDate, endDate),
          getContactsByDate(prevStartDate, prevEndDate),
          getContactConversionsByDate(startDate, endDate),
          trackingService.getTrackingConfig().catch(() => null),
          getMessageAnalyticsSummary(startDate, endDate, viewType, messageSummaryFilters).catch(() => null)
        ])

        setWebTrackingConfigured(Boolean(
          trackingConfig?.isConfigured ||
          trackingConfig?.hasPublicSites ||
          currentSessions.length > 0
        ))
        setMessageAnalytics(messageSummary)
        setContactConversionsByDate(contactConversionRows || [])

        if (currentSessions.length > 0) {
          const currentViewSessions = currentSessions.filter(isTrackingViewEvent)
          // Calcular métricas principales
          const uniqueVids = new Set(currentViewSessions.map((s: Session) => s.visitor_id)).size

          const totalPageViews = currentViewSessions.length

          // Contar sesiones únicas (por session_id)
          const uniqueSessionIds = new Set(currentViewSessions.map((s: Session) => s.session_id)).size

          // Registros = contactos con visitor_id creados en el período (con fallback a array vacío)
          const registros = (contactsData || []).reduce((sum, item) => sum + item.count, 0)

          // Guardar valor ORIGINAL para restaurar al quitar filtros
          setOriginalRegistros(registros)

          const conversionRate = uniqueVids > 0 ? ((registros / uniqueVids) * 100) : 0

          // Usuarios recurrentes: contar visitor_ids que tienen múltiples session_ids diferentes
          const visitorSessionMap: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((s: Session) => {
            if (!visitorSessionMap[s.visitor_id]) {
              visitorSessionMap[s.visitor_id] = new Set()
            }
            visitorSessionMap[s.visitor_id].add(s.session_id)
          })
          const returningUsers = Object.values(visitorSessionMap).filter(sessions => sessions.size > 1).length

          // Páginas por sesión = total de page_views / número de sesiones únicas
          const avgPagePerSession = uniqueSessionIds > 0 ?
            (totalPageViews / uniqueSessionIds) : 0

          // Calcular métricas del período anterior para trends
          const prevUniqueVids = prevSessionMetrics.uniqueVisitors
          const prevTotalPageViews = prevSessionMetrics.pageViews
          const prevUniqueSessionIds = prevSessionMetrics.uniqueSessions
          const prevRegistros = (prevContactsData || []).reduce((sum, item) => sum + item.count, 0)
          const prevConversionRate = prevUniqueVids > 0 ? ((prevRegistros / prevUniqueVids) * 100) : 0

          const prevReturningUsers = prevSessionMetrics.returningUsers
          const prevAvgPagePerSession = prevUniqueSessionIds > 0 ?
            (prevTotalPageViews / prevUniqueSessionIds) : 0

          // Calcular trends
          const calculateTrend = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0
            return ((current - previous) / Math.abs(previous)) * 100
          }

          setMetrics({
            pageViews: totalPageViews,
            uniqueVisitors: uniqueVids,
            registros,
            conversionRate,
            returningUsers,
            avgPagePerSession,
            trends: {
              pageViews: calculateTrend(totalPageViews, prevTotalPageViews),
              uniqueVisitors: calculateTrend(uniqueVids, prevUniqueVids),
              registros: calculateTrend(registros, prevRegistros),
              conversionRate: calculateTrend(conversionRate, prevConversionRate),
              returningUsers: calculateTrend(returningUsers, prevReturningUsers),
              avgPagePerSession: calculateTrend(avgPagePerSession, prevAvgPagePerSession)
            }
          })

          // Preparar datos para gráfico de tráfico por período
          setDailyTraffic(completeTrafficPeriods(
            buildTrafficChartData(
              currentSessions,
              viewType,
              convertToLocalTime
            ),
            viewType,
            { from: startDate, to: endDate }
          ))

          // Gráfico de conversiones (registros reales de contactos por fecha de creación)
          const conversionChartData = aggregateContactsByPeriod(contactsData || [], viewType)
            .map(item => ({
              label: formatPeriodLabel(item.period, viewType),
              value: item.count,
              value2: 0,
              periodKey: item.periodKey,
              periodStart: item.periodStart,
              periodEnd: item.periodEnd
            }))

          setDailyConversions(completeTrafficPeriods(conversionChartData, viewType, { from: startDate, to: endDate }))

          // Guardar todas las sesiones y sesiones filtradas (ordenadas de más reciente a más vieja)
          const sortedSessions = [...currentSessions].sort((a, b) => {
            const dateA = parseTimestamp(a.started_at)?.getTime() ?? 0
            const dateB = parseTimestamp(b.started_at)?.getTime() ?? 0
            return dateB - dateA // DESC: más reciente primero
          })
          setAllSessions(sortedSessions)
          setSessions(sortedSessions)

          // Recopilar datos disponibles para el TreeFilter
          const filterData: any = {
            pages: [],
            campaigns: [],
            ads: [],
            sources: [],
            devices: [],
            browsers: [],
            os: [],
            placements: [],
            conversions: [],
            trafficChannels: [],
            trackingSources: [],
            ...getMessageFilterData(messageSummary),
            siteTypes: [],
            nativeSites: [],
            nativeForms: [],
            nativeConversions: []
          }

          // Páginas
          const pageMap: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            if (!isTrackingViewEvent(session)) return

            if (session.page_url) {
              const urlPath = session.page_url.split('?')[0]
              const pageName = urlPath.split('/').pop() || 'home'
              pageMap[pageName] = (pageMap[pageName] || 0) + 1
            }
          })

          filterData.pages = Object.entries(pageMap)
            .map(([page, count]) => ({ page, count }))
            .sort((a, b) => b.count - a.count)

          // JERARQUÍA DE ANUNCIOS: Platform → Campaign → Adset → Ad
          interface AdHierarchy {
            platform: string
            platform_id: string
            visitors: Set<string>
            campaigns: Map<string, {
              id: string
              name: string
              visitors: Set<string>
              adsets: Map<string, {
                id: string
                name: string
                visitors: Set<string>
                ads: Map<string, {
                  id: string
                  name: string
                  visitors: Set<string>
                }>
              }>
            }>
          }

          const adsHierarchyMap = new Map<string, AdHierarchy>()

          // Sources, etc. - Contar VISITANTES ÚNICOS por fuente
          const campaignsMap: { [key: string]: Set<string> } = {}
          const adsMap: { [key: string]: Set<string> } = {}
          const sourcesMap: { [key: string]: Set<string> } = {}
          const devicesMap: { [key: string]: Set<string> } = {}
          const browsersMap: { [key: string]: Set<string> } = {}
          const osMap: { [key: string]: Set<string> } = {}
          const placementsMap: { [key: string]: Set<string> } = {}
          const trafficChannelsMap: { [key: string]: Set<string> } = {}
          const trackingSourceMap: { [key: string]: Set<string> } = {}
          const siteTypesMap: { [key: string]: Set<string> } = {}
          const nativeSitesMap: { [key: string]: { name: string; visitors: Set<string> } } = {}
          const nativeFormsMap: { [key: string]: { name: string; visitors: Set<string> } } = {}
          const nativeConversionsMap: { [key: string]: { name: string; conversions: Set<string> } } = {}
          const conversionsMap = CONVERSION_STAGES.reduce<Record<ConversionStage, Set<string>>>((acc, stage) => {
            acc[stage] = new Set()
            return acc
          }, {} as Record<ConversionStage, Set<string>>)

          currentSessions.forEach((session: Session) => {
            const visitorId = session.visitor_id
            const conversionStage = getSessionConversionStage(session)
            const trackingSource = getTrackingSourceValue(session)
            const trafficChannel = normalizeTrafficChannelValue(session.channel)

            if (!trafficChannelsMap[trafficChannel]) trafficChannelsMap[trafficChannel] = new Set()
            trafficChannelsMap[trafficChannel].add(visitorId)

            if (!trackingSourceMap[trackingSource]) trackingSourceMap[trackingSource] = new Set()
            trackingSourceMap[trackingSource].add(visitorId)

            if (isNativeSiteSession(session)) {
              const siteType = session.site_type || 'unknown'
              if (!siteTypesMap[siteType]) siteTypesMap[siteType] = new Set()
              siteTypesMap[siteType].add(visitorId)

              if (session.site_id) {
                if (!nativeSitesMap[session.site_id]) {
                  nativeSitesMap[session.site_id] = {
                    name: session.site_name || session.site_slug || 'Site sin nombre',
                    visitors: new Set()
                  }
                }
                nativeSitesMap[session.site_id].visitors.add(visitorId)
              }

              const formId = getNativeFormId(session)
              if (formId) {
                if (!nativeFormsMap[formId]) {
                  nativeFormsMap[formId] = {
                    name: getNativeFormName(session) || 'Formulario sin nombre',
                    visitors: new Set()
                  }
                }
                nativeFormsMap[formId].visitors.add(visitorId)
              }

              const nativeConversionValue = getNativeConversionFilterValue(session)
              if (nativeConversionValue) {
                const conversionKey = session.submission_id || session.contact_id || visitorId
                const label = nativeConversionValue.startsWith('form:')
                  ? `Formulario: ${getNativeFormName(session) || session.site_name || 'Sin nombre'}`
                  : `Landing: ${session.site_name || session.site_slug || 'Sin nombre'}`
                if (!nativeConversionsMap[nativeConversionValue]) {
                  nativeConversionsMap[nativeConversionValue] = {
                    name: label,
                    conversions: new Set()
                  }
                }
                nativeConversionsMap[nativeConversionValue].conversions.add(conversionKey)
              }
            }

            if (conversionStage) {
              conversionsMap[conversionStage].add(visitorId)
            }

            // Construir jerarquía de anuncios usando UTMs (más confiable que campos específicos)
            // Requerimos al menos utm_source y utm_campaign para construir la jerarquía
            if (session.utm_source && session.utm_campaign) {
              // Normalizar plataforma desde utm_source (esto agrupa fb, facebook, Facebook)
              const platform = normalizeTrafficSource({
                referrer_url: session.referrer_url,
                site_source_name: session.site_source_name,
                utm_source: session.utm_source,
                source_platform: session.source_platform
              })
              // Usar plataforma normalizada como ID para evitar duplicados
              const platformId = platform.toLowerCase()

              // Obtener o crear entrada de plataforma
              if (!adsHierarchyMap.has(platformId)) {
                adsHierarchyMap.set(platformId, {
                  platform,
                  platform_id: platformId,
                  visitors: new Set(),
                  campaigns: new Map()
                })
              }
              const platformNode = adsHierarchyMap.get(platformId)!
              platformNode.visitors.add(visitorId)

              // Obtener o crear campaña (decodificar para evitar formato +++)
              const campaignId = decodeAdName(session.utm_campaign)
              if (!platformNode.campaigns.has(campaignId)) {
                platformNode.campaigns.set(campaignId, {
                  id: campaignId,
                  name: campaignId, // Ya está decodificado
                  visitors: new Set(),
                  adsets: new Map()
                })
              }
              const campaignNode = platformNode.campaigns.get(campaignId)!
              campaignNode.visitors.add(visitorId)

              // Obtener o crear adset desde utm_medium (decodificar ID también)
              const adsetId = session.utm_medium && session.utm_medium !== 'null' && session.utm_medium !== 'undefined'
                ? decodeAdName(session.utm_medium)
                : 'sin_conjunto'

              if (!campaignNode.adsets.has(adsetId)) {
                const displayName = session.utm_medium && session.utm_medium !== 'null' && session.utm_medium !== 'undefined'
                  ? adsetId // Ya está decodificado
                  : '(Sin conjunto de anuncios)'

                campaignNode.adsets.set(adsetId, {
                  id: adsetId,
                  name: displayName,
                  visitors: new Set(),
                  ads: new Map()
                })
              }
              const adsetNode = campaignNode.adsets.get(adsetId)!
              adsetNode.visitors.add(visitorId)

              // Obtener o crear anuncio desde utm_content (decodificar ID también)
              const adId = session.utm_content && session.utm_content !== 'null' && session.utm_content !== 'undefined'
                ? decodeAdName(session.utm_content)
                : 'sin_anuncio'

              if (!adsetNode.ads.has(adId)) {
                const displayName = session.utm_content && session.utm_content !== 'null' && session.utm_content !== 'undefined'
                  ? adId // Ya está decodificado
                  : '(Sin nombre de anuncio)'

                adsetNode.ads.set(adId, {
                  id: adId,
                  name: displayName,
                  visitors: new Set()
                })
              }
              const adNode = adsetNode.ads.get(adId)!
              adNode.visitors.add(visitorId)
            }

            // Mantener mapeo plano para compatibilidad con TreeFilter antiguo
            if (session.utm_campaign) {
              if (!campaignsMap[session.utm_campaign]) campaignsMap[session.utm_campaign] = new Set()
              campaignsMap[session.utm_campaign].add(visitorId)
            }
            if (session.utm_content) {
              if (!adsMap[session.utm_content]) adsMap[session.utm_content] = new Set()
              adsMap[session.utm_content].add(visitorId)
            }
            // Normalizar fuente con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const normalized = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (normalized && normalized !== 'Desconocido' && normalized !== 'Otro') {
              if (!sourcesMap[normalized]) sourcesMap[normalized] = new Set()
              sourcesMap[normalized].add(visitorId)
            }
            if (session.device_type) {
              if (!devicesMap[session.device_type]) devicesMap[session.device_type] = new Set()
              devicesMap[session.device_type].add(visitorId)
            }
            if (session.browser) {
              if (!browsersMap[session.browser]) browsersMap[session.browser] = new Set()
              browsersMap[session.browser].add(visitorId)
            }
            if (session.os) {
              if (!osMap[session.os]) osMap[session.os] = new Set()
              osMap[session.os].add(visitorId)
            }
            if (session.placement) {
              const formatted = formatPlacementName(session.placement)
              if (!placementsMap[formatted]) placementsMap[formatted] = new Set()
              placementsMap[formatted].add(visitorId)
            }
          })

          filterData.campaigns = Object.entries(campaignsMap)
            .map(([name, visitorSet]) => ({ name: formatUrlParameter(name), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.ads = Object.entries(adsMap)
            .map(([name, visitorSet]) => ({ name: formatUrlParameter(name), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.sources = Object.entries(sourcesMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.devices = Object.entries(devicesMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.browsers = Object.entries(browsersMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.os = Object.entries(osMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.placements = Object.entries(placementsMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.trafficChannels = Object.entries(trafficChannelsMap)
            .map(([value, visitorSet]) => ({ value, name: getTrafficChannelLabel(value), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.trackingSources = Object.entries(trackingSourceMap)
            .map(([value, visitorSet]) => ({ value, name: getTrackingSourceLabel(value), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.siteTypes = Object.entries(siteTypesMap)
            .map(([value, visitorSet]) => ({ value, name: getSiteTypeLabel(value), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.nativeSites = Object.entries(nativeSitesMap)
            .map(([value, item]) => ({ value, name: item.name, count: item.visitors.size }))
            .sort((a, b) => b.count - a.count)

          filterData.nativeForms = Object.entries(nativeFormsMap)
            .map(([value, item]) => ({ value, name: item.name, count: item.visitors.size }))
            .sort((a, b) => b.count - a.count)

          filterData.nativeConversions = Object.entries(nativeConversionsMap)
            .map(([value, item]) => ({ value, name: item.name, count: item.conversions.size }))
            .sort((a, b) => b.count - a.count)

          filterData.conversions = conversionFilters.map(item => ({
            stage: item.stage,
            name: item.label,
            count: conversionsMap[item.stage].size
          }))

          // Convertir jerarquía de anuncios a formato compatible con TreeFilter
          filterData.adsHierarchy = Array.from(adsHierarchyMap.values()).map(platformNode => ({
            platform: platformNode.platform,
            platform_id: platformNode.platform_id,
            count: platformNode.visitors.size,
            campaigns: Array.from(platformNode.campaigns.values()).map(campaignNode => ({
              id: campaignNode.id,
              name: campaignNode.name,
              count: campaignNode.visitors.size,
              adsets: Array.from(campaignNode.adsets.values()).map(adsetNode => ({
                id: adsetNode.id,
                name: adsetNode.name,
                count: adsetNode.visitors.size,
                ads: Array.from(adsetNode.ads.values()).map(adNode => ({
                  id: adNode.id,
                  name: adNode.name,
                  count: adNode.visitors.size
                })).sort((a, b) => b.count - a.count)
              })).sort((a, b) => b.count - a.count)
            })).sort((a, b) => b.count - a.count)
          })).sort((a, b) => b.count - a.count)

          setAvailableFilterData(filterData)

          // Calcular stats para las cards - VISITANTES ÚNICOS
          const chartPercentageDenominator = Math.max(uniqueVids, 1)
          const browsersForChart: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((session: Session) => {
            const browser = session.browser || 'Desconocido'
            if (!browsersForChart[browser]) browsersForChart[browser] = new Set()
            browsersForChart[browser].add(session.visitor_id)
          })
          const browserStats = Object.entries(browsersForChart)
            .map(([browser, visitorSet]) => ({
              name: browser,
              users: visitorSet.size,
              percentage: ((visitorSet.size / chartPercentageDenominator) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setBrowserData(browserStats)

          const platformsForChart: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((session: Session) => {
            // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const platform = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (!platformsForChart[platform]) platformsForChart[platform] = new Set()
            platformsForChart[platform].add(session.visitor_id)
          })
          const platformStats = Object.entries(platformsForChart)
            .map(([platform, visitorSet]) => ({
              name: platform,
              users: visitorSet.size,
              percentage: ((visitorSet.size / chartPercentageDenominator) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlatformsData(platformStats)

          // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.) - VISITANTES ÚNICOS
          const placementsForChart: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((session: Session) => {
            const rawPlacement = session.placement || 'Sin ubicación'
            const placement = formatPlacementName(rawPlacement)
            if (!placementsForChart[placement]) placementsForChart[placement] = new Set()
            placementsForChart[placement].add(session.visitor_id)
          })
          const placementStats = Object.entries(placementsForChart)
            .map(([placement, visitorSet]) => ({
              name: placement,
              users: visitorSet.size,
              percentage: ((visitorSet.size / chartPercentageDenominator) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlacementsData(placementStats)

          const devicesForChart: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((session: Session) => {
            const device = session.device_type || 'Desconocido'
            if (!devicesForChart[device]) devicesForChart[device] = new Set()
            devicesForChart[device].add(session.visitor_id)
          })
          const deviceStats = Object.entries(devicesForChart)
            .map(([device, visitorSet]) => ({
              name: device,
              users: visitorSet.size,
              percentage: ((visitorSet.size / chartPercentageDenominator) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setDevicesData(deviceStats)

          const operatingSystemsForChart: { [key: string]: Set<string> } = {}
          currentViewSessions.forEach((session: Session) => {
            const os = session.os || 'Desconocido'
            if (!operatingSystemsForChart[os]) operatingSystemsForChart[os] = new Set()
            operatingSystemsForChart[os].add(session.visitor_id)
          })
          const osStats = Object.entries(operatingSystemsForChart)
            .map(([os, visitorSet]) => ({
              name: os,
              users: visitorSet.size,
              percentage: ((visitorSet.size / chartPercentageDenominator) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setOsData(osStats)

          // Calcular top visitors (visitantes con más requests)
          const visitorCounts: { [key: string]: number } = {}
          currentViewSessions.forEach((s: Session) => {
            visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
          })
          const topVisitorsList = Object.entries(visitorCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([visitorId, count]) => ({
              id: visitorId.substring(0, 24) + '...',
              requests: count
            }))
          setTopVisitors(topVisitorsList)
        } else {
          // Reset si no hay datos
          const messageFilterData = getMessageFilterData(messageSummary)
          setOriginalRegistros(0)
          setAllSessions([])
          setSessions([])
          setAvailableFilterData(hasAvailableFilterOptions(messageFilterData) ? messageFilterData : {})
          setPlatformsData([])
          setPlacementsData([])
          setDevicesData([])
          setOsData([])
          setBrowserData([])
          setTopVisitors([])
          setMetrics({
            pageViews: 0,
            uniqueVisitors: 0,
            registros: 0,
            conversionRate: 0,
            returningUsers: 0,
            avgPagePerSession: 0,
            trends: {
              pageViews: 0,
              uniqueVisitors: 0,
              registros: 0,
              conversionRate: 0,
              returningUsers: 0,
              avgPagePerSession: 0
            }
          })
          setDailyTraffic(completeTrafficPeriods([], viewType, { from: startDate, to: endDate }))
          setDailyConversions(completeTrafficPeriods([], viewType, { from: startDate, to: endDate }))
          setContactConversionsByDate(contactConversionRows || [])
        }
      } catch {
        setWebTrackingConfigured(false)
        setMessageAnalytics(null)
        setContactConversionsByDate([])
      } finally {
        setLoading(false)
        setHasLoadedAnalytics(true)
      }
    }

    fetchAnalytics()
  }, [apiRange.from, apiRange.to, viewType, convertToLocalTime, conversionFilters, messageSummaryFilterKey, messageSummaryFilters])

  // Efecto para filtrar sesiones cuando cambian los filtros seleccionados
  useEffect(() => {
    if (Object.keys(selectedFilters).length === 0) {
      setSessions(allSessions)
    } else {
      const filtered = allSessions.filter((session: Session) => {
        for (const [field, values] of Object.entries(selectedFilters)) {
          if (values.length === 0) continue
          if (isMessageFilterField(field)) continue

          let fieldMatch = false

          for (const value of values) {
            switch (field) {
              case 'landing_url':  // TreeFilter usa 'landing_url' para páginas
              case 'page_url':     // Mantener compatibilidad
                if (session.page_url) {
                  const urlPath = session.page_url.split('?')[0]
                  const pageName = urlPath.split('/').pop() || 'home'
                  if (pageName === value) fieldMatch = true
                }
                break
              case 'utm_campaign':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedCampaign = decodeAdName(session.utm_campaign)
                if (decodedCampaign === value) fieldMatch = true
                break
              case 'utm_medium':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedMedium = session.utm_medium ? decodeAdName(session.utm_medium) : ''
                if (decodedMedium === value) fieldMatch = true
                break
              case 'utm_content':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedContent = session.utm_content ? decodeAdName(session.utm_content) : ''
                if (decodedContent === value) fieldMatch = true
                break
              case 'utm_source':
                // Normalizar fuente con todas las prioridades para match correcto
                const normalizedSource = normalizeTrafficSource({
                  referrer_url: session.referrer_url,
                  site_source_name: session.site_source_name,
                  utm_source: session.utm_source,
                  source_platform: session.source_platform
                })
                if (normalizedSource.toLowerCase() === value.toLowerCase()) fieldMatch = true
                break
              case 'device_type':
                if (session.device_type === value) fieldMatch = true
                break
              case 'browser':
                if (session.browser === value) fieldMatch = true
                break
              case 'os':
                if (session.os === value) fieldMatch = true
                break
              case 'placement':
                const placementFormatted = formatPlacementName(session.placement || '')
                if (placementFormatted === value) fieldMatch = true
                break
              case 'ad_platform':
                const sessionPlatform = (session.source_platform || '').toLowerCase()
                if (sessionPlatform === value) fieldMatch = true
                break
              case 'campaign_id':
                if (session.campaign_id === value) fieldMatch = true
                break
              case 'adset_id':
                const sessionAdsetId = session.adset_id || session.ad_group_id
                if (sessionAdsetId === value) fieldMatch = true
                break
              case 'ad_id':
                if (session.ad_id === value) fieldMatch = true
                break
              case 'conversion_stage':
                if (getSessionConversionStage(session) === value) fieldMatch = true
                break
              case 'tracking_source':
                if (getTrackingSourceValue(session) === value) fieldMatch = true
                break
              case 'channel':
                if (normalizeTrafficChannelValue(session.channel) === value) fieldMatch = true
                break
              case 'site_type':
                if ((session.site_type || 'unknown') === value) fieldMatch = true
                break
              case 'site_id':
                if (session.site_id === value) fieldMatch = true
                break
              case 'form_site_id':
                if (getNativeFormId(session) === value) fieldMatch = true
                break
              case 'native_conversion_source':
                if (getNativeConversionFilterValue(session) === value) fieldMatch = true
                break
            }
          }

          if (!fieldMatch) return false
        }

        return true
      })

      // Ordenar sesiones filtradas de más reciente a más vieja
      const sortedFiltered = [...filtered].sort((a, b) => {
        const dateA = parseTimestamp(a.started_at)?.getTime() ?? 0
        const dateB = parseTimestamp(b.started_at)?.getTime() ?? 0
        return dateB - dateA // DESC: más reciente primero
      })
      setSessions(sortedFiltered)
    }
  }, [selectedFilters, allSessions])

  // Efecto para recalcular visualizaciones cuando cambien las sesiones filtradas
  useEffect(() => {
    // No hacer nada si allSessions está vacío (aún no se han cargado los datos iniciales)
    if (allSessions.length === 0) {
      return
    }

    // Detectar si hay filtros activos
    const hasActiveFilters = hasSelectedWebFilters(selectedFilters)

    // BUG FIX: Si no hay filtros activos, usar allSessions en vez de sessions
    const sessionsToProcess = hasActiveFilters ? sessions : allSessions

    if (sessionsToProcess.length === 0) {
      // Si no hay sesiones filtradas, resetear solo métricas de sesiones.
      setMetrics(prev => ({
        pageViews: 0,
        uniqueVisitors: 0,
        registros: hasActiveFilters ? 0 : prev.registros, // Si hay filtro y no hay datos = 0
        conversionRate: 0,
        returningUsers: 0,
        avgPagePerSession: 0,
        trends: prev.trends // Mantener trends originales
      }))
      setDailyTraffic([])
      setDailyConversions([])
      return
    }

    const viewSessionsToProcess = sessionsToProcess.filter(isTrackingViewEvent)

    // Recalcular KPIs principales con las sesiones filtradas
    const uniqueVids = new Set(viewSessionsToProcess.map((s: Session) => s.visitor_id)).size
    const totalPageViews = viewSessionsToProcess.length

    // Contar sesiones únicas (por session_id)
    const uniqueSessionIds = new Set(viewSessionsToProcess.map((s: Session) => s.session_id)).size

    // Registros = contactos únicos que aparecen en las sesiones filtradas
    const sesionesConContacto = sessionsToProcess.filter((s: Session) => {
      if (!s.contact_id || !s.contact_created_at) return false

      const startedDate = parseTimestamp(s.started_at)
      const contactCreatedDate = parseTimestamp(s.contact_created_at)

      if (!startedDate || !contactCreatedDate) return false

      return startedDate >= contactCreatedDate
    })

    const registrosEnSesiones = new Set(
      sesionesConContacto.map((s: Session) => s.contact_id)
    ).size

    // Si hay filtros activos, usar registrosEnSesiones; si no, usar valor original guardado
    const registrosValue = hasActiveFilters ? registrosEnSesiones : originalRegistros

    const conversionRate = uniqueVids > 0 ? ((registrosValue / uniqueVids) * 100) : 0

    // Usuarios recurrentes: contar visitor_ids que tienen múltiples session_ids diferentes
    const visitorSessionMap: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((s: Session) => {
      if (!visitorSessionMap[s.visitor_id]) {
        visitorSessionMap[s.visitor_id] = new Set()
      }
      visitorSessionMap[s.visitor_id].add(s.session_id)
    })
    const returningUsers = Object.values(visitorSessionMap).filter(sessionSet => sessionSet.size > 1).length

    // Páginas por sesión = total de page_views / número de sesiones únicas
    const avgPagePerSession = uniqueSessionIds > 0 ?
      (totalPageViews / uniqueSessionIds) : 0

    // Actualizar métricas (sin trends, ya que los filtros no tienen período anterior)
    setMetrics(prev => ({
      pageViews: totalPageViews,
      uniqueVisitors: uniqueVids,
      registros: registrosValue, // Usar valor filtrado si hay filtros activos
      conversionRate,
      returningUsers,
      avgPagePerSession,
      trends: prev.trends // Mantener trends del período original
    }))

    // Recalcular gráfico de tráfico con sesiones filtradas
    setDailyTraffic(buildTrafficChartData(sessionsToProcess, viewType, convertToLocalTime))

    // Recalcular gráficos de registros SI hay filtros activos
    if (hasActiveFilters) {
      // Agrupar contactos únicos por fecha de creación
      const registrosPorFecha: { [key: string]: Set<string> } = {}

      sessionsToProcess.forEach((session: Session) => {
        if (session.contact_id && session.contact_created_at) {
          const createdDate = parseTimestamp(session.contact_created_at)
          const startedDate = parseTimestamp(session.started_at)

          if (!createdDate || !startedDate || startedDate < createdDate) {
            return
          }

          const periodKey = getPeriodKeyFromTimestamp(session.contact_created_at, viewType, convertToLocalTime)
          if (!periodKey) return
          if (!registrosPorFecha[periodKey]) {
            registrosPorFecha[periodKey] = new Set()
          }
          registrosPorFecha[periodKey].add(session.contact_id)
        }
      })

      // Generar datos para el gráfico de conversiones filtrado.
      const filteredConversionsData = Object.entries(registrosPorFecha)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, contactSet]) => ({
          label: formatPeriodLabel(period, viewType),
          value: contactSet.size,
          ...getPeriodPointMeta(period, viewType)
        }))

      setDailyConversions(filteredConversionsData)
    } else {
    }
    // Si NO hay filtros, mantener los datos originales (ya están seteados en el primer useEffect)

    // Recalcular stats para las cards
    const browsersForFilter: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((session: Session) => {
      const browser = session.browser || 'Desconocido'
      if (!browsersForFilter[browser]) browsersForFilter[browser] = new Set()
      browsersForFilter[browser].add(session.visitor_id)
    })
    const uniqueVisitorsInFilter = new Set(viewSessionsToProcess.map(s => s.visitor_id)).size
    const percentageDenominator = Math.max(uniqueVisitorsInFilter, 1)
    const browserStats = Object.entries(browsersForFilter)
      .map(([browser, visitorSet]) => ({
        name: browser,
        users: visitorSet.size,
        percentage: ((visitorSet.size / percentageDenominator) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setBrowserData(browserStats)

    const platformsForFilter: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((session: Session) => {
      // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
      const platform = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })
      if (!platformsForFilter[platform]) platformsForFilter[platform] = new Set()
      platformsForFilter[platform].add(session.visitor_id)
    })
    const platformStats = Object.entries(platformsForFilter)
      .map(([platform, visitorSet]) => ({
        name: platform,
        users: visitorSet.size,
        percentage: ((visitorSet.size / percentageDenominator) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlatformsData(platformStats)

    // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.) - VISITANTES ÚNICOS
    const placementsForFilter: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((session: Session) => {
      const rawPlacement = session.placement || 'Sin ubicación'
      const placement = formatPlacementName(rawPlacement)
      if (!placementsForFilter[placement]) placementsForFilter[placement] = new Set()
      placementsForFilter[placement].add(session.visitor_id)
    })
    const placementStats = Object.entries(placementsForFilter)
      .map(([placement, visitorSet]) => ({
        name: placement,
        users: visitorSet.size,
        percentage: ((visitorSet.size / percentageDenominator) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlacementsData(placementStats)

    const devicesFiltered: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((session: Session) => {
      const device = session.device_type || 'Desconocido'
      if (!devicesFiltered[device]) devicesFiltered[device] = new Set()
      devicesFiltered[device].add(session.visitor_id)
    })
    const uniqueVisitorsFiltered = new Set(viewSessionsToProcess.map(s => s.visitor_id)).size
    const devicePercentageDenominator = Math.max(uniqueVisitorsFiltered, 1)
    const deviceStats = Object.entries(devicesFiltered)
      .map(([device, visitorSet]) => ({
        name: device,
        users: visitorSet.size,
        percentage: ((visitorSet.size / devicePercentageDenominator) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setDevicesData(deviceStats)

    const operatingSystemsForFilter: { [key: string]: Set<string> } = {}
    viewSessionsToProcess.forEach((session: Session) => {
      const os = session.os || 'Desconocido'
      if (!operatingSystemsForFilter[os]) operatingSystemsForFilter[os] = new Set()
      operatingSystemsForFilter[os].add(session.visitor_id)
    })
    const osStats = Object.entries(operatingSystemsForFilter)
      .map(([os, visitorSet]) => ({
        name: os,
        users: visitorSet.size,
        percentage: ((visitorSet.size / percentageDenominator) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setOsData(osStats)

    const visitorCounts: { [key: string]: number } = {}
    viewSessionsToProcess.forEach((s: Session) => {
      visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
    })
    const topVisitorsList = Object.entries(visitorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([visitorId, count]) => ({
        id: visitorId.substring(0, 24) + '...',
        requests: count
      }))
    setTopVisitors(topVisitorsList)

  }, [sessions, allSessions, selectedFilters, viewType, convertToLocalTime])

  const messageMetrics = messageAnalytics?.metrics

  const webMetrics = [
    {
      title: 'Visualizaciones',
      value: formatChartNumber(metrics.pageViews || 0),
      delta: metrics.trends?.pageViews || 0,
      icon: Eye
    },
    {
      title: 'Visitantes Únicos',
      value: String(metrics.uniqueVisitors || 0),
      delta: metrics.trends?.uniqueVisitors || 0,
      icon: Users
    },
    {
      title: newContactsLabel,
      value: String(metrics.registros || 0),
      delta: metrics.trends?.registros || 0,
      icon: UserCheck
    },
    {
      title: 'Conversión',
      value: `${(metrics.conversionRate || 0).toFixed(1)}%`,
      delta: metrics.trends?.conversionRate || 0,
      icon: Target
    }
  ]

  const messageMetricCards = [
    {
      title: 'Mensajes Entrantes',
      value: formatChartNumber(messageMetrics?.inboundMessages || 0),
      delta: 0,
      icon: MessageCircle
    },
    {
      title: 'Conversaciones',
      value: formatChartNumber(messageMetrics?.conversations || 0),
      delta: 0,
      icon: Users
    },
    {
      title: 'Contactos nuevos',
      value: formatChartNumber(messageMetrics?.contacts || 0),
      delta: 0,
      icon: UserCheck
    },
    {
      title: 'Con Atribución',
      value: `${(messageMetrics?.attributionRate || 0).toFixed(1)}%`,
      delta: 0,
      icon: Target
    }
  ]

  const hasWebAnalyticsData = Boolean(
    metrics.pageViews > 0 ||
    metrics.uniqueVisitors > 0 ||
    metrics.registros > 0 ||
    metrics.returningUsers > 0 ||
    dailyTraffic.some(item => (item.value || 0) > 0 || (item.value2 || 0) > 0)
  )
  const hasMessageAnalyticsData = Boolean(
    messageAnalytics?.status?.hasData ||
    (messageMetrics?.inboundMessages || 0) > 0 ||
    (messageMetrics?.conversations || 0) > 0 ||
    (messageMetrics?.contacts || 0) > 0 ||
    (messageAnalytics?.trend || []).some(item => (item.messages || 0) > 0)
  )
  const showWebAnalyticsBlocks = Boolean(webTrackingConfigured || hasWebAnalyticsData)
  const showMessageAnalyticsBlocks = Boolean(
    messageAnalytics?.status?.connected ||
    hasMessageAnalyticsData
  )

  const metricSections: Array<{ title: string; metrics: typeof webMetrics }> = []
  if (showWebAnalyticsBlocks) {
    metricSections.push({ title: 'Tráfico del sitio', metrics: webMetrics })
  }
  if (showMessageAnalyticsBlocks) {
    metricSections.push({ title: 'Mensajes', metrics: messageMetricCards })
  }
  const sourceGridClassName = metricSections.length > 1 ? 'grid gap-4 xl:grid-cols-2' : 'grid gap-4'
  const analyticsSubtitle = showWebAnalyticsBlocks && showMessageAnalyticsBlocks
    ? 'Tráfico del sitio, mensajes y conversiones por rango.'
    : showWebAnalyticsBlocks
      ? 'Tráfico del sitio y conversiones por rango.'
      : showMessageAnalyticsBlocks
        ? 'Mensajes y conversiones por rango.'
        : 'Conecta una fuente para ver analíticas por rango.'

  const handleMonthPresetChange = (value: string) => {
    if (!isAnalyticsMonthPreset(value)) return
    setMonthPreset(value)
    const nextParams = new URLSearchParams(searchParams)
    setSearchParam(nextParams, 'preset', value, 'last12')
    if (value !== 'custom') {
      nextParams.delete('from')
      nextParams.delete('to')
    }
    setSearchParams(nextParams, { replace: true })
  }

  const handleViewTypeChange = (value: string) => {
    if (!isAnalyticsViewType(value)) return
    if (value === 'year' && !canShowYearView) return

    if (value === 'year' && monthPreset !== 'all') {
      const nextYearRange = {
        start: baseRange.start.getFullYear(),
        end: baseRange.end.getFullYear()
      }
      setMonthPreset('custom')
      setYearRange(nextYearRange)

      const nextParams = new URLSearchParams(searchParams)
      setSearchParam(nextParams, 'preset', 'custom', 'last12')
      setSearchParam(nextParams, 'yearStart', nextYearRange.start, defaultYearRange.start)
      setSearchParam(nextParams, 'yearEnd', nextYearRange.end, defaultYearRange.end)
      setSearchParams(nextParams, { replace: true })

      const nextSearch = nextParams.toString()
      setViewType(value)
      navigateAnalyticsView({ viewType: value, search: nextSearch ? `?${nextSearch}` : '' })
      return
    }

    setViewType(value)
    navigateAnalyticsView({ viewType: value })
  }

  const handleYearRangeChange = (key: 'start' | 'end', delta: number) => {
    setYearRange(prev => {
      const updated = { ...prev, [key]: prev[key] + delta }
      if (updated.start > updated.end) {
        return prev
      }
      const nextParams = new URLSearchParams(searchParams)
      setSearchParam(nextParams, 'yearStart', updated.start, defaultYearRange.start)
      setSearchParam(nextParams, 'yearEnd', updated.end, defaultYearRange.end)
      setSearchParams(nextParams, { replace: true })
      return updated
    })
  }

  const periodLabel = viewType === 'year' ? 'año' : viewType === 'month' ? 'mes' : 'fecha'
  const hasActiveFiltersForCharts = showWebAnalyticsBlocks && hasSelectedWebFilters(selectedFilters)
  const sessionsForCharts = hasActiveFiltersForCharts ? sessions : allSessions

  const messageTrendData = React.useMemo<TrafficPoint[]>(() => (
    buildMessageTrendData(messageAnalytics, viewType, apiRange)
  ), [apiRange.from, apiRange.to, viewType, messageAnalytics])

  const mainChartOptions = React.useMemo<Array<{ value: AnalyticsMainChartView; label: string }>>(() => (
    [
      { value: 'traffic', label: 'Tráfico del sitio' },
      { value: 'visitors-registrations', label: `Visitantes vs ${newContactsLabel}` },
      { value: 'sessions-visitors', label: 'Sesiones vs Visitantes' },
      { value: 'identity-returning', label: 'Identificados vs Recurrentes' }
    ]
  ), [newContactsLabel])

  const showAnalyticsFilters = Boolean(
    (showWebAnalyticsBlocks || showMessageAnalyticsBlocks) &&
    hasAvailableFilterOptions(availableFilterData)
  )

  useEffect(() => {
    if (!hasSelectedFilters(selectedFilters)) return

    const nextFilters = Object.fromEntries(
      Object.entries(selectedFilters).filter(([field, values]) => {
        if (!values.length) return false
        return isMessageFilterField(field) ? showMessageAnalyticsBlocks : showWebAnalyticsBlocks
      })
    )

    if (Object.keys(nextFilters).length !== Object.keys(selectedFilters).length) {
      setSelectedFilters(nextFilters)
    }
  }, [selectedFilters, setSelectedFilters, showMessageAnalyticsBlocks, showWebAnalyticsBlocks])

  const conversionChartOptions = React.useMemo<Array<{ value: AnalyticsConversionChartView; label: string }>>(() => {
    const options: Array<{ value: AnalyticsConversionChartView; label: string }> = [
      { value: 'registrations-customers', label: `${newContactsLabel} vs ${customersLabel}` },
      { value: 'prospects-customers', label: `${leadsLabel} vs ${customersLabel}` }
    ]

    if (showMessageAnalyticsBlocks) {
      options.push({ value: 'messages-appointments', label: 'Mensajes vs Citas' })
    }

    options.push(
      { value: 'appointments-patients', label: `Citas vs ${customersLabel}` }
    )

    return options
  }, [customersLabel, leadsLabel, newContactsLabel, showMessageAnalyticsBlocks])

  useEffect(() => {
    const validValues = conversionChartOptions.map(opt => opt.value)
    if (!validValues.includes(selectedConversionChartView)) {
      const nextChart = conversionChartOptions[0]?.value as AnalyticsConversionChartView
      setSelectedConversionChartView(nextChart)
      navigateAnalyticsView({ conversionChart: nextChart, replace: true })
    }
  }, [conversionChartOptions, navigateAnalyticsView, selectedConversionChartView])

  const sessionTrendData = React.useMemo(
    () => completeSessionTrendPeriods(
      buildSessionTrendData(sessionsForCharts, viewType, convertToLocalTime),
      viewType,
      apiRange
    ),
    [sessionsForCharts, viewType, convertToLocalTime, apiRange.from, apiRange.to]
  )

  const contactCreatedConversionTrendData = React.useMemo(
    () => completeConversionTrendPeriods(
      aggregateContactConversionsByPeriod(contactConversionsByDate, viewType),
      viewType,
      apiRange
    ),
    [contactConversionsByDate, viewType, apiRange.from, apiRange.to]
  )

  const filteredConversionTrendData = React.useMemo(
    () => completeConversionTrendPeriods(
      buildConversionTrendData(sessionsForCharts, viewType, convertToLocalTime),
      viewType,
      apiRange
    ),
    [sessionsForCharts, viewType, convertToLocalTime, apiRange.from, apiRange.to]
  )

  const conversionTrendData = hasActiveFiltersForCharts
    ? filteredConversionTrendData
    : contactCreatedConversionTrendData

  const webChartConfig = React.useMemo<ChartMetricConfig>(() => {
    switch (selectedMainChartView) {
      case 'visitors-registrations':
        return {
          title: `Visitantes vs ${newContactsLabel}`,
          description: `Cuántos visitantes terminan creando contactos nuevos por ${periodLabel}`,
          label1: 'Visitantes únicos',
          label2: newContactsLabel,
          color: ANALYTICS_CHART_COLORS.visitors,
          color2: ANALYTICS_CHART_COLORS.registrations,
          data: mergeVisitorRegistrationData(dailyTraffic, dailyConversions),
          emptyMessage: 'Sin datos de visitantes o contactos nuevos disponibles'
        }
      case 'sessions-visitors':
        return {
          title: 'Sesiones vs Visitantes',
          description: `Frecuencia de regreso y volumen real por ${periodLabel}`,
          label1: 'Sesiones',
          label2: 'Visitantes únicos',
          color: ANALYTICS_CHART_COLORS.sessions,
          color2: ANALYTICS_CHART_COLORS.visitors,
          data: mapTrendToChartData(sessionTrendData, 'uniqueSessions', 'uniqueVisitors'),
          emptyMessage: 'Sin sesiones disponibles'
        }
      case 'identity-returning':
        return {
          title: 'Identificados vs Recurrentes',
          description: `Calidad del tráfico: contactos identificados y usuarios que regresan por ${periodLabel}`,
          label1: 'Contactos identificados',
          label2: 'Visitantes recurrentes',
          color: ANALYTICS_CHART_COLORS.identified,
          color2: ANALYTICS_CHART_COLORS.returning,
          data: mapTrendToChartData(sessionTrendData, 'identifiedContacts', 'returningVisitors'),
          emptyMessage: 'Sin visitantes identificados o recurrentes'
        }
      case 'traffic':
      default:
        return {
          title: 'Tráfico del Sitio',
          description: `Visualizaciones de página y visitantes únicos por ${periodLabel}`,
          label1: 'Visualizaciones',
          label2: 'Visitantes únicos',
          color: ANALYTICS_CHART_COLORS.traffic,
          color2: ANALYTICS_CHART_COLORS.visitors,
          data: dailyTraffic,
          emptyMessage: 'Sin datos de tráfico disponibles'
        }
    }
  }, [dailyConversions, dailyTraffic, newContactsLabel, periodLabel, selectedMainChartView, sessionTrendData])

  const messageChartConfig = React.useMemo<ChartMetricConfig>(() => ({
    title: 'Mensajes',
    description: `Mensajes recibidos por ${periodLabel}`,
    label1: 'Mensajes',
    color: ANALYTICS_CHART_COLORS.messages,
    color2: ANALYTICS_CHART_COLORS.appointments,
    data: messageTrendData,
    emptyMessage: 'Sin mensajes disponibles en este rango'
  }), [periodLabel, messageTrendData])

  const conversionChartConfig = React.useMemo<ChartMetricConfig>(() => {
    switch (selectedConversionChartView) {
      case 'appointments-attendances':
        return {
          title: 'Citas vs Asistencias',
          description: `Controla si la agenda se está convirtiendo en show-ups por ${periodLabel}`,
          label1: 'Citas agendadas',
          label2: 'Citas asistidas',
          color: ANALYTICS_CHART_COLORS.appointments,
          color2: ANALYTICS_CHART_COLORS.attendances,
          data: mapTrendToChartData(conversionTrendData, 'appointments', 'attendances'),
          emptyMessage: 'Sin citas o asistencias disponibles'
        }
      case 'prospects-customers':
        return {
          title: `${leadsLabel} vs ${customersLabel}`,
          description: `Compara ${leadsLabelLower} en etapa inicial contra ${customersLabelLower} por ${periodLabel}`,
          label1: leadsLabel,
          label2: customersLabel,
          color: ANALYTICS_CHART_COLORS.prospects,
          color2: ANALYTICS_CHART_COLORS.customers,
          data: mapTrendToChartData(conversionTrendData, 'prospects', 'customers'),
          emptyMessage: `Sin ${leadsLabelLower} o ${customersLabelLower} disponibles`
        }
      case 'messages-appointments':
        return {
          title: 'Mensajes vs Citas',
          description: `Cuántos mensajes llegan versus citas agendadas por ${periodLabel}`,
          label1: 'Mensajes',
          label2: 'Citas',
          color: ANALYTICS_CHART_COLORS.messages,
          color2: ANALYTICS_CHART_COLORS.appointments,
          data: mergeMessagesWithAppointments(messageTrendData, conversionTrendData),
          emptyMessage: 'Sin mensajes o citas disponibles'
        }
      case 'appointments-patients':
        return {
          title: `Citas vs ${customersLabel}`,
          description: `Cuántas citas agendadas se convierten en ${customersLabelLower} por ${periodLabel}`,
          label1: 'Citas',
          label2: customersLabel,
          color: ANALYTICS_CHART_COLORS.appointments,
          color2: ANALYTICS_CHART_COLORS.customers,
          data: mapTrendToChartData(conversionTrendData, 'appointments', 'customers'),
          emptyMessage: `Sin citas o ${customersLabelLower} disponibles`
        }
      case 'registrations-customers':
      default:
        return {
          title: `${newContactsLabel} vs ${customersLabel}`,
          description: `Mide cuántos ${newContactsLabelLower} terminan siendo ${customersLabelLower} por ${periodLabel}`,
          label1: newContactsLabel,
          label2: customersLabel,
          color: ANALYTICS_CHART_COLORS.registrations,
          color2: ANALYTICS_CHART_COLORS.customers,
          data: mapTrendToChartData(conversionTrendData, 'registrations', 'customers'),
          emptyMessage: `Sin ${newContactsLabelLower} o ${customersLabelLower} disponibles`
        }
    }
  }, [conversionTrendData, customersLabel, customersLabelLower, leadsLabel, leadsLabelLower, newContactsLabel, newContactsLabelLower, periodLabel, selectedConversionChartView, messageTrendData])

  const webChartHasData = webChartConfig.data.some(item => (item.value || 0) > 0 || (item.value2 || 0) > 0)
  const messageChartHasData = messageChartConfig.data.some(item => (item.value || 0) > 0 || (item.value2 || 0) > 0)
  const conversionChartHasData = conversionChartConfig.data.some(item => (item.value || 0) > 0 || (item.value2 || 0) > 0)

  const getConversionClickConfig = useCallback((seriesKey: ChartSeriesKey): {
    listType: ContactConversionListType
    modalType: ContactModalType
    title: string
  } | null => {
    switch (selectedConversionChartView) {
      case 'prospects-customers':
        return seriesKey === 'value'
          ? { listType: 'prospects', modalType: 'interesados', title: leadsLabel }
          : { listType: 'customers', modalType: 'sales', title: customersLabel }
      case 'appointments-attendances':
        return seriesKey === 'value'
          ? { listType: 'appointments', modalType: 'appointments', title: 'Citas' }
          : { listType: 'attendances', modalType: 'attendances', title: 'Asistencias' }
      case 'messages-appointments':
        return seriesKey === 'value2'
          ? { listType: 'appointments', modalType: 'appointments', title: 'Citas' }
          : null
      case 'appointments-patients':
        return seriesKey === 'value'
          ? { listType: 'appointments', modalType: 'appointments', title: 'Citas' }
          : { listType: 'customers', modalType: 'sales', title: customersLabel }
      case 'registrations-customers':
      default:
        return seriesKey === 'value'
          ? { listType: 'registrations', modalType: 'interesados', title: newContactsLabel }
          : { listType: 'customers', modalType: 'sales', title: customersLabel }
    }
  }, [customersLabel, leadsLabel, newContactsLabel, selectedConversionChartView])

  const handleConversionPointClick = useCallback(async (
    point: AnalyticsChartClickPoint,
    _index: number,
    seriesKey: ChartSeriesKey
  ) => {
    const clickConfig = getConversionClickConfig(seriesKey)
    const from = point.periodStart
    const to = point.periodEnd

    if (!clickConfig || !from || !to) return

    setContactModalState({
      open: true,
      title: `${clickConfig.title} · ${point.label}`,
      subtitle: formatRangeLabel(from, to),
      type: clickConfig.modalType,
      contacts: [],
      loading: true
    })

    try {
      const contacts = hasActiveFiltersForCharts
        ? buildFilteredContactListFromSessions(
            sessionsForCharts,
            viewType,
            convertToLocalTime,
            point.periodKey || '',
            clickConfig.listType
          )
        : (await getContactConversionContacts(from, to, clickConfig.listType)).contacts

      setContactModalState(prev => ({
        ...prev,
        contacts: contacts.map(contact => ({
          ...contact,
          created_at: contact.created_at || (contact as any).createdAt || ''
        })),
        loading: false
      }))
    } catch {
      setContactModalState(prev => ({
        ...prev,
        contacts: [],
        loading: false
      }))
    }
  }, [convertToLocalTime, getConversionClickConfig, hasActiveFiltersForCharts, sessionsForCharts, viewType])

  const analyticsRefreshing = loading && hasLoadedAnalytics

  if (loading && !hasLoadedAnalytics) {
    return <Loading message="Cargando analíticas..." page="analytics" />
  }

  return (
    <PageContainer>
      {/* Ritmo vertical estándar entre secciones de página (DESIGN_SYSTEM.md) */}
      <div className="flex flex-col gap-[18px]">
        {/* Header */}
        <div className="flex flex-col gap-4">
          <PageHeader
            title="Analíticas"
            subtitle={analyticsSubtitle}
          />

          {/* Filtro en árbol, selector de fechas y vista */}
          <div className="flex flex-col gap-3">
            {viewType === 'month' && monthPreset === 'custom' && (
              <div className="flex flex-wrap items-center gap-3">
                <ViewSelector
                  value={monthPreset}
                  options={monthRangeOptions}
                  onChange={handleMonthPresetChange}
                />
              </div>
            )}

            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                {showAnalyticsFilters && (
                  <TreeFilter
                    availableData={availableFilterData}
                    selectedFilters={selectedFilters}
                    onFilterChange={setSelectedFilters}
                  />
                )}

                {viewType === 'day' && (
                  <DateRangePicker
                    startDate={formatDateToISO(baseRange.start)}
                    endDate={formatDateToISO(baseRange.end)}
                    onChange={(start, end) =>
                      setDateRange({
                        start: parseLocalDateString(start),
                        end: parseLocalDateString(end),
                        preset: 'custom'
                      })
                    }
                  />
                )}

                {viewType === 'month' && monthPreset !== 'custom' && (
                  <ViewSelector
                    value={monthPreset}
                    options={monthRangeOptions}
                    onChange={handleMonthPresetChange}
                  />
                )}

                {viewType === 'month' && monthPreset === 'custom' && (
                  <DateRangePicker
                    startDate={formatDateToISO(baseRange.start)}
                    endDate={formatDateToISO(baseRange.end)}
                    onChange={(start, end) =>
                      setDateRange({
                        start: parseLocalDateString(start),
                        end: parseLocalDateString(end),
                        preset: 'custom'
                      })
                    }
                  />
                )}

                {viewType === 'year' && monthPreset === 'all' && (
                  <div className="flex min-h-10 items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text-dim)]">
                    Todo el tiempo
                  </div>
                )}

                {viewType === 'year' && monthPreset !== 'all' && (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--text-mute)]">Inicio</span>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" aria-label="Disminuir año de inicio" onClick={() => handleYearRangeChange('start', -1)}>
                          <Minus size={16} />
                        </Button>
                        <span className="min-w-12 text-center text-sm font-semibold">{yearRange.start}</span>
                        <Button variant="ghost" size="sm" aria-label="Aumentar año de inicio" onClick={() => handleYearRangeChange('start', 1)}>
                          <Plus size={16} />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--text-mute)]">Fin</span>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" aria-label="Disminuir año de fin" onClick={() => handleYearRangeChange('end', -1)}>
                          <Minus size={16} />
                        </Button>
                        <span className="min-w-12 text-center text-sm font-semibold">{yearRange.end}</span>
                        <Button variant="ghost" size="sm" aria-label="Aumentar año de fin" onClick={() => handleYearRangeChange('end', 1)}>
                          <Plus size={16} />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <TabList
                tabs={availableViewTabs}
                activeTab={viewType}
                onTabChange={handleViewTypeChange}
                variant="compact"
              />
            </div>
          </div>
        </div>

        {/* Métricas por canal */}
        {metricSections.length > 0 && (
          <div className={sourceGridClassName}>
            {metricSections.map((section) => (
              <section key={section.title} className="flex min-w-0 flex-col gap-3" aria-label={section.title}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-sm font-semibold text-[var(--text)]">{section.title}</h2>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  {section.metrics.map((metric) => (
                    <KpiCard
                      key={metric.title}
                      title={metric.title}
                      value={metric.value}
                      delta={metric.delta}
                      icon={metric.icon}
                      loading={analyticsRefreshing}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Gráficas por canal */}
        {metricSections.length > 0 && (
        <div className={sourceGridClassName}>
          {showWebAnalyticsBlocks && (
          <Card variant="glass" className="p-6">
            <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 flex-1">
                <ViewSelector
                  variant="title"
                  options={mainChartOptions}
                  value={selectedMainChartView}
                  onChange={(value) => {
                    if (isAnalyticsMainChartView(value)) {
                      setSelectedMainChartView(value)
                      navigateAnalyticsView({ mainChart: value })
                    }
                  }}
                />
                <p className="mt-1 text-sm text-[var(--text-mute)]">
                  {webChartConfig.description}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3 lg:justify-end">
                <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-dim)]">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: webChartConfig.color }} />
                    <span className="font-medium">{webChartConfig.label1}</span>
                  </span>
                  {webChartConfig.label2 && (
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: webChartConfig.color2 }} />
                      <span className="font-medium">{webChartConfig.label2}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="relative w-full" style={{ minHeight: 340, height: 340 }}>
              {analyticsRefreshing ? (
                <div data-ristak-chart-empty className="flex h-full items-end justify-between gap-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface) 82%, transparent)] p-5" role="status" aria-live="polite" aria-label="Cargando tráfico del sitio">
                  {[62, 44, 76, 54, 82, 66].map((height, index) => (
                    <span
                      key={`analytics-web-chart-skeleton-${index}`}
                      className="min-w-0 flex-1 animate-pulse rounded-t-lg bg-[var(--app-skeleton-base)]"
                      style={{ height: `${height}%` }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              ) : webChartHasData ? (
                <AreaChart
                  data={webChartConfig.data}
                  height={340}
                  showGrid
                  color={webChartConfig.color}
                  color2={webChartConfig.color2}
                  legendLabels={{ label1: webChartConfig.label1, label2: webChartConfig.label2 }}
                  formatValue={formatTrafficAxis}
                  formatTooltipValue={formatTrafficTooltip}
                />
              ) : (
                <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface) 82%, transparent)] px-4 text-center text-sm text-[var(--text-mute)]">
                  {webChartConfig.emptyMessage}
                </div>
              )}
            </div>
          </Card>
          )}

          {showMessageAnalyticsBlocks && (
          <Card variant="glass" className="p-6">
            <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-semibold text-[var(--text)]">{messageChartConfig.title}</h2>
                <p className="mt-1 text-sm text-[var(--text-mute)]">
                  {messageChartConfig.description}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3 lg:justify-end">
                <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-dim)]">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: messageChartConfig.color }} />
                    <span className="font-medium">{messageChartConfig.label1}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="relative w-full" style={{ minHeight: 340, height: 340 }}>
              {analyticsRefreshing ? (
                <div data-ristak-chart-empty className="flex h-full items-end justify-between gap-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface) 82%, transparent)] p-5" role="status" aria-live="polite" aria-label="Cargando mensajes">
                  {[48, 70, 58, 84, 62, 74].map((height, index) => (
                    <span
                      key={`analytics-message-chart-skeleton-${index}`}
                      className="min-w-0 flex-1 animate-pulse rounded-t-lg bg-[var(--app-skeleton-base)]"
                      style={{ height: `${height}%` }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              ) : messageChartHasData ? (
                <AreaChart
                  data={messageChartConfig.data}
                  height={340}
                  showGrid
                  color={messageChartConfig.color}
                  color2={messageChartConfig.color2}
                  legendLabels={{ label1: messageChartConfig.label1 }}
                  formatValue={formatTrafficAxis}
                  formatTooltipValue={formatTrafficTooltip}
                />
              ) : (
                <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface) 82%, transparent)] px-4 text-center text-sm text-[var(--text-mute)]">
                  {messageChartConfig.emptyMessage}
                </div>
              )}
            </div>
          </Card>
          )}
        </div>
        )}

        {/* Grid de Gráficas: Conversión y Distribución */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            variant="glass"
            className="p-6 h-full [&>[data-ristak-card-content]]:flex [&>[data-ristak-card-content]]:h-full [&>[data-ristak-card-content]]:flex-col"
          >
            <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <ViewSelector
                  variant="title"
                  options={conversionChartOptions}
                  value={selectedConversionChartView}
                  onChange={(value) => {
                    if (isAnalyticsConversionChartView(value)) {
                      setSelectedConversionChartView(value)
                      navigateAnalyticsView({ conversionChart: value })
                    }
                  }}
                />
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {conversionChartConfig.description}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
                <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--color-text-secondary)]">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: conversionChartConfig.color }} />
                    <span className="font-medium">{conversionChartConfig.label1}</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: conversionChartConfig.color2 }} />
                    <span className="font-medium">{conversionChartConfig.label2}</span>
                  </span>
                </div>
              </div>
            </div>
            <div className="relative w-full flex-1 min-h-[340px]">
              {analyticsRefreshing ? (
                <div data-ristak-chart-empty className="flex h-full items-end justify-between gap-3 rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] p-5" role="status" aria-live="polite" aria-label="Cargando datos">
                  {[48, 70, 58, 84, 62, 74].map((height, index) => (
                    <span
                      key={`analytics-conversion-chart-skeleton-${index}`}
                      className="min-w-0 flex-1 animate-pulse rounded-t-lg bg-[var(--app-skeleton-base)]"
                      style={{ height: `${height}%` }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              ) : conversionChartHasData ? (
                <AreaChart
                  data={conversionChartConfig.data}
                  height="100%"
                  minHeight={340}
                  showGrid
                  color={conversionChartConfig.color}
                  color2={conversionChartConfig.color2}
                  legendLabels={{ label1: conversionChartConfig.label1, label2: conversionChartConfig.label2 }}
                  formatValue={formatTrafficAxis}
                  formatTooltipValue={formatTrafficTooltip}
                  onPointClick={handleConversionPointClick}
                />
              ) : (
                <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                  {conversionChartConfig.emptyMessage}
                </div>
              )}
            </div>
          </Card>

          <OriginDistributionCard />
        </div>

        {/* Grid de stats cards */}
        {showWebAnalyticsBlocks && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Top Plataformas */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Plataformas</h3>
            </div>
            <div className="p-5 space-y-4">
              {platformsData.map((platform, index) => {
                const PlatformIcon = getPlatformIcon(platform.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlatformIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{platform.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{platform.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${platform.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Ubicaciones */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Ubicaciones</h3>
            </div>
            <div className="p-5 space-y-4">
              {placementsData.map((placement, index) => {
                const PlacementIcon = getPlacementIcon(placement.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlacementIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{placement.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{placement.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${placement.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Dispositivos */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Dispositivos</h3>
            </div>
            <div className="p-5 space-y-4">
              {devicesData.map((device, index) => {
                const DeviceIcon = getDeviceIcon(device.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <DeviceIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{device.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{device.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${device.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Sistemas */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Sistemas</h3>
            </div>
            <div className="p-5 space-y-4">
              {osData.map((os, index) => {
                const OSIcon = getOSIcon(os.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <OSIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{os.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{os.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${os.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Navegadores */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Navegadores</h3>
            </div>
            <div className="p-5 space-y-4">
              {browserData.map((browser, index) => {
                const BrowserIcon = getBrowserIcon(browser.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BrowserIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{browser.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{browser.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${browser.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Visitors */}
          <Card variant="glass">
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold">Top Visitantes</h3>
            </div>
            <div className="p-5">
              <div className="space-y-3">
                {topVisitors.map((visitor, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-gray-400 font-mono">{visitor.id}</span>
                    <span className="text-sm font-semibold">{visitor.requests} requests</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
        )}

        {/* Tabla de sesiones de tracking */}
        {showWebAnalyticsBlocks && (
          <SessionsTable
            filteredSessions={sessions}
            useExternalData={true}
          />
        )}
      </div>

      <ContactDetailsModal
        isOpen={contactModalState.open}
        onClose={() => setContactModalState(emptyContactModalState)}
        title={contactModalState.title}
        subtitle={contactModalState.subtitle}
        data={contactModalState.contacts}
        loading={contactModalState.loading}
        type={contactModalState.type}
      />
    </PageContainer>
  )
}

export default Analytics
