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
  type ReportRange
} from '@/services/reportsService'
import { formatCurrency, formatNumber, formatRoas, formatDate, formatDateToISO, parseLocalDateString } from '@/utils/format'
import { useAppConfig, useChartHover, useIsRenderDomain, useMetaTimezone } from '@/hooks'
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
  LineChart,
  Line,
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
  transactions: number
  new_customers: number
  leads: number
  appointments: number
  clicks: number
  reach: number
  visitors: number
  cpc: number
  cpv: number
  cpl: number
  cpa: number
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

// Componentes de gráfico personalizados con tooltip del Dashboard
interface MetricChartData {
  label: string
  [key: string]: number | string
}

interface SimpleLineChartProps {
  data: MetricChartData[]
  dataKeys: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
  height?: number
}

const SimpleLineChart: React.FC<SimpleLineChartProps> = ({ data, dataKeys, formatValue, height = 200 }) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = React.useState<{ x: number; y: number } | null>(null)
  const activePointRef = React.useRef<{ [key: string]: { x: number; y: number } }>({})
  const isDarkMode = typeof document !== 'undefined' && document.body.classList.contains('dark')

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
    <div ref={chartRef} style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            {dataKeys.map((dk) => (
              <linearGradient key={`gradient-${dk.key}`} id={`gradient-${dk.key}-line-reports`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={dk.color} stopOpacity={0.18} />
                <stop offset="50%" stopColor={dk.color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={dk.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          {dataKeys.map((dk) => (
            <Area
              key={dk.key}
              type="monotone"
              dataKey={dk.key}
              stroke={dk.color}
              strokeWidth={2.5}
              fill={`url(#gradient-${dk.key}-line-reports)`}
              dot={(props: any) => {
                const isActive = props.index === activeIndex

                // Capturar la posición real del punto cuando está activo
                if (isActive && props.cx && props.cy) {
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
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={isActive ? 7 : 3.5}
                    fill={isActive ? 'var(--color-background-primary)' : dk.color}
                    stroke={isActive ? dk.color : 'none'}
                    strokeWidth={isActive ? 3 : 0}
                    data-chart-index={props.index}
                    data-chart-interactive="true"
                    style={{
                      pointerEvents: 'auto',
                      transition: 'all 150ms ease-out',
                      filter: isActive ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))' : 'none'
                    }}
                  />
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
  height?: number
}

const SimpleBarChart: React.FC<SimpleBarChartProps> = ({ data, dataKey, label, color, formatValue, height = 200 }) => {
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
    <div ref={chartRef} style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          <Bar
            dataKey={dataKey}
            fill={color}
            radius={[4, 4, 0, 0]}
            shape={(props: any) => {
              const { x, y, width, height, index } = props
              const isActive = index === activeIndex

              // Capturar la posición real del punto cuando está activo
              if (isActive) {
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
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    fill={color}
                    rx={4}
                    ry={4}
                    opacity={isActive ? 1 : 0.9}
                    style={{ transition: 'opacity 150ms ease-out' }}
                  />
                  {/* Área interactiva invisible para detección de hover */}
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
                  {/* Dot invisible en el centro superior de cada barra para posicionamiento */}
                  <circle
                    cx={x + width / 2}
                    cy={y}
                    r={0}
                    data-chart-index={index}
                    data-chart-interactive="true"
                    style={{ pointerEvents: 'none' }}
                  />
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
  height?: number
}

const SimpleAreaChart: React.FC<SimpleAreaChartProps> = ({ data, dataKeys, formatValue, height = 200 }) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = React.useState<{ x: number; y: number } | null>(null)
  const activePointRef = React.useRef<{ [key: string]: { x: number; y: number } }>({})
  const isDarkMode = typeof document !== 'undefined' && document.body.classList.contains('dark')

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
    <div ref={chartRef} style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            {dataKeys.map((dk) => (
              <linearGradient key={`gradient-${dk.key}`} id={`gradient-${dk.key}-reports`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={dk.color} stopOpacity={0.18} />
                <stop offset="50%" stopColor={dk.color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={dk.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary)" />
          {dataKeys.map((dk) => (
            <Area
              key={dk.key}
              type="monotone"
              dataKey={dk.key}
              stroke={dk.color}
              strokeWidth={2.5}
              fill={`url(#gradient-${dk.key}-reports)`}
              dot={(props: any) => {
                const isActive = props.index === activeIndex

                // Capturar la posición real del punto cuando está activo
                if (isActive && props.cx && props.cy) {
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
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={isActive ? 7 : 3.5}
                    fill={isActive ? 'var(--color-background-primary)' : dk.color}
                    stroke={isActive ? dk.color : 'none'}
                    strokeWidth={isActive ? 3 : 0}
                    data-chart-index={props.index}
                    data-chart-interactive="true"
                    style={{
                      pointerEvents: 'auto',
                      transition: 'all 150ms ease-out',
                      filter: isActive ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))' : 'none'
                    }}
                  />
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

const MetricsGrid: React.FC<MetricsGridProps> = ({ metrics, loading, reportType, showVisitors, viewType }) => {
  const timezoneInfo = useMetaTimezone()
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

  // Preparar datos para los gráficos (formato compatible con useChartHover)
  // Ordenar cronológicamente (fecha más antigua a la izquierda, más reciente a la derecha)
  const chartData = React.useMemo(() => {
    return metrics.slice().sort((a, b) => {
      const dateA = new Date(a.date).getTime()
      const dateB = new Date(b.date).getTime()
      return dateA - dateB // Orden ascendente
    }).map(m => ({
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
      sales: m.sales,
      new_customers: m.new_customers,
      revenue: m.revenue,
      spend: m.spend,
      profit: m.revenue - m.spend
    }))
  }, [metrics, timezoneInfo, viewType])

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
    { key: 'clicks', label: 'Clicks', color: '#3b82f6' }
  ]
  if (showVisitors) {
    trafficKeys.push({ key: 'visitors', label: 'Visitantes', color: '#8b5cf6' })
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
        { label: `${labels.leads}→Citas %`, value: `${interesadoToAppt.toFixed(1)}%` },
        { label: reportType === 'cashflow' ? 'Transacciones' : 'Ventas', value: formatNumber(totals.sales) },
        { label: 'Citas→Ventas %', value: `${apptToSale.toFixed(1)}%` }
      ],
      chart: (
        <SimpleLineChart
          data={chartData}
          dataKeys={[
            { key: 'leads', label: labels.leads, color: '#10b981' },
            { key: 'appointments', label: 'Citas', color: '#f59e0b' },
            { key: 'sales', label: 'Ventas', color: '#ef4444' }
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
        { label: 'Total de Transacciones', value: formatNumber(totals.sales) },
        { label: `Transacciones por ${labels.customer}`, value: transactionsPerCustomer.toFixed(1) },
        { label: 'Ticket Promedio', value: formatCurrency(aov) }
      ],
      chart: (
        <SimpleBarChart
          data={chartData}
          dataKey="new_customers"
          label={`${labels.customers} Nuevos`}
          color="#06b6d4"
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
        { label: 'Ganancias Netas', value: formatCurrency(profit) },
        { label: 'Transacciones', value: formatNumber(totals.sales) },
        { label: 'Retorno de Inversión', value: `${roas.toFixed(2)}x` },
        { label: 'ROI', value: `${roi.toFixed(1)}%` }
      ],
      chart: (
        <SimpleAreaChart
          data={chartData}
          dataKeys={[
            { key: 'revenue', label: 'Ingresos', color: '#10b981' },
            { key: 'spend', label: 'Gastos', color: '#ef4444' },
            { key: 'profit', label: 'Ganancias', color: '#3b82f6' }
          ]}
          formatValue={(value) => formatCurrency(value)}
        />
      )
    }
  ], [chartData, trafficItems, trafficKeys, labels, totals, reportType, profit, roas, roi, cac, aov, transactionsPerCustomer, cpl, epl, interesadoToAppt, apptToSale])

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

  // Detectar discrepancia de timezone con Meta
  const timezoneInfo = useMetaTimezone()

  // Detectar si estamos en dominio .onrender.com
  const isRenderDomain = useIsRenderDomain()

  // Sistema híbrido de configuración
  const [visitorSourceConfig] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')

  // FORZAR valores si estamos en dominio .onrender.com
  const visitorSource = isRenderDomain ? 'platform' : visitorSourceConfig
  const analyticsEnabled = isRenderDomain ? false : parseAnalyticsFlag(showAnalyticsConfig)

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
      const cpa = item.appointments > 0 ? item.spend / item.appointments : 0
      const cac = item.new_customers > 0 ? item.spend / item.new_customers : 0
      const webToInteresadosRate = item.visitors > 0 ? (item.leads / item.visitors) * 100 : 0
      const interesadosToApptsRate = item.leads > 0 ? (item.appointments / item.leads) * 100 : 0
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
        sales: item.sales,
        transactions: item.sales, // En vista "Todos" sales es el conteo de transacciones
        new_customers: item.new_customers,
        leads: item.leads,
        appointments: item.appointments,
        clicks: item.clicks,
        reach: item.reach,
        visitors: item.visitors,
        cpc,
        cpv,
        cpl,
        cpa,
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
        key: 'cpa',
        header: 'Costo por Cita',
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
  }, [reportType, viewType, visitorSource, handleOpenModal, handleOpenVisitorsModal, handleOpenTransactionsModal, labels.lead, labels.leads, labels.customer, labels.customers, analyticsEnabled])

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

  if ((loadingMetrics || loadingSummary) && !metrics.length && !summary) {
    return <Loading message="Cargando reportes..." />
  }

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
                    variant="dual"
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

export default Reports
