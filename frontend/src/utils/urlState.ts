export type UrlFilterState = Record<string, string[]>

export const normalizeUrlFilters = (filters?: UrlFilterState | null): UrlFilterState => {
  if (!filters) return {}

  return Object.keys(filters)
    .sort()
    .reduce<UrlFilterState>((acc, key) => {
      const values = Array.from(new Set((filters[key] || []).map((value) => String(value)).filter(Boolean))).sort()
      if (values.length) acc[key] = values
      return acc
    }, {})
}

export const stringifyUrlFiltersParam = (filters?: UrlFilterState | null) => {
  const normalized = normalizeUrlFilters(filters)
  if (Object.keys(normalized).length === 0) return ''
  return JSON.stringify(normalized)
}

export const parseUrlFiltersParam = (value?: string | null): UrlFilterState => {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return normalizeUrlFilters(
      Object.entries(parsed).reduce<UrlFilterState>((acc, [key, rawValues]) => {
        if (Array.isArray(rawValues)) {
          const values = rawValues.map((item) => String(item)).filter(Boolean)
          if (values.length) acc[key] = values
        }
        return acc
      }, {})
    )
  } catch {
    return {}
  }
}

export const urlFiltersEqual = (a?: UrlFilterState | null, b?: UrlFilterState | null) =>
  stringifyUrlFiltersParam(a) === stringifyUrlFiltersParam(b)

export const formatUrlDate = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const parseUrlDate = (value?: string | null): Date | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

export const sameUrlDate = (date: Date | string, value?: string | null) =>
  Boolean(value && formatUrlDate(date) === value)

export const readNumberParam = (
  searchParams: URLSearchParams,
  key: string,
  fallback: number,
  options?: { min?: number; max?: number }
) => {
  const raw = searchParams.get(key)
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isInteger(value)) return fallback
  if (options?.min !== undefined && value < options.min) return fallback
  if (options?.max !== undefined && value > options.max) return fallback
  return value
}

export const setSearchParam = (
  params: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
  defaultValue?: string | number
) => {
  const text = value === null || value === undefined ? '' : String(value)
  const defaultText = defaultValue === null || defaultValue === undefined ? undefined : String(defaultValue)

  if (!text || text === defaultText) {
    params.delete(key)
    return
  }

  params.set(key, text)
}
