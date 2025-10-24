import { DateTime } from 'luxon'
import { db } from '../config/database.js'

// Utilidades para manejo de fechas

const DEFAULT_TIMEZONE = 'America/Mexico_City'

// Cache de timezone de HighLevel (se refresca cada hora)
let cachedTimezone = null
let cacheTimestamp = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hora

/**
 * Obtiene la zona horaria configurada en HighLevel.
 * Si no hay configuración, retorna la zona horaria por defecto.
 * INCLUYE CACHE para evitar queries repetidas a la DB.
 */
export async function getTimezoneFromGHL() {
  try {
    // Si hay cache válido, usarlo
    const now = Date.now()
    if (cachedTimezone && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL_MS) {
      return cachedTimezone
    }

    const config = await db.get(
      'SELECT location_data FROM highlevel_config LIMIT 1'
    )

    if (config?.location_data) {
      const locationData = JSON.parse(config.location_data)
      const timezone = locationData.timezone || DEFAULT_TIMEZONE

      // Actualizar cache
      cachedTimezone = timezone
      cacheTimestamp = now

      return timezone
    }

    // Cachear default también
    cachedTimezone = DEFAULT_TIMEZONE
    cacheTimestamp = now
    return DEFAULT_TIMEZONE
  } catch (error) {
    // En caso de error, usar default y cachearlo
    cachedTimezone = DEFAULT_TIMEZONE
    cacheTimestamp = Date.now()
    return DEFAULT_TIMEZONE
  }
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
  const zone = timezone || DEFAULT_TIMEZONE

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

  // 🔥 FIX CRÍTICO: Si el endDate es HOY o está en el futuro cercano (hasta mañana),
  // agregar un margen de seguridad para evitar problemas de timezone.
  // Esto asegura que TODOS los datos del día actual se incluyan sin importar
  // discrepancias de timezone entre HighLevel, PostgreSQL y el usuario.
  if (end) {
    const today = DateTime.now().setZone(zone).startOf('day')
    const tomorrow = today.plus({ days: 1 })

    // Si endDate es hoy o mañana, agregar 12 horas de margen
    if (end >= today && end <= tomorrow.endOf('day')) {
      end = end.plus({ hours: 12 })
    }
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
