import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'
import { useTimezone } from './TimezoneContext'
import {
  dateOnlyToLocalDate,
  formatDateOnlyFromDate,
  todayDateOnlyInTimezone
} from '@/utils/timezone'

type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last7days'
  | 'thisMonth'
  | 'last30days'
  | 'last90days'
  | 'last12months'
  | 'all'
  | 'custom'

interface DateRange {
  start: Date
  end: Date
  preset: DatePreset
}

interface DateRangeContextType {
  dateRange: DateRange
  setDateRange: (range: DateRange) => void
  setPeriod: (start: Date, end: Date) => void
  setPreset: (preset: DatePreset) => void
}

const DateRangeContext = createContext<DateRangeContextType | undefined>(undefined)

const getPresetDates = (preset: DatePreset, timezone: string): { start: Date; end: Date } => {
  const todayDateOnly = todayDateOnlyInTimezone(timezone)
  const today = dateOnlyToLocalDate(todayDateOnly) || new Date()

  switch (preset) {
    case 'today':
      return { start: today, end: today }

    case 'yesterday': {
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      return { start: yesterday, end: yesterday }
    }

    case 'last7days': {
      const start = new Date(today)
      start.setDate(start.getDate() - 6)
      return { start, end: today }
    }

    case 'thisMonth': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      return { start, end: today }
    }

    case 'last30days': {
      const start = new Date(today)
      start.setDate(start.getDate() - 29)
      return { start, end: today }
    }

    case 'last90days': {
      const start = new Date(today)
      start.setDate(start.getDate() - 89)
      return { start, end: today }
    }

    case 'last12months': {
      const start = new Date(today.getFullYear(), today.getMonth() - 11, 1)
      return { start, end: today }
    }

    case 'all': {
      const start = new Date(2020, 0, 1) // Start from 2020 for "all" data
      return { start, end: today }
    }

    default:
      return { start: today, end: today }
  }
}

// Versión del formato de sessionStorage - incrementar si cambia el formato
const STORAGE_VERSION = 3

const normalizeStoredRangeDate = (value: Date | string): Date => {
  if (value instanceof Date) return value
  return dateOnlyToLocalDate(value) || new Date(value)
}

export const DateRangeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { timezone } = useTimezone()

  // Intentar cargar desde sessionStorage, si no existe usar "Este mes" como default
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const saved = sessionStorage.getItem('dateRange')
    const version = sessionStorage.getItem('dateRangeVersion')

    // Si la versión no coincide, limpiar datos viejos
    if (version !== String(STORAGE_VERSION)) {
      sessionStorage.removeItem('dateRange')
      sessionStorage.setItem('dateRangeVersion', String(STORAGE_VERSION))
      const { start, end } = getPresetDates('thisMonth', timezone)
      return { start, end, preset: 'thisMonth' }
    }

    if (saved) {
      try {
        const parsed = JSON.parse(saved)

        const parseLocalDate = (dateStr: string | undefined | null): Date | null => {
          if (!dateStr) return null
          return dateOnlyToLocalDate(dateStr)
        }

        const start = parseLocalDate(parsed.start)
        const end = parseLocalDate(parsed.end)

        // Si las fechas no son válidas, usar default
        if (!start || !end) {
          const defaultDates = getPresetDates('thisMonth', timezone)
          return { start: defaultDates.start, end: defaultDates.end, preset: 'thisMonth' }
        }

        return {
          start,
          end,
          preset: parsed.preset
        }
      } catch (e) {
        // Si hay error parseando, usar default
      }
    }

    // Default: "Este mes"
    const { start, end } = getPresetDates('thisMonth', timezone)
    return { start, end, preset: 'thisMonth' }
  })

  useEffect(() => {
    setDateRange(current => {
      if (current.preset === 'custom') return current

      const { start, end } = getPresetDates(current.preset, timezone)
      if (
        formatDateOnlyFromDate(current.start) === formatDateOnlyFromDate(start) &&
        formatDateOnlyFromDate(current.end) === formatDateOnlyFromDate(end)
      ) {
        return current
      }

      return { ...current, start, end }
    })
  }, [timezone])

  // Save to sessionStorage whenever dateRange changes
  useEffect(() => {
    // Ensure dates are Date objects before saving
    const start = normalizeStoredRangeDate(dateRange.start)
    const end = normalizeStoredRangeDate(dateRange.end)

    // Validar que las fechas sean válidas
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return // No guardar fechas inválidas
    }

    sessionStorage.setItem('dateRange', JSON.stringify({
      start: formatDateOnlyFromDate(start),
      end: formatDateOnlyFromDate(end),
      preset: dateRange.preset
    }))
    sessionStorage.setItem('dateRangeVersion', String(STORAGE_VERSION))
  }, [dateRange])

  const setPeriod = useCallback((start: Date, end: Date) => {
    setDateRange({ start, end, preset: 'custom' })
  }, [])

  const setPreset = useCallback((preset: DatePreset) => {
    const { start, end } = getPresetDates(preset, timezone)
    setDateRange({ start, end, preset })
  }, [timezone])

  return (
    <DateRangeContext.Provider
      value={{
        dateRange,
        setDateRange,
        setPeriod,
        setPreset
      }}
    >
      {children}
    </DateRangeContext.Provider>
  )
}

export const useDateRange = () => {
  const context = useContext(DateRangeContext)
  if (context === undefined) {
    throw new Error('useDateRange must be used within a DateRangeProvider')
  }
  return context
}
