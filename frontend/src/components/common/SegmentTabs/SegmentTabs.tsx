import React from 'react'
import { cn } from '@/utils/cn'
import styles from './SegmentTabs.module.css'

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
    className={cn(styles.root, className)}
    data-scroll
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
          className={styles.tab}
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
