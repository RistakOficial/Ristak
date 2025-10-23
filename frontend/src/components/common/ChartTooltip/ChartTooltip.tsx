import React, { useEffect, useRef, useState, useLayoutEffect } from 'react'
import ReactDOM from 'react-dom'
import styles from './ChartTooltip.module.css'

interface ChartTooltipProps {
  active: boolean
  data: any
  pointPos: { x: number; y: number } | null
  series: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
  verticalOffset?: number
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  active,
  data,
  pointPos,
  series,
  formatValue,
  verticalOffset = 12
}) => {
  const [shouldHide, setShouldHide] = useState(false)
  const [renderPoint, setRenderPoint] = useState<{ x: number; y: number } | null>(null)
  const lastValidPointRef = useRef<{ x: number; y: number } | null>(null)

  // Detectar si hay un modal abierto o un date range picker activo observando el body
  useEffect(() => {
    if (typeof document === 'undefined') return

    const checkBodyState = () => {
      const body = document.body
      const hasOverflowHidden = body.style.overflow === 'hidden'
      const isDatePickerOpen = body.classList.contains('date-range-picker-open')
      setShouldHide(hasOverflowHidden || isDatePickerOpen)
    }

    // Verificar al montar
    checkBodyState()

    // Observar cambios en los atributos relevantes del body
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === 'attributes' &&
          (mutation.attributeName === 'style' || mutation.attributeName === 'class')
        ) {
          checkBodyState()
        }
      })
    })

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class']
    })

    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!active) {
      setRenderPoint(null)
      lastValidPointRef.current = null
      return
    }

    if (!pointPos) {
      return
    }

    const { x, y } = pointPos
    const hasFiniteCoords = Number.isFinite(x) && Number.isFinite(y)
    const isOrigin = x === 0 && y === 0

    if (!hasFiniteCoords || isOrigin) {
      return
    }

    lastValidPointRef.current = pointPos

    setRenderPoint(prev => {
      if (prev && prev.x === pointPos.x && prev.y === pointPos.y) {
        return prev
      }
      return pointPos
    })
  }, [active, pointPos])

  const effectivePoint = renderPoint ?? lastValidPointRef.current

  // No mostrar tooltip si hay superposición activa que bloquearía la interacción
  const shouldRender = active && data && effectivePoint && !shouldHide

  // IMPORTANTE: NUNCA usar early return - siempre renderizar el portal
  // para evitar error React #185 (renders inconsistentes)

  type TooltipStyle = React.CSSProperties & { '--tooltip-gap'?: string }

  const clampedOffset = Number.isFinite(verticalOffset)
    ? Math.max(0, verticalOffset)
    : 12

  // Calcular contenido del tooltip (puede ser null si no debe mostrarse)
  let tooltipContent: React.ReactNode = null

  if (shouldRender && effectivePoint) {
    const tooltipStyle: TooltipStyle = {
      position: 'fixed',
      left: effectivePoint.x,
      top: effectivePoint.y,
      transform: 'translate(-50%, calc(-100% - var(--tooltip-gap)))',
      pointerEvents: 'none',
      zIndex: 9998,
      '--tooltip-gap': `${clampedOffset}px`
    }

    tooltipContent = (
      <div style={tooltipStyle}>
        <div className={styles.tooltip}>
          {data.label && <p className={styles.tooltipLabel}>{data.label}</p>}
          <div className={styles.seriesGroup}>
            {series.map((serie) => {
              const value = data[serie.key]
              if (typeof value !== 'number') return null

              return (
                <div key={serie.key} className={styles.seriesRow}>
                  <span
                    className={styles.seriesColor}
                    style={{ backgroundColor: serie.color }}
                  />
                  <span className={styles.seriesLabel}>{`${serie.label}:`}</span>
                  <span className={styles.seriesValue}>
                    {formatValue(value, serie.key)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // SIEMPRE renderizar en portal (incluso si el contenido es null)
  // Esto asegura que React siempre vea el mismo número de hooks
  return ReactDOM.createPortal(tooltipContent, document.body)
}
