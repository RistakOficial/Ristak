import { localDateTimeInputToUTCISOString, todayDateOnlyInTimezone } from './timezone'

// Convierte la fecha elegida (YYYY-MM-DD) en un timestamp COMPLETO para registrar el
// MOMENTO exacto del pago y poder ordenar las transacciones de forma descendente:
// - hoy        -> ahora mismo (la hora real en que se registró el pago)
// - otra fecha -> mediodía de la zona del negocio (cae en el día correcto sin
//                 depender de la zona horaria del navegador)
export const buildPaymentTimestamp = (dateInput?: string | null, timezone?: string): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const localToday = timezone
    ? todayDateOnlyInTimezone(timezone, now)
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const value = (dateInput || '').trim()
  if (!value || value === localToday) return now.toISOString()
  if (timezone) {
    return localDateTimeInputToUTCISOString(`${value}T12:00`, timezone) || now.toISOString()
  }
  const noonLocal = new Date(`${value}T12:00:00`)
  return Number.isNaN(noonLocal.getTime()) ? now.toISOString() : noonLocal.toISOString()
}
