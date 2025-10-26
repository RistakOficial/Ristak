import { useState, useEffect } from 'react'
import { campaignsService } from '@/services/campaignsService'
import { useTimezone } from '@/contexts/TimezoneContext'

interface MetaTimezoneInfo {
  metaTimezoneName: string | null
  metaTimezoneOffset: number | null
  highLevelTimezoneName: string
  highLevelTimezoneOffset: number | null
  hasDiscrepancy: boolean
  discrepancyHours: number
  isLoading: boolean
  adjustMetaDateToLocal: (metaDate: string) => string
}

/**
 * Hook para detectar discrepancias entre el timezone de Meta Ads y HighLevel
 *
 * @returns Información sobre los timezones y si hay discrepancia
 */
export function useMetaTimezone(): MetaTimezoneInfo {
  const { timezone } = useTimezone()
  const [metaTimezoneName, setMetaTimezoneName] = useState<string | null>(null)
  const [metaTimezoneOffset, setMetaTimezoneOffset] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchMetaTimezone = async () => {
      try {
        const response = await campaignsService.getMetaConfig()

        if (response.configured && response.config) {
          setMetaTimezoneName(response.config.timezoneName)
          setMetaTimezoneOffset(response.config.timezoneOffsetHoursUtc)
        }
      } catch (error) {
        // Silently fail, no timezone info available
      } finally {
        setIsLoading(false)
      }
    }

    fetchMetaTimezone()
  }, [])

  // Calcular offset de HighLevel usando Intl API
  const getHighLevelTimezoneOffset = (tz: string): number => {
    try {
      const now = new Date()
      const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
      const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }))
      const offsetMs = tzDate.getTime() - utcDate.getTime() // tzDate - utcDate para signo correcto
      return offsetMs / (1000 * 60 * 60) // Convertir a horas
    } catch {
      return 0
    }
  }

  const highLevelTimezoneOffset = getHighLevelTimezoneOffset(timezone)

  // Detectar discrepancia
  const hasDiscrepancy = metaTimezoneOffset !== null &&
                        Math.abs(metaTimezoneOffset - highLevelTimezoneOffset) > 0.5 // Tolerancia de 30 minutos

  const discrepancyHours = metaTimezoneOffset !== null
    ? Math.abs(metaTimezoneOffset - highLevelTimezoneOffset)
    : 0

  /**
   * Convierte una fecha de Meta al timezone local de HighLevel
   * @param metaDate Fecha en formato YYYY-MM-DD desde Meta (en su timezone)
   * @returns Fecha ajustada visualmente con indicador de timezone si hay discrepancia
   */
  const adjustMetaDateToLocal = (metaDate: string): string => {
    // Si no hay fecha, devolver tal cual
    if (!metaDate) {
      return metaDate
    }

    // Si no hay información de timezone o no hay discrepancia significativa, devolver tal cual
    if (!hasDiscrepancy || metaTimezoneOffset === null || discrepancyHours < 0.5) {
      return metaDate
    }

    // Obtener el nombre corto del timezone de Meta (ej: "LA", "NYC", "CHI")
    const getTimezoneAbbr = (tzName: string | null): string => {
      if (!tzName) return 'UTC'

      const abbreviations: Record<string, string> = {
        'America/Los_Angeles': 'LA',
        'America/New_York': 'NY',
        'America/Chicago': 'CHI',
        'America/Mexico_City': 'CDMX',
        'America/Denver': 'DEN',
        'America/Phoenix': 'PHX',
        'America/Toronto': 'TOR',
        'Europe/London': 'LON',
        'Europe/Paris': 'PAR',
        'Europe/Madrid': 'MAD'
      }

      return abbreviations[tzName] || tzName.split('/').pop() || 'UTC'
    }

    const metaTzAbbr = getTimezoneAbbr(metaTimezoneName)

    // Agregar indicador de timezone solo si hay discrepancia significativa
    return `${metaDate} (${metaTzAbbr})`
  }

  return {
    metaTimezoneName,
    metaTimezoneOffset,
    highLevelTimezoneName: timezone,
    highLevelTimezoneOffset,
    hasDiscrepancy,
    discrepancyHours,
    isLoading,
    adjustMetaDateToLocal
  }
}
