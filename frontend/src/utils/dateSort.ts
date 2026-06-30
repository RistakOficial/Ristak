const DATE_SORT_KEY_PATTERN = /(^|_|\b)(date|time|at)$|(^|_)(created|updated|started|ended|sent|paid|due|scheduled|next|last|first|start|end)(_|$)/i

export const isDateSortKey = (key?: string | null): boolean => {
  const normalized = String(key || '').trim()
  if (!normalized) return false

  return DATE_SORT_KEY_PATTERN.test(normalized)
    || /(?:Date|Time|At)$/.test(normalized)
    || /^(date|time)$/.test(normalized)
}

export const parseSortableDateValue = (value?: unknown): number => {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : 0
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }

  const raw = String(value || '').trim()
  if (!raw) return 0

  let normalized = raw
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T00:00:00.000Z`
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    const withDateSeparator = raw.replace(/\s+/, 'T')
    const withNormalizedOffset = withDateSeparator
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
      .replace(/([+-]\d{2})$/, '$1:00')
    normalized = /[zZ]$|[+-]\d{2}:\d{2}$/.test(withNormalizedOffset)
      ? withNormalizedOffset
      : `${withNormalizedOffset}Z`
  }

  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export const getDateSortValueForKey = (key: string, value: unknown): unknown => (
  isDateSortKey(key) ? parseSortableDateValue(value) : value
)
