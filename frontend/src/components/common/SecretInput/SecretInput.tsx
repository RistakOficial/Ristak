import React, { forwardRef, useId } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { cn } from '@/utils/cn'
import styles from './SecretInput.module.css'

export interface SecretInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'value'> {
  value: string
  onChange: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void
  visible?: boolean
  onVisibleChange: (visible: boolean) => void
  revealLabel?: string
  hideLabel?: string
  leadingIcon?: React.ReactNode
}

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(({
  value,
  onChange,
  visible = false,
  onVisibleChange,
  revealLabel = 'Mostrar valor',
  hideLabel = 'Ocultar valor',
  leadingIcon = <KeyRound size={17} />,
  className,
  disabled,
  id,
  autoComplete = 'off',
  spellCheck = false,
  ...inputProps
}, ref) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <span
      className={cn(styles.root, className)}
      data-ristak-unstyled
      data-ristak-secret-input
      data-disabled={disabled ? 'true' : undefined}
    >
      <span className={styles.leadingIcon} aria-hidden="true">{leadingIcon}</span>
      <input
        {...inputProps}
        ref={ref}
        id={inputId}
        className={styles.input}
        type={visible ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        onChange={(event) => onChange(event.target.value, event)}
      />
      <button
        type="button"
        className={styles.revealButton}
        aria-label={visible ? hideLabel : revealLabel}
        aria-pressed={visible}
        disabled={disabled}
        onClick={() => onVisibleChange(!visible)}
      >
        {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </span>
  )
})

SecretInput.displayName = 'SecretInput'
