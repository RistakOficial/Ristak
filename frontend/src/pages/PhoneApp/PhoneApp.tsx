import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  ChevronRight,
  Cog,
  CreditCard,
  Eye,
  Gauge,
  Megaphone,
  MessageCircle,
  MonitorX,
  Package,
  RefreshCw,
  TrendingUp,
  Users,
  type LucideIcon
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useHighLevelConnected, usePhoneElasticScroll } from '@/hooks'
import { AccountSettings } from '@/pages/Settings/AccountSettings'
import { AIAgentSettings } from '@/pages/Settings/AIAgentSettings'
import { calendarsService, type AppointmentStats, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { campaignsService, type Campaign } from '@/services/campaignsService'
import { contactsService, type ContactStats } from '@/services/contactsService'
import { dashboardService, type ChartData, type DashboardMetrics } from '@/services/dashboardService'
import { getPhoneDailyCacheKey, readPhoneDailyCache, writePhoneDailyCache } from '@/services/phoneDailyCache'
import { reportsService, type ContactListItem, type ReportMetricRow, type ReportsSummary } from '@/services/reportsService'
import { transactionsService, type Transaction, type TransactionSummary } from '@/services/transactionsService'
import { formatCurrency, formatDate, formatDateToISO, formatNumber, formatRoas } from '@/utils/format'
import styles from './PhoneApp.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_PHONE_SELECTOR = '[data-phone-scrollable="true"]'
const SCROLLABLE_PHONE_NAV_SELECTOR = '[data-phone-nav-scrollable="true"]'

const PHONE_SECTION_IDS = [
  'chat',
  'dashboard',
  'appointments',
  'transactions',
  'contacts',
  'campaigns',
  'reports',
  'analytics',
  'settings'
] as const

type PhoneSectionId = typeof PHONE_SECTION_IDS[number]
type AccessState = 'checking' | 'allowed' | 'blocked'
type TrendPoint = { label: string; value: number; value2?: number }

type PeriodOption = {
  id: 'today' | 'last7days' | 'thisMonth' | 'last30days' | 'last90days'
  label: string
}

interface PhoneSectionConfig {
  id: PhoneSectionId
  label: string
  Icon: LucideIcon
}

interface PhoneAppData {
  dashboardMetrics: DashboardMetrics
  financialChart: ChartData[]
  funnelData: Array<{ stage: string; value: number }>
  trafficSources: Array<{ name: string; value: number; color?: string }>
  visitorsData: Array<{ label: string; value: number }>
  leadsData: Array<{ label: string; value: number }>
  appointmentsData: Array<{ label: string; value: number }>
  salesData: Array<{ label: string; value: number }>
  transactionSummary: TransactionSummary
  transactions: Transaction[]
  contactStats: ContactStats
  contacts: ContactListItem[]
  campaigns: Campaign[]
  reportMetrics: ReportMetricRow[]
  reportsSummary: ReportsSummary | null
  calendars: Calendar[]
  appointmentEvents: CalendarEvent[]
  appointmentStats: AppointmentStats
}

const PHONE_SECTIONS: PhoneSectionConfig[] = [
  { id: 'chat', label: 'Chat', Icon: MessageCircle },
  { id: 'dashboard', label: 'Dashboard', Icon: Gauge },
  { id: 'appointments', label: 'Citas', Icon: CalendarDays },
  { id: 'transactions', label: 'Pagos', Icon: CreditCard },
  { id: 'contacts', label: 'Contactos', Icon: Users },
  { id: 'campaigns', label: 'Publicidad', Icon: Megaphone },
  { id: 'reports', label: 'Reportes', Icon: BarChart3 },
  { id: 'analytics', label: 'Analíticas', Icon: TrendingUp },
  { id: 'settings', label: 'Configuración', Icon: Cog }
]

const PERIOD_OPTIONS: PeriodOption[] = [
  { id: 'today', label: 'Today' },
  { id: 'last7days', label: '7d' },
  { id: 'thisMonth', label: 'Month' },
  { id: 'last30days', label: '30d' },
  { id: 'last90days', label: '90d' }
]

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  cancelled: 'Cancelled',
  showed: 'Showed',
  noshow: 'No-show',
  rescheduled: 'Rescheduled',
  paid: 'Paid',
  sent: 'Sent',
  overdue: 'Overdue',
  refunded: 'Refund',
  failed: 'Failed',
  draft: 'Draft'
}

const SECTION_BY_ID = PHONE_SECTIONS.reduce((acc, section) => {
  acc[section.id] = section
  return acc
}, {} as Record<PhoneSectionId, PhoneSectionConfig>)

function createEmptyDashboardMetrics(): DashboardMetrics {
  return {
    ingresosNetos: { value: 0, variation: 0 },
    gastosPublicidad: { value: 0, variation: 0 },
    gananciaBruta: { value: 0, variation: 0 },
    roas: { value: 0, variation: 0 },
    totalCostos: { value: 0, variation: 0 },
    gananciaNeta: { value: 0, variation: 0 },
    reembolsos: { value: 0, variation: 0 },
    ltvPromedio: { value: 0, variation: 0 }
  }
}

function createEmptyTransactionSummary(): TransactionSummary {
  return {
    totalRevenue: 0,
    totalRevenuePrev: 0,
    completedPayments: 0,
    completedPaymentsPrev: 0,
    averageTicket: 0,
    averageTicketPrev: 0,
    refunds: 0,
    refundsPrev: 0
  }
}

function createEmptyContactStats(): ContactStats {
  return {
    total: 0,
    totalPrev: 0,
    withAppointments: 0,
    withAppointmentsPrev: 0,
    customers: 0,
    customersPrev: 0,
    ltvTotal: 0,
    ltvTotalPrev: 0,
    avgLtv: 0,
    avgLtvPrev: 0
  }
}

function createEmptyAppointmentStats(): AppointmentStats {
  return {
    pending: 0,
    cancelled: 0,
    confirmed: 0,
    rescheduled: 0,
    showed: 0,
    noshow: 0
  }
}

function createEmptyPhoneData(): PhoneAppData {
  return {
    dashboardMetrics: createEmptyDashboardMetrics(),
    financialChart: [],
    funnelData: [],
    trafficSources: [],
    visitorsData: [],
    leadsData: [],
    appointmentsData: [],
    salesData: [],
    transactionSummary: createEmptyTransactionSummary(),
    transactions: [],
    contactStats: createEmptyContactStats(),
    contacts: [],
    campaigns: [],
    reportMetrics: [],
    reportsSummary: null,
    calendars: [],
    appointmentEvents: [],
    appointmentStats: createEmptyAppointmentStats()
  }
}

function compactPhoneDataForCache(data: PhoneAppData): PhoneAppData {
  return {
    ...data,
    transactions: data.transactions.slice(0, 80),
    contacts: data.contacts.slice(0, 80),
    campaigns: data.campaigns.slice(0, 80),
    reportMetrics: data.reportMetrics.slice(-120),
    appointmentEvents: data.appointmentEvents.slice(0, 160)
  }
}

function hasPortableAccess() {
  if (typeof window === 'undefined') return false

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const phoneViewport = window.matchMedia(PHONE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return phoneViewport || (portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer))
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

function isPhoneSectionId(value?: string): value is PhoneSectionId {
  return PHONE_SECTION_IDS.includes(value as PhoneSectionId)
}

async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch {
    return fallback
  }
}

function getInclusiveEnd(date: Date) {
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)
  return end
}

function getDaysBetween(start: Date, end: Date) {
  const diff = getInclusiveEnd(end).getTime() - start.getTime()
  return Math.max(1, Math.ceil(diff / 86_400_000))
}

function normalizeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function calculateDelta(current: number, previous: number) {
  if (!previous) return current > 0 ? 100 : 0
  return ((current - previous) / previous) * 100
}

function formatCompactCurrency(value: number) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(normalizeNumber(value))
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('es-MX', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(normalizeNumber(value))
}

function formatPercent(value: number) {
  return `${normalizeNumber(value).toFixed(1)}%`
}

function formatSignedPercent(value: number) {
  const normalized = normalizeNumber(value)
  const sign = normalized > 0 ? '+' : ''
  return `${sign}${normalized.toFixed(1)}%`
}

function getStatusLabel(status?: string | null) {
  if (!status) return 'Sin estado'
  return STATUS_LABELS[status.toLowerCase()] || status
}

function getContactLabel(contact: ContactListItem) {
  return contact.name || contact.email || contact.phone || 'Contacto sin nombre'
}

function normalizeCalendarEvent(event: any, fallbackId: string): CalendarEvent {
  return {
    ...event,
    id: String(event?.id || fallbackId),
    title: event?.title || event?.name || event?.contactName || '(Sin título)',
    calendarId: event?.calendarId || event?.calendar_id || '',
    locationId: event?.locationId || event?.location_id || '',
    contactId: event?.contactId || event?.contact_id,
    appointmentStatus: (event?.appointmentStatus || event?.appointment_status || event?.status || 'confirmed') as CalendarEvent['appointmentStatus'],
    startTime: event?.startTime || event?.start_time || event?.start || '',
    endTime: event?.endTime || event?.end_time || event?.end || event?.startTime || event?.start_time || '',
    dateAdded: event?.dateAdded || event?.date_added || '',
    dateUpdated: event?.dateUpdated || event?.date_updated
  }
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'

  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatPeriodLabel(start: Date, end: Date) {
  if (formatDateToISO(start) === formatDateToISO(end)) {
    return formatDate(start, { includeYear: true })
  }

  return `${formatDate(start, { includeYear: true })} - ${formatDate(end, { includeYear: true })}`
}

function toTrendFromSingle(data: Array<{ label?: string; date?: string; value: number }>, limit = 8): TrendPoint[] {
  return data.slice(-limit).map((item) => ({
    label: formatDate(item.label || item.date || ''),
    value: normalizeNumber(item.value)
  }))
}

function toTrendFromFinancial(data: ChartData[], limit = 8): TrendPoint[] {
  return data.slice(-limit).map((item) => ({
    label: formatDate(item.date),
    value: normalizeNumber(item.ingresos),
    value2: normalizeNumber(item.gastado)
  }))
}

function toTrendFromReports(data: ReportMetricRow[], key: keyof ReportMetricRow, limit = 8): TrendPoint[] {
  return data.slice(-limit).map((item) => ({
    label: formatDate(item.date),
    value: normalizeNumber(item[key])
  }))
}

export const PhoneApp: React.FC = () => {
  const params = useParams<{ section?: string }>()
  const { locationId, accessToken } = useAuth()
  const { dateRange, setPreset } = useDateRange()
  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  usePhoneElasticScroll({ enabled: accessState === 'allowed' })

  const [phoneData, setPhoneData] = useState<PhoneAppData>(() => createEmptyPhoneData())
  const [loading, setLoading] = useState(true)
  const [cacheRefreshing, setCacheRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)

  const sectionParam = params.section as string | undefined
  const activeSectionId = isPhoneSectionId(sectionParam) ? sectionParam : null
  const activeSection = activeSectionId ? SECTION_BY_ID[activeSectionId] : SECTION_BY_ID.dashboard
  const startDate = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const endDate = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const startIso = formatDateToISO(startDate)
  const endIso = formatDateToISO(endDate)

  useEffect(() => {
    document.title = `${activeSection.label} mobile | Ristak`
  }, [activeSection.label])

  useEffect(() => {
    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const phoneMedia = window.matchMedia(PHONE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    phoneMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      phoneMedia.removeEventListener('change', updateAccess)
      pointerMedia.removeEventListener('change', updateAccess)
      window.removeEventListener('resize', updateAccess)
      window.removeEventListener('orientationchange', updateAccess)
      window.visualViewport?.removeEventListener('resize', updateAccess)
    }
  }, [])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const html = document.documentElement
    const body = document.body
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const previousViewportContent = viewportMeta?.getAttribute('content') || ''
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousHtmlBackground = html.style.background
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousBodyBackground = body.style.background
    const phoneFrameBackground = 'color-mix(in srgb, var(--color-background-primary) 92%, #ffffff 8%)'
    let startX = 0
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.background = phoneFrameBackground
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.background = phoneFrameBackground

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const getScrollableNav = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_NAV_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const handleTouchStart = (event: TouchEvent) => {
      startX = event.touches[0]?.clientX || 0
      startY = event.touches[0]?.clientY || 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      const currentX = event.touches[0]?.clientX || startX
      const currentY = event.touches[0]?.clientY || startY
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const horizontalIntent = Math.abs(deltaX) > Math.abs(deltaY)
      const nav = getScrollableNav(event.target)

      if (nav) {
        const canScrollX = nav.scrollWidth > nav.clientWidth + 1
        const atLeft = nav.scrollLeft <= 0
        const atRight = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1

        if (horizontalIntent && canScrollX && !((atLeft && deltaX > 0) || (atRight && deltaX < 0))) {
          return
        }

        event.preventDefault()
        return
      }

      const scrollable = getScrollableElement(event.target)

      if (!scrollable) {
        event.preventDefault()
        return
      }

      const canScroll = scrollable.scrollHeight > scrollable.clientHeight + 1
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

      if (!canScroll || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        event.preventDefault()
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)

      if (viewportMeta) {
        viewportMeta.setAttribute('content', previousViewportContent)
      }

      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      html.style.background = previousHtmlBackground
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
      body.style.background = previousBodyBackground
    }
  }, [accessState])

  useEffect(() => {
    if (accessState !== 'allowed' || !activeSectionId) return
    if (activeSectionId === 'settings') {
      setLoading(false)
      setCacheRefreshing(false)
      setLoadError(null)
      return
    }

    let cancelled = false

    const loadPhoneData = async () => {
      setLoadError(null)
      const cacheKey = getPhoneDailyCacheKey('phone-app', 'data', locationId || 'default', startIso, endIso)
      const cachedPhoneData = readPhoneDailyCache<PhoneAppData>(cacheKey)
      const showedCachedData = Boolean(cachedPhoneData)

      if (cachedPhoneData) {
        setPhoneData({
          ...createEmptyPhoneData(),
          ...cachedPhoneData.data
        })
        setLoading(false)
        setCacheRefreshing(true)
      } else {
        setLoading(true)
        setCacheRefreshing(false)
      }

      const groupBy = getDaysBetween(startDate, endDate) > 95 ? 'month' : 'day'
      const inclusiveEnd = getInclusiveEnd(endDate)

      try {
        const [
          dashboardMetrics,
          financialChart,
          funnelData,
          trafficSources,
          visitorsData,
          leadsData,
          appointmentsData,
          salesData,
          transactionSummary,
          transactions,
          contactStats,
          contactsResponse,
          campaigns,
          reportsMetricsResponse,
          reportsSummary
        ] = await Promise.all([
          safe(dashboardService.getDashboardMetrics({ start: startDate, end: endDate }), createEmptyDashboardMetrics()),
          safe(dashboardService.getFinancialChart({ start: startDate, end: endDate, scope: 'all' }), [] as ChartData[]),
          safe(dashboardService.getFunnelData({ start: startDate, end: endDate, scope: 'all' }), [] as Array<{ stage: string; value: number }>),
          safe(dashboardService.getTrafficSources({ start: startDate, end: endDate }), [] as Array<{ name: string; value: number; color?: string }>),
          safe(dashboardService.getVisitorsData({ start: startDate, end: endDate, groupBy }), [] as Array<{ label: string; value: number }>),
          safe(dashboardService.getLeadsData({ start: startDate, end: endDate, groupBy }), [] as Array<{ label: string; value: number }>),
          safe(dashboardService.getAppointmentsData({ start: startDate, end: endDate, groupBy }), [] as Array<{ label: string; value: number }>),
          safe(dashboardService.getSalesData({ start: startDate, end: endDate, groupBy }), [] as Array<{ label: string; value: number }>),
          safe(transactionsService.getSummary(startIso, endIso), createEmptyTransactionSummary()),
          safe(transactionsService.getTransactions(startIso, endIso), [] as Transaction[]),
          safe(contactsService.getStats(startIso, endIso), createEmptyContactStats()),
          safe(
            reportsService.getContactsList({ from: startIso, to: endIso, scope: 'all' }),
            { contacts: [], range: { start: startIso, end: endIso, timezone: '', filtered: true } }
          ),
          safe(campaignsService.getCampaigns(startIso, endIso), [] as Campaign[]),
          safe(reportsService.getMetrics({ from: startIso, to: endIso, groupBy, scope: 'all' }), {
            metrics: [],
            range: { start: startIso, end: endIso, timezone: '', filtered: true }
          }),
          safe(reportsService.getSummary({ from: startIso, to: endIso, scope: 'all' }), null)
        ])

        let calendars: Calendar[] = []
        let appointmentEvents: CalendarEvent[] = []

        if (locationId && accessToken) {
          calendars = await safe(calendarsService.getCalendars(locationId, accessToken), [] as Calendar[])
          const rawEvents = await safe(
            calendarsService.getEvents(locationId, startDate.getTime(), inclusiveEnd.getTime(), accessToken),
            [] as CalendarEvent[]
          )
          appointmentEvents = rawEvents.map((event, index) => normalizeCalendarEvent(event, `event-${index}`))
        }

        if (cancelled) return

        const nextPhoneData = {
          dashboardMetrics,
          financialChart,
          funnelData,
          trafficSources,
          visitorsData,
          leadsData,
          appointmentsData,
          salesData,
          transactionSummary,
          transactions,
          contactStats,
          contacts: contactsResponse.contacts || [],
          campaigns,
          reportMetrics: reportsMetricsResponse.metrics || [],
          reportsSummary,
          calendars,
          appointmentEvents,
          appointmentStats: calendarsService.calculateStats(appointmentEvents)
        }

        setPhoneData(nextPhoneData)
        writePhoneDailyCache(cacheKey, compactPhoneDataForCache(nextPhoneData), { maxEntryChars: 520_000 })
      } catch {
        if (!cancelled) {
          if (!showedCachedData) {
            setLoadError('No se pudieron cargar los datos móviles.')
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setCacheRefreshing(false)
        }
      }
    }

    loadPhoneData()

    return () => {
      cancelled = true
    }
  }, [accessState, accessToken, activeSectionId, endDate, endIso, locationId, refreshKey, startDate, startIso])

  const dashboardTiles = useMemo(() => {
    const metrics = phoneData.dashboardMetrics
    return [
      {
        label: 'Revenue',
        value: formatCompactCurrency(metrics.ingresosNetos.value),
        detail: formatCurrency(metrics.ingresosNetos.value),
        delta: metrics.ingresosNetos.variation,
        tone: 'green' as const
      },
      {
        label: 'Ad spend',
        value: formatCompactCurrency(metrics.gastosPublicidad.value),
        detail: formatCurrency(metrics.gastosPublicidad.value),
        delta: metrics.gastosPublicidad.variation,
        tone: 'orange' as const
      },
      {
        label: 'Net profit',
        value: formatCompactCurrency(metrics.gananciaNeta.value),
        detail: formatCurrency(metrics.gananciaNeta.value),
        delta: metrics.gananciaNeta.variation,
        tone: 'blue' as const
      },
      {
        label: 'ROAS',
        value: formatRoas(metrics.roas.value),
        detail: 'Retorno de publicidad',
        delta: metrics.roas.variation,
        tone: 'purple' as const
      }
    ]
  }, [phoneData.dashboardMetrics])

  const financeTrend = useMemo(() => toTrendFromFinancial(phoneData.financialChart), [phoneData.financialChart])
  const visitorsTrend = useMemo(() => toTrendFromSingle(phoneData.visitorsData), [phoneData.visitorsData])
  const leadsTrend = useMemo(() => toTrendFromSingle(phoneData.leadsData), [phoneData.leadsData])
  const appointmentsTrend = useMemo(() => toTrendFromSingle(phoneData.appointmentsData), [phoneData.appointmentsData])
  const salesTrend = useMemo(() => toTrendFromSingle(phoneData.salesData), [phoneData.salesData])
  const profitTrend = useMemo(() => toTrendFromReports(phoneData.reportMetrics, 'profit'), [phoneData.reportMetrics])

  const campaignTotals = useMemo(() => {
    return phoneData.campaigns.reduce(
      (acc, campaign) => {
        acc.spend += normalizeNumber(campaign.spend)
        acc.revenue += normalizeNumber(campaign.revenue)
        acc.clicks += normalizeNumber(campaign.clicks)
        acc.leads += normalizeNumber(campaign.leads)
        acc.sales += normalizeNumber(campaign.sales)
        return acc
      },
      { spend: 0, revenue: 0, clicks: 0, leads: 0, sales: 0 }
    )
  }, [phoneData.campaigns])

  const topCampaigns = useMemo(() => {
    return phoneData.campaigns
      .slice()
      .sort((a, b) => normalizeNumber(b.revenue) - normalizeNumber(a.revenue))
      .slice(0, 5)
  }, [phoneData.campaigns])

  const upcomingAppointments = useMemo(() => {
    const now = new Date()
    return phoneData.appointmentEvents
      .filter((event) => new Date(event.startTime) >= now)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 5)
  }, [phoneData.appointmentEvents])

  const recentTransactions = useMemo(() => {
    return phoneData.transactions
      .slice()
      .sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''))
      .slice(0, 5)
  }, [phoneData.transactions])

  const recentContacts = useMemo(() => phoneData.contacts.slice(0, 5), [phoneData.contacts])

  const reportTotals = useMemo(() => {
    return phoneData.reportMetrics.reduce(
      (acc, row) => {
        acc.revenue += normalizeNumber(row.revenue)
        acc.spend += normalizeNumber(row.spend)
        acc.profit += normalizeNumber(row.profit)
        acc.visitors += normalizeNumber(row.visitors)
        acc.leads += normalizeNumber(row.leads)
        acc.customers += normalizeNumber(row.customers)
        return acc
      },
      { revenue: 0, spend: 0, profit: 0, visitors: 0, leads: 0, customers: 0 }
    )
  }, [phoneData.reportMetrics])

  const analyticsConversion = useMemo(() => {
    const visitors = visitorsTrend.reduce((total, item) => total + item.value, 0)
    const leads = leadsTrend.reduce((total, item) => total + item.value, 0)
    const appointments = appointmentsTrend.reduce((total, item) => total + item.value, 0)
    const sales = salesTrend.reduce((total, item) => total + item.value, 0)

    return [
      { label: 'Visitors', value: visitors, percent: 100 },
      { label: 'Leads', value: leads, percent: visitors ? (leads / visitors) * 100 : 0 },
      { label: 'Appointments', value: appointments, percent: leads ? (appointments / leads) * 100 : 0 },
      { label: 'Sales', value: sales, percent: leads ? (sales / leads) * 100 : 0 }
    ]
  }, [appointmentsTrend, leadsTrend, salesTrend, visitorsTrend])

  if (!activeSectionId) {
    return <Navigate to="/phone/dashboard" replace />
  }

  if (accessState === 'checking') {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.loadingDot} />
      </main>
    )
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-app-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Phone route</p>
            <h1 id="phone-app-blocked-title">Mobile or tablet only</h1>
            <p>
              This view is optimized to analyze Ristak from a phone or tablet. Open it from a portable device to see the full mobile dashboard.
            </p>
          </div>
          <Link className={styles.dashboardLink} to="/dashboard">
            Back to dashboard
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className={styles.phonePage} aria-label="Ristak mobile app">
      <div className={styles.phoneFrame}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <span className={styles.brandMark}>R</span>
            <div>
              <p className={styles.eyebrow}>Ristak Phone</p>
              <h1>{activeSection.label}</h1>
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setRefreshKey((value) => value + 1)}
              aria-label="Refresh metrics"
              title="Refresh metrics"
            >
              <RefreshCw size={18} className={loading || cacheRefreshing ? styles.spinIcon : undefined} />
            </button>
            <Link className={styles.iconButton} to="/phone/agent-ai" aria-label="Open AI agent" title="Open AI agent">
              <Bot size={18} />
            </Link>
          </div>
        </header>

        {activeSectionId !== 'settings' && (
          <section className={styles.periodPanel} aria-label="Date range">
            <div className={styles.periodCopy}>
              <span>Period</span>
              <strong>{formatPeriodLabel(startDate, endDate)}</strong>
            </div>
            <div className={styles.periodControls}>
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.periodButton} ${dateRange.preset === option.id ? styles.periodButtonActive : ''}`}
                  onClick={() => setPreset(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <nav className={styles.sectionTabs} aria-label="Mobile sections" data-phone-nav-scrollable="true">
          {PHONE_SECTIONS.map((section) => {
            const Icon = section.Icon
            const isActive = section.id === activeSectionId
            return (
              <Link
                key={section.id}
                to={`/phone/${section.id}`}
                className={`${styles.sectionTab} ${isActive ? styles.sectionTabActive : ''}`}
              >
                <Icon size={16} />
                <span>{section.label}</span>
              </Link>
            )
          })}
        </nav>

        <section className={styles.content} data-phone-scrollable="true">
          {cacheRefreshing && (
            <div className={styles.cacheBanner} role="status">
              Mostrando lo guardado, actualizando datos
            </div>
          )}

          {loadError && (
            <div className={styles.errorBanner} role="status">
              {loadError}
            </div>
          )}

          {loading ? (
            <PhoneSkeleton />
          ) : (
            <>
              {activeSectionId === 'dashboard' && (
                <DashboardSection
                  tiles={dashboardTiles}
                  financeTrend={financeTrend}
                  funnelData={phoneData.funnelData}
                  trafficSources={phoneData.trafficSources}
                />
              )}

              {activeSectionId === 'appointments' && (
                <AppointmentsSection
                  stats={phoneData.appointmentStats}
                  events={upcomingAppointments}
                  calendars={phoneData.calendars}
                  trend={appointmentsTrend}
                />
              )}

              {activeSectionId === 'transactions' && (
                <TransactionsSection
                  summary={phoneData.transactionSummary}
                  transactions={recentTransactions}
                />
              )}

              {activeSectionId === 'contacts' && (
                <ContactsSection
                  stats={phoneData.contactStats}
                  contacts={recentContacts}
                  leadsTrend={leadsTrend}
                />
              )}

              {activeSectionId === 'campaigns' && (
                <CampaignsSection
                  totals={campaignTotals}
                  campaigns={topCampaigns}
                />
              )}

              {activeSectionId === 'reports' && (
                <ReportsSection
                  totals={reportTotals}
                  reportsSummary={phoneData.reportsSummary}
                  profitTrend={profitTrend}
                  rows={phoneData.reportMetrics.slice(-6).reverse()}
                />
              )}

              {activeSectionId === 'analytics' && (
                <AnalyticsSection
                  visitorsTrend={visitorsTrend}
                  leadsTrend={leadsTrend}
                  salesTrend={salesTrend}
                  conversion={analyticsConversion}
                />
              )}

              {activeSectionId === 'settings' && (
                <SettingsSection />
              )}
            </>
          )}
        </section>
      </div>
    </main>
  )
}

interface DashboardSectionProps {
  tiles: Array<{
    label: string
    value: string
    detail: string
    delta: number
    tone: 'green' | 'orange' | 'blue' | 'purple'
  }>
  financeTrend: TrendPoint[]
  funnelData: Array<{ stage: string; value: number }>
  trafficSources: Array<{ name: string; value: number; color?: string }>
}

function DashboardSection({ tiles, financeTrend, funnelData, trafficSources }: DashboardSectionProps) {
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        {tiles.map((tile) => (
          <MetricTile key={tile.label} {...tile} />
        ))}
      </div>

      <Panel title="Revenue vs ads" actionLabel="Finance">
        <DualTrend data={financeTrend} labelA="Revenue" labelB="Ads" formatValue={formatCompactCurrency} />
      </Panel>

      <Panel title="Funnel" actionLabel="Conversion">
        <ProgressList
          items={funnelData.map((item) => ({ label: item.stage, value: item.value }))}
          formatValue={formatNumber}
        />
      </Panel>

      <Panel title="Traffic sources" actionLabel="Channels">
        <ProgressList
          items={trafficSources.map((source) => ({ label: source.name, value: source.value, color: source.color }))}
          formatValue={formatNumber}
        />
      </Panel>
    </div>
  )
}

interface AppointmentsSectionProps {
  stats: AppointmentStats
  events: CalendarEvent[]
  calendars: Calendar[]
  trend: TrendPoint[]
}

function AppointmentsSection({ stats, events, calendars, trend }: AppointmentsSectionProps) {
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <MetricTile label="Upcoming" value={formatNumber(stats.pending)} detail="Future confirmed" tone="blue" />
        <MetricTile label="Showed" value={formatNumber(stats.showed)} detail="Completed appointments" tone="green" />
        <MetricTile label="No-show" value={formatNumber(stats.noshow)} detail="Follow-up" tone="orange" />
        <MetricTile label="Calendars" value={formatNumber(calendars.length)} detail="Active in HighLevel" tone="purple" />
      </div>

      <Panel title="Appointments by period" actionLabel="Activity">
        <MiniBars data={trend} formatValue={formatNumber} />
      </Panel>

      <Panel title="Immediate agenda" actionLabel={`${events.length} appointments`}>
        <ListStack emptyLabel="No upcoming appointments in this range.">
          {events.map((event) => (
            <ListItem
              key={event.id}
              title={event.title}
              meta={`${formatDateTime(event.startTime)} · ${getStatusLabel(event.appointmentStatus)}`}
              value={event.appointmentStatus === 'showed' ? 'OK' : ''}
            />
          ))}
        </ListStack>
      </Panel>
    </div>
  )
}

interface TransactionsSectionProps {
  summary: TransactionSummary
  transactions: Transaction[]
}

function TransactionsSection({ summary, transactions }: TransactionsSectionProps) {
  const { connected: highLevelConnected } = useHighLevelConnected()
  const revenueDelta = calculateDelta(summary.totalRevenue, summary.totalRevenuePrev)
  const paidDelta = calculateDelta(summary.completedPayments, summary.completedPaymentsPrev)

  return (
    <div className={styles.sectionStack}>
      <div className={styles.paymentActionGrid}>
        <Link
          to="/phone/payments?mode=single"
          className={`${styles.paymentActionButton} ${styles.paymentActionPrimary}`}
        >
          <CreditCard size={18} />
          <span>
            <strong>Registrar pago</strong>
            <small>Envía un enlace de pago o guarda un pago manual</small>
          </span>
        </Link>
        <Link
          to="/phone/payments?mode=products"
          className={styles.paymentActionButton}
        >
          <Package size={18} />
          <span>
            <strong>Productos</strong>
            <small>Crear, editar o eliminar productos para cobrar</small>
          </span>
        </Link>
        {highLevelConnected && (
          <Link
            to="/phone/payments?mode=partial"
            className={styles.paymentActionButton}
          >
            <CalendarDays size={18} />
            <span>
              <strong>Plan de pagos</strong>
              <small>Abre parcialidades automáticas</small>
            </span>
          </Link>
        )}
      </div>

      <div className={styles.metricGrid}>
        <MetricTile label="Collected" value={formatCompactCurrency(summary.totalRevenue)} detail={formatCurrency(summary.totalRevenue)} delta={revenueDelta} tone="green" />
        <MetricTile label="Payments" value={formatNumber(summary.completedPayments)} detail="Completed" delta={paidDelta} tone="blue" />
        <MetricTile label="Ticket" value={formatCompactCurrency(summary.averageTicket)} detail="Average" tone="purple" />
        <MetricTile label="Refunds" value={formatCompactCurrency(summary.refunds)} detail="For this period" tone="orange" />
      </div>

      <Panel title="Recent payments" actionLabel={`${transactions.length} visible`}>
        <ListStack emptyLabel="No recent payments for this period.">
          {transactions.map((transaction) => (
            <ListItem
              key={transaction.id}
              title={transaction.contactName || transaction.email || 'Customer'}
              meta={`${formatDateTime(transaction.date || transaction.createdAt)} · ${getStatusLabel(transaction.status)}`}
              value={formatCompactCurrency(transaction.amount)}
            />
          ))}
        </ListStack>
      </Panel>
    </div>
  )
}

interface ContactsSectionProps {
  stats: ContactStats
  contacts: ContactListItem[]
  leadsTrend: TrendPoint[]
}

function ContactsSection({ stats, contacts, leadsTrend }: ContactsSectionProps) {
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <MetricTile label="Contacts" value={formatNumber(stats.total)} detail="Registered" delta={calculateDelta(stats.total, stats.totalPrev)} tone="blue" />
        <MetricTile label="With appointment" value={formatNumber(stats.withAppointments)} detail="Scheduled" delta={calculateDelta(stats.withAppointments, stats.withAppointmentsPrev)} tone="purple" />
        <MetricTile label="Customers" value={formatNumber(stats.customers)} detail="Buyers" delta={calculateDelta(stats.customers, stats.customersPrev)} tone="green" />
        <MetricTile label="Avg. LTV" value={formatCompactCurrency(stats.avgLtv)} detail="Average value" tone="orange" />
      </div>

      <Panel title="New leads" actionLabel="Trend">
        <MiniBars data={leadsTrend} formatValue={formatNumber} />
      </Panel>

      <Panel title="Recent contacts" actionLabel={`${contacts.length} visible`}>
        <ListStack emptyLabel="No contacts in this period.">
          {contacts.map((contact) => (
            <ListItem
              key={contact.id}
              title={getContactLabel(contact)}
              meta={`${contact.email || contact.phone || 'No contact info'} · ${formatDate(contact.created_at, { includeYear: true })}`}
              value={formatCompactCurrency(contact.ltv || contact.lifetimeLtv || 0)}
            />
          ))}
        </ListStack>
      </Panel>
    </div>
  )
}

interface CampaignsSectionProps {
  totals: {
    spend: number
    revenue: number
    clicks: number
    leads: number
    sales: number
  }
  campaigns: Campaign[]
}

function CampaignsSection({ totals, campaigns }: CampaignsSectionProps) {
  const roas = totals.spend > 0 ? totals.revenue / totals.spend : 0

  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <MetricTile label="Spend" value={formatCompactCurrency(totals.spend)} detail={formatCurrency(totals.spend)} tone="orange" />
        <MetricTile label="Revenue" value={formatCompactCurrency(totals.revenue)} detail={formatCurrency(totals.revenue)} tone="green" />
        <MetricTile label="ROAS" value={formatRoas(roas)} detail="Ads" tone="purple" />
        <MetricTile label="Leads" value={formatNumber(totals.leads)} detail={`${formatNumber(totals.clicks)} clicks`} tone="blue" />
      </div>

      <Panel title="Top campaigns" actionLabel={`${campaigns.length} campaigns`}>
        <ListStack emptyLabel="No campaigns with data in this period.">
          {campaigns.map((campaign) => (
            <ListItem
              key={campaign.id}
              title={campaign.name}
              meta={`${formatCompactCurrency(campaign.spend)} spent · ${formatNumber(campaign.leads || 0)} leads`}
              value={formatRoas(campaign.roas || (campaign.spend ? (campaign.revenue || 0) / campaign.spend : 0))}
            />
          ))}
        </ListStack>
      </Panel>
    </div>
  )
}

interface ReportsSectionProps {
  totals: {
    revenue: number
    spend: number
    profit: number
    visitors: number
    leads: number
    customers: number
  }
  reportsSummary: ReportsSummary | null
  profitTrend: TrendPoint[]
  rows: ReportMetricRow[]
}

function ReportsSection({ totals, reportsSummary, profitTrend, rows }: ReportsSectionProps) {
  const summaryRoas = reportsSummary?.campaigns?.roas || (totals.spend > 0 ? totals.revenue / totals.spend : 0)

  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <MetricTile label="Revenue" value={formatCompactCurrency(totals.revenue)} detail={formatCurrency(totals.revenue)} tone="green" />
        <MetricTile label="Spend" value={formatCompactCurrency(totals.spend)} detail={formatCurrency(totals.spend)} tone="orange" />
        <MetricTile label="Profit" value={formatCompactCurrency(totals.profit)} detail={formatCurrency(totals.profit)} tone="blue" />
        <MetricTile label="ROAS" value={formatRoas(summaryRoas)} detail="Report" tone="purple" />
      </div>

      <Panel title="Profit by period" actionLabel="Report">
        <MiniBars data={profitTrend} formatValue={formatCompactCurrency} />
      </Panel>

      <Panel title="Quick cut" actionLabel={`${rows.length} rows`}>
        <ListStack emptyLabel="No report rows in this period.">
          {rows.map((row) => (
            <ListItem
              key={row.date}
              title={formatDate(row.date, { includeYear: true })}
              meta={`${formatNumber(row.visitors)} visits · ${formatNumber(row.leads)} leads · ${formatNumber(row.customers)} customers`}
              value={formatCompactCurrency(row.profit)}
            />
          ))}
        </ListStack>
      </Panel>
    </div>
  )
}

interface AnalyticsSectionProps {
  visitorsTrend: TrendPoint[]
  leadsTrend: TrendPoint[]
  salesTrend: TrendPoint[]
  conversion: Array<{ label: string; value: number; percent: number }>
}

function AnalyticsSection({ visitorsTrend, leadsTrend, salesTrend, conversion }: AnalyticsSectionProps) {
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        {conversion.map((item) => (
          <MetricTile
            key={item.label}
            label={item.label}
            value={formatCompactNumber(item.value)}
            detail={item.label === 'Visitantes' ? 'Base del embudo' : `${formatPercent(item.percent)} conversión`}
            tone={item.label === 'Ventas' ? 'green' : item.label === 'Citas' ? 'purple' : item.label === 'Leads' ? 'blue' : 'orange'}
            icon={getAnalyticsMetricIcon(item.label)}
          />
        ))}
      </div>

      <Panel title="Visitors" actionLabel="Traffic">
        <MiniBars data={visitorsTrend} formatValue={formatNumber} />
      </Panel>

      <Panel title="Leads vs sales" actionLabel="Conversion">
        <DualTrend data={mergeTrendSeries(leadsTrend, salesTrend)} labelA="Leads" labelB="Sales" formatValue={formatCompactNumber} />
      </Panel>
    </div>
  )
}

type SettingsPanelId = 'account' | 'agent'

function SettingsSection() {
  const [activePanel, setActivePanel] = useState<SettingsPanelId>('account')

  return (
    <div className={styles.settingsShell}>
      <div className={styles.settingsSwitcher} role="tablist" aria-label="Mobile settings">
        <button
          type="button"
          role="tab"
          aria-selected={activePanel === 'account'}
          className={`${styles.settingsSwitchButton} ${activePanel === 'account' ? styles.settingsSwitchButtonActive : ''}`}
          onClick={() => setActivePanel('account')}
        >
          <Users size={16} />
          Account
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePanel === 'agent'}
          className={`${styles.settingsSwitchButton} ${activePanel === 'agent' ? styles.settingsSwitchButtonActive : ''}`}
          onClick={() => setActivePanel('agent')}
        >
          <Bot size={16} />
          AI Agent
        </button>
      </div>

      <div className={styles.embeddedSettings}>
        {activePanel === 'account' ? <AccountSettings /> : <AIAgentSettings />}
      </div>
    </div>
  )
}

function mergeTrendSeries(primary: TrendPoint[], secondary: TrendPoint[]): TrendPoint[] {
  const maxLength = Math.max(primary.length, secondary.length)
  const result: TrendPoint[] = []

  for (let index = 0; index < maxLength; index += 1) {
    const first = primary[index]
    const second = secondary[index]
    result.push({
      label: first?.label || second?.label || '',
      value: first?.value || 0,
      value2: second?.value || 0
    })
  }

  return result
}

function getAnalyticsMetricIcon(label: string): LucideIcon {
  if (label === 'Visitantes') return Eye
  if (label === 'Leads') return Users
  if (label === 'Citas') return CalendarDays
  return TrendingUp
}

interface MetricTileProps {
  label: string
  value: string
  detail: string
  delta?: number
  tone: 'green' | 'orange' | 'blue' | 'purple'
  icon?: LucideIcon
}

function MetricTile({ label, value, detail, delta, tone, icon }: MetricTileProps) {
  const deltaTone = typeof delta === 'number' && delta < 0 ? styles.deltaDown : styles.deltaUp
  const MetricIcon = icon

  return (
    <article className={`${styles.metricTile} ${styles[`tone${tone}`]}`}>
      <div className={styles.metricHeader}>
        <span className={styles.metricLabel}>{label}</span>
        {MetricIcon && (
          <span className={styles.metricIcon} aria-hidden="true">
            <MetricIcon size={14} strokeWidth={2.2} />
          </span>
        )}
      </div>
      <strong>{value}</strong>
      <span className={styles.metricDetail}>{detail}</span>
      {typeof delta === 'number' && (
        <span className={`${styles.deltaBadge} ${deltaTone}`}>
          {formatSignedPercent(delta)}
        </span>
      )}
    </article>
  )
}

interface PanelProps {
  title: string
  actionLabel?: string
  children: ReactNode
}

function Panel({ title, actionLabel, children }: PanelProps) {
  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <h2>{title}</h2>
        {actionLabel && (
          <span className={styles.panelAction}>
            {actionLabel}
            <ChevronRight size={14} aria-hidden="true" />
          </span>
        )}
      </header>
      {children}
    </section>
  )
}

interface MiniBarsProps {
  data: TrendPoint[]
  formatValue: (value: number) => string
}

function MiniBars({ data, formatValue }: MiniBarsProps) {
  const maxValue = Math.max(1, ...data.map((item) => item.value))

  if (!data.length) {
    return <EmptyState label="No trend data for this period." />
  }

  return (
    <div className={styles.miniBars}>
      {data.map((item, index) => (
        <div key={`${item.label}-${index}`} className={styles.miniBarColumn}>
          <span className={styles.miniBarValue}>{formatValue(item.value)}</span>
          <span className={styles.miniBarTrack}>
            <span className={styles.miniBarFill} style={{ height: `${Math.max(8, (item.value / maxValue) * 100)}%` }} />
          </span>
          <span className={styles.miniBarLabel}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

interface DualTrendProps {
  data: TrendPoint[]
  labelA: string
  labelB: string
  formatValue: (value: number) => string
}

function DualTrend({ data, labelA, labelB, formatValue }: DualTrendProps) {
  const maxValue = Math.max(1, ...data.flatMap((item) => [item.value, item.value2 || 0]))
  const latest = data[data.length - 1]

  if (!data.length) {
    return <EmptyState label="No comparison data for this period." />
  }

  return (
    <div className={styles.dualTrend}>
      <div className={styles.dualLegend}>
        <span><i className={styles.legendGreen} />{labelA}</span>
        <span><i className={styles.legendOrange} />{labelB}</span>
      </div>
      <div className={styles.dualChart}>
        {data.map((item, index) => (
          <div key={`${item.label}-${index}`} className={styles.dualColumn}>
            <span className={styles.dualPill} style={{ height: `${Math.max(8, (item.value / maxValue) * 100)}%` }} />
            <span className={styles.dualPillAlt} style={{ height: `${Math.max(8, ((item.value2 || 0) / maxValue) * 100)}%` }} />
          </div>
        ))}
      </div>
      {latest && (
        <div className={styles.dualSummary}>
          <span>{latest.label}</span>
          <strong>{formatValue(latest.value)} / {formatValue(latest.value2 || 0)}</strong>
        </div>
      )}
    </div>
  )
}

interface ProgressListProps {
  items: Array<{ label: string; value: number; color?: string }>
  formatValue: (value: number) => string
}

function ProgressList({ items, formatValue }: ProgressListProps) {
  const maxValue = Math.max(1, ...items.map((item) => item.value))

  if (!items.length) {
    return <EmptyState label="No data available for this period." />
  }

  return (
    <div className={styles.progressList}>
      {items.slice(0, 6).map((item, index) => (
        <div key={`${item.label}-${index}`} className={styles.progressItem}>
          <div className={styles.progressMeta}>
            <span>{item.label}</span>
            <strong>{formatValue(item.value)}</strong>
          </div>
          <span className={styles.progressTrack}>
            <span
              className={styles.progressFill}
              style={{
                width: `${Math.max(4, (item.value / maxValue) * 100)}%`,
                background: item.color || undefined
              }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

interface ListStackProps {
  children: ReactNode
  emptyLabel: string
}

function ListStack({ children, emptyLabel }: ListStackProps) {
  const count = React.Children.count(children)

  if (!count) {
    return <EmptyState label={emptyLabel} />
  }

  return <div className={styles.listStack}>{children}</div>
}

interface ListItemProps {
  title: string
  meta: string
  value?: string
}

function ListItem({ title, meta, value }: ListItemProps) {
  return (
    <article className={styles.listItem}>
      <div>
        <strong>{title}</strong>
        <span>{meta}</span>
      </div>
      {value && <em>{value}</em>}
    </article>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className={styles.emptyState}>
      <Activity size={18} />
      <span>{label}</span>
    </div>
  )
}

function PhoneSkeleton() {
  return (
    <div className={styles.skeletonStack} aria-label="Loading mobile metrics">
      <div className={styles.skeletonGrid}>
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className={styles.skeletonPanel} />
      <span className={styles.skeletonPanel} />
      <span className={styles.skeletonPanelShort} />
    </div>
  )
}
