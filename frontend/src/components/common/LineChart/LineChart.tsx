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
import { formatCurrency, formatChartCurrency } from '@/utils/format'

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
  height = '100%',
  minHeight,
  showGrid = true,
  color = DEFAULT_COLOR_PRIMARY,
  color2 = DEFAULT_COLOR_SECONDARY,
  showPoints = true,
  formatValue = defaultFormatAxis,
  formatTooltipValue = (value) => defaultFormatTooltip(value),
  showLegend = false,
  legendLabels = { label1: 'Serie 1', label2: 'Serie 2' }
}) => {
  console.log('📈 LineChart data received:', data?.length, 'points')
  console.log('📈 First data point:', data?.[0])
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

  const yDomain = useMemo<[number, number]>(() => {
    if (numericValues.length === 0) {
      console.log('📈 No numeric values, using default domain [0, 1]')
      return [0, 1]
    }

    const maxValue = Math.max(...numericValues)
    console.log('📈 Max value:', maxValue, 'Numeric values:', numericValues.length)
    if (maxValue <= 0) {
      return [0, 1]
    }

    const paddedMax = Math.max(maxValue * 1.05, maxValue + 1)
    console.log('📈 Y Domain:', [0, paddedMax])
    return [0, paddedMax]
  }, [numericValues])

  const axisFormatter = (value: number) => formatValue(value)

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
        style={{
          height,
          minHeight:
            typeof minHeight !== 'undefined'
              ? minHeight
              : typeof height === 'number'
                ? height
                : 280
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RechartsLineChart
            data={data}
            margin={{ top: 10, right: 12, left: 0, bottom: 5 }}
            onMouseEnter={() => console.log('📈 Chart mouse enter')}
            onMouseLeave={() => console.log('📈 Chart mouse leave')}>
            {showGrid && (
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" opacity={0.5} />
            )}

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text-tertiary)', fontSize: 13 }}
              axisLine={{ stroke: 'var(--color-border-subtle)', opacity: 0.2 }}
              tickLine={false}
              allowDuplicatedCategory
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

            {/* Tooltip nativo de Recharts habilitado temporalmente para diagnóstico */}
            <Tooltip />

            {series.map((serie) => (
              <Line
                key={serie.key}
                name={serie.label}
                type="monotone"
                dataKey={serie.key}
                stroke={serie.color}
                strokeWidth={2.5}
                dot={showPoints ? { r: 3, fill: serie.color } : false}
                activeDot={showPoints ? { r: 6 } : false}
                animationDuration={300}
                connectNulls
              />
            ))}
          </RechartsLineChart>
        </ResponsiveContainer>
      </div>

      {/* Nuestro tooltip flotante que aparece sobre el punto */}
      {/* Temporalmente comentado para diagnóstico
      <ChartTooltip
        active={isHovering && Boolean(resolvedPointPos)}
        data={activeData}
        pointPos={resolvedPointPos}
        series={series}
        formatValue={tooltipFormatter}
        verticalOffset={tooltipVerticalOffset}
      />
      */}
    </div>
  )
}
