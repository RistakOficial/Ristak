import {
  addDateOnlyDays,
  convertUTCToLocal,
  formatDateOnlyFromDate,
  formatInTimezone,
  getStoredBusinessTimezone,
  todayDateOnlyInTimezone
} from './timezone'

const cleanFormattedDate = (value: string) => value.replace(/\./g, '').trim()

const getLocalChatDate = (value: string | null | undefined, timezone: string) => {
  if (!value) return null
  const date = convertUTCToLocal(value, timezone)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatChatDateOnly = (value: string, timezone: string, includeYear: boolean) => cleanFormattedDate(
  formatInTimezone(value, timezone, {
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {})
  })
)

export function formatChatMessageTime(value?: string | null, timezone = getStoredBusinessTimezone()) {
  if (!value) return ''
  try {
    return formatInTimezone(value, timezone, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  } catch {
    return ''
  }
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
  return formatChatDateOnly(value, timezone, localDate.getFullYear() !== currentYear)
}

export function formatChatDaySeparatorLabel(value?: string | null, timezone = getStoredBusinessTimezone()) {
  const localDate = getLocalChatDate(value, timezone)
  if (!value || !localDate) return 'Sin fecha'

  const dayKey = formatDateOnlyFromDate(localDate)
  const todayKey = todayDateOnlyInTimezone(timezone)
  if (dayKey === todayKey) return 'Hoy'

  const yesterdayKey = addDateOnlyDays(todayKey, -1)
  if (dayKey === yesterdayKey) return 'Ayer'

  return formatChatDateOnly(value, timezone, true)
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

  const currentYear = Number(todayKey.slice(0, 4))
  return formatChatDateOnly(value, timezone, localDate.getFullYear() !== currentYear)
}
