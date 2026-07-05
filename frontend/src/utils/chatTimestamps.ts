import {
  addDateOnlyDays,
  convertUTCToLocal,
  formatDateOnlyFromDate,
  getStoredBusinessTimezone,
  parseDateOnlyParts,
  todayDateOnlyInTimezone
} from './timezone'

const MS_PER_DAY = 86_400_000
const RECENT_CHAT_DAY_WINDOW_DAYS = 7

const CHAT_WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado'
]

const CHAT_MONTH_NAMES = [
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

const getLocalChatDate = (value: string | null | undefined, timezone: string) => {
  if (!value) return null
  const date = convertUTCToLocal(value, timezone)
  return Number.isNaN(date.getTime()) ? null : date
}

const padTimePart = (value: number) => String(value).padStart(2, '0')

const formatChatDateOnly = (date: Date, includeYear: boolean) => {
  const month = CHAT_MONTH_NAMES[date.getMonth()]
  if (!month) return ''
  const baseLabel = `${date.getDate()} de ${month}`
  return includeYear ? `${baseLabel} de ${date.getFullYear()}` : baseLabel
}

const capitalizeFirst = (value: string) => value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value

const formatChatWeekday = (date: Date) => capitalizeFirst(CHAT_WEEKDAY_NAMES[date.getDay()] || '')

const getDateOnlyDistanceInDays = (fromDateOnly: string, toDateOnly: string) => {
  const fromParts = parseDateOnlyParts(fromDateOnly)
  const toParts = parseDateOnlyParts(toDateOnly)
  if (!fromParts || !toParts) return Number.NaN

  const fromTime = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day)
  const toTime = Date.UTC(toParts.year, toParts.month - 1, toParts.day)
  return Math.round((toTime - fromTime) / MS_PER_DAY)
}

const formatChatCalendarDate = (localDate: Date, todayKey: string) => {
  const currentYear = Number(todayKey.slice(0, 4))
  return formatChatDateOnly(localDate, localDate.getFullYear() !== currentYear)
}

const formatChatRelativeDayLabel = (
  value: string | null | undefined,
  timezone: string,
  fallback: string
) => {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return fallback

  const dayKey = formatDateOnlyFromDate(localDate)
  const todayKey = todayDateOnlyInTimezone(timezone)
  if (dayKey === todayKey) return 'Hoy'

  const yesterdayKey = addDateOnlyDays(todayKey, -1)
  if (dayKey === yesterdayKey) return 'Ayer'

  const dayDistance = getDateOnlyDistanceInDays(dayKey, todayKey)
  if (dayDistance > 1 && dayDistance < RECENT_CHAT_DAY_WINDOW_DAYS) {
    return formatChatWeekday(localDate)
  }

  return formatChatCalendarDate(localDate, todayKey)
}

export function formatChatMessageTime(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return ''

  const hour = localDate.getHours()
  const displayHour = hour % 12 || 12
  const period = hour >= 12 ? 'p.m.' : 'a.m.'
  return `${displayHour}:${padTimePart(localDate.getMinutes())} ${period}`
}

export function formatChatDayLabel(value?: string | null, timezone = getStoredBusinessTimezone()) {
  return formatChatRelativeDayLabel(value, timezone, '')
}

export function formatChatDaySeparatorLabel(value?: string | null, timezone = getStoredBusinessTimezone()) {
  return formatChatRelativeDayLabel(value, timezone, 'Sin fecha')
}

export function isChatTimestampToday(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return false

  return formatDateOnlyFromDate(localDate) === todayDateOnlyInTimezone(timezone)
}

export function formatChatListTimestamp(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return ''

  const dayKey = formatDateOnlyFromDate(localDate)
  const todayKey = todayDateOnlyInTimezone(timezone)
  if (dayKey === todayKey) return formatChatMessageTime(value, timezone)

  return formatChatRelativeDayLabel(value, timezone, '')
}

export function getChatTimestampDayKey(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return ''
  return formatDateOnlyFromDate(localDate)
}
