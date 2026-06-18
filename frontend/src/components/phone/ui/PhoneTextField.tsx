import React, { useEffect, useState } from 'react'
import styles from './PhoneTextField.module.css'

interface PhoneTextFieldBaseProps {
  label?: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  className?: string
  ariaLabel?: string
  leading?: React.ReactNode
  onBlur?: () => void
  onSubmit?: () => void
}

interface PhoneTextFieldProps extends PhoneTextFieldBaseProps {
  type?: 'text' | 'email' | 'tel' | 'number' | 'password' | 'url' | 'search'
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  maxLength?: number
}

interface PhoneTextAreaProps extends PhoneTextFieldBaseProps {
  rows?: number
  maxLength?: number
}

const sanitizeNumericDraft = (raw: string) => {
  let value = raw.replace(',', '.').replace(/[^\d.]/g, '')
  const dotIndex = value.indexOf('.')
  if (dotIndex !== -1) {
    value = `${value.slice(0, dotIndex + 1)}${value.slice(dotIndex + 1).replace(/\./g, '')}`
  }
  return value
}

/**
 * Campo de texto estándar de la app móvil: etiqueta arriba y caja tipo pastilla
 * con el mismo borde, fondo y tipografía que los selects del celular.
 * Usa font-size de 16px para que iOS no haga zoom al enfocar.
 */
export const PhoneTextField: React.FC<PhoneTextFieldProps> = ({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  maxLength,
  disabled = false,
  invalid = false,
  autoFocus = false,
  className = '',
  ariaLabel,
  leading,
  onBlur,
  onSubmit
}) => {
  const isNumeric = type === 'number'
  const [draft, setDraft] = useState(() => isNumeric ? sanitizeNumericDraft(value) : value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!isNumeric || editing) return
    setDraft(sanitizeNumericDraft(value))
  }, [editing, isNumeric, value])

  const displayValue = isNumeric ? (editing ? draft : sanitizeNumericDraft(value)) : value

  return (
    <label className={`${styles.field} ${className}`.trim()}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={`${styles.control} ${invalid ? styles.invalid : ''} ${disabled ? styles.disabled : ''}`.trim()}>
        {leading && <span className={styles.leading}>{leading}</span>}
        <input
          type={isNumeric ? 'text' : type}
          inputMode={inputMode || (isNumeric ? 'decimal' : undefined)}
          value={displayValue}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel || label}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            if (isNumeric) {
              setEditing(true)
              setDraft(sanitizeNumericDraft(value))
            }
          }}
          onChange={(event) => {
            if (!isNumeric) {
              onChange(event.target.value)
              return
            }
            const nextDraft = sanitizeNumericDraft(event.target.value)
            setDraft(nextDraft)
            onChange(nextDraft)
          }}
          onBlur={() => {
            if (isNumeric) setEditing(false)
            onBlur?.()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
      </span>
      {hint && <small className={styles.hint}>{hint}</small>}
    </label>
  )
}

/** Área de texto estándar de la app móvil, mismo lenguaje visual que PhoneTextField. */
export const PhoneTextArea: React.FC<PhoneTextAreaProps> = ({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  disabled = false,
  invalid = false,
  autoFocus = false,
  className = '',
  ariaLabel,
  onBlur
}) => (
  <label className={`${styles.field} ${className}`.trim()}>
    {label && <span className={styles.label}>{label}</span>}
    <span className={`${styles.control} ${styles.controlArea} ${invalid ? styles.invalid : ''} ${disabled ? styles.disabled : ''}`.trim()}>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel || label}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </span>
    {hint && <small className={styles.hint}>{hint}</small>}
  </label>
)
