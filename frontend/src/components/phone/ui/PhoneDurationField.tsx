import React from 'react'
import { PhoneSelect } from '../PhoneSelect'

interface PhoneDurationFieldProps {
  /** Duración en minutos. */
  value: number
  onChange: (minutes: number) => void
  title?: string
  placeholder?: string
  disabled?: boolean
  /** Opciones de duración en minutos. */
  options?: number[]
  className?: string
  buttonClassName?: string
}

const DEFAULT_DURATIONS = [15, 30, 45, 60, 90, 120, 180]

export function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourLabel = hours === 1 ? '1 hora' : `${hours} horas`
  return rest > 0 ? `${hourLabel} ${rest} min` : hourLabel
}

/** Selector de duración estándar (en vez de pedir hora de inicio y hora de fin). */
export const PhoneDurationField: React.FC<PhoneDurationFieldProps> = ({
  value,
  onChange,
  title = 'Duración',
  placeholder = 'Duración',
  disabled = false,
  options = DEFAULT_DURATIONS,
  className,
  buttonClassName
}) => {
  const values = options.includes(value) || !value ? options : [...options, value].sort((a, b) => a - b)

  return (
    <PhoneSelect
      value={value ? String(value) : ''}
      onChange={(next) => onChange(Number(next))}
      options={values.map((minutes) => ({ value: String(minutes), label: formatDurationLabel(minutes) }))}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      buttonClassName={buttonClassName}
    />
  )
}
