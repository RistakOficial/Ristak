import React, { useMemo, useState, useEffect, useRef } from 'react'
import { BarChart as RechartsBarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useChartHover } from '@/hooks/useChartHover'
import { DEFAULT_BAR_RADIUS, getTopRoundedBarPath } from '../chartShapes'
import { ChartTooltip } from '../ChartTooltip/ChartTooltip'
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
  color = 'var(--accent)',
  xAxisLabel,
  yAxisLabel,
  formatTooltip = (value) => value.toString(),
  formatXAxis = (value) => value
}) => {
  const minHeight = typeof height === 'number' ? `${height}px` : height

  // Convertir data a formato compatible con useChartHover (label en vez de name)
  const chartData = useMemo(() =>
    data.map(item => ({ label: item.name, value: item.value })),
    [data]
  )

  const { chartRef, pointPos: _pointPos, isHovering, activeIndex, activeData } = useChartHover({ data: chartData })
  const [actualPointPos, setActualPointPos] = useState<{ x: number; y: number } | null>(null)
  const activePointRef = useRef<{ x: number; y: number } | null>(null)
  const pendingUpdateRef = useRef<{ x: number; y: number } | null>(null)

  // Resetear cuando cambia el índice o deja de hacer hover
  useEffect(() => {
    if (!isHovering) {
      setActualPointPos(null)
      activePointRef.current = null
      pendingUpdateRef.current = null
    } else {
      // Limpiar los puntos del índice anterior
      activePointRef.current = null
      pendingUpdateRef.current = null
    }
  }, [isHovering, activeIndex])

  // Actualizar posición después del render
  useEffect(() => {
    if (pendingUpdateRef.current) {
      setActualPointPos(pendingUpdateRef.current)
      pendingUpdateRef.current = null
    }
  }, [isHovering, activeIndex])

  const series = useMemo(() => [
    { key: 'value', label: 'Registros', color }
  ], [color])

  const resolvedPointPos = actualPointPos ?? pendingUpdateRef.current ?? null
  const tooltipAnchor = resolvedPointPos

  // Calcular offset vertical dinámico (igual que LineChart)
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

  if (loading) {
    return (
      <div className={styles.loadingContainer} style={{ height: '100%', minHeight }}>
        <div className={styles.loadingSpinner} />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className={styles.emptyContainer} data-ristak-chart-empty style={{ height: '100%', minHeight }}>
        <p className={styles.emptyMessage}>No hay datos disponibles para el período seleccionado</p>
      </div>
    )
  }

  return (
    <div className={styles.container} data-ristak-chart="bar" style={{ height: '100%', minHeight }}>
      <div ref={chartRef} className={styles.chartFrame}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={data}
            margin={{ top: 10, right: 10, left: 0, bottom: 20 }}
          >
            <CartesianGrid
              strokeDasharray="var(--design-chart-grid-dash, 3 3)"
              stroke="var(--design-chart-grid, var(--color-border))"
              vertical={false}
            />
            <XAxis
              dataKey="name"
              stroke="var(--design-chart-grid, var(--color-text-tertiary))"
              tick={{ fill: 'var(--design-chart-axis, var(--color-text-secondary))', fontSize: 12, fontFamily: 'var(--font-app)' }}
              tickFormatter={formatXAxis}
              label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, fill: 'var(--color-text-tertiary)' } : undefined}
            />
            <YAxis
              stroke="var(--design-chart-grid, var(--color-text-tertiary))"
              tick={{ fill: 'var(--design-chart-axis, var(--color-text-secondary))', fontSize: 12, fontFamily: 'var(--font-app)' }}
              allowDecimals={false}
              label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fill: 'var(--color-text-tertiary)' } : undefined}
            />
            <Bar
              dataKey="value"
              radius={[DEFAULT_BAR_RADIUS, DEFAULT_BAR_RADIUS, 0, 0]}
              animationDuration={300}
              isAnimationActive={true}
              shape={(props: any) => {
                const { x, y, width, height, index } = props
                const isActive = index === activeIndex
                const hasValue = data[index]?.value > 0
                const barPath = hasValue ? getTopRoundedBarPath(x, y, width, height) : ''

                // Capturar la posición del punto más alto de la barra cuando está activa
                if (isActive && hasValue && x !== undefined && y !== undefined) {
                  const rect = chartRef.current?.getBoundingClientRect()
                  if (rect) {
                    // Punto en el centro superior de la barra
                    const pointX = rect.left + x + width / 2
                    const pointY = rect.top + y
                    activePointRef.current = { x: pointX, y: pointY }
                    pendingUpdateRef.current = { x: pointX, y: pointY }
                  }
                }

                return (
                  <g>
                    {/* Barra visible */}
                    {barPath && (
                      <path
                        d={barPath}
                        fill={color}
                        opacity={isActive ? 1 : 0.9}
                        style={{
                          transition: 'opacity 150ms ease-out',
                          cursor: 'default'
                        }}
                      />
                    )}
                    {/* Área interactiva invisible SOLO si hay valor */}
                    {hasValue && (
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
                    )}
                  </g>
                )
              }}
            />
          </RechartsBarChart>
        </ResponsiveContainer>

        {/* Tooltip flotante personalizado (igual que LineChart) */}
        <ChartTooltip
          active={isHovering && Boolean(resolvedPointPos)}
          data={activeData}
          pointPos={resolvedPointPos}
          series={series}
          formatValue={(value) => formatTooltip(value)}
          verticalOffset={tooltipVerticalOffset}
        />
      </div>
    </div>
  )
}
