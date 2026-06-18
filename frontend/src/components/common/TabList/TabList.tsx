import React from 'react'
import { HelpTooltip } from '@/components/common/HelpTooltip'
import { cn } from '@/utils/cn'

interface Tab {
  value: string
  label: string
  icon?: React.ReactNode
  description?: React.ReactNode
}

interface TabListProps {
  tabs: Tab[]
  activeTab: string
  onTabChange: (value: string) => void
  variant?: 'default' | 'compact'
  /** Ocupa todo el ancho disponible y reparte las pestañas en partes iguales. */
  fullWidth?: boolean
  className?: string
}

export const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  variant = 'default',
  fullWidth = false,
  className
}) => {
  const containerClasses = cn(
    // borde más marcado + sombra sutil: el control se lee como un segmentado
    // elevado incluso cuando el track (--surface-2) coincide con el fondo (Onyx).
    'items-center gap-[3px] rounded-[var(--radius-ctl)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-[3px] shadow-[var(--shadow-xs)]',
    fullWidth ? 'flex w-full' : 'inline-flex',
    className
  )

  return (
    <div className={containerClasses} data-ristak-tablist>
      {tabs.map((tab) => {
        const isActive = tab.value === activeTab

        const button = (
          <button
            type="button"
            onClick={() => onTabChange(tab.value)}
            data-ristak-tablist-tab
            data-active={isActive ? 'true' : undefined}
            className={cn(
              'relative rounded-[calc(var(--radius-ctl)-3px)] text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5',
              variant === 'default' ? 'px-3 py-1.5' : 'px-2.5 py-1',
              fullWidth && 'flex-1 w-full justify-center',
              isActive
                ? 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] shadow-[var(--shadow-xs)]'
                : 'border border-transparent text-[var(--text-dim)] hover:text-[var(--text)]'
            )}
          >
            {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
            {tab.label}
          </button>
        )

        if (!tab.description) {
          return React.cloneElement(button, { key: tab.value })
        }

        return (
          <HelpTooltip key={tab.value} content={tab.description} className={fullWidth ? 'flex-1 min-w-0' : undefined}>
            {button}
          </HelpTooltip>
        )
      })}
    </div>
  )
}
