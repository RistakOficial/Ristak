import React, { useMemo, useRef, useState, useEffect } from 'react'
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
}

interface LegendLabels {
  label1: string
  label2?: string
}

interface LineChartProps {
  data: DataPoint[]
  height?: number
  showGrid?: boolean
  color?: string
  color2?: string
  showPoints?: boolean
  formatValue?: (value: number) => string
  formatTooltipValue?: (value: number, key: string) => string
  showLegend?: boolean
  legendLabels?: LegendLabels
}

interface SeriesDefinition {
  key: 'value' | 'value2'
  label: string
  color: string
}

const DEFAULT_COLOR_PRIMARY = 'var(--color-accent-blue)'
const DEFAULT_COLOR_SECONDARY = 'var(--color-accent-orange)'

const defaultFormatAxis = (value: number): string => formatChartCurrency(value)

const defaultFormatTooltip = (value: number): string => formatCurrency(value)


export const LineChart: React.FC<LineChartProps> = ({
  data,
  height = 280,
  showGrid = true,
  color = DEFAULT_COLOR_PRIMARY,
  color2 = DEFAULT_COLOR_SECONDARY,
  showPoints = true,
  formatValue = defaultFormatAxis,
  formatTooltipValue = (value) => defaultFormatTooltip(value),
  showLegend = false,
  legendLabels = { label1: 'Serie 1', label2: 'Serie 2' }
}) => {
  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const [actualPointPos, setActualPointPos] = useState<{ x: number; y: number } | null>(null)
  const activePointRef = useRef<{ [key: string]: { x: number; y: number } }>({})
  const pendingUpdateRef = useRef<{ x: number; y: number } | null>(null)
  const hasSecondSeries = data.some((d) => typeof d.value2 === 'number')
  const isDarkMode = typeof document !== 'undefined' && document.body.classList.contains('dark')

  // Resetear cuando cambia el índice o deja de hacer hover
  useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = {}
      pendingUpdateRef.current = null
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = {}
      pendingUpdateRef.current = null
    }
  }, [isHovering, activeIndex])

  // Actualizar posición después del render
  // CRÍTICO: Usar useLayoutEffect para sincronización inmediata después del render
  // Se ejecuta cuando isHovering o activeIndex cambian (que es cuando se actualiza pendingUpdateRef)
  useEffect(() => {
    if (pendingUpdateRef.current) {
      setActualPointPos(pendingUpdateRef.current)
      pendingUpdateRef.current = null
    }
  }, [isHovering, activeIndex])  // Solo cuando cambian estos valores

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
  // Los datos deben ocupar máximo el 75% de la altura del gráfico
  const yDomain: [number, number] = [0, maxValue > 0 ? Math.ceil(maxValue / 0.75) : 1]

  const axisFormatter = (value: number) => formatValue(value)
  const tooltipFormatter = (value: number, key: string) => formatTooltipValue(value, key)
  const resolvedPointPos = actualPointPos ?? pendingUpdateRef.current ?? null
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
    <div className="space-y-3">
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
        style={{ minHeight: height, height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RechartsAreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 5 }}>
            <defs>
              {series.map((serie) => (
                <linearGradient
                  key={`gradient-${serie.key}`}
                  id={`gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  <stop offset="0%" stopColor={serie.color} stopOpacity={0.18} />
                  <stop offset="50%" stopColor={serie.color} stopOpacity={0.1} />
                  <stop offset="100%" stopColor={serie.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            {showGrid && (
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
            )}

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 13 }}
              axisLine={{ stroke: 'var(--color-border-subtle)', opacity: 0.2 }}
              tickLine={false}
              padding={{ left: 0, right: 0 }}
              scale="point"
            />

            <YAxis
              domain={yDomain}
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 13 }}
              axisLine={{ stroke: 'var(--color-border-subtle)', opacity: 0.2 }}
              tickLine={false}
              tickFormatter={axisFormatter}
              allowDecimals={false}
            />

            {/* Tooltip de Recharts deshabilitado - usamos nuestro FloatingTooltip */}

            {series.map((serie) => (
              <Area
                key={serie.key}
                name={serie.label}
                type="monotone"
                dataKey={serie.key}
                stroke={serie.color}
                strokeWidth={2.5}
                fill={`url(#gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'})`}
                dot={
                  showPoints
                    ? (props: any) => {
                        const isActive = props.index === activeIndex

                        // Capturar la posición real del punto cuando está activo
                        if (isActive && props.cx && props.cy) {
                          const rect = chartRef.current?.getBoundingClientRect()
                          if (rect) {
                            const pointX = rect.left + props.cx
                            const pointY = rect.top + props.cy
                            // Guardar la posición de este punto
                            activePointRef.current[`${props.index}-${serie.key}`] = { x: pointX, y: pointY }

                            // Guardar para actualizar después del render
                            const allPoints = Object.values(activePointRef.current)
                            if (allPoints.length > 0) {
                              const highestPoint = allPoints.reduce((highest, current) =>
                                current.y < highest.y ? current : highest
                              )
                              pendingUpdateRef.current = highestPoint
                            }
                          }
                        }

                        return (
                          <circle
                            cx={props.cx}
                            cy={props.cy}
                            r={showPoints ? (isActive ? 7 : 3.5) : 0}
                            fill={
                              showPoints
                                ? isActive
                                  ? 'var(--color-background-primary)'
                                  : serie.color
                                : 'transparent'
                            }
                            stroke={showPoints && isActive ? serie.color : 'none'}
                            strokeWidth={showPoints && isActive ? 3 : 0}
                            data-chart-index={props.index}
                            data-chart-interactive={showPoints ? 'true' : undefined}
                            style={{
                              pointerEvents: showPoints ? 'auto' : 'none',
                              transition: showPoints ? 'all 150ms ease-out' : undefined,
                              filter:
                                showPoints && isActive
                                  ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))'
                                  : 'none'
                            }}
                          />
                        )
                      }
                    : false
                }
                activeDot={false}
                animationDuration={0}
                animationBegin={0}
                connectNulls
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
