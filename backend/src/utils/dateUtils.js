import { DateTime } from 'luxon'
import { db } from '../config/database.js'

// Utilidades para manejo de fechas

export const DEFAULT_TIMEZONE = 'America/Mexico_City'

// Cache de timezone de HighLevel (se refresca cada hora)
let cachedTimezone = null
let cacheTimestamp = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hora

// Clave en app_config donde se guarda la zona horaria elegida en Ristak.
export const ACCOUNT_TIMEZONE_CONFIG_KEY = 'account_timezone'

/**
 * Valida que una cadena sea una zona horaria IANA reconocida por el runtime.
 */
export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false
  try {
    // Lanza RangeError si la zona no existe.
    Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch (error) {
    return false
  }
}

export function resolveTimezone(tz, fallback = DEFAULT_TIMEZONE) {
  return isValidTimezone(tz) ? tz : (isValidTimezone(fallback) ? fallback : DEFAULT_TIMEZONE)
}

export function getTimezoneOffsetMinutes(timezone = DEFAULT_TIMEZONE, referenceDate = new Date()) {
  const zone = resolveTimezone(timezone)
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate)
  const at = Number.isNaN(date.getTime()) ? new Date() : date
  const offset = DateTime.fromJSDate(at, { zone }).offset
  return Number.isFinite(offset) ? offset : DateTime.fromJSDate(at, { zone: DEFAULT_TIMEZONE }).offset
}

export function sqliteTimezoneOffsetClause(timezone = DEFAULT_TIMEZONE, referenceDate = new Date()) {
  const offsetMinutes = getTimezoneOffsetMinutes(timezone, referenceDate)
  return `'${offsetMinutes} minutes'`
}

/**
 * Invalida el cache de zona horaria. Llamar cuando el usuario cambia la zona
 * en Ristak o cuando se actualiza la config de HighLevel.
 */
export function invalidateTimezoneCache() {
  cachedTimezone = null
  cacheTimestamp = null
}

/**
 * Obtiene la zona horaria efectiva de la cuenta con esta prioridad:
 *   1. Override explícito guardado en Ristak (app_config.account_timezone)
 *   2. Zona horaria de HighLevel (location_data.timezone)
 *   3. Default (America/Mexico_City)
 *
 * Esta es la ÚNICA fuente de verdad de zona horaria del backend. No depende de
 * que HighLevel esté conectado: usuarios sin GHL pueden fijar su zona en Ristak.
 * INCLUYE CACHE para evitar queries repetidas a la DB.
 */
export async function getAccountTimezone() {
  const now = Date.now()
  if (cachedTimezone && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedTimezone
  }

  let timezone = DEFAULT_TIMEZONE

  try {
    // 1) Override de la cuenta configurado en Ristak
    const override = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      [ACCOUNT_TIMEZONE_CONFIG_KEY]
    )

    if (override?.config_value && isValidTimezone(override.config_value)) {
      timezone = override.config_value
    } else {
      // 2) Zona horaria de HighLevel (si está conectado)
      const config = await db.get('SELECT location_data FROM highlevel_config LIMIT 1')
      if (config?.location_data) {
        const locationData = JSON.parse(config.location_data)
        if (locationData?.timezone && isValidTimezone(locationData.timezone)) {
          timezone = locationData.timezone
        }
      }
    }
  } catch (error) {
    // 3) Ante cualquier error, usar el default
    timezone = DEFAULT_TIMEZONE
  }

  cachedTimezone = timezone
  cacheTimestamp = Date.now()
  return timezone
}

/**
 * Alias retrocompatible. La resolución real vive en getAccountTimezone().
 * @deprecated usar getAccountTimezone()
 */
export async function getTimezoneFromGHL() {
  return getAccountTimezone()
}

/**
 * Normaliza CUALQUIER fecha a un ISO string en UTC, listo para guardar en BD.
 *
 * Reglas:
 *  - Si la cadena trae zona explícita (Z o ±HH:MM), se respeta ese offset.
 *  - Si la cadena es "naive" (sin zona), se interpreta en `fallbackZone`
 *    (la zona del negocio), NO en la del servidor.
 *  - Garantiza que el instante guardado sea correcto sin importar si la columna
 *    es `timestamptz` o `timestamp` (Postgres descarta el offset en `timestamp`,
 *    por eso normalizamos a UTC antes de insertar).
 *
 * @param {string|Date} value
 * @param {string} [fallbackZone] zona para fechas sin offset (default: zona México)
 * @returns {string|null} ISO UTC ("...Z") o el valor original si es inválido
 */
export function normalizeToUtcIso(value, fallbackZone = DEFAULT_TIMEZONE) {
  if (value === null || value === undefined || value === '') return value

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : value.toISOString()
  }

  const str = String(value).trim()
  if (!str) return value

  const zone = resolveTimezone(fallbackZone)
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)

  let dt
  if (hasExplicitZone) {
    dt = DateTime.fromISO(str, { setZone: true })
  } else {
    dt = DateTime.fromISO(str, { zone })
    if (!dt.isValid) {
      // Soportar formato SQL "YYYY-MM-DD HH:mm:ss"
      dt = DateTime.fromSQL(str, { zone })
    }
  }

  if (!dt || !dt.isValid) {
    const fallback = new Date(str)
    return Number.isNaN(fallback.getTime()) ? value : fallback.toISOString()
  }

  return dt.toUTC().toISO({ suppressMilliseconds: false })
}

export function businessTodayDateOnly(timezone = DEFAULT_TIMEZONE, referenceDate = new Date()) {
  return DateTime.fromJSDate(referenceDate instanceof Date ? referenceDate : new Date(referenceDate))
    .setZone(resolveTimezone(timezone))
    .toISODate()
}

export function normalizeDateOnlyInTimezone(value, timezone = DEFAULT_TIMEZONE, fallbackDate = null) {
  const zone = resolveTimezone(timezone)
  const fallback = fallbackDate
    ? DateTime.fromISO(String(fallbackDate), { zone })
    : DateTime.now().setZone(zone)

  if (value === null || value === undefined || value === '') {
    return (fallback.isValid ? fallback : DateTime.now().setZone(zone)).toISODate()
  }

  const text = String(value).trim()
  const dateOnly = text.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateOnly) return dateOnly[1]

  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  let parsed = hasExplicitZone
    ? DateTime.fromISO(text, { setZone: true }).setZone(zone)
    : DateTime.fromISO(text, { zone })

  if (!parsed.isValid) parsed = DateTime.fromSQL(text, { zone })
  if (!parsed.isValid) {
    const fallbackJs = new Date(text)
    if (!Number.isNaN(fallbackJs.getTime())) parsed = DateTime.fromJSDate(fallbackJs).setZone(zone)
  }

  if (!parsed.isValid) {
    return (fallback.isValid ? fallback : DateTime.now().setZone(zone)).toISODate()
  }

  return parsed.toISODate()
}

export function assertDateOnlyNotInPast(value, timezone = DEFAULT_TIMEZONE, message = 'La fecha no puede estar en el pasado.') {
  const normalizedDate = normalizeDateOnlyInTimezone(value, timezone)
  if (normalizedDate < businessTodayDateOnly(timezone)) {
    const error = new Error(message)
    error.status = 400
    throw error
  }
  return normalizedDate
}

export function assertLocalDateTimeNotInPast(value, timezone = DEFAULT_TIMEZONE, message = 'La fecha y hora no puede estar en el pasado.') {
  const utcIso = normalizeToUtcIso(value, timezone)
  const timestamp = Date.parse(utcIso)
  if (!Number.isFinite(timestamp)) {
    const error = new Error('La fecha y hora no es válida.')
    error.status = 400
    throw error
  }

  if (timestamp < Date.now() - 60_000) {
    const error = new Error(message)
    error.status = 400
    throw error
  }

  return utcIso
}

/**
 * Normaliza un rango de fechas recibido desde la API para usar en consultas SQL.
 * Garantiza:
 *  - Inclusión de toda la fecha final (23:59:59.999)
 *  - Conversión a UTC para almacenaje/consulta
 *  - Valores por defecto predecibles cuando falta alguno de los extremos
 * @param {Object} params
 * @param {string|undefined} params.startDate - Fecha inicial (YYYY-MM-DD)
 * @param {string|undefined} params.endDate - Fecha final (YYYY-MM-DD)
 * @param {string} [params.timezone] - Zona horaria a normalizar
 * @returns {{ startUtc: string|null, endUtc: string|null, appliedTimezone: string, isFiltered: boolean }}
 */
export function resolveDateRange ({ startDate, endDate, timezone = DEFAULT_TIMEZONE } = {}) {
  const zone = resolveTimezone(timezone)

  let start = startDate ? DateTime.fromISO(startDate, { zone }).startOf('day') : null
  let end = endDate ? DateTime.fromISO(endDate, { zone }).endOf('day') : null

  if (start?.isValid === false) {
    start = null
  }

  if (end?.isValid === false) {
    end = null
  }

  const now = DateTime.now().setZone(zone).endOf('day')

  if (start && !end) {
    end = now
  }

  const providedStart = Boolean(start)
  const providedEnd = Boolean(end)

  return {
    startUtc: start ? start.toUTC().toISO({ suppressMilliseconds: false }) : null,
    endUtc: end ? end.toUTC().toISO({ suppressMilliseconds: false }) : null,
    appliedTimezone: zone,
    isFiltered: Boolean(startDate || endDate),
    startZoned: start,
    endZoned: end,
    providedStart,
    providedEnd
  }
}

/**
 * Versión async de resolveDateRange que obtiene automáticamente el timezone de HighLevel.
 * USAR ESTA FUNCIÓN en todos los controllers y services nuevos.
 *
 * @param {Object} params
 * @param {string|undefined} params.startDate - Fecha inicial (YYYY-MM-DD)
 * @param {string|undefined} params.endDate - Fecha final (YYYY-MM-DD)
 * @param {string} [params.timezone] - Zona horaria (si no se pasa, se obtiene de GHL)
 * @returns {Promise<{ startUtc: string|null, endUtc: string|null, appliedTimezone: string, isFiltered: boolean }>}
 */
export async function resolveDateRangeWithGHLTimezone ({ startDate, endDate, timezone } = {}) {
  // Si no se pasó timezone, obtenerlo de HighLevel
  const resolvedTimezone = timezone || await getTimezoneFromGHL()

  // Llamar a la función sync con el timezone correcto
  return resolveDateRange({ startDate, endDate, timezone: resolvedTimezone })
}

/**
 * Construye cláusula WHERE para un rango de fechas.
 * @param {string} column - Nombre de la columna en BD
 * @param {Object} options - ver resolveDateRange
 * @param {boolean} usePostgres - Si se usa Postgres para decidir placeholders
 * @param {Array} params - Arreglo de parámetros al que se agregarán los valores
 * @returns {{ clause: string, params: any[] }}
 */
export function buildDateRangeClause (column, options = {}, params = []) {
  const range = resolveDateRange(options)

  let clause = ''
  const placeholders = []

  if (range.startUtc) {
    placeholders.push('?')
  }

  if (range.endUtc) {
    placeholders.push('?')
  }

  if (range.startUtc && range.endUtc) {
    clause = `${column} BETWEEN ${placeholders[0]} AND ${placeholders[1]}`
    params.push(range.startUtc, range.endUtc)
  } else if (range.startUtc) {
    clause = `${column} >= ${placeholders[0]}`
    params.push(range.startUtc)
  } else if (range.endUtc) {
    clause = `${column} <= ${placeholders[0]}`
    params.push(range.endUtc)
  }

  return {
    clause,
    params,
    range
  }
}

/**
 * Divide un rango de fechas en chunks mensuales
 * @param {Date} startDate - Fecha de inicio
 * @param {Date} endDate - Fecha de fin
 * @returns {Array} Array de objetos {since, until}
 */
export function splitDateRangeIntoMonths(startDate, endDate) {
  const chunks = []
  const current = new Date(startDate)
  const end = new Date(endDate)

  while (current < end) {
    const chunkStart = new Date(current)

    // Avanzar al último día del mes
    const chunkEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0)

    // Si el chunk end es mayor que la fecha final, usar la fecha final
    if (chunkEnd > end) {
      chunks.push({
        since: formatDate(chunkStart),
        until: formatDate(end)
      })
      break
    }

    chunks.push({
      since: formatDate(chunkStart),
      until: formatDate(chunkEnd)
    })

    // Avanzar al primer día del siguiente mes
    current.setMonth(current.getMonth() + 1)
    current.setDate(1)
  }

  return chunks
}

/**
 * Formatea una fecha a YYYY-MM-DD usando UTC para evitar problemas de zona horaria
 */
export function formatDate(date) {
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Formatea una fecha a ISO string para base de datos
 */
export function formatDateTimeForDB(date) {
  return new Date(date).toISOString()
}

/**
 * Calcula fecha N días atrás desde hoy
 */
export function daysAgo(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date
}

/**
 * Calcula fecha N meses atrás desde hoy
 */
export function monthsAgo(months) {
  const date = new Date()
  date.setMonth(date.getMonth() - months)
  return date
}

/**
 * Convierte una fecha del timezone de Meta Ads a UTC
 * @param {string|Date} date - Fecha en el timezone de Meta
 * @param {number} timezoneOffsetHours - Offset en horas desde UTC (ej: -8 para PST, -6 para CST México)
 * @returns {Date} Fecha convertida a UTC
 */
export function convertMetaDateToUTC(date, timezoneOffsetHours) {
  // Si no hay offset, asumir que ya está en UTC
  if (timezoneOffsetHours === null || timezoneOffsetHours === undefined) {
    return new Date(date)
  }

  // Parsear la fecha (Meta envía formato YYYY-MM-DD)
  const dateObj = typeof date === 'string' ? new Date(date) : date

  // Meta da fechas en el timezone de la cuenta (ej: "2025-01-15" en PST)
  // Necesitamos ajustar al offset correcto
  // Si offset es -8 (PST), significa que la fecha Meta está 8 horas ATRÁS de UTC
  // Entonces sumamos 8 horas para llegar a UTC
  const utcDate = new Date(dateObj.getTime() - (timezoneOffsetHours * 60 * 60 * 1000))

  return utcDate
}

/**
 * Convierte una fecha UTC al timezone de Meta Ads
 * @param {string|Date} utcDate - Fecha en UTC
 * @param {number} timezoneOffsetHours - Offset en horas desde UTC
 * @returns {Date} Fecha convertida al timezone de Meta
 */
export function convertUTCToMetaDate(utcDate, timezoneOffsetHours) {
  if (timezoneOffsetHours === null || timezoneOffsetHours === undefined) {
    return new Date(utcDate)
  }

  const dateObj = typeof utcDate === 'string' ? new Date(utcDate) : utcDate
  const metaDate = new Date(dateObj.getTime() + (timezoneOffsetHours * 60 * 60 * 1000))

  return metaDate
}
