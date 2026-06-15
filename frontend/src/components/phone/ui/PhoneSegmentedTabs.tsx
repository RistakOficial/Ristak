import React from 'react'
import { cn } from '@/utils/cn'
import styles from './PhoneSegmentedTabs.module.css'

export interface PhoneSegmentedTabOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

interface PhoneSegmentedTabsProps {
  options: PhoneSegmentedTabOption[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  className?: string
  disabled?: boolean
}

export const PhoneSegmentedTabs: React.FC<PhoneSegmentedTabsProps> = ({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  disabled = false
}) => {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

    const enabledOptions = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled)

    if (enabledOptions.length === 0) return

    event.preventDefault()

    const enabledPosition = enabledOptions.findIndex(({ index }) => index === currentIndex)
    const fallbackPosition = enabledOptions.findIndex(({ option }) => option.value === value)
    const currentPosition = enabledPosition >= 0 ? enabledPosition : Math.max(fallbackPosition, 0)
    let nextPosition = currentPosition

    if (event.key === 'ArrowRight') {
      nextPosition = (currentPosition + 1) % enabledOptions.length
    } else if (event.key === 'ArrowLeft') {
      nextPosition = (currentPosition - 1 + enabledOptions.length) % enabledOptions.length
    } else if (event.key === 'Home') {
      nextPosition = 0
    } else if (event.key === 'End') {
      nextPosition = enabledOptions.length - 1
    }

    const nextValue = enabledOptions[nextPosition]?.option.value
    if (nextValue && nextValue !== value) {
      onChange(nextValue)
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(styles.root, className)}
      data-phone-segmented-tabs
    >
      {options.map((option, index) => {
        const isActive = option.value === value
        const isDisabled = disabled || option.disabled

        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={isDisabled}
            data-phone-segmented-tab
            data-active={isActive ? 'true' : undefined}
            className={cn(styles.tab, isActive && styles.tabActive)}
            onClick={() => {
              if (!isDisabled) onChange(option.value)
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className={styles.tabLabel}>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
