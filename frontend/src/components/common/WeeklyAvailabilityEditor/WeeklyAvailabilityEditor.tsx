import React, { useMemo, useState } from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { Button } from '../Button'
import { TimePickerSelect } from '../TimePickerSelect'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
  minutesToTimeValue,
  timeValueToMinutes,
  type WeeklyAvailability,
  type WeeklyAvailabilityTimeRange
} from './weeklyAvailability'

const LAST_MINUTE_OF_DAY = 24 * 60 - 1
import styles from './WeeklyAvailabilityEditor.module.css'

export interface WeeklyAvailabilityEditorProps {
  value: WeeklyAvailability
  onChange: (value: WeeklyAvailability) => void
  minimumRangeMinutes?: number
  disabled?: boolean
  'aria-label'?: string
}

interface CopyScheduleMenuProps {
  sourceDay: number
  disabled: boolean
  onApply: (targetDays: number[]) => void
}

const CopyScheduleMenu: React.FC<CopyScheduleMenuProps> = ({
  sourceDay,
  disabled,
  onApply
}) => {
  const [open, setOpen] = useState(false)
  const [targetDays, setTargetDays] = useState<number[]>([])
  const availableTargetDays: number[] = WEEKLY_AVAILABILITY_DAYS
    .filter(day => day.day !== sourceDay)
    .map(day => day.day)
  const selectedTargets = targetDays.filter(day => availableTargetDays.includes(day))
  const allSelected = selectedTargets.length === availableTargetDays.length
  const selectAllState = allSelected
    ? true
    : selectedTargets.length
      ? 'indeterminate'
      : false

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setTargetDays([])
    setOpen(nextOpen)
  }

  const toggleTargetDay = (day: number, checked: boolean) => {
    setTargetDays(current => checked
      ? [...new Set([...current, day])]
      : current.filter(target => target !== day))
  }

  const applyCopy = () => {
    if (!selectedTargets.length) return
    onApply(selectedTargets)
    setOpen(false)
  }

  const sourceLabel = WEEKLY_AVAILABILITY_DAYS
    .find(day => day.day === sourceDay)?.label.toLowerCase() || 'ese día'

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="small"
          iconOnly
          disabled={disabled}
          aria-label={`Copiar horarios del ${sourceLabel}`}
          title="Copiar horarios"
        >
          <Copy size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12} className={styles.copyMenu}>
        <div className={styles.copyMenuTitle}>Copiar horas a…</div>
        <DropdownMenuCheckboxItem
          checked={selectAllState}
          onCheckedChange={() => setTargetDays(allSelected ? [] : availableTargetDays)}
          onSelect={(event) => event.preventDefault()}
        >
          Copiar a todos
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {WEEKLY_AVAILABILITY_DAYS.map(target => {
          const isSource = target.day === sourceDay
          return (
            <DropdownMenuCheckboxItem
              key={target.day}
              checked={isSource || selectedTargets.includes(target.day)}
              disabled={isSource}
              onCheckedChange={(checked) => toggleTargetDay(target.day, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              {target.label}
            </DropdownMenuCheckboxItem>
          )
        })}
        <div className={styles.copyMenuActions}>
          <DropdownMenuItem
            asChild
            unstyled
            disabled={!selectedTargets.length}
            onSelect={(event) => {
              event.preventDefault()
              applyCopy()
            }}
          >
            <Button
              type="button"
              size="small"
              fullWidth
              disabled={!selectedTargets.length}
            >
              Aplicar
            </Button>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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

  // Mantiene el rango siempre válido (fin > inicio). Cuando la persona mueve un
  // extremo por encima del otro, en vez de dejar un rango imposible (que se
  // descartaría al guardar) conservamos la duración del bloque desplazando el
  // extremo que NO tocó. Así se puede configurar "2:00 – 7:00 PM" empezando por
  // cualquiera de los dos selectores sin que el bloque se pierda.
  const keepRangeValid = (
    previous: WeeklyAvailabilityTimeRange,
    patch: Partial<WeeklyAvailabilityTimeRange>
  ): WeeklyAvailabilityTimeRange => {
    const next = { ...previous, ...patch }
    const start = timeValueToMinutes(next.start)
    const end = timeValueToMinutes(next.end, true)
    if (start === null || end === null || end > start) return next

    const prevStart = timeValueToMinutes(previous.start)
    const prevEnd = timeValueToMinutes(previous.end, true)
    const fallbackSpan = Math.max(5, Math.round(minimumRangeMinutes) || 0)
    const span = prevStart !== null && prevEnd !== null && prevEnd > prevStart
      ? prevEnd - prevStart
      : fallbackSpan

    if ('start' in patch) {
      const shiftedEnd = Math.min(LAST_MINUTE_OF_DAY, start + span)
      if (shiftedEnd > start) return { start: next.start, end: minutesToTimeValue(shiftedEnd, true) }
      // Sin espacio al final del día: fija el fin al último minuto y retrocede el inicio.
      return {
        start: minutesToTimeValue(Math.max(0, LAST_MINUTE_OF_DAY - span)),
        end: minutesToTimeValue(LAST_MINUTE_OF_DAY, true)
      }
    }
    // Se movió el fin: adelanta el inicio para conservar el bloque.
    return { start: minutesToTimeValue(Math.max(0, end - span)), end: next.end }
  }

  const handleRangeChange = (
    day: number,
    rangeIndex: number,
    patch: Partial<WeeklyAvailabilityTimeRange>
  ) => {
    emitDayChange(day, current => ({
      ...current,
      ranges: current.ranges.map((range, index) => index === rangeIndex ? keepRangeValid(range, patch) : range)
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

  const handleCopySchedule = (sourceDay: number, targetDays: number[]) => {
    const source = weekly.find(entry => entry.day === sourceDay)
    if (!source?.ranges.length) return
    const targets = new Set(targetDays)
    onChange(weekly.map(entry => {
      return targets.has(entry.day)
        ? { ...entry, enabled: source.enabled, ranges: source.ranges.map(range => ({ ...range })) }
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
                    <TimePickerSelect
                      className={styles.timeControl}
                      value={range.start}
                      onValueChange={(start) => handleRangeChange(day.day, rangeIndex, { start })}
                      disabled={disabled}
                      aria-label={`Hora inicial del ${dayMeta.label.toLowerCase()}`}
                    />
                    <span className={styles.rangeSeparator} aria-hidden="true">a</span>
                    <TimePickerSelect
                      className={styles.timeControl}
                      value={range.end}
                      onValueChange={(end) => handleRangeChange(day.day, rangeIndex, { end })}
                      allowLastMinute
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
                      {rangeIndex === 0 ? (
                        <CopyScheduleMenu
                          sourceDay={day.day}
                          disabled={disabled}
                          onApply={(targetDays) => handleCopySchedule(day.day, targetDays)}
                        />
                      ) : null}
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
