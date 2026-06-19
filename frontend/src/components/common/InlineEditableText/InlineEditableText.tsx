import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import styles from './InlineEditableText.module.css'

type InlineEditableInputType = 'text' | 'email' | 'tel' | 'url'

export interface InlineEditableTextProps {
  value?: string | null
  emptyLabel?: string
  ariaLabel: string
  type?: InlineEditableInputType
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode']
  disabled?: boolean
  className?: string
  layout?: 'inline' | 'block'
  onSave: (value: string) => Promise<void> | void
  normalizeValue?: (value: string) => string
  validate?: (value: string) => string | null | undefined
}

const defaultNormalizeValue = (value: string) => value.trim()
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_ALLOWED_PATTERN = /^\+?[0-9\s().-]+$/
const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15
const MIN_INPUT_SIZE = 4
const MAX_INPUT_SIZE = 64

const getDefaultValidationMessage = (type: InlineEditableInputType, value: string) => {
  if (!value) return null

  if (type === 'email') {
    const parts = value.split('@')
    const domain = parts[1] || ''
    if (
      parts.length !== 2 ||
      !EMAIL_PATTERN.test(value) ||
      domain.startsWith('.') ||
      domain.endsWith('.') ||
      domain.includes('..')
    ) {
      return 'Escribe un correo válido.'
    }
  }

  if (type === 'tel') {
    const digits = value.replace(/\D/g, '')
    const plusCount = (value.match(/\+/g) || []).length
    if (
      !PHONE_ALLOWED_PATTERN.test(value) ||
      plusCount > 1 ||
      (plusCount === 1 && !value.trim().startsWith('+')) ||
      digits.length < MIN_PHONE_DIGITS ||
      digits.length > MAX_PHONE_DIGITS
    ) {
      return 'Escribe un teléfono válido.'
    }
  }

  return null
}

export function InlineEditableText({
  value,
  emptyLabel = 'Sin dato',
  ariaLabel,
  type = 'text',
  inputMode,
  disabled = false,
  className = '',
  layout = 'inline',
  onSave,
  normalizeValue = defaultNormalizeValue,
  validate
}: InlineEditableTextProps) {
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const normalizedValue = normalizeValue(String(value ?? ''))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(normalizedValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!editing) {
      setDraft(normalizedValue)
      setError('')
    }
  }, [editing, normalizedValue])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const commitDraft = async () => {
    if (disabled || saving) return

    const nextValue = normalizeValue(draft)
    const validationMessage = getDefaultValidationMessage(type, nextValue) || validate?.(nextValue)
    if (validationMessage) {
      setError(validationMessage)
      return
    }

    if (nextValue === normalizedValue) {
      setDraft(normalizedValue)
      setEditing(false)
      setError('')
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(nextValue)
      setDraft(nextValue)
      setEditing(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  const cancelEditing = () => {
    setDraft(normalizedValue)
    setError('')
    setEditing(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitDraft()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEditing()
    }
  }

  const rootClassName = [styles.inlineEditableText, className].filter(Boolean).join(' ')
  const displayValue = normalizedValue || emptyLabel
  const inputSize = Math.min(
    Math.max((draft || normalizedValue || '').length + 1, MIN_INPUT_SIZE),
    MAX_INPUT_SIZE
  )

  if (editing) {
    return (
      <span className={rootClassName} data-inline-editing="true" data-layout={layout}>
        <input
          ref={inputRef}
          className={styles.input}
          type={type}
          inputMode={inputMode}
          size={inputSize}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setError('')
          }}
          onBlur={() => {
            void commitDraft()
          }}
          onKeyDown={handleKeyDown}
          disabled={saving}
          aria-label={ariaLabel}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {saving && <span className={styles.status}>Guardando...</span>}
        {error && <span id={errorId} className={styles.error} role="alert">{error}</span>}
      </span>
    )
  }

  return (
    <span className={rootClassName} data-layout={layout}>
      <button
        type="button"
        className={`${styles.displayButton} ${normalizedValue ? '' : styles.emptyValue}`.trim()}
        onClick={() => {
          if (!disabled) setEditing(true)
        }}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {displayValue}
      </button>
    </span>
  )
}
