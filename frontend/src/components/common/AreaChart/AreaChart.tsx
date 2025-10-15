import React, { useMemo } from 'react'
import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip
} from 'recharts'
import { formatCurrency, formatNumber } from '@/utils/format'

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

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="glass rounded-lg p-3 shadow-xl">
        <p className="text-xs text-[var(--color-text-tertiary)] mb-2">{label}</p>
        {payload.map((item: any, index: number) => (
          <div key={index} className="flex items-center gap-2 text-sm">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-[var(--color-text-secondary)]">
              {item.name}:
            </span>
            <span className="text-[var(--color-text-primary)] font-medium">
              {typeof item.value === 'number' ? formatCurrency(item.value) : item.value}
            </span>
          </div>
        ))}
      </div>
    )
  }
  return null
}

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

      <div className="relative" style={{ height }}>
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

            <Tooltip
              content={<CustomTooltip />}
              cursor={false}
            />

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
                    ? {
                        r: 3.5,
                        fill: serie.color,
                        strokeWidth: 0
                      }
                    : false
                }
                activeDot={
                  showPoints
                    ? {
                        r: 5,
                        fill: serie.color,
                        stroke: isDarkMode ? '#0a0b0d' : '#ffffff',
                        strokeWidth: 2
                      }
                    : false
                }
              />
            ))}
          </RechartsAreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
