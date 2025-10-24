import React from 'react'
import { BarChart as RechartsBarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { ChartTooltip } from '../ChartTooltip'
import styles from './BarChart.module.css'

export interface BarChartData {
  name: string
  value: number
}

interface BarChartProps {
  data: BarChartData[]
  loading?: boolean
  height?: number
  color?: string
  xAxisLabel?: string
  yAxisLabel?: string
  formatTooltip?: (value: number) => string
  formatXAxis?: (value: string) => string
}

export const BarChart: React.FC<BarChartProps> = ({
  data,
  loading = false,
  height = 300,
  color = 'var(--color-primary)',
  xAxisLabel,
  yAxisLabel,
  formatTooltip = (value) => value.toString(),
  formatXAxis = (value) => value
}) => {
  if (loading) {
    return (
      <div className={styles.loadingContainer} style={{ height }}>
        <div className={styles.loadingSpinner} />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className={styles.emptyContainer} style={{ height }}>
        <p className={styles.emptyMessage}>No hay datos disponibles para el período seleccionado</p>
      </div>
    )
  }

  return (
    <div className={styles.container} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 20 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border)"
            vertical={false}
          />
          <XAxis
            dataKey="name"
            stroke="var(--color-text-tertiary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
            tickFormatter={formatXAxis}
            label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, fill: 'var(--color-text-tertiary)' } : undefined}
          />
          <YAxis
            stroke="var(--color-text-tertiary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
            label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fill: 'var(--color-text-tertiary)' } : undefined}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: 'var(--color-primary-alpha-10)' }}
            formatter={(value: number) => [formatTooltip(value), 'Registros']}
          />
          <Bar
            dataKey="value"
            fill={color}
            radius={[4, 4, 0, 0]}
            animationDuration={300}
          />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  )
}
