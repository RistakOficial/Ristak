import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'
import { DEFAULT_TIMEZONE, convertUTCToLocal, convertLocalToUTC, formatInTimezone, ensureUTC } from '@/utils/timezone'

// Nombres de meses en español (formato corto)
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic']

interface TimezoneContextType {
  timezone: string
  setTimezone: (tz: string) => void
  updateTimezone: (tz: string | null) => Promise<string>
  convertToLocalTime: (utcDate: string | Date) => Date
  convertToUTC: (localDate: string | Date) => Date
  formatLocalDate: (utcDate: string | Date) => string
  formatLocalDateShort: (utcDate: string | Date) => string
  formatLocalDateTime: (utcDate: string | Date) => string
}

const TimezoneContext = createContext<TimezoneContextType | undefined>(undefined)

export const useTimezone = () => {
  const context = useContext(TimezoneContext)
  if (!context) {
    throw new Error('useTimezone must be used within TimezoneProvider')
  }
  return context
}

export const TimezoneProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Default to México City timezone
  const [timezone, setTimezone] = useState<string>(() => {
    const saved = localStorage.getItem('userTimezone')
    return saved || DEFAULT_TIMEZONE
  })

  // Fetch timezone from GHL config on mount
  useEffect(() => {
    const fetchTimezoneFromGHL = async () => {
      try {
        const response = await fetch(apiUrl('/api/settings/timezone'))
        const data = await response.json()

        if (data.success && data.timezone) {
          setTimezone(data.timezone)
          localStorage.setItem('userTimezone', data.timezone)
        }
      } catch (error) {
        // Keep default or saved timezone
      }
    }

    fetchTimezoneFromGHL()
  }, [])

  useEffect(() => {
    localStorage.setItem('userTimezone', timezone)
  }, [timezone])

  // Persiste la zona horaria elegida en Ristak (fuente de verdad sobre HighLevel).
  // Pasar null limpia el override y vuelve a usar HighLevel/default.
  const updateTimezone = async (tz: string | null): Promise<string> => {
    const response = await fetch(apiUrl('/api/settings/timezone'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: tz })
    })

    const data = await response.json()
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'No se pudo guardar la zona horaria')
    }

    const resolved = data.timezone || DEFAULT_TIMEZONE
    setTimezone(resolved)
    localStorage.setItem('userTimezone', resolved)
    return resolved
  }

  // Convierte una fecha UTC a la hora local del usuario
  const convertToLocalTime = (utcDate: string | Date): Date => {
    const normalized = new Date(ensureUTC(utcDate))
    return convertUTCToLocal(normalized, timezone)
  }

  // Convierte una fecha local a UTC
  const convertToUTC = (localDate: string | Date): Date => {
    return convertLocalToUTC(localDate, timezone)
  }

  // Formatea una fecha UTC para mostrarla en la zona horaria local
  const formatLocalDate = (utcDate: string | Date): string => {
    const normalized = ensureUTC(utcDate)

    try {
      return formatInTimezone(new Date(normalized), timezone)
    } catch (error) {
      const date = typeof normalized === 'string' ? new Date(normalized) : normalized
      return date.toLocaleString('es-MX')
    }
  }

  // Formatea una fecha UTC en formato corto: "16 oct 2025" (SIN hora, SIEMPRE con año)
  const formatLocalDateShort = (utcDate: string | Date): string => {
    if (!utcDate) return '—'

    try {
      const date = convertToLocalTime(utcDate)
      const day = date.getDate()
      const month = MONTHS_SHORT[date.getMonth()]
      const year = date.getFullYear()

      // Siempre mostrar año
      return `${day} ${month} ${year}`
    } catch (error) {
      return '—'
    }
  }

  // Formatea una fecha UTC con hora: "16 oct 2025, 11:02 PM" (SIEMPRE con año)
  const formatLocalDateTime = (utcDate: string | Date): string => {
    if (!utcDate) return '—'

    try {
      const date = convertToLocalTime(utcDate)
      const day = date.getDate()
      const month = MONTHS_SHORT[date.getMonth()]
      const year = date.getFullYear()
      const hours = date.getHours()
      const minutes = date.getMinutes().toString().padStart(2, '0')
      const ampm = hours >= 12 ? 'PM' : 'AM'
      const hours12 = hours % 12 || 12

      // Siempre mostrar año
      return `${day} ${month} ${year}, ${hours12}:${minutes} ${ampm}`
    } catch (error) {
      return '—'
    }
  }

  return (
    <TimezoneContext.Provider value={{
      timezone,
      setTimezone,
      updateTimezone,
      convertToLocalTime,
      convertToUTC,
      formatLocalDate,
      formatLocalDateShort,
      formatLocalDateTime
    }}>
      {children}
    </TimezoneContext.Provider>
  )
}
