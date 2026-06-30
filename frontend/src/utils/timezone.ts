/**
 * Utilidades para manejo de zonas horarias (frontend)
 *
 * Modelo:
 * - La BD guarda SIEMPRE en UTC.
 * - Al mostrar, convertimos de UTC a la zona horaria de la cuenta (la del usuario).
 * - Usamos Intl.DateTimeFormat (formatToParts), que es la forma robusta y consistente
 *   con la del calendario, en lugar de parsear strings de toLocaleString.
 */

/**
 * Extrae los componentes (año, mes, ...) de una fecha en una zona horaria dada.
 */
export const DEFAULT_TIMEZONE = 'America/Mexico_City'

function getZonedParts(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  const parts = formatter.formatToParts(date)
  const result: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') {
      // 'hour' puede venir como "24" a medianoche en algunos motores; normalizar
      const value = part.type === 'hour' && part.value === '24' ? 0 : Number(part.value)
      result[part.type] = value
    }
  }
  return result
}

/**
 * Offset (zona - UTC) en milisegundos para un instante dado.
 */
function getZoneOffsetMs(timeZone: string, atDate: Date): number {
  const parts = getZonedParts(atDate, timeZone)
  const zoneWallAsUtc = Date.UTC(
    parts.year,
    (parts.month ?? 1) - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  )
  return zoneWallAsUtc - atDate.getTime()
}

const padDateTimePart = (value: number): string => String(value).padStart(2, '0')

/**
 * Asegura que una fecha quede como ISO string en UTC ("...Z").
 * Si la cadena NO trae zona, se interpreta como UTC (así viene de la BD).
 */
export function ensureUTC(date: string | Date): string {
  if (date instanceof Date) return date.toISOString()

  const str = String(date).trim()
  if (!str) return new Date(NaN).toISOString()

  // Ya trae zona explícita (Z, ±HH, ±HHMM o ±HH:MM)
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(str)) {
    const parsed = new Date(str)
    return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString()
  }

  // Naive → interpretar como UTC
  const iso = (str.includes('T') ? str : str.replace(' ', 'T')) + 'Z'
  const parsed = new Date(iso)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()

  const fallback = new Date(str)
  return Number.isNaN(fallback.getTime()) ? str : fallback.toISOString()
}

/**
 * Convierte una fecha UTC a un Date cuyos getters LOCALES reflejan la hora de
 * pared en la zona del usuario. Útil para leer getHours()/getDate() en esa zona.
 * @param utcDate Fecha en UTC
 * @param userTimezone Zona horaria del usuario (IANA)
 */
export function convertUTCToLocal(utcDate: string | Date, userTimezone: string): Date {
  const date = utcDate instanceof Date ? utcDate : new Date(ensureUTC(utcDate))
  if (Number.isNaN(date.getTime())) return date

  const parts = getZonedParts(date, userTimezone)
  return new Date(
    parts.year,
    (parts.month ?? 1) - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  )
}

/**
 * Convierte una hora de pared local (interpretada en `timezone`) a UTC.
 * @param localDate Fecha cuyos componentes locales representan la hora de pared
 * @param timezone Zona horaria en la que se interpretan esos componentes (IANA)
 */
export function convertLocalToUTC(localDate: string | Date, timezone: string): Date {
  const date = localDate instanceof Date ? localDate : new Date(localDate)
  if (Number.isNaN(date.getTime())) return date

  const asUtc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  )

  // El offset se evalúa en el instante aproximado para respetar DST.
  const offsetMs = getZoneOffsetMs(timezone, new Date(asUtc))
  return new Date(asUtc - offsetMs)
}

export function toDateTimeLocalInputValue(utcDate: string | Date, timezone: string): string {
  const local = convertUTCToLocal(utcDate, timezone)
  if (Number.isNaN(local.getTime())) return ''

  return [
    local.getFullYear(),
    padDateTimePart(local.getMonth() + 1),
    padDateTimePart(local.getDate())
  ].join('-') + `T${padDateTimePart(local.getHours())}:${padDateTimePart(local.getMinutes())}`
}

export function localDateTimeInputToUTCISOString(value: string, timezone: string): string | undefined {
  const clean = String(value || '').trim()
  if (!clean) return undefined

  const utc = convertLocalToUTC(clean, timezone)
  return Number.isNaN(utc.getTime()) ? undefined : utc.toISOString()
}

export function todayDateOnlyInTimezone(timezone: string, referenceDate: string | Date = new Date()): string {
  const local = convertUTCToLocal(referenceDate, timezone)
  if (Number.isNaN(local.getTime())) return ''
  return [
    local.getFullYear(),
    padDateTimePart(local.getMonth() + 1),
    padDateTimePart(local.getDate())
  ].join('-')
}

/**
 * Formatea una fecha UTC para mostrarla en la zona horaria del usuario.
 * @param utcDate Fecha en UTC
 * @param timezone Zona horaria del usuario
 * @param options Opciones de formato
 */
export function formatInTimezone(
  utcDate: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = utcDate instanceof Date ? utcDate : new Date(ensureUTC(utcDate))

  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...options
  }

  return new Intl.DateTimeFormat('es-MX', defaultOptions).format(date)
}
