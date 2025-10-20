import React, { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import styles from './DateTimePicker.module.css'

interface DateTimePickerProps {
  value: string // ISO string: "2025-02-10T17:00:00"
  onChange: (value: string) => void
  label?: string
  required?: boolean
  minDate?: string
}

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]

const WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']

export function DateTimePicker({ value, onChange, label, required, minDate }: DateTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [viewDate, setViewDate] = useState<Date>(value ? new Date(value) : new Date())
  const containerRef = useRef<HTMLDivElement>(null)

  // Parse current value
  const currentDate = value ? new Date(value) : null
  const displayText = currentDate
    ? `${currentDate.getDate()} ${MONTHS[currentDate.getMonth()].slice(0, 3)} ${currentDate.getFullYear()}, ${formatTime(currentDate)}`
    : 'Seleccionar fecha y hora'

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  function formatTime(date: Date): string {
    const hours = date.getHours()
    const minutes = date.getMinutes()
    const ampm = hours >= 12 ? 'p.m.' : 'a.m.'
    const displayHours = hours % 12 || 12
    return `${displayHours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} ${ampm}`
  }

  function getDaysInMonth(year: number, month: number): Date[] {
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const daysInMonth = lastDay.getDate()
    const startingDayOfWeek = firstDay.getDay()

    const days: Date[] = []

    // Previous month days
    const prevMonthLastDay = new Date(year, month, 0).getDate()
    for (let i = startingDayOfWeek - 1; i >= 0; i--) {
      days.push(new Date(year, month - 1, prevMonthLastDay - i))
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(new Date(year, month, i))
    }

    // Next month days
    const remainingDays = 42 - days.length // 6 rows x 7 days
    for (let i = 1; i <= remainingDays; i++) {
      days.push(new Date(year, month + 1, i))
    }

    return days
  }

  function handleDateSelect(date: Date) {
    // Preserve current time or set to current time if no value
    const hours = currentDate?.getHours() ?? new Date().getHours()
    const minutes = currentDate?.getMinutes() ?? new Date().getMinutes()

    const newDate = new Date(date)
    newDate.setHours(hours, minutes, 0, 0)

    onChange(newDate.toISOString())
  }

  function handleTimeChange(hours: number, minutes: number) {
    const newDate = currentDate ? new Date(currentDate) : new Date()
    newDate.setHours(hours, minutes, 0, 0)
    onChange(newDate.toISOString())
  }

  function changeMonth(delta: number) {
    const newDate = new Date(viewDate)
    newDate.setMonth(newDate.getMonth() + delta)
    setViewDate(newDate)
  }

  function isToday(date: Date): boolean {
    const today = new Date()
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    )
  }

  function isSelected(date: Date): boolean {
    if (!currentDate) return false
    return (
      date.getDate() === currentDate.getDate() &&
      date.getMonth() === currentDate.getMonth() &&
      date.getFullYear() === currentDate.getFullYear()
    )
  }

  function isCurrentMonth(date: Date): boolean {
    return date.getMonth() === viewDate.getMonth()
  }

  function isPastDate(date: Date): boolean {
    if (!minDate) return false
    const min = new Date(minDate)
    return date < min
  }

  const days = getDaysInMonth(viewDate.getFullYear(), viewDate.getMonth())

  // Generate hour and minute options
  const hours = Array.from({ length: 12 }, (_, i) => i + 1)
  const minutes = Array.from({ length: 60 }, (_, i) => i)

  const currentHour = currentDate ? currentDate.getHours() % 12 || 12 : 1
  const currentMinute = currentDate ? currentDate.getMinutes() : 0
  const currentPeriod = currentDate && currentDate.getHours() >= 12 ? 'pm' : 'am'

  return (
    <div className={styles.container} ref={containerRef}>
      {label && (
        <label className={styles.label}>
          {label}
          {required && <span className={styles.required}> *</span>}
        </label>
      )}

      <button
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
      >
        <Calendar size={16} />
        <span>{displayText}</span>
        {value && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
          >
            <X size={14} />
          </button>
        )}
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownContent}>
            {/* Calendar */}
            <div className={styles.calendar}>
            <div className={styles.calendarHeader}>
              <button
                type="button"
                className={styles.navButton}
                onClick={() => changeMonth(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span className={styles.monthYear}>
                {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
              </span>
              <button
                type="button"
                className={styles.navButton}
                onClick={() => changeMonth(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>

            <div className={styles.weekdays}>
              {WEEKDAYS.map((day) => (
                <div key={day} className={styles.weekday}>
                  {day}
                </div>
              ))}
            </div>

            <div className={styles.days}>
              {days.map((date, index) => (
                <button
                  key={index}
                  type="button"
                  className={`
                    ${styles.day}
                    ${isToday(date) ? styles.today : ''}
                    ${isSelected(date) ? styles.selected : ''}
                    ${!isCurrentMonth(date) ? styles.otherMonth : ''}
                    ${isPastDate(date) ? styles.disabled : ''}
                  `}
                  onClick={() => !isPastDate(date) && handleDateSelect(date)}
                  disabled={isPastDate(date)}
                >
                  {date.getDate()}
                </button>
              ))}
            </div>
          </div>

          {/* Time Picker */}
          <div className={styles.timePicker}>
            <div className={styles.timeHeader}>
              <Clock size={12} />
              <span>Hora</span>
            </div>

            <div className={styles.timeSelectors}>
              {/* Hours */}
              <div className={styles.timeColumn}>
                <div className={styles.timeColumnLabel}>Hora</div>
                <div className={styles.timeScroll}>
                  {hours.map((hour) => (
                    <button
                      key={hour}
                      type="button"
                      className={`${styles.timeOption} ${currentHour === hour ? styles.timeOptionSelected : ''}`}
                      onClick={() => {
                        const hour24 = currentPeriod === 'pm' && hour !== 12
                          ? hour + 12
                          : currentPeriod === 'am' && hour === 12
                          ? 0
                          : hour
                        handleTimeChange(hour24, currentMinute)
                      }}
                    >
                      {hour.toString().padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Minutes */}
              <div className={styles.timeColumn}>
                <div className={styles.timeColumnLabel}>Min</div>
                <div className={styles.timeScroll}>
                  {minutes.filter(m => m % 5 === 0).map((minute) => (
                    <button
                      key={minute}
                      type="button"
                      className={`${styles.timeOption} ${currentMinute === minute ? styles.timeOptionSelected : ''}`}
                      onClick={() => {
                        const hour24 = currentPeriod === 'pm' && currentHour !== 12
                          ? currentHour + 12
                          : currentPeriod === 'am' && currentHour === 12
                          ? 0
                          : currentHour
                        handleTimeChange(hour24, minute)
                      }}
                    >
                      {minute.toString().padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>

              {/* AM/PM */}
              <div className={styles.timeColumn}>
                <div className={styles.timeColumnLabel}>Periodo</div>
                <div className={styles.timeScroll}>
                  <button
                    type="button"
                    className={`${styles.timeOption} ${currentPeriod === 'am' ? styles.timeOptionSelected : ''}`}
                    onClick={() => {
                      const hour24 = currentHour === 12 ? 0 : currentHour
                      handleTimeChange(hour24, currentMinute)
                    }}
                  >
                    a.m.
                  </button>
                  <button
                    type="button"
                    className={`${styles.timeOption} ${currentPeriod === 'pm' ? styles.timeOptionSelected : ''}`}
                    onClick={() => {
                      const hour24 = currentHour === 12 ? 12 : currentHour + 12
                      handleTimeChange(hour24, currentMinute)
                    }}
                  >
                    p.m.
                  </button>
                </div>
              </div>
            </div>
          </div>
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => {
                const now = new Date()
                onChange(now.toISOString())
                setViewDate(now)
              }}
            >
              Ahora
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
              onClick={() => setIsOpen(false)}
            >
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
