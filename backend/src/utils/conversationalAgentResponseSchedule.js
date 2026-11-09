import { DateTime } from 'luxon'
import { getAccountTimezone, resolveTimezone } from './dateUtils.js'

const CLOSED_SCHEDULE = Object.freeze({ weekly: Object.freeze([]), dateOverrides: Object.freeze([]) })

function invalidSchedule(message) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'CONVERSATIONAL_AGENT_INVALID_RESPONSE_SCHEDULE'
  })
}

function timeInMinutes(value, allowMidnight = false) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return allowMidnight && value === '24:00' ? 1440 : null
  }
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function normalizeIntervals(intervals) {
  if (!Array.isArray(intervals)) throw invalidSchedule('Cada fecha debe incluir su lista de horarios.')
  const sorted = intervals.map((interval) => {
    const start = timeInMinutes(interval?.start)
    const end = timeInMinutes(interval?.end, true)
    if (start === null || end === null || start >= end) {
      throw invalidSchedule('La hora de cierre debe ser posterior a la de inicio en el mismo día.')
    }
    return { start: interval.start, end: interval.end }
  }).sort((left, right) => left.start.localeCompare(right.start))

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) {
      throw invalidSchedule('Revisa los horarios empalmados en un mismo día.')
    }
  }
  return sorted
}

export function normalizeAgentResponseSchedule(input) {
  if (input === null) return null
  if (!Array.isArray(input?.weekly) || !Array.isArray(input?.dateOverrides)) {
    throw invalidSchedule('Selecciona los días y horarios de respuesta del bot.')
  }

  const weeklyByDay = new Map()
  for (const entry of input.weekly) {
    const day = entry?.dayOfWeek
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw invalidSchedule('Selecciona un día de la semana válido.')
    }
    if (!weeklyByDay.has(day)) weeklyByDay.set(day, [])
    weeklyByDay.get(day).push(entry)
  }
  const weekly = [...weeklyByDay.keys()].sort().flatMap((dayOfWeek) => (
    normalizeIntervals(weeklyByDay.get(dayOfWeek)).map((interval) => ({ dayOfWeek, ...interval }))
  ))

  const seenDates = new Set()
  const dateOverrides = input.dateOverrides.map((entry) => {
    const date = entry?.date
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !DateTime.fromISO(date, { zone: 'UTC' }).isValid) {
      throw invalidSchedule('Selecciona una fecha válida para el horario del bot.')
    }
    if (seenDates.has(date)) throw invalidSchedule('Cada fecha sólo puede tener un horario especial.')
    seenDates.add(date)
    return { date, intervals: normalizeIntervals(entry.intervals) }
  }).sort((left, right) => left.date.localeCompare(right.date))

  if (!weekly.length && !dateOverrides.some((entry) => entry.intervals.length > 0)) {
    throw invalidSchedule('Agrega al menos un horario semanal o una fecha con horas activas.')
  }
  return { weekly, dateOverrides }
}

export function parseStoredAgentResponseSchedule(value) {
  if (value === null || value === undefined) return null
  try {
    const schedule = typeof value === 'string' ? JSON.parse(value) : value
    return schedule === null ? CLOSED_SCHEDULE : normalizeAgentResponseSchedule(schedule)
  } catch {
    // Un horario inválido en almacenamiento no debe prender el bot 24/7.
    return CLOSED_SCHEDULE
  }
}

export function isAgentResponseScheduleOpenAt(schedule, timezone, instantMs) {
  if (schedule == null) return true
  if (!Number.isFinite(instantMs)) return false
  const local = DateTime.fromMillis(instantMs, { zone: resolveTimezone(timezone) })
  if (!local.isValid) return false
  const override = schedule.dateOverrides.find((entry) => entry.date === local.toISODate())
  const intervals = override?.intervals ?? schedule.weekly.filter((entry) => entry.dayOfWeek === local.weekday % 7)
  const minute = local.hour * 60 + local.minute
  return intervals.some(({ start, end }) => minute >= timeInMinutes(start) && minute < timeInMinutes(end, true))
}

export async function isAgentResponseScheduleOpen(schedule, ...instantsMs) {
  if (schedule == null) return true
  const timezone = await getAccountTimezone({ throwOnError: true })
  return instantsMs.every((instantMs) => isAgentResponseScheduleOpenAt(schedule, timezone, instantMs))
}
