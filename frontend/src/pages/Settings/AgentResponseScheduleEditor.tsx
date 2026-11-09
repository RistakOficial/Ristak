import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, DatePicker } from '@/components/common'
import {
  AvailabilityTimeRanges,
  DEFAULT_WEEKLY_AVAILABILITY_RANGE,
  WeeklyAvailabilityEditor,
  createEmptyWeeklyAvailability,
  validateAvailabilityRanges,
  validateWeeklyAvailability
} from '@/components/common/WeeklyAvailabilityEditor'
import { useTimezone } from '@/contexts/TimezoneContext'
import type { AgentResponseSchedule } from '@/services/conversationalAgentService'
import { formatDate } from '@/utils/format'
import { todayDateOnlyInTimezone } from '@/utils/timezone'
import styles from './ConversationalAgentSettings.module.css'

const toWeeklyAvailability = (weekly: AgentResponseSchedule['weekly']) => (
  createEmptyWeeklyAvailability().map(({ day }) => {
    const ranges = weekly.filter((entry) => entry.dayOfWeek === day).map(({ start, end }) => ({ start, end }))
    return { day, enabled: ranges.length > 0, ranges }
  })
)

export function getAgentResponseScheduleError(schedule: AgentResponseSchedule | null) {
  if (!schedule) return ''
  if (!schedule.weekly.length && !schedule.dateOverrides.some(({ intervals }) => intervals.length)) {
    return 'Activa un día o agrega una fecha con horario para guardar.'
  }

  const weeklyIssue = validateWeeklyAvailability(toWeeklyAvailability(schedule.weekly), 1, true).issues[0]
  if (weeklyIssue) return weeklyIssue.message

  for (const { date, intervals } of schedule.dateOverrides) {
    if (!intervals.length) continue
    const label = formatDate(date, { includeYear: true })
    const issue = validateAvailabilityRanges(intervals, label, 1, true)[0]
    if (issue) return issue.message
  }
  return ''
}

interface AgentResponseScheduleEditorProps {
  value: AgentResponseSchedule
  onChange: (value: AgentResponseSchedule) => void
}

export function AgentResponseScheduleEditor({ value, onChange }: AgentResponseScheduleEditorProps) {
  const { timezone } = useTimezone()
  const today = todayDateOnlyInTimezone(timezone)
  const [newDate, setNewDate] = useState('')
  const duplicateDate = value.dateOverrides.some(({ date }) => date === newDate)
  const weekly = toWeeklyAvailability(value.weekly)

  const addDate = () => {
    if (!newDate || duplicateDate) return
    const dateOverrides = [
      ...value.dateOverrides,
      { date: newDate, intervals: [{ ...DEFAULT_WEEKLY_AVAILABILITY_RANGE }] }
    ].sort((left, right) => left.date.localeCompare(right.date))
    setNewDate('')
    onChange({ ...value, dateOverrides })
  }

  return (
    <div className={styles.responseScheduleEditor}>
      <section className={styles.responseScheduleGroup} aria-label="Horario semanal">
        <h4>Horario semanal</h4>
        <p>Los días que dejes sin marcar quedan fuera del horario de respuesta. Los horarios usan la zona del negocio ({timezone}).</p>
        <WeeklyAvailabilityEditor
          value={weekly}
          onChange={(next) => onChange({
            ...value,
            weekly: next.flatMap(({ day, enabled, ranges }) => enabled
              ? ranges.map((range) => ({ ...range, dayOfWeek: day }))
              : [])
          })}
          minimumRangeMinutes={1}
          mondayFirst
          allowEndOfDay
          aria-label="Días y horas de respuesta del agente"
        />
      </section>

      <section className={styles.responseScheduleGroup} aria-label="Fechas especiales">
        <h4>Fechas especiales</h4>
        <p>Agrega una fecha para elegir otro horario o dejarla sin respuestas. Esa fecha tiene prioridad sobre el horario semanal.</p>

        {value.dateOverrides.map(({ date, intervals }) => {
          const dateLabel = formatDate(date, { timezone, includeYear: true })
          const updateIntervals = (nextIntervals: typeof intervals) => onChange({
            ...value,
            dateOverrides: value.dateOverrides.map((entry) => entry.date === date
              ? { ...entry, intervals: nextIntervals }
              : entry)
          })

          return (
            <div key={date} className={styles.responseScheduleDate} role="group" aria-label={dateLabel}>
              <div className={styles.responseScheduleDateHeading}>
                <span>{dateLabel}</span>
                <div className={styles.responseScheduleDateActions}>
                  {intervals.length > 0 && (
                    <Button variant="ghost" size="small" type="button" onClick={() => updateIntervals([])}>
                      Dejar sin respuestas
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="small"
                    iconOnly
                    type="button"
                    aria-label={`Quitar la fecha ${dateLabel}`}
                    title="Quitar fecha especial"
                    onClick={() => onChange({
                      ...value,
                      dateOverrides: value.dateOverrides.filter((entry) => entry.date !== date)
                    })}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>

              <AvailabilityTimeRanges
                ranges={intervals}
                onChange={updateIntervals}
                contextLabel={`del ${dateLabel}`}
                unavailableLabel="Sin respuestas"
                minimumRangeMinutes={1}
                allowEndOfDay
              />
            </div>
          )
        })}

        <div className={styles.responseScheduleDateActions}>
          <DatePicker
            className={styles.responseScheduleDateInput}
            value={newDate}
            onChange={setNewDate}
            today={today}
            placeholder="Selecciona una fecha"
            ariaLabel="Fecha especial"
          />
          <Button type="button" variant="secondary" size="small" disabled={!newDate || duplicateDate} onClick={addDate}>
            <Plus size={16} aria-hidden="true" />
            Agregar fecha
          </Button>
        </div>
        {duplicateDate && <p role="status">Esa fecha ya tiene un horario especial.</p>}
      </section>
    </div>
  )
}
