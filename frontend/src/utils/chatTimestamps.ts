import {
  addDateOnlyDays,
  convertUTCToLocal,
  formatDateOnlyFromDate,
  getStoredBusinessTimezone,
  todayDateOnlyInTimezone
} from './timezone'

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
  return [date.getDate(), month, includeYear ? date.getFullYear() : null].filter(Boolean).join(' ')
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
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return ''

  const dayKey = formatDateOnlyFromDate(localDate)
  const todayKey = todayDateOnlyInTimezone(timezone)
  if (dayKey === todayKey) return 'Hoy'

  const yesterdayKey = addDateOnlyDays(todayKey, -1)
  if (dayKey === yesterdayKey) return 'Ayer'

  const currentYear = Number(todayKey.slice(0, 4))
  return formatChatDateOnly(localDate, localDate.getFullYear() !== currentYear)
}

export function formatChatDaySeparatorLabel(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return 'Sin fecha'

  const dayKey = formatDateOnlyFromDate(localDate)
  const todayKey = todayDateOnlyInTimezone(timezone)
  if (dayKey === todayKey) return 'Hoy'

  const yesterdayKey = addDateOnlyDays(todayKey, -1)
  if (dayKey === yesterdayKey) return 'Ayer'

  const currentYear = Number(todayKey.slice(0, 4))
  return formatChatDateOnly(localDate, localDate.getFullYear() !== currentYear)
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

  const yesterdayKey = addDateOnlyDays(todayKey, -1)
  if (dayKey === yesterdayKey) return 'Ayer'

  const currentYear = Number(todayKey.slice(0, 4))
  return formatChatDateOnly(localDate, localDate.getFullYear() !== currentYear)
}
