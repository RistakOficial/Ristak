import React, { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronLeft, ChevronRight, Clock, TrendingUp } from 'lucide-react'
import styles from './DateRangePicker.module.css'
import { formatDateToISO } from '@/utils/format'

interface DateRangePickerProps {
  startDate: string
  endDate: string
  onChange: (start: string, end: string) => void
  placeholder?: string
}

interface DatePreset {
  label: string
  icon?: React.ReactNode
  getValue: () => { start: Date; end: Date }
}

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]

const WEEKDAYS = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa']

// Helper: Normalizar fecha a medianoche local (00:00:00.000)
const toMidnight = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

const DATE_PRESETS: DatePreset[] = [
  {
    label: 'Hoy',
    icon: <Clock size={14} />,
    getValue: () => {
      const today = toMidnight(new Date())
      return { start: today, end: today }
    }
  },
  {
    label: 'Ayer',
    getValue: () => {
      const yesterday = toMidnight(new Date())
      yesterday.setDate(yesterday.getDate() - 1)
      return { start: yesterday, end: yesterday }
    }
  },
  {
    label: 'Últimos 7 días',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(end)
      start.setDate(start.getDate() - 6)
      return { start, end }
    }
  },
  {
    label: 'Últimos 14 días',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(end)
      start.setDate(start.getDate() - 13)
      return { start, end }
    }
  },
  {
    label: 'Últimos 30 días',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(end)
      start.setDate(start.getDate() - 29)
      return { start, end }
    }
  },
  {
    label: 'Este mes',
    getValue: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      return { start, end }
    }
  },
  {
    label: 'Mes anterior',
    getValue: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { start, end }
    }
  },
  {
    label: 'Últimos 90 días',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(end)
      start.setDate(start.getDate() - 89)
      return { start, end }
    }
  },
  {
    label: 'Últimos 12 meses',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(end)
      start.setMonth(start.getMonth() - 12)
      return { start, end }
    }
  },
  {
    label: 'Este año',
    icon: <TrendingUp size={14} />,
    getValue: () => {
      const now = new Date()
      const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0)
      const end = toMidnight(now)
      return { start, end }
    }
  },
  {
    label: 'Todo el tiempo',
    getValue: () => {
      const end = toMidnight(new Date())
      const start = new Date(2020, 0, 1, 0, 0, 0, 0)
      return { start, end }
    }
  }
]

// Helper: Parsear string YYYY-MM-DD como fecha LOCAL (no UTC)
const parseLocalDate = (dateStr: string | undefined | null): Date | null => {
  if (!dateStr) return null
  try {
    const [year, month, day] = dateStr.split('-').map(Number)
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null
    return new Date(year, month - 1, day, 0, 0, 0, 0)
  } catch {
    return null
  }
}
export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onChange,
  placeholder = 'Seleccionar fechas'
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [leftMonth, setLeftMonth] = useState(() => {
    if (startDate) {
      const date = parseLocalDate(startDate)
      if (date) return new Date(date.getFullYear(), date.getMonth(), 1)
    }
    return new Date()
  })
  const [rightMonth, setRightMonth] = useState(() => {
    if (startDate) {
      const date = parseLocalDate(startDate)
      if (date) {
        const next = new Date(date.getFullYear(), date.getMonth() + 1, 1)
        return next
      }
    }
    const date = new Date()
    date.setMonth(date.getMonth() + 1)
    return date
  })
  const [tempStart, setTempStart] = useState<Date | null>(
    parseLocalDate(startDate) || null
  )
  const [tempEnd, setTempEnd] = useState<Date | null>(
    parseLocalDate(endDate) || null
  )
  const [hoveredDate, setHoveredDate] = useState<Date | null>(null)
  const [selectingEndDate, setSelectingEndDate] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Update temp dates when props change
  useEffect(() => {
    if (startDate) {
      setTempStart(parseLocalDate(startDate) || null)
    }
    if (endDate) {
      setTempEnd(parseLocalDate(endDate) || null)
    }
  }, [startDate, endDate])

  const formatDateRange = () => {
    if (!startDate || !endDate) return placeholder

    const start = parseLocalDate(startDate)
    const end = parseLocalDate(endDate)

    if (!start || !end) return placeholder

    const formatDate = (date: Date) => {
      const day = date.getDate()
      const month = MONTHS[date.getMonth()].slice(0, 3)
      const year = date.getFullYear()
      return `${day} ${month} ${year}`
    }

    if (start.getTime() === end.getTime()) {
      return formatDate(start)
    }

    return `${formatDate(start)} — ${formatDate(end)}`
  }

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay()
  }

  const navigateMonth = (isLeft: boolean, direction: 'prev' | 'next') => {
    const setter = isLeft ? setLeftMonth : setRightMonth
    setter(prev => {
      const newDate = new Date(prev)
      newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1))
      return newDate
    })
  }

  const handleDateClick = (date: Date) => {
    if (!selectingEndDate) {
      // Selecting start date
      setTempStart(date)
      setTempEnd(null)
      setSelectingEndDate(true)
    } else {
      // Selecting end date
      if (date < tempStart!) {
        // If end date is before start date, swap them
        setTempEnd(tempStart)
        setTempStart(date)
      } else {
        setTempEnd(date)
      }
      setSelectingEndDate(false)
    }
  }

  const handlePresetClick = (preset: DatePreset) => {
    const { start, end } = preset.getValue()
    setTempStart(start)
    setTempEnd(end)

    // Adjust calendar view to show selected range
    setLeftMonth(new Date(start.getFullYear(), start.getMonth(), 1))
    const rightDate = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    setRightMonth(rightDate)
  }

  const applyDateRange = () => {
    if (tempStart && tempEnd) {
      onChange(
        formatDateToISO(tempStart),
        formatDateToISO(tempEnd)
      )
      setIsOpen(false)
    }
  }

  const cancelSelection = () => {
    setTempStart(parseLocalDate(startDate) || null)
    setTempEnd(parseLocalDate(endDate) || null)
    setIsOpen(false)
  }

  // Normalizar fecha a medianoche local para comparación
  const normalizeDate = (date: Date): number => {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }

  const isStartDate = (date: Date) => {
    if (!tempStart) return false
    return normalizeDate(date) === normalizeDate(tempStart)
  }

  const isEndDate = (date: Date) => {
    if (selectingEndDate && hoveredDate) {
      return normalizeDate(date) === normalizeDate(hoveredDate)
    }
    if (!tempEnd) return false
    return normalizeDate(date) === normalizeDate(tempEnd)
  }

  const isDateInRange = (date: Date) => {
    if (!tempStart) return false

    // When selecting end date, show range preview on hover
    if (selectingEndDate && hoveredDate) {
      const effectiveEnd = hoveredDate
      const start = tempStart < effectiveEnd ? tempStart : effectiveEnd
      const end = tempStart < effectiveEnd ? effectiveEnd : tempStart

      // Normalize all dates to midnight for proper comparison
      const dateTime = normalizeDate(date)
      const startTime = normalizeDate(start)
      const endTime = normalizeDate(end)
      return dateTime >= startTime && dateTime <= endTime
    }

    // Show actual selected range (inclusive of ALL dates)
    if (tempStart && tempEnd) {
      const start = tempStart < tempEnd ? tempStart : tempEnd
      const end = tempStart < tempEnd ? tempEnd : tempStart

      // Normalize all dates to midnight for proper comparison
      const dateTime = normalizeDate(date)
      const startTime = normalizeDate(start)
      const endTime = normalizeDate(end)
      return dateTime >= startTime && dateTime <= endTime
    }

    return false
  }

  const renderCalendar = (currentMonth: Date, isLeftCalendar: boolean) => {
    const daysInMonth = getDaysInMonth(currentMonth)
    const firstDayOfMonth = getFirstDayOfMonth(currentMonth)
    const days = []

    // Empty cells for days before month starts
    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className={styles.emptyDay} />)
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
      const isToday = new Date().toDateString() === date.toDateString()
      const isInRange = isDateInRange(date)
      const isStart = isStartDate(date)
      const isEnd = isEndDate(date)
      const isDisabled = false // You can add date restrictions here if needed

      // Determine all applicable classes
      const classNames = [styles.day]
      if (isToday) classNames.push(styles.today)
      if (isInRange) classNames.push(styles.inRange)
      if (isStart) classNames.push(styles.startDate)
      if (isEnd) classNames.push(styles.endDate)
      if (isStart && isEnd) classNames.push(styles.singleDate)
      if (isDisabled) classNames.push(styles.disabled)

      days.push(
        <button
          key={day}
          className={classNames.join(' ')}
          onClick={() => handleDateClick(date)}
          onMouseEnter={() => selectingEndDate && setHoveredDate(date)}
          onMouseLeave={() => setHoveredDate(null)}
          type="button"
          disabled={isDisabled}
        >
          <span className={styles.dayNumber}>{day}</span>
        </button>
      )
    }

    return (
      <div className={styles.calendar}>
        <div className={styles.calendarHeader}>
          <button
            className={styles.navButton}
            onClick={() => navigateMonth(isLeftCalendar, 'prev')}
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
          <div className={styles.monthYear}>
            {MONTHS[currentMonth.getMonth()]} {currentMonth.getFullYear()}
          </div>
          <button
            className={styles.navButton}
            onClick={() => navigateMonth(isLeftCalendar, 'next')}
            type="button"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div className={styles.weekDays}>
          {WEEKDAYS.map(day => (
            <div key={day} className={styles.weekDay}>{day}</div>
          ))}
        </div>

        <div className={styles.days}>
          {days}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        className={styles.input}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <Calendar size={16} className={styles.icon} />
        <span className={startDate ? styles.value : styles.placeholder}>
          {formatDateRange()}
        </span>
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.sidebar}>
            <h4 className={styles.sidebarTitle}>Seleccionar fechas</h4>
            <div className={styles.presetList}>
              {DATE_PRESETS.map(preset => {
                const { start, end } = preset.getValue()
                const isActive = tempStart && tempEnd &&
                  start.toDateString() === tempStart.toDateString() &&
                  end.toDateString() === tempEnd.toDateString()

                return (
                  <button
                    key={preset.label}
                    className={`${styles.presetItem} ${isActive ? styles.presetActive : ''}`}
                    onClick={() => handlePresetClick(preset)}
                    type="button"
                  >
                    {preset.icon && <span className={styles.presetIcon}>{preset.icon}</span>}
                    <span className={styles.presetLabel}>{preset.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className={styles.calendarSection}>
            <div className={styles.rangeDisplay}>
              <div className={styles.rangeField}>
                <label className={styles.rangeLabel}>Fecha inicial</label>
                <div className={styles.rangeValue}>
                  {tempStart ? tempStart.toLocaleDateString('es-MX', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                  }) : 'Seleccionar'}
                </div>
              </div>
              <div className={styles.rangeSeparator}>→</div>
              <div className={styles.rangeField}>
                <label className={styles.rangeLabel}>Fecha final</label>
                <div className={styles.rangeValue}>
                  {tempEnd ? tempEnd.toLocaleDateString('es-MX', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                  }) : 'Seleccionar'}
                </div>
              </div>
            </div>

            <div className={styles.calendars}>
              {renderCalendar(leftMonth, true)}
              {renderCalendar(rightMonth, false)}
            </div>

            <div className={styles.footer}>
              <button
                className={styles.clearButton}
                onClick={() => {
                  setTempStart(null)
                  setTempEnd(null)
                  setSelectingEndDate(false)
                }}
                type="button"
              >
                Limpiar
              </button>
              <div className={styles.footerActions}>
                <button
                  className={styles.cancelButton}
                  onClick={cancelSelection}
                  type="button"
                >
                  Cancelar
                </button>
                <button
                  className={styles.applyButton}
                  onClick={applyDateRange}
                  disabled={!tempStart || !tempEnd}
                  type="button"
                >
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}