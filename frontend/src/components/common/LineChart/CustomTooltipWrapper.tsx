import React, { useEffect, useState } from 'react'

interface CustomTooltipWrapperProps {
  active?: boolean
  payload?: any[]
  label?: string
  coordinate?: { x: number; y: number }
  series: { key: string; label: string; color: string }[]
  formatValue: (value: number, key: string) => string
}

export const CustomTooltipWrapper: React.FC<CustomTooltipWrapperProps> = ({
  active,
  payload,
  label,
  coordinate,
  series,
  formatValue
}) => {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY })
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  if (!active || !payload || payload.length === 0) {
    return null
  }

  const items = payload.map((entry) => {
    const seriesInfo = series.find((serie) => serie.key === entry.dataKey)
    if (!seriesInfo) return null

    return (
      <div key={seriesInfo.key} className="flex items-center gap-2 text-sm">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: seriesInfo.color }}
        />
        <span className="text-[var(--color-text-secondary)]">{seriesInfo.label}:</span>
        <span className="font-medium text-[var(--color-text-primary)]">
          {typeof entry.value === 'number' ? formatValue(entry.value, seriesInfo.key) : entry.value}
        </span>
      </div>
    )
  }).filter(Boolean)

  if (items.length === 0) return null

  // Usar la posición real del mouse, SIEMPRE 120px por encima
  const tooltipStyle: React.CSSProperties = {
    position: 'fixed',
    left: `${mousePosition.x}px`,
    top: `${mousePosition.y - 120}px`, // SIEMPRE 120px por encima del cursor
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    zIndex: 99999,
    willChange: 'transform'
  }

  return (
    <div style={tooltipStyle}>
      <div className="glass rounded-lg border border-[rgba(148,163,184,0.14)] px-4 py-3 dark:shadow-[0_18px_35px_-25px_rgba(15,23,42,0.6)]">
        {label && <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">{label}</p>}
        <div className="space-y-1.5">
          {items}
        </div>
      </div>
    </div>
  )
}