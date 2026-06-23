import React, { forwardRef, useId } from 'react'
import { cn } from '@/utils/cn'
import styles from './PathInput.module.css'

export interface PathInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'prefix' | 'size' | 'type'> {
  value: string
  prefix: React.ReactNode
  onChange: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void
  prefixTitle?: string
  suffix?: React.ReactNode
  size?: 'md' | 'lg'
}

export const PathInput = forwardRef<HTMLInputElement, PathInputProps>(({
  value,
  prefix,
  onChange,
  prefixTitle,
  suffix,
  size = 'md',
  className,
  disabled,
  id,
  inputMode = 'url',
  autoCapitalize = 'off',
  autoCorrect = 'off',
  spellCheck = false,
  ...inputProps
}, ref) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <label
      className={cn(styles.root, className)}
      data-ristak-unstyled
      data-ristak-path-input
      data-size={size}
      data-disabled={disabled ? 'true' : undefined}
    >
      <span className={styles.prefix} title={prefixTitle}>
        {prefix}
      </span>
      <span className={styles.divider} aria-hidden="true" />
      <input
        {...inputProps}
        ref={ref}
        id={inputId}
        type="text"
        className={styles.input}
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        spellCheck={spellCheck}
        onChange={(event) => onChange(event.target.value, event)}
      />
      {suffix ? (
        <span className={styles.suffix} aria-hidden="true">
          {suffix}
        </span>
      ) : null}
    </label>
  )
})

PathInput.displayName = 'PathInput'
