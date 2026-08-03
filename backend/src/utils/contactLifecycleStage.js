const CUSTOMER_STAGE_ALIASES = new Set([
  'customer',
  'client',
  'cliente',
  'comprador',
  'sale',
  'venta',
  'paid',
  'pago'
])

const APPOINTMENT_STAGE_ALIASES = new Set([
  'appointment',
  'booked',
  'scheduled',
  'cita',
  'citado',
  'cita agendada',
  'agendo cita'
])

const ATTENDED_STAGE_ALIASES = new Set([
  'attended',
  'showed',
  'completed',
  'asistio',
  'asistio a cita',
  'asistencia'
])

const LEAD_STAGE_ALIASES = new Set([
  'lead',
  'prospect',
  'prospecto',
  'interesado'
])

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
}

export function normalizeContactLifecycleStage(value) {
  const normalized = normalizedText(value)
  if (CUSTOMER_STAGE_ALIASES.has(normalized)) return 'customer'
  if (ATTENDED_STAGE_ALIASES.has(normalized)) return 'attended'
  if (APPOINTMENT_STAGE_ALIASES.has(normalized)) return 'appointment'
  if (LEAD_STAGE_ALIASES.has(normalized)) return 'lead'
  return ''
}

/**
 * Etapa comercial canónica del contacto. Los hechos reales ganan sobre un
 * valor legacy guardado a mano; el valor legacy sólo se conserva cuando no hay
 * pagos ni citas que permitan calcular una etapa más precisa.
 */
export function resolveContactLifecycleStage(contact = {}) {
  if (
    positiveNumber(contact.purchasesCount ?? contact.purchases_count) ||
    positiveNumber(contact.totalPaid ?? contact.total_paid)
  ) {
    return 'customer'
  }

  if (
    positiveNumber(contact.attendedAppointmentsCount ?? contact.attended_appointments_count) ||
    contact.hasAttendedAppointment === true ||
    contact.hasShowedAppointment === true
  ) {
    return 'attended'
  }

  if (
    positiveNumber(contact.activeAppointmentsCount ?? contact.active_appointments_count) ||
    contact.hasActiveAppointment === true ||
    contact.hasAppointments === true
  ) {
    return 'appointment'
  }

  return normalizeContactLifecycleStage(
    contact.lifecycleStage ?? contact.lifecycle_stage ?? contact.stage
  ) || 'lead'
}
