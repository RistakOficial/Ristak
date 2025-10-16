import React, { useMemo } from 'react'

interface ActiveDotsProps {
  data: any[]
  activeIndex: number
  series: { key: string; label: string; color: string }[]
  width: number
  height: number
  marginLeft?: number
  marginRight?: number
  marginTop?: number
  marginBottom?: number
}

export const ActiveDots: React.FC<ActiveDotsProps> = ({
  data,
  activeIndex,
  series,
  width,
  height,
  marginLeft = 5,
  marginRight = 5,
  marginTop = 5,
  marginBottom = 5
}) => {
  const dotPositions = useMemo(() => {
    if (activeIndex < 0 || !data[activeIndex]) return []

    const chartWidth = width - marginLeft - marginRight
    const chartHeight = height - marginTop - marginBottom
    const x = marginLeft + (activeIndex / (data.length - 1)) * chartWidth

    // Encontrar valores máximos para escalar correctamente
    const allValues: number[] = []
    data.forEach(item => {
      series.forEach(serie => {
        if (typeof item[serie.key] === 'number') {
          allValues.push(item[serie.key])
        }
      })
    })
    const maxValue = Math.max(...allValues)

    return series.map(serie => {
      const value = data[activeIndex][serie.key]
      if (typeof value !== 'number') return null

      const y = marginTop + chartHeight - (value / maxValue) * chartHeight * 0.75 // 0.75 porque los datos ocupan 75% del gráfico

      return {
        key: serie.key,
        x,
        y,
        color: serie.color,
        value
      }
    }).filter(Boolean)
  }, [data, activeIndex, series, width, height, marginLeft, marginRight, marginTop, marginBottom])

  if (activeIndex < 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 10
      }}
    >
      {dotPositions.map((dot) => dot && (
        <div
          key={dot.key}
          style={{
            position: 'absolute',
            left: `${dot.x}px`,
            top: `${dot.y}px`,
            transform: 'translate(-50%, -50%)',
            transition: 'all 150ms ease-out'
          }}
        >
          {/* Círculo exterior (borde) */}
          <div
            style={{
              width: '14px',
              height: '14px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-background-primary)',
              border: `3px solid ${dot.color}`,
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)'
            }}
          />
          {/* Círculo interior (relleno) */}
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: dot.color
            }}
          />
        </div>
      ))}
    </div>
  )
}