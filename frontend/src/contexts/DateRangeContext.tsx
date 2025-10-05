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

export const DateRangeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Intentar cargar desde sessionStorage, si no existe usar "Este mes" como default
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const saved = sessionStorage.getItem('dateRange')

    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return {
          start: new Date(parsed.start),
          end: new Date(parsed.end),
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

    sessionStorage.setItem('dateRange', JSON.stringify({
      start: start.toISOString(),
      end: end.toISOString(),
      preset: dateRange.preset
    }))
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
