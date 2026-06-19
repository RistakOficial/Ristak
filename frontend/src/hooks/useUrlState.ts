import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  formatUrlDate,
  parseUrlDate,
  parseUrlFiltersParam,
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
  const routeRangeKey = routeStart && routeEnd ? `${routeStart}|${routeEnd}` : ''
  const dateRangeKey = useMemo(() => {
    const start = formatUrlDate(dateRange.start)
    const end = formatUrlDate(dateRange.end)
    return start && end ? `${start}|${end}` : ''
  }, [dateRange.end, dateRange.start])
  const latestDateRangeKeyRef = useRef(dateRangeKey)
  const pendingRouteRangeRef = useRef<string | null>(null)

  useEffect(() => {
    latestDateRangeKeyRef.current = dateRangeKey
  }, [dateRangeKey])

  useEffect(() => {
    if (!enabled) {
      pendingRouteRangeRef.current = null
      return
    }

    const start = parseUrlDate(routeStart)
    const end = parseUrlDate(routeEnd)

    if (!start || !end) {
      pendingRouteRangeRef.current = null
      return
    }
    if (routeRangeKey === latestDateRangeKeyRef.current) {
      pendingRouteRangeRef.current = null
      return
    }

    pendingRouteRangeRef.current = routeRangeKey
    setDateRange({ start, end, preset: 'custom' })
  }, [enabled, routeEnd, routeRangeKey, routeStart, setDateRange])

  useEffect(() => {
    if (!enabled) return
    if (!dateRangeKey) return

    // Let a newly visited URL hydrate state once, then allow user changes to win.
    if (pendingRouteRangeRef.current) {
      if (pendingRouteRangeRef.current !== dateRangeKey) return
      pendingRouteRangeRef.current = null
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
