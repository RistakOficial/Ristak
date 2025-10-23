import React, { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Card,
  KpiCard,
  Table,
  TabList,
  DateRangePicker,
  Button,
  ContactDetailsModal,
  VisitorDetailsModal,
  ViewSelector,
  PageContainer
} from '@/components/common'
import type { Column } from '@/components/common'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useLabels } from '@/contexts/LabelsContext'
import {
  reportsService,
  type ReportsSummary,
  type ReportMetricRow,
  type ContactListItem,
  type ReportRange
} from '@/services/reportsService'
import { formatCurrency, formatNumber, formatRoas, formatDate, formatDateToISO, parseLocalDateString } from '@/utils/format'
import { useAppConfig } from '@/hooks'
import styles from './Reports.module.css'
import {
  Users,
  UserCheck,
  DollarSign,
  Target,
  Layers,
  MousePointerClick,
  Table as TableIcon,
  BarChart3
} from 'lucide-react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  TooltipProps
} from 'recharts'

const monthNames = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]
const monthNamesShort = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sept', 'oct', 'nov', 'dic'
]

type ViewType = 'day' | 'month' | 'year'
type ReportType = 'cashflow' | 'attribution' | 'campaigns'
type DisplayMode = 'table' | 'metrics'
type ModalType = 'interesados' | 'sales' | 'appointments' | 'customers'

type TableRow = {
  id: string
  date: string
  displayDate: string
  roas: number
  profit: number
  revenue: number
  spend: number
  sales: number
  new_customers: number
  leads: number
  appointments: number
  clicks: number
  reach: number
  visitors: number
  cpc: number
  cpv: number
  cpl: number
  cac: number
  webToInteresadosRate: number
  interesadosToApptsRate: number
  apptsToSalesRate: number
}

// "Todos" agrupa por la fecha en que sucedió cada evento.
// "Al momento de registro" agrupa todo por fecha de creación del contacto (sin filtro de anuncios).
// "Identificados de anuncios" agrupa por fecha de creación + filtra solo contactos con ad_id.
const scopeTabs = [
  { value: 'cashflow', label: 'Todos', icon: <Layers size={16} /> },
  { value: 'attribution', label: 'Al momento de registro', icon: <Target size={16} /> },
  { value: 'campaigns', label: 'Identificados de anuncios', icon: <MousePointerClick size={16} /> }
]

const viewTabs = [
  { value: 'day', label: 'Día' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' }
]

const displayTabs = [
  { value: 'table', label: 'Histórico', icon: <TableIcon size={16} /> },
  { value: 'metrics', label: 'Métricas', icon: <BarChart3 size={16} /> }
]

const monthRangeOptions = [
  { value: 'last12', label: 'Últimos 12 meses' },
  { value: 'thisYear', label: 'Este año' },
  { value: 'custom', label: 'Rango personalizado' }
]

const now = new Date()
const currentYear = now.getFullYear()
const defaultYearRange = { start: currentYear - 2, end: currentYear }

// Usar formatDateToISO en vez de toIsoDate para evitar problemas de zona horaria
const toIsoDate = formatDateToISO

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

const startOfMonth = (year: number, monthIndex: number) => new Date(year, monthIndex, 1, 0, 0, 0)
const endOfMonth = (year: number, monthIndex: number) => new Date(year, monthIndex + 1, 0, 23, 59, 59)
const startOfYear = (year: number) => new Date(year, 0, 1, 0, 0, 0)
const endOfYear = (year: number) => new Date(year, 11, 31, 23, 59, 59)

const calcDelta = (current: number, previous: number) => {
  if (previous === 0) {
    return current > 0 ? 100 : 0
  }
  return ((current - previous) / previous) * 100
}

const formatPeriodLabel = (
  value: string,
  viewType: ViewType,
  options: { includeYear?: boolean } = {}
) => {
  if (!value) return ''

  if (viewType === 'day') {
    const sanitized = value.includes('T') ? value.split('T')[0] : value
    const parts = sanitized.split('-')
    if (parts.length === 3) {
      const [year, month, day] = parts
      const monthIndex = parseInt(month, 10) - 1
      if (Number.isNaN(monthIndex)) return value
      const monthLabel = monthNamesShort[monthIndex] || ''
      const includeYear = options.includeYear ?? false
      const cleanDay = day.split('T')[0]
      const dayLabel = cleanDay.padStart(2, '0')
      return includeYear ? `${dayLabel} ${monthLabel} ${year}` : `${dayLabel} ${monthLabel}`
    }
  }

  if (viewType === 'month') {
    const parts = value.split('-')
    if (parts.length >= 2) {
      const [year, month] = parts
      const monthIndex = parseInt(month, 10) - 1
      if (Number.isNaN(monthIndex)) return value
      const monthName = monthNames[monthIndex] || ''
      const includeYear = options.includeYear ?? true
      return includeYear ? `${monthName} ${year}` : monthName
    }
  }

  if (viewType === 'year' && value.length === 4) {
    return value
  }

  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    const includeYear = options.includeYear ?? true
    return formatDate(date, { includeYear, referenceDate: date })
  }

  return value
}

const formatRangeLabel = (range?: ReportRange | null) => {
  if (!range) return ''
  const { start, end } = range
  if (!start && !end) return 'Todo el historial'
  if (!start && end) return `Hasta ${formatPeriodLabel(end, 'day', { includeYear: true })}`
  if (start && !end) return `Desde ${formatPeriodLabel(start, 'day', { includeYear: true })}`
  if (!start || !end) return ''
  if (start === end) return formatPeriodLabel(start, 'day', { includeYear: true })
  return `${formatPeriodLabel(start, 'day', { includeYear: true })} – ${formatPeriodLabel(end, 'day', { includeYear: true })}`
}

const resolvePeriodRange = (period: string, viewType: ViewType) => {
  if (viewType === 'day') {
    return { from: period, to: period }
  }
  if (viewType === 'month') {
    const [year, month] = period.split('-').map(Number)
    const start = startOfMonth(year, month - 1)
    const end = endOfMonth(year, month - 1)
    return { from: toIsoDate(start), to: toIsoDate(end) }
  }
  const year = Number(period)
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

const computeRangeForView = (
  viewType: ViewType,
  baseRange: { start: Date; end: Date },
  monthPreset: 'last12' | 'thisYear' | 'custom',
  customMonthYear: number,
  customMonthStart: number,
  customMonthEnd: number,
  yearRange: { start: number; end: number }
) => {
  if (viewType === 'day') {
    return {
      from: toIsoDate(baseRange.start),
      to: toIsoDate(baseRange.end)
    }
  }

  if (viewType === 'month') {
    if (monthPreset === 'thisYear') {
      const start = startOfYear(currentYear)
      const end = endOfMonth(currentYear, now.getMonth())
      return { from: toIsoDate(start), to: toIsoDate(end) }
    }

    if (monthPreset === 'custom') {
      const start = startOfMonth(customMonthYear, customMonthStart)
      const end = endOfMonth(customMonthYear, customMonthEnd)
      return { from: toIsoDate(start), to: toIsoDate(end) }
    }

    const end = endOfMonth(now.getFullYear(), now.getMonth())
    const start = startOfMonth(now.getFullYear(), now.getMonth() - 11)
    return { from: toIsoDate(start), to: toIsoDate(end) }
  }

  const start = startOfYear(yearRange.start)
  const end = endOfYear(yearRange.end)
  return { from: toIsoDate(start), to: toIsoDate(end) }
}

interface MetricsGridProps {
  metrics: ReportMetricRow[]
  loading: boolean
  reportType: ReportType
  showVisitors: boolean
  viewType: ViewType
}

// Componente de tooltip personalizado para los gráficos
interface CustomTooltipProps extends TooltipProps<number, string> {
  formatter?: (value: number) => string
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, label, formatter }) => {
  if (!active || !payload || !payload.length) {
    return null
  }

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        padding: '12px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
      }}
    >
      <p
        style={{
          margin: '0 0 8px 0',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--color-text-primary)'
        }}
      >
        {label}
      </p>
      {payload.map((entry, index) => (
        <div
          key={`item-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: index > 0 ? '4px' : '0'
          }}
        >
          <span
            style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              backgroundColor: entry.color,
              display: 'inline-block'
            }}
          />
          <span
            style={{
              fontSize: '11px',
              color: 'var(--color-text-secondary)',
              marginRight: '4px'
            }}
          >
            {entry.name}:
          </span>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--color-text-primary)'
            }}
          >
            {formatter ? formatter(entry.value as number) : entry.value}
          </span>
        </div>
      ))}
    </div>
  )
}

const MetricsGrid: React.FC<MetricsGridProps> = ({ metrics, loading, reportType, showVisitors, viewType }) => {
  const { labels } = useLabels()
  const totals = metrics.reduce((acc, m) => ({
    spend: acc.spend + m.spend,
    revenue: acc.revenue + m.revenue,
    leads: acc.leads + m.leads,
    sales: acc.sales + m.sales,
    clicks: acc.clicks + m.clicks,
    visitors: acc.visitors + m.visitors,
    appointments: acc.appointments + m.appointments,
    new_customers: acc.new_customers + m.new_customers
  }), {
    spend: 0,
    revenue: 0,
    leads: 0,
    sales: 0,
    clicks: 0,
    visitors: 0,
    appointments: 0,
    new_customers: 0
  })

  const profit = totals.revenue - totals.spend
  const roas = totals.spend > 0 ? totals.revenue / totals.spend : 0
  const roi = totals.spend > 0 ? ((totals.revenue - totals.spend) / totals.spend) * 100 : 0
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0
  const epc = totals.clicks > 0 ? totals.revenue / totals.clicks : 0
  const cpl = totals.leads > 0 ? totals.spend / totals.leads : 0
  const epl = totals.leads > 0 ? totals.revenue / totals.leads : 0
  const cac = totals.new_customers > 0 ? totals.spend / totals.new_customers : 0
  const aov = totals.sales > 0 ? totals.revenue / totals.sales : 0
  const transactionsPerCustomer = totals.new_customers > 0 ? totals.sales / totals.new_customers : 0
  const webToInteresado = totals.visitors > 0 ? (totals.leads / totals.visitors) * 100 : 0
  const interesadoToAppt = totals.leads > 0 ? (totals.appointments / totals.leads) * 100 : 0
  const apptToSale = totals.appointments > 0 ? (totals.sales / totals.appointments) * 100 : 0

  // Preparar datos para los gráficos
  const chartData = metrics.slice().reverse().map(m => ({
    date: formatPeriodLabel(m.date, viewType, { includeYear: false }),
    clicks: m.clicks,
    visitors: m.visitors,
    leads: m.leads,
    appointments: m.appointments,
    sales: m.sales,
    new_customers: m.new_customers,
    revenue: m.revenue,
    spend: m.spend,
    profit: m.revenue - m.spend
  }))

  const trafficItems = [
    { label: 'Clicks', value: formatNumber(totals.clicks) },
    { label: 'Costo por Click', value: formatCurrency(cpc) },
    { label: 'Ingreso por Click', value: formatCurrency(epc) }
  ]

  if (showVisitors) {
    trafficItems.push(
      { label: 'Visitantes', value: formatNumber(totals.visitors) },
      { label: `Web→${labels.leads} %`, value: `${webToInteresado.toFixed(1)}%` }
    )
  }

  const metricGroups = [
    {
      title: 'Tráfico',
      icon: <MousePointerClick size={18} />,
      items: trafficItems,
      chart: (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <Tooltip
              content={<CustomTooltip formatter={formatNumber} />}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
              wrapperStyle={{ zIndex: 1000 }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Line type="monotone" dataKey="clicks" stroke="#3b82f6" name="Clicks" strokeWidth={2} dot={{ r: 3 }} />
            {showVisitors && (
              <Line type="monotone" dataKey="visitors" stroke="#8b5cf6" name="Visitantes" strokeWidth={2} dot={{ r: 3 }} />
            )}
          </LineChart>
        </ResponsiveContainer>
      )
    },
    {
      title: 'Conversión',
      icon: <Target size={18} />,
      items: [
        { label: labels.leads, value: formatNumber(totals.leads) },
        { label: `Costo por ${labels.lead}`, value: formatCurrency(cpl) },
        { label: `Ingreso por ${labels.lead}`, value: formatCurrency(epl) },
        { label: 'Citas (Primera)', value: formatNumber(totals.appointments) },
        { label: `${labels.leads}→Citas %`, value: `${interesadoToAppt.toFixed(1)}%` },
        { label: reportType === 'cashflow' ? 'Transacciones' : 'Ventas', value: formatNumber(totals.sales) },
        { label: 'Citas→Ventas %', value: `${apptToSale.toFixed(1)}%` }
      ],
      chart: (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <Tooltip
              content={<CustomTooltip formatter={formatNumber} />}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
              wrapperStyle={{ zIndex: 1000 }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Line type="monotone" dataKey="leads" stroke="#10b981" name={labels.leads} strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="appointments" stroke="#f59e0b" name="Citas" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="sales" stroke="#ef4444" name="Ventas" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )
    },
    {
      title: 'Clientes',
      icon: <UserCheck size={18} />,
      items: [
        { label: `${labels.customers} Nuevos`, value: formatNumber(totals.new_customers) },
        { label: `Costo por ${labels.customer}`, value: formatCurrency(cac) },
        { label: 'Total de Transacciones', value: formatNumber(totals.sales) },
        { label: 'Transacciones por Cliente', value: transactionsPerCustomer.toFixed(1) },
        { label: 'Ticket Promedio', value: formatCurrency(aov) }
      ],
      chart: (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <Tooltip
              content={<CustomTooltip formatter={formatNumber} />}
              cursor={{ fill: 'rgba(0, 0, 0, 0.05)' }}
              wrapperStyle={{ zIndex: 1000 }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Bar dataKey="new_customers" fill="#06b6d4" name="Clientes Nuevos" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )
    },
    {
      title: 'Finanzas',
      icon: <DollarSign size={18} />,
      items: [
        { label: 'Ingresos', value: formatCurrency(totals.revenue) },
        { label: 'Gasto en Anuncios', value: formatCurrency(totals.spend) },
        { label: 'Ganancias Netas', value: formatCurrency(profit) },
        { label: 'Retorno de Inversión', value: `${roas.toFixed(2)}x` },
        { label: 'ROI', value: `${roi.toFixed(1)}%` }
      ],
      chart: (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
            <Tooltip
              content={<CustomTooltip formatter={formatCurrency} />}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
              wrapperStyle={{ zIndex: 1000 }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Area type="monotone" dataKey="revenue" stroke="#10b981" fill="#10b981" fillOpacity={0.3} name="Ingresos" />
            <Area type="monotone" dataKey="spend" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} name="Gastos" />
            <Area type="monotone" dataKey="profit" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} name="Ganancias" />
          </AreaChart>
        </ResponsiveContainer>
      )
    }
  ]

  return (
    <div className={styles.metricsContainer}>
      {loading ? (
        <Card className={styles.metricsTableCard}>
          <p className={styles.metricsLoading}>Cargando métricas...</p>
        </Card>
      ) : (
        metricGroups.map((group) => (
          <Card key={group.title} className={styles.metricsCategoryCard}>
            <div className={styles.metricsCategoryHeader}>
              <span className={styles.metricsCategoryIcon}>{group.icon}</span>
              <h3 className={styles.metricsCategoryTitle}>{group.title}</h3>
            </div>
            <div className={styles.metricsTableWrapper}>
              <table className={styles.metricsTable}>
                <thead>
                  <tr>
                    <th>Descripción</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item) => (
                    <tr key={`${group.title}-${item.label}`} className={styles.metricsRow}>
                      <td className={styles.metricsLabelCell}>{item.label}</td>
                      <td className={styles.metricsValueCell}>{item.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {chartData.length > 0 && (
              <div className={styles.metricsChartWrapper}>
                {group.chart}
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  )
}

const mapContactsToModalData = (contacts: ContactListItem[]): ContactListItem[] =>
  contacts.map(contact => ({
    ...contact,
    created_at: contact.created_at || (contact as any).createdAt
  }))

export const Reports: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { showToast } = useNotification()
  const { labels } = useLabels()

  // Sistema híbrido de configuración
  const [visitorSource] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')
  const analyticsEnabled = parseAnalyticsFlag(showAnalyticsConfig)

  const [reportType, setReportType] = useState<ReportType>('cashflow')
  const reportTypeRef = React.useRef<ReportType>(reportType)

  useEffect(() => {
    reportTypeRef.current = reportType
  }, [reportType])
  const [viewType, setViewType] = useState<ViewType>('month')
  const [displayMode, setDisplayMode] = useState<DisplayMode>('table')
  const [monthPreset, setMonthPreset] = useState<'last12' | 'thisYear' | 'custom'>('last12')
  const [customMonthYear, setCustomMonthYear] = useState(currentYear)
  const [customMonthStart, setCustomMonthStart] = useState(0)
  const [customMonthEnd, setCustomMonthEnd] = useState(11)
  const [yearRange, setYearRange] = useState(defaultYearRange)

  const [metrics, setMetrics] = useState<ReportMetricRow[]>([])
  const [metricsRange, setMetricsRange] = useState<ReportRange | null>(null)
  const [summary, setSummary] = useState<ReportsSummary | null>(null)
  const [loadingMetrics, setLoadingMetrics] = useState(false)
  const [loadingSummary, setLoadingSummary] = useState(false)

  const [modalState, setModalState] = useState<{
    open: boolean
    type: ModalType | null
    title: string
    subtitle?: string
    contacts: ContactListItem[]
    loading: boolean
    range?: { from: string; to: string }
    titleOverride?: string
  }>({
    open: false,
    type: null,
    title: '',
    subtitle: '',
    contacts: [],
    loading: false
  })

  // Estado para modal de visitantes
  const [isVisitorsModalOpen, setIsVisitorsModalOpen] = useState(false)
  const [visitorsModalLoading, setVisitorsModalLoading] = useState(false)
  const [visitorsData, setVisitorsData] = useState<any[]>([])
  const [visitorsModalDate, setVisitorsModalDate] = useState('')
  const [visitorsModalRawDate, setVisitorsModalRawDate] = useState('') // Para guardar la fecha original

  const baseRange = {
    start: dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start),
    end: dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  }

  const apiRange = computeRangeForView(
    viewType,
    baseRange,
    monthPreset,
    customMonthYear,
    customMonthStart,
    customMonthEnd,
    yearRange
  )

  // 'all' = agrupa por fecha del evento
  // 'attribution' = agrupa por fecha de creación del contacto (todos los contactos)
  // 'campaigns' = agrupa por fecha de creación del contacto (solo con ad_id)
  const scopeParam = reportType === 'campaigns' ? 'campaigns' : reportType === 'attribution' ? 'attribution' : 'all'

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoadingMetrics(true)
        const result = await reportsService.getMetrics({
          from: apiRange.from,
          to: apiRange.to,
          groupBy: viewType,
          scope: scopeParam
        })

        // Si estamos en modo tracking, obtener visitantes del tracking
        if (visitorSource === 'tracking') {
          try {
            const trackingResponse = await fetch(
              `/api/tracking/visitors-by-period?` + new URLSearchParams({
                startDate: apiRange.from,
                endDate: apiRange.to,
                groupBy: viewType,
                scope: scopeParam // Pasar el scope actual para que respete la vista
              })
            )

            if (trackingResponse.ok) {
              const trackingData = await trackingResponse.json()

              // Actualizar las métricas con los visitantes del tracking
              const updatedMetrics = result.metrics.map((metric: ReportMetricRow) => {
                const trackingVisitors = trackingData.data?.[metric.date] || 0
                return {
                  ...metric,
                  visitors: trackingVisitors
                }
              })

              setMetrics(updatedMetrics)
            } else {
              setMetrics(result.metrics)
            }
          } catch (trackingError) {
            // Si falla el tracking, usar métricas originales
            setMetrics(result.metrics)
          }
        } else {
          setMetrics(result.metrics)
        }

        setMetricsRange(result.range)
      } catch (error) {
        setMetrics([])
        showToast('error', 'No se pudieron cargar las métricas', 'Revisa tu conexión e intenta nuevamente')
      } finally {
        setLoadingMetrics(false)
      }
    }

    fetchMetrics()
  }, [apiRange.from, apiRange.to, scopeParam, viewType, showToast, dateRange, visitorSource])

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        setLoadingSummary(true)
        const result = await reportsService.getSummary({ from: apiRange.from, to: apiRange.to, scope: scopeParam })
        setSummary(result)
      } catch (error) {
        setSummary(null)
      } finally {
        setLoadingSummary(false)
      }
    }

    fetchSummary()
  }, [apiRange.from, apiRange.to, scopeParam, dateRange])

  useEffect(() => {
    setModalState(prev => ({
      ...prev,
      open: false,
      contacts: [],
      loading: false
    }))
  }, [reportType, viewType])

  const includeYearForTable = viewType === 'day'
    ? new Date(apiRange.from).getFullYear() !== new Date(apiRange.to).getFullYear()
    : true

  const tableData: TableRow[] = useMemo(() => (
    metrics.map((item, index) => {
      const profit = item.revenue - item.spend
      const cpc = item.clicks > 0 ? item.spend / item.clicks : 0
      const cpv = item.visitors > 0 ? item.spend / item.visitors : 0
      const cpl = item.leads > 0 ? item.spend / item.leads : 0
      const cac = item.sales > 0 ? item.spend / item.sales : 0
      const webToInteresadosRate = item.visitors > 0 ? (item.leads / item.visitors) * 100 : 0
      const interesadosToApptsRate = item.leads > 0 ? (item.appointments / item.leads) * 100 : 0
      const apptsToSalesRate = item.appointments > 0 ? (item.sales / item.appointments) * 100 : 0

      return {
        id: `${item.date}-${index}`,
        date: item.date,
        displayDate: formatPeriodLabel(item.date, viewType, { includeYear: includeYearForTable }),
        roas: item.roas,
        profit,
        revenue: item.revenue,
        spend: item.spend,
        sales: item.sales,
        new_customers: item.new_customers,
        leads: item.leads,
        appointments: item.appointments,
        clicks: item.clicks,
        reach: item.reach,
        visitors: item.visitors,
        cpc,
        cpv,
        cpl,
        cac,
        webToInteresadosRate,
        interesadosToApptsRate,
        apptsToSalesRate
      }
    }).sort((a, b) => {
      // Ordenar por fecha descendente (más reciente primero) sin activar indicador visual
      const dateA = new Date(a.date).getTime()
      const dateB = new Date(b.date).getTime()
      return dateB - dateA
    })
  ), [metrics, viewType, includeYearForTable])

  const handleOpenModal = React.useCallback(async (
    type: ModalType,
    range?: { from: string; to: string },
    titleOverride?: string
  ) => {
    const from = range?.from ?? apiRange.from
    const to = range?.to ?? apiRange.to
    const currentReportType = reportTypeRef.current
    const currentScope = currentReportType === 'campaigns' ? 'campaigns' : currentReportType === 'attribution' ? 'attribution' : 'all'

    setModalState({
      open: true,
      type,
      title: titleOverride ||
        (type === 'interesados'
          ? labels.leads
          : type === 'sales'
            ? (currentReportType === 'campaigns' ? 'Ventas' : 'Transacciones')
            : type === 'appointments'
              ? 'Citas (Primera)'
              : labels.customers),
      subtitle: `${formatPeriodLabel(from, 'day', { includeYear: true })} – ${formatPeriodLabel(to, 'day', { includeYear: true })}`,
      contacts: [],
      loading: true,
      range,
      titleOverride
    })

    try {
      const result = await reportsService.getContactsList({
        from,
        to,
        type: type === 'customers' ? 'customers' : type,
        scope: currentScope
      })
      setModalState(prev => ({
        ...prev,
        contacts: mapContactsToModalData(result.contacts),
        loading: false
      }))
    } catch (error) {
      setModalState(prev => ({ ...prev, contacts: [], loading: false }))
      showToast('error', 'No se pudieron cargar los contactos', 'Intenta nuevamente más tarde')
    }
  }, [apiRange, labels, reportTypeRef, showToast])

  // Limpiar y recargar datos del modal cuando cambian las fechas
  useEffect(() => {
    if (modalState.open && modalState.type) {
      // Limpiar datos anteriores inmediatamente
      setModalState(prev => ({ ...prev, contacts: [], loading: true }))

      // Recargar con las nuevas fechas
      const loadModalData = async () => {
        const from = modalState.range?.from ?? apiRange.from
        const to = modalState.range?.to ?? apiRange.to
        const currentReportType = reportTypeRef.current
        const currentScope = currentReportType === 'campaigns' ? 'campaigns' : currentReportType === 'attribution' ? 'attribution' : 'all'

        try {
          const result = await reportsService.getContactsList({
            from,
            to,
            type: modalState.type === 'customers' ? 'customers' : modalState.type,
            scope: currentScope
          })
          setModalState(prev => ({
            ...prev,
            contacts: mapContactsToModalData(result.contacts),
            loading: false
          }))
        } catch (error) {
          setModalState(prev => ({ ...prev, contacts: [], loading: false }))
        }
      }

      loadModalData()
    }
  }, [dateRange, apiRange.from, apiRange.to]) // Reaccionar a cambios de fecha

  // Función para abrir modal de visitantes
  const handleOpenVisitorsModal = useCallback(async (date: string) => {
    if (!analyticsEnabled) return

    setVisitorsModalLoading(true)
    setIsVisitorsModalOpen(true)
    setVisitorsModalRawDate(date) // Guardar la fecha original para recargar si es necesario

    // Manejar diferentes formatos de fecha según viewType
    let startDate = date
    let endDate = date
    let displayDate = date

    // Si es formato año-mes (2025-10) o solo año (2025)
    if (date.match(/^\d{4}$/)) {
      // Solo año: 2025 -> 2025-01-01 hasta 2025-12-31
      startDate = `${date}-01-01`
      endDate = `${date}-12-31`
      displayDate = date
    } else if (date.match(/^\d{4}-\d{2}$/)) {
      // Año-mes: 2025-10 -> 2025-10-01 hasta 2025-10-31
      const [year, month] = date.split('-')
      startDate = `${date}-01`
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
      endDate = `${date}-${lastDay.toString().padStart(2, '0')}`
      displayDate = `${monthNames[parseInt(month) - 1]} ${year}`
    } else {
      // Fecha completa: 2025-10-18
      displayDate = new Date(date).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' })
    }

    setVisitorsModalDate(displayDate)

    try {
      const currentScope = reportTypeRef.current === 'campaigns' ? 'campaigns' : reportTypeRef.current === 'attribution' ? 'attribution' : 'all'
      const response = await fetch(
        `/api/tracking/visitors?` + new URLSearchParams({
          startDate: startDate,
          endDate: endDate,
          scope: currentScope
        })
      )

      if (response.ok) {
        const data = await response.json()
        setVisitorsData(data.data || [])
      } else {
        setVisitorsData([])
        showToast('error', 'No se pudieron cargar los visitantes', 'Intenta nuevamente')
      }
    } catch (error) {
      setVisitorsData([])
      showToast('error', 'Error al cargar visitantes', 'Verifica tu conexión')
    } finally {
      setVisitorsModalLoading(false)
    }
  }, [analyticsEnabled, showToast, reportTypeRef])

  const initialColumns: Column<TableRow>[] = useMemo(() => {
    const salesLabel = reportType === 'cashflow' ? 'Transacciones' : 'Ventas'

    const columns: Column<TableRow>[] = [
      {
        key: 'date',
        header: viewType === 'year' ? 'Año' : viewType === 'month' ? 'Mes' : 'Fecha',
        sortable: true,
        render: (_value, row) => <span className={styles.dateCell}>{row.displayDate}</span>
      },
      {
        key: 'spend',
        header: 'Invertido',
        sortable: true,
        render: (value: number) => <span className={styles.secondaryText}>{formatCurrency(value)}</span>
      },
      {
        key: 'revenue',
        header: 'Recolectado',
        sortable: true,
        render: (value: number) => <span className={styles.primaryText}>{formatCurrency(value)}</span>
      },
      {
        key: 'profit',
        header: 'Ganancias',
        sortable: true,
        render: (value: number) => <span className={styles.primaryText}>{formatCurrency(value)}</span>
      },
      {
        key: 'roas',
        header: 'Retorno de Inversión',
        sortable: true,
        render: (value: number) => <span className={styles.secondaryText}>{value.toFixed(2)}x</span>
      },
      {
        key: 'leads',
        header: labels.leads,
        sortable: true,
        render: (value: number, row) => {
          const hasValue = (value || 0) > 0
          return hasValue ? (
            <button
              type="button"
              className={styles.metricLink}
              onClick={() => handleOpenModal('interesados', resolvePeriodRange(row.date, viewType), labels.leads)}
            >
              {formatNumber(value)}
            </button>
          ) : (
            <span>{formatNumber(value)}</span>
          )
        }
      },
      {
        key: 'new_customers',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>{labels.customers}</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Nuevos)</div>
          </div>
        ),
        sortable: true,
        render: (value: number, row) => {
          const hasValue = (value || 0) > 0
          return hasValue ? (
            <button
              type="button"
              className={styles.metricLink}
              onClick={() => handleOpenModal('customers', resolvePeriodRange(row.date, viewType), `${labels.customers} nuevos`)}
            >
              {formatNumber(value)}
            </button>
          ) : (
            <span>{formatNumber(value)}</span>
          )
        }
      },
      {
        key: 'cac',
        header: `Costo por ${labels.customer}`,
        sortable: true,
        render: (value: number) => <span>{formatCurrency(value)}</span>
      },
      {
        key: 'appointments',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>Citas</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
          </div>
        ),
        sortable: true,
        visible: true,
        render: (value: number, row) => {
          const hasValue = (value || 0) > 0
          return hasValue ? (
            <button
              type="button"
              className={styles.metricLink}
              onClick={() => handleOpenModal('appointments', resolvePeriodRange(row.date, viewType), 'Citas')}
            >
              {formatNumber(value)}
            </button>
          ) : (
            <span>{formatNumber(value)}</span>
          )
        }
      },
      {
        key: 'clicks',
        header: 'Clicks',
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatNumber(value)}</span>
      },
      {
        key: 'reach',
        header: 'Alcance',
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatNumber(value)}</span>
      },
      {
        key: 'cpc',
        header: 'Costo por Clic',
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatCurrency(value)}</span>
      },
      {
        key: 'cpl',
        header: `Costo por ${labels.lead}`,
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatCurrency(value)}</span>
      },
      {
        key: 'visitors',
        header: 'Visitantes',
        sortable: true,
        visible: false,
        render: (value: number, item: TableRow) => {
          const hasVisitors = (value || 0) > 0 && visitorSource === 'tracking'
          return (
            <span
              className={hasVisitors ? styles.clickableNumber : ''}
              onClick={(e) => {
                if (hasVisitors) {
                  e.stopPropagation()
                  handleOpenVisitorsModal(item.date)
                }
              }}
            >
              {formatNumber(value)}
            </span>
          )
        }
      },
      {
        key: 'cpv',
        header: 'Costo por Visitante',
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatCurrency(value)}</span>
      },
      {
        key: 'webToInteresadosRate',
        header: `Web→${labels.leads} %`,
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      },
      {
        key: 'interesadosToApptsRate',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>{`${labels.leads}→Citas %`}</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
          </div>
        ),
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      },
      {
        key: 'apptsToSalesRate',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>Citas→Ventas %</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
          </div>
        ),
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      }
    ]
    if (!analyticsEnabled) {
      const visitorKeys = new Set(['visitors', 'cpv', 'webToInteresadosRate'])
      return columns.filter((column) => !visitorKeys.has(String(column.key)))
    }
    return columns
  }, [reportType, viewType, visitorSource, handleOpenModal, handleOpenVisitorsModal, labels.lead, labels.leads, analyticsEnabled])

  const summaryCards = summary ? [
    {
      label: 'Ingresos',
      value: formatCurrency(summary.payments.totalRevenue),
      delta: calcDelta(summary.payments.totalRevenue, summary.payments.totalRevenuePrev),
      deltaLabel: 'vs anterior',
      icon: <DollarSign className="text-[var(--color-text-tertiary)]" />
    },
    {
      label: 'Ganancia',
      value: formatCurrency(summary.payments.totalRevenue - summary.campaigns.spend),
      delta: calcDelta(
        summary.payments.totalRevenue - summary.campaigns.spend,
        summary.payments.totalRevenuePrev - summary.campaigns.spendPrev
      ),
      deltaLabel: 'vs anterior',
      icon: <Target className="text-[var(--color-text-tertiary)]" />
    },
    {
      label: 'Gastos',
      value: formatCurrency(summary.campaigns.spend),
      delta: calcDelta(summary.campaigns.spend, summary.campaigns.spendPrev),
      deltaLabel: 'vs anterior',
      icon: <Users className="text-[var(--color-text-tertiary)]" />
    },
    {
      label: 'Retorno de Inversión',
      value: summary.campaigns.spend > 0
        ? `${(summary.payments.totalRevenue / summary.campaigns.spend).toFixed(2)}x`
        : '0.00x',
      delta: calcDelta(
        summary.campaigns.spend > 0 ? summary.payments.totalRevenue / summary.campaigns.spend : 0,
        summary.campaigns.spendPrev > 0 ? summary.payments.totalRevenuePrev / summary.campaigns.spendPrev : 0
      ),
      deltaLabel: 'vs anterior',
      icon: <UserCheck className="text-[var(--color-text-tertiary)]" />
    }
  ] : []

  const handleMonthPresetChange = (value: string) => {
    setMonthPreset(value as typeof monthPreset)
  }

  const handleCustomMonthChange = (type: 'start' | 'end', value: number) => {
    if (type === 'start') {
      if (value <= customMonthEnd) {
        setCustomMonthStart(value)
      }
    } else {
      if (value >= customMonthStart) {
        setCustomMonthEnd(value)
      }
    }
  }

  const handleYearRangeChange = (key: 'start' | 'end', delta: number) => {
    setYearRange(prev => {
      const updated = { ...prev, [key]: prev[key] + delta }
      if (updated.start > updated.end) {
        return prev
      }
      return updated
    })
  }

  const metricsRangeLabel = formatRangeLabel(metricsRange)
  const closeModal = () => setModalState(prev => ({ ...prev, open: false }))

  return (
    <PageContainer>
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Reportes</h1>
            {metricsRangeLabel && <span className={styles.rangeLabel}>{metricsRangeLabel}</span>}
          </div>
          <div className={styles.filtersRow}>
            <div className={styles.rangeControlsInline}>
              {viewType === 'day' && (
                <div className={styles.datePickerControl}>
                  <DateRangePicker
                    startDate={toIsoDate(baseRange.start)}
                    endDate={toIsoDate(baseRange.end)}
                    onChange={(start, end) => setDateRange({
                      start: parseLocalDateString(start),
                      end: parseLocalDateString(end),
                      preset: 'custom'
                    })}
                  />
                </div>
              )}
              {viewType === 'month' && (
                <>
                  <ViewSelector
                    value={monthPreset}
                    options={monthRangeOptions}
                    onChange={handleMonthPresetChange}
                  />
                  {monthPreset === 'custom' && (
                    <div className={styles.customMonthControls}>
                      <label className={styles.customControl}>
                        Año
                        <input
                          type="number"
                          value={customMonthYear}
                          onChange={(event) => setCustomMonthYear(Number(event.target.value))}
                          className={styles.numberInput}
                        />
                      </label>
                      <label className={styles.customControl}>
                        Inicio
                        <select
                          value={customMonthStart}
                          onChange={(event) => handleCustomMonthChange('start', Number(event.target.value))}
                        >
                          {monthNames.map((name, index) => (
                          <option key={name} value={index}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.customControl}>
                      Fin
                      <select
                        value={customMonthEnd}
                        onChange={(event) => handleCustomMonthChange('end', Number(event.target.value))}
                      >
                        {monthNames.map((name, index) => (
                          <option key={name} value={index}>{name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </>
            )}
            {viewType === 'year' && (
              <div className={styles.yearControls}>
                <div className={styles.yearControlGroup}>
                  <span>Inicio</span>
                  <div className={styles.yearButtons}>
                    <Button variant="ghost" size="sm" onClick={() => handleYearRangeChange('start', -1)}>-</Button>
                    <span>{yearRange.start}</span>
                    <Button variant="ghost" size="sm" onClick={() => handleYearRangeChange('start', 1)}>+</Button>
                  </div>
                </div>
                <div className={styles.yearControlGroup}>
                  <span>Fin</span>
                  <div className={styles.yearButtons}>
                    <Button variant="ghost" size="sm" onClick={() => handleYearRangeChange('end', -1)}>-</Button>
                    <span>{yearRange.end}</span>
                    <Button variant="ghost" size="sm" onClick={() => handleYearRangeChange('end', 1)}>+</Button>
                  </div>
                </div>
              </div>
            )}
            </div>
            <div className={styles.tabsContainer}>
              <TabList
                tabs={viewTabs}
                activeTab={viewType}
                onTabChange={(value) => setViewType(value as ViewType)}
                variant="compact"
              />
              <TabList
                tabs={scopeTabs}
                activeTab={reportType}
                onTabChange={(value) => setReportType(value as ReportType)}
                variant="compact"
              />
              <TabList
                tabs={displayTabs}
                activeTab={displayMode}
                onTabChange={(value) => setDisplayMode(value as DisplayMode)}
                variant="compact"
              />
            </div>
          </div>
      </header>

      {displayMode === 'table' && summary && (
        <div className={styles.kpiRow}>
          {summaryCards.map(card => (
            <div key={card.label} className={styles.kpiStatic}>
              <KpiCard
                title={card.label}
                value={card.value}
                delta={card.delta}
                deltaLabel={card.deltaLabel}
                icon={card.icon}
              />
            </div>
          ))}
        </div>
      )}

      {displayMode === 'table' ? (
        <Card padding="none">
          <Table
            initialColumns={initialColumns}
            data={tableData}
            keyExtractor={(item) => item.id}
            loading={loadingMetrics}
            paginated
            pageSize={25}
            searchable
            searchPlaceholder="Buscar períodos..."
            tableId={`reports_metrics_${reportType}_${viewType}`}
            emptyMessage={loadingMetrics ? 'Cargando métricas...' : 'No hay datos para el rango seleccionado'}
          />
        </Card>
      ) : (
        <MetricsGrid
          metrics={metrics}
          loading={loadingMetrics}
          reportType={reportType}
          showVisitors={analyticsEnabled}
          viewType={viewType}
        />
      )}

        <ContactDetailsModal
          isOpen={modalState.open}
          onClose={closeModal}
          title={modalState.title}
          subtitle={modalState.subtitle}
          data={modalState.contacts.map(contact => ({
            id: contact.id,
            name: contact.name,
            email: contact.email,
            phone: contact.phone,
            created_at: contact.created_at,
            ltv: contact.ltv,
            payments: contact.payments,
            appointments: contact.appointments,
            source: contact.source,
            ad_name: contact.ad_name,
            ad_id: contact.ad_id
          }))}
          loading={modalState.loading}
          type={modalState.type === 'customers' ? 'sales' : modalState.type === 'sales' ? 'sales' : modalState.type === 'appointments' ? 'appointments' : 'interesados'}
        />

        {/* Modal de Visitantes */}
        {analyticsEnabled && (
          <VisitorDetailsModal
            isOpen={isVisitorsModalOpen}
            onClose={() => setIsVisitorsModalOpen(false)}
            title="Visitantes"
            subtitle={`Visitantes del ${visitorsModalDate}`}
            data={visitorsData}
            loading={visitorsModalLoading}
          />
        )}
      </div>
    </PageContainer>
  )
}

export default Reports
