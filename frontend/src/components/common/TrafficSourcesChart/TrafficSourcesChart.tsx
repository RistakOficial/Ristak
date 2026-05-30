import React, { useCallback, useMemo, useState } from 'react'
import { Card } from '../Card'
import { Globe } from 'lucide-react'
import { ChartTooltip } from '../ChartTooltip/ChartTooltip'
import styles from './TrafficSourcesChart.module.css'

interface TrafficData {
  name: string
  value: number
  color?: string
}

interface TrafficSourcesChartProps {
  data: TrafficData[]
  loading?: boolean
  title?: string
  totalLabel?: string
  emptyText?: string
  emptySubtext?: string
  itemLabel?: string
  insightPrimaryLabel?: string
  insightCountLabel?: string
  insightCountSuffix?: string
  headerAction?: React.ReactNode
}

interface ChartSource {
  name: string
  value: number
  color: string
  percentage: number
}

interface DonutSegment extends ChartSource {
  startAngle: number
  endAngle: number
  isFullCircle: boolean
}

const SOURCE_COLORS: Record<string, string> = {
  Facebook: '#1877f2',
  Google: '#4285f4',
  Instagram: '#c32aa3',
  TikTok: '#ee1d52',
  Bing: '#00a4ef',
  Microsoft: '#00a4ef',
  Twitter: '#1da1f2',
  LinkedIn: '#0a66c2',
  YouTube: '#ff0000',
  Messenger: '#0084ff',
  WhatsApp: '#25d366',
  Snapchat: '#fffc00',
  Pinterest: '#e60023',
  Reddit: '#ff4500',
  Telegram: '#0088cc',
  Email: '#ea4335',
  Directo: '#6b7280',
  Orgánico: '#10b981',
  Referencia: '#8b5cf6',
  Yahoo: '#7b0099',
  DuckDuckGo: '#de5833',
  Otro: '#94a3b8',
  Desconocido: '#64748b'
}

const FALLBACK_COLORS = [
  '#2dd4bf',
  '#60a5fa',
  '#f59e0b',
  '#a78bfa',
  '#f43f5e',
  '#34d399',
  '#f97316',
  '#94a3b8'
]

const DONUT_CENTER = 100
const DONUT_RADIUS = 72

const getSourceColor = (name: string, color: string | undefined, index: number) => {
  const incomingColor = color?.trim()
  if (incomingColor) return incomingColor

  return SOURCE_COLORS[name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]
}

const toPoint = (angle: number) => {
  const radians = (angle - 90) * (Math.PI / 180)

  return {
    x: DONUT_CENTER + DONUT_RADIUS * Math.cos(radians),
    y: DONUT_CENTER + DONUT_RADIUS * Math.sin(radians)
  }
}

const describeArc = (startAngle: number, endAngle: number) => {
  const start = toPoint(endAngle)
  const end = toPoint(startAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1'

  return [
    `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${DONUT_RADIUS} ${DONUT_RADIUS} 0 ${largeArcFlag} 0 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`
  ].join(' ')
}

export const TrafficSourcesChart: React.FC<TrafficSourcesChartProps> = ({
  data,
  loading = false,
  title = 'Fuentes de Tráfico',
  totalLabel = 'visitantes únicos',
  emptyText = 'Sin datos de tráfico',
  emptySubtext = 'Los datos aparecerán cuando haya visitas',
  itemLabel = 'Visitantes',
  insightPrimaryLabel = 'Mayor fuente',
  insightCountLabel = 'Diversificación',
  insightCountSuffix = 'fuentes activas',
  headerAction
}) => {
  const normalizedData = useMemo(() => {
    const sourceMap = new Map<string, { name: string; value: number; color?: string; firstIndex: number }>()

    data.forEach((item, index) => {
      const name = item.name?.trim() || 'Desconocido'
      const value = Number(item.value)

      if (!Number.isFinite(value) || value <= 0) return

      const existing = sourceMap.get(name)
      if (existing) {
        sourceMap.set(name, {
          ...existing,
          value: existing.value + value,
          color: existing.color || item.color
        })
        return
      }

      sourceMap.set(name, {
        name,
        value,
        color: item.color,
        firstIndex: index
      })
    })

    return Array.from(sourceMap.values())
      .sort((a, b) => b.value - a.value || a.firstIndex - b.firstIndex)
      .map((item, index) => ({
        ...item,
        color: getSourceColor(item.name, item.color, index)
      }))
  }, [data])

  const totalVisits = normalizedData.reduce((sum, item) => sum + item.value, 0)

  const chartData = useMemo<ChartSource[]>(() => {
    return normalizedData.map((item) => ({
      name: item.name,
      value: item.value,
      color: item.color,
      percentage: totalVisits > 0 ? (item.value / totalVisits) * 100 : 0
    }))
  }, [normalizedData, totalVisits])

  const segments = useMemo<DonutSegment[]>(() => {
    if (totalVisits <= 0) return []

    let angleCursor = 0

    return chartData.map((item) => {
      const sweepAngle = (item.value / totalVisits) * 360
      const gapAngle = chartData.length > 1 ? Math.min(2.4, sweepAngle * 0.28) : 0
      const startAngle = angleCursor + gapAngle / 2
      const endAngle = angleCursor + sweepAngle - gapAngle / 2

      angleCursor += sweepAngle

      return {
        ...item,
        startAngle,
        endAngle,
        isFullCircle: sweepAngle >= 359.9
      }
    }).filter((segment) => segment.isFullCircle || segment.endAngle > segment.startAngle)
  }, [chartData, totalVisits])

  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  const activeSource = activeIndex !== null ? chartData[activeIndex] : null

  const handleSegmentMouseEnter = useCallback((index: number) => (event: React.MouseEvent<SVGElement>) => {
    setActiveIndex(index)
    setTooltipPos({ x: event.clientX, y: event.clientY })
  }, [])

  const handleSegmentMouseMove = useCallback((event: React.MouseEvent<SVGElement>) => {
    setTooltipPos({ x: event.clientX, y: event.clientY })
  }, [])

  const handleSegmentFocus = useCallback((index: number) => (event: React.FocusEvent<SVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setActiveIndex(index)
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [])

  const handleMouseLeave = useCallback(() => {
    setActiveIndex(null)
    setTooltipPos(null)
  }, [])

  const formatTooltipValue = (value: number) => {
    const percentage = totalVisits > 0 ? ((value / totalVisits) * 100).toFixed(1) : '0.0'
    return `${value.toLocaleString('es-MX')} (${percentage}%)`
  }

  return (
    <Card variant="glass" className={styles.container} data-ristak-chart="donut">
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <h3 className={styles.title}>{title}</h3>
          <div className={styles.totalContainer}>
            <span className={styles.totalValue}>
              {totalVisits.toLocaleString('es-MX')}
            </span>
            <span className={styles.totalLabel}>{totalLabel}</span>
          </div>
        </div>
        {headerAction && (
          <div className={styles.headerAction}>
            {headerAction}
          </div>
        )}
      </div>

      <div className={styles.chartContainer}>
        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.loadingText}>Cargando datos...</div>
          </div>
        ) : chartData.length > 0 ? (
          <div className={styles.donutFrame} onMouseLeave={handleMouseLeave}>
            <svg
              className={styles.donutChart}
              viewBox="0 0 200 200"
              role="img"
              aria-label={`${title} con ${totalVisits.toLocaleString('es-MX')} ${totalLabel}`}
              shapeRendering="geometricPrecision"
            >
              <circle
                className={styles.donutTrack}
                cx={DONUT_CENTER}
                cy={DONUT_CENTER}
                r={DONUT_RADIUS}
              />
              {segments.map((segment, index) => {
                const commonProps = {
                  className: styles.donutSegment,
                  stroke: segment.color,
                  tabIndex: 0,
                  role: 'listitem',
                  'aria-label': `${segment.name}: ${segment.value.toLocaleString('es-MX')} ${itemLabel.toLowerCase()}, ${segment.percentage.toFixed(1)}%`,
                  onMouseEnter: handleSegmentMouseEnter(index),
                  onMouseMove: handleSegmentMouseMove,
                  onFocus: handleSegmentFocus(index),
                  onBlur: handleMouseLeave
                }

                if (segment.isFullCircle) {
                  return (
                    <circle
                      key={segment.name}
                      {...commonProps}
                      cx={DONUT_CENTER}
                      cy={DONUT_CENTER}
                      r={DONUT_RADIUS}
                    />
                  )
                }

                return (
                  <path
                    key={segment.name}
                    {...commonProps}
                    d={describeArc(segment.startAngle, segment.endAngle)}
                  />
                )
              })}
            </svg>

            <ChartTooltip
              active={Boolean(activeSource)}
              data={activeSource ? { ...activeSource, label: activeSource.name } : null}
              pointPos={tooltipPos}
              series={[
                {
                  key: 'value',
                  label: itemLabel,
                  color: activeSource?.color ?? 'var(--design-chart-primary, #10b981)'
                }
              ]}
              formatValue={formatTooltipValue}
              verticalOffset={45}
            />

            <div className={styles.centerLabel}>
              <div className={styles.centerValue}>
                {(activeSource?.value ?? totalVisits).toLocaleString('es-MX')}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.emptyContainer} data-ristak-chart-empty>
            <Globe className={styles.emptyIcon} />
            <p className={styles.emptyText}>{emptyText}</p>
            <p className={styles.emptySubtext}>{emptySubtext}</p>
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
            const percentage = item.percentage.toFixed(1)

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
                    {item.value.toLocaleString('es-MX')}
                  </span>
                </div>

                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{
                      width: `${item.percentage}%`,
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
            <p className={styles.insightLabel}>{insightPrimaryLabel}</p>
            <p className={styles.insightValue}>
              {chartData[0].name} <span className={styles.insightHighlight}>{chartData[0].percentage.toFixed(1)}%</span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>{insightCountLabel}</p>
            <p className={styles.insightValue}>{chartData.length} {insightCountSuffix}</p>
          </div>
        </div>
      )}
    </Card>
  )
}
