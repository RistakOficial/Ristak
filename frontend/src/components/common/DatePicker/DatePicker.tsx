import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  addDateOnlyDays,
  dateOnlyToLocalDate,
  getStoredBusinessTimezone,
  todayDateOnlyInTimezone,
  parseDateOnlyParts
} from '@/utils/timezone'
import { formatDate } from '@/utils/format'
import { getFloatingLayerZIndex } from '@/utils/layering'
import styles from './DatePicker.module.css'

export interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  today?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
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

const WEEKDAYS = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa']
const VIEWPORT_PADDING = 12
const PANEL_GAP = 6
const PANEL_WIDTH = 320
const PANEL_ESTIMATED_HEIGHT = 356

function monthDateOnly(value?: string) {
  const parts = value ? parseDateOnlyParts(value) : null
  if (!parts) return null
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-01`
}

function addMonths(value: string, amount: number) {
  const parts = parseDateOnlyParts(value)
  if (!parts) return value

  const absoluteMonth = parts.year * 12 + parts.month - 1 + amount
  const year = Math.floor(absoluteMonth / 12)
  const month = absoluteMonth - year * 12 + 1
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function formatDateLabel(value: string, placeholder: string) {
  return formatDate(value, {
    includeYear: true,
    padDay: false,
    fallback: placeholder
  })
}

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  min,
  max,
  today,
  placeholder = 'Elige fecha',
  disabled = false,
  className = '',
  ariaLabel = 'Fecha'
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  const effectiveToday = today || todayDateOnlyInTimezone(getStoredBusinessTimezone())
  const [viewMonth, setViewMonth] = useState(() => (
    monthDateOnly(value) || monthDateOnly(effectiveToday) || monthDateOnly(min) || '1970-01-01'
  ))
  const viewMonthParts = useMemo(
    () => parseDateOnlyParts(viewMonth) || { year: 1970, month: 1, day: 1 },
    [viewMonth]
  )

  const close = useCallback((restoreFocus = false) => {
    setIsOpen(false)
    setPanelStyle(null)
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
  }, [])

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') return

    const rect = trigger.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2)
    const panelHeight = Math.min(
      panelRef.current?.offsetHeight || PANEL_ESTIMATED_HEIGHT,
      window.innerHeight - VIEWPORT_PADDING * 2
    )
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING
    const spaceAbove = rect.top - VIEWPORT_PADDING
    const openAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow
    const top = openAbove
      ? Math.max(VIEWPORT_PADDING, rect.top - panelHeight - PANEL_GAP)
      : Math.min(rect.bottom + PANEL_GAP, window.innerHeight - panelHeight - VIEWPORT_PADDING)
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left),
      window.innerWidth - width - VIEWPORT_PADDING
    )

    setPanelStyle({
      top,
      left,
      width,
      zIndex: getFloatingLayerZIndex(containerRef.current, 'popover')
    })
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const selectedMonthDate = monthDateOnly(value) || monthDateOnly(effectiveToday) || monthDateOnly(min)
    if (selectedMonthDate) setViewMonth(selectedMonthDate)
  }, [effectiveToday, isOpen, min, value])

  useLayoutEffect(() => {
    if (!isOpen) return

    updatePanelPosition()
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)

    return () => {
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
    }
  }, [isOpen, updatePanelPosition, viewMonth])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      close()
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [close, isOpen])

  const calendarDays = useMemo(() => {
    const firstWeekday = dateOnlyToLocalDate(viewMonth)?.getDay() || 0
    return Array.from({ length: 42 }, (_, index) => {
      const dateOnly = addDateOnlyDays(viewMonth, index - firstWeekday)
      const parts = parseDateOnlyParts(dateOnly) || viewMonthParts
      return {
        dateOnly,
        day: parts.day,
        outsideMonth: parts.month !== viewMonthParts.month,
        disabled: Boolean((min && dateOnly < min) || (max && dateOnly > max))
      }
    })
  }, [max, min, viewMonth, viewMonthParts])

  const moveMonth = (amount: number) => {
    setViewMonth((current) => addMonths(current, amount))
  }

  const focusDate = useCallback((dateOnly: string) => {
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date-value="${dateOnly}"]`)
        ?.focus()
    })
  }, [])

  const handleDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, dateOnly: string) => {
    const dayOffsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7
    }
    const offset = dayOffsets[event.key]
    if (!offset) return

    event.preventDefault()
    const nextDateOnly = addDateOnlyDays(dateOnly, offset)
    const nextMonth = monthDateOnly(nextDateOnly)
    if (!nextMonth) return
    setViewMonth(nextMonth)
    focusDate(nextDateOnly)
  }

  const selectDate = (dateOnly: string, isDisabled: boolean) => {
    if (isDisabled) return
    onChange(dateOnly)
    close(true)
  }

  const panel = isOpen && typeof document !== 'undefined' ? (
    <div
      ref={panelRef}
      className={styles.panel}
      style={panelStyle || { visibility: 'hidden' }}
      role="dialog"
      aria-label="Seleccionar fecha"
      data-date-picker-panel
      data-ristak-dropdown-panel
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.navButton}
          aria-label="Mes anterior"
          onClick={() => moveMonth(-1)}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className={styles.monthTitle} aria-live="polite">
          {MONTHS[viewMonthParts.month - 1]} {viewMonthParts.year}
        </div>
        <button
          type="button"
          className={styles.navButton}
          aria-label="Mes siguiente"
          onClick={() => moveMonth(1)}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.weekdays} aria-hidden="true">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>

      <div className={styles.days} role="grid" aria-label={`${MONTHS[viewMonthParts.month - 1]} ${viewMonthParts.year}`}>
        {calendarDays.map((calendarDay) => {
          const isSelected = calendarDay.dateOnly === value
          const isToday = calendarDay.dateOnly === effectiveToday
          return (
            <button
              key={calendarDay.dateOnly}
              type="button"
              className={`${styles.dayButton} ${calendarDay.outsideMonth ? styles.outsideMonth : ''} ${isToday ? styles.today : ''} ${isSelected ? styles.selected : ''}`}
              disabled={calendarDay.disabled}
              aria-label={formatDateLabel(calendarDay.dateOnly, calendarDay.dateOnly)}
              aria-selected={isSelected}
              data-date-value={calendarDay.dateOnly}
              data-selected={isSelected ? 'true' : undefined}
              onClick={() => selectDate(calendarDay.dateOnly, calendarDay.disabled)}
              onKeyDown={(event) => handleDayKeyDown(event, calendarDay.dateOnly)}
            >
              {calendarDay.day}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  return (
    <div ref={containerRef} className={`${styles.container} ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.open : ''}`}
        onClick={() => {
          if (disabled) return
          if (isOpen) close()
          else setIsOpen(true)
        }}
        onKeyDown={(event) => {
          if (!isOpen || event.key !== 'ArrowDown') return
          event.preventDefault()
          const focusValue = value || effectiveToday
          focusDate(focusValue)
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-date-picker-trigger
        data-ristak-dropdown-trigger
      >
        <span className={value ? styles.value : styles.placeholder}>
          {formatDateLabel(value, placeholder)}
        </span>
        <CalendarDays size={17} className={styles.icon} aria-hidden="true" />
      </button>
      {typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  )
}
