import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  DollarSign,
  Loader2,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  WalletCards,
  type LucideIcon
} from 'lucide-react'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAccountCurrency, usePhoneElasticScroll } from '@/hooks'
import {
  dashboardService,
  type DashboardMetrics,
  type DashboardMobileAnalyticsSnapshot,
  type OriginDistributionData,
  type SourceDatum,
  type WhatsAppNumberOriginDatum
} from '@/services/dashboardService'
import type { WhatsAppApiPhoneNumber } from '@/services/whatsappApiService'
import { formatCurrency, formatDate, formatDateToISO, formatNumber, formatRoas } from '@/utils/format'
import { hasWebAnalyticsAccess as canAccessWebAnalytics } from '@/utils/accessControl'
import { dateOnlyToLocalDate, todayDateOnlyInTimezone } from '@/utils/timezone'
import { getPhoneDailyCacheKey, removePhoneDailyCacheGroup } from '@/services/phoneDailyCache'
import { getApiBaseUrl } from '@/services/apiBaseUrl'
import { getSavedAnalyticsSections, refreshPeriodReading, savePeriodReading } from './periodCache'
import styles from './PhoneAnalytics.module.css'

type AnalyticsPeriod = '30d' | '60d' | '180d' | 'year'
type ChartView = 'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-attendances' | 'attendances-sales'
type ScopeType = 'all' | 'attribution' | 'campaigns'
type OriginTab = 'traffic' | 'leads' | 'appointments' | 'conversions'

interface ChartPoint {
  label: string
  value: number
  value2: number
}

interface ChartMeta {
  label1: string
  label2: string
  color1: string
  color2: string
  currency: boolean
}

interface MetricCardConfig {
  key: keyof DashboardMetrics
  title: string
  Icon: LucideIcon
  tone: 'green' | 'black' | 'blue' | 'gold' | 'red'
  formatter: (value: number) => string
}

interface PhoneNumberOriginRow {
  key: string
  name: string
  phone: string
  value: number
  statusLabel: string
}

const PERIOD_OPTIONS: Array<{ id: AnalyticsPeriod; label: string; menuLabel: string; days: number }> = [
  { id: '30d', label: '30 días', menuLabel: 'Últimos 30 días', days: 30 },
  { id: '60d', label: '60 días', menuLabel: 'Últimos 60 días', days: 60 },
  { id: '180d', label: '180 días', menuLabel: 'Últimos 180 días', days: 180 },
  { id: 'year', label: 'Año', menuLabel: 'Último año', days: 365 }
]

const SCOPE_OPTIONS: Array<{ id: ScopeType; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'attribution', label: 'Al registro' },
  { id: 'campaigns', label: 'Anuncios' }
]

const EMPTY_ORIGIN_DATA: OriginDistributionData = {
  traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
  leads: [],
  appointments: [],
  conversions: [],
  whatsappNumbers: []
}

const shortNumberFormatter = new Intl.NumberFormat('es-MX', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1
})

function getAnalyticsRange(period: AnalyticsPeriod, day: string) {
  const option = PERIOD_OPTIONS.find((item) => item.id === period) || PERIOD_OPTIONS[0]
  const businessToday = dateOnlyToLocalDate(day) || new Date()
  const end = new Date(businessToday)
  const start = new Date(businessToday)

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)

  if (option.days > 0) {
    start.setDate(start.getDate() - (option.days - 1))
  }

  return { start, end }
}

function getGroupBy(period: AnalyticsPeriod): 'day' | 'month' {
  return period === '180d' || period === 'year' ? 'month' : 'day'
}

function combineSeries(first: Array<{ label: string; value: number }>, second: Array<{ label: string; value: number }>): ChartPoint[] {
  const firstMap = new Map(first.map((item) => [item.label, Number(item.value) || 0]))
  const secondMap = new Map(second.map((item) => [item.label, Number(item.value) || 0]))
  const labels = Array.from(new Set([...firstMap.keys(), ...secondMap.keys()])).sort()

  return labels.map((label) => ({
    label,
    value: firstMap.get(label) || 0,
    value2: secondMap.get(label) || 0
  }))
}

function formatShortDateLabel(label: string, timezone: string) {
  return formatDate(label, {
    timezone,
    padDay: false,
    fallback: label
  })
}

function formatCompactValue(value: number, currency: boolean, accountCurrency: string) {
  if (!currency) return shortNumberFormatter.format(value || 0)
  return new Intl.NumberFormat('es-MX', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    style: 'currency',
    currency: accountCurrency
  }).format(value || 0)
}

function getVariationLabel(value: number) {
  const rounded = Math.abs(value || 0).toFixed(1)
  if (value > 0) return `+${rounded}%`
  if (value < 0) return `-${rounded}%`
  return '0%'
}

function normalizePhone(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

function getPhoneStatusLabel(phone?: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  const qrConnected = phone?.qr_status === 'connected' || phone?.qr_send_enabled || row?.qrSendEnabled
  const apiActive = phone?.api_send_enabled || row?.apiSendEnabled

  if (qrConnected && apiActive) return 'API y web'
  if (qrConnected) return 'Web activo'
  if (apiActive) return 'API activa'
  return 'Detectado'
}

function getPhoneName(phone: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  return phone.label || phone.verified_name || row?.name || phone.display_phone_number || phone.phone_number || 'Número'
}

function getPhoneDisplay(phone: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  return phone.display_phone_number || phone.phone_number || row?.displayPhoneNumber || row?.phoneNumber || ''
}

function buildPhoneNumberRows(
  apiRows: WhatsAppNumberOriginDatum[],
  detectedPhones: WhatsAppApiPhoneNumber[]
): PhoneNumberOriginRow[] {
  const usedApiRows = new Set<number>()
  const rows: PhoneNumberOriginRow[] = []

  detectedPhones.forEach((phone) => {
    const phoneId = phone.id || ''
    const phoneDigits = normalizePhone(phone.phone_number || phone.display_phone_number || phone.qr_connected_phone)
    const matchedIndex = apiRows.findIndex((row, index) => {
      if (usedApiRows.has(index)) return false
      const rowDigits = normalizePhone(row.phoneNumber || row.displayPhoneNumber)
      return (phoneId && row.phoneNumberId === phoneId) || (phoneDigits && rowDigits && phoneDigits === rowDigits)
    })
    const matchedRow = matchedIndex >= 0 ? apiRows[matchedIndex] : undefined

    if (matchedIndex >= 0) {
      usedApiRows.add(matchedIndex)
    }

    rows.push({
      key: phone.id || phone.phone_number || phone.display_phone_number || `phone-${rows.length}`,
      name: getPhoneName(phone, matchedRow),
      phone: getPhoneDisplay(phone, matchedRow),
      value: matchedRow?.value || 0,
      statusLabel: getPhoneStatusLabel(phone, matchedRow)
    })
  })

  apiRows.forEach((row, index) => {
    if (usedApiRows.has(index)) return

    rows.push({
      key: row.phoneNumberId || row.phoneNumber || row.displayPhoneNumber || `origin-${index}`,
      name: row.name,
      phone: row.displayPhoneNumber || row.phoneNumber || '',
      value: row.value || 0,
      statusLabel: getPhoneStatusLabel(undefined, row)
    })
  })

  return rows
}

function MobileDualLineChart({
  accountCurrency,
  data,
  meta,
  timezone
}: {
  accountCurrency: string
  data: ChartPoint[]
  meta: ChartMeta
  timezone: string
}) {
  const width = 320
  const height = 176
  const padding = { top: 18, right: 14, bottom: 28, left: 14 }
  const maxValue = Math.max(1, ...data.flatMap((item) => [item.value || 0, item.value2 || 0]))
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const buildPoints = (key: 'value' | 'value2') => data.map((point, index) => {
    const x = data.length <= 1
      ? width / 2
      : padding.left + (index / (data.length - 1)) * plotWidth
    const y = padding.top + plotHeight - ((point[key] || 0) / maxValue) * plotHeight

    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')

  const labelIndexes = Array.from(new Set([
    0,
    Math.floor((data.length - 1) / 2),
    data.length - 1
  ])).filter((index) => index >= 0)

  return (
    <div className={styles.chartCanvas}>
      <div className={styles.chartTopScale}>{formatCompactValue(maxValue, meta.currency, accountCurrency)}</div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${meta.label1} y ${meta.label2}`}>
        {[0.25, 0.5, 0.75].map((step) => {
          const y = padding.top + plotHeight * step
          return <line key={step} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className={styles.gridLine} />
        })}
        <polyline points={buildPoints('value')} fill="none" stroke={meta.color1} strokeWidth="var(--phone-analytics-chart-stroke)" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <polyline points={buildPoints('value2')} fill="none" stroke={meta.color2} strokeWidth="var(--phone-analytics-chart-stroke)" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {data.map((point, index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth
          const y1 = padding.top + plotHeight - ((point.value || 0) / maxValue) * plotHeight
          const y2 = padding.top + plotHeight - ((point.value2 || 0) / maxValue) * plotHeight

          return (
            <g key={`${point.label}-${index}`}>
              <circle cx={x} cy={y1} r="var(--phone-analytics-chart-point)" fill={meta.color1} />
              <circle cx={x} cy={y2} r="var(--phone-analytics-chart-point)" fill={meta.color2} />
            </g>
          )
        })}
        {labelIndexes.map((index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth

          return (
            <text key={index} x={x} y={height - 6} textAnchor="middle" className={styles.axisLabel}>
              {formatShortDateLabel(data[index]?.label || '', timezone)}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

export const PhoneAnalytics: React.FC = () => {
  const { user, locationId } = useAuth()
  const { timezone } = useTimezone()
  const [currency] = useAccountCurrency()
  const scope = getPhoneDailyCacheKey('analytics', getApiBaseUrl(), locationId, user?.id, timezone, currency, canAccessWebAnalytics(user))
  return (
    <PhoneAnalyticsContent
      key={scope}
      scope={scope}
      timezone={timezone}
      accountCurrency={currency}
      hasWebAnalyticsAccess={canAccessWebAnalytics(user)}
    />
  )
}

const PhoneAnalyticsContent: React.FC<{
  scope: string
  timezone: string
  accountCurrency: string
  hasWebAnalyticsAccess: boolean
}> = ({ scope, timezone, accountCurrency, hasWebAnalyticsAccess }) => {
  const { labels } = useLabels()
  usePhoneElasticScroll()

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false)
  const [chartView, setChartView] = useState<ChartView>('revenue-spend')
  const [financialScope, setFinancialScope] = useState<ScopeType>('all')
  const [funnelScope, setFunnelScope] = useState<ScopeType>('all')
  const [originTab, setOriginTab] = useState<OriginTab>(hasWebAnalyticsAccess ? 'traffic' : 'leads')
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [funnelData, setFunnelData] = useState<Array<{ stage: string; value: number }>>([])
  const [originData, setOriginData] = useState(EMPTY_ORIGIN_DATA)
  const [detectedPhones, setDetectedPhones] = useState<WhatsAppApiPhoneNumber[]>([])
  const [loading, setLoading] = useState(true)
  const [chartLoading, setChartLoading] = useState(true)
  const [funnelLoading, setFunnelLoading] = useState(true)
  const [originLoading, setOriginLoading] = useState(true)
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  const [summaryThrough, setSummaryThrough] = useState('')
  const [chartThrough, setChartThrough] = useState('')
  const [funnelThrough, setFunnelThrough] = useState('')
  const [numbersThrough, setNumbersThrough] = useState('')
  const [originPanelVisible, setOriginPanelVisible] = useState(false)

  const [day, setDay] = useState(() => todayDateOnlyInTimezone(timezone))
  useEffect(() => {
    const updateDay = () => setDay(todayDateOnlyInTimezone(timezone))
    document.addEventListener('visibilitychange', updateDay)
    const timer = window.setInterval(updateDay, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', updateDay)
      window.clearInterval(timer)
    }
  }, [timezone])
  const range = useMemo(() => getAnalyticsRange(period, day), [period, day])
  const [denied, setDenied] = useState(false)
  const [chartDenied, setChartDenied] = useState(false)
  const [funnelDenied, setFunnelDenied] = useState(false)
  const groupBy = useMemo(() => getGroupBy(period), [period])
  const rangeKey = useMemo(() => `${formatDateToISO(range.start)}:${formatDateToISO(range.end)}:${hasWebAnalyticsAccess ? 1 : 0}`, [hasWebAnalyticsAccess, range.end, range.start])
  const periodQuery = useMemo(() => ({ scope, period, rangeKey, through: day, timezone }), [scope, period, rangeKey, day, timezone])
  const activePeriod = PERIOD_OPTIONS.find((option) => option.id === period) || PERIOD_OPTIONS[0]
  const snapshotRequestIdRef = useRef(0)
  const snapshotReadyRangeRef = useRef('')
  const phoneOriginRangeRef = useRef('')
  const phoneOriginRequestIdRef = useRef(0)
  const mobileSnapshotRef = useRef<{ data: DashboardMobileAnalyticsSnapshot; through: string } | null>(null)
  const funnelScopeRef = useRef(funnelScope)
  const financialScopeRef = useRef(financialScope)
  const chartViewRef = useRef(chartView)
  const originPanelRef = useRef<HTMLElement | null>(null)
  funnelScopeRef.current = funnelScope
  financialScopeRef.current = financialScope
  chartViewRef.current = chartView

  useEffect(() => {
    document.title = 'Analíticas móviles | Ristak'
  }, [])

  useEffect(() => {
    const panel = originPanelRef.current
    if (!panel) return
    if (typeof IntersectionObserver === 'undefined') {
      setOriginPanelVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setOriginPanelVisible(true)
      observer.disconnect()
    }, { threshold: 0.1 })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [denied])

  useEffect(() => {
    if (!hasWebAnalyticsAccess && chartView === 'visitors-leads') {
      setChartView('leads-appointments')
    }
  }, [chartView, hasWebAnalyticsAccess])

  useEffect(() => {
    if (!hasWebAnalyticsAccess && originTab === 'traffic') {
      setOriginTab('leads')
    }
  }, [hasWebAnalyticsAccess, originTab])

  useEffect(() => {
    const requestId = ++snapshotRequestIdRef.current
    const requestedFunnelScope = funnelScopeRef.current
    const requestedFinancialScope = financialScopeRef.current
    const snapshotParams = {
      start: range.start,
      end: range.end,
      includeWeb: hasWebAnalyticsAccess,
      funnelScope: requestedFunnelScope,
      financialScope: requestedFinancialScope,
      includePhoneBreakdown: false
    }
    const applySnapshot = (snapshot: DashboardMobileAnalyticsSnapshot, through: string, live: boolean) => {
      if (requestId !== snapshotRequestIdRef.current) return
      setSummaryThrough(through)
      setDenied(false)
      const becameReady = snapshotReadyRangeRef.current !== rangeKey
      const previousScopes = mobileSnapshotRef.current?.data.scopes
      const scopesChanged = previousScopes?.financial !== snapshot.scopes.financial || previousScopes?.funnel !== snapshot.scopes.funnel
      const financialChart = snapshot.financialChart.map(item => ({
        label: item.label, value: item.value || 0, value2: item.value2 || 0
      }))
      if (live) {
        // Los indicadores y el origen son comunes al periodo. Cada serie conserva
        // la atribución con la que se obtuvo, también cuando llegó en el resumen.
        savePeriodReading(periodQuery, ['funnel', snapshot.scopes.funnel], { data: snapshot.funnel, through })
        savePeriodReading(periodQuery, ['chart', 'revenue-spend', snapshot.scopes.financial, groupBy], { data: financialChart, through })
      }
      const snapshotPhoneNumbers = snapshot.origin?.whatsappNumbers || []
      mobileSnapshotRef.current = { data: snapshot, through }
      snapshotReadyRangeRef.current = rangeKey
      setMetrics(snapshot.metrics)
      setOriginData(current => ({
        ...EMPTY_ORIGIN_DATA,
        ...snapshot.origin,
        traffic: {
          ...EMPTY_ORIGIN_DATA.traffic,
          ...(snapshot.origin?.traffic || {})
        },
        // El snapshot inicial omite este desglose. Una revalidación tardía no
        // debe borrar la carga secundaria que ya terminó para el mismo rango.
        whatsappNumbers: snapshotPhoneNumbers.length > 0
          ? snapshotPhoneNumbers
          : (phoneOriginRangeRef.current === rangeKey ? current.whatsappNumbers : [])
      }))
      setDetectedPhones((snapshot.whatsappPhoneNumbers || []).filter((phone) => (
        Boolean(phone.id || phone.phone_number || phone.display_phone_number || phone.qr_connected_phone)
      )))

      if (funnelScopeRef.current === snapshot.scopes.funnel) {
        setFunnelData(snapshot.funnel)
        setFunnelThrough(through)
        setFunnelLoading(false)
      }
      if (
        chartViewRef.current === 'revenue-spend' &&
        financialScopeRef.current === snapshot.scopes.financial
      ) {
        setChartData(financialChart)
        setChartThrough(through)
        setChartLoading(false)
      }
      setLoading(false)
      setOriginLoading(false)
      if (becameReady || scopesChanged) setSnapshotVersion(version => version + 1)
    }

    mobileSnapshotRef.current = null
    snapshotReadyRangeRef.current = ''
    phoneOriginRangeRef.current = ''
    setSummaryThrough('')
    setFunnelThrough('')
    setChartThrough('')
    setNumbersThrough('')
    setLoading(true)
    setOriginLoading(true)
    setFunnelLoading(true)
    setChartLoading(true)
    setDetectedPhones([])
    setDenied(false)
    return refreshPeriodReading(periodQuery, ['summary'], {
      legacyFilters: [requestedFunnelScope, requestedFinancialScope],
      isCurrent: () => requestId === snapshotRequestIdRef.current,
      read: signal => dashboardService.getMobileAnalyticsSnapshot(snapshotParams, { signal, forceRefresh: true }),
      apply: applySnapshot,
      denied: () => {
        removePhoneDailyCacheGroup(getPhoneDailyCacheKey(scope))
        mobileSnapshotRef.current = null
        snapshotReadyRangeRef.current = ''
        setSnapshotVersion(version => version + 1)
        setDenied(true)
      }
    })
  }, [periodQuery, scope, groupBy, hasWebAnalyticsAccess, range.end, range.start, rangeKey])

  useEffect(() => {
    if (!originPanelVisible || snapshotReadyRangeRef.current !== rangeKey) return
    const requestId = ++phoneOriginRequestIdRef.current
    return refreshPeriodReading(periodQuery, ['numbers'], {
      isCurrent: () => requestId === phoneOriginRequestIdRef.current && snapshotReadyRangeRef.current === rangeKey,
      read: async signal => (await dashboardService.getOriginDistribution({
        start: range.start, end: range.end, includeWeb: false, includeWhatsapp: false,
        dimension: 'sources', includeBreakdowns: false, includePhoneBreakdown: true, signal
      })).whatsappNumbers || [],
      apply: (numbers, through) => {
        setNumbersThrough(through)
        phoneOriginRangeRef.current = rangeKey
        setOriginData(current => ({ ...current, whatsappNumbers: numbers }))
      },
      denied: () => {
        setNumbersThrough('')
        phoneOriginRangeRef.current = ''
        setOriginData(current => ({ ...current, whatsappNumbers: [] }))
      }
    })
  }, [periodQuery, originPanelVisible, range.end, range.start, rangeKey, snapshotVersion])

  useEffect(() => {
    if (snapshotReadyRangeRef.current !== rangeKey) return
    setFunnelDenied(false)
    const snapshot = mobileSnapshotRef.current
    if (snapshot?.data.scopes.funnel === funnelScope) {
      setFunnelData(snapshot.data.funnel)
      setFunnelThrough(snapshot.through)
      setFunnelLoading(false)
      return
    }

    setFunnelLoading(true)
    return refreshPeriodReading(periodQuery, ['funnel', funnelScope], {
      isCurrent: () => snapshotReadyRangeRef.current === rangeKey && funnelScopeRef.current === funnelScope
        && mobileSnapshotRef.current?.data.scopes.funnel !== funnelScope,
      read: signal => dashboardService.getFunnelData(
        { start: range.start, end: range.end, scope: funnelScope, includeWeb: hasWebAnalyticsAccess }, signal
      ),
      apply: (data, through) => {
        setFunnelThrough(through)
        setFunnelData(data)
        setFunnelLoading(false)
        setFunnelDenied(false)
      },
      denied: () => {
        setFunnelThrough('')
        setFunnelData([])
        setFunnelDenied(true)
      }
    })
  }, [periodQuery, funnelScope, hasWebAnalyticsAccess, range.end, range.start, rangeKey, snapshotVersion])

  useEffect(() => {
    if (snapshotReadyRangeRef.current !== rangeKey) return
    setChartDenied(false)
    const snapshot = mobileSnapshotRef.current
    if (chartView === 'revenue-spend' && snapshot?.data.scopes.financial === financialScope) {
      setChartThrough(snapshot.through)
      setChartData(snapshot.data.financialChart.map(item => ({
        label: item.label,
        value: item.value || 0,
        value2: item.value2 || 0
      })))
      setChartLoading(false)
      return
    }

    setChartLoading(true)
    const loadChart = async (signal: AbortSignal): Promise<ChartPoint[]> => {
      if (chartView === 'revenue-spend') {
        const response = await dashboardService.getFinancialChart({
          start: range.start,
          end: range.end,
          scope: financialScope
        }, signal)

        return response.map((item) => ({
          label: item.date,
          value: item.ingresos || 0,
          value2: item.gastado || 0
        }))
      }

      const commonParams = { start: range.start, end: range.end, groupBy, signal }
      let response: ChartPoint[] = []

      if (chartView === 'visitors-leads') {
        if (!hasWebAnalyticsAccess) {
          response = []
        } else {
          const [visitors, leads] = await Promise.all([
            dashboardService.getVisitorsData(commonParams),
            dashboardService.getLeadsData(commonParams)
          ])
          response = combineSeries(visitors, leads)
        }
      } else if (chartView === 'leads-appointments') {
        const [leads, appointments] = await Promise.all([
          dashboardService.getLeadsData(commonParams),
          dashboardService.getAppointmentsData(commonParams)
        ])
        response = combineSeries(leads, appointments)
      } else if (chartView === 'appointments-attendances') {
        const [appointments, attendances] = await Promise.all([
          dashboardService.getAppointmentsData(commonParams),
          dashboardService.getAttendancesData(commonParams)
        ])
        response = combineSeries(appointments, attendances)
      } else {
        const [attendances, sales] = await Promise.all([
          dashboardService.getAttendancesData(commonParams),
          dashboardService.getSalesData(commonParams)
        ])
        response = combineSeries(attendances, sales)
      }
      return response
    }

    return refreshPeriodReading(periodQuery, ['chart', chartView, financialScope, groupBy], {
      isCurrent: () => snapshotReadyRangeRef.current === rangeKey && chartViewRef.current === chartView && financialScopeRef.current === financialScope
        && !(chartView === 'revenue-spend' && mobileSnapshotRef.current?.data.scopes.financial === financialScope),
      read: loadChart,
      apply: (data, through) => {
        setChartThrough(through)
        setChartData(data)
        setChartLoading(false)
        setChartDenied(false)
      },
      denied: () => {
        setChartThrough('')
        setChartData([])
        setChartDenied(true)
      }
    })
  }, [periodQuery, chartView, financialScope, groupBy, hasWebAnalyticsAccess, range.end, range.start, rangeKey, snapshotVersion])

  const chartOptions = useMemo<Array<{ id: ChartView; label: string }>>(() => {
    const options: Array<{ id: ChartView; label: string }> = [
      { id: 'revenue-spend', label: 'Ingresos vs gastos' }
    ]

    if (hasWebAnalyticsAccess) {
      options.push({ id: 'visitors-leads', label: `Visitantes vs ${labels.leads}` })
    }

    options.push(
      { id: 'leads-appointments', label: `${labels.leads} vs citas` },
      { id: 'appointments-attendances', label: 'Citas vs asistencias' },
      { id: 'attendances-sales', label: 'Asistencias vs ventas' }
    )

    return options
  }, [hasWebAnalyticsAccess, labels.leads])

  const chartMeta = useMemo<ChartMeta>(() => {
    if (chartView === 'visitors-leads') {
      return { label1: 'Visitantes', label2: labels.leads, color1: 'var(--phone-analytics-blue-line)', color2: 'var(--phone-analytics-accent)', currency: false }
    }

    if (chartView === 'leads-appointments') {
      return { label1: labels.leads, label2: 'Citas', color1: 'var(--phone-analytics-accent)', color2: 'var(--phone-analytics-warning-line)', currency: false }
    }

    if (chartView === 'appointments-attendances') {
      return { label1: 'Citas', label2: 'Asistencias', color1: 'var(--phone-analytics-warning-line)', color2: 'var(--phone-analytics-blue-line)', currency: false }
    }

    if (chartView === 'attendances-sales') {
      return { label1: 'Asistencias', label2: 'Ventas', color1: 'var(--phone-analytics-blue-line)', color2: 'var(--phone-analytics-accent)', currency: false }
    }

    return { label1: 'Ingresos', label2: 'Gastos', color1: 'var(--phone-analytics-accent)', color2: 'var(--phone-analytics-contrast-line)', currency: true }
  }, [chartView, labels.leads])

  const metricCards = useMemo<MetricCardConfig[]>(() => ([
    { key: 'ingresosNetos', title: 'Ingresos netos', Icon: DollarSign, tone: 'green', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gastosPublicidad', title: 'Gastos publicidad', Icon: CreditCard, tone: 'black', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gananciaBruta', title: 'Ganancia bruta', Icon: TrendingUp, tone: 'blue', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'roas', title: 'ROAS', Icon: Activity, tone: 'gold', formatter: formatRoas },
    { key: 'totalCostos', title: 'Gastos negocio', Icon: WalletCards, tone: 'black', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gananciaNeta', title: 'Ganancia neta', Icon: Banknote, tone: 'green', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'reembolsos', title: 'Reembolsos', Icon: TrendingDown, tone: 'red', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'ltvPromedio', title: 'Pago promedio', Icon: Users, tone: 'blue', formatter: (value) => formatCurrency(value, accountCurrency) }
  ]), [accountCurrency])

  const hasChartData = chartData.some((point) => point.value > 0 || point.value2 > 0)
  const funnelRows = (funnelData.length > 0
    ? funnelData
    : [
      ...(hasWebAnalyticsAccess ? [{ stage: 'Visitantes', value: 0 }] : []),
      { stage: labels.leads, value: 0 },
      { stage: 'Citas', value: 0 },
      { stage: 'Asistencias', value: 0 },
      { stage: labels.customers, value: 0 }
    ]).filter((item) => hasWebAnalyticsAccess || item.stage?.trim().toLowerCase() !== 'visitantes')
  const funnelMax = Math.max(1, ...funnelRows.map((item) => item.value || 0))
  const totalConversion = funnelRows[0]?.value > 0
    ? ((funnelRows[funnelRows.length - 1].value / funnelRows[0].value) * 100).toFixed(1)
    : '0.0'

  const originOptions = useMemo<Array<{ id: OriginTab; label: string }>>(() => {
    const options: Array<{ id: OriginTab; label: string }> = []

    if (hasWebAnalyticsAccess) {
      options.push({ id: 'traffic', label: 'Tráfico' })
    }

    options.push(
      { id: 'leads', label: labels.leads },
      { id: 'appointments', label: 'Citas' },
      { id: 'conversions', label: labels.customers }
    )

    return options
  }, [hasWebAnalyticsAccess, labels.customers, labels.leads])

  const originRows = useMemo<SourceDatum[]>(() => {
    if (originTab === 'traffic' && !hasWebAnalyticsAccess) return []
    if (originTab === 'traffic') return originData.traffic.sources || []
    return originData[originTab] || []
  }, [hasWebAnalyticsAccess, originData, originTab])
  const originMax = Math.max(1, ...originRows.map((item) => item.value || 0))
  const originTotal = originRows.reduce((sum, item) => sum + (item.value || 0), 0)
  const phoneNumberRows = useMemo(
    () => buildPhoneNumberRows(originData.whatsappNumbers || [], detectedPhones),
    [detectedPhones, originData.whatsappNumbers]
  )
  const showPhoneNumberOrigin = !originLoading && phoneOriginRangeRef.current === rangeKey && phoneNumberRows.length >= 2
  const phoneNumberMax = Math.max(1, ...phoneNumberRows.map((item) => item.value || 0))
  const savedSections = getSavedAnalyticsSections(day, [
    ['Indicadores y origen', !loading && summaryThrough],
    ['Gráfica', !chartLoading && !chartDenied && chartThrough],
    ['Embudo', !funnelLoading && !funnelDenied && funnelThrough],
    ['Origen por número', showPhoneNumberOrigin && numbersThrough]
  ])

  const handlePeriodSelect = (nextPeriod: AnalyticsPeriod) => {
    setPeriod(nextPeriod)
    setPeriodMenuOpen(false)
  }

  return (
    <main className={styles.phoneAnalyticsPage} aria-label="Analíticas de Ristak">
      <PhonePageTransition active="analytics" className={styles.phoneFrame} data-phone-scrollable="true">
        <header className={styles.header}>
          <div className={styles.headerContent}>
            <p className={styles.eyebrow}>Ristak</p>
            <div className={styles.titleRow}>
              <h1>Analíticas</h1>
              <button
                type="button"
                className={`${styles.periodToggle} ${periodMenuOpen ? styles.periodToggleOpen : ''}`}
                aria-expanded={periodMenuOpen}
                aria-controls="phone-analytics-period-menu"
                onClick={() => setPeriodMenuOpen((open) => !open)}
              >
                <span>{activePeriod.label}</span>
                <ChevronDown size={16} className={styles.periodChevron} />
              </button>
            </div>
            <div
              id="phone-analytics-period-menu"
              className={`${styles.periodMenu} ${periodMenuOpen ? styles.periodMenuOpen : ''}`}
              role="group"
              aria-label="Periodo de analíticas"
              aria-hidden={!periodMenuOpen}
            >
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={period === option.id ? styles.periodOptionActive : ''}
                  tabIndex={periodMenuOpen ? 0 : -1}
                  onClick={() => handlePeriodSelect(option.id)}
                >
                  {option.menuLabel}
                </button>
              ))}
            </div>
          </div>
        </header>

        {denied ? <p className={styles.emptyState} role="status">Sin acceso a las analíticas de esta cuenta.</p> : <>
        {Array.from(savedSections, ([through, sections]) => (
          <p className={styles.savedReading} key={through} role="status">
            Datos guardados hasta el {formatDate(through, { timezone, includeYear: true })} · {sections.join(', ')}
          </p>
        ))}
        <section className={styles.metricsGrid} aria-label="Tarjetas principales">
          {metricCards.map(({ key, title, Icon, tone, formatter }) => {
            const metric = metrics?.[key]
            const deltaClass = (metric?.variation || 0) >= 0 ? styles.deltaPositive : styles.deltaNegative

            return (
              <article key={key} className={styles.metricCard}>
                <span className={`${styles.metricIcon} ${styles[`tone${tone}`]}`}>
                  <Icon size={18} />
                </span>
                <span className={styles.metricTitle}>{title}</span>
                <strong>{loading || !metric ? '...' : formatter(metric.value)}</strong>
                <small className={deltaClass}>{loading || !metric ? '' : `${getVariationLabel(metric.variation)} vs antes`}</small>
              </article>
            )
          })}
        </section>

        <section className={styles.panel} aria-label="Gráfica principal">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.sectionLabel}>Gráfica</p>
              <h2>{chartOptions.find((option) => option.id === chartView)?.label || 'Ingresos vs gastos'}</h2>
            </div>
          </div>

          <div className={styles.optionScroller} role="group" aria-label="Tipo de gráfica">
            {chartOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={chartView === option.id ? styles.chipActive : ''}
                onClick={() => setChartView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {chartView === 'revenue-spend' && (
            <div className={styles.segmentedControl} role="group" aria-label="Forma de atribución financiera">
              {SCOPE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={financialScope === option.id ? styles.segmentActive : ''}
                  onClick={() => setFinancialScope(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          <div className={styles.legendRow}>
            <span><i style={{ background: chartMeta.color1 }} />{chartMeta.label1}</span>
            <span><i style={{ background: chartMeta.color2 }} />{chartMeta.label2}</span>
          </div>

          {chartDenied ? <p className={styles.emptyState}>Sin acceso a esta gráfica.</p> : chartLoading ? (
            <div className={styles.loadingState} role="status" aria-live="polite" aria-label="Cargando gráfica">
              <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
            </div>
          ) : hasChartData ? (
            <MobileDualLineChart accountCurrency={accountCurrency} data={chartData} meta={chartMeta} timezone={timezone} />
          ) : (
            <div className={styles.emptyState}>Sin datos para este periodo.</div>
          )}
        </section>

        <section className={styles.panel} aria-label="Embudo de conversiones">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.sectionLabel}>Embudo</p>
              <h2>Conversiones</h2>
            </div>
            <strong className={styles.conversionPill}>{funnelLoading || funnelDenied ? '…' : `${totalConversion}%`}</strong>
          </div>

          <div className={styles.segmentedControl} role="group" aria-label="Forma de atribución del embudo">
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={funnelScope === option.id ? styles.segmentActive : ''}
                onClick={() => setFunnelScope(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {funnelDenied ? <p className={styles.emptyState}>Sin acceso a este embudo.</p> : funnelLoading ? (
            <div className={styles.loadingState} role="status" aria-live="polite" aria-label="Cargando embudo">
              <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
            </div>
          ) : (
            <div className={styles.funnelList}>
              {funnelRows.map((item, index) => {
                const percentage = ((item.value || 0) / funnelMax) * 100
                const previous = funnelRows[index - 1]?.value || 0
                const stepRate = index > 0 && previous > 0 ? ((item.value / previous) * 100).toFixed(1) : null

                return (
                  <div key={`${item.stage}-${index}`} className={styles.funnelItem}>
                    <span className={styles.funnelIcon}>
                      {index === 0 ? <Users size={16} /> : index === 1 ? <Target size={16} /> : index === 2 ? <CalendarDays size={16} /> : index === 3 ? <CheckCircle2 size={16} /> : <DollarSign size={16} />}
                    </span>
                    <div className={styles.funnelContent}>
                      <div className={styles.funnelTop}>
                        <strong>{item.stage}</strong>
                        <span>{formatNumber(item.value || 0)}</span>
                      </div>
                      <div className={styles.progressTrack}>
                        <i style={{ width: `${percentage}%` }} />
                      </div>
                      {stepRate && <small>{stepRate}% desde el paso anterior</small>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section ref={originPanelRef} className={styles.panel} aria-label="Origen">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.sectionLabel}>Origen</p>
              <h2>Fuentes</h2>
            </div>
            <strong className={styles.conversionPill}>{originLoading ? '…' : formatNumber(originTotal)}</strong>
          </div>

          <div className={styles.optionScroller} role="group" aria-label="Tipo de origen">
            {originOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={originTab === option.id ? styles.chipActive : ''}
                onClick={() => setOriginTab(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {originLoading ? (
            <div className={styles.loadingState} role="status" aria-live="polite" aria-label="Cargando origen">
              <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
            </div>
          ) : originRows.length > 0 ? (
            <div className={styles.sourceList}>
              {originRows.slice(0, 8).map((item, index) => (
                <div key={`${item.name}-${index}`} className={styles.sourceItem}>
                  <div className={styles.sourceTop}>
                    <strong>{item.name}</strong>
                    <span>{formatNumber(item.value || 0)}</span>
                  </div>
                  <div className={styles.sourceTrack}>
                    <i
                      style={{
                        width: `${((item.value || 0) / originMax) * 100}%`,
                        background: item.color || '#0078f8'
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>Sin origen detectado en este periodo.</div>
          )}
        </section>

        {showPhoneNumberOrigin && (
          <section className={styles.panel} aria-label="Origen por número">
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.sectionLabel}>WhatsApp</p>
                <h2>Origen por número</h2>
              </div>
            </div>

            <div className={styles.sourceList}>
              {phoneNumberRows.map((item) => (
                <div key={item.key} className={styles.sourceItem}>
                  <div className={styles.phoneSourceTop}>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.phone || item.statusLabel}</small>
                    </span>
                    <em>{formatNumber(item.value)} personas</em>
                  </div>
                  <div className={styles.sourceTrack}>
                    <i style={{ width: `${((item.value || 0) / phoneNumberMax) * 100}%`, background: 'var(--phone-analytics-contrast-line)' }} />
                  </div>
                  <small className={styles.phoneStatus}>{item.statusLabel}</small>
                </div>
              ))}
            </div>
          </section>
        )}
        </>}
      </PhonePageTransition>

      <PhoneEcosystemNav active="analytics" />
    </main>
  )
}
