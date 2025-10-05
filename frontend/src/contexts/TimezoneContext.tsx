import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { convertUTCToLocal, convertLocalToUTC, formatInTimezone, ensureUTC } from '@/utils/timezone'

interface TimezoneContextType {
  timezone: string
  setTimezone: (tz: string) => void
  convertToLocalTime: (utcDate: string | Date) => Date
  convertToUTC: (localDate: string | Date) => Date
  formatLocalDate: (utcDate: string | Date) => string
}

const TimezoneContext = createContext<TimezoneContextType | undefined>(undefined)

export const useTimezone = () => {
  const context = useContext(TimezoneContext)
  if (!context) {
    throw new Error('useTimezone must be used within TimezoneProvider')
  }
  return context
}

// Lista de zonas horarias comunes
export const TIMEZONES = [
  { value: 'America/Mexico_City', label: 'Ciudad de México (GMT-6)' },
  { value: 'America/Tijuana', label: 'Tijuana (GMT-8)' },
  { value: 'America/Cancun', label: 'Cancún (GMT-5)' },
  { value: 'America/New_York', label: 'Nueva York (GMT-5)' },
  { value: 'America/Los_Angeles', label: 'Los Ángeles (GMT-8)' },
  { value: 'America/Chicago', label: 'Chicago (GMT-6)' },
  { value: 'Europe/London', label: 'Londres (GMT+0)' },
  { value: 'Europe/Paris', label: 'París (GMT+1)' },
  { value: 'Europe/Madrid', label: 'Madrid (GMT+1)' },
  { value: 'Asia/Tokyo', label: 'Tokio (GMT+9)' },
  { value: 'UTC', label: 'UTC (GMT+0)' }
]

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

export const TimezoneProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Default to Mexico City timezone
  const [timezone, setTimezone] = useState<string>(() => {
    const saved = localStorage.getItem('userTimezone')
    return saved || 'America/Mexico_City'
  })

  // Fetch timezone from GHL config on mount
  useEffect(() => {
    const fetchTimezoneFromGHL = async () => {
      try {
        const endpoint = API_BASE_URL ? `${API_BASE_URL}/api/settings/timezone` : '/api/settings/timezone'
        const response = await fetch(endpoint)
        const data = await response.json()

        if (data.success && data.timezone) {
          setTimezone(data.timezone)
          localStorage.setItem('userTimezone', data.timezone)
        }
      } catch (error) {
        console.error('Error fetching timezone from GHL:', error)
        // Keep default or saved timezone
      }
    }

    fetchTimezoneFromGHL()
  }, [])

  useEffect(() => {
    localStorage.setItem('userTimezone', timezone)
  }, [timezone])

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

  return (
    <TimezoneContext.Provider value={{
      timezone,
      setTimezone,
      convertToLocalTime,
      convertToUTC,
      formatLocalDate
    }}>
      {children}
    </TimezoneContext.Provider>
  )
}
