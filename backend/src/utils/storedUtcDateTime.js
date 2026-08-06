import { DateTime } from 'luxon'

/**
 * Lee un instante que ya viene de una columna UTC de la base de datos.
 * PostgreSQL entrega `timestamp without time zone` como Date por medio de
 * nuestro adaptador; SQLite conserva el texto SQL. Ambos representan el mismo
 * instante y nunca deben reinterpretarse en la zona del proceso o del negocio.
 */
export function parseStoredUtcDateTime(value) {
  if (DateTime.isDateTime(value)) {
    return value.isValid ? value.toUTC() : null
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return DateTime.fromJSDate(value, { zone: 'utc' })
  }

  const text = String(value ?? '').trim()
  if (!text) return null
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const parsed = DateTime.fromISO(normalized, { zone: 'utc' })
  return parsed.isValid ? parsed.toUTC() : null
}
