import { DEFAULT_TIMEZONE, localDateTimeInputToUTCISOString, todayDateOnlyInTimezone } from './timezone'

// Convierte la fecha elegida (YYYY-MM-DD) en un timestamp COMPLETO para registrar el
// MOMENTO exacto del pago y poder ordenar las transacciones de forma descendente:
// - hoy        -> ahora mismo (la hora real en que se registró el pago)
// - otra fecha -> mediodía de la zona del negocio (cae en el día correcto sin
//                 depender de la zona horaria del navegador)
export const buildPaymentTimestamp = (dateInput?: string | null, timezone?: string): string => {
  const now = new Date()
  const businessTimezone = timezone || DEFAULT_TIMEZONE
  const localToday = todayDateOnlyInTimezone(businessTimezone, now)
  const value = (dateInput || '').trim()
  if (!value || value === localToday) return now.toISOString()
  return localDateTimeInputToUTCISOString(`${value}T12:00`, businessTimezone) || now.toISOString()
}
