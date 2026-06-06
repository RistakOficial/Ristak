import React, { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Banknote,
  BarChart3,
  CalendarDays,
  CheckCircle2,
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
import { useLabels } from '@/contexts/LabelsContext'
import {
  dashboardService,
  type DashboardMetrics,
  type OriginDistributionData,
  type SourceDatum,
  type WhatsAppNumberOriginDatum
} from '@/services/dashboardService'
import { whatsappApiService, type WhatsAppApiPhoneNumber } from '@/services/whatsappApiService'
import { formatCurrency, formatNumber, formatRoas } from '@/utils/format'
import styles from './PhoneAnalytics.module.css'

type AnalyticsPeriod = 'today' | '7d' | '30d' | '90d'
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

const PERIOD_OPTIONS: Array<{ id: AnalyticsPeriod; label: string; days: number }> = [
  { id: 'today', label: 'Hoy', days: 0 },
  { id: '7d', label: '7 días', days: 7 },
  { id: '30d', label: '30 días', days: 30 },
  { id: '90d', label: '90 días', days: 90 }
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

const shortCurrencyFormatter = new Intl.NumberFormat('es-MX', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  style: 'currency',
  currency: 'MXN'
})

const shortNumberFormatter = new Intl.NumberFormat('es-MX', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1
})

function getAnalyticsRange(period: AnalyticsPeriod) {
  const option = PERIOD_OPTIONS.find((item) => item.id === period) || PERIOD_OPTIONS[2]
  const end = new Date()
  const start = new Date()

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)

  if (option.days > 0) {
    start.setDate(start.getDate() - (option.days - 1))
  }

  return { start, end }
}

function getGroupBy(period: AnalyticsPeriod): 'day' | 'month' {
  return period === '90d' ? 'month' : 'day'
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

function formatShortDateLabel(label: string) {
  const parsed = new Date(label)
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(parsed)
  }

  return label
}

function formatCompactValue(value: number, currency: boolean) {
  return currency ? shortCurrencyFormatter.format(value || 0) : shortNumberFormatter.format(value || 0)
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
  data,
  meta
}: {
  data: ChartPoint[]
  meta: ChartMeta
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
      <div className={styles.chartTopScale}>{formatCompactValue(maxValue, meta.currency)}</div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${meta.label1} y ${meta.label2}`}>
        {[0.25, 0.5, 0.75].map((step) => {
          const y = padding.top + plotHeight * step
          return <line key={step} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className={styles.gridLine} />
        })}
        <polyline points={buildPoints('value')} fill="none" stroke={meta.color1} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={buildPoints('value2')} fill="none" stroke={meta.color2} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((point, index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth
          const y1 = padding.top + plotHeight - ((point.value || 0) / maxValue) * plotHeight
          const y2 = padding.top + plotHeight - ((point.value2 || 0) / maxValue) * plotHeight

          return (
            <g key={`${point.label}-${index}`}>
              <circle cx={x} cy={y1} r="4" fill={meta.color1} />
              <circle cx={x} cy={y2} r="4" fill={meta.color2} />
            </g>
          )
        })}
        {labelIndexes.map((index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth

          return (
            <text key={index} x={x} y={height - 6} textAnchor="middle" className={styles.axisLabel}>
              {formatShortDateLabel(data[index]?.label || '')}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

export const PhoneAnalytics: React.FC = () => {
  const { labels } = useLabels()
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [chartView, setChartView] = useState<ChartView>('revenue-spend')
  const [financialScope, setFinancialScope] = useState<ScopeType>('all')
  const [funnelScope, setFunnelScope] = useState<ScopeType>('all')
  const [originTab, setOriginTab] = useState<OriginTab>('traffic')
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [funnelData, setFunnelData] = useState<Array<{ stage: string; value: number }>>([])
  const [originData, setOriginData] = useState(EMPTY_ORIGIN_DATA)
  const [detectedPhones, setDetectedPhones] = useState<WhatsAppApiPhoneNumber[]>([])
  const [loading, setLoading] = useState(true)
  const [chartLoading, setChartLoading] = useState(true)
  const [funnelLoading, setFunnelLoading] = useState(true)
  const [originLoading, setOriginLoading] = useState(true)

  const range = useMemo(() => getAnalyticsRange(period), [period])
  const groupBy = useMemo(() => getGroupBy(period), [period])

  useEffect(() => {
    document.title = 'Analíticas móviles | Ristak Chat'
  }, [])

  useEffect(() => {
    let active = true

    setLoading(true)
    setOriginLoading(true)

    Promise.all([
      dashboardService.getDashboardMetrics({ start: range.start, end: range.end }),
      dashboardService.getOriginDistribution({ start: range.start, end: range.end }),
      whatsappApiService.getStatus().catch(() => null)
    ])
      .then(([metricsResponse, originResponse, whatsappStatus]) => {
        if (!active) return

        setMetrics(metricsResponse)
        setOriginData({
          ...EMPTY_ORIGIN_DATA,
          ...originResponse,
          traffic: {
            ...EMPTY_ORIGIN_DATA.traffic,
            ...(originResponse?.traffic || {})
          },
          whatsappNumbers: originResponse?.whatsappNumbers || []
        })
        setDetectedPhones((whatsappStatus?.phoneNumbers || []).filter((phone) => (
          Boolean(phone.id || phone.phone_number || phone.display_phone_number || phone.qr_connected_phone)
        )))
      })
      .catch(() => {
        if (!active) return
        setMetrics(null)
        setOriginData(EMPTY_ORIGIN_DATA)
        setDetectedPhones([])
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
        setOriginLoading(false)
      })

    return () => {
      active = false
    }
  }, [range.end, range.start])

  useEffect(() => {
    let active = true

    setFunnelLoading(true)
    dashboardService.getFunnelData({ start: range.start, end: range.end, scope: funnelScope })
      .then((response) => {
        if (active) setFunnelData(response)
      })
      .catch(() => {
        if (active) setFunnelData([])
      })
      .finally(() => {
        if (active) setFunnelLoading(false)
      })

    return () => {
      active = false
    }
  }, [funnelScope, range.end, range.start])

  useEffect(() => {
    let active = true

    const loadChart = async () => {
      setChartLoading(true)

      try {
        if (chartView === 'revenue-spend') {
          const response = await dashboardService.getFinancialChart({
            start: range.start,
            end: range.end,
            scope: financialScope
          })

          if (!active) return
          setChartData(response.map((item) => ({
            label: item.date,
            value: item.ingresos || 0,
            value2: item.gastado || 0
          })))
          return
        }

        const commonParams = { start: range.start, end: range.end, groupBy }
        let response: ChartPoint[] = []

        if (chartView === 'visitors-leads') {
          const [visitors, leads] = await Promise.all([
            dashboardService.getVisitorsData(commonParams),
            dashboardService.getLeadsData(commonParams)
          ])
          response = combineSeries(visitors, leads)
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

        if (active) setChartData(response)
      } catch {
        if (active) setChartData([])
      } finally {
        if (active) setChartLoading(false)
      }
    }

    void loadChart()

    return () => {
      active = false
    }
  }, [chartView, financialScope, groupBy, range.end, range.start])

  const chartOptions = useMemo<Array<{ id: ChartView; label: string }>>(() => ([
    { id: 'revenue-spend', label: 'Ingresos vs gastos' },
    { id: 'visitors-leads', label: `Visitantes vs ${labels.leads}` },
    { id: 'leads-appointments', label: `${labels.leads} vs citas` },
    { id: 'appointments-attendances', label: 'Citas vs asistencias' },
    { id: 'attendances-sales', label: 'Asistencias vs ventas' }
  ]), [labels.leads])

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
    { key: 'ingresosNetos', title: 'Ingresos netos', Icon: DollarSign, tone: 'green', formatter: formatCurrency },
    { key: 'gastosPublicidad', title: 'Gastos publicidad', Icon: CreditCard, tone: 'black', formatter: formatCurrency },
    { key: 'gananciaBruta', title: 'Ganancia bruta', Icon: TrendingUp, tone: 'blue', formatter: formatCurrency },
    { key: 'roas', title: 'ROAS', Icon: Activity, tone: 'gold', formatter: formatRoas },
    { key: 'totalCostos', title: 'Costos', Icon: WalletCards, tone: 'black', formatter: formatCurrency },
    { key: 'gananciaNeta', title: 'Ganancia neta', Icon: Banknote, tone: 'green', formatter: formatCurrency },
    { key: 'reembolsos', title: 'Reembolsos', Icon: TrendingDown, tone: 'red', formatter: formatCurrency },
    { key: 'ltvPromedio', title: 'Pago promedio', Icon: Users, tone: 'blue', formatter: formatCurrency }
  ]), [])

  const hasChartData = chartData.some((point) => point.value > 0 || point.value2 > 0)
  const funnelRows = funnelData.length > 0
    ? funnelData
    : [
      { stage: 'Visitantes', value: 0 },
      { stage: labels.leads, value: 0 },
      { stage: 'Citas', value: 0 },
      { stage: 'Asistencias', value: 0 },
      { stage: labels.customers, value: 0 }
    ]
  const funnelMax = Math.max(1, ...funnelRows.map((item) => item.value || 0))
  const totalConversion = funnelRows[0]?.value > 0
    ? ((funnelRows[funnelRows.length - 1].value / funnelRows[0].value) * 100).toFixed(1)
    : '0.0'

  const originOptions = useMemo<Array<{ id: OriginTab; label: string }>>(() => ([
    { id: 'traffic', label: 'Tráfico' },
    { id: 'leads', label: labels.leads },
    { id: 'appointments', label: 'Citas' },
    { id: 'conversions', label: labels.customers }
  ]), [labels.customers, labels.leads])

  const originRows = useMemo<SourceDatum[]>(() => {
    if (originTab === 'traffic') return originData.traffic.sources || []
    return originData[originTab] || []
  }, [originData, originTab])
  const originMax = Math.max(1, ...originRows.map((item) => item.value || 0))
  const originTotal = originRows.reduce((sum, item) => sum + (item.value || 0), 0)
  const phoneNumberRows = useMemo(
    () => buildPhoneNumberRows(originData.whatsappNumbers || [], detectedPhones),
    [detectedPhones, originData.whatsappNumbers]
  )
  const showPhoneNumberOrigin = phoneNumberRows.length >= 2
  const phoneNumberMax = Math.max(1, ...phoneNumberRows.map((item) => item.value || 0))

  return (
    <main className={styles.phoneAnalyticsPage} aria-label="Analíticas de Ristak Chat">
      <section className={styles.phoneFrame} data-phone-scrollable="true">
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Ristak Chat</p>
            <h1>Analíticas</h1>
          </div>
          <span className={styles.headerIcon} aria-hidden="true">
            <BarChart3 size={25} />
          </span>
        </header>

        <div className={styles.periodScroller} role="group" aria-label="Periodo de analíticas">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={period === option.id ? styles.chipActive : ''}
              onClick={() => setPeriod(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

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
                <small className={deltaClass}>{loading || !metric ? 'Cargando' : `${getVariationLabel(metric.variation)} vs antes`}</small>
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

          {chartLoading ? (
            <div className={styles.loadingState}>
              <Loader2 size={17} className={styles.spinIcon} />
              Cargando gráfica...
            </div>
          ) : hasChartData ? (
            <MobileDualLineChart data={chartData} meta={chartMeta} />
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
            <strong className={styles.conversionPill}>{totalConversion}%</strong>
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

          {funnelLoading ? (
            <div className={styles.loadingState}>
              <Loader2 size={17} className={styles.spinIcon} />
              Cargando embudo...
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

        <section className={styles.panel} aria-label="Origen">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.sectionLabel}>Origen</p>
              <h2>Fuentes</h2>
            </div>
            <strong className={styles.conversionPill}>{formatNumber(originTotal)}</strong>
          </div>

          <div className={styles.segmentedControl} role="group" aria-label="Tipo de origen">
            {originOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={originTab === option.id ? styles.segmentActive : ''}
                onClick={() => setOriginTab(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {originLoading ? (
            <div className={styles.loadingState}>
              <Loader2 size={17} className={styles.spinIcon} />
              Cargando origen...
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
                        background: item.color || '#25d366'
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
      </section>

      <PhoneEcosystemNav active="analytics" />
    </main>
  )
}
