import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

export type DatePreset =
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

const getPresetDates = (preset: DatePreset): { start: Date; end: Date } => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

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
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
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
      const start = new Date(today)
      start.setMonth(start.getMonth() - 11)
      start.setDate(1)
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
const STORAGE_VERSION = 2

export const DateRangeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Intentar cargar desde sessionStorage, si no existe usar "Este mes" como default
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const saved = sessionStorage.getItem('dateRange')
    const version = sessionStorage.getItem('dateRangeVersion')

    // Si la versión no coincide, limpiar datos viejos
    if (version !== String(STORAGE_VERSION)) {
      sessionStorage.removeItem('dateRange')
      sessionStorage.setItem('dateRangeVersion', String(STORAGE_VERSION))
      const { start, end } = getPresetDates('thisMonth')
      return { start, end, preset: 'thisMonth' }
    }

    if (saved) {
      try {
        const parsed = JSON.parse(saved)

        // Parsear fechas YYYY-MM-DD como fecha LOCAL, no UTC
        // new Date("2025-10-05") lo parsea como UTC, causando problemas de zona horaria
        const parseLocalDate = (dateStr: string | undefined | null): Date | null => {
          if (!dateStr) return null
          try {
            const [year, month, day] = dateStr.split('-').map(Number)
            if (isNaN(year) || isNaN(month) || isNaN(day)) return null
            return new Date(year, month - 1, day, 0, 0, 0, 0)
          } catch {
            return null
          }
        }

        const start = parseLocalDate(parsed.start)
        const end = parseLocalDate(parsed.end)

        // Si las fechas no son válidas, usar default
        if (!start || !end) {
          const defaultDates = getPresetDates('thisMonth')
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
    const { start, end } = getPresetDates('thisMonth')
    return { start, end, preset: 'thisMonth' }
  })

  // Save to sessionStorage whenever dateRange changes
  useEffect(() => {
    // Ensure dates are Date objects before saving
    const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
    const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)

    // Validar que las fechas sean válidas
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return // No guardar fechas inválidas
    }

    // Guardar fechas en formato YYYY-MM-DD LOCAL (sin hora, sin UTC)
    // para evitar problemas de zona horaria al cargar
    const formatLocalDate = (date: Date) => {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }

    sessionStorage.setItem('dateRange', JSON.stringify({
      start: formatLocalDate(start),
      end: formatLocalDate(end),
      preset: dateRange.preset
    }))
    sessionStorage.setItem('dateRangeVersion', String(STORAGE_VERSION))
  }, [dateRange])

  const setPeriod = useCallback((start: Date, end: Date) => {
    setDateRange({ start, end, preset: 'custom' })
  }, [])

  const setPreset = useCallback((preset: DatePreset) => {
    const { start, end } = getPresetDates(preset)
    setDateRange({ start, end, preset })
  }, [])

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
