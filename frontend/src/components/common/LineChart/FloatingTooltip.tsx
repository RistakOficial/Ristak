import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'

interface FloatingTooltipProps {
  chartRef: React.RefObject<HTMLDivElement>
  data: any[]
  series: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
}

export const FloatingTooltip: React.FC<FloatingTooltipProps> = ({
  chartRef,
  data,
  series,
  formatValue
}) => {
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [isHovering, setIsHovering] = useState(false)
  const [activeData, setActiveData] = useState<any>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    let animationFrame: number

    const handleMouseMove = (e: MouseEvent) => {
      // Actualizar posición del mouse en tiempo real
      animationFrame = requestAnimationFrame(() => {
        setMousePos({ x: e.clientX, y: e.clientY })

        // Verificar si estamos sobre el gráfico
        if (chartRef.current) {
          const rect = chartRef.current.getBoundingClientRect()
          const isInChart =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom

          setIsHovering(isInChart)

          if (isInChart && data.length > 0) {
            // Calcular qué punto de datos está más cerca
            const relativeX = e.clientX - rect.left
            const chartWidth = rect.width
            const dataIndex = Math.round((relativeX / chartWidth) * (data.length - 1))
            const clampedIndex = Math.max(0, Math.min(data.length - 1, dataIndex))

            if (clampedIndex !== activeIndex) {
              setActiveIndex(clampedIndex)
              setActiveData(data[clampedIndex])
            }
          }
        }
      })
    }

    const handleMouseLeave = () => {
      setIsHovering(false)
      setActiveData(null)
      setActiveIndex(-1)
    }

    // Escuchar eventos globalmente
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleMouseLeave)
      if (animationFrame) {
        cancelAnimationFrame(animationFrame)
      }
    }
  }, [chartRef, data, activeIndex])

  if (!isHovering || !activeData) {
    return null
  }

  // Construir el contenido del tooltip
  const tooltipContent = (
    <div
      style={{
        position: 'fixed',
        left: mousePos.x,
        top: mousePos.y - 100, // SIEMPRE 100px arriba del cursor
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
        zIndex: 2147483647, // Máximo z-index posible
        transition: 'none', // Sin transiciones para seguimiento inmediato
      }}
    >
      <div className="glass rounded-lg border border-[rgba(148,163,184,0.14)] px-4 py-3 dark:shadow-[0_18px_35px_-25px_rgba(15,23,42,0.6)] bg-[var(--color-background-primary)]">
        {activeData.label && (
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            {activeData.label}
          </p>
        )}
        <div className="space-y-1.5">
          {series.map((serie) => {
            const value = activeData[serie.key]
            if (typeof value !== 'number') return null

            return (
              <div key={serie.key} className="flex items-center gap-2 text-sm">
                <span
                  className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: serie.color }}
                />
                <span className="text-[var(--color-text-secondary)]">{serie.label}:</span>
                <span className="font-medium text-[var(--color-text-primary)]">
                  {formatValue(value, serie.key)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )

  // Renderizar en portal para estar fuera de todos los contenedores
  return ReactDOM.createPortal(tooltipContent, document.body)
}