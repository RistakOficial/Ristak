export const APPOINTMENT_BOOKING_ORIGINS = Object.freeze({
  CONTACT: 'contact',
  ADMIN: 'admin',
  PUBLIC_CALENDAR: 'public_calendar'
})

const APPOINTMENT_BOOKING_ORIGIN_ALIASES = new Map([
  ['contact', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['contacto', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['conversational_agent', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['conversational_agent_v2', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['agent', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['ai', APPOINTMENT_BOOKING_ORIGINS.CONTACT],
  ['admin', APPOINTMENT_BOOKING_ORIGINS.ADMIN],
  ['administrator', APPOINTMENT_BOOKING_ORIGINS.ADMIN],
  ['manual', APPOINTMENT_BOOKING_ORIGINS.ADMIN],
  ['crm', APPOINTMENT_BOOKING_ORIGINS.ADMIN],
  ['public_calendar', APPOINTMENT_BOOKING_ORIGINS.PUBLIC_CALENDAR],
  ['calendar_public', APPOINTMENT_BOOKING_ORIGINS.PUBLIC_CALENDAR],
  ['calendario_publico', APPOINTMENT_BOOKING_ORIGINS.PUBLIC_CALENDAR],
  ['public', APPOINTMENT_BOOKING_ORIGINS.PUBLIC_CALENDAR]
])

export function normalizeAppointmentBookingOrigin(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_')

  return APPOINTMENT_BOOKING_ORIGIN_ALIASES.get(normalized) || null
}
