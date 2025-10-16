import React, { useMemo } from 'react'
import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer
} from 'recharts'
import { formatCurrency, formatNumber } from '@/utils/format'
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

interface AreaChartProps {
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

const DEFAULT_COLOR_PRIMARY = '#3b82f6'
const DEFAULT_COLOR_SECONDARY = '#10b981'

const defaultFormatAxis = (value: number): string => {
  if (Math.abs(value) >= 1_000_000) {
    return `$${Math.round(value / 1_000_000)}M`
  }
  if (Math.abs(value) >= 1_000) {
    return `$${Math.round(value / 1_000)}k`
  }
  return `$${Math.round(value)}`
}

const defaultFormatTooltip = (value: number): string => formatCurrency(value)


export const AreaChart: React.FC<AreaChartProps> = ({
  data,
  height = 250,
  showGrid = true,
  color = DEFAULT_COLOR_PRIMARY,
  color2 = DEFAULT_COLOR_SECONDARY,
  showPoints = true,
  formatValue = defaultFormatAxis,
  formatTooltipValue = (value) => defaultFormatTooltip(value),
  showLegend = false,
  legendLabels = { label1: 'Serie 1', label2: 'Serie 2' }
}) => {
  const { chartRef, mousePos, isHovering, activeIndex, activeData } = useChartHover({ data })
  const hasSecondSeries = data.some((d) => typeof d.value2 === 'number')
  const isDarkMode = document.body.classList.contains('dark')

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

  const tooltipFormatter = (value: number, key: string) => formatTooltipValue(value, key)

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

      <div ref={chartRef} className="relative" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsAreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              {series.map((serie) => (
                <linearGradient
                  key={`gradient-${serie.key}`}
                  id={`gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  <stop offset="0%" stopColor={serie.color} stopOpacity={0.2} />
                  <stop offset="50%" stopColor={serie.color} stopOpacity={0.1} />
                  <stop offset="100%" stopColor={serie.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            {showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border-subtle)"
                opacity={0.3}
              />
            )}

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-text-tertiary)', opacity: 0.2 }}
              tickLine={false}
            />

            <YAxis
              domain={yDomain}
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-text-tertiary)', opacity: 0.2 }}
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
                fill={`url(#gradient-${serie.key}-${isDarkMode ? 'dark' : 'light'})`}
                dot={
                  showPoints
                    ? (props: any) => {
                        const isActive = props.index === activeIndex
                        return (
                          <circle
                            cx={props.cx}
                            cy={props.cy}
                            r={isActive ? 7 : 3.5}
                            fill={isActive ? 'var(--color-background-primary)' : serie.color}
                            stroke={isActive ? serie.color : 'none'}
                            strokeWidth={isActive ? 3 : 0}
                            style={{
                              transition: 'all 150ms ease-out',
                              filter: isActive ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))' : 'none'
                            }}
                          />
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

      {/* Nuestro tooltip flotante que sigue al cursor */}
      <ChartTooltip
        active={isHovering}
        data={activeData}
        mousePos={mousePos}
        series={series}
        formatValue={tooltipFormatter}
      />
    </div>
  )
}
