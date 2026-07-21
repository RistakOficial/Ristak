import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, DateRangePicker, AreaChart, PageContainer, PageHeader, OriginDistributionCard, ConversionFunnelChart, ViewSelector, Loading, TabList, Modal } from '@/components/common'
import { KpiCard } from '@/components/common/KpiCard/KpiCard'
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  Target,
  Receipt,
  Wallet,
  RotateCcw,
  Users,
  Layers,
  MousePointerClick,
  CalendarClock,
  ArrowRight,
  UserPlus,
  Clock3,
  Banknote
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig, useUrlDateRangeSync } from '@/hooks'
import { dashboardService, type DashboardMetrics, type ChartData, type DashboardVisitorDetail } from '@/services/dashboardService'
import { trackingService, trackingVisitorsCoverageNotice } from '@/services/trackingService'
import type { ContactListItem } from '@/services/reportsService'
import type { Transaction } from '@/services/transactionsService'
import type { CalendarEvent } from '@/services/calendarsService'
import type { Campaign } from '@/services/campaignsService'
import { formatCurrency, formatRoas, formatChartDate, formatDateToISO, formatEndDateToISO, parseLocalDateString, formatChartCurrency, formatChartNumber, formatDate } from '@/utils/format'
import { dateOnlyToLocalDate, todayDateOnlyInTimezone } from '@/utils/timezone'
import { parseSortableDateValue } from '@/utils/dateSort'
import { getTransactionStatusBadge, getAppointmentStatusBadge } from '@/utils/statusBadges'
import { Badge } from '@/components/common/Badge'
import { hasWebAnalyticsAccess as canAccessWebAnalytics } from '@/utils/accessControl'
import { useNotification } from '@/contexts/NotificationContext'

const LazyContactDetailsModal = React.lazy(async () => {
  const module = await import('@/components/common/ContactDetailsModal/ContactDetailsModal')
  return { default: module.ContactDetailsModal }
})

const LazyVisitorDetailsModal = React.lazy(async () => {
  const module = await import('@/components/common/VisitorDetailsModal/VisitorDetailsModal')
  return { default: module.VisitorDetailsModal }
})

const loadReportsService = () => import('@/services/reportsService').then(module => module.reportsService)
const loadCampaignsService = () => import('@/services/campaignsService').then(module => module.campaignsService)

const DetailsModalLoadingFallback = ({
  title,
  subtitle,
  onClose
}: {
  title: string
  subtitle?: string
  onClose: () => void
}) => (
  <Modal
    isOpen
    onClose={onClose}
    title={title}
    subtitle={subtitle}
    size="lg"
    type="custom"
  >
    <Loading message="Abriendo detalles..." size="md" />
  </Modal>
)

const parseAnalyticsFlag = (value: unknown) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  if (typeof value === 'number') {
    return value === 1
  }
  return Boolean(value)
}

type FunnelStageKind = 'visitors' | 'leads' | 'appointments' | 'attendances' | 'customers'
type ContactModalType = 'interesados' | 'sales' | 'appointments' | 'attendances'
type ChartView = 'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-attendances' | 'attendances-sales'
type ChartSeriesKey = 'value' | 'value2'
type ChartBucketGranularity = 'day' | 'week' | 'fortnight' | 'month' | 'quarter' | 'year'
type ChartPeriodPreference =
  | 'year'
  | 'last12'
  | 'calendar-auto'
  | 'calendar-day'
  | 'calendar-week'
  | 'calendar-fortnight'
  | 'calendar-month'
  | 'calendar-quarter'
  | 'calendar-year'

const dashboardChartViews: ChartView[] = ['revenue-spend', 'visitors-leads', 'leads-appointments', 'appointments-attendances', 'attendances-sales']
const isDashboardChartView = (value?: string): value is ChartView => dashboardChartViews.includes(value as ChartView)
const parseDashboardRoute = (pathname: string): ChartView => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const dashboardIndex = segments.indexOf('dashboard')
  const routeSegments = dashboardIndex >= 0 ? segments.slice(dashboardIndex + 1) : []
  const chartIndex = routeSegments.indexOf('chart')
  const chartValue = chartIndex >= 0 ? routeSegments[chartIndex + 1] : routeSegments[0]
  return isDashboardChartView(chartValue) ? chartValue : 'revenue-spend'
}
const buildDashboardChartPath = (chartView: ChartView) => `/dashboard/chart/${chartView}`

interface DashboardChartPoint {
  label: string
  value: number
  value2?: number
  periodStart: string
  periodEnd: string
  periodKey: string
}

type DashboardChartClickPoint = Omit<DashboardChartPoint, 'periodStart' | 'periodEnd' | 'periodKey'> & Partial<Pick<DashboardChartPoint, 'periodStart' | 'periodEnd' | 'periodKey'>>
type ChartInsightContactType = 'interesados' | 'customers' | 'sales' | 'appointments' | 'attendances'

interface DashboardChartConfig {
  data: DashboardChartPoint[]
  label1: string
  label2: string
  color: string
  color2: string
  formatValue: (value: number) => string
  formatTooltipValue: (value: number) => string
}

interface ChartBucket {
  key: string
  label: string
  start: Date
  end: Date
  periodStart: string
  periodEnd: string
}

interface ChartWindow {
  start: Date
  end: Date
  granularity: ChartBucketGranularity
  buckets: ChartBucket[]
}

interface RawDualSeriesPoint {
  label: string
  value: number
  value2: number
}

interface ChartInsightItem {
  id: string
  title: string
  subtitle?: string
  meta?: string
  value?: string
  status?: string
}

interface ChartInsightColumn {
  key: string
  title: string
  metricLabel: string
  metricValue: string
  emptyMessage: string
  items: ChartInsightItem[]
}

interface ChartInsightModalState {
  open: boolean
  requestKey?: string
  title: string
  subtitle: string
  loading: boolean
  columns: ChartInsightColumn[]
}

interface VisitorsModalPageState {
  page: number
  cursor: string | null
  cursorHistory: Array<string | null>
  search: string
  hasNext: boolean
  nextCursor: string | null
  coverageNotice: string | null
}

const emptyVisitorsModalPageState: VisitorsModalPageState = {
  page: 1,
  cursor: null,
  cursorHistory: [],
  search: '',
  hasNext: false,
  nextCursor: null,
  coverageNotice: null
}

const emptyChartInsightModal: ChartInsightModalState = {
  open: false,
  title: '',
  subtitle: '',
  loading: false,
  columns: []
}

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const DAY_IN_MS = 24 * 60 * 60 * 1000
const VALID_CHART_PERIODS = new Set<ChartPeriodPreference>([
  'year',
  'last12',
  'calendar-auto',
  'calendar-day',
  'calendar-week',
  'calendar-fortnight',
  'calendar-month',
  'calendar-quarter',
  'calendar-year'
])

const GRANULARITY_LABELS: Record<ChartBucketGranularity, string> = {
  day: 'por día',
  week: 'por semana',
  fortnight: 'por quincena',
  month: 'por mes',
  quarter: 'por trimestre',
  year: 'por año'
}

const isSuccessfulPaymentStatus = (status?: string | null) => (
  SUCCESS_PAYMENT_STATUSES.has(status?.trim().toLowerCase() ?? '')
)

const isTestPaymentRecord = (payment?: { paymentMode?: string | null; payment_mode?: string | null }) => (
  payment?.paymentMode === 'test' || payment?.payment_mode === 'test'
)

const normalizeChartPeriodPreference = (value: unknown): ChartPeriodPreference => (
  typeof value === 'string' && VALID_CHART_PERIODS.has(value as ChartPeriodPreference)
    ? value as ChartPeriodPreference
    : 'last12'
)

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

const endOfLocalDay = (date: Date) => {
  const end = startOfLocalDay(date)
  end.setHours(23, 59, 59, 999)
  return end
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const addMonths = (date: Date, months: number) => (
  new Date(date.getFullYear(), date.getMonth() + months, 1)
)

const getInclusiveRangeDays = (start: Date, end: Date) => (
  Math.max(1, Math.floor((startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / DAY_IN_MS) + 1)
)

const getMonthKey = (date: Date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
)

const getQuarterKey = (date: Date) => (
  `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`
)

const getAvailableCalendarGranularities = (rangeDays: number): ChartBucketGranularity[] => {
  if (rangeDays <= 14) return ['day', 'week']
  if (rangeDays <= 45) return ['day', 'week', 'fortnight']
  if (rangeDays <= 120) return ['week', 'fortnight', 'month']
  if (rangeDays <= 400) return ['month', 'quarter']
  return ['month', 'quarter', 'year']
}

const getDefaultCalendarGranularity = (rangeDays: number): ChartBucketGranularity => {
  if (rangeDays <= 45) return 'day'
  if (rangeDays <= 120) return 'week'
  if (rangeDays <= 400) return 'month'
  return 'quarter'
}

const getChartPointDate = (dateStr: string): Date | null => {
  const trimmed = dateStr?.trim()
  if (!trimmed) return null

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed)
  if (monthMatch) {
    return new Date(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1)
  }

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (dayMatch) {
    return new Date(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3]))
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const formatFortnightLabel = (start: Date, end: Date) => {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
  const monthLabel = formatChartDate(formatDateToISO(end), 45)

  if (sameMonth) {
    return `${start.getDate()}-${end.getDate()} ${monthLabel.replace(/^\d+\s/, '')}`
  }

  return `${formatChartDate(formatDateToISO(start), 45)} - ${formatChartDate(formatDateToISO(end), 45)}`
}

const createChartBucket = (
  key: string,
  start: Date,
  end: Date,
  granularity: ChartBucketGranularity,
  previousKey?: string,
  rangeDays = 365
): ChartBucket => {
  const periodStartDate = startOfLocalDay(start)
  const periodEndDate = endOfLocalDay(end)

  let label = key
  if (granularity === 'day' || granularity === 'week') {
    label = formatChartDate(formatDateToISO(periodStartDate), rangeDays, previousKey)
  } else if (granularity === 'fortnight') {
    label = formatFortnightLabel(periodStartDate, periodEndDate)
  } else if (granularity === 'month') {
    label = formatChartDate(getMonthKey(periodStartDate), rangeDays, previousKey)
  } else if (granularity === 'quarter') {
    label = `T${Math.floor(periodStartDate.getMonth() / 3) + 1} ${periodStartDate.getFullYear()}`
  } else {
    label = String(periodStartDate.getFullYear())
  }

  return {
    key,
    label,
    start: periodStartDate,
    end: periodEndDate,
    periodStart: formatDateToISO(periodStartDate),
    periodEnd: formatEndDateToISO(periodEndDate)
  }
}

const buildChartBuckets = (
  startInput: Date,
  endInput: Date,
  granularity: ChartBucketGranularity
): ChartBucket[] => {
  const start = startOfLocalDay(startInput)
  const end = startOfLocalDay(endInput)
  const rangeDays = getInclusiveRangeDays(start, end)
  const buckets: ChartBucket[] = []

  if (granularity === 'day') {
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      const key = formatDateToISO(cursor)
      buckets.push(createChartBucket(key, cursor, cursor, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
    }
    return buckets
  }

  if (granularity === 'week') {
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
      const bucketEnd = new Date(Math.min(addDays(cursor, 6).getTime(), end.getTime()))
      const key = `week-${formatDateToISO(cursor)}`
      buckets.push(createChartBucket(key, cursor, bucketEnd, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
    }
    return buckets
  }

  if (granularity === 'fortnight') {
    let cursor = start.getDate() <= 15
      ? new Date(start.getFullYear(), start.getMonth(), 1)
      : new Date(start.getFullYear(), start.getMonth(), 16)

    while (cursor <= end) {
      const naturalEnd = cursor.getDate() === 1
        ? new Date(cursor.getFullYear(), cursor.getMonth(), 15)
        : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
      const bucketStart = new Date(Math.max(cursor.getTime(), start.getTime()))
      const bucketEnd = new Date(Math.min(naturalEnd.getTime(), end.getTime()))
      const key = `fortnight-${formatDateToISO(cursor)}`

      buckets.push(createChartBucket(key, bucketStart, bucketEnd, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
      cursor = cursor.getDate() === 1
        ? new Date(cursor.getFullYear(), cursor.getMonth(), 16)
        : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    return buckets
  }

  if (granularity === 'month') {
    for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = addMonths(cursor, 1)) {
      const naturalEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
      const bucketStart = new Date(Math.max(cursor.getTime(), start.getTime()))
      const bucketEnd = new Date(Math.min(naturalEnd.getTime(), end.getTime()))
      const key = getMonthKey(cursor)

      buckets.push(createChartBucket(key, bucketStart, bucketEnd, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
    }
    return buckets
  }

  if (granularity === 'quarter') {
    const firstQuarterMonth = Math.floor(start.getMonth() / 3) * 3
    for (let cursor = new Date(start.getFullYear(), firstQuarterMonth, 1); cursor <= end; cursor = addMonths(cursor, 3)) {
      const naturalEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 0)
      const bucketStart = new Date(Math.max(cursor.getTime(), start.getTime()))
      const bucketEnd = new Date(Math.min(naturalEnd.getTime(), end.getTime()))
      const key = getQuarterKey(cursor)

      buckets.push(createChartBucket(key, bucketStart, bucketEnd, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
    }
    return buckets
  }

  for (let cursor = new Date(start.getFullYear(), 0, 1); cursor <= end; cursor = new Date(cursor.getFullYear() + 1, 0, 1)) {
    const naturalEnd = new Date(cursor.getFullYear(), 11, 31)
    const bucketStart = new Date(Math.max(cursor.getTime(), start.getTime()))
    const bucketEnd = new Date(Math.min(naturalEnd.getTime(), end.getTime()))
    const key = String(cursor.getFullYear())

    buckets.push(createChartBucket(key, bucketStart, bucketEnd, granularity, buckets[buckets.length - 1]?.periodStart, rangeDays))
  }

  return buckets
}

const aggregateDualSeries = (
  rawData: RawDualSeriesPoint[],
  buckets: ChartBucket[]
): DashboardChartPoint[] => {
  const totals = new Map(buckets.map(bucket => [bucket.key, { value: 0, value2: 0 }]))

  rawData.forEach(item => {
    const pointDate = getChartPointDate(item.label)
    if (!pointDate) return

    const bucket = buckets.find(candidate => pointDate >= candidate.start && pointDate <= candidate.end)
    if (!bucket) return

    const current = totals.get(bucket.key)
    if (!current) return

    current.value += Number(item.value || 0)
    current.value2 += Number(item.value2 || 0)
  })

  return buckets.map(bucket => {
    const values = totals.get(bucket.key) ?? { value: 0, value2: 0 }

    return {
      label: bucket.label,
      value: values.value,
      value2: values.value2,
      periodKey: bucket.key,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd
    }
  })
}

const getTimeValue = (date?: string | null) => {
  if (!date) return 0
  return parseSortableDateValue(date)
}

const getTransactionDate = (transaction: Transaction) => (
  transaction.date || transaction.createdAt || transaction.sentAt || transaction.updatedAt || ''
)

const getContactCreatedAt = (contact: ContactListItem) => (
  contact.created_at || (contact as any).createdAt || ''
)

const getContactName = (contact: ContactListItem) => (
  contact.name || contact.email || contact.phone || 'Contacto sin nombre'
)

const getAppointmentTitle = (appointment: CalendarEvent) => (
  appointment.title || appointment.description || 'Cita sin título'
)

const getResponsiveDashboardChartHeight = () => {
  if (typeof window === 'undefined') return 380

  const width = window.innerWidth
  if (width <= 680) return 220
  if (width <= 760) return 240
  if (width <= 820) return 260
  if (width <= 1024) return 280
  if (width <= 1180) return 310
  if (width <= 1366) return 340
  if (width <= 1536) return 360
  return 380
}

const formatPeriodRange = (from: string, to: string) => {
  const startDate = parseLocalDateString(from.slice(0, 10))
  const endDate = to.includes('T') ? new Date(to) : parseLocalDateString(to.slice(0, 10))

  return `${formatDate(startDate, { includeYear: true })} - ${formatDate(endDate, { includeYear: true })}`
}

export const Dashboard: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeChartView = React.useMemo(() => parseDashboardRoute(location.pathname), [location.pathname])
  const { dateRange, setDateRange } = useDateRange()
  const { user, locationId } = useAuth()
  const { labels } = useLabels()
  const { formatLocalDateTime, timezone } = useTimezone()
  const { showToast } = useNotification()
  const hasWebAnalyticsAccess = canAccessWebAnalytics(user)
  const businessToday = React.useMemo(
    () => dateOnlyToLocalDate(todayDateOnlyInTimezone(timezone)) || new Date(),
    [timezone]
  )

  // Sistema híbrido de configuración
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')
  const [chartPeriodConfig, setChartPeriodConfig] = useAppConfig<string>('dashboard_chart_period', 'last12')
  const [showFunnelVisitorsConfig, setShowFunnelVisitorsConfig, savingFunnelVisitorsConfig] = useAppConfig<string | number | boolean>('dashboard_show_funnel_visitors', '1', {
    cacheFirst: false
  })
  const chartPeriodPreference = normalizeChartPeriodPreference(chartPeriodConfig)

  const analyticsPreferenceEnabled = parseAnalyticsFlag(showAnalyticsConfig)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(false)
  const analyticsEnabled = hasWebAnalyticsAccess && analyticsPreferenceEnabled && webTrackingConfigured
  const showFunnelVisitors = analyticsEnabled && parseAnalyticsFlag(showFunnelVisitorsConfig)

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(() => (
    user ? dashboardService.peekDashboardMetrics({ start: dateRange.start, end: dateRange.end }) : null
  ))
  const [chartData, setChartData] = useState<ChartData[]>([])
  const [visitorsLeadsData, setVisitorsLeadsData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [leadsAppointmentsData, setLeadsAppointmentsData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [appointmentsAttendancesData, setAppointmentsAttendancesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [attendancesSalesData, setAttendancesSalesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [funnelData, setFunnelData] = useState<{ stage: string; value: number }[]>([])
  const [funnelScope, setFunnelScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [financialScope, setFinancialScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [loading, setLoading] = useState(true)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const [metricsRetryKey, setMetricsRetryKey] = useState(0)
  const [chartLoading, setChartLoading] = useState(true)
  const [selectedChartView, setSelectedChartView] = useState<ChartView>(routeChartView)
  const [extendedChartDataLoaded, setExtendedChartDataLoaded] = useState(false)
  const [extendedChartDataLoading, setExtendedChartDataLoading] = useState(false)
  const [extendedChartDataError, setExtendedChartDataError] = useState<string | null>(null)
  const extendedChartRequestRef = React.useRef(0)
  const extendedChartAbortRef = React.useRef<AbortController | null>(null)
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [contactModalTitle, setContactModalTitle] = useState('')
  const [contactModalSubtitle, setContactModalSubtitle] = useState('')
  const [contactModalType, setContactModalType] = useState<ContactModalType>('interesados')
  const [contactModalLoading, setContactModalLoading] = useState(false)
  const [contactModalContacts, setContactModalContacts] = useState<ContactListItem[]>([])
  const contactModalRequestRef = React.useRef(0)
  const contactModalAbortRef = React.useRef<AbortController | null>(null)
  const [visitorsModalOpen, setVisitorsModalOpen] = useState(false)
  const [visitorsModalTitle, setVisitorsModalTitle] = useState('Visitantes')
  const [visitorsModalSubtitle, setVisitorsModalSubtitle] = useState('')
  const [visitorsModalLoading, setVisitorsModalLoading] = useState(false)
  const [visitorsModalData, setVisitorsModalData] = useState<DashboardVisitorDetail[]>([])
  const [visitorsModalPage, setVisitorsModalPage] = useState<VisitorsModalPageState>(emptyVisitorsModalPageState)
  const visitorsModalRequestRef = React.useRef(0)
  const visitorsModalAbortRef = React.useRef<AbortController | null>(null)
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([])
  const [recentAppointments, setRecentAppointments] = useState<CalendarEvent[]>([])
  const [recentContacts, setRecentContacts] = useState<ContactListItem[]>([])
  const [chartInsightModal, setChartInsightModal] = useState<ChartInsightModalState>(emptyChartInsightModal)
  const [chartHeight, setChartHeight] = useState(getResponsiveDashboardChartHeight)

  useUrlDateRangeSync({
    dateRange,
    setDateRange
  })

  const funnelChartData = React.useMemo(() => {
    if (analyticsEnabled) return funnelData
    return funnelData.filter((stage) => stage.stage?.trim().toLowerCase() !== 'visitantes')
  }, [analyticsEnabled, funnelData])

  const showTrafficSourcesChart = analyticsEnabled

  useEffect(() => {
    if (!hasWebAnalyticsAccess || !analyticsPreferenceEnabled) {
      setWebTrackingConfigured(false)
      return
    }

    let mounted = true

    trackingService.getTrackingConfig()
      .then((config) => {
        if (mounted) setWebTrackingConfigured(Boolean(config?.isConfigured))
      })
      .catch(() => {
        if (mounted) setWebTrackingConfigured(false)
      })

    return () => {
      mounted = false
    }
  }, [hasWebAnalyticsAccess, analyticsPreferenceEnabled])

  const handleFunnelVisitorsVisibilityChange = React.useCallback((nextShowVisitors: boolean) => {
    setShowFunnelVisitorsConfig(nextShowVisitors ? '1' : '0').catch((error) => {
      console.error('Error guardando visibilidad de visitantes del embudo:', error)
    })
  }, [setShowFunnelVisitorsConfig])

  const chartsGridClass = showTrafficSourcesChart ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'

  useEffect(() => {
    const handleResize = () => {
      setChartHeight(getResponsiveDashboardChartHeight())
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [])

  const calendarRangeDays = React.useMemo(
    () => getInclusiveRangeDays(dateRange.start, dateRange.end),
    [dateRange.start, dateRange.end]
  )
  const availableCalendarGranularities = React.useMemo(
    () => getAvailableCalendarGranularities(calendarRangeDays),
    [calendarRangeDays]
  )
  const defaultCalendarGranularity = React.useMemo(
    () => getDefaultCalendarGranularity(calendarRangeDays),
    [calendarRangeDays]
  )

  const effectiveCalendarGranularity = React.useMemo<ChartBucketGranularity>(() => {
    if (!chartPeriodPreference.startsWith('calendar-') || chartPeriodPreference === 'calendar-auto') {
      return defaultCalendarGranularity
    }

    const requested = chartPeriodPreference.replace('calendar-', '') as ChartBucketGranularity
    return availableCalendarGranularities.includes(requested) ? requested : defaultCalendarGranularity
  }, [availableCalendarGranularities, chartPeriodPreference, defaultCalendarGranularity])

  const chartPeriodOptions = React.useMemo(() => {
    const calendarOptions = availableCalendarGranularities.map((granularity) => ({
      value: `calendar-${granularity}`,
      label: `Calendario: ${GRANULARITY_LABELS[granularity]}`
    }))

    return [
      { value: 'year', label: 'Por año' },
      { value: 'last12', label: 'Últimos 12 meses' },
      { value: 'calendar-auto', label: `Según calendario: ${GRANULARITY_LABELS[defaultCalendarGranularity]}` },
      ...calendarOptions
    ]
  }, [availableCalendarGranularities, defaultCalendarGranularity])

  const selectedChartPeriodValue = React.useMemo(() => {
    return chartPeriodOptions.some(option => option.value === chartPeriodPreference)
      ? chartPeriodPreference
      : 'calendar-auto'
  }, [chartPeriodOptions, chartPeriodPreference])

  const chartWindow = React.useMemo<ChartWindow>(() => {
    const today = startOfLocalDay(businessToday)
    let start = dateRange.start
    let end = dateRange.end
    let granularity: ChartBucketGranularity = effectiveCalendarGranularity

    if (chartPeriodPreference === 'year') {
      start = new Date(today.getFullYear(), 0, 1)
      end = today
      granularity = 'month'
    } else if (chartPeriodPreference === 'last12') {
      start = new Date(today.getFullYear(), today.getMonth() - 11, 1)
      end = today
      granularity = 'month'
    }

    const normalizedStart = startOfLocalDay(start)
    const normalizedEnd = startOfLocalDay(end)
    return {
      start: normalizedStart,
      end: normalizedEnd,
      granularity,
      buckets: buildChartBuckets(normalizedStart, normalizedEnd, granularity)
    }
  }, [businessToday, chartPeriodPreference, dateRange.end, dateRange.start, effectiveCalendarGranularity])

  const chartApiGroupBy = chartWindow.granularity === 'day' || chartWindow.granularity === 'week' || chartWindow.granularity === 'fortnight'
    ? 'day'
    : 'month'

  // Agrupar datos financieros según el rango activo del gráfico
  const formattedFinancialData = React.useMemo<DashboardChartPoint[]>(() => {
    return aggregateDualSeries(
      chartData.map(item => ({
        label: item.date,
        value: item.ingresos,
        value2: item.gastado
      })),
      chartWindow.buckets
    )
  }, [chartData, chartWindow.buckets])

  const currencyAxisFormatter = React.useCallback((value: number) => formatChartCurrency(value), [])

  // Configuración del gráfico según la vista seleccionada
  const chartConfig = React.useMemo<DashboardChartConfig>(() => {
    const formatData = (rawData: { label: string; value: number; value2: number }[]): DashboardChartPoint[] => {
      return aggregateDualSeries(rawData, chartWindow.buckets)
    }

    switch (selectedChartView) {
      case 'revenue-spend':
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-secondary, #64748b)',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
      case 'visitors-leads':
        if (!analyticsEnabled) {
          return {
            data: formatData([]),
            label1: 'Ingresos',
            label2: 'Gastos',
            color: 'var(--design-chart-primary, #10b981)',
            color2: 'var(--design-chart-secondary, #64748b)',
            formatValue: currencyAxisFormatter,
            formatTooltipValue: (value: number) => formatCurrency(value)
          }
        }
        return {
          data: formatData(visitorsLeadsData),
          label1: 'Visitantes',
          label2: labels.leads,
          color: 'var(--design-chart-tertiary, #3b82f6)',
          color2: 'var(--design-chart-accent, #8b5cf6)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'leads-appointments':
        return {
          data: formatData(leadsAppointmentsData),
          label1: labels.leads,
          label2: 'Citas',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-warning, #f59e0b)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'appointments-attendances':
        return {
          data: formatData(appointmentsAttendancesData),
          label1: 'Citas',
          label2: 'Asistencias',
          color: 'var(--design-chart-warning, #f59e0b)',
          color2: 'var(--design-chart-tertiary, #3b82f6)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'attendances-sales':
        return {
          data: formatData(attendancesSalesData),
          label1: 'Asistencias',
          label2: 'Ventas',
          color: 'var(--design-chart-tertiary, #3b82f6)',
          color2: 'var(--design-chart-primary, #10b981)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      default:
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-secondary, #64748b)',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
    }
  }, [analyticsEnabled, selectedChartView, formattedFinancialData, visitorsLeadsData, leadsAppointmentsData, appointmentsAttendancesData, attendancesSalesData, labels.leads, currencyAxisFormatter, chartWindow.buckets])

  const isChartLoading = selectedChartView === 'revenue-spend'
    ? chartLoading
    : extendedChartDataLoading

  const hasChartData = React.useMemo(
    () => chartConfig.data.some(item => (item.value ?? 0) !== 0 || (item.value2 ?? 0) !== 0),
    [chartConfig]
  )

  const chartViewOptions = React.useMemo(() => {
    const options: Array<{ value: ChartView; label: string }> = [
      { value: 'revenue-spend', label: 'Ingresos vs Gastos' },
      { value: 'leads-appointments', label: `${labels.leads} vs Citas` },
      { value: 'appointments-attendances', label: 'Citas vs Asistencias' },
      { value: 'attendances-sales', label: 'Asistencias vs Ventas' }
    ]

    if (analyticsEnabled) {
      options.splice(1, 0, { value: 'visitors-leads', label: `Visitantes vs ${labels.leads}` })
    }

    return options
  }, [analyticsEnabled, labels.leads])

  const activeChartLabel = React.useMemo(() => {
    const active = chartViewOptions.find(option => option.value === selectedChartView)
    return active?.label ?? 'Ingresos vs Gastos'
  }, [chartViewOptions, selectedChartView])

  const chartLegendItems = React.useMemo(() => {
    const items = [
      { key: 'value', label: chartConfig.label1, color: chartConfig.color }
    ]

    if (chartConfig.label2) {
      items.push({ key: 'value2', label: chartConfig.label2, color: chartConfig.color2 })
    }

    return items
  }, [chartConfig.color, chartConfig.color2, chartConfig.label1, chartConfig.label2])

  const selectedRangeLabel = React.useMemo(() => {
    const from = formatDateToISO(dateRange.start, { timezone })
    const to = formatDateToISO(dateRange.end, { timezone })
    return from === to ? from : `${from} - ${to}`
  }, [dateRange.start, dateRange.end, timezone])

  const getFunnelStageKind = React.useCallback((stage: string): FunnelStageKind | null => {
    const normalized = stage.trim().toLowerCase()
    const leadsLabel = labels.leads.trim().toLowerCase()
    const customersLabel = labels.customers.trim().toLowerCase()

    if (normalized === 'visitantes') return 'visitors'
    if ([leadsLabel, 'leads', 'interesados', 'prospectos'].includes(normalized)) return 'leads'
    if (normalized === 'citas') return 'appointments'
    if (normalized === 'asistencias') return 'attendances'
    if ([customersLabel, 'clientes', 'customers'].includes(normalized)) return 'customers'
    return null
  }, [labels.customers, labels.leads])

  const loadVisitorsModalPage = React.useCallback(async ({
    cursor,
    cursorHistory,
    page,
    search
  }: Pick<VisitorsModalPageState, 'cursor' | 'cursorHistory' | 'page' | 'search'>) => {
    visitorsModalAbortRef.current?.abort()
    const controller = new AbortController()
    visitorsModalAbortRef.current = controller
    const requestId = visitorsModalRequestRef.current + 1
    visitorsModalRequestRef.current = requestId
    setVisitorsModalLoading(true)

    try {
      const result = await dashboardService.getVisitorsPage({
        start: dateRange.start,
        end: dateRange.end,
        scope: funnelScope,
        cursor,
        search,
        limit: 50,
        signal: controller.signal
      })
      if (visitorsModalRequestRef.current !== requestId) return

      const coverageNotice = trackingVisitorsCoverageNotice(result.coverage)
      if (result.items.length > 0 || !coverageNotice) {
        setVisitorsModalData(result.items)
      }
      setVisitorsModalPage({
        page,
        cursor,
        cursorHistory,
        search,
        hasNext: result.pagination.hasNext,
        nextCursor: result.pagination.nextCursor,
        coverageNotice
      })
    } catch (error) {
      if (controller.signal.aborted) return
      if (visitorsModalRequestRef.current !== requestId) return
      setVisitorsModalData([])
      setVisitorsModalPage({
        ...emptyVisitorsModalPageState,
        search,
        coverageNotice: error instanceof Error
          ? error.message
          : 'No se pudieron cargar los visitantes. Intenta nuevamente.'
      })
    } finally {
      if (visitorsModalRequestRef.current === requestId) setVisitorsModalLoading(false)
      if (visitorsModalAbortRef.current === controller) visitorsModalAbortRef.current = null
    }
  }, [dateRange.end, dateRange.start, funnelScope])

  const closeVisitorsModal = React.useCallback(() => {
    visitorsModalRequestRef.current += 1
    visitorsModalAbortRef.current?.abort()
    visitorsModalAbortRef.current = null
    setVisitorsModalLoading(false)
    setVisitorsModalOpen(false)
  }, [])

  const closeContactModal = React.useCallback(() => {
    contactModalRequestRef.current += 1
    contactModalAbortRef.current?.abort()
    contactModalAbortRef.current = null
    setContactModalLoading(false)
    setContactModalOpen(false)
  }, [])

  React.useEffect(() => () => {
    contactModalAbortRef.current?.abort()
    visitorsModalAbortRef.current?.abort()
    extendedChartAbortRef.current?.abort()
  }, [])

  const handleVisitorsModalPageChange = React.useCallback((direction: 'next' | 'previous') => {
    if (direction === 'next') {
      if (!visitorsModalPage.hasNext || !visitorsModalPage.nextCursor) return
      void loadVisitorsModalPage({
        cursor: visitorsModalPage.nextCursor,
        cursorHistory: [...visitorsModalPage.cursorHistory, visitorsModalPage.cursor],
        page: visitorsModalPage.page + 1,
        search: visitorsModalPage.search
      })
      return
    }

    if (visitorsModalPage.page <= 1) return
    const previousCursor = visitorsModalPage.cursorHistory[visitorsModalPage.cursorHistory.length - 1] ?? null
    void loadVisitorsModalPage({
      cursor: previousCursor,
      cursorHistory: visitorsModalPage.cursorHistory.slice(0, -1),
      page: visitorsModalPage.page - 1,
      search: visitorsModalPage.search
    })
  }, [loadVisitorsModalPage, visitorsModalPage])

  const handleVisitorsModalSearch = React.useCallback((search: string) => {
    if (search === visitorsModalPage.search) return
    void loadVisitorsModalPage({ cursor: null, cursorHistory: [], page: 1, search })
  }, [loadVisitorsModalPage, visitorsModalPage.search])

  const handleFunnelStageClick = React.useCallback(async (stage: { stage: string; value: number }) => {
    const kind = getFunnelStageKind(stage.stage)
    if (!kind) return

    if (kind === 'visitors') {
      if (!analyticsEnabled) return

      closeContactModal()
      setVisitorsModalOpen(true)
      setVisitorsModalTitle('Visitantes')
      setVisitorsModalSubtitle(selectedRangeLabel)
      setVisitorsModalData([])
      setVisitorsModalPage(emptyVisitorsModalPageState)
      await loadVisitorsModalPage({ cursor: null, cursorHistory: [], page: 1, search: '' })
      return
    }

    const contactConfig = {
      leads: { listType: 'interesados', modalType: 'interesados', title: labels.leads },
      appointments: { listType: 'appointments', modalType: 'appointments', title: 'Citas' },
      attendances: { listType: 'attendances', modalType: 'attendances', title: 'Asistencias' },
      customers: { listType: 'customers', modalType: 'sales', title: labels.customers }
    }[kind] as {
      listType: 'interesados' | 'customers' | 'appointments' | 'attendances'
      modalType: ContactModalType
      title: string
    }

    closeVisitorsModal()
    setContactModalOpen(true)
    setContactModalTitle(contactConfig.title)
    setContactModalSubtitle(selectedRangeLabel)
    setContactModalType(contactConfig.modalType)
    setContactModalContacts([])
    setContactModalLoading(true)
    contactModalAbortRef.current?.abort()
    const controller = new AbortController()
    contactModalAbortRef.current = controller
    const requestId = contactModalRequestRef.current + 1
    contactModalRequestRef.current = requestId

    try {
      const reportsService = await loadReportsService()
      const result = await reportsService.getContactsList({
        from: formatDateToISO(dateRange.start, { timezone }),
        to: formatEndDateToISO(dateRange.end, { timezone }),
        type: contactConfig.listType,
        scope: funnelScope
      }, controller.signal)

      if (contactModalRequestRef.current !== requestId) return

      setContactModalContacts(result.contacts.map(contact => ({
        ...contact,
        created_at: contact.created_at || (contact as any).createdAt
      })))
    } catch {
      if (controller.signal.aborted || contactModalRequestRef.current !== requestId) return
      setContactModalContacts([])
    } finally {
      if (contactModalRequestRef.current === requestId) setContactModalLoading(false)
      if (contactModalAbortRef.current === controller) contactModalAbortRef.current = null
    }
  }, [analyticsEnabled, closeContactModal, closeVisitorsModal, dateRange.end, dateRange.start, funnelScope, getFunnelStageKind, labels.customers, labels.leads, loadVisitorsModalPage, selectedRangeLabel, timezone])

  const financialScopeOptions = React.useMemo(
    () => [
      {
        value: 'all' as const,
        label: 'Todos',
        icon: Layers,
        description: 'Muestra ingresos y gasto por la fecha real en que ocurrió cada evento.'
      },
      {
        value: 'attribution' as const,
        label: 'Al registro',
        icon: Target,
        description: 'Agrupa los resultados en la fecha de creación del contacto para evaluar qué registros convirtieron.'
      },
      {
        value: 'campaigns' as const,
        label: 'Identificados de anuncios',
        icon: MousePointerClick,
        description: 'Filtra a contactos identificados desde anuncios y atribuye sus resultados al día de registro.'
      }
    ],
    []
  )

  const handleChartPeriodChange = React.useCallback((value: string) => {
    void setChartPeriodConfig(normalizeChartPeriodPreference(value))
  }, [setChartPeriodConfig])

  useEffect(() => {
    setSelectedChartView(current => current === routeChartView ? current : routeChartView)
  }, [routeChartView])

  useEffect(() => {
    if (!analyticsEnabled && selectedChartView === 'visitors-leads') {
      setSelectedChartView('revenue-spend')
      navigate({ pathname: buildDashboardChartPath('revenue-spend'), search: location.search }, { replace: true })
    }
  }, [analyticsEnabled, location.search, navigate, selectedChartView])

  // Cargar datasets extendidos del gráfico solo cuando sean necesarios
  const loadExtendedChartData = React.useCallback(async () => {
    if (
      !user
      || selectedChartView === 'revenue-spend'
      || extendedChartDataLoading
      || extendedChartDataLoaded
      || extendedChartDataError
    ) {
      return
    }

    const requestId = extendedChartRequestRef.current + 1
    extendedChartRequestRef.current = requestId
    extendedChartAbortRef.current?.abort()
    const controller = new AbortController()
    extendedChartAbortRef.current = controller
    const isCurrentRequest = () => (
      !controller.signal.aborted && extendedChartRequestRef.current === requestId
    )

    setExtendedChartDataLoading(true)
    setExtendedChartDataError(null)
    try {
      // Las métricas de CONTEO ÚNICO (visitantes, citados, asistencias) no se pueden
      // sumar por día para armar buckets que abarcan varios días: se contaría de más al
      // mismo visitante/contacto activo en varios días del bucket. Cuando el bucket abarca
      // más de un día (semana/quincena/trimestre/año) mandamos las fronteras EXACTAS de
      // cada bucket para que el backend haga UN DISTINCT por ventana (mismo número que el
      // modal). Las series aditivas (leads/ventas) se siguen pidiendo por día y sumando.
      const usesMultiDayBuckets = ['week', 'fortnight', 'quarter', 'year'].includes(chartWindow.granularity)
      const bucketPeriods = usesMultiDayBuckets
        ? chartWindow.buckets.map(bucket => ({ start: bucket.periodStart, end: bucket.periodEnd }))
        : undefined

      type ChartSeries = { label: string; value: number }[]
      let primarySeriesPromise: Promise<ChartSeries>
      let secondarySeriesPromise: Promise<ChartSeries>

      switch (selectedChartView) {
        case 'visitors-leads':
          if (!analyticsEnabled) return
          primarySeriesPromise = dashboardService.getVisitorsData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            periods: bucketPeriods,
            signal: controller.signal
          })
          secondarySeriesPromise = dashboardService.getLeadsData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            signal: controller.signal
          })
          break
        case 'leads-appointments':
          primarySeriesPromise = dashboardService.getLeadsData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            signal: controller.signal
          })
          secondarySeriesPromise = dashboardService.getAppointmentsData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            periods: bucketPeriods,
            signal: controller.signal
          })
          break
        case 'appointments-attendances':
          primarySeriesPromise = dashboardService.getAppointmentsData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            periods: bucketPeriods,
            signal: controller.signal
          })
          secondarySeriesPromise = dashboardService.getAttendancesData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            periods: bucketPeriods,
            signal: controller.signal
          })
          break
        case 'attendances-sales':
          primarySeriesPromise = dashboardService.getAttendancesData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            periods: bucketPeriods,
            signal: controller.signal
          })
          secondarySeriesPromise = dashboardService.getSalesData({
            start: chartWindow.start,
            end: chartWindow.end,
            groupBy: chartApiGroupBy,
            signal: controller.signal
          })
          break
      }

      // Ambas series se encolan juntas. La espera tiene un límite propio y cada
      // deadline de 20 s empieza al obtener uno de los dos carriles del backend.
      const [primarySeries, secondarySeries] = await Promise.all([
        primarySeriesPromise,
        secondarySeriesPromise
      ])

      if (!isCurrentRequest()) return

      const primaryMap = new Map(primarySeries.map(point => [point.label, point.value]))
      const secondaryMap = new Map(secondarySeries.map(point => [point.label, point.value]))
      const allDates = new Set([
        ...primarySeries.map(point => point.label),
        ...secondarySeries.map(point => point.label)
      ])
      const sortedDates = Array.from(allDates).sort()
      const selectedSeries = sortedDates.map(date => ({
        label: date,
        value: primaryMap.get(date) || 0,
        value2: secondaryMap.get(date) || 0
      }))

      if (selectedChartView === 'visitors-leads') setVisitorsLeadsData(selectedSeries)
      else if (selectedChartView === 'leads-appointments') setLeadsAppointmentsData(selectedSeries)
      else if (selectedChartView === 'appointments-attendances') setAppointmentsAttendancesData(selectedSeries)
      else setAttendancesSalesData(selectedSeries)

      setExtendedChartDataLoaded(true)
    } catch (error) {
      if (!isCurrentRequest()) return
      setExtendedChartDataLoaded(false)
      const message = error instanceof Error ? error.message : 'Intenta nuevamente.'
      setExtendedChartDataError(message)
      showToast('error', 'No se cargó la gráfica', message)
    } finally {
      if (isCurrentRequest()) setExtendedChartDataLoading(false)
    }
  }, [analyticsEnabled, chartApiGroupBy, chartWindow.granularity, chartWindow.buckets, chartWindow.end, chartWindow.start, extendedChartDataError, extendedChartDataLoaded, extendedChartDataLoading, selectedChartView, showToast, user])

  React.useEffect(() => {
    extendedChartRequestRef.current += 1
    extendedChartAbortRef.current?.abort()
    extendedChartAbortRef.current = null
    setExtendedChartDataLoaded(false)
    setExtendedChartDataLoading(false)
    setExtendedChartDataError(null)
    setVisitorsLeadsData([])
    setLeadsAppointmentsData([])
    setAppointmentsAttendancesData([])
    setAttendancesSalesData([])

    return () => {
      extendedChartAbortRef.current?.abort()
    }
  }, [analyticsEnabled, chartApiGroupBy, chartWindow.granularity, chartWindow.buckets, chartWindow.end, chartWindow.start, selectedChartView])

  React.useEffect(() => {
    if (selectedChartView === 'revenue-spend') return
    if (!analyticsEnabled && selectedChartView === 'visitors-leads') return
    void loadExtendedChartData()
  }, [selectedChartView, analyticsEnabled, loadExtendedChartData])

  useEffect(() => {
    if (!user) return

    let mounted = true
    const controller = new AbortController()
    const cachedMetrics = dashboardService.peekDashboardMetrics({
      start: dateRange.start,
      end: dateRange.end
    })
    setMetrics(cachedMetrics)

    const loadData = async () => {
      setLoading(!cachedMetrics)
      setMetricsError(null)
      try {
        const metricsData = await dashboardService.getDashboardMetrics({
          start: dateRange.start,
          end: dateRange.end
        }, {
          signal: controller.signal
        })

        if (!mounted || controller.signal.aborted) return

        setMetrics(metricsData)
      } catch (error) {
        if (!controller.signal.aborted && mounted) {
          const message = error instanceof Error ? error.message : 'Intenta nuevamente'
          setMetricsError(message)
          showToast('error', 'No se cargaron las métricas', message)
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    loadData()

    return () => {
      mounted = false
      controller.abort()
    }
  }, [dateRange.end, dateRange.start, metricsRetryKey, showToast, user])

  useEffect(() => {
    if (!user) return

    let mounted = true
    const controller = new AbortController()

    const loadFinancialChartData = async () => {
      setChartLoading(true)
      try {
        const chartDataResponse = await dashboardService.getFinancialChart({
          start: chartWindow.start,
          end: chartWindow.end,
          scope: financialScope
        }, controller.signal)

        if (!mounted) return
        setChartData(chartDataResponse)
      } catch (error) {
        if (mounted) {
          setChartData([])
          if (!controller.signal.aborted) {
            showToast('error', 'No se cargó la gráfica financiera', error instanceof Error ? error.message : 'Intenta nuevamente')
          }
        }
      } finally {
        if (mounted) {
          setChartLoading(false)
        }
      }
    }

    loadFinancialChartData()

    return () => {
      mounted = false
      controller.abort()
    }
  }, [chartWindow.end, chartWindow.start, financialScope, showToast, user])

  useEffect(() => {
    if (!user) return

    let mounted = true
    const controller = new AbortController()

    const loadOperationalSnapshot = async () => {
      setOperationsLoading(true)

      try {
        const snapshot = await dashboardService.getOperationalSnapshot({
          start: dateRange.start,
          end: dateRange.end
        }, controller.signal)

        if (!mounted) return

        setRecentTransactions(snapshot.transactions)
        setRecentContacts(snapshot.contacts)
        setRecentAppointments(snapshot.appointments)
      } catch (error) {
        if (!mounted) return
        setRecentTransactions([])
        setRecentContacts([])
        setRecentAppointments([])
        if (!controller.signal.aborted) {
          showToast('error', 'No se cargó el resumen operativo', error instanceof Error ? error.message : 'Intenta nuevamente')
        }
      } finally {
        if (mounted) {
          setOperationsLoading(false)
        }
      }
    }

    loadOperationalSnapshot()

    return () => {
      mounted = false
      controller.abort()
    }
  }, [dateRange.end, dateRange.start, showToast, timezone, user])

  // useEffect separado solo para el funnel (no recarga toda la página)
  React.useEffect(() => {
    if (!user) return

    let mounted = true
    const controller = new AbortController()

    const loadFunnelData = async () => {
      try {
        const funnelDataResponse = await dashboardService.getFunnelData({
          start: dateRange.start,
          end: dateRange.end,
          scope: funnelScope,
          includeWeb: hasWebAnalyticsAccess
        }, controller.signal)
        if (mounted) setFunnelData(funnelDataResponse)
      } catch (error) {
        if (mounted && !controller.signal.aborted) {
          setFunnelData([])
          showToast('error', 'No se cargó el embudo', error instanceof Error ? error.message : 'Intenta nuevamente')
        }
      }
    }

    loadFunnelData()

    return () => {
      mounted = false
      controller.abort()
    }
  }, [dateRange.end, dateRange.start, funnelScope, hasWebAnalyticsAccess, showToast, user])

  const renderOperationsLoadingRows = (count = 4) => (
    Array.from({ length: count }).map((_, index) => (
      <div key={`operations-loading-${index}`} className="flex items-center justify-between gap-4 border-b border-[rgba(148,163,184,0.12)] py-3 last:border-b-0">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--app-skeleton-base)]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--app-skeleton-muted)]" />
        </div>
        <div className="h-6 w-20 animate-pulse rounded-full bg-[var(--app-skeleton-muted)]" />
      </div>
    ))
  )

  const renderEmptyOperationsState = (message: string) => (
    <div className="flex min-h-[156px] items-center justify-center rounded-xl border border-dashed border-[rgba(148,163,184,0.2)] px-4 text-center text-sm text-[var(--color-text-tertiary)]">
      {message}
    </div>
  )

  const normalizeContacts = React.useCallback((contacts: ContactListItem[]) => (
    contacts.map(contact => ({
      ...contact,
      created_at: contact.created_at || (contact as any).createdAt || ''
    }))
  ), [])

  const fetchContactsForInsight = React.useCallback(async (
    type: ChartInsightContactType,
    from: string,
    to: string,
    scope: 'all' | 'attribution' | 'campaigns' = 'all'
  ) => {
    const reportsService = await loadReportsService()
    const result = await reportsService.getContactsList({ from, to, type, scope })
    return normalizeContacts(result.contacts)
  }, [normalizeContacts])

  const mapContactsToInsightItems = React.useCallback((
    contacts: ContactListItem[],
    context: 'lead' | 'appointment' | 'attendance' | 'payment' = 'lead'
  ): ChartInsightItem[] => {
    const getPrimaryDate = (contact: ContactListItem) => {
      if (context === 'payment') {
        const payment = [...(contact.payments ?? [])]
          .filter(paymentItem => isSuccessfulPaymentStatus(paymentItem.status) && !isTestPaymentRecord(paymentItem))
          .sort((a, b) => getTimeValue(b.date) - getTimeValue(a.date))[0]
        return payment?.date || getContactCreatedAt(contact)
      }

      if (context === 'appointment' || context === 'attendance') {
        const appointment = [...(contact.appointments ?? [])]
          .sort((a, b) => getTimeValue(b.start_time) - getTimeValue(a.start_time))[0]
        return appointment?.start_time || getContactCreatedAt(contact)
      }

      return getContactCreatedAt(contact)
    }

    return [...contacts]
      .sort((a, b) => getTimeValue(getPrimaryDate(b)) - getTimeValue(getPrimaryDate(a)))
      .map(contact => {
        const successfulPayments = [...(contact.payments ?? [])]
          .filter(payment => isSuccessfulPaymentStatus(payment.status) && !isTestPaymentRecord(payment))
          .sort((a, b) => getTimeValue(b.date) - getTimeValue(a.date))
        const primaryPayment = successfulPayments[0]
        const paymentTotal = successfulPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        const appointments = [...(contact.appointments ?? [])]
          .sort((a, b) => getTimeValue(b.start_time) - getTimeValue(a.start_time))
        const primaryAppointment = appointments[0]
        const contactValue = context === 'payment'
          ? paymentTotal || contact.ltv || contact.lifetimeLtv || 0
          : contact.ltv || contact.lifetimeLtv || 0
        const subtitle = contact.email || contact.phone || contact.source || contact.firstSession?.campaign_name || 'Sin datos de contacto'
        const meta = context === 'payment'
          ? primaryPayment
            ? `Pago ${formatDate(primaryPayment.date, { includeYear: true })}`
            : `Registro ${formatDate(getContactCreatedAt(contact), { includeYear: true })}`
          : (context === 'appointment' || context === 'attendance') && primaryAppointment
            ? formatLocalDateTime(primaryAppointment.start_time)
            : `Registro ${formatDate(getContactCreatedAt(contact), { includeYear: true })}`

        return {
          id: `contact-${contact.id}`,
          title: getContactName(contact),
          subtitle,
          meta,
          value: contactValue > 0 ? formatCurrency(contactValue) : undefined,
          status: context === 'payment'
            ? 'Pagó'
            : context === 'attendance'
              ? 'Asistió'
              : context === 'appointment'
                ? 'Citado'
                : contact.attributed
                  ? 'Anuncio'
                  : undefined
        }
      })
  }, [formatLocalDateTime])

  const mapVisitorsToInsightItems = React.useCallback((visitors: DashboardVisitorDetail[]): ChartInsightItem[] => (
    [...visitors]
      .sort((a, b) => getTimeValue(b.createdAt || b.firstVisit) - getTimeValue(a.createdAt || a.firstVisit))
      .map(visitor => {
        const contact = visitor.contact
        const source = visitor.utmCampaign || visitor.adName || visitor.utmSource || visitor.pageUrl || 'Sin fuente'
        const title = contact?.name || contact?.email || contact?.phone || `Visitante ${visitor.visitorId.slice(0, 8)}`
        const subtitle = contact?.email || contact?.phone || source
        const device = [visitor.deviceType, visitor.browser].filter(Boolean).join(' · ')

        return {
          id: `visitor-${visitor.visitorId}-${visitor.sessionId ?? 'session'}`,
          title,
          subtitle,
          meta: `${formatDate(visitor.createdAt || visitor.firstVisit, { includeYear: true })}${device ? ` · ${device}` : ''}`,
          value: contact?.ltv && contact.ltv > 0 ? formatCurrency(contact.ltv) : undefined,
          status: visitor.contactId ? 'Con contacto' : 'Visitante'
        }
      })
  ), [])

  const mapCampaignsToInsightItems = React.useCallback((campaigns: Campaign[]): ChartInsightItem[] => (
    campaigns
      .filter(campaign => Number(campaign.spend || 0) > 0)
      .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
      .map(campaign => ({
        id: `campaign-${campaign.id}`,
        title: campaign.name || 'Campaña sin nombre',
        subtitle: `${(campaign.clicks || 0).toLocaleString('es-MX')} clicks · ${(campaign.reach || 0).toLocaleString('es-MX')} alcance`,
        meta: `ROAS ${formatRoas(campaign.roas || 0)}`,
        value: formatCurrency(campaign.spend || 0),
        status: 'Gasto'
      }))
  ), [])

  const buildInsightColumn = React.useCallback((
    key: string,
    title: string,
    metricLabel: string,
    metricValue: string,
    emptyMessage: string,
    items: ChartInsightItem[]
  ): ChartInsightColumn => ({
    key,
    title,
    metricLabel,
    metricValue,
    emptyMessage,
    items
  }), [])

  const handleChartPointClick = React.useCallback(async (
    point: DashboardChartClickPoint,
    _index: number,
    _seriesKey: ChartSeriesKey
  ) => {
    const periodStart = point.periodStart
    const periodEnd = point.periodEnd

    if (!periodStart || !periodEnd) return

    const requestKey = `${selectedChartView}-${periodStart}-${periodEnd}-${Date.now()}`
    const metricValue1 = chartConfig.formatTooltipValue(point.value || 0)
    const metricValue2 = chartConfig.formatTooltipValue(point.value2 || 0)
    const modalTitle = `${activeChartLabel} · ${point.label}`

    setChartInsightModal({
      open: true,
      requestKey,
      title: modalTitle,
      subtitle: formatPeriodRange(periodStart, periodEnd),
      loading: true,
      columns: []
    })

    const commitColumns = (columns: ChartInsightColumn[]) => {
      setChartInsightModal(prev => (
        prev.requestKey === requestKey
          ? { ...prev, loading: false, columns }
          : prev
      ))
    }

    try {
      let columns: ChartInsightColumn[] = []

      if (selectedChartView === 'revenue-spend') {
        const [payingContacts, campaigns] = await Promise.all([
          fetchContactsForInsight('sales', periodStart, periodEnd, financialScope),
          loadCampaignsService().then(service => service.getCampaigns(periodStart, periodEnd))
        ])

        columns = [
          buildInsightColumn(
            'revenue',
            'Personas que pagaron',
            chartConfig.label1,
            metricValue1,
            'Sin pagos registrados en este periodo.',
            mapContactsToInsightItems(payingContacts, 'payment')
          ),
          buildInsightColumn(
            'spend',
            'Gastos de publicidad',
            chartConfig.label2,
            metricValue2,
            'Sin gasto publicitario en este periodo.',
            mapCampaignsToInsightItems(campaigns)
          )
        ]
      } else if (selectedChartView === 'visitors-leads') {
        const [visitors, leads] = await Promise.all([
          dashboardService.getVisitorsList({
            start: parseLocalDateString(periodStart.slice(0, 10)),
            end: new Date(periodEnd),
            scope: 'all',
            limit: 100
          }),
          fetchContactsForInsight('interesados', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'visitors',
            'Visitantes',
            chartConfig.label1,
            metricValue1,
            'Sin visitantes registrados en este periodo.',
            mapVisitorsToInsightItems(visitors)
          ),
          buildInsightColumn(
            'leads',
            labels.leads,
            chartConfig.label2,
            metricValue2,
            `Sin ${labels.leads.toLowerCase()} registrados en este periodo.`,
            mapContactsToInsightItems(leads, 'lead')
          )
        ]
      } else if (selectedChartView === 'leads-appointments') {
        const [leads, appointments] = await Promise.all([
          fetchContactsForInsight('interesados', periodStart, periodEnd),
          fetchContactsForInsight('appointments', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'leads',
            labels.leads,
            chartConfig.label1,
            metricValue1,
            `Sin ${labels.leads.toLowerCase()} registrados en este periodo.`,
            mapContactsToInsightItems(leads, 'lead')
          ),
          buildInsightColumn(
            'appointments',
            'Citados',
            chartConfig.label2,
            metricValue2,
            'Sin citas registradas en este periodo.',
            mapContactsToInsightItems(appointments, 'appointment')
          )
        ]
      } else if (selectedChartView === 'appointments-attendances') {
        const [appointments, attendances] = await Promise.all([
          fetchContactsForInsight('appointments', periodStart, periodEnd),
          fetchContactsForInsight('attendances', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'appointments',
            'Citados',
            chartConfig.label1,
            metricValue1,
            'Sin citas registradas en este periodo.',
            mapContactsToInsightItems(appointments, 'appointment')
          ),
          buildInsightColumn(
            'attendances',
            'Asistieron',
            chartConfig.label2,
            metricValue2,
            'Sin asistencias registradas en este periodo.',
            mapContactsToInsightItems(attendances, 'attendance')
          )
        ]
      } else if (selectedChartView === 'attendances-sales') {
        const [attendances, payingContacts] = await Promise.all([
          fetchContactsForInsight('attendances', periodStart, periodEnd),
          fetchContactsForInsight('sales', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'attendances',
            'Asistieron',
            chartConfig.label1,
            metricValue1,
            'Sin asistencias registradas en este periodo.',
            mapContactsToInsightItems(attendances, 'attendance')
          ),
          buildInsightColumn(
            'sales',
            `${labels.customers} que pagaron`,
            chartConfig.label2,
            metricValue2,
            `Sin ${labels.customers.toLowerCase()} con pago en este periodo.`,
            mapContactsToInsightItems(payingContacts, 'payment')
          )
        ]
      }

      commitColumns(columns)
    } catch {
      commitColumns([
        buildInsightColumn(
          'error',
          'Detalle del punto',
          'Estado',
          'Sin cargar',
          'No se pudo cargar el detalle de este punto.',
          []
        )
      ])
    }
  }, [
    activeChartLabel,
    buildInsightColumn,
    chartConfig,
    fetchContactsForInsight,
    financialScope,
    labels.leads,
    mapCampaignsToInsightItems,
    mapContactsToInsightItems,
    mapVisitorsToInsightItems,
    selectedChartView
  ])

  const renderInsightLoadingColumns = () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1].map(columnIndex => (
        <div key={`chart-insight-loading-${columnIndex}`} className="rounded-xl border border-[var(--app-skeleton-border)] bg-[var(--app-skeleton-card)]">
          <div className="border-b border-[var(--app-skeleton-border)] p-4">
            <div className="h-4 w-32 animate-pulse rounded bg-[var(--app-skeleton-base)]" />
            <div className="mt-3 h-7 w-24 animate-pulse rounded bg-[var(--app-skeleton-muted)]" />
          </div>
          <div className="p-4">
            {renderOperationsLoadingRows(5)}
          </div>
        </div>
      ))}
    </div>
  )

  const renderInsightItem = (item: ChartInsightItem) => (
    <div key={item.id} className="flex items-start justify-between gap-4 border-b border-[rgba(148,163,184,0.12)] py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="m-0 truncate text-sm font-medium text-[var(--color-text-primary)]">{item.title}</p>
        {item.subtitle && (
          <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">{item.subtitle}</p>
        )}
        {item.meta && (
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{item.meta}</p>
        )}
      </div>
      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
        {item.value && (
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{item.value}</span>
        )}
        {item.status && (
          <Badge variant="neutral">{item.status}</Badge>
        )}
      </div>
    </div>
  )

  if (!metrics && loading) {
    return <Loading message="Cargando dashboard..." page="dashboard" kpiLayout="joined" kpiCount={8} />
  }

  if (!metrics) {
    return (
      <PageContainer>
        <PageHeader
          title="Dashboard"
          subtitle="Resumen de ingresos, citas y rendimiento de tu negocio."
        />
        <Card variant="glass" className="p-4">
          <div role="alert" aria-live="assertive" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-display text-sm font-semibold text-[var(--text)]">El Dashboard no respondió</p>
              <p className="mt-1 text-sm text-[var(--text-mute)]">{metricsError || 'Intenta nuevamente.'}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setMetricsRetryKey(current => current + 1)}>
              Reintentar
            </Button>
          </div>
        </Card>
      </PageContainer>
    )
  }

  const metricsRefreshing = loading

  return (
    <>
      <PageContainer>
      <div data-ristak-dashboard className="flex flex-col" style={{ gap: 'var(--app-section-gap, 18px)' }}>
        {/* data-dashboard-topbar/-heading: hooks que usan los presets de diseño (index.css) */}
        <PageHeader
          data-dashboard-topbar
          data-dashboard-heading
          title="Dashboard"
          subtitle="Resumen de ingresos, citas y rendimiento de tu negocio."
          actions={(
            <DateRangePicker
              startDate={formatDateToISO(dateRange.start, { timezone })}
              endDate={formatDateToISO(dateRange.end, { timezone })}
              onChange={(start, end) => setDateRange({
                start: parseLocalDateString(start),
                end: parseLocalDateString(end),
                preset: 'custom'
              })}
            />
          )}
        />

        {metricsError && (
          <Card variant="glass" className="p-4">
            <div role="alert" aria-live="assertive" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-display text-sm font-semibold text-[var(--text)]">No se pudo actualizar el Dashboard</p>
                <p className="mt-1 text-sm text-[var(--text-mute)]">Conservamos el último resultado correcto. {metricsError}</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => setMetricsRetryKey(current => current + 1)}
              >
                {loading ? 'Reintentando…' : 'Reintentar'}
              </Button>
            </div>
          </Card>
        )}

        <div data-dashboard-kpi-grid className="grid grid-cols-2 gap-[var(--app-grid-gap,1rem)] sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            title="Ingresos Netos"
            value={formatCurrency(metrics.ingresosNetos.value)}
            delta={metrics.ingresosNetos.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<DollarSign className="w-5 h-5" />}
          />
          <KpiCard
            title="Gastos de Publicidad"
            value={formatCurrency(metrics.gastosPublicidad.value)}
            delta={metrics.gastosPublicidad.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<Megaphone className="w-5 h-5" />}
          />
          <KpiCard
            title="Ganancia Bruta"
            value={formatCurrency(metrics.gananciaBruta.value)}
            delta={metrics.gananciaBruta.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<TrendingUp className="w-5 h-5" />}
          />
          <KpiCard
            title="Retorno de Inversión"
            value={formatRoas(metrics.roas.value)}
            delta={metrics.roas.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<Target className="w-5 h-5" />}
          />
          <KpiCard
            title="Gastos negocio"
            value={formatCurrency(metrics.totalCostos.value)}
            delta={metrics.totalCostos.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<Receipt className="w-5 h-5" />}
          />
          <KpiCard
            title="Ganancia Neta"
            value={formatCurrency(metrics.gananciaNeta.value)}
            delta={metrics.gananciaNeta.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<Wallet className="w-5 h-5" />}
          />
          <KpiCard
            title="Reembolsos"
            value={formatCurrency(metrics.reembolsos.value)}
            delta={metrics.reembolsos.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<RotateCcw className="w-5 h-5" />}
          />
          <KpiCard
            title="Pagos totales promedio"
            value={formatCurrency(metrics.ltvPromedio.value)}
            delta={metrics.ltvPromedio.variation}
            deltaLabel="vs periodo anterior"
            loading={metricsRefreshing}
            icon={<Users className="w-5 h-5" />}
          />
        </div>

        <Card data-dashboard-chart-card variant="glass" className="space-y-[var(--app-card-content-gap,1rem)]">
          <div className="flex flex-col gap-[var(--app-card-content-gap,1rem)] xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-3 xl:flex-row xl:items-center xl:gap-[var(--app-grid-gap,1rem)]">
              <h2 className="m-0 text-lg font-semibold text-[var(--color-text-primary)] sm:whitespace-nowrap">
                {activeChartLabel}
              </h2>
              <div data-dashboard-chart-controls className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-[var(--app-grid-gap,1rem)]">
                <ViewSelector
                  className="dashboard-chart-period-selector"
                  options={chartPeriodOptions}
                  value={selectedChartPeriodValue}
                  onChange={handleChartPeriodChange}
                />
                <ViewSelector
                  className="dashboard-chart-view-selector"
                  options={chartViewOptions}
                  value={selectedChartView}
                  onChange={(value) => {
                    if (isDashboardChartView(value)) {
                      setSelectedChartView(value)
                      navigate({ pathname: buildDashboardChartPath(value), search: location.search })
                    }
                  }}
                />
                <div className="flex flex-wrap items-center gap-[var(--app-legend-gap,1rem)] px-2 text-xs text-[var(--color-text-secondary)]">
                  {chartLegendItems.map((item) => (
                    <div key={item.key} className="inline-flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="font-medium">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {selectedChartView === 'revenue-spend' && (
              <TabList
                className="shrink-0 self-start xl:ml-auto xl:self-center"
                tabs={financialScopeOptions.map(({ value, label, icon: Icon, description }) => ({
                  value,
                  label,
                  icon: <Icon size={13} />,
                  description
                }))}
                activeTab={financialScope}
                onTabChange={(value) => setFinancialScope(value as typeof financialScope)}
              />
            )}
          </div>
          <div className="relative w-full" style={{ minHeight: chartHeight, height: chartHeight }}>
            {isChartLoading ? (
              <div data-ristak-chart-empty className="flex h-full items-end justify-between gap-3 rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] p-5" role="status" aria-live="polite" aria-label="Cargando datos del gráfico">
                {[44, 68, 52, 82, 60, 74, 58].map((height, index) => (
                  <span
                    key={`dashboard-chart-skeleton-${index}`}
                    className="min-w-0 flex-1 animate-pulse rounded-t-lg bg-[var(--app-skeleton-base)]"
                    style={{ height: `${height}%` }}
                    aria-hidden="true"
                  />
                ))}
              </div>
            ) : extendedChartDataError && selectedChartView !== 'revenue-spend' ? (
              <div data-ristak-chart-empty role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-[var(--color-text-tertiary)]">
                <span>No se pudo cargar esta gráfica. {extendedChartDataError}</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => setExtendedChartDataError(null)}>
                  Reintentar
                </Button>
              </div>
            ) : hasChartData ? (
              <AreaChart
                data={chartConfig.data}
                height={chartHeight}
                showGrid
                color={chartConfig.color}
                color2={chartConfig.color2}
                formatValue={chartConfig.formatValue}
                formatTooltipValue={chartConfig.formatTooltipValue}
                legendLabels={{ label1: chartConfig.label1, label2: chartConfig.label2 }}
                onPointClick={handleChartPointClick}
              />
            ) : (
              <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Sin datos disponibles
              </div>
            )}
          </div>
        </Card>

        <div className={chartsGridClass}>
          <ConversionFunnelChart
            data={funnelChartData}
            loading={false}
            showVisitors={showFunnelVisitors}
            scope={funnelScope}
            onScopeChange={setFunnelScope}
            onStageClick={handleFunnelStageClick}
            onVisitorsVisibilityChange={analyticsEnabled ? handleFunnelVisitorsVisibilityChange : undefined}
            visitorsVisibilityLoading={savingFunnelVisitorsConfig}
          />
          {showTrafficSourcesChart && (
            <OriginDistributionCard />
          )}
        </div>

        <section data-dashboard-operations className="grid gap-[var(--app-grid-gap,1rem)] xl:grid-cols-3">
          <Card variant="glass" className="flex min-h-[var(--dashboard-operation-card-min-height,320px)] flex-col gap-[var(--app-card-content-gap,1rem)]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <Banknote className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Pagos</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Últimos pagos</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Movimientos del rango activo</p>
              </div>
              <Link
                to="/transactions"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentTransactions.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentTransactions.map((transaction) => {
                    const desc = getTransactionStatusBadge(transaction.status)
                    return (
                    <div key={transaction.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
                          {transaction.contactName || transaction.email || `${labels.customer} sin nombre`}
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                          {formatDate(getTransactionDate(transaction), { includeYear: true })}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                          {formatCurrency(transaction.amount)}
                        </span>
                        <Badge variant={desc.variant}>{desc.label}</Badge>
                      </div>
                    </div>
                    )
                  })}
                </div>
              ) : (
                renderEmptyOperationsState('Sin pagos registrados en este rango.')
              )}
            </div>
          </Card>

          <Card variant="glass" className="flex min-h-[var(--dashboard-operation-card-min-height,320px)] flex-col gap-[var(--app-card-content-gap,1rem)]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <CalendarClock className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Citas</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Últimas citas</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Eventos del rango activo</p>
              </div>
              <Link
                to="/appointments"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentAppointments.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentAppointments.map((appointment) => {
                    const desc = getAppointmentStatusBadge(appointment.appointmentStatus)
                    return (
                    <div key={appointment.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
                          {getAppointmentTitle(appointment)}
                        </p>
                        <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatLocalDateTime(appointment.startTime)}
                        </p>
                      </div>
                      <Badge variant={desc.variant}>{desc.label}</Badge>
                    </div>
                    )
                  })}
                </div>
              ) : (
                renderEmptyOperationsState(locationId ? 'No hay citas en el rango activo.' : 'No hay citas recientes en Ristak.')
              )}
            </div>
          </Card>

          <Card variant="glass" className="flex min-h-[var(--dashboard-operation-card-min-height,320px)] flex-col gap-[var(--app-card-content-gap,1rem)]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <UserPlus className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Contactos</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Nuevos contactos</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Registros recientes del rango activo</p>
              </div>
              <Link
                to="/contacts"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentContacts.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentContacts.map((contact) => (
                    <div key={contact.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
                          {getContactName(contact)}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">
                          {contact.email || contact.phone || 'Sin datos de contacto'}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                        <span className="text-xs text-[var(--color-text-tertiary)]">
                          {formatDate(getContactCreatedAt(contact), { includeYear: true })}
                        </span>
                        {contact.ltv > 0 && (
                          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                            {formatCurrency(contact.ltv)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                renderEmptyOperationsState('Sin contactos nuevos en este rango.')
              )}
            </div>
          </Card>
        </section>
        </div>
        </PageContainer>

        <Modal
          isOpen={chartInsightModal.open}
          onClose={() => setChartInsightModal(emptyChartInsightModal)}
          title={chartInsightModal.title}
          size="xl"
          type="custom"
          flushContent
        >
          <div className="space-y-5 p-6" data-modal-panel="">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="m-0 text-sm text-[var(--color-text-secondary)]">{chartInsightModal.subtitle}</p>
              {!chartInsightModal.loading && chartInsightModal.columns.length > 0 && (
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  {chartInsightModal.columns.reduce((total, column) => total + column.items.length, 0).toLocaleString('es-MX')} registros
                </span>
              )}
            </div>

            {chartInsightModal.loading ? renderInsightLoadingColumns() : chartInsightModal.columns.length > 0 ? (
              <div className={`grid gap-4 ${chartInsightModal.columns.length > 1 ? 'lg:grid-cols-2' : ''}`}>
                {chartInsightModal.columns.map(column => (
                  <div key={column.key} className="min-w-0 rounded-xl border border-[rgba(148,163,184,0.18)]">
                    <div className="flex items-start justify-between gap-4 border-b border-[rgba(148,163,184,0.14)] p-4">
                      <div className="min-w-0">
                        <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                          {column.metricLabel}
                        </p>
                        <h3 className="mt-1 truncate text-base font-semibold text-[var(--color-text-primary)]">
                          {column.title}
                        </h3>
                      </div>
                      <span className="flex-shrink-0 text-lg font-semibold text-[var(--color-text-primary)]">
                        {column.metricValue}
                      </span>
                    </div>
                    <div className="max-h-[52vh] overflow-y-auto px-4">
                      {column.items.length > 0 ? (
                        column.items.map(renderInsightItem)
                      ) : (
                        <div className="flex min-h-[180px] items-center justify-center px-4 text-center text-sm text-[var(--color-text-tertiary)]">
                          {column.emptyMessage}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-[rgba(148,163,184,0.2)] px-4 text-center text-sm text-[var(--color-text-tertiary)]">
                Sin detalles disponibles para este punto.
              </div>
            )}
          </div>
        </Modal>

        {contactModalOpen && (
          <React.Suspense
            fallback={(
              <DetailsModalLoadingFallback
                title={contactModalTitle}
                subtitle={contactModalSubtitle}
                onClose={closeContactModal}
              />
            )}
          >
            <LazyContactDetailsModal
              isOpen
              onClose={closeContactModal}
              title={contactModalTitle}
              subtitle={contactModalSubtitle}
              data={contactModalContacts}
              loading={contactModalLoading}
              type={contactModalType}
            />
          </React.Suspense>
        )}

      {visitorsModalOpen && (
        <React.Suspense
          fallback={(
            <DetailsModalLoadingFallback
              title={visitorsModalTitle}
              subtitle={visitorsModalSubtitle}
              onClose={closeVisitorsModal}
            />
          )}
        >
          <LazyVisitorDetailsModal
            isOpen
            onClose={closeVisitorsModal}
            title={visitorsModalTitle}
            subtitle={[visitorsModalSubtitle, visitorsModalPage.coverageNotice].filter(Boolean).join(' · ')}
            data={visitorsModalData}
            loading={visitorsModalLoading}
            currentPage={visitorsModalPage.page}
            hasNextPage={visitorsModalPage.hasNext}
            hasPreviousPage={visitorsModalPage.page > 1}
            onPageChange={handleVisitorsModalPageChange}
            onSearchChange={handleVisitorsModalSearch}
          />
        </React.Suspense>
      )}
    </>
  )
}
