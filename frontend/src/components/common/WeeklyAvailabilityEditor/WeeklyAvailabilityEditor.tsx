import React, { useMemo } from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { Button } from '../Button'
import { CustomSelect } from '../CustomSelect'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../DropdownMenu'
import {
  DEFAULT_WEEKLY_AVAILABILITY_RANGE,
  WEEKLY_AVAILABILITY_DAYS,
  cloneWeeklyAvailability,
  findSuggestedAvailabilityRange,
  formatAvailabilityTime,
  type WeeklyAvailability,
  type WeeklyAvailabilityTimeRange
} from './weeklyAvailability'
import styles from './WeeklyAvailabilityEditor.module.css'

export interface WeeklyAvailabilityEditorProps {
  value: WeeklyAvailability
  onChange: (value: WeeklyAvailability) => void
  minimumRangeMinutes?: number
  disabled?: boolean
  'aria-label'?: string
}

const createTimeOptions = (includeEndOfDay: boolean) => {
  const end = 24 * 60 - 5
  const options = []
  for (let minutes = 0; minutes <= end; minutes += 5) {
    const hour = Math.floor(minutes / 60)
    const minute = minutes % 60
    const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    options.push({ value, label: formatAvailabilityTime(value) })
  }
  if (includeEndOfDay) {
    options.push({ value: '23:59', label: formatAvailabilityTime('23:59') })
  }
  return options
}

const START_TIME_OPTIONS = createTimeOptions(false)
const END_TIME_OPTIONS = createTimeOptions(true)

const withCurrentTimeOption = (
  options: Array<{ value: string; label: string }>,
  currentValue: string
) => {
  if (!currentValue || options.some(option => option.value === currentValue)) return options
  return [...options, { value: currentValue, label: formatAvailabilityTime(currentValue) }]
    .sort((left, right) => left.value.localeCompare(right.value))
}

export const WeeklyAvailabilityEditor: React.FC<WeeklyAvailabilityEditorProps> = ({
  value,
  onChange,
  minimumRangeMinutes = 60,
  disabled = false,
  'aria-label': ariaLabel = 'Disponibilidad semanal'
}) => {
  const weekly = useMemo(() => cloneWeeklyAvailability(value), [value])

  const emitDayChange = (
    day: number,
    updater: (current: WeeklyAvailability[number]) => WeeklyAvailability[number]
  ) => {
    onChange(weekly.map(entry => entry.day === day ? updater(entry) : entry))
  }

  const handleDayToggle = (day: number, enabled: boolean) => {
    emitDayChange(day, current => ({
      ...current,
      enabled,
      ranges: enabled
        ? current.ranges.length
          ? current.ranges
          : [{ ...DEFAULT_WEEKLY_AVAILABILITY_RANGE }]
        : []
    }))
  }

  const handleRangeChange = (
    day: number,
    rangeIndex: number,
    patch: Partial<WeeklyAvailabilityTimeRange>
  ) => {
    emitDayChange(day, current => ({
      ...current,
      ranges: current.ranges.map((range, index) => index === rangeIndex ? { ...range, ...patch } : range)
    }))
  }

  const handleAddRange = (day: number, range: WeeklyAvailabilityTimeRange | null) => {
    if (!range) return
    emitDayChange(day, current => ({ ...current, enabled: true, ranges: [...current.ranges, range] }))
  }

  const handleDeleteRange = (day: number, rangeIndex: number) => {
    emitDayChange(day, current => {
      const ranges = current.ranges.filter((_, index) => index !== rangeIndex)
      return { ...current, enabled: ranges.length > 0, ranges }
    })
  }

  const handleCopySchedule = (sourceDay: number, targetDay?: number) => {
    const source = weekly.find(entry => entry.day === sourceDay)
    if (!source?.ranges.length) return
    onChange(weekly.map(entry => {
      const shouldCopy = targetDay === undefined ? entry.day !== sourceDay : entry.day === targetDay
      return shouldCopy
        ? { ...entry, enabled: true, ranges: source.ranges.map(range => ({ ...range })) }
        : entry
    }))
  }

  return (
    <div className={styles.editor} role="group" aria-label={ariaLabel}>
      {WEEKLY_AVAILABILITY_DAYS.map(dayMeta => {
        const day = weekly.find(entry => entry.day === dayMeta.day) || {
          day: dayMeta.day,
          enabled: false,
          ranges: []
        }
        const suggestedRange = findSuggestedAvailabilityRange(day.ranges, minimumRangeMinutes)

        return (
          <div
            key={day.day}
            className={styles.dayRow}
            data-enabled={day.enabled ? 'true' : undefined}
          >
            <label className={styles.dayToggle}>
              <input
                type="checkbox"
                checked={day.enabled}
                disabled={disabled}
                onChange={(event) => handleDayToggle(day.day, event.currentTarget.checked)}
              />
              <span>{dayMeta.label}</span>
            </label>

            {!day.enabled ? (
              <span className={styles.unavailable}>No disponible</span>
            ) : (
              <div className={styles.rangeStack}>
                {day.ranges.map((range, rangeIndex) => (
                  <div className={styles.rangeRow} key={`${day.day}-${rangeIndex}`}>
                    <CustomSelect
                      className={styles.timeControl}
                      value={range.start}
                      onValueChange={(start) => handleRangeChange(day.day, rangeIndex, { start })}
                      options={withCurrentTimeOption(START_TIME_OPTIONS, range.start)}
                      searchable
                      searchPlaceholder="Buscar hora inicial"
                      disabled={disabled}
                      aria-label={`Hora inicial del ${dayMeta.label.toLowerCase()}`}
                    />
                    <span className={styles.rangeSeparator} aria-hidden="true">a</span>
                    <CustomSelect
                      className={styles.timeControl}
                      value={range.end}
                      onValueChange={(end) => handleRangeChange(day.day, rangeIndex, { end })}
                      options={withCurrentTimeOption(END_TIME_OPTIONS, range.end)}
                      searchable
                      searchPlaceholder="Buscar hora final"
                      disabled={disabled}
                      aria-label={`Hora final del ${dayMeta.label.toLowerCase()}`}
                    />
                    <div className={styles.rangeActions}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        iconOnly
                        disabled={disabled || !suggestedRange}
                        onClick={() => handleAddRange(day.day, suggestedRange)}
                        aria-label={`Agregar otro horario el ${dayMeta.label.toLowerCase()}`}
                        title={suggestedRange ? 'Agregar otro horario' : 'No queda espacio para otro horario'}
                      >
                        <Plus size={16} aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        iconOnly
                        className={styles.deleteAction}
                        disabled={disabled}
                        onClick={() => handleDeleteRange(day.day, rangeIndex)}
                        aria-label={`Eliminar este horario del ${dayMeta.label.toLowerCase()}`}
                        title="Eliminar horario"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="small"
                            iconOnly
                            disabled={disabled}
                            aria-label={`Copiar horarios del ${dayMeta.label.toLowerCase()}`}
                            title="Copiar horarios"
                          >
                            <Copy size={16} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => handleCopySchedule(day.day)}>
                            Copiar a todos los días
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {WEEKLY_AVAILABILITY_DAYS
                            .filter(target => target.day !== day.day)
                            .map(target => (
                              <DropdownMenuItem
                                key={target.day}
                                onSelect={() => handleCopySchedule(day.day, target.day)}
                              >
                                Copiar a {target.label.toLowerCase()}
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default WeeklyAvailabilityEditor
