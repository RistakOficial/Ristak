import React, { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useDateRange } from '../../contexts/DateRangeContext'
import { useTimezone } from '../../contexts/TimezoneContext'
import { useLabels } from '../../contexts/LabelsContext'
import { useAuth } from '../../contexts/AuthContext'
import { useUrlDateRangeSync, useUrlFilterState } from '../../hooks'
import {
  PageContainer,
  PageHeader,
  Card,
  DateRangePicker,
  ViewSelector,
  TabList,
  Button,
  AreaChart,
  TreeFilter,
  OriginDistributionCard,
  SessionsTable
} from '../../components/common'
import { KpiCard } from '../../components/common/KpiCard/KpiCard'
import { ContactDetailsModal } from '../../components/common/ContactDetailsModal/ContactDetailsModal'
import { Eye, Users, UserCheck, Target, Smartphone, Monitor, Tablet, Globe, Minus, Plus, MessageCircle } from 'lucide-react'
import { FaFacebook, FaGoogle, FaInstagram, FaTiktok, FaTwitter, FaLinkedin, FaMicrosoft, FaChrome, FaFirefox, FaSafari, FaEdge, FaOpera, FaWindows, FaAndroid, FaLinux } from 'react-icons/fa'
import { SiMacos, SiIos } from 'react-icons/si'
import {
  getContactConversionsByDate,
  getContactConversionContacts,
  getMessageAnalyticsSummary,
  getTrackingAnalyticsFacet,
  getTrackingAnalyticsSummary,
  peekTrackingAnalyticsSummary,
  scheduleTrackingAnalyticsStaleRevalidation,
  TRACKING_ANALYTICS_VIEWPORT_DISTRIBUTION_DIMENSIONS as ANALYTICS_DISTRIBUTION_DIMENSIONS,
  type ContactsByDate,
  type ContactConversionListType,
  type ContactConversionsByDate,
  type MessageAnalyticsSummary,
  type TrackingAnalyticsFacetItem,
  type TrackingAnalyticsFacetDimension,
  type TrackingAnalyticsSummary,
  type TrackingAnalyticsSummaryInput
} from '../../services/analyticsService'
import { trackingService, type TrackingSession } from '../../services/trackingService'
import type { ContactListItem } from '../../services/reportsService'
import { contactsService } from '../../services/contactsService'
import { formatDateToISO, normalizeDateInputToLocalDate, parseLocalDateString, formatUrlParameter, formatChartNumber } from '../../utils/format'
import { dateOnlyToLocalDate, todayDateOnlyInTimezone } from '../../utils/timezone'
import { normalizeTrafficSource } from '../../utils/trafficSourceNormalizer'
import { readNumberParam, setSearchParam } from '../../utils/urlState'
import { hasLicenseFeature } from '../../utils/accessControl'
import { useNotification } from '../../contexts/NotificationContext'

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
  listType: ContactConversionListType
  range: { from: string; to: string } | null
  cursor: string | null
  cursorHistory: Array<string | null>
  page: number
  search: string
  pagination: {
    limit: number
    hasNext: boolean
    nextCursor: string | null
  }
}

const emptyContactModalState: AnalyticsContactModalState = {
  open: false,
  title: '',
  subtitle: '',
  type: 'interesados',
  contacts: [],
  loading: false,
  listType: 'registrations',
  range: null,
  cursor: null,
  cursorHistory: [],
  page: 1,
  search: '',
  pagination: { limit: 50, hasNext: false, nextCursor: null }
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

const toNamedFacet = (items: TrackingAnalyticsFacetItem[] = []) => (
  items.map(item => ({ name: item.value, count: item.count }))
)

const toValuedFacet = (items: TrackingAnalyticsFacetItem[] = []) => (
  items.map(item => ({ value: item.value, name: item.label || item.value, count: item.count }))
)

const buildTrackingFilterData = (
  summary: TrackingAnalyticsSummary | null,
  conversionFilters: Array<{ stage: ConversionStage; label: string }>
) => {
  const facets = summary?.facets || {}
  const conversionCounts = new Map((facets.conversions || []).map(item => [item.value, item.count]))

  return {
    pages: (facets.pages || []).map(item => ({ page: item.value, count: item.count })),
    campaigns: toNamedFacet(facets.campaigns),
    adsets: toNamedFacet(facets.adsets),
    ads: toNamedFacet(facets.ads),
    sources: toNamedFacet(facets.sources),
    devices: toNamedFacet(facets.devices),
    browsers: toNamedFacet(facets.browsers),
    os: toNamedFacet(facets.os),
    placements: toNamedFacet(facets.placements),
    trafficChannels: toValuedFacet(facets.trafficChannels),
    trackingSources: toValuedFacet(facets.trackingSources),
    siteTypes: toValuedFacet(facets.siteTypes),
    nativeSites: toValuedFacet(facets.nativeSites),
    nativeForms: toValuedFacet(facets.nativeForms),
    nativeConversions: toValuedFacet(facets.nativeConversions),
    conversions: conversionFilters.map(item => ({
      stage: item.stage,
      name: item.label,
      count: conversionCounts.get(item.stage) || 0
    })),
    adsHierarchy: Array.isArray(facets.adsHierarchy) ? facets.adsHierarchy : []
  }
}

const ANALYTICS_DEFERRED_FILTER_CATEGORIES = [
  'tracking_sources',
  'traffic_channels',
  'site_types',
  'native_sites',
  'native_forms',
  'native_conversions',
  'pages',
  'ads',
  'sources',
  'devices',
  'browsers',
  'os',
  'placements'
]

const ANALYTICS_FILTER_DIMENSION_BY_CATEGORY: Record<string, TrackingAnalyticsFacetDimension> = {
  tracking_sources: 'trackingSources',
  traffic_channels: 'trafficChannels',
  site_types: 'siteTypes',
  native_sites: 'nativeSites',
  native_forms: 'nativeForms',
  native_conversions: 'nativeConversions',
  pages: 'pages',
  ads: 'adsHierarchy',
  sources: 'sources',
  devices: 'devices',
  browsers: 'browsers',
  os: 'os',
  placements: 'placements'
}

const ANALYTICS_FILTER_CATEGORY_BY_FIELD: Record<string, string> = {
  tracking_source: 'tracking_sources',
  channel: 'traffic_channels',
  site_type: 'site_types',
  site_id: 'native_sites',
  form_site_id: 'native_forms',
  native_conversion_source: 'native_conversions',
  landing_url: 'pages',
  page_url: 'pages',
  utm_source: 'ads',
  utm_campaign: 'ads',
  utm_medium: 'ads',
  utm_content: 'ads',
  device_type: 'devices',
  browser: 'browsers',
  os: 'os',
  placement: 'placements'
}

const trackingFacetToFilterData = (
  dimension: TrackingAnalyticsFacetDimension,
  items: unknown[]
): Record<string, unknown> => {
  if (dimension === 'adsHierarchy') return { adsHierarchy: items }
  const facetItems = items as TrackingAnalyticsFacetItem[]
  if (dimension === 'pages') {
    return { pages: facetItems.map(item => ({ page: item.value, count: item.count })) }
  }
  if (['trafficChannels', 'trackingSources', 'siteTypes', 'nativeSites', 'nativeForms', 'nativeConversions'].includes(dimension)) {
    return { [dimension]: toValuedFacet(facetItems) }
  }
  return { [dimension]: toNamedFacet(facetItems) }
}

const toDistributionStats = (
  items: TrackingAnalyticsFacetItem[] = [],
  uniqueVisitors = 0
) => {
  const denominator = Math.max(uniqueVisitors, 1)
  return items.slice(0, 5).map(item => ({
    name: item.label || item.value,
    users: item.count,
    percentage: ((item.count / denominator) * 100).toFixed(1)
  }))
}

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
  const { user } = useAuth()
  const { showToast } = useNotification()
  const hasWebAnalyticsAccess = hasLicenseFeature(user, ['web_analytics'])
  const [loading, setLoading] = useState(false)
  const [hasLoadedAnalytics, setHasLoadedAnalytics] = useState(false)
  const [messageLoading, setMessageLoading] = useState(false)
  const [hasLoadedMessageAnalytics, setHasLoadedMessageAnalytics] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [analyticsRetryKey, setAnalyticsRetryKey] = useState(0)
  const [hasWebAnalyticsSnapshot, setHasWebAnalyticsSnapshot] = useState(false)
  const [loadedAnalyticsCoreScopeKey, setLoadedAnalyticsCoreScopeKey] = useState<string | null>(null)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(hasWebAnalyticsAccess)
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
  const [webFilterData, setWebFilterData] = useState<Record<string, unknown>>({})
  const [messageFilterData, setMessageFilterData] = useState<Record<string, unknown>>({})
  const [loadedWebFilterCategories, setLoadedWebFilterCategories] = useState<string[]>([])
  const [loadingWebFilterCategories, setLoadingWebFilterCategories] = useState<string[]>([])
  const analyticsFacetControllersRef = React.useRef(new Map<string, AbortController>())
  const analyticsFacetGenerationRef = React.useRef(0)
  const analyticsStatsGridRef = React.useRef<HTMLDivElement | null>(null)
  const [shouldLoadAnalyticsDistributions, setShouldLoadAnalyticsDistributions] = useState(false)
  const [topVisitorsPanelVisible, setTopVisitorsPanelVisible] = useState(false)
  const availableFilterData = React.useMemo(
    () => ({ ...webFilterData, ...messageFilterData }),
    [messageFilterData, webFilterData]
  )

  // Estado para visualizaciones
  const [dailyTraffic, setDailyTraffic] = useState<TrafficPoint[]>([])
  const [dailyConversions, setDailyConversions] = useState<any[]>([])
  const [sessionTrendSeries, setSessionTrendSeries] = useState<SessionTrendPoint[]>([])
  const [conversionTrendSeries, setConversionTrendSeries] = useState<ConversionTrendPoint[]>([])
  const [contactModalState, setContactModalState] = useState<AnalyticsContactModalState>(emptyContactModalState)
  const contactModalRequestRef = React.useRef(0)
  const contactModalAbortRef = React.useRef<AbortController | null>(null)
  useEffect(() => () => {
    contactModalRequestRef.current += 1
    contactModalAbortRef.current?.abort()
    contactModalAbortRef.current = null
  }, [])
  const [analyticsDistributionFacets, setAnalyticsDistributionFacets] = useState<
    Partial<Record<TrackingAnalyticsFacetDimension, TrackingAnalyticsFacetItem[]>>
  >({})
  const [viewType, setViewType] = useState<ViewType>(routeState.viewType)
  const [monthPreset, setMonthPreset] = useState<MonthPreset>(routeMonthPreset)
  const [yearRange, setYearRange] = useState(routeYearRange)
  const [selectedMainChartView, setSelectedMainChartView] = useState<AnalyticsMainChartView>(routeState.mainChart)
  const [selectedConversionChartView, setSelectedConversionChartView] = useState<AnalyticsConversionChartView>(routeState.conversionChart)
  const handleTrackingSessionsChanged = useCallback(() => {
    setAnalyticsRetryKey(current => current + 1)
  }, [])

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
  const platformsData = React.useMemo(
    () => toDistributionStats(analyticsDistributionFacets.sources, metrics.uniqueVisitors),
    [analyticsDistributionFacets.sources, metrics.uniqueVisitors]
  )
  const placementsData = React.useMemo(
    () => toDistributionStats(analyticsDistributionFacets.placements, metrics.uniqueVisitors),
    [analyticsDistributionFacets.placements, metrics.uniqueVisitors]
  )
  const devicesData = React.useMemo(
    () => toDistributionStats(analyticsDistributionFacets.devices, metrics.uniqueVisitors),
    [analyticsDistributionFacets.devices, metrics.uniqueVisitors]
  )
  const osData = React.useMemo(
    () => toDistributionStats(analyticsDistributionFacets.os, metrics.uniqueVisitors),
    [analyticsDistributionFacets.os, metrics.uniqueVisitors]
  )
  const browserData = React.useMemo(
    () => toDistributionStats(analyticsDistributionFacets.browsers, metrics.uniqueVisitors),
    [analyticsDistributionFacets.browsers, metrics.uniqueVisitors]
  )
  const topVisitors = React.useMemo(
    () => (analyticsDistributionFacets.topVisitors || []).slice(0, 5).map(item => {
      const visitorId = item.value || item.label
      return {
        id: visitorId.length > 24 ? `${visitorId.slice(0, 24)}...` : visitorId,
        requests: item.count
      }
    }),
    [analyticsDistributionFacets.topVisitors]
  )

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

  const webSummaryFilters = React.useMemo<Record<string, string[]>>(() => (
    Object.fromEntries(
      Object.entries(selectedFilters).filter(([field, values]) => (
        !isMessageFilterField(field) && values.length > 0
      ))
    )
  ), [selectedFilters])
  const webSummaryFilterKey = React.useMemo(
    () => JSON.stringify(webSummaryFilters),
    [webSummaryFilters]
  )
  const analyticsSummaryInput = React.useMemo<TrackingAnalyticsSummaryInput>(() => ({
    start: apiRange.from,
    end: apiRange.to,
    groupBy: viewType,
    filters: webSummaryFilters,
    includeFacets: false
  }), [apiRange.from, apiRange.to, viewType, webSummaryFilterKey])
  const analyticsSummaryScopeKey = React.useMemo(() => JSON.stringify(analyticsSummaryInput), [analyticsSummaryInput])
  const analyticsRequestIdRef = React.useRef(0)
  const messageAnalyticsRequestIdRef = React.useRef(0)

  useEffect(() => {
    analyticsFacetGenerationRef.current += 1
    for (const controller of analyticsFacetControllersRef.current.values()) controller.abort()
    analyticsFacetControllersRef.current.clear()
    setLoadedWebFilterCategories([])
    setLoadingWebFilterCategories([])
    setLoadedAnalyticsCoreScopeKey(null)
    setWebFilterData({})
    setAnalyticsDistributionFacets({})
    setShouldLoadAnalyticsDistributions(false)
    setTopVisitorsPanelVisible(false)
  }, [analyticsSummaryScopeKey])

  useEffect(() => () => {
    analyticsFacetGenerationRef.current += 1
    for (const controller of analyticsFacetControllersRef.current.values()) controller.abort()
    analyticsFacetControllersRef.current.clear()
  }, [])

  const loadWebFilterCategory = useCallback(async (categoryId: string) => {
    if (!hasWebAnalyticsAccess) return
    const dimension = ANALYTICS_FILTER_DIMENSION_BY_CATEGORY[categoryId]
    if (!dimension || loadedWebFilterCategories.includes(categoryId)) return

    const requestKey = `filter:${categoryId}`
    if (analyticsFacetControllersRef.current.has(requestKey)) return
    const controller = new AbortController()
    const generation = analyticsFacetGenerationRef.current
    analyticsFacetControllersRef.current.set(requestKey, controller)
    setLoadingWebFilterCategories(current => current.includes(categoryId) ? current : [...current, categoryId])

    try {
      const response = await getTrackingAnalyticsFacet({
        start: analyticsSummaryInput.start,
        end: analyticsSummaryInput.end,
        filters: analyticsSummaryInput.filters,
        dimension
      }, { signal: controller.signal })
      if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
      setWebFilterData(current => ({
        ...current,
        ...trackingFacetToFilterData(dimension, response.facet.items)
      }))
      setLoadedWebFilterCategories(current => current.includes(categoryId) ? current : [...current, categoryId])
    } catch (error) {
      if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
      console.error(`No se pudo cargar la faceta ${dimension}:`, error)
      showToast('error', 'No se pudo cargar ese filtro', 'Intenta abrir la categoría nuevamente.')
    } finally {
      if (analyticsFacetControllersRef.current.get(requestKey) === controller) {
        analyticsFacetControllersRef.current.delete(requestKey)
      }
      if (generation === analyticsFacetGenerationRef.current) {
        setLoadingWebFilterCategories(current => current.filter(item => item !== categoryId))
      }
    }
  }, [analyticsSummaryInput, hasWebAnalyticsAccess, loadedWebFilterCategories, showToast])

  useEffect(() => {
    if (
      !hasWebAnalyticsAccess
      || !hasWebAnalyticsSnapshot
      || loadedAnalyticsCoreScopeKey !== analyticsSummaryScopeKey
    ) return
    const activeCategories = new Set<string>()
    for (const [field, values] of Object.entries(selectedFilters)) {
      if (!values.length) continue
      const category = ANALYTICS_FILTER_CATEGORY_BY_FIELD[field]
      if (category) activeCategories.add(category)
    }
    for (const category of activeCategories) void loadWebFilterCategory(category)
  }, [
    analyticsSummaryScopeKey,
    hasWebAnalyticsAccess,
    hasWebAnalyticsSnapshot,
    loadWebFilterCategory,
    loadedAnalyticsCoreScopeKey,
    selectedFilters
  ])

  // El navegador recibe agregados acotados; nunca el historial crudo de tracking.
  useEffect(() => {
    const controller = new AbortController()
    let staleRevalidationTimer: ReturnType<typeof setTimeout> | null = null
    const requestId = ++analyticsRequestIdRef.current
    const cachedSummary = hasWebAnalyticsAccess
      ? peekTrackingAnalyticsSummary(analyticsSummaryInput)
      : null
    setLoading(!cachedSummary)

    const isCurrentRequest = () => (
      !controller.signal.aborted && analyticsRequestIdRef.current === requestId
    )

    const applyTrackingSummary = (summary: TrackingAnalyticsSummary) => {
      const groupBy = summary.range.groupBy
      const range = { from: summary.range.start, to: summary.range.end }
      const current = summary.metrics.current
      const trends = summary.metrics.trends

      const trafficSeries = completeSessionTrendPeriods(
        summary.trafficSeries.map(point => ({
          label: formatPeriodLabel(point.period, groupBy),
          ...getPeriodPointMeta(point.period, groupBy),
          pageViews: point.pageViews,
          uniqueVisitors: point.uniqueVisitors,
          uniqueSessions: point.uniqueSessions,
          identifiedContacts: point.identifiedContacts,
          returningVisitors: point.returningUsers
        })),
        groupBy,
        range
      )
      const conversionSeries = completeConversionTrendPeriods(
        summary.conversionSeries.map(point => ({
          label: formatPeriodLabel(point.period, groupBy),
          ...getPeriodPointMeta(point.period, groupBy),
          registrations: point.registrations,
          prospects: point.prospects,
          appointments: point.appointments,
          attendances: point.attendances,
          customers: point.customers
        })),
        groupBy,
        range
      )

      setMetrics({
        pageViews: current.pageViews,
        uniqueVisitors: current.uniqueVisitors,
        registros: current.registrations,
        conversionRate: current.conversionRate,
        returningUsers: current.returningUsers,
        avgPagePerSession: current.avgPagePerSession,
        trends: {
          pageViews: trends.pageViews,
          uniqueVisitors: trends.uniqueVisitors,
          registros: trends.registrations,
          conversionRate: trends.conversionRate,
          returningUsers: trends.returningUsers,
          avgPagePerSession: trends.avgPagePerSession
        }
      })
      setSessionTrendSeries(trafficSeries)
      setConversionTrendSeries(conversionSeries)
      setDailyTraffic(trafficSeries.map(point => ({
        label: point.label,
        value: point.pageViews,
        value2: point.uniqueVisitors,
        periodKey: point.periodKey,
        periodStart: point.periodStart,
        periodEnd: point.periodEnd
      })))
      setDailyConversions(conversionSeries.map(point => ({
        label: point.label,
        value: point.registrations,
        value2: 0,
        periodKey: point.periodKey,
        periodStart: point.periodStart,
        periodEnd: point.periodEnd
      })))

      const distributions = summary.distributions || {}
      const receivedDistributionFacets = Object.fromEntries(
        ANALYTICS_DISTRIBUTION_DIMENSIONS
          .filter(dimension => Array.isArray(distributions[dimension]))
          .map(dimension => [dimension, distributions[dimension]])
      ) as Partial<Record<TrackingAnalyticsFacetDimension, TrackingAnalyticsFacetItem[]>>
      if (Object.keys(receivedDistributionFacets).length > 0) {
        setAnalyticsDistributionFacets(existing => ({ ...existing, ...receivedDistributionFacets }))
      }
      const conversionData = buildTrackingFilterData(summary, conversionFilters).conversions
      setWebFilterData(existing => ({ ...existing, conversions: conversionData }))
      setHasWebAnalyticsSnapshot(true)
      setLoadedAnalyticsCoreScopeKey(analyticsSummaryScopeKey)
      if (current.pageViews > 0 || current.uniqueVisitors > 0) {
        setWebTrackingConfigured(true)
      }
    }

    const scheduleStaleRevalidation = (summary: TrackingAnalyticsSummary) => {
      if (!summary.snapshot?.stale || staleRevalidationTimer) return

      // El primer request ya hace que backend reconstruya el snapshot stale en
      // segundo plano. Esperar una ventana tranquila evita abrir de inmediato
      // un segundo POST que compita con mensajes, tabla y facetas por viewport.
      staleRevalidationTimer = scheduleTrackingAnalyticsStaleRevalidation(summary.snapshot, () => {
        staleRevalidationTimer = null
        void getTrackingAnalyticsSummary(analyticsSummaryInput, {
          signal: controller.signal,
          forceRefresh: true,
          waitForFresh: true
        })
          .then(freshSummary => {
            if (isCurrentRequest()) applyTrackingSummary(freshSummary)
          })
          .catch(error => {
            if (!isCurrentRequest()) return
            console.warn('No se pudo revalidar el snapshot de Analíticas:', error)
          })
      })
    }

    // Stale-while-revalidate real: el snapshot tiene que pintarse antes de
    // arrancar la revalidación. Leerlo únicamente para ocultar el loader dejaba
    // visibles las métricas del rango anterior bajo las fechas nuevas.
    if (cachedSummary) {
      setAnalyticsError(null)
      applyTrackingSummary(cachedSummary)
      setHasLoadedAnalytics(true)
    }

    const fetchAnalytics = async () => {
      try {
        const summaryPromise = hasWebAnalyticsAccess
          ? getTrackingAnalyticsSummary(analyticsSummaryInput, {
              signal: controller.signal
            })
          : Promise.resolve(null)
        const fallbackConversionsPromise = hasWebAnalyticsAccess
          ? Promise.resolve([] as ContactConversionsByDate[])
          : getContactConversionsByDate(apiRange.from, apiRange.to, controller.signal)
        const trackingConfigPromise = hasWebAnalyticsAccess
          ? trackingService.getTrackingConfig().catch(() => null)
          : Promise.resolve(null)

        const [summary, fallbackConversions] = await Promise.all([
          summaryPromise,
          fallbackConversionsPromise
        ])

        if (!isCurrentRequest()) return
        setAnalyticsError(null)

        if (summary) {
          applyTrackingSummary(summary)
          scheduleStaleRevalidation(summary)
          void trackingConfigPromise.then(trackingConfig => {
            if (!trackingConfig || !isCurrentRequest()) return
            const current = summary.metrics.current
            setWebTrackingConfigured(Boolean(
              trackingConfig.isConfigured ||
              trackingConfig.hasPublicSites ||
              current.pageViews > 0 ||
              current.uniqueVisitors > 0
            ))
          })
        } else if (!hasWebAnalyticsAccess) {
          const fallbackSeries = completeConversionTrendPeriods(
            aggregateContactConversionsByPeriod(fallbackConversions, viewType),
            viewType,
            { from: apiRange.from, to: apiRange.to }
          )
          setWebTrackingConfigured(false)
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
          setDailyTraffic([])
          setDailyConversions(fallbackSeries.map(point => ({
            label: point.label,
            value: point.registrations,
            value2: 0,
            periodKey: point.periodKey,
            periodStart: point.periodStart,
            periodEnd: point.periodEnd
          })))
          setSessionTrendSeries([])
          setConversionTrendSeries(fallbackSeries)
          setAnalyticsDistributionFacets({})
          setWebFilterData({})
        }
      } catch (error) {
        if (!isCurrentRequest()) return
        console.error('No se pudo cargar el resumen web de Analíticas:', error)
        setAnalyticsError('No pudimos cargar el tráfico del sitio. Tus datos no se reemplazaron por ceros; puedes reintentar sin salir de esta página.')
      } finally {
        if (isCurrentRequest()) {
          setLoading(false)
          setHasLoadedAnalytics(true)
        }
      }
    }

    void fetchAnalytics()

    return () => {
      if (staleRevalidationTimer) clearTimeout(staleRevalidationTimer)
      controller.abort()
    }
  }, [
    analyticsSummaryInput,
    analyticsRetryKey,
    apiRange.from,
    apiRange.to,
    conversionFilters,
    hasWebAnalyticsAccess,
    viewType
  ])

  // Mensajes se resuelve en paralelo y nunca frena las métricas web.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const requestId = ++messageAnalyticsRequestIdRef.current
    setMessageLoading(true)

    const fetchMessageAnalytics = async () => {
      try {
        const summary = await getMessageAnalyticsSummary(
          apiRange.from,
          apiRange.to,
          viewType,
          messageSummaryFilters,
          controller.signal
        )

        if (cancelled || messageAnalyticsRequestIdRef.current !== requestId) return
        setMessageAnalytics(summary)
        const nextFilterData = getMessageFilterData(summary)
        setMessageFilterData(hasAvailableFilterOptions(nextFilterData) ? nextFilterData : {})
      } catch (error) {
        if (cancelled || messageAnalyticsRequestIdRef.current !== requestId) return
        setMessageAnalytics(null)
        setMessageFilterData({})
        console.error('No se pudo cargar el resumen de mensajes de Analíticas:', error)
        showToast(
          'error',
          'No se cargó el resumen de mensajes',
          error instanceof Error ? error.message : 'Intenta nuevamente'
        )
      } finally {
        if (!cancelled && messageAnalyticsRequestIdRef.current === requestId) {
          setMessageLoading(false)
          setHasLoadedMessageAnalytics(true)
        }
      }
    }

    void fetchMessageAnalytics()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    apiRange.from,
    apiRange.to,
    messageSummaryFilterKey,
    messageSummaryFilters,
    showToast,
    viewType
  ])

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
  const analyticsRefreshing = loading || !hasLoadedAnalytics
  const messageAnalyticsRefreshing = messageLoading || !hasLoadedMessageAnalytics
  const showWebAnalyticsBlocks = hasWebAnalyticsAccess && Boolean(
    (!analyticsError || hasWebAnalyticsSnapshot) &&
    (webTrackingConfigured || hasWebAnalyticsData)
  )
  const showMessageAnalyticsBlocks = Boolean(
    messageAnalytics?.status?.connected ||
    hasMessageAnalyticsData
  )

  useEffect(() => {
    if (!showWebAnalyticsBlocks || shouldLoadAnalyticsDistributions) return
    const target = analyticsStatsGridRef.current
    if (!target || typeof IntersectionObserver === 'undefined') {
      setShouldLoadAnalyticsDistributions(true)
      return
    }

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setShouldLoadAnalyticsDistributions(true)
      observer.disconnect()
    }, { rootMargin: '280px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [shouldLoadAnalyticsDistributions, showWebAnalyticsBlocks])

  useEffect(() => {
    if (
      !shouldLoadAnalyticsDistributions
      || loadedAnalyticsCoreScopeKey !== analyticsSummaryScopeKey
      || !hasWebAnalyticsAccess
    ) return

    const controller = new AbortController()
    const generation = analyticsFacetGenerationRef.current
    let reportedError = false

    const loadDistributions = async () => {
      for (const dimension of ANALYTICS_DISTRIBUTION_DIMENSIONS) {
        if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
        try {
          const response = await getTrackingAnalyticsFacet({
            start: analyticsSummaryInput.start,
            end: analyticsSummaryInput.end,
            filters: analyticsSummaryInput.filters,
            dimension
          }, { signal: controller.signal })
          if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
          const items = response.facet.items as TrackingAnalyticsFacetItem[]
          setAnalyticsDistributionFacets(existing => ({ ...existing, [dimension]: items }))
        } catch (error) {
          if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
          console.error(`No se pudo cargar la distribución ${dimension}:`, error)
          if (!reportedError) {
            reportedError = true
            showToast('error', 'No se cargaron algunos desgloses', 'Las métricas principales siguen disponibles; desplázate de nuevo para reintentar.')
          }
        }
      }
    }

    void loadDistributions()
    return () => controller.abort()
  }, [
    analyticsSummaryInput,
    analyticsSummaryScopeKey,
    hasWebAnalyticsAccess,
    loadedAnalyticsCoreScopeKey,
    shouldLoadAnalyticsDistributions,
    showToast
  ])

  // Top Visitantes es la faceta de mayor cardinalidad. Se calcula únicamente
  // cuando su propia tarjeta se acerca al viewport; no junto con los cinco
  // desgloses secundarios del grid.
  useEffect(() => {
    if (
      !topVisitorsPanelVisible
      || loadedAnalyticsCoreScopeKey !== analyticsSummaryScopeKey
      || !hasWebAnalyticsAccess
    ) return

    const controller = new AbortController()
    const generation = analyticsFacetGenerationRef.current

    void getTrackingAnalyticsFacet({
      start: analyticsSummaryInput.start,
      end: analyticsSummaryInput.end,
      filters: analyticsSummaryInput.filters,
      dimension: 'topVisitors'
    }, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
        setAnalyticsDistributionFacets(existing => ({
          ...existing,
          topVisitors: response.facet.items as TrackingAnalyticsFacetItem[]
        }))
      })
      .catch(error => {
        if (controller.signal.aborted || generation !== analyticsFacetGenerationRef.current) return
        console.error('No se pudo cargar la distribución topVisitors:', error)
        showToast(
          'error',
          'No se cargaron los visitantes principales',
          'Las métricas principales siguen disponibles; cambia de rango para reintentar.'
        )
      })

    return () => controller.abort()
  }, [
    analyticsSummaryInput,
    analyticsSummaryScopeKey,
    hasWebAnalyticsAccess,
    loadedAnalyticsCoreScopeKey,
    showToast,
    topVisitorsPanelVisible
  ])

  useEffect(() => {
    if (!showWebAnalyticsBlocks || topVisitorsPanelVisible) return
    const panel = document.querySelector<HTMLElement>('[data-analytics-top-visitors]')
    if (!panel) return

    if (typeof IntersectionObserver === 'undefined') {
      setTopVisitorsPanelVisible(true)
      return
    }

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setTopVisitorsPanelVisible(true)
      observer.disconnect()
    }, { rootMargin: '160px 0px' })

    observer.observe(panel)
    return () => observer.disconnect()
  }, [showWebAnalyticsBlocks, topVisitorsPanelVisible])

  const metricSections: Array<{ title: string; metrics: typeof webMetrics; loading: boolean }> = []
  if (showWebAnalyticsBlocks) {
    metricSections.push({ title: 'Tráfico del sitio', metrics: webMetrics, loading: analyticsRefreshing })
  }
  if (showMessageAnalyticsBlocks) {
    metricSections.push({ title: 'Mensajes', metrics: messageMetricCards, loading: messageAnalyticsRefreshing })
  }
  const sourceGridClassName = metricSections.length > 1 ? 'grid gap-4 xl:grid-cols-2' : 'grid gap-4'
  const analyticsSubtitle = analyticsError && !hasWebAnalyticsSnapshot
    ? 'El resumen web no respondió. Los mensajes siguen cargando por separado.'
    : showWebAnalyticsBlocks && showMessageAnalyticsBlocks
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
    showWebAnalyticsBlocks || (
      showMessageAnalyticsBlocks && hasAvailableFilterOptions(availableFilterData)
    )
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

  const sessionTrendData = sessionTrendSeries
  const conversionTrendData = conversionTrendSeries

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

  const loadConversionContactPage = useCallback(async (nextState: AnalyticsContactModalState) => {
    if (!nextState.range) return
    contactModalAbortRef.current?.abort()
    const controller = new AbortController()
    contactModalAbortRef.current = controller
    const requestId = contactModalRequestRef.current + 1
    contactModalRequestRef.current = requestId
    setContactModalState({ ...nextState, loading: true })

    try {
      const result = await getContactConversionContacts(
        nextState.range.from,
        nextState.range.to,
        nextState.listType,
        {
          cursor: nextState.cursor,
          search: nextState.search,
          limit: 50,
          signal: controller.signal
        }
      )
      if (contactModalRequestRef.current !== requestId) return

      setContactModalState({
        ...nextState,
        contacts: result.contacts.map(contact => ({
          ...contact,
          created_at: contact.created_at || (contact as any).createdAt || ''
        })),
        loading: false,
        pagination: {
          limit: result.pagination.limit,
          hasNext: result.pagination.hasNext,
          nextCursor: result.pagination.nextCursor
        }
      })
    } catch (error) {
      if (controller.signal.aborted) return
      if (contactModalRequestRef.current !== requestId) return
      setContactModalState({
        ...nextState,
        contacts: [],
        loading: false,
        pagination: { limit: 50, hasNext: false, nextCursor: null }
      })
      showToast('error', 'No se cargó la lista de conversiones', error instanceof Error ? error.message : 'Intenta nuevamente')
    } finally {
      if (contactModalAbortRef.current === controller) contactModalAbortRef.current = null
    }
  }, [showToast])

  const handleConversionContactPageChange = useCallback((direction: 'next' | 'previous') => {
    if (!contactModalState.range) return
    if (direction === 'next') {
      if (!contactModalState.pagination.hasNext || !contactModalState.pagination.nextCursor) return
      void loadConversionContactPage({
        ...contactModalState,
        cursor: contactModalState.pagination.nextCursor,
        cursorHistory: [...contactModalState.cursorHistory, contactModalState.cursor],
        page: contactModalState.page + 1
      })
      return
    }

    if (contactModalState.page <= 1) return
    const previousCursor = contactModalState.cursorHistory[contactModalState.cursorHistory.length - 1] ?? null
    void loadConversionContactPage({
      ...contactModalState,
      cursor: previousCursor,
      cursorHistory: contactModalState.cursorHistory.slice(0, -1),
      page: contactModalState.page - 1
    })
  }, [contactModalState, loadConversionContactPage])

  const handleConversionContactSearch = useCallback((search: string) => {
    if (!contactModalState.range) return
    if (search === contactModalState.search) return
    void loadConversionContactPage({
      ...contactModalState,
      cursor: null,
      cursorHistory: [],
      page: 1,
      search
    })
  }, [contactModalState, loadConversionContactPage])

  const hydrateConversionContact = useCallback(async (contact: { id: string }) => {
    const detail = await contactsService.getContactDetails(contact.id, {
      warmProfilePictures: false,
      refreshExternalAppointments: false
    })

    return {
      ...detail,
      created_at: detail.createdAt,
      hasShowedAppointment: detail.hasShowedAppointment,
      hasAttendedAppointment: detail.hasAttendedAppointment
    }
  }, [])

  const closeConversionContactModal = useCallback(() => {
    contactModalRequestRef.current += 1
    contactModalAbortRef.current?.abort()
    contactModalAbortRef.current = null
    setContactModalState(emptyContactModalState)
  }, [])

  const handleConversionPointClick = useCallback(async (
    point: AnalyticsChartClickPoint,
    _index: number,
    seriesKey: ChartSeriesKey
  ) => {
    const clickConfig = getConversionClickConfig(seriesKey)
    const from = point.periodStart
    const to = point.periodEnd

    // La lista legacy no acepta filtros web. Evitamos mostrar contactos que no
    // corresponden al agregado filtrado hasta que ese drill-down tenga contrato
    // server-side propio.
    if (!clickConfig || !from || !to || hasActiveFiltersForCharts) return

    void loadConversionContactPage({
      open: true,
      title: `${clickConfig.title} · ${point.label}`,
      subtitle: formatRangeLabel(from, to),
      type: clickConfig.modalType,
      contacts: [],
      loading: true,
      listType: clickConfig.listType,
      range: { from, to },
      cursor: null,
      cursorHistory: [],
      page: 1,
      search: '',
      pagination: { limit: 50, hasNext: false, nextCursor: null }
    })
  }, [getConversionClickConfig, hasActiveFiltersForCharts, loadConversionContactPage])

  const conversionAnalyticsRefreshing = selectedConversionChartView === 'messages-appointments'
    ? messageAnalyticsRefreshing
    : analyticsRefreshing

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
                    loadableCategories={showWebAnalyticsBlocks ? ANALYTICS_DEFERRED_FILTER_CATEGORIES : []}
                    loadedCategories={loadedWebFilterCategories}
                    loadingCategories={loadingWebFilterCategories}
                    onCategoryIntent={loadWebFilterCategory}
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

        {analyticsError && (
          <Card variant="glass" className="p-4">
            <div role="alert" aria-live="assertive" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-display text-sm font-semibold text-[var(--text)]">El resumen web no respondió</p>
                <p className="mt-1 text-sm text-[var(--text-mute)]">
                  {hasWebAnalyticsSnapshot
                    ? 'Dejamos visible el último resultado correcto para no engañarte con ceros.'
                    : analyticsError}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => setAnalyticsRetryKey(current => current + 1)}
              >
                {loading ? 'Reintentando…' : 'Reintentar'}
              </Button>
            </div>
          </Card>
        )}

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
                      loading={section.loading}
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
              {messageAnalyticsRefreshing ? (
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
        <div className={showWebAnalyticsBlocks ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'}>
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
              {conversionAnalyticsRefreshing ? (
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
                  onPointClick={hasActiveFiltersForCharts ? undefined : handleConversionPointClick}
                />
              ) : (
                <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                  {conversionChartConfig.emptyMessage}
                </div>
              )}
            </div>
          </Card>

          {showWebAnalyticsBlocks && <OriginDistributionCard />}
        </div>

        {/* Grid de stats cards */}
        {showWebAnalyticsBlocks && (
        <div ref={analyticsStatsGridRef} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
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
          <Card variant="glass" data-analytics-top-visitors>
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
        {hasWebAnalyticsAccess && (
          <SessionsTable
            range={{ start: apiRange.from, end: apiRange.to }}
            filters={webSummaryFilters}
            onSessionsChanged={handleTrackingSessionsChanged}
          />
        )}
      </div>

      <ContactDetailsModal
        isOpen={contactModalState.open}
        onClose={closeConversionContactModal}
        title={contactModalState.title}
        subtitle={contactModalState.subtitle}
        data={contactModalState.contacts}
        loading={contactModalState.loading}
        type={contactModalState.type}
        currentPage={contactModalState.page}
        hasNextPage={contactModalState.pagination.hasNext}
        hasPreviousPage={contactModalState.page > 1}
        onPageChange={handleConversionContactPageChange}
        onSearchChange={handleConversionContactSearch}
        onSelectContact={hydrateConversionContact}
      />
    </PageContainer>
  )
}

export default Analytics
