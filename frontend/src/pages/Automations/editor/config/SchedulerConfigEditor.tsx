import React, { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Repeat, Timer } from 'lucide-react'
import { useTimezone } from '@/contexts/TimezoneContext'
import { cn } from '@/utils/cn'
import { dateOnlyToLocalDate, todayDateOnlyInTimezone } from '@/utils/timezone'
import { CustomSelect, Field, TextInput, WeekdaysPicker } from './configPrimitives'
import styles from '../AutomationEditor.module.css'

type ConfigValue = Record<string, unknown>

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre'
]

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

const str = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)

function dateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateFromKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function splitDatetime(value: string): { date: string; time: string } {
  const [date = '', rawTime = ''] = value.split('T')
  return { date, time: rawTime.slice(0, 5) }
}

function monthDays(viewDate: Date) {
  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const first = new Date(year, month, 1)
  const startOffset = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - startOffset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

export const SchedulerConfigEditor: React.FC<{
  config: ConfigValue
  onChange: (config: ConfigValue) => void
}> = ({ config, onChange }) => {
  const { timezone } = useTimezone()
  const recurrence = str(config.recurrence) || 'none'
  const mode = str(config.scheduleMode) || (recurrence === 'none' ? 'once' : 'recurring')
  const { date, time } = splitDatetime(str(config.datetime))
  const selectedDate = dateFromKey(date)
  const today = useMemo(
    () => dateOnlyToLocalDate(todayDateOnlyInTimezone(timezone)) || new Date(),
    [timezone]
  )
  const [viewDate, setViewDate] = useState(() => selectedDate || today)

  useEffect(() => {
    if (selectedDate) setViewDate(selectedDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  const patchSchedule = (patch: ConfigValue) => {
    onChange({ ...config, ...patch })
  }

  const setMode = (nextMode: 'once' | 'recurring') => {
    patchSchedule({
      scheduleMode: nextMode,
      recurrence: nextMode === 'once'
        ? 'none'
        : recurrence === 'none'
          ? 'daily'
          : recurrence
    })
  }

  const setDate = (nextDate: string) => {
    patchSchedule({ datetime: `${nextDate}T${time || '09:00'}` })
  }

  const setTime = (nextTime: string) => {
    const nextDate = date || dateKey(today)
    patchSchedule({ datetime: `${nextDate}T${nextTime || '09:00'}` })
  }

  const days = monthDays(viewDate)
  const currentMonthLabel = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`
  const selectedKey = selectedDate ? dateKey(selectedDate) : ''
  const todayKey = dateKey(today)

  return (
    <div className={styles.schedulerConfig}>
      <div className={styles.schedulerModeGrid} role="group" aria-label="Tipo de programación">
        <button
          type="button"
          className={cn(styles.schedulerModeButton, mode === 'once' && styles.schedulerModeButtonActive)}
          onClick={() => setMode('once')}
          aria-pressed={mode === 'once'}
        >
          <Timer size={18} />
          <span>
            <strong>Una vez</strong>
            <small>En una fecha específica</small>
          </span>
        </button>
        <button
          type="button"
          className={cn(styles.schedulerModeButton, mode === 'recurring' && styles.schedulerModeButtonActive)}
          onClick={() => setMode('recurring')}
          aria-pressed={mode === 'recurring'}
        >
          <Repeat size={18} />
          <span>
            <strong>Recurrente</strong>
            <small>Se repite automáticamente</small>
          </span>
        </button>
      </div>

      <Field label={mode === 'once' ? 'Fecha específica' : 'Empieza el'}>
        <div className={styles.schedulerCalendar}>
          <div className={styles.schedulerCalendarHeader}>
            <button
              type="button"
              className={styles.schedulerCalendarNav}
              title="Mes anterior"
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}
            >
              <ChevronLeft size={16} />
            </button>
            <div className={styles.schedulerCalendarTitle}>
              <CalendarDays size={16} />
              <span>{currentMonthLabel}</span>
            </div>
            <button
              type="button"
              className={styles.schedulerCalendarNav}
              title="Mes siguiente"
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className={styles.schedulerWeekHeader}>
            {WEEKDAYS.map((weekday, index) => (
              <span key={`${weekday}-${index}`}>{weekday}</span>
            ))}
          </div>

          <div className={styles.schedulerDateGrid}>
            {days.map((day) => {
              const key = dateKey(day)
              const muted = day.getMonth() !== viewDate.getMonth()
              const selected = key === selectedKey
              return (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    styles.schedulerDateButton,
                    muted && styles.schedulerDateButtonMuted,
                    key === todayKey && styles.schedulerDateButtonToday,
                    selected && styles.schedulerDateButtonSelected
                  )}
                  onClick={() => setDate(key)}
                  aria-pressed={selected}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          <button type="button" className={styles.schedulerTodayButton} onClick={() => setDate(todayKey)}>
            Usar hoy
          </button>
        </div>
      </Field>

      <Field label="Hora">
        <TextInput
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          onBlur={(event) => {
            if (!event.currentTarget.value) setTime('09:00')
          }}
        />
      </Field>

      {mode === 'recurring' && (
        <>
          <Field label="Se repite">
            <CustomSelect
              options={[
                { value: 'daily', label: 'Cada día' },
                { value: 'weekly', label: 'Cada semana' },
                { value: 'monthly', label: 'Cada mes' }
              ]}
              value={recurrence === 'none' ? 'daily' : recurrence}
              onValueChange={(next) => patchSchedule({ recurrence: next })}
              aria-label="Frecuencia"
            />
          </Field>
          {(recurrence === 'daily' || recurrence === 'weekly') && (
            <Field label={recurrence === 'weekly' ? 'Días de la semana' : 'Días activos (opcional)'}>
              <WeekdaysPicker
                values={Array.isArray(config.weekdays) ? (config.weekdays as string[]) : []}
                onChange={(weekdays) => patchSchedule({ weekdays })}
              />
            </Field>
          )}
        </>
      )}
    </div>
  )
}
