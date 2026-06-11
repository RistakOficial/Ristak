import React from 'react'
import { PhoneSelect } from '../PhoneSelect'
import styles from './PhoneDateTimeField.module.css'

interface PhoneDateTimeFieldProps {
  /** Fecha en formato 'YYYY-MM-DD'. Si viene vacía se muestra la fecha de hoy. */
  dateValue: string
  /** Hora en formato 'HH:mm' (24 horas). Si viene vacía se muestra la hora actual. */
  timeValue: string
  onChange: (date: string, time: string) => void
  dateLabel?: string
  timeLabel?: string
  disabled?: boolean
  /** Cuántos años hacia adelante se ofrecen además del actual. */
  yearsAhead?: number
  className?: string
}

const MONTH_LABELS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]

const padTwo = (value: number) => String(value).padStart(2, '0')

const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '')
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function formatHourLabel(hour: number): string {
  const period = hour >= 12 ? 'p.m.' : 'a.m.'
  const hour12 = hour % 12 || 12
  return `${hour12} ${period}`
}

/**
 * Selector estándar de fecha y hora del celular: cajitas desplegables
 * individuales para día, mes, año, hora y minutos. Mes y año arrancan en el
 * actual y solo se cambian si hace falta.
 */
export const PhoneDateTimeField: React.FC<PhoneDateTimeFieldProps> = ({
  dateValue,
  timeValue,
  onChange,
  dateLabel = 'Fecha',
  timeLabel = 'Hora',
  disabled = false,
  yearsAhead = 2,
  className = ''
}) => {
  const now = new Date()
  const date = parseDate(dateValue) ?? { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }
  const time = parseTime(timeValue) ?? { hour: now.getHours(), minute: now.getMinutes() }

  const emit = (year: number, month: number, day: number, hour: number, minute: number) => {
    const safeDay = Math.min(day, daysInMonth(year, month))
    onChange(`${year}-${padTwo(month + 1)}-${padTwo(safeDay)}`, `${padTwo(hour)}:${padTwo(minute)}`)
  }

  const dayOptions = Array.from({ length: daysInMonth(date.year, date.month) }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1)
  }))

  const monthOptions = MONTH_LABELS.map((label, index) => ({ value: String(index), label }))

  const baseYear = Math.min(date.year, now.getFullYear())
  const lastYear = Math.max(date.year, now.getFullYear() + yearsAhead)
  const yearOptions = Array.from({ length: lastYear - baseYear + 1 }, (_, index) => ({
    value: String(baseYear + index),
    label: String(baseYear + index)
  }))

  const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: formatHourLabel(hour)
  }))

  const minuteValues = Array.from({ length: 12 }, (_, index) => index * 5)
  if (!minuteValues.includes(time.minute)) {
    minuteValues.push(time.minute)
    minuteValues.sort((a, b) => a - b)
  }
  const minuteOptions = minuteValues.map((minute) => ({
    value: String(minute),
    label: `:${padTwo(minute)}`
  }))

  return (
    <div className={`${styles.host} ${className}`.trim()}>
      <div className={styles.group}>
        <span className={styles.label}>{dateLabel}</span>
        <div className={styles.dateRow}>
          <PhoneSelect
            options={dayOptions}
            value={String(date.day)}
            onChange={(value) => emit(date.year, date.month, Number(value), time.hour, time.minute)}
            title="Día"
            ariaLabel="Día"
            disabled={disabled}
          />
          <PhoneSelect
            options={monthOptions}
            value={String(date.month)}
            onChange={(value) => emit(date.year, Number(value), date.day, time.hour, time.minute)}
            title="Mes"
            ariaLabel="Mes"
            disabled={disabled}
          />
          <PhoneSelect
            options={yearOptions}
            value={String(date.year)}
            onChange={(value) => emit(Number(value), date.month, date.day, time.hour, time.minute)}
            title="Año"
            ariaLabel="Año"
            disabled={disabled}
          />
        </div>
      </div>
      <div className={styles.group}>
        <span className={styles.label}>{timeLabel}</span>
        <div className={styles.timeRow}>
          <PhoneSelect
            options={hourOptions}
            value={String(time.hour)}
            onChange={(value) => emit(date.year, date.month, date.day, Number(value), time.minute)}
            title="Hora"
            ariaLabel="Hora"
            disabled={disabled}
          />
          <PhoneSelect
            options={minuteOptions}
            value={String(time.minute)}
            onChange={(value) => emit(date.year, date.month, date.day, time.hour, Number(value))}
            title="Minutos"
            ariaLabel="Minutos"
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  )
}
