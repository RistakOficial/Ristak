import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Card,
  KpiCard,
  Table,
  TabList,
  DateRangePicker,
  Button,
  ContactDetailsModal,
  VisitorDetailsModal,
  TransactionsModal,
  ViewSelector,
  PageContainer,
  Loading
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
  type ReportRange,
  type ManualBusinessExpense
} from '@/services/reportsService'
import { costsService, type Cost } from '@/services/costsService'
import { formatCurrency, formatNumber, formatDate, formatDateToISO, parseLocalDateString } from '@/utils/format'
import { useAppConfig, useChartHover, useMetaTimezone, useTableConfig } from '@/hooks'
import { DEFAULT_BAR_RADIUS, getTopRoundedBarPath } from '@/components/common/chartShapes'
import { ChartTooltip } from '@/components/common/ChartTooltip/ChartTooltip'
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
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer
} from 'recharts'

const monthNames = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]
const monthNamesShort = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sept', 'oct', 'nov', 'dic'
]

const MANUAL_BUSINESS_EXPENSES_COLUMN_KEY = 'businessExpenses'
const FIXED_BUSINESS_EXPENSES_COLUMN_KEY = 'fixedBusinessExpenses'
const MANUAL_BUSINESS_EXPENSES_CONFIG_KEY = 'report_manual_business_expenses_enabled'
const MS_PER_DAY = 24 * 60 * 60 * 1000

type ViewType = 'day' | 'month' | 'year'
type ReportType = 'cashflow' | 'attribution' | 'campaigns'
type DisplayMode = 'table' | 'metrics'
type ModalType = 'interesados' | 'sales' | 'appointments' | 'attendances' | 'customers'

type TableRow = {
  id: string
  date: string
  displayDate: string
  roas: number
  profit: number
  revenue: number
  spend: number
  businessExpenses: number
  fixedBusinessExpenses: number
  sales: number
  transactions: number
  new_customers: number
  leads: number
  appointments: number
  attendances: number
  clicks: number
  reach: number
  visitors: number
  cpc: number
  cpv: number
  cpl: number
  cpa: number
  cpaAttendance: number
  cac: number
  webToInteresadosRate: number
  interesadosToApptsRate: number
  apptsToAttendanceRate: number
  attendanceToSalesRate: number
  attendanceToCustomersRate: number
  apptsToSalesRate: number
}

// "Todos" agrupa por la fecha en que sucedió cada evento.
// "Al momento de registro" agrupa todo por fecha de creación del contacto (sin filtro de anuncios).
// "Identificados de anuncios" agrupa por fecha de creación + filtra solo contactos con ad_id.
const scopeTabs = [
  {
    value: 'cashflow',
    label: 'Todos',
    icon: <Layers size={16} />,
    description: 'Usa la fecha real de cada evento: pagos cuando se pagaron, citas cuando se agendaron y registros cuando ocurrieron.'
  },
  {
    value: 'attribution',
    label: 'Al momento de registro',
    icon: <Target size={16} />,
    description: 'Agrupa pagos, citas y ventas en la fecha en que se creó el contacto para medir qué registros terminaron convirtiendo.'
  },
  {
    value: 'campaigns',
    label: 'Identificados de anuncios',
    icon: <MousePointerClick size={16} />,
    description: 'Muestra solo contactos identificados desde anuncios y atribuye sus resultados al día en que se registraron.'
  }
]

const viewTabs = [
  { value: 'day', label: 'Día' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' }
]

const displayTabs = [
  {
    value: 'table',
    label: 'Histórico',
    icon: <TableIcon size={16} />,
    description: 'Vista de tabla para revisar cada periodo con sus ingresos, gastos, citas, clientes y demás métricas.'
  },
  {
    value: 'metrics',
    label: 'Métricas',
    icon: <BarChart3 size={16} />,
    description: 'Vista resumida por tarjetas y gráficas para comparar indicadores sin entrar al detalle de cada fila.'
  }
]

const reportDisplayModes: DisplayMode[] = ['table', 'metrics']
const reportViewTypes: ViewType[] = ['day', 'month', 'year']
const reportTypes: ReportType[] = ['cashflow', 'attribution', 'campaigns']

const isReportDisplayMode = (value?: string): value is DisplayMode =>
  reportDisplayModes.includes(value as DisplayMode)

const isReportViewType = (value?: string): value is ViewType =>
  reportViewTypes.includes(value as ViewType)

const isReportType = (value?: string): value is ReportType =>
  reportTypes.includes(value as ReportType)

const buildReportsPath = (displayMode: DisplayMode, viewType: ViewType, reportType: ReportType) =>
  `/reports/${displayMode}/${viewType}/${reportType}`

const parseReportsPath = (pathname: string) => {
  const parts = pathname.replace(/^\/reports\/?/, '').split('/').filter(Boolean)
  const displayMode = isReportDisplayMode(parts[0]) ? parts[0] : 'table'
  const viewType = isReportViewType(parts[1]) ? parts[1] : 'month'
  const reportType = isReportType(parts[2]) ? parts[2] : 'cashflow'

  return { displayMode, viewType, reportType }
}

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

const parseDateKeyParts = (value: string) => {
  const sanitized = value.includes('T') ? value.split('T')[0] : value
  const [yearRaw, monthRaw = '01', dayRaw = '01'] = sanitized.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null
  }

  return { year, month, day }
}

const toUtcDayIndex = (value: string) => {
  const parts = parseDateKeyParts(value)
  if (!parts) return null
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY)
}

const getLastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

const getManualExpenseRange = (expense: ManualBusinessExpense) => {
  const parts = parseDateKeyParts(expense.period_start)
  if (!parts) return null

  if (expense.period_type === 'day') {
    return { from: expense.period_start, to: expense.period_start }
  }

  if (expense.period_type === 'month') {
    const month = String(parts.month).padStart(2, '0')
    const lastDay = String(getLastDayOfMonth(parts.year, parts.month)).padStart(2, '0')
    return { from: `${parts.year}-${month}-01`, to: `${parts.year}-${month}-${lastDay}` }
  }

  return { from: `${parts.year}-01-01`, to: `${parts.year}-12-31` }
}

const roundCurrencyValue = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

// Los costos fijos configurados son MENSUALES: cada mes aporta su monto completo.
// Para cualquier rango objetivo (día, mes, año o rango libre) se prorratea mes a mes:
// cada mes contribuye monthlyValue * (díasDelMesDentroDelRango / díasTotalesDelMes).
// Así un día = monthlyValue / díasDelMes, un mes completo = monthlyValue
// y un año completo = monthlyValue * 12.
const calculateMonthlyFixedCostForRange = (
  targetRange: { from: string; to: string },
  monthlyValue: number
) => {
  if (!Number.isFinite(monthlyValue) || monthlyValue <= 0) return 0

  const startParts = parseDateKeyParts(targetRange.from)
  const endParts = parseDateKeyParts(targetRange.to)
  if (!startParts || !endParts) return 0

  const targetStart = toUtcDayIndex(targetRange.from)
  const targetEnd = toUtcDayIndex(targetRange.to)
  if (targetStart === null || targetEnd === null || targetEnd < targetStart) return 0

  let total = 0
  let year = startParts.year
  let month = startParts.month

  while (year < endParts.year || (year === endParts.year && month <= endParts.month)) {
    const daysInMonth = getLastDayOfMonth(year, month)
    const monthStart = toUtcDayIndex(`${year}-${String(month).padStart(2, '0')}-01`)

    if (monthStart !== null) {
      const monthEnd = monthStart + daysInMonth - 1
      const overlapStart = Math.max(targetStart, monthStart)
      const overlapEnd = Math.min(targetEnd, monthEnd)

      if (overlapEnd >= overlapStart) {
        const overlapDays = overlapEnd - overlapStart + 1
        total += (monthlyValue * overlapDays) / daysInMonth
      }
    }

    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return total
}

const calculateConfiguredBusinessCostsForRange = (
  targetRange: { from: string; to: string },
  costs: Cost[],
  revenue: number
) => {
  const total = costs.reduce((sum, cost) => {
    if (Number(cost.is_active) === 0) return sum

    const value = Number(cost.value || 0)
    if (!Number.isFinite(value) || value <= 0) return sum

    if (cost.calculation_type === 'fixed') {
      // Costo fijo mensual recurrente, prorrateado al periodo mostrado.
      return sum + calculateMonthlyFixedCostForRange(targetRange, value)
    }

    if (cost.calculation_type === 'percentage' && cost.applies_to === 'revenue') {
      return sum + (revenue * value) / 100
    }

    return sum
  }, 0)

  return roundCurrencyValue(total)
}

const calculateManualBusinessExpensesForRange = (
  targetRange: { from: string; to: string },
  expenses: ManualBusinessExpense[]
) => {
  const targetStart = toUtcDayIndex(targetRange.from)
  const targetEnd = toUtcDayIndex(targetRange.to)

  if (targetStart === null || targetEnd === null) return 0

  const total = expenses.reduce((sum, expense) => {
    const amount = Number(expense.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) return sum

    const sourceRange = getManualExpenseRange(expense)
    if (!sourceRange) return sum

    const sourceStart = toUtcDayIndex(sourceRange.from)
    const sourceEnd = toUtcDayIndex(sourceRange.to)
    if (sourceStart === null || sourceEnd === null || sourceEnd < sourceStart) return sum

    const overlapStart = Math.max(targetStart, sourceStart)
    const overlapEnd = Math.min(targetEnd, sourceEnd)
    if (overlapEnd < overlapStart) return sum

    const sourceDays = sourceEnd - sourceStart + 1
    const overlapDays = overlapEnd - overlapStart + 1
    return sum + (amount * overlapDays) / sourceDays
  }, 0)

  return roundCurrencyValue(total)
}

const getManualExpensePeriodStart = (period: string, viewType: ViewType) => {
  if (viewType === 'day') return period
  if (viewType === 'month') return `${period}-01`
  return `${period}-01-01`
}

const getManualExpenseRecordKey = (periodType: ViewType, periodStart: string) => `${periodType}:${periodStart}`

const parseManualExpenseInput = (value: string) => {
  const normalized = value.replace(/[$,\s]/g, '')
  if (!normalized) return 0

  const amount = Number(normalized)
  if (!Number.isFinite(amount) || amount < 0) return null

  return roundCurrencyValue(amount)
}

const computeRangeForView = (
  viewType: ViewType,
  baseRange: { start: Date; end: Date },
  monthPreset: 'last12' | 'thisYear' | 'custom',
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
      const start = startOfMonth(baseRange.start.getFullYear(), baseRange.start.getMonth())
      const end = endOfMonth(baseRange.end.getFullYear(), baseRange.end.getMonth())
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
  businessExpensesByPeriod?: Record<string, number>
  fixedBusinessExpensesByPeriod?: Record<string, number>
  applyManualBusinessExpenses?: boolean
  applyFixedBusinessExpenses?: boolean
}

// Componentes de gráfico personalizados con tooltip del Dashboard
interface MetricChartData {
  label: string
  [key: string]: number | string
}

interface SimpleLineChartProps {
  data: MetricChartData[]
  dataKeys: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
  height?: number | string
}

const SimpleLineChart: React.FC<SimpleLineChartProps> = ({ data, dataKeys, formatValue, height = '100%' }) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = React.useState<{ x: number; y: number } | null>(null)
  const activePointRef = React.useRef<{ [key: string]: { x: number; y: number } }>({})
  const gradientIdPrefix = React.useId().replace(/:/g, '')

  // Resetear cuando cambia el índice o deja de hacer hover
  React.useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = {}
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = {}
    }
  }, [isHovering, activeIndex])

  const resolvedPointPos = actualPointPos ?? null

  // Calcular offset dinámico del tooltip (igual que Dashboard)
  const tooltipVerticalOffset = React.useMemo(() => {
    if (!resolvedPointPos || !chartRef.current) {
      return 22
    }

    const rect = chartRef.current.getBoundingClientRect()
    const distanceFromTop = Math.max(0, resolvedPointPos.y - rect.top)
    const normalized = rect.height > 0 ? Math.min(Math.max(distanceFromTop / rect.height, 0), 1) : 0.5

    const IDEAL_MIN_GAP = 18
    const IDEAL_MAX_GAP = 54
    const TOP_CLEARANCE = 4

    const availableGap = Math.max(distanceFromTop - TOP_CLEARANCE, 0)

    if (availableGap <= IDEAL_MIN_GAP) {
      return availableGap
    }

    const idealGap = IDEAL_MIN_GAP + normalized * (IDEAL_MAX_GAP - IDEAL_MIN_GAP)
    const boundedGap = Math.min(
      Math.max(IDEAL_MIN_GAP, idealGap),
      Math.min(availableGap, IDEAL_MAX_GAP)
    )

    return boundedGap
  }, [resolvedPointPos, chartRef])

  return (
    <div ref={chartRef} className={styles.metricsChartCanvas} data-ristak-chart="report-line" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
          <defs>
            {dataKeys.map((dk) => (
              <linearGradient key={`gradient-${dk.key}`} id={`${gradientIdPrefix}-gradient-${dk.key}-line-reports`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-start, 0.18)" />
                <stop offset="50%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-mid, 0.1)" />
                <stop offset="100%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-end, 0.02)" />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="var(--design-chart-grid-dash, 3 3)" stroke="var(--design-chart-grid, var(--color-border-subtle))" opacity={1} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          {dataKeys.map((dk) => (
            <Area
              key={dk.key}
              type="monotone"
              dataKey={dk.key}
              stroke={dk.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientIdPrefix}-gradient-${dk.key}-line-reports)`}
              dot={(props: any) => {
                const isActive = props.index === activeIndex

                // Capturar la posición real del punto cuando está activo
                if (isActive && props.cx != null && props.cy != null) {
                  const rect = chartRef.current?.getBoundingClientRect()
                  if (rect) {
                    const pointX = rect.left + props.cx
                    const pointY = rect.top + props.cy
                    const pointKey = `${props.index}-${dk.key}`

                    // Solo guardar si no existe o cambió
                    const existing = activePointRef.current[pointKey]
                    if (!existing || existing.x !== pointX || existing.y !== pointY) {
                      activePointRef.current[pointKey] = { x: pointX, y: pointY }

                      // Usar requestAnimationFrame para evitar setState durante render
                      requestAnimationFrame(() => {
                        const allPoints = Object.values(activePointRef.current)
                        if (allPoints.length > 0) {
                          const highestPoint = allPoints.reduce((highest, current) =>
                            current.y < highest.y ? current : highest
                          )
                          setActualPointPos(highestPoint)
                        }
                      })
                    }
                  }
                }

                return (
                  <g>
                    <circle
                      cx={props.cx}
                      cy={props.cy}
                      r={10}
                      fill="transparent"
                      stroke="transparent"
                      data-chart-index={props.index}
                      data-chart-interactive="true"
                      style={{ pointerEvents: 'all' }}
                    />
                    <circle
                      cx={props.cx}
                      cy={props.cy}
                      r={isActive ? 7 : 0}
                      fill="var(--color-background-primary)"
                      stroke={dk.color}
                      strokeWidth={isActive ? 3 : 0}
                      opacity={isActive ? 1 : 0}
                      aria-hidden="true"
                      style={{
                        pointerEvents: 'none',
                        transition: 'all 150ms ease-out',
                        filter: isActive ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))' : 'none'
                      }}
                    />
                  </g>
                )
              }}
              activeDot={false}
              animationDuration={0}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <ChartTooltip
        active={isHovering && Boolean(resolvedPointPos)}
        data={activeData}
        pointPos={resolvedPointPos}
        series={dataKeys}
        formatValue={formatValue}
        verticalOffset={tooltipVerticalOffset}
      />
    </div>
  )
}

interface SimpleBarChartProps {
  data: MetricChartData[]
  dataKey: string
  label: string
  color: string
  formatValue: (value: number, key: string) => string
  height?: number | string
}

const SimpleBarChart: React.FC<SimpleBarChartProps> = ({ data, dataKey, label, color, formatValue, height = '100%' }) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = React.useState<{ x: number; y: number } | null>(null)
  const activePointRef = React.useRef<{ [key: string]: { x: number; y: number } }>({})

  // Resetear cuando cambia el índice o deja de hacer hover
  React.useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = {}
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = {}
    }
  }, [isHovering, activeIndex])

  const resolvedPointPos = actualPointPos ?? null

  // Calcular offset dinámico del tooltip (igual que Dashboard)
  const tooltipVerticalOffset = React.useMemo(() => {
    if (!resolvedPointPos || !chartRef.current) {
      return 22
    }

    const rect = chartRef.current.getBoundingClientRect()
    const distanceFromTop = Math.max(0, resolvedPointPos.y - rect.top)
    const normalized = rect.height > 0 ? Math.min(Math.max(distanceFromTop / rect.height, 0), 1) : 0.5

    const IDEAL_MIN_GAP = 18
    const IDEAL_MAX_GAP = 54
    const TOP_CLEARANCE = 4

    const availableGap = Math.max(distanceFromTop - TOP_CLEARANCE, 0)

    if (availableGap <= IDEAL_MIN_GAP) {
      return availableGap
    }

    const idealGap = IDEAL_MIN_GAP + normalized * (IDEAL_MAX_GAP - IDEAL_MIN_GAP)
    const boundedGap = Math.min(
      Math.max(IDEAL_MIN_GAP, idealGap),
      Math.min(availableGap, IDEAL_MAX_GAP)
    )

    return boundedGap
  }, [resolvedPointPos, chartRef])

  return (
    <div ref={chartRef} className={styles.metricsChartCanvas} data-ristak-chart="report-bar" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
          <CartesianGrid strokeDasharray="var(--design-chart-grid-dash, 3 3)" stroke="var(--design-chart-grid, var(--color-border-subtle))" opacity={1} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          <Bar
            dataKey={dataKey}
            fill={color}
            radius={[DEFAULT_BAR_RADIUS, DEFAULT_BAR_RADIUS, 0, 0]}
            shape={(props: any) => {
              const { x, y, width, height, index } = props
              const isActive = index === activeIndex
              const rawValue = Number(data[index]?.[dataKey] ?? 0)
              const hasValue = Number.isFinite(rawValue) && rawValue > 0
              const barPath = hasValue ? getTopRoundedBarPath(x, y, width, height) : ''

              // Capturar la posición real del punto cuando está activo
              if (isActive && hasValue) {
                const rect = chartRef.current?.getBoundingClientRect()
                if (rect) {
                  const pointX = rect.left + x + width / 2
                  const pointY = rect.top + y
                  const pointKey = `${index}-${dataKey}`

                  // Solo guardar si no existe o cambió
                  const existing = activePointRef.current[pointKey]
                  if (!existing || existing.x !== pointX || existing.y !== pointY) {
                    activePointRef.current[pointKey] = { x: pointX, y: pointY }

                    // Usar requestAnimationFrame para evitar setState durante render
                    requestAnimationFrame(() => {
                      const allPoints = Object.values(activePointRef.current)
                      if (allPoints.length > 0) {
                        const highestPoint = allPoints.reduce((highest, current) =>
                          current.y < highest.y ? current : highest
                        )
                        setActualPointPos(highestPoint)
                      }
                    })
                  }
                }
              }

              return (
                <g>
                  {barPath && (
                    <path
                      d={barPath}
                      fill={color}
                      opacity={isActive ? 1 : 0.9}
                      style={{ transition: 'opacity 150ms ease-out' }}
                    />
                  )}
                  {/* Área interactiva invisible para detección de hover */}
                  {hasValue && (
                    <rect
                      x={x}
                      y={y}
                      width={width}
                      height={height}
                      fill="transparent"
                      data-chart-index={index}
                      data-chart-interactive="true"
                      style={{ pointerEvents: 'auto', cursor: 'default' }}
                    />
                  )}
                  {/* Dot invisible en el centro superior de cada barra para posicionamiento */}
                  {hasValue && (
                    <circle
                      cx={x + width / 2}
                      cy={y}
                      r={0}
                      data-chart-index={index}
                      data-chart-interactive="true"
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                </g>
              )
            }}
          />
        </BarChart>
      </ResponsiveContainer>
      <ChartTooltip
        active={isHovering && Boolean(resolvedPointPos)}
        data={activeData}
        pointPos={resolvedPointPos}
        series={[{ key: dataKey, label, color }]}
        formatValue={formatValue}
        verticalOffset={tooltipVerticalOffset}
      />
    </div>
  )
}

interface SimpleAreaChartProps {
  data: MetricChartData[]
  dataKeys: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
  height?: number | string
}

const SimpleAreaChart: React.FC<SimpleAreaChartProps> = ({ data, dataKeys, formatValue, height = '100%' }) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = React.useState<{ x: number; y: number } | null>(null)
  const activePointRef = React.useRef<{ [key: string]: { x: number; y: number } }>({})
  const gradientIdPrefix = React.useId().replace(/:/g, '')

  // Resetear cuando cambia el índice o deja de hacer hover
  React.useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = {}
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = {}
    }
  }, [isHovering, activeIndex])

  const resolvedPointPos = actualPointPos ?? null

  // Calcular offset dinámico del tooltip (igual que Dashboard)
  const tooltipVerticalOffset = React.useMemo(() => {
    if (!resolvedPointPos || !chartRef.current) {
      return 22
    }

    const rect = chartRef.current.getBoundingClientRect()
    const distanceFromTop = Math.max(0, resolvedPointPos.y - rect.top)
    const normalized = rect.height > 0 ? Math.min(Math.max(distanceFromTop / rect.height, 0), 1) : 0.5

    const IDEAL_MIN_GAP = 18
    const IDEAL_MAX_GAP = 54
    const TOP_CLEARANCE = 4

    const availableGap = Math.max(distanceFromTop - TOP_CLEARANCE, 0)

    if (availableGap <= IDEAL_MIN_GAP) {
      return availableGap
    }

    const idealGap = IDEAL_MIN_GAP + normalized * (IDEAL_MAX_GAP - IDEAL_MIN_GAP)
    const boundedGap = Math.min(
      Math.max(IDEAL_MIN_GAP, idealGap),
      Math.min(availableGap, IDEAL_MAX_GAP)
    )

    return boundedGap
  }, [resolvedPointPos, chartRef])

  return (
    <div ref={chartRef} className={styles.metricsChartCanvas} data-ristak-chart="report-area" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
          <defs>
            {dataKeys.map((dk) => (
              <linearGradient key={`gradient-${dk.key}`} id={`${gradientIdPrefix}-gradient-${dk.key}-reports`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-start, 0.18)" />
                <stop offset="50%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-mid, 0.1)" />
                <stop offset="100%" stopColor={dk.color} stopOpacity="var(--design-chart-area-opacity-end, 0.02)" />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="var(--design-chart-grid-dash, 3 3)" stroke="var(--design-chart-grid, var(--color-border-subtle))" opacity={1} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontFamily: 'var(--font-app)' }} stroke="var(--design-chart-grid, var(--color-text-tertiary))" />
          {dataKeys.map((dk) => (
            <Area
              key={dk.key}
              type="monotone"
              dataKey={dk.key}
              stroke={dk.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={`url(#${gradientIdPrefix}-gradient-${dk.key}-reports)`}
              dot={(props: any) => {
                const isActive = props.index === activeIndex

                // Capturar la posición real del punto cuando está activo
                if (isActive && props.cx != null && props.cy != null) {
                  const rect = chartRef.current?.getBoundingClientRect()
                  if (rect) {
                    const pointX = rect.left + props.cx
                    const pointY = rect.top + props.cy
                    const pointKey = `${props.index}-${dk.key}`

                    // Solo guardar si no existe o cambió
                    const existing = activePointRef.current[pointKey]
                    if (!existing || existing.x !== pointX || existing.y !== pointY) {
                      activePointRef.current[pointKey] = { x: pointX, y: pointY }

                      // Usar requestAnimationFrame para evitar setState durante render
                      requestAnimationFrame(() => {
                        const allPoints = Object.values(activePointRef.current)
                        if (allPoints.length > 0) {
                          const highestPoint = allPoints.reduce((highest, current) =>
                            current.y < highest.y ? current : highest
                          )
                          setActualPointPos(highestPoint)
                        }
                      })
                    }
                  }
                }

                return (
                  <g>
                    <circle
                      cx={props.cx}
                      cy={props.cy}
                      r={10}
                      fill="transparent"
                      stroke="transparent"
                      data-chart-index={props.index}
                      data-chart-interactive="true"
                      style={{ pointerEvents: 'all' }}
                    />
                    <circle
                      cx={props.cx}
                      cy={props.cy}
                      r={isActive ? 7 : 0}
                      fill="var(--color-background-primary)"
                      stroke={dk.color}
                      strokeWidth={isActive ? 3 : 0}
                      opacity={isActive ? 1 : 0}
                      aria-hidden="true"
                      style={{
                        pointerEvents: 'none',
                        transition: 'all 150ms ease-out',
                        filter: isActive ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))' : 'none'
                      }}
                    />
                  </g>
                )
              }}
              activeDot={false}
              animationDuration={0}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <ChartTooltip
        active={isHovering && Boolean(resolvedPointPos)}
        data={activeData}
        pointPos={resolvedPointPos}
        series={dataKeys}
        formatValue={formatValue}
        verticalOffset={tooltipVerticalOffset}
      />
    </div>
  )
}

const MetricsGrid: React.FC<MetricsGridProps> = ({
  metrics,
  loading,
  reportType,
  showVisitors,
  viewType,
  businessExpensesByPeriod = {},
  fixedBusinessExpensesByPeriod = {},
  applyManualBusinessExpenses = false,
  applyFixedBusinessExpenses = false
}) => {
  const timezoneInfo = useMetaTimezone()
  const { labels } = useLabels()
  const totals = metrics.reduce((acc, m) => {
    const businessExpenses = applyManualBusinessExpenses ? (businessExpensesByPeriod[m.date] || 0) : 0
    const fixedBusinessExpenses = applyFixedBusinessExpenses ? (fixedBusinessExpensesByPeriod[m.date] || 0) : 0

    return {
      spend: acc.spend + m.spend,
      revenue: acc.revenue + m.revenue,
      businessExpenses: acc.businessExpenses + businessExpenses,
      fixedBusinessExpenses: acc.fixedBusinessExpenses + fixedBusinessExpenses,
      leads: acc.leads + m.leads,
      sales: acc.sales + m.sales,
      clicks: acc.clicks + m.clicks,
      visitors: acc.visitors + m.visitors,
      appointments: acc.appointments + m.appointments,
      attendances: acc.attendances + (m.attendances || 0),
      new_customers: acc.new_customers + m.new_customers
    }
  }, {
    spend: 0,
    revenue: 0,
    businessExpenses: 0,
    fixedBusinessExpenses: 0,
    leads: 0,
    sales: 0,
    clicks: 0,
    visitors: 0,
    appointments: 0,
    attendances: 0,
    new_customers: 0
  })

  const profit = totals.revenue - totals.spend - totals.businessExpenses - totals.fixedBusinessExpenses
  const roas = totals.spend > 0 ? totals.revenue / totals.spend : 0
  const roi = totals.spend > 0 ? (profit / totals.spend) * 100 : 0
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0
  const epc = totals.clicks > 0 ? totals.revenue / totals.clicks : 0
  const cpl = totals.leads > 0 ? totals.spend / totals.leads : 0
  const epl = totals.leads > 0 ? totals.revenue / totals.leads : 0
  const cpa = totals.appointments > 0 ? totals.spend / totals.appointments : 0
  const cpaAttendance = totals.attendances > 0 ? totals.spend / totals.attendances : 0
  const cac = totals.new_customers > 0 ? totals.spend / totals.new_customers : 0
  const aov = totals.sales > 0 ? totals.revenue / totals.sales : 0
  const transactionsPerCustomer = totals.new_customers > 0 ? totals.sales / totals.new_customers : 0
  const webToInteresado = totals.visitors > 0 ? (totals.leads / totals.visitors) * 100 : 0
  const interesadoToAppt = totals.leads > 0 ? (totals.appointments / totals.leads) * 100 : 0
  const apptToAttendance = totals.appointments > 0 ? (totals.attendances / totals.appointments) * 100 : 0
  const attendanceToSale = totals.attendances > 0 ? (totals.sales / totals.attendances) * 100 : 0
  const attendanceToCustomer = totals.attendances > 0 ? (totals.new_customers / totals.attendances) * 100 : 0
  const salesLabel = reportType === 'cashflow' ? 'Transacciones' : 'Ventas'

  // Preparar datos para los gráficos (formato compatible con useChartHover)
  // Ordenar cronológicamente (fecha más antigua a la izquierda, más reciente a la derecha)
  const chartData = React.useMemo(() => {
    return metrics.slice().sort((a, b) => {
      const dateA = new Date(a.date).getTime()
      const dateB = new Date(b.date).getTime()
      return dateA - dateB // Orden ascendente
    }).map(m => {
      const businessExpenses = applyManualBusinessExpenses ? (businessExpensesByPeriod[m.date] || 0) : 0
      const fixedBusinessExpenses = applyFixedBusinessExpenses ? (fixedBusinessExpensesByPeriod[m.date] || 0) : 0

      return {
        // Ajustar fecha con timezone de Meta si hay discrepancia
        label: formatPeriodLabel(
          timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(m.date) : m.date,
          viewType,
          { includeYear: false }
        ),
        clicks: m.clicks,
        visitors: m.visitors,
        leads: m.leads,
        appointments: m.appointments,
        attendances: m.attendances || 0,
        sales: m.sales,
        new_customers: m.new_customers,
        revenue: m.revenue,
        spend: m.spend,
        businessExpenses,
        fixedBusinessExpenses,
        profit: m.revenue - m.spend - businessExpenses - fixedBusinessExpenses
      }
    })
  }, [metrics, timezoneInfo, viewType, businessExpensesByPeriod, fixedBusinessExpensesByPeriod, applyManualBusinessExpenses, applyFixedBusinessExpenses])

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

  const trafficKeys = [
    { key: 'clicks', label: 'Clicks', color: 'var(--design-chart-tertiary, #3b82f6)' }
  ]
  if (showVisitors) {
    trafficKeys.push({ key: 'visitors', label: 'Visitantes', color: 'var(--design-chart-accent, #8b5cf6)' })
  }

  const allMetricGroups = React.useMemo(() => [
    {
      title: 'Tráfico',
      icon: <MousePointerClick size={18} />,
      items: trafficItems,
      chart: (
        <SimpleLineChart
          data={chartData}
          dataKeys={trafficKeys}
          formatValue={(value) => formatNumber(value)}
        />
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
        { label: 'Costo por Cita', value: formatCurrency(cpa) },
        { label: `${labels.leads}→Citas %`, value: `${interesadoToAppt.toFixed(1)}%` },
        { label: 'Asistencias', value: formatNumber(totals.attendances) },
        { label: 'Costo por Asistencia', value: formatCurrency(cpaAttendance) },
        { label: 'Citas→Asistencias %', value: `${apptToAttendance.toFixed(1)}%` },
        { label: salesLabel, value: formatNumber(totals.sales) },
        { label: `Asistencias→${salesLabel} %`, value: `${attendanceToSale.toFixed(1)}%` }
      ],
      chart: (
        <SimpleLineChart
          data={chartData}
          dataKeys={[
            { key: 'leads', label: labels.leads, color: 'var(--design-chart-primary, #10b981)' },
            { key: 'appointments', label: 'Citas', color: 'var(--design-chart-warning, #f59e0b)' },
            { key: 'attendances', label: 'Asistencias', color: 'var(--design-chart-tertiary, #3b82f6)' },
            { key: 'sales', label: 'Ventas', color: 'var(--design-chart-danger, #ef4444)' }
          ]}
          formatValue={(value) => formatNumber(value)}
        />
      )
    },
    {
      title: labels.customers,
      icon: <UserCheck size={18} />,
      items: [
        { label: `${labels.customers} Nuevos`, value: formatNumber(totals.new_customers) },
        { label: `Costo por ${labels.customer}`, value: formatCurrency(cac) },
        { label: `Asistencias→${labels.customers} %`, value: `${attendanceToCustomer.toFixed(1)}%` },
        { label: 'Total de Transacciones', value: formatNumber(totals.sales) },
        { label: `Transacciones por ${labels.customer}`, value: transactionsPerCustomer.toFixed(1) },
        { label: 'Ticket Promedio', value: formatCurrency(aov) }
      ],
      chart: (
        <SimpleBarChart
          data={chartData}
          dataKey="new_customers"
          label={`${labels.customers} Nuevos`}
          color="var(--design-chart-tertiary, #06b6d4)"
          formatValue={(value) => formatNumber(value)}
        />
      )
    },
    {
      title: 'Finanzas',
      icon: <DollarSign size={18} />,
      items: [
        { label: 'Ingresos', value: formatCurrency(totals.revenue) },
        { label: 'Gasto en Anuncios', value: formatCurrency(totals.spend) },
        ...(applyFixedBusinessExpenses ? [{ label: 'Gastos fijos', value: formatCurrency(totals.fixedBusinessExpenses) }] : []),
        ...(applyManualBusinessExpenses ? [{ label: 'Costos variables', value: formatCurrency(totals.businessExpenses) }] : []),
        { label: 'Ganancias Netas', value: formatCurrency(profit) },
        { label: 'Transacciones', value: formatNumber(totals.sales) },
        { label: 'Retorno de Inversión', value: `${roas.toFixed(2)}x` },
        { label: 'ROI', value: `${roi.toFixed(1)}%` }
      ],
      chart: (
        <SimpleAreaChart
          data={chartData}
          dataKeys={[
            { key: 'revenue', label: 'Ingresos', color: 'var(--design-chart-primary, #10b981)' },
            { key: 'spend', label: 'Gastos', color: 'var(--design-chart-danger, #ef4444)' },
            { key: 'profit', label: 'Ganancias', color: 'var(--design-chart-tertiary, #3b82f6)' }
          ]}
          formatValue={(value) => formatCurrency(value)}
        />
      )
    }
  ], [chartData, trafficItems, trafficKeys, labels, totals, reportType, profit, roas, roi, cac, aov, transactionsPerCustomer, cpl, epl, cpa, cpaAttendance, interesadoToAppt, apptToAttendance, attendanceToSale, attendanceToCustomer, salesLabel, applyManualBusinessExpenses, applyFixedBusinessExpenses])

  // Filtrar la tarjeta de "Tráfico" si showVisitors es false (dominio .onrender.com)
  const metricGroups = showVisitors
    ? allMetricGroups
    : allMetricGroups.filter(group => group.title !== 'Tráfico')

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
              <table className={styles.metricsTable} data-ristak-table-element>
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

interface BusinessExpenseCellProps {
  value: number
  row: TableRow
  saving: boolean
  onCommit: (row: TableRow, value: string) => Promise<number | null>
}

const formatBusinessExpenseDraft = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundCurrencyValue(value))
}

const BusinessExpenseCell: React.FC<BusinessExpenseCellProps> = ({ value, row, saving, onCommit }) => {
  const [draft, setDraft] = React.useState(formatBusinessExpenseDraft(value))
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) {
      setDraft(formatBusinessExpenseDraft(value))
    }
  }, [value, focused])

  const handleCommit = async () => {
    const savedAmount = await onCommit(row, draft)
    if (savedAmount !== null) {
      setDraft(formatBusinessExpenseDraft(savedAmount))
    }
  }

  return (
    <div className={styles.businessExpenseInputShell} onClick={(event) => event.stopPropagation()}>
      <span className={styles.businessExpensePrefix}>$</span>
      <input
        className={styles.businessExpenseInput}
        value={draft}
        inputMode="decimal"
        aria-label={`Costos variables para ${row.displayDate}`}
        placeholder="0.00"
        disabled={saving}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setDraft(formatBusinessExpenseDraft(value))
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void handleCommit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(formatBusinessExpenseDraft(value))
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

export const Reports: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { dateRange, setDateRange } = useDateRange()
  const { showToast } = useNotification()
  const { labels } = useLabels()
  const routeState = useMemo(() => parseReportsPath(location.pathname), [location.pathname])

  // Detectar discrepancia de timezone con Meta
  const timezoneInfo = useMetaTimezone()

  // Sistema híbrido de configuración
  const [visitorSourceConfig] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')
  const [manualBusinessExpensesEnabledConfig] = useAppConfig<string | number | boolean>(
    MANUAL_BUSINESS_EXPENSES_CONFIG_KEY,
    '0'
  )

  const visitorSource = visitorSourceConfig
  const analyticsEnabled = parseAnalyticsFlag(showAnalyticsConfig)

  const [reportType, setReportType] = useState<ReportType>(routeState.reportType)
  const reportTypeRef = React.useRef<ReportType>(reportType)

  useEffect(() => {
    reportTypeRef.current = reportType
  }, [reportType])
  const [viewType, setViewType] = useState<ViewType>(routeState.viewType)
  const [displayMode, setDisplayMode] = useState<DisplayMode>(routeState.displayMode)
  const [monthPreset, setMonthPreset] = useState<'last12' | 'thisYear' | 'custom'>('last12')
  const [yearRange, setYearRange] = useState(defaultYearRange)

  const [metrics, setMetrics] = useState<ReportMetricRow[]>([])
  const [metricsRange, setMetricsRange] = useState<ReportRange | null>(null)
  const [summary, setSummary] = useState<ReportsSummary | null>(null)
  const [loadingMetrics, setLoadingMetrics] = useState(false)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [hasLoadedMetrics, setHasLoadedMetrics] = useState(false)
  const [hasLoadedSummary, setHasLoadedSummary] = useState(false)

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

  // Estado para modal de transacciones
  const [transactionsModalState, setTransactionsModalState] = useState<{
    open: boolean
    loading: boolean
    title: string
    subtitle: string
    transactions: any[]
    range?: { from: string; to: string }
  }>({
    open: false,
    loading: false,
    title: 'Transacciones',
    subtitle: '',
    transactions: []
  })

  useEffect(() => {
    const nextPath = buildReportsPath(routeState.displayMode, routeState.viewType, routeState.reportType)
    if (location.pathname !== nextPath) {
      navigate({ pathname: nextPath, search: location.search }, { replace: true })
      return
    }

    setDisplayMode(current => current === routeState.displayMode ? current : routeState.displayMode)
    setViewType(current => current === routeState.viewType ? current : routeState.viewType)
    setReportType(current => current === routeState.reportType ? current : routeState.reportType)
  }, [location.pathname, location.search, navigate, routeState.displayMode, routeState.reportType, routeState.viewType])

  const navigateReportsView = useCallback((next: {
    displayMode?: DisplayMode
    viewType?: ViewType
    reportType?: ReportType
  }) => {
    const nextDisplayMode = next.displayMode || displayMode
    const nextViewType = next.viewType || viewType
    const nextReportType = next.reportType || reportType
    const nextPath = buildReportsPath(nextDisplayMode, nextViewType, nextReportType)

    if (location.pathname === nextPath) return
    navigate({ pathname: nextPath, search: location.search })
  }, [displayMode, location.pathname, location.search, navigate, reportType, viewType])

  const baseRange = {
    start: dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start),
    end: dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  }

  const apiRange = computeRangeForView(
    viewType,
    baseRange,
    monthPreset,
    yearRange
  )

  // 'all' = agrupa por fecha del evento
  // 'attribution' = agrupa por fecha de creación del contacto (todos los contactos)
  // 'campaigns' = agrupa por fecha de creación del contacto (solo con ad_id)
  const scopeParam = reportType === 'campaigns' ? 'campaigns' : reportType === 'attribution' ? 'attribution' : 'all'
  const reportsTableId = `reports_metrics_${reportType}_${viewType}`
  const [reportsTableConfig] = useTableConfig<Array<{ id: string; visible: boolean; order?: number }>>(reportsTableId)

  const manualBusinessExpensesEnabled = parseAnalyticsFlag(manualBusinessExpensesEnabledConfig)
  const manualBusinessExpensesColumnVisible = useMemo(() => {
    if (!Array.isArray(reportsTableConfig)) return false
    const columnConfig = reportsTableConfig.find((column) => column.id === MANUAL_BUSINESS_EXPENSES_COLUMN_KEY)
    return Boolean(columnConfig?.visible)
  }, [reportsTableConfig])
  const fixedBusinessExpensesColumnVisible = useMemo(() => {
    if (!Array.isArray(reportsTableConfig)) return true
    const columnConfig = reportsTableConfig.find((column) => column.id === FIXED_BUSINESS_EXPENSES_COLUMN_KEY)
    return columnConfig ? columnConfig.visible !== false : true
  }, [reportsTableConfig])
  const applyManualBusinessExpenses = manualBusinessExpensesEnabled && manualBusinessExpensesColumnVisible
  const applyFixedBusinessExpenses = fixedBusinessExpensesColumnVisible

  const [manualBusinessExpenses, setManualBusinessExpenses] = useState<ManualBusinessExpense[]>([])
  const [configuredCosts, setConfiguredCosts] = useState<Cost[]>([])
  const [savingManualBusinessExpenseKey, setSavingManualBusinessExpenseKey] = useState<string | null>(null)

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
        setHasLoadedMetrics(true)
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
        setHasLoadedSummary(true)
      }
    }

    fetchSummary()
  }, [apiRange.from, apiRange.to, scopeParam, dateRange])

  const loadManualBusinessExpenses = useCallback(async () => {
    try {
      const expenses = await reportsService.getManualBusinessExpenses()
      setManualBusinessExpenses(expenses)
    } catch {
      setManualBusinessExpenses([])
    }
  }, [])

  useEffect(() => {
    loadManualBusinessExpenses()
  }, [loadManualBusinessExpenses])

  const loadConfiguredCosts = useCallback(async () => {
    try {
      const costs = await costsService.getAllCosts()
      setConfiguredCosts(costs)
    } catch {
      setConfiguredCosts([])
    }
  }, [])

  useEffect(() => {
    loadConfiguredCosts()
  }, [loadConfiguredCosts])

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

  const businessExpensesByPeriod = useMemo(() => {
    const expensesByPeriod: Record<string, number> = {}

    metrics.forEach((item) => {
      expensesByPeriod[item.date] = calculateManualBusinessExpensesForRange(
        resolvePeriodRange(item.date, viewType),
        manualBusinessExpenses
      )
    })

    return expensesByPeriod
  }, [metrics, viewType, manualBusinessExpenses])

  const fixedBusinessExpensesByPeriod = useMemo(() => {
    const expensesByPeriod: Record<string, number> = {}

    metrics.forEach((item) => {
      expensesByPeriod[item.date] = calculateConfiguredBusinessCostsForRange(
        resolvePeriodRange(item.date, viewType),
        configuredCosts,
        item.revenue
      )
    })

    return expensesByPeriod
  }, [metrics, viewType, configuredCosts, apiRange])

  const manualBusinessExpensesTotalForRange = useMemo(() => (
    calculateManualBusinessExpensesForRange(apiRange, manualBusinessExpenses)
  ), [apiRange, manualBusinessExpenses])

  const fixedBusinessExpensesTotalForRange = useMemo(() => {
    const revenue = summary?.payments.totalRevenue ?? metrics.reduce((sum, item) => sum + item.revenue, 0)
    return calculateConfiguredBusinessCostsForRange(apiRange, configuredCosts, revenue)
  }, [apiRange, configuredCosts, summary?.payments.totalRevenue, metrics])

  const handleSaveBusinessExpense = useCallback(async (row: TableRow, rawValue: string): Promise<number | null> => {
    const amount = parseManualExpenseInput(rawValue)

    if (amount === null) {
      showToast('warning', 'Gasto inválido', 'Ingresa un monto positivo')
      return null
    }

    const periodStart = getManualExpensePeriodStart(row.date, viewType)
    const expenseKey = getManualExpenseRecordKey(viewType, periodStart)

    setSavingManualBusinessExpenseKey(expenseKey)
    try {
      const result = await reportsService.saveManualBusinessExpense({
        period_type: viewType,
        period_start: periodStart,
        amount
      })

      setManualBusinessExpenses((current) => {
        const next = current.filter((expense) => (
          getManualExpenseRecordKey(expense.period_type, expense.period_start) !== expenseKey
        ))

        if (result.expense) {
          next.push(result.expense)
        }

        return next
      })
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el gasto', error?.message || 'Intenta nuevamente')
      return null
    } finally {
      setSavingManualBusinessExpenseKey(null)
    }

    return amount
  }, [showToast, viewType])

  const tableData: TableRow[] = useMemo(() => (
    metrics.map((item, index) => {
      const businessExpenses = businessExpensesByPeriod[item.date] || 0
      const fixedBusinessExpenses = fixedBusinessExpensesByPeriod[item.date] || 0
      const profit = item.revenue -
        item.spend -
        (applyManualBusinessExpenses ? businessExpenses : 0) -
        (applyFixedBusinessExpenses ? fixedBusinessExpenses : 0)
      const cpc = item.clicks > 0 ? item.spend / item.clicks : 0
      const cpv = item.visitors > 0 ? item.spend / item.visitors : 0
      const cpl = item.leads > 0 ? item.spend / item.leads : 0
      const cpa = item.appointments > 0 ? item.spend / item.appointments : 0
      const cpaAttendance = (item.attendances || 0) > 0 ? item.spend / (item.attendances || 0) : 0
      const cac = item.new_customers > 0 ? item.spend / item.new_customers : 0
      const webToInteresadosRate = item.visitors > 0 ? (item.leads / item.visitors) * 100 : 0
      const interesadosToApptsRate = item.leads > 0 ? (item.appointments / item.leads) * 100 : 0
      const apptsToAttendanceRate = item.appointments > 0 ? ((item.attendances || 0) / item.appointments) * 100 : 0
      const attendanceToSalesRate = (item.attendances || 0) > 0 ? (item.sales / (item.attendances || 0)) * 100 : 0
      const attendanceToCustomersRate = (item.attendances || 0) > 0 ? (item.new_customers / (item.attendances || 0)) * 100 : 0
      const apptsToSalesRate = item.appointments > 0 ? (item.sales / item.appointments) * 100 : 0

      return {
        id: `${item.date}-${index}`,
        date: item.date,
        displayDate: formatPeriodLabel(
          timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(item.date) : item.date,
          viewType,
          { includeYear: includeYearForTable }
        ),
        roas: item.roas,
        profit,
        revenue: item.revenue,
        spend: item.spend,
        businessExpenses,
        fixedBusinessExpenses,
        sales: item.sales,
        transactions: item.sales, // En vista "Todos" sales es el conteo de transacciones
        new_customers: item.new_customers,
        leads: item.leads,
        appointments: item.appointments,
        attendances: item.attendances || 0,
        clicks: item.clicks,
        reach: item.reach,
        visitors: item.visitors,
        cpc,
        cpv,
        cpl,
        cpa,
        cpaAttendance,
        cac,
        webToInteresadosRate,
        interesadosToApptsRate,
        apptsToAttendanceRate,
        attendanceToSalesRate,
        attendanceToCustomersRate,
        apptsToSalesRate
      }
    }).sort((a, b) => {
      // Ordenar por fecha descendente (más reciente primero) sin activar indicador visual
      const dateA = new Date(a.date).getTime()
      const dateB = new Date(b.date).getTime()
      return dateB - dateA
    })
  ), [metrics, viewType, includeYearForTable, timezoneInfo, businessExpensesByPeriod, fixedBusinessExpensesByPeriod, applyManualBusinessExpenses, applyFixedBusinessExpenses])

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
              : type === 'attendances'
                ? 'Asistencias'
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
      const currentModalType = modalState.type
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
            type: currentModalType === 'customers' ? 'customers' : currentModalType,
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

  // Función para abrir modal de transacciones
  const handleOpenTransactionsModal = useCallback(async (range?: { from: string; to: string }) => {
    const from = range?.from ?? apiRange.from
    const to = range?.to ?? apiRange.to

    setTransactionsModalState({
      open: true,
      loading: true,
      title: 'Transacciones',
      subtitle: `${formatPeriodLabel(from, 'day', { includeYear: true })} – ${formatPeriodLabel(to, 'day', { includeYear: true })}`,
      transactions: [],
      range
    })

    try {
      const response = await fetch(
        `/api/reports/transactions?` + new URLSearchParams({
          from,
          to
        })
      )

      if (response.ok) {
        const result = await response.json()
        setTransactionsModalState(prev => ({
          ...prev,
          transactions: result.data?.transactions || [],
          loading: false
        }))
      } else {
        setTransactionsModalState(prev => ({ ...prev, transactions: [], loading: false }))
        showToast('error', 'No se pudieron cargar las transacciones', 'Intenta nuevamente')
      }
    } catch (error) {
      setTransactionsModalState(prev => ({ ...prev, transactions: [], loading: false }))
      showToast('error', 'Error al cargar transacciones', 'Verifica tu conexión')
    }
  }, [apiRange.from, apiRange.to, showToast])

  // Función para abrir modal de visitantes
  const handleOpenVisitorsModal = useCallback(async (date: string) => {
    if (!analyticsEnabled) return

    setVisitorsModalLoading(true)
    setIsVisitorsModalOpen(true)

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
        key: FIXED_BUSINESS_EXPENSES_COLUMN_KEY,
        header: 'Costos fijos',
        sortable: true,
        visible: true,
        width: '160px',
        render: (value: number) => <span className={styles.secondaryText}>{formatCurrency(value)}</span>
      },
      {
        key: MANUAL_BUSINESS_EXPENSES_COLUMN_KEY,
        header: 'Costos variables',
        sortable: true,
        visible: false,
        width: '160px',
        render: (value: number, row) => {
          const periodStart = getManualExpensePeriodStart(row.date, viewType)
          const expenseKey = getManualExpenseRecordKey(viewType, periodStart)

          return (
            <BusinessExpenseCell
              value={value}
              row={row}
              saving={savingManualBusinessExpenseKey === expenseKey}
              onCommit={handleSaveBusinessExpense}
            />
          )
        }
      },
      {
        key: 'spend',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>Invertido</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Anuncios)</div>
          </div>
        ),
        sortable: true,
        render: (value: number) => <span className={styles.secondaryText}>{formatCurrency(value)}</span>
      },
      {
        key: 'revenue',
        header: 'Recolectado',
        sortable: true,
        render: (value: number, row) => (
          <span className={`${styles.financialAmount} ${value > row.spend ? styles.financialPositive : styles.financialNegative}`}>
            {formatCurrency(value)}
          </span>
        )
      },
      {
        key: 'profit',
        header: 'Ganancias',
        sortable: true,
        render: (value: number) => (
          <span className={`${styles.financialAmount} ${value > 0 ? styles.financialPositive : styles.financialNegative}`}>
            {formatCurrency(value)}
          </span>
        )
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
        key: 'cpa',
        header: 'Costo por Cita',
        sortable: true,
        visible: false,
        render: (value: number) => <span>{formatCurrency(value)}</span>
      },
      {
        key: 'cpaAttendance',
        header: 'Costo por Asistencia',
        sortable: true,
        visible: false,
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
        key: 'attendances',
        header: 'Asistencias',
        sortable: true,
        visible: true,
        render: (value: number, row) => {
          const hasValue = (value || 0) > 0
          return hasValue ? (
            <button
              type="button"
              className={styles.metricLink}
              onClick={() => handleOpenModal('attendances', resolvePeriodRange(row.date, viewType), 'Asistencias')}
            >
              {formatNumber(value)}
            </button>
          ) : (
            <span>{formatNumber(value)}</span>
          )
        }
      },
      {
        key: 'transactions',
        header: 'Transacciones',
        sortable: true,
        visible: false,
        render: (value: number, row) => {
          const hasValue = (value || 0) > 0
          return hasValue ? (
            <button
              type="button"
              className={styles.metricLink}
              onClick={() => handleOpenTransactionsModal(resolvePeriodRange(row.date, viewType))}
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
        key: 'apptsToAttendanceRate',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>Citas→Asistencias %</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
          </div>
        ),
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      },
      {
        key: 'attendanceToSalesRate',
        header: `Asistencias→${salesLabel} %`,
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      },
      {
        key: 'attendanceToCustomersRate',
        header: `Asistencias→${labels.customers} %`,
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      },
      {
        key: 'apptsToSalesRate',
        header: (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div>{`Citas→${salesLabel} %`}</div>
            <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
          </div>
        ),
        sortable: true,
        visible: false,
        render: (value: number) => <span>{value.toFixed(1)}%</span>
      }
    ]

    // Filtrar columnas según configuración
    let filteredColumns = columns

    // Filtrar columnas de visitantes si analytics no está habilitado
    if (!analyticsEnabled) {
      const visitorKeys = new Set(['visitors', 'cpv', 'webToInteresadosRate'])
      filteredColumns = filteredColumns.filter((column) => !visitorKeys.has(String(column.key)))
    }

    // Filtrar columna de transacciones: solo en vista "Todos"
    if (reportType !== 'cashflow') {
      filteredColumns = filteredColumns.filter((column) => column.key !== 'transactions')
    }

    return filteredColumns
  }, [reportType, viewType, visitorSource, handleOpenModal, handleOpenVisitorsModal, handleOpenTransactionsModal, handleSaveBusinessExpense, savingManualBusinessExpenseKey, labels.lead, labels.leads, labels.customer, labels.customers, analyticsEnabled])

  const appliedManualBusinessExpensesTotal = applyManualBusinessExpenses ? manualBusinessExpensesTotalForRange : 0
  const appliedFixedBusinessExpensesTotal = applyFixedBusinessExpenses ? fixedBusinessExpensesTotalForRange : 0
  const summaryProfit = summary
    ? summary.payments.totalRevenue - summary.campaigns.spend - appliedManualBusinessExpensesTotal - appliedFixedBusinessExpensesTotal
    : 0

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
      value: formatCurrency(summaryProfit),
      delta: calcDelta(
        summaryProfit,
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

  const hasLoadedReports = hasLoadedMetrics && hasLoadedSummary
  const summaryRefreshing = loadingSummary && hasLoadedSummary

  if ((loadingMetrics || loadingSummary) && !hasLoadedReports) {
    return <Loading message="Cargando reportes..." page="reports" />
  }

  return (
    <PageContainer size="wide">
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Reportes</h1>
            {metricsRangeLabel && <span className={styles.rangeLabel}>{metricsRangeLabel}</span>}
          </div>
          <div className={styles.filtersArea}>
            {/* Cuando es rango personalizado, el selector va solo en su propia fila */}
            {viewType === 'month' && monthPreset === 'custom' && (
              <div className={styles.presetRow}>
                <ViewSelector
                  value={monthPreset}
                  options={monthRangeOptions}
                  onChange={handleMonthPresetChange}
                />
              </div>
            )}

            {/* Fila principal: controles izquierda + todos los tabs juntos a la derecha */}
            <div className={styles.controlsRow}>
              <div className={styles.leftControls}>
                {viewType === 'day' && (
                  <DateRangePicker
                    startDate={toIsoDate(baseRange.start)}
                    endDate={toIsoDate(baseRange.end)}
                    onChange={(start, end) => setDateRange({
                      start: parseLocalDateString(start),
                      end: parseLocalDateString(end),
                      preset: 'custom'
                    })}
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
                    startDate={toIsoDate(baseRange.start)}
                    endDate={toIsoDate(baseRange.end)}
                    onChange={(start, end) => setDateRange({
                      start: parseLocalDateString(start),
                      end: parseLocalDateString(end),
                      preset: 'custom'
                    })}
                  />
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

              {/* Todos los tabs juntos en la misma fila */}
              <div className={styles.tabsContainer}>
	                <TabList
	                  tabs={scopeTabs}
	                  activeTab={reportType}
	                  onTabChange={(value) => {
	                    if (isReportType(value)) navigateReportsView({ reportType: value })
	                  }}
	                  variant="compact"
	                />
	                <TabList
	                  tabs={displayTabs}
	                  activeTab={displayMode}
	                  onTabChange={(value) => {
	                    if (isReportDisplayMode(value)) navigateReportsView({ displayMode: value })
	                  }}
	                  variant="compact"
	                />
	                <TabList
	                  tabs={viewTabs}
	                  activeTab={viewType}
	                  onTabChange={(value) => {
	                    if (isReportViewType(value)) navigateReportsView({ viewType: value })
	                  }}
	                  variant="compact"
	                />
              </div>
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
                loading={summaryRefreshing}
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
            loading={loadingMetrics && !hasLoadedMetrics}
            paginated
            pageSize={25}
            searchable
            searchPlaceholder="Buscar períodos..."
            tableId={reportsTableId}
            emptyMessage={loadingMetrics ? 'Cargando métricas...' : 'No hay datos para el rango seleccionado'}
          />
        </Card>
      ) : (
        <MetricsGrid
          metrics={metrics}
          loading={loadingMetrics && !hasLoadedMetrics}
          reportType={reportType}
          showVisitors={analyticsEnabled}
          viewType={viewType}
          businessExpensesByPeriod={businessExpensesByPeriod}
          fixedBusinessExpensesByPeriod={fixedBusinessExpensesByPeriod}
          applyManualBusinessExpenses={applyManualBusinessExpenses}
          applyFixedBusinessExpenses={applyFixedBusinessExpenses}
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
          type={modalState.type === 'customers' ? 'sales' : modalState.type === 'sales' ? 'sales' : (modalState.type === 'appointments' || modalState.type === 'attendances') ? 'appointments' : 'interesados'}
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

        {/* Modal de Transacciones */}
        <TransactionsModal
          isOpen={transactionsModalState.open}
          onClose={() => setTransactionsModalState(prev => ({ ...prev, open: false }))}
          title={transactionsModalState.title}
          subtitle={transactionsModalState.subtitle}
          transactions={transactionsModalState.transactions}
          loading={transactionsModalState.loading}
        />
      </div>
    </PageContainer>
  )
}
