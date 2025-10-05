import { DateTime } from 'luxon'
import { db } from '../config/database.js'

// Utilidades para manejo de fechas

const DEFAULT_TIMEZONE = 'America/Mexico_City'

/**
 * Obtiene la zona horaria configurada en HighLevel.
 * Si no hay configuración, retorna la zona horaria por defecto.
 */
export async function getTimezoneFromGHL() {
  try {
    const config = await db.get(
      'SELECT location_data FROM highlevel_config LIMIT 1'
    )

    if (config?.location_data) {
      const locationData = JSON.parse(config.location_data)
      return locationData.timezone || DEFAULT_TIMEZONE
    }

    return DEFAULT_TIMEZONE
  } catch (error) {
    console.error('Error obteniendo timezone de GHL:', error)
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
 * Formatea una fecha a YYYY-MM-DD
 */
export function formatDate(date) {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
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
