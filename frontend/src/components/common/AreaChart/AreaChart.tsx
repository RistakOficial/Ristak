import React, { useMemo, useRef, useState, useEffect, useId } from 'react'
import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer
} from 'recharts'
import { formatCurrency, formatChartCurrency } from '@/utils/format'
import { useChartHover } from '@/hooks/useChartHover'
import { ChartTooltip } from '../ChartTooltip/ChartTooltip'

interface DataPoint {
  label: string
  value: number
  value2?: number
  periodStart?: string
  periodEnd?: string
  periodKey?: string
}

interface LegendLabels {
  label1: string
  label2?: string
}

interface AreaChartProps {
  data: DataPoint[]
  height?: number | string
  minHeight?: number | string
  showGrid?: boolean
  color?: string
  color2?: string
  showPoints?: boolean
  formatValue?: (value: number) => string
  formatTooltipValue?: (value: number, key: string) => string
  showLegend?: boolean
  legendLabels?: LegendLabels
  onPointClick?: (point: DataPoint, index: number, seriesKey: 'value' | 'value2') => void
}

interface SeriesDefinition {
  key: 'value' | 'value2'
  label: string
  color: string
}

const DEFAULT_COLOR_PRIMARY = 'var(--design-chart-primary, #10b981)'
const DEFAULT_COLOR_SECONDARY = 'var(--design-chart-secondary, #64748b)'

const defaultFormatAxis = (value: number): string => formatChartCurrency(value)

const defaultFormatTooltip = (value: number): string => formatCurrency(value)


export const AreaChart: React.FC<AreaChartProps> = ({
  data,
  height = 250,
  minHeight,
  showGrid = true,
  color = DEFAULT_COLOR_PRIMARY,
  color2 = DEFAULT_COLOR_SECONDARY,
  showPoints = true,
  formatValue = defaultFormatAxis,
  formatTooltipValue = (value) => defaultFormatTooltip(value),
  showLegend = false,
  legendLabels = { label1: 'Serie 1', label2: 'Serie 2' },
  onPointClick
}) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const gradientIdPrefix = useId().replace(/:/g, '')
  const [actualPointPos, setActualPointPos] = useState<{ x: number; y: number } | null>(null)
  const activePointRef = useRef<{ [key: string]: { x: number; y: number } }>({})
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null)
  const hasPendingPointRef = useRef(false)
  const hasSecondSeries = data.some((d) => typeof d.value2 === 'number')
  const isDarkMode = document.body.classList.contains('dark')

  // Resetear cuando cambia el índice o deja de hacer hover
  useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = {}
      pendingPointRef.current = null
      hasPendingPointRef.current = false
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = {}
      pendingPointRef.current = null
      hasPendingPointRef.current = false
    }
  }, [isHovering, activeIndex])

  useEffect(() => {
    if (!hasPendingPointRef.current) return

    const pendingPoint = pendingPointRef.current
    hasPendingPointRef.current = false

    if (!pendingPoint) return

    setActualPointPos((prev) => {
      if (prev && prev.x === pendingPoint.x && prev.y === pendingPoint.y) {
        return prev
      }
      return pendingPoint
    })
  })

  const series = useMemo<SeriesDefinition[]>(() => {
    const definitions: SeriesDefinition[] = [
      { key: 'value', label: legendLabels.label1, color }
    ]

    if (hasSecondSeries && legendLabels.label2) {
      definitions.push({ key: 'value2', label: legendLabels.label2, color: color2 })
    }

    return definitions
  }, [color, color2, legendLabels.label1, legendLabels.label2, hasSecondSeries])

  const numericValues = useMemo(() => {
    const values: number[] = []
    data.forEach((item) => {
      if (typeof item.value === 'number') values.push(item.value)
      if (typeof item.value2 === 'number') values.push(item.value2)
    })
    return values
  }, [data])

  const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 0
  const yDomain: [number, number] = [0, maxValue > 0 ? Math.ceil(maxValue * 1.4) : 1]
  const usesFluidHeight = typeof height === 'string'

  const tooltipFormatter = (value: number, key: string) => formatTooltipValue(value, key)
  const resolvedPointPos = actualPointPos ?? null
  const tooltipAnchor = resolvedPointPos

  const tooltipVerticalOffset = useMemo(() => {
    if (!tooltipAnchor || !chartRef.current) {
      return 22
    }

    const rect = chartRef.current.getBoundingClientRect()
    const distanceFromTop = Math.max(0, tooltipAnchor.y - rect.top)
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
  }, [tooltipAnchor, chartRef])

  return (
    <div
      className={usesFluidHeight ? 'flex flex-col gap-3' : 'space-y-3'}
      data-ristak-chart="area"
      style={usesFluidHeight ? { height, minHeight } : undefined}
    >
      {showLegend && (
        <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-[var(--color-text-secondary)] mb-2">
          {series.map((serie) => (
            <div key={serie.key} className="inline-flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: serie.color }}
              />
              <span className="font-medium">{serie.label}</span>
            </div>
          ))}
        </div>
      )}

      <div
        ref={chartRef}
        className="relative"
        style={usesFluidHeight ? { flex: 1, minHeight: minHeight ?? 0 } : { height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RechartsAreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 5 }}>
            <defs>
              {series.map((serie) => (
                <linearGradient
                  key={`gradient-${serie.key}`}
                  id={`${gradientIdPrefix}-gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  <stop offset="0%" stopColor={serie.color} stopOpacity="var(--design-chart-area-opacity-start, 0.2)" />
                  <stop offset="50%" stopColor={serie.color} stopOpacity="var(--design-chart-area-opacity-mid, 0.1)" />
                  <stop offset="100%" stopColor={serie.color} stopOpacity="var(--design-chart-area-opacity-end, 0.02)" />
                </linearGradient>
              ))}
            </defs>

            {showGrid && (
              <CartesianGrid
                strokeDasharray="var(--design-chart-grid-dash, 3 3)"
                stroke="var(--design-chart-grid, var(--color-border-subtle))"
                opacity={1}
              />
            )}

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontSize: 12, fontFamily: 'var(--font-app)' }}
              axisLine={{ stroke: 'var(--design-chart-grid, var(--color-text-tertiary))', opacity: 1 }}
              tickLine={false}
              allowDuplicatedCategory
              padding={{ left: 0, right: 0 }}
              scale="point"
            />

            <YAxis
              domain={yDomain}
              tick={{ fill: 'var(--design-chart-axis, var(--color-text-tertiary))', fontSize: 12, fontFamily: 'var(--font-app)' }}
              axisLine={{ stroke: 'var(--design-chart-grid, var(--color-text-tertiary))', opacity: 1 }}
              tickLine={false}
              tickFormatter={(value, index) => {
                // Ocultar el primer valor del eje Y para evitar solapamiento con eje X
                if (index === 0) return ''
                return formatValue(value)
              }}
            />

            {/* Tooltip de Recharts deshabilitado - usamos FloatingTooltip */}

            {series.map((serie) => (
              <Area
                key={serie.key}
                type="monotone"
                dataKey={serie.key}
                name={serie.label}
                stroke={serie.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={`url(#${gradientIdPrefix}-gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'})`}
                dot={
                  showPoints
                    ? (props: any) => {
                        const isActive = props.index === activeIndex

                        // Capturar la posición real del punto cuando está activo
                        if (isActive && props.cx != null && props.cy != null) {
                          const rect = chartRef.current?.getBoundingClientRect()
                          if (rect) {
                            const pointX = rect.left + props.cx
                            const pointY = rect.top + props.cy
                            const pointKey = `${props.index}-${serie.key}`

                            // Solo guardar si no existe o cambió
                            const existing = activePointRef.current[pointKey]
                            if (!existing || existing.x !== pointX || existing.y !== pointY) {
                              activePointRef.current[pointKey] = { x: pointX, y: pointY }

                              const allPoints = Object.values(activePointRef.current)
                              if (allPoints.length > 0) {
                                const highestPoint = allPoints.reduce((highest, current) =>
                                  current.y < highest.y ? current : highest
                                )
                                pendingPointRef.current = highestPoint
                                hasPendingPointRef.current = true
                              }
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
                              role={onPointClick ? 'button' : undefined}
                              tabIndex={onPointClick ? 0 : undefined}
                              aria-label={onPointClick ? `Ver detalles de ${serie.label} en ${props.payload?.label ?? 'este punto'}` : undefined}
                              onClick={(event) => {
                                if (!onPointClick || !props.payload) return
                                event.stopPropagation()
                                onPointClick(props.payload, props.index, serie.key)
                              }}
                              onKeyDown={(event) => {
                                if (!onPointClick || !props.payload) return
                                if (event.key !== 'Enter' && event.key !== ' ') return
                                event.preventDefault()
                                onPointClick(props.payload, props.index, serie.key)
                              }}
                              style={{
                                pointerEvents: 'all',
                                cursor: onPointClick ? 'pointer' : undefined
                              }}
                            />
                            <circle
                              cx={props.cx}
                              cy={props.cy}
                              r={isActive ? 7 : 0}
                              fill="var(--color-background-primary)"
                              stroke={serie.color}
                              strokeWidth={isActive ? 3 : 0}
                              opacity={isActive ? 1 : 0}
                              aria-hidden="true"
                              style={{
                                pointerEvents: 'none',
                                transition: 'all 150ms ease-out',
                                filter: isActive
                                  ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))'
                                  : 'none'
                              }}
                            />
                          </g>
                        )
                      }
                    : false
                }
                activeDot={false}
                animationDuration={0}
                animationBegin={0}
                isAnimationActive={false}
              />
            ))}
          </RechartsAreaChart>
        </ResponsiveContainer>
      </div>

      {/* Nuestro tooltip flotante que aparece sobre el punto */}
      <ChartTooltip
        active={isHovering && Boolean(resolvedPointPos)}
        data={activeData}
        pointPos={resolvedPointPos}
        series={series}
        formatValue={tooltipFormatter}
        verticalOffset={tooltipVerticalOffset}
      />
    </div>
  )
}
