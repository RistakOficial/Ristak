import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { PhoneSheet } from './ui/PhoneSheet'
import styles from './PhoneDateField.module.css'

interface PhoneDateFieldProps {
  value: string
  onChange: (value: string) => void
  min?: string
  disabled?: boolean
  placeholder?: string
  title?: string
  className?: string
  buttonClassName?: string
  ariaLabel?: string
  inlineOnWide?: boolean
}

const MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre'
]

const WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']

function parseDateInput(value?: string | null) {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function formatDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getCalendarDays(viewDate: Date) {
  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const firstDay = new Date(year, month, 1)
  const start = new Date(year, month, 1 - firstDay.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function isSameDay(a?: Date | null, b?: Date | null) {
  return Boolean(
    a &&
    b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatDisplayDate(value: string, placeholder: string) {
  const date = parseDateInput(value)
  if (!date) return placeholder

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date)
}

export const PhoneDateField: React.FC<PhoneDateFieldProps> = ({
  value,
  onChange,
  min,
  disabled = false,
  placeholder = 'Selecciona fecha',
  title = 'Selecciona fecha',
  className = '',
  buttonClassName = '',
  ariaLabel,
  inlineOnWide = false
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const selectedDate = useMemo(() => parseDateInput(value), [value])
  const minDate = useMemo(() => parseDateInput(min), [min])
  const [open, setOpen] = useState(false)
  const [wideViewport, setWideViewport] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : false
  ))
  const [viewDate, setViewDate] = useState<Date>(() => selectedDate || minDate || new Date())
  const days = useMemo(() => getCalendarDays(viewDate), [viewDate])
  const today = useMemo(() => new Date(), [])
  const useInlinePanel = inlineOnWide && wideViewport

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setWideViewport(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!open) return
    setViewDate(selectedDate || minDate || new Date())
  }, [minDate, open, selectedDate])

  useEffect(() => {
    if (!open || !useInlinePanel) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && hostRef.current?.contains(target)) return
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, useInlinePanel])

  const changeMonth = (delta: number) => {
    setViewDate((current) => {
      const next = new Date(current)
      next.setMonth(current.getMonth() + delta)
      return next
    })
  }

  const selectDate = (date: Date) => {
    if (minDate && date < minDate) return
    onChange(formatDateInput(date))
    setOpen(false)
  }

  const calendarPanel = (
    <>
      <div className={styles.monthRow}>
        <button type="button" onClick={() => changeMonth(-1)} aria-label="Mes anterior">
          <ChevronLeft size={20} />
        </button>
        <span>{MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}</span>
        <button type="button" onClick={() => changeMonth(1)} aria-label="Mes siguiente">
          <ChevronRight size={20} />
        </button>
      </div>
      <div className={styles.weekdays}>
        {WEEKDAYS.map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className={styles.days}>
        {days.map((date) => {
          const dateValue = formatDateInput(date)
          const outside = date.getMonth() !== viewDate.getMonth()
          const selected = isSameDay(date, selectedDate)
          const current = isSameDay(date, today)
          const blocked = Boolean(minDate && date < minDate)

          return (
            <button
              key={dateValue}
              type="button"
              className={`${outside ? styles.outside : ''} ${selected ? styles.selected : ''} ${current ? styles.today : ''}`}
              disabled={blocked}
              onClick={() => selectDate(date)}
              aria-pressed={selected}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>
    </>
  )

  const hostClassName = [
    styles.host,
    useInlinePanel ? styles.hostInline : '',
    open && useInlinePanel ? styles.hostInlineOpen : '',
    className
  ].filter(Boolean).join(' ')

  return (
    <div ref={hostRef} className={hostClassName}>
      <button
        type="button"
        className={`${styles.trigger} ${buttonClassName}`}
        disabled={disabled}
        aria-label={ariaLabel || title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((current) => !current)}
      >
        <CalendarDays size={17} />
        <span className={selectedDate ? styles.value : styles.placeholder}>
          {formatDisplayDate(value, placeholder)}
        </span>
      </button>

      {useInlinePanel ? (
        open && (
          <div className={styles.popoverPanel} role="dialog" aria-label={ariaLabel || title}>
            <div className={styles.popoverHeader}>
              <strong>{title}</strong>
              <button type="button" className={styles.todayButton} onClick={() => selectDate(new Date())}>
                Hoy
              </button>
            </div>
            {calendarPanel}
          </div>
        )
      ) : (
        <PhoneSheet
          isOpen={open}
          onClose={() => setOpen(false)}
          title={title}
          ariaLabel={ariaLabel || title}
          headerRight={(
            <button type="button" className={styles.todayButton} onClick={() => selectDate(new Date())}>
              Hoy
            </button>
          )}
        >
          {calendarPanel}
        </PhoneSheet>
      )}
    </div>
  )
}
