import { createHash } from 'node:crypto'

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g

export function hashPaginationCursorScope(kind, context = {}) {
  return createHash('sha256')
    .update(JSON.stringify({ kind: String(kind || '').trim(), ...context }))
    .digest('base64url')
}

export function paginationCursorRangeScope(range = {}) {
  return {
    startDate: range.startZoned?.toISODate?.() || null,
    endDate: range.endZoned?.toISODate?.() || null,
    startUtc: range.startUtc || null,
    endUtc: range.endUtc || null,
    timezone: range.appliedTimezone || null
  }
}

export function paginationCursorHiddenFiltersScope(filters = []) {
  const uniqueFilters = new Map()

  for (const filter of Array.isArray(filters) ? filters : []) {
    const normalized = {
      text: String(filter?.text ?? '').replace(CONTROL_CHARACTERS, ''),
      type: filter?.type === 'exact' ? 'exact' : 'contains'
    }
    uniqueFilters.set(JSON.stringify(normalized), normalized)
  }

  return [...uniqueFilters.keys()]
    .sort()
    .map(key => uniqueFilters.get(key))
}

export function paginationCursorListScope(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value)))]
    .filter(Boolean)
    .sort()
}
