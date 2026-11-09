import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../Button'
import { TimePickerSelect } from '../TimePickerSelect'
import {
  DEFAULT_WEEKLY_AVAILABILITY_RANGE,
  findSuggestedAvailabilityRange,
  minutesToTimeValue,
  timeValueToMinutes,
  type WeeklyAvailabilityTimeRange
} from './weeklyAvailability'
import styles from './WeeklyAvailabilityEditor.module.css'

interface AvailabilityTimeRangesProps {
  ranges: WeeklyAvailabilityTimeRange[]
  onChange: (ranges: WeeklyAvailabilityTimeRange[]) => void
  contextLabel: string
  unavailableLabel?: string
  minimumRangeMinutes?: number
  allowEndOfDay?: boolean
  disabled?: boolean
  firstRangeAction?: React.ReactNode
}

export const AvailabilityTimeRanges: React.FC<AvailabilityTimeRangesProps> = ({
  ranges,
  onChange,
  contextLabel,
  unavailableLabel = 'No disponible',
  minimumRangeMinutes = 60,
  allowEndOfDay = false,
  disabled = false,
  firstRangeAction
}) => {
  const suggestedRange = findSuggestedAvailabilityRange(ranges, minimumRangeMinutes, allowEndOfDay)
  const lastMinuteOfDay = 24 * 60 - Number(!allowEndOfDay)

  const changeRange = (rangeIndex: number, patch: Partial<WeeklyAvailabilityTimeRange>) => {
    onChange(ranges.map((previous, index) => {
      if (index !== rangeIndex) return previous

      const next = { ...previous, ...patch }
      const start = timeValueToMinutes(next.start)
      const end = timeValueToMinutes(next.end, allowEndOfDay)
      if (start === null || end === null || end > start) return next

      // Si un extremo rebasa al otro, conserva la duración cuando cabe en el día.
      const prevStart = timeValueToMinutes(previous.start)
      const prevEnd = timeValueToMinutes(previous.end, allowEndOfDay)
      const span = prevStart !== null && prevEnd !== null && prevEnd > prevStart
        ? prevEnd - prevStart
        : Math.max(5, Math.round(minimumRangeMinutes) || 0)

      if ('start' in patch) {
        const shiftedEnd = Math.min(lastMinuteOfDay, start + span)
        const endValue = minutesToTimeValue(shiftedEnd, allowEndOfDay)
        if (shiftedEnd > start) return { start: next.start, end: endValue }
        return { start: minutesToTimeValue(Math.max(0, shiftedEnd - span)), end: endValue }
      }
      return { start: minutesToTimeValue(Math.max(0, end - span)), end: next.end }
    }))
  }

  if (!ranges.length) {
    return (
      <div className={styles.rangeEmpty}>
        <span className={styles.unavailable}>{unavailableLabel}</span>
        <Button
          type="button"
          variant="ghost"
          size="small"
          disabled={disabled}
          onClick={() => onChange([{ ...DEFAULT_WEEKLY_AVAILABILITY_RANGE }])}
          aria-label={`Agregar horario ${contextLabel}`}
        >
          <Plus size={16} aria-hidden="true" />
          Agregar horario
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.rangeStack}>
      {ranges.map((range, index) => (
        <div className={styles.rangeRow} key={index}>
          <TimePickerSelect
            className={styles.timeControl}
            value={range.start}
            onValueChange={(start) => changeRange(index, { start })}
            disabled={disabled}
            aria-label={`Hora inicial ${contextLabel}`}
          />
          <span className={styles.rangeSeparator} aria-hidden="true">a</span>
          <TimePickerSelect
            className={styles.timeControl}
            value={range.end}
            onValueChange={(end) => changeRange(index, { end })}
            allowLastMinute
            allowEndOfDay={allowEndOfDay}
            disabled={disabled}
            aria-label={`Hora final ${contextLabel}`}
          />
          <div className={styles.rangeActions}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              iconOnly
              disabled={disabled || !suggestedRange}
              onClick={() => suggestedRange && onChange([...ranges, suggestedRange])}
              aria-label={`Agregar otro horario ${contextLabel}`}
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
              onClick={() => onChange(ranges.filter((_, rangeIndex) => rangeIndex !== index))}
              aria-label={`Eliminar este horario ${contextLabel}`}
              title="Eliminar horario"
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
            {index === 0 ? firstRangeAction : null}
          </div>
        </div>
      ))}
    </div>
  )
}
