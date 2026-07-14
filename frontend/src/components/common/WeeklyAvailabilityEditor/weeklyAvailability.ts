export interface CalendarOpenHourRange {
  openHour: number
  openMinute: number
  closeHour: number
  closeMinute: number
}

export interface CalendarOpenHoursShape {
  daysOfTheWeek: number[]
  hours: CalendarOpenHourRange[]
}

export interface WeeklyAvailabilityTimeRange {
  start: string
  end: string
}

export interface WeeklyAvailabilityDay {
  day: number
  enabled: boolean
  ranges: WeeklyAvailabilityTimeRange[]
}

export type WeeklyAvailability = WeeklyAvailabilityDay[]

export interface WeeklyAvailabilityValidationIssue {
  day: number
  code: 'missing_ranges' | 'invalid_range' | 'range_too_short' | 'overlap'
  message: string
}

export interface WeeklyAvailabilityValidationResult {
  valid: boolean
  issues: WeeklyAvailabilityValidationIssue[]
}

export const WEEKLY_AVAILABILITY_DAYS = [
  { day: 0, label: 'Domingo', shortLabel: 'Dom' },
  { day: 1, label: 'Lunes', shortLabel: 'Lun' },
  { day: 2, label: 'Martes', shortLabel: 'Mar' },
  { day: 3, label: 'Miércoles', shortLabel: 'Mié' },
  { day: 4, label: 'Jueves', shortLabel: 'Jue' },
  { day: 5, label: 'Viernes', shortLabel: 'Vie' },
  { day: 6, label: 'Sábado', shortLabel: 'Sáb' }
] as const

export const DEFAULT_WEEKLY_AVAILABILITY_RANGE: WeeklyAvailabilityTimeRange = {
  start: '09:00',
  end: '17:00'
}

const SUMMARY_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const padTimePart = (value: number) => String(value).padStart(2, '0')

const normalizeWeekDay = (value: unknown) => {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed === 7) return 0
  return parsed >= 0 && parsed <= 6 ? parsed : null
}

export const timeValueToMinutes = (value: string, allowEndOfDay = false) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  if (allowEndOfDay && hour === 24 && minute === 0) return 24 * 60
  if (hour < 0 || hour > 23) return null
  return hour * 60 + minute
}

export const minutesToTimeValue = (minutes: number, allowEndOfDay = false) => {
  const rounded = Math.trunc(Number(minutes))
  if (allowEndOfDay && rounded === 24 * 60) return '24:00'
  const safeMinutes = Math.min(24 * 60 - 1, Math.max(0, rounded))
  return `${padTimePart(Math.floor(safeMinutes / 60))}:${padTimePart(safeMinutes % 60)}`
}

export const formatAvailabilityTime = (value: string) => {
  const minutes = timeValueToMinutes(value, true)
  if (minutes === null) return value
  if (minutes === 24 * 60) return '12:00 AM · día siguiente'
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const period = hour >= 12 ? 'PM' : 'AM'
  return `${padTimePart(hour % 12 || 12)}:${padTimePart(minute)} ${period}`
}

const cloneRanges = (ranges: WeeklyAvailabilityTimeRange[]) => ranges.map(range => ({ ...range }))

export const createDefaultWeeklyAvailability = (): WeeklyAvailability => (
  WEEKLY_AVAILABILITY_DAYS.map(({ day }) => ({
    day,
    enabled: day >= 1 && day <= 5,
    ranges: day >= 1 && day <= 5 ? [{ ...DEFAULT_WEEKLY_AVAILABILITY_RANGE }] : []
  }))
)

export const createEmptyWeeklyAvailability = (): WeeklyAvailability => (
  WEEKLY_AVAILABILITY_DAYS.map(({ day }) => ({ day, enabled: false, ranges: [] }))
)

export const cloneWeeklyAvailability = (value: WeeklyAvailability): WeeklyAvailability => (
  WEEKLY_AVAILABILITY_DAYS.map(({ day }) => {
    const source = value.find(entry => entry.day === day)
    return {
      day,
      enabled: Boolean(source?.enabled),
      ranges: cloneRanges(source?.ranges || [])
    }
  })
)

const rangeFromOpenHours = (value: unknown): WeeklyAvailabilityTimeRange | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const parsePart = (part: unknown) => {
    if (part === null || part === undefined || typeof part === 'boolean' || String(part).trim() === '') return null
    const parsed = Number(part)
    return Number.isInteger(parsed) ? parsed : null
  }
  const openHour = parsePart(source.openHour ?? source.open_hour)
  const openMinute = parsePart(source.openMinute ?? source.open_minute)
  const closeHour = parsePart(source.closeHour ?? source.close_hour)
  const closeMinute = parsePart(source.closeMinute ?? source.close_minute)
  if (openHour === null || openHour < 0 || openHour > 23) return null
  if (openMinute === null || openMinute < 0 || openMinute > 59) return null
  if (closeHour === null || closeHour < 0 || closeHour > 24) return null
  if (closeMinute === null || closeMinute < 0 || closeMinute > 59) return null
  if (closeHour === 24 && closeMinute !== 0) return null

  const start = minutesToTimeValue(openHour * 60 + openMinute)
  // Configuraciones históricas locales admitían 24:00, pero los calendarios
  // conectados sólo aceptan closeHour 0..23. Al editar, llévalo al último minuto
  // válido en vez de dejar un valor que el usuario no podría volver a guardar.
  const endMinutes = closeHour === 24 && closeMinute === 0
    ? 24 * 60 - 1
    : closeHour * 60 + closeMinute
  const end = minutesToTimeValue(endMinutes, true)
  const startMinutes = timeValueToMinutes(start)
  const normalizedEndMinutes = timeValueToMinutes(end, true)
  if (startMinutes === null || normalizedEndMinutes === null || normalizedEndMinutes <= startMinutes) return null
  return { start, end }
}

export const openHoursToWeeklyAvailability = (
  value: unknown,
  { fallbackToDefault = true }: { fallbackToDefault?: boolean } = {}
): WeeklyAvailability => {
  const source = Array.isArray(value) ? value : []
  if (!source.length) return fallbackToDefault ? createDefaultWeeklyAvailability() : createEmptyWeeklyAvailability()

  const weekly = createEmptyWeeklyAvailability()
  source.forEach(rawSchedule => {
    if (!rawSchedule || typeof rawSchedule !== 'object') return
    const schedule = rawSchedule as Record<string, unknown>
    const rawDays = Array.isArray(schedule.daysOfTheWeek)
      ? schedule.daysOfTheWeek
      : schedule.day !== undefined
        ? [schedule.day]
        : schedule.dayOfWeek !== undefined
          ? [schedule.dayOfWeek]
          : []
    const days = rawDays.map(normalizeWeekDay).filter((day): day is number => day !== null)
    const rawRanges = Array.isArray(schedule.hours) && schedule.hours.length ? schedule.hours : [schedule]
    const ranges = rawRanges.map(rangeFromOpenHours).filter((range): range is WeeklyAvailabilityTimeRange => Boolean(range))

    days.forEach(day => {
      const target = weekly.find(entry => entry.day === day)
      if (!target || !ranges.length) return
      target.enabled = true
      ranges.forEach(range => {
        if (!target.ranges.some(existing => existing.start === range.start && existing.end === range.end)) {
          target.ranges.push({ ...range })
        }
      })
    })
  })

  weekly.forEach(entry => {
    entry.ranges.sort((left, right) => (
      (timeValueToMinutes(left.start) || 0) - (timeValueToMinutes(right.start) || 0)
    ))
  })

  const hasUsableSchedule = weekly.some(entry => entry.enabled && entry.ranges.length)
  return hasUsableSchedule || !fallbackToDefault ? weekly : createDefaultWeeklyAvailability()
}

export const weeklyAvailabilityToOpenHours = (value: WeeklyAvailability): CalendarOpenHoursShape[] => (
  cloneWeeklyAvailability(value)
    .filter(entry => entry.enabled && entry.ranges.length)
    .map(entry => ({
      daysOfTheWeek: [entry.day],
      hours: entry.ranges
        .map(range => {
          const start = timeValueToMinutes(range.start)
          const end = timeValueToMinutes(range.end)
          if (start === null || end === null || end <= start) return null
          return {
            openHour: Math.floor(start / 60),
            openMinute: start % 60,
            closeHour: Math.floor(end / 60),
            closeMinute: end % 60
          }
        })
        .filter((range): range is CalendarOpenHourRange => Boolean(range))
        .sort((left, right) => (
          left.openHour * 60 + left.openMinute - (right.openHour * 60 + right.openMinute)
        ))
    }))
    .filter(entry => entry.hours.length)
)

export const calendarDurationToMinutes = (value: unknown, unit: unknown) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 1
  const normalizedUnit = String(unit || '').trim().toLowerCase()
  return Math.max(1, Math.round(amount * (normalizedUnit.startsWith('hour') ? 60 : 1)))
}

export const validateWeeklyAvailability = (
  value: WeeklyAvailability,
  minimumRangeMinutes = 1
): WeeklyAvailabilityValidationResult => {
  const issues: WeeklyAvailabilityValidationIssue[] = []
  const requiredMinutes = Math.max(1, Math.round(Number(minimumRangeMinutes) || 1))

  cloneWeeklyAvailability(value).forEach(entry => {
    if (!entry.enabled) return
    const dayLabel = WEEKLY_AVAILABILITY_DAYS.find(day => day.day === entry.day)?.label || 'Ese día'
    if (!entry.ranges.length) {
      issues.push({
        day: entry.day,
        code: 'missing_ranges',
        message: `${dayLabel} está activo, pero no tiene ningún horario.`
      })
      return
    }

    const normalizedRanges = entry.ranges.map(range => ({
      range,
      start: timeValueToMinutes(range.start),
      end: timeValueToMinutes(range.end)
    }))

    normalizedRanges.forEach(({ range, start, end }) => {
      if (start === null || end === null || end <= start) {
        issues.push({
          day: entry.day,
          code: 'invalid_range',
          message: `Revisa el horario ${range.start || 'sin inicio'}–${range.end || 'sin cierre'} de ${dayLabel}. La hora final debe ser posterior a la inicial.`
        })
        return
      }
      if (end - start < requiredMinutes) {
        issues.push({
          day: entry.day,
          code: 'range_too_short',
          message: `El horario ${range.start}–${range.end} de ${dayLabel} es menor que la duración de la cita (${requiredMinutes} min).`
        })
      }
    })

    const validRanges = normalizedRanges
      .filter((range): range is { range: WeeklyAvailabilityTimeRange; start: number; end: number } => (
        range.start !== null && range.end !== null && range.end > range.start
      ))
      .sort((left, right) => left.start - right.start)

    for (let index = 1; index < validRanges.length; index += 1) {
      const previous = validRanges[index - 1]
      const current = validRanges[index]
      if (current.start < previous.end) {
        issues.push({
          day: entry.day,
          code: 'overlap',
          message: `Hay horarios empalmados el ${dayLabel.toLowerCase()}: ${previous.range.start}–${previous.range.end} y ${current.range.start}–${current.range.end}.`
        })
      }
    }
  })

  return { valid: issues.length === 0, issues }
}

export const findSuggestedAvailabilityRange = (
  ranges: WeeklyAvailabilityTimeRange[],
  minimumRangeMinutes = 60
): WeeklyAvailabilityTimeRange | null => {
  const lastMinuteOfDay = 24 * 60 - 1
  const desiredMinutes = Math.min(lastMinuteOfDay, Math.max(5, Math.ceil(Math.max(60, minimumRangeMinutes) / 5) * 5))
  const occupied = ranges
    .map(range => ({
      start: timeValueToMinutes(range.start),
      end: timeValueToMinutes(range.end)
    }))
    .filter((range): range is { start: number; end: number } => (
      range.start !== null && range.end !== null && range.end > range.start
    ))
    .sort((left, right) => left.start - right.start)

  const gaps: Array<{ start: number; end: number }> = []
  if (occupied.length) {
    gaps.push({ start: occupied[occupied.length - 1].end, end: lastMinuteOfDay })
    let cursor = 0
    occupied.forEach(range => {
      if (range.start > cursor) gaps.push({ start: cursor, end: range.start })
      cursor = Math.max(cursor, range.end)
    })
  } else {
    gaps.push({ start: 9 * 60, end: 17 * 60 }, { start: 0, end: lastMinuteOfDay })
  }

  const gap = gaps.find(candidate => candidate.end - candidate.start >= desiredMinutes)
  if (!gap) return null
  return {
    start: minutesToTimeValue(gap.start),
    end: minutesToTimeValue(gap.start + desiredMinutes)
  }
}

const formatDayGroup = (days: number[]) => {
  const positions = days
    .map(day => ({ day, position: SUMMARY_DAY_ORDER.indexOf(day) }))
    .filter(entry => entry.position >= 0)
    .sort((left, right) => left.position - right.position)
  const sequences: number[][] = []

  positions.forEach(entry => {
    const current = sequences[sequences.length - 1]
    const previousPosition = current?.length
      ? SUMMARY_DAY_ORDER.indexOf(current[current.length - 1])
      : -2
    if (!current || entry.position !== previousPosition + 1) sequences.push([entry.day])
    else current.push(entry.day)
  })

  return sequences.map(sequence => {
    const first = WEEKLY_AVAILABILITY_DAYS.find(day => day.day === sequence[0])?.shortLabel || ''
    const last = WEEKLY_AVAILABILITY_DAYS.find(day => day.day === sequence[sequence.length - 1])?.shortLabel || ''
    return sequence.length > 1 ? `${first}–${last}` : first
  }).join(', ')
}

export const summarizeWeeklyAvailability = (value: WeeklyAvailability) => {
  const enabled = cloneWeeklyAvailability(value).filter(entry => entry.enabled && entry.ranges.length)
  if (!enabled.length) return 'Sin disponibilidad'

  const groups = new Map<string, number[]>()
  enabled.forEach(entry => {
    const rangeLabel = entry.ranges
      .slice()
      .sort((left, right) => (timeValueToMinutes(left.start) || 0) - (timeValueToMinutes(right.start) || 0))
      .map(range => `${formatAvailabilityTime(range.start)}–${formatAvailabilityTime(range.end)}`)
      .join(', ')
    groups.set(rangeLabel, [...(groups.get(rangeLabel) || []), entry.day])
  })

  if (groups.size === 1 && enabled.length === 7) {
    return `Todos los días · ${groups.keys().next().value}`
  }

  return [...groups.entries()]
    .map(([ranges, days]) => `${formatDayGroup(days)} · ${ranges}`)
    .join('; ')
}
