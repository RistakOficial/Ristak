import { useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  formatUrlDate,
  parseUrlDate,
  parseUrlFiltersParam,
  sameUrlDate,
  setSearchParam,
  stringifyUrlFiltersParam,
  type UrlFilterState
} from '@/utils/urlState'

export const useUrlFilterState = (paramName = 'filters') => {
  const [searchParams, setSearchParams] = useSearchParams()

  const filters = useMemo(
    () => parseUrlFiltersParam(searchParams.get(paramName)),
    [paramName, searchParams]
  )

  const setFilters = useCallback((nextFilters: UrlFilterState) => {
    const nextParams = new URLSearchParams(searchParams)
    const encoded = stringifyUrlFiltersParam(nextFilters)

    if (encoded) {
      nextParams.set(paramName, encoded)
    } else {
      nextParams.delete(paramName)
    }

    setSearchParams(nextParams, { replace: true })
  }, [paramName, searchParams, setSearchParams])

  return [filters, setFilters] as const
}

export const useUrlStringState = <T extends string>(
  paramName: string,
  defaultValue: T,
  isValid: (value?: string | null) => value is T,
  options?: { omitDefault?: boolean; replace?: boolean }
) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const omitDefault = options?.omitDefault ?? true
  const replace = options?.replace ?? true

  const value = useMemo(() => {
    const raw = searchParams.get(paramName)
    return isValid(raw) ? raw : defaultValue
  }, [defaultValue, isValid, paramName, searchParams])

  useEffect(() => {
    const raw = searchParams.get(paramName)
    if (!raw || isValid(raw)) return

    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete(paramName)
    setSearchParams(nextParams, { replace: true })
  }, [isValid, paramName, searchParams, setSearchParams])

  const setValue = useCallback((nextValue: T) => {
    const nextParams = new URLSearchParams(searchParams)
    setSearchParam(nextParams, paramName, nextValue, omitDefault ? defaultValue : undefined)
    setSearchParams(nextParams, { replace })
  }, [defaultValue, omitDefault, paramName, replace, searchParams, setSearchParams])

  return [value, setValue] as const
}

export const useUrlDateRangeSync = ({
  dateRange,
  setDateRange,
  enabled = true,
  fromParam = 'from',
  toParam = 'to',
  replace = true
}: {
  dateRange: { start: Date | string; end: Date | string }
  setDateRange: (range: { start: Date; end: Date; preset: 'custom' }) => void
  enabled?: boolean
  fromParam?: string
  toParam?: string
  replace?: boolean
}) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const routeStart = searchParams.get(fromParam)
  const routeEnd = searchParams.get(toParam)

  useEffect(() => {
    if (!enabled) return

    const start = parseUrlDate(routeStart)
    const end = parseUrlDate(routeEnd)

    if (!start || !end) return
    if (sameUrlDate(dateRange.start, routeStart) && sameUrlDate(dateRange.end, routeEnd)) return

    setDateRange({ start, end, preset: 'custom' })
  }, [dateRange.end, dateRange.start, enabled, routeEnd, routeStart, setDateRange])

  useEffect(() => {
    if (!enabled) return

    const urlStart = parseUrlDate(routeStart)
    const urlEnd = parseUrlDate(routeEnd)

    if (
      urlStart &&
      urlEnd &&
      (!sameUrlDate(dateRange.start, routeStart) || !sameUrlDate(dateRange.end, routeEnd))
    ) {
      return
    }

    const nextStart = formatUrlDate(dateRange.start)
    const nextEnd = formatUrlDate(dateRange.end)
    if (!nextStart || !nextEnd) return
    if (routeStart === nextStart && routeEnd === nextEnd) return

    const nextParams = new URLSearchParams(searchParams)
    nextParams.set(fromParam, nextStart)
    nextParams.set(toParam, nextEnd)
    setSearchParams(nextParams, { replace })
  }, [
    dateRange.end,
    dateRange.start,
    enabled,
    fromParam,
    replace,
    routeEnd,
    routeStart,
    searchParams,
    setSearchParams,
    toParam
  ])
}
