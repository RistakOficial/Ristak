import React, { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { PhoneSheet } from './PhoneSheet'
import styles from './PhoneDurationField.module.css'

type DurationUnit = 'seconds' | 'minutes' | 'days'

interface PhoneDurationFieldProps {
  /** Duración expresada en minutos. Puede ser decimal cuando la unidad elegida son segundos. */
  value: number
  onChange: (minutes: number) => void
  title?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  buttonClassName?: string
}

interface DurationParts {
  amount: number
  unit: DurationUnit
}

interface PickerOption<T extends string | number> {
  value: T
  label: string
}

const MIN_VALUE = 1
const MAX_VALUE = 60
const MINUTES_PER_DAY = 1440
const UNIT_OPTIONS: Array<PickerOption<DurationUnit>> = [
  { value: 'minutes', label: 'minutos' },
  { value: 'seconds', label: 'segundos' },
  { value: 'days', label: 'días' }
]

const numberOptions: Array<PickerOption<number>> = Array.from({ length: MAX_VALUE }, (_, index) => {
  const value = index + 1
  return { value, label: String(value) }
})

const clampAmount = (value: number) => Math.min(MAX_VALUE, Math.max(MIN_VALUE, Math.round(value || MIN_VALUE)))

const isExactDays = (minutes: number) => {
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  const days = minutes / MINUTES_PER_DAY
  return Math.abs(days - Math.round(days)) < 0.000001 && days >= MIN_VALUE && days <= MAX_VALUE
}

const resolveDurationParts = (minutes: number): DurationParts => {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { amount: 30, unit: 'minutes' }
  }

  if (minutes > 0 && minutes < 1) {
    return { amount: clampAmount(minutes * 60), unit: 'seconds' }
  }

  if (isExactDays(minutes)) {
    return { amount: clampAmount(minutes / MINUTES_PER_DAY), unit: 'days' }
  }

  return { amount: clampAmount(minutes), unit: 'minutes' }
}

const toMinutes = (amount: number, unit: DurationUnit) => {
  const safeAmount = clampAmount(amount)
  if (unit === 'seconds') return safeAmount / 60
  if (unit === 'days') return safeAmount * MINUTES_PER_DAY
  return safeAmount
}

export function formatDurationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return ''

  const totalSeconds = Math.max(1, Math.round(minutes * 60))
  if (totalSeconds < 60) {
    return totalSeconds === 1 ? '1 segundo' : `${totalSeconds} segundos`
  }

  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalSeconds % (MINUTES_PER_DAY * 60) === 0) {
    const days = totalSeconds / (MINUTES_PER_DAY * 60)
    return days === 1 ? '1 día' : `${days} días`
  }

  if (totalMinutes < 60) {
    return totalMinutes === 1 ? '1 minuto' : `${totalMinutes} minutos`
  }

  const hours = Math.floor(totalMinutes / 60)
  const rest = totalMinutes % 60
  const hourLabel = hours === 1 ? '1 hora' : `${hours} horas`
  return rest > 0 ? `${hourLabel} ${rest} min` : hourLabel
}

const DurationColumn = <T extends string | number,>({
  label,
  options,
  value,
  onSelect
}: {
  label: string
  options: Array<PickerOption<T>>
  value: T
  onSelect: (value: T) => void
}) => (
  <div className={styles.column}>
    <div className={styles.columnList} role="listbox" aria-label={label} data-phone-scrollable="true">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="option"
            aria-selected={selected}
            className={`${styles.columnOption} ${selected ? styles.columnOptionSelected : ''}`.trim()}
            onClick={() => onSelect(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
    <span className={styles.columnLabel}>{label}</span>
  </div>
)

/** Selector de duración móvil: valor numérico del 1 al 60 y unidad aparte. */
export const PhoneDurationField: React.FC<PhoneDurationFieldProps> = ({
  value,
  onChange,
  title = 'Duración',
  placeholder = 'Duración',
  disabled = false,
  className = '',
  buttonClassName = ''
}) => {
  const [open, setOpen] = useState(false)
  const resolved = useMemo(() => resolveDurationParts(value), [value])
  const [draftAmount, setDraftAmount] = useState(resolved.amount)
  const [draftUnit, setDraftUnit] = useState<DurationUnit>(resolved.unit)
  const selectedAmount = open ? draftAmount : resolved.amount
  const selectedUnit = open ? draftUnit : resolved.unit
  const displayLabel = value ? formatDurationLabel(value) : ''

  const openSheet = () => {
    if (disabled) return
    setDraftAmount(resolved.amount)
    setDraftUnit(resolved.unit)
    setOpen(true)
  }

  const commit = (amount: number, unit: DurationUnit) => {
    const safeAmount = clampAmount(amount)
    setDraftAmount(safeAmount)
    setDraftUnit(unit)
    onChange(toMinutes(safeAmount, unit))
  }

  return (
    <div className={`${styles.host} ${className}`.trim()}>
      <button
        type="button"
        className={`${styles.trigger} ${buttonClassName}`.trim()}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        onClick={openSheet}
      >
        <span className={displayLabel ? styles.value : styles.placeholder}>
          {displayLabel || placeholder}
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>

      <PhoneSheet isOpen={open} onClose={() => setOpen(false)} title={title} scrollable={false}>
        <div className={styles.columns}>
          <DurationColumn
            label="Valor"
            options={numberOptions}
            value={selectedAmount}
            onSelect={(amount) => commit(amount, selectedUnit)}
          />
          <DurationColumn
            label="Unidad"
            options={UNIT_OPTIONS}
            value={selectedUnit}
            onSelect={(unit) => commit(selectedAmount, unit)}
          />
        </div>
        <button type="button" className={styles.doneButton} onClick={() => setOpen(false)}>
          Listo
        </button>
      </PhoneSheet>
    </div>
  )
}
