import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
  className?: string
}

export const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  variant = 'default',
  className
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0, ready: false })

  const updateIndicator = useCallback(() => {
    const container = containerRef.current
    const activeButton = tabRefs.current[activeTab]

    if (!container || !activeButton) {
      setIndicatorStyle(prev => ({ ...prev, ready: false }))
      return
    }

    const containerRect = container.getBoundingClientRect()
    const activeRect = activeButton.getBoundingClientRect()

    setIndicatorStyle({
      left: activeRect.left - containerRect.left + container.scrollLeft,
      width: activeRect.width,
      ready: true
    })
  }, [activeTab])

  useLayoutEffect(() => {
    updateIndicator()

    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver(updateIndicator)
    resizeObserver.observe(container)
    Object.values(tabRefs.current).forEach(tab => {
      if (tab) resizeObserver.observe(tab)
    })

    return () => resizeObserver.disconnect()
  }, [tabs, updateIndicator])

  const containerClasses = cn(
    'relative inline-flex items-center gap-1 overflow-hidden rounded-xl border border-[rgba(148,163,184,0.18)] bg-[rgba(148,163,184,0.06)] backdrop-blur-xl dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
    variant === 'default' ? 'p-1' : 'p-0.5',
    className
  )

  return (
    <div ref={containerRef} className={containerClasses} data-ristak-tablist>
      <span
        aria-hidden="true"
        data-ristak-tablist-indicator
        className={cn(
          'pointer-events-none absolute rounded-lg bg-[rgba(148,163,184,0.16)] shadow-none transition-[transform,width,opacity] duration-200 ease-out dark:shadow-[0_10px_20px_-16px_rgba(15,23,42,0.45)]',
          variant === 'default' ? 'top-1 bottom-1' : 'top-0.5 bottom-0.5',
          indicatorStyle.ready ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          width: `${indicatorStyle.width}px`,
          transform: `translateX(${indicatorStyle.left}px)`
        }}
      />
      {tabs.map((tab) => {
        const isActive = tab.value === activeTab

        const button = (
          <button
            ref={(node) => {
              tabRefs.current[tab.value] = node
            }}
            onClick={() => onTabChange(tab.value)}
            data-ristak-tablist-tab
            data-active={isActive ? 'true' : undefined}
            className={cn(
              'relative z-10 flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150',
              isActive
                ? 'text-[var(--color-text-primary)]'
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
          <HelpTooltip key={tab.value} content={tab.description}>
            {button}
          </HelpTooltip>
        )
      })}
    </div>
  )
}
