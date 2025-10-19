import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import styles from './ChartTooltip.module.css'

interface ChartTooltipProps {
  active: boolean
  data: any
  pointPos: { x: number; y: number } | null
  series: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  active,
  data,
  pointPos,
  series,
  formatValue
}) => {
  const [shouldHide, setShouldHide] = useState(false)

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

  // No mostrar tooltip si hay superposición activa que bloquearía la interacción
  if (!active || !data || !pointPos || shouldHide) {
    return null
  }

  const tooltipStyle: React.CSSProperties = {
    position: 'fixed',
    left: pointPos.x,
    top: pointPos.y,
    transform: 'translate(-50%, calc(-100% - 8px))',
    pointerEvents: 'none',
    zIndex: 9998,
    transition: 'left 150ms ease-out, top 150ms ease-out'
  }

  const tooltipContent = (
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

  // Renderizar en portal para estar fuera de todos los contenedores
  return ReactDOM.createPortal(tooltipContent, document.body)
}
