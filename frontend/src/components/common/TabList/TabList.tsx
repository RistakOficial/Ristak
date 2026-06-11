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
    'items-center gap-1 rounded-xl border border-[rgba(148,163,184,0.18)] bg-[rgba(148,163,184,0.06)] backdrop-blur-xl dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
    fullWidth ? 'flex w-full' : 'inline-flex',
    variant === 'default' ? 'p-1' : 'p-0.5',
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
              'relative rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5',
              fullWidth && 'flex-1 w-full justify-center',
              isActive
                ? 'bg-[rgba(148,163,184,0.16)] text-[var(--color-text-primary)] dark:shadow-[0_10px_20px_-16px_rgba(15,23,42,0.45)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[rgba(148,163,184,0.12)]'
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
