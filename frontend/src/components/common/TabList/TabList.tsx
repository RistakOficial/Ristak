import React from 'react'
import { cn } from '@/utils/cn'

interface Tab {
  value: string
  label: string
}

interface TabListProps {
  tabs: Tab[]
  activeTab: string
  onTabChange: (value: string) => void
  variant?: 'default' | 'compact'
  className?: string
}

export const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  variant = 'default',
  className
}) => {
  const containerClasses = cn(
    'inline-flex items-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[rgba(148,163,184,0.06)] backdrop-blur-xl dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
    variant === 'default' ? 'p-1' : 'p-0.5',
    className
  )

  return (
    <div className={containerClasses}>
      {tabs.map((tab) => {
        const isActive = tab.value === activeTab

        return (
          <button
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              'relative rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap',
              isActive
                ? 'bg-[rgba(148,163,184,0.16)] text-[var(--color-text-primary)] dark:shadow-[0_10px_20px_-16px_rgba(15,23,42,0.45)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[rgba(148,163,184,0.12)]'
            )}
          >
            {tab.label}
          </button>
        )}
      )}
    </div>
  )
}
