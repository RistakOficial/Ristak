import React, { useMemo, useState, useCallback } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { Card } from '../Card'
import { Globe } from 'lucide-react'
import { ChartTooltip } from '../ChartTooltip/ChartTooltip'
import styles from './TrafficSourcesChart.module.css'

interface TrafficData {
  name: string
  value: number
  color: string
}

interface TrafficSourcesChartProps {
  data: TrafficData[]
  loading?: boolean
}

const DEFAULT_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Green
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316', // Orange
]

export const TrafficSourcesChart: React.FC<TrafficSourcesChartProps> = ({ data, loading = false }) => {
  const chartData = useMemo(() => {
    return data.map((item, index) => ({
      ...item,
      color: item.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length]
    }))
  }, [data])

  const totalVisits = chartData.reduce((sum, item) => sum + item.value, 0)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  // Manejar hover sobre celdas individuales del pie
  const handleCellMouseEnter = useCallback((index: number) => (event: React.MouseEvent) => {
    setActiveIndex(index)
    setTooltipPos({ x: event.clientX, y: event.clientY })
  }, [])

  const handleCellMouseMove = useCallback((event: React.MouseEvent) => {
    setTooltipPos({ x: event.clientX, y: event.clientY })
  }, [])

  const handleMouseLeave = useCallback(() => {
    setActiveIndex(null)
    setTooltipPos(null)
  }, [])

  // Formatear tooltip
  const formatTooltipValue = (value: number) => {
    const percentage = totalVisits > 0 ? ((value / totalVisits) * 100).toFixed(1) : '0'
    return `${value.toLocaleString()} (${percentage}%)`
  }

  return (
    <Card variant="glass" className={styles.container}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Fuentes de Tráfico</h3>
          <div className={styles.totalContainer}>
            <span className={styles.totalValue}>
              {totalVisits.toLocaleString()}
            </span>
            <span className={styles.totalLabel}>visitantes totales</span>
          </div>
        </div>
      </div>

      <div className={styles.chartContainer}>
        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.loadingText}>Cargando datos...</div>
          </div>
        ) : chartData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart onMouseLeave={handleMouseLeave}>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                  startAngle={90}
                  endAngle={450}
                  stroke="none"
                >
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.color}
                      className={styles.chartCell}
                      onMouseEnter={handleCellMouseEnter(index)}
                      onMouseMove={handleCellMouseMove}
                    />
                  ))}
                </Pie>
                <Tooltip content={() => null} cursor={false} />
              </PieChart>
            </ResponsiveContainer>

            <ChartTooltip
              active={activeIndex !== null}
              data={activeIndex !== null ? { ...chartData[activeIndex], label: chartData[activeIndex].name } : null}
              pointPos={tooltipPos}
              series={[
                {
                  key: 'value',
                  label: 'Visitantes',
                  color: chartData[activeIndex ?? 0]?.color ?? '#3b82f6'
                }
              ]}
              formatValue={formatTooltipValue}
              verticalOffset={45}
            />

            <div className={styles.centerLabel}>
              <div className={styles.centerValue}>{chartData.length}</div>
              <div className={styles.centerText}>fuentes</div>
            </div>
          </>
        ) : (
          <div className={styles.emptyContainer}>
            <Globe className={styles.emptyIcon} />
            <p className={styles.emptyText}>Sin datos de tráfico</p>
            <p className={styles.emptySubtext}>Los datos aparecerán cuando haya visitas</p>
          </div>
        )}
      </div>

      <div className={styles.sourcesList}>
        {loading ? (
          <div className={styles.loadingList}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={styles.loadingItem}>
                <div className={styles.loadingDot} />
                <div className={styles.loadingBar} />
              </div>
            ))}
          </div>
        ) : (
          chartData.map((item) => {
            const percentage = totalVisits > 0 ? ((item.value / totalVisits) * 100).toFixed(1) : '0'

            return (
              <div key={item.name} className={styles.sourceItem}>
                <div className={styles.sourceHeader}>
                  <div className={styles.sourceInfo}>
                    <div
                      className={styles.sourceDot}
                      style={{ backgroundColor: item.color }}
                    />
                    <span className={styles.sourceName}>{item.name}</span>
                    <span className={styles.sourcePercentage}>{percentage}%</span>
                  </div>
                  <span className={styles.sourceValue}>
                    {item.value.toLocaleString()}
                  </span>
                </div>

                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{
                      width: `${percentage}%`,
                      backgroundColor: item.color
                    }}
                  />
                </div>
              </div>
            )
          })
        )}
      </div>

      {!loading && chartData.length > 0 && (
        <div className={styles.insights}>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Mayor fuente</p>
            <p className={styles.insightValue}>
              {chartData[0].name} <span className={styles.insightHighlight}>{((chartData[0].value / totalVisits) * 100).toFixed(1)}%</span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Diversificación</p>
            <p className={styles.insightValue}>{chartData.length} fuentes activas</p>
          </div>
        </div>
      )}
    </Card>
  )
}
