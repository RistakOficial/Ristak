import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { PhoneSheet } from './PhoneSheet'
import { formatTimeLabel } from './PhoneTimeField'
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
  buttonClassName?: string
}

const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

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
  return `${hour % 12 || 12} ${period}`
}

interface PickerOption {
  value: number
  label: string
}

/** Columna desplazable del picker; centra la opción elegida al abrir. */
const PickerColumn: React.FC<{
  label: string
  options: PickerOption[]
  value: number
  onSelect: (value: number) => void
}> = ({ label, options, value, onSelect }) => {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[data-selected="true"]')
    if (list && selected) {
      list.scrollTop = selected.offsetTop - list.clientHeight / 2 + selected.clientHeight / 2
    }
    // Solo al montar: después el usuario controla el scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.column}>
      <span className={styles.columnLabel}>{label}</span>
      <div ref={listRef} className={styles.columnList} role="listbox" aria-label={label}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              data-selected={selected ? 'true' : undefined}
              className={`${styles.columnOption} ${selected ? styles.columnOptionSelected : ''}`.trim()}
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Selector estándar de fecha y hora del celular: un solo contenedor para la
 * fecha y otro para la hora; cada uno abre un sheet con columnas (día / mes
 * abreviado / año, hora / minutos) que arrancan en el momento actual.
 */
export const PhoneDateTimeField: React.FC<PhoneDateTimeFieldProps> = ({
  dateValue,
  timeValue,
  onChange,
  dateLabel = 'Fecha',
  timeLabel = 'Hora',
  disabled = false,
  yearsAhead = 2,
  className = '',
  buttonClassName = ''
}) => {
  const [openDate, setOpenDate] = useState(false)
  const [openTime, setOpenTime] = useState(false)

  const now = new Date()
  const date = parseDate(dateValue) ?? { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }
  const time = parseTime(timeValue) ?? { hour: now.getHours(), minute: now.getMinutes() }

  const emit = (year: number, month: number, day: number, hour: number, minute: number) => {
    const safeDay = Math.min(day, daysInMonth(year, month))
    onChange(`${year}-${padTwo(month + 1)}-${padTwo(safeDay)}`, `${padTwo(hour)}:${padTwo(minute)}`)
  }

  const dayOptions: PickerOption[] = Array.from({ length: daysInMonth(date.year, date.month) }, (_, index) => ({
    value: index + 1,
    label: String(index + 1)
  }))

  const monthOptions: PickerOption[] = MONTHS_SHORT.map((label, index) => ({ value: index, label }))

  const baseYear = Math.min(date.year, now.getFullYear())
  const lastYear = Math.max(date.year, now.getFullYear() + yearsAhead)
  const yearOptions: PickerOption[] = Array.from({ length: lastYear - baseYear + 1 }, (_, index) => ({
    value: baseYear + index,
    label: String(baseYear + index)
  }))

  const hourOptions: PickerOption[] = Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: formatHourLabel(hour)
  }))

  const minuteValues = Array.from({ length: 12 }, (_, index) => index * 5)
  if (!minuteValues.includes(time.minute)) {
    minuteValues.push(time.minute)
    minuteValues.sort((a, b) => a - b)
  }
  const minuteOptions: PickerOption[] = minuteValues.map((minute) => ({ value: minute, label: `:${padTwo(minute)}` }))

  const dateText = `${date.day} ${MONTHS_SHORT[date.month]} ${date.year}`
  const timeText = formatTimeLabel(`${padTwo(time.hour)}:${padTwo(time.minute)}`)

  return (
    <div className={`${styles.host} ${className}`.trim()}>
      <div className={styles.group}>
        <span className={styles.label}>{dateLabel}</span>
        <button
          type="button"
          className={`${styles.trigger} ${buttonClassName}`.trim()}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={openDate}
          aria-label={dateLabel}
          onClick={() => !disabled && setOpenDate(true)}
        >
          <span className={styles.triggerValue}>{dateText}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.group}>
        <span className={styles.label}>{timeLabel}</span>
        <button
          type="button"
          className={`${styles.trigger} ${buttonClassName}`.trim()}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={openTime}
          aria-label={timeLabel}
          onClick={() => !disabled && setOpenTime(true)}
        >
          <span className={styles.triggerValue}>{timeText}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </div>

      <PhoneSheet isOpen={openDate} onClose={() => setOpenDate(false)} title="Elige la fecha" scrollable={false}>
        {openDate && (
          <>
            <div className={styles.columns}>
              <PickerColumn
                label="Día"
                options={dayOptions}
                value={Math.min(date.day, dayOptions.length)}
                onSelect={(day) => emit(date.year, date.month, day, time.hour, time.minute)}
              />
              <PickerColumn
                label="Mes"
                options={monthOptions}
                value={date.month}
                onSelect={(month) => emit(date.year, month, date.day, time.hour, time.minute)}
              />
              <PickerColumn
                label="Año"
                options={yearOptions}
                value={date.year}
                onSelect={(year) => emit(year, date.month, date.day, time.hour, time.minute)}
              />
            </div>
            <button type="button" className={styles.doneButton} onClick={() => setOpenDate(false)}>
              Listo
            </button>
          </>
        )}
      </PhoneSheet>

      <PhoneSheet isOpen={openTime} onClose={() => setOpenTime(false)} title="Elige la hora" scrollable={false}>
        {openTime && (
          <>
            <div className={styles.columns}>
              <PickerColumn
                label="Hora"
                options={hourOptions}
                value={time.hour}
                onSelect={(hour) => emit(date.year, date.month, date.day, hour, time.minute)}
              />
              <PickerColumn
                label="Minutos"
                options={minuteOptions}
                value={time.minute}
                onSelect={(minute) => emit(date.year, date.month, date.day, time.hour, minute)}
              />
            </div>
            <button type="button" className={styles.doneButton} onClick={() => setOpenTime(false)}>
              Listo
            </button>
          </>
        )}
      </PhoneSheet>
    </div>
  )
}
