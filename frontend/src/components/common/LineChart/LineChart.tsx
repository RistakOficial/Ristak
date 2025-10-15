import React, { useMemo } from 'react'
import {
  LineChart as RechartsLineChart,
  Line,
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

const TooltipContent: React.FC<{ payload?: any[]; label?: string; series: SeriesDefinition[]; formatValue: (value: number, key: string) => string }> = ({ payload, label, series, formatValue }) => {
  if (!payload || payload.length === 0) {
    return null
  }

  const items = payload.map((entry) => {
    const seriesInfo = series.find((serie) => serie.key === entry.dataKey)
    if (!seriesInfo) return null

    return (
      <div key={seriesInfo.key} className="flex items-center gap-2 text-sm">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: seriesInfo.color }}
        />
        <span className="text-[var(--color-text-secondary)]">{seriesInfo.label}:</span>
        <span className="font-medium text-[var(--color-text-primary)]">
          {typeof entry.value === 'number' ? formatValue(entry.value, seriesInfo.key) : entry.value}
        </span>
      </div>
    )
  }).filter(Boolean)

  if (items.length === 0) return null

  return (
    <div className="glass rounded-lg border border-[rgba(148,163,184,0.14)] px-4 py-3 dark:shadow-[0_18px_35px_-25px_rgba(15,23,42,0.6)]">
      {label && <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">{label}</p>}
      <div className="space-y-1.5">
        {items}
      </div>
    </div>
  )
}

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
  const hasSecondSeries = data.some((d) => typeof d.value2 === 'number')

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
        className="relative"
        style={{ minHeight: height, height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RechartsLineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            {showGrid && (
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
            )}

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 13 }}
              axisLine={{ stroke: 'var(--color-border-subtle)', opacity: 0.2 }}
              tickLine={false}
            />

            <YAxis
              domain={yDomain}
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 13 }}
              axisLine={{ stroke: 'var(--color-border-subtle)', opacity: 0.2 }}
              tickLine={false}
              tickFormatter={axisFormatter}
              allowDecimals={false}
            />

            <Tooltip
              content={<TooltipContent series={series} formatValue={tooltipFormatter} />}
              cursor={{ stroke: 'var(--color-border-subtle)', strokeWidth: 1 }}
              isAnimationActive={false}
            />

            {series.map((serie) => (
              <Line
                key={serie.key}
                type="monotone"
                dataKey={serie.key}
                stroke={serie.color}
                strokeWidth={2.5}
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
                        stroke: 'var(--color-background-primary)',
                        strokeWidth: 2
                      }
                    : false
                }
                animationDuration={0}
                animationBegin={0}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </RechartsLineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
