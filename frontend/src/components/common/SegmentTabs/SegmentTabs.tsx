import React from 'react'

export interface SegmentTab {
  id: string
  label: string
  icon?: React.ReactNode
  trailingIcon?: React.ReactNode
  disabled?: boolean
}

interface SegmentTabsProps {
  tabs: SegmentTab[]
  value: string
  onChange: (id: string) => void
  className?: string
  'aria-label'?: string
}

/**
 * Barra de pestañas tipo "folder/underline" reutilizable, con el estilo global
 * del sistema de diseño (recipe `[data-segdir]`): contenedor con línea inferior y
 * la pestaña activa rellena con el acento del tema. Pensada para sub-secciones de
 * página (Sitios, Analíticas, etc.). No fija `background` inline para que el
 * recipe `[data-segdir][data-on='true']` gobierne el estado activo.
 */
export const SegmentTabs: React.FC<SegmentTabsProps> = ({
  tabs,
  value,
  onChange,
  className,
  'aria-label': ariaLabel
}) => (
  <div
    role="tablist"
    aria-label={ariaLabel}
    className={className}
    data-scroll
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      marginBottom: 18,
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      overflowY: 'hidden',
      scrollbarWidth: 'none'
    }}
  >
    {tabs.map((tab) => {
      const active = tab.id === value
      return (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active}
          disabled={tab.disabled}
          data-segdir=""
          data-on={active ? 'true' : undefined}
          onClick={() => onChange(tab.id)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            flex: '0 0 auto',
            fontSize: 13,
            fontWeight: 600,
            padding: '9px 15px',
            borderRadius: '8px 8px 0 0',
            border: '1px solid transparent',
            borderBottom: '2px solid transparent',
            marginBottom: -1,
            color: 'var(--text-dim)',
            cursor: tab.disabled ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            transition: 'color .15s ease, background .15s ease'
          }}
        >
          {tab.icon}
          <span>{tab.label}</span>
          {tab.trailingIcon}
        </button>
      )
    })}
  </div>
)

export default SegmentTabs
