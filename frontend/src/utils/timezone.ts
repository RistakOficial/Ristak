/**
 * Utilidades para manejo de zonas horarias
 *
 * IMPORTANTE:
 * - Todo se guarda en UTC en la base de datos
 * - Las campañas de Meta vienen en la zona horaria de la cuenta publicitaria
 * - Necesitamos normalizar todo a UTC antes de guardar
 * - Al mostrar, convertimos de UTC a la zona horaria del usuario
 */

// Mapa de zonas horarias de Meta Ads a zonas horarias IANA
const META_TIMEZONE_MAP: Record<number, string> = {
  // América
  1: 'America/Los_Angeles',      // Pacific Time
  2: 'America/Denver',           // Mountain Time
  3: 'America/Chicago',          // Central Time
  4: 'America/New_York',         // Eastern Time
  5: 'America/Anchorage',        // Alaska
  6: 'Pacific/Honolulu',         // Hawaii
  47: 'America/Mexico_City',     // Ciudad de México
  48: 'America/Cancun',          // Cancún
  49: 'America/Tijuana',         // Tijuana
  50: 'America/Argentina/Buenos_Aires', // Buenos Aires
  51: 'America/Sao_Paulo',       // São Paulo
  52: 'America/Santiago',        // Santiago
  53: 'America/Bogota',          // Bogotá
  54: 'America/Lima',            // Lima

  // Europa
  7: 'Europe/London',            // Londres
  8: 'Europe/Paris',             // París/Madrid
  9: 'Europe/Berlin',            // Berlín
  10: 'Europe/Rome',             // Roma
  11: 'Europe/Moscow',           // Moscú

  // Asia
  12: 'Asia/Tokyo',              // Tokio
  13: 'Asia/Shanghai',           // China
  14: 'Asia/Hong_Kong',          // Hong Kong
  15: 'Asia/Singapore',          // Singapur
  16: 'Asia/Dubai',              // Dubai
  17: 'Asia/Tel_Aviv',           // Tel Aviv
  18: 'Asia/Seoul',              // Seúl
  19: 'Asia/Kolkata',            // India

  // Oceanía
  20: 'Australia/Sydney',        // Sydney
  21: 'Australia/Melbourne',     // Melbourne
  22: 'Pacific/Auckland',        // Auckland
}

/**
 * Convierte una fecha de la zona horaria de Meta a UTC
 * @param date Fecha en string o Date
 * @param metaTimezoneId ID de zona horaria de Meta (del Ad Account)
 * @returns Fecha en UTC
 */
export function convertMetaDateToUTC(date: string | Date, metaTimezoneId: number): Date {
  const timezone = META_TIMEZONE_MAP[metaTimezoneId] || 'UTC'
  const dateObj = typeof date === 'string' ? new Date(date) : date

  // Usar Intl.DateTimeFormat para obtener el offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  // Obtener las partes de la fecha en la zona horaria específica
  const parts = formatter.formatToParts(dateObj)
  const dateParts: any = {}
  parts.forEach(part => {
    dateParts[part.type] = part.value
  })

  // Crear fecha en la zona horaria local
  const localDate = new Date(
    `${dateParts.year}-${dateParts.month}-${dateParts.day}T${dateParts.hour}:${dateParts.minute}:${dateParts.second}`
  )

  // Calcular el offset en minutos
  const tzOffset = getTimezoneOffset(timezone, dateObj)

  // Convertir a UTC sumando el offset
  const utcTime = localDate.getTime() + (tzOffset * 60 * 1000)

  return new Date(utcTime)
}

/**
 * Obtiene el offset de una zona horaria en minutos
 */
function getTimezoneOffset(timezone: string, date: Date): number {
  // Crear dos fechas: una en UTC y otra en la zona horaria específica
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }))

  // La diferencia es el offset
  return (utcDate.getTime() - tzDate.getTime()) / 60000
}

/**
 * Convierte una fecha UTC a la zona horaria local del usuario
 * @param utcDate Fecha en UTC
 * @param userTimezone Zona horaria del usuario (IANA format)
 * @returns Fecha en la zona horaria del usuario
 */
export function convertUTCToLocal(utcDate: string | Date, userTimezone: string): Date {
  const date = typeof utcDate === 'string' ? new Date(utcDate + 'Z') : utcDate

  // Formatear en la zona horaria del usuario
  const localString = date.toLocaleString('en-US', { timeZone: userTimezone })

  return new Date(localString)
}

/**
 * Convierte una fecha local a UTC
 * @param localDate Fecha en zona horaria local
 * @param timezone Zona horaria (IANA format)
 * @returns Fecha en UTC
 */
export function convertLocalToUTC(localDate: string | Date, timezone: string): Date {
  const date = typeof localDate === 'string' ? new Date(localDate) : localDate

  // Obtener el offset de la zona horaria
  const offset = getTimezoneOffset(timezone, date)

  // Convertir a UTC restando el offset
  const utcTime = date.getTime() - (offset * 60 * 1000)

  return new Date(utcTime)
}

/**
 * Formatea una fecha UTC para mostrarla en la zona horaria del usuario
 * @param utcDate Fecha en UTC
 * @param timezone Zona horaria del usuario
 * @param format Formato deseado
 */
export function formatInTimezone(
  utcDate: string | Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = typeof utcDate === 'string' ? new Date(utcDate + 'Z') : utcDate

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

/**
 * Obtiene la zona horaria actual del navegador
 */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Valida si una fecha está en UTC
 */
export function isUTC(date: string): boolean {
  return date.endsWith('Z') || date.includes('+00:00')
}

/**
 * Asegura que una fecha esté en formato UTC
 */
export function ensureUTC(date: string | Date): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toISOString()
}

/**
 * Calcula la diferencia de horas entre dos zonas horarias
 */
export function getTimezoneOffsetDifference(tz1: string, tz2: string, date = new Date()): number {
  const offset1 = getTimezoneOffset(tz1, date)
  const offset2 = getTimezoneOffset(tz2, date)
  return (offset1 - offset2) / 60 // Retorna en horas
}

/**
 * Lista de zonas horarias comunes para México y LATAM
 */
export const COMMON_TIMEZONES = [
  // México
  { value: 'America/Mexico_City', label: 'Ciudad de México (GMT-6)', metaId: 47 },
  { value: 'America/Tijuana', label: 'Tijuana (GMT-8)', metaId: 49 },
  { value: 'America/Cancun', label: 'Cancún (GMT-5)', metaId: 48 },

  // LATAM
  { value: 'America/Bogota', label: 'Bogotá (GMT-5)', metaId: 53 },
  { value: 'America/Lima', label: 'Lima (GMT-5)', metaId: 54 },
  { value: 'America/Santiago', label: 'Santiago (GMT-3)', metaId: 52 },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires (GMT-3)', metaId: 50 },
  { value: 'America/Sao_Paulo', label: 'São Paulo (GMT-3)', metaId: 51 },

  // USA
  { value: 'America/New_York', label: 'Nueva York (GMT-5)', metaId: 4 },
  { value: 'America/Los_Angeles', label: 'Los Ángeles (GMT-8)', metaId: 1 },
  { value: 'America/Chicago', label: 'Chicago (GMT-6)', metaId: 3 },

  // Europa
  { value: 'Europe/Madrid', label: 'Madrid (GMT+1)', metaId: 8 },
  { value: 'Europe/London', label: 'Londres (GMT+0)', metaId: 7 },

  // UTC
  { value: 'UTC', label: 'UTC (GMT+0)', metaId: 0 }
]
