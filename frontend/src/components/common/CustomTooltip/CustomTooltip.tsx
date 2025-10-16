import React from 'react'
import { TooltipProps } from 'recharts'

interface CustomTooltipProps extends TooltipProps<any, any> {
  series?: any[]
  formatValue?: (value: number, key: string) => string
  children?: React.ReactNode
}

export const CustomTooltip: React.FC<CustomTooltipProps> = ({
  active,
  payload,
  label,
  coordinate,
  series,
  formatValue,
  children
}) => {
  if (!active || !payload || !coordinate) return null

  // Renderizar el contenido personalizado si se proporciona
  if (children && React.isValidElement(children)) {
    const childElement = React.cloneElement(children as React.ReactElement, {
      active,
      payload,
      label,
      series,
      formatValue
    })

    return (
      <div
        style={{
          position: 'absolute',
          left: coordinate.x,
          top: coordinate.y - 100, // Siempre 100px arriba del punto
          transform: 'translateX(-50%)', // Centrar horizontalmente
          pointerEvents: 'none',
          zIndex: 1000
        }}
      >
        {childElement}
      </div>
    )
  }

  // Tooltip por defecto si no hay children
  return (
    <div
      style={{
        position: 'absolute',
        left: coordinate.x,
        top: coordinate.y - 100, // Siempre 100px arriba del punto
        transform: 'translateX(-50%)', // Centrar horizontalmente
        pointerEvents: 'none',
        zIndex: 1000
      }}
    >
      <div className="glass rounded-lg border border-[rgba(148,163,184,0.14)] px-4 py-3 shadow-2xl">
        {label && (
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            {label}
          </p>
        )}
        <div className="space-y-1.5">
          {payload.map((entry: any, index: number) => {
            const seriesInfo = series?.find((s: any) => s.key === entry.dataKey)
            return (
              <div key={index} className="flex items-center gap-2 text-sm">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: entry.color || seriesInfo?.color }}
                />
                <span className="text-[var(--color-text-secondary)]">
                  {entry.name || seriesInfo?.label}:
                </span>
                <span className="font-medium text-[var(--color-text-primary)]">
                  {typeof entry.value === 'number'
                    ? (formatValue ? formatValue(entry.value, entry.dataKey) : entry.value.toLocaleString())
                    : entry.value}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default CustomTooltip