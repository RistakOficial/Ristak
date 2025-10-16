import React from 'react'
import ReactDOM from 'react-dom'

interface ChartTooltipProps {
  active: boolean
  data: any
  mousePos: { x: number; y: number }
  series: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  active,
  data,
  mousePos,
  series,
  formatValue
}) => {
  if (!active || !data) {
    return null
  }

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
        {data.label && (
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            {data.label}
          </p>
        )}
        <div className="space-y-1.5">
          {series.map((serie) => {
            const value = data[serie.key]
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