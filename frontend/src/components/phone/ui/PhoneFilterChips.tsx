import React from 'react'
import { cn } from '@/utils/cn'
import styles from './PhoneFilterChips.module.css'

export interface PhoneFilterChipOption<Value extends string = string> {
  value: Value
  label: React.ReactNode
  ariaLabel?: string
  count?: React.ReactNode
  disabled?: boolean
  separatorBefore?: boolean
  /** 'comments' pinta el chip con el color info (vista de Comentarios, aparte de
   *  los filtros de mensajes). */
  tone?: 'comments'
}

interface PhoneFilterChipsProps<Value extends string = string> {
  options: Array<PhoneFilterChipOption<Value>>
  value: Value
  onChange: (value: Value) => void
  ariaLabel: string
  className?: string
  disabled?: boolean
  hidden?: boolean
  wrapOnWide?: boolean
}

export function PhoneFilterChips<Value extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  disabled = false,
  hidden = false,
  wrapOnWide = false
}: PhoneFilterChipsProps<Value>) {
  return (
    <div
      className={cn(styles.root, wrapOnWide && styles.wrapOnWide, className)}
      data-phone-filter-chips
      data-phone-filter-chips-wrap-wide={wrapOnWide ? 'true' : undefined}
      data-phone-chat-scrollable="true"
      role="tablist"
      aria-label={ariaLabel}
      aria-hidden={hidden || undefined}
    >
      {options.map((option) => {
        const isActive = option.value === value
        const isDisabled = disabled || option.disabled

        return (
          <React.Fragment key={option.value}>
            {option.separatorBefore ? <span className={styles.separator} aria-hidden="true" /> : null}
            <button
              type="button"
              role="tab"
              className={cn(styles.chip, isActive && styles.chipActive, option.tone === 'comments' && styles.chipComments)}
              aria-label={option.ariaLabel}
              aria-selected={isActive}
              aria-pressed={isActive}
              tabIndex={isActive ? 0 : -1}
              disabled={isDisabled}
              data-phone-filter-chip
              data-active={isActive ? 'true' : undefined}
              onClick={() => {
                if (!isDisabled) onChange(option.value)
              }}
            >
              <span>{option.label}</span>
              {option.count !== undefined ? <small>{option.count}</small> : null}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default PhoneFilterChips
