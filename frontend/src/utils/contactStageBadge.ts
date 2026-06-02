import type { BadgeVariant } from '@/components/common/Badge'

type ContactStage = 'lead' | 'appointment' | 'attended' | 'customer'

interface ContactStageLabels {
  lead: string
  customer: string
}

interface ContactStageBadge {
  stage: ContactStage
  text: string
  variant: BadgeVariant
}

export const CONTACT_STAGE_BADGE_VARIANTS: Record<ContactStage, BadgeVariant> = {
  lead: 'neutral',
  appointment: 'purple',
  attended: 'info',
  customer: 'success'
}

const CUSTOMER_KEYWORDS = ['customer', 'cliente', 'sale', 'ventas', 'sold', 'converted', 'paid', 'pago', 'pagó', 'compra', 'compró', 'closed-won', 'won']
const APPOINTMENT_KEYWORDS = ['appointment', 'cita', 'agend', 'booked', 'scheduled', 'confirmado', 'reserva', 'reservo', 'calendar']
const ATTENDANCE_KEYWORDS = ['asist', 'showed', 'attended', 'completed']

const ATTENDED_APPOINTMENT_STATUSES = new Set(['completed', 'showed', 'attended'])
const ACTIVE_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const INACTIVE_APPOINTMENT_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
])

export const isAttendedAppointmentStatus = (status?: string | null) =>
  ATTENDED_APPOINTMENT_STATUSES.has(String(status || '').trim().toLowerCase())

const normalizeValue = (value: unknown) => String(value || '').trim().toLowerCase()

const toNumber = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const toBoolean = (value: unknown) =>
  value === true || value === 1 || value === '1' || normalizeValue(value) === 'true'

const normalizeTags = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string').map(normalizeValue).filter(Boolean)
  }

  if (typeof value === 'string') {
    return value.split(',').map(normalizeValue).filter(Boolean)
  }

  return []
}

const getAppointmentStatus = (appointment: unknown) => {
  if (!appointment || typeof appointment !== 'object') return ''
  const item = appointment as Record<string, unknown>
  return normalizeValue(item.appointmentStatus ?? item.appointment_status ?? item.status)
}

const getPayments = (contact: Record<string, unknown>) => {
  if (Array.isArray(contact.payments)) return contact.payments
  if (Array.isArray(contact.payment_details)) return contact.payment_details
  return []
}

const getAppointments = (contact: Record<string, unknown>) => {
  if (Array.isArray(contact.appointments)) return contact.appointments
  if (Array.isArray(contact.appointment_details)) return contact.appointment_details
  return []
}

const hasKnownField = (contact: Record<string, unknown>, keys: string[]) =>
  keys.some(key => contact[key] !== undefined && contact[key] !== null)

const isLivePayment = (payment: Record<string, unknown>) =>
  normalizeValue(payment.paymentMode ?? payment.payment_mode) !== 'test'

const isActivePayment = (payment: unknown) => {
  if (!payment || typeof payment !== 'object') return false
  const item = payment as Record<string, unknown>
  const status = normalizeValue(item.status)
  return toNumber(item.amount) > 0 && isLivePayment(item) && (!status || ACTIVE_PAYMENT_STATUSES.has(status))
}

const isActiveAppointmentStatus = (status?: string | null) => {
  const normalized = normalizeValue(status)
  return !normalized || !INACTIVE_APPOINTMENT_STATUSES.has(normalized)
}

export const getContactStageBadge = (
  contactInput: unknown,
  labels: ContactStageLabels
): ContactStageBadge | null => {
  if (!contactInput || typeof contactInput !== 'object') return null

  const contact = contactInput as Record<string, unknown>
  const statusValues = [
    contact.status,
    contact.customerStatus,
    contact.stage,
    contact.lifecycleStage
  ].map(normalizeValue).filter(Boolean)

  const tags = [
    ...normalizeTags(contact.tags),
    ...normalizeTags(contact.labels),
    ...normalizeTags(contact.tagList),
    ...normalizeTags(contact.contactTags)
  ]

  const statusMatches = (keywords: string[]) =>
    statusValues.some(status => keywords.some(keyword => status.includes(keyword)))

  const tagsMatch = (keywords: string[]) =>
    tags.some(tag => keywords.some(keyword => tag.includes(keyword)))

  const payments = getPayments(contact)
  const appointments = getAppointments(contact)
  const hasPaymentFacts =
    Array.isArray(contact.payments) ||
    Array.isArray(contact.payment_details) ||
    hasKnownField(contact, [
      'purchases',
      'purchases_count',
      'lifetimePurchases',
      'purchasesLifetime',
      'ltv',
      'totalPaid',
      'total_paid',
      'lifetimeLtv'
    ])

  const hasAppointmentList = Array.isArray(contact.appointments) || Array.isArray(contact.appointment_details)
  const hasAppointmentFacts =
    hasAppointmentList ||
    hasKnownField(contact, [
      'hasAppointments',
      'has_appointments',
      'hasShowedAppointment',
      'hasAttendedAppointment',
      'firstAppointmentDate',
      'nextAppointmentDate',
      'appointment_date'
    ])

  const hasPurchases =
    toNumber(contact.purchases) > 0 ||
    toNumber(contact.lifetimePurchases ?? contact.purchasesLifetime ?? contact.purchases_count) > 0 ||
    toNumber(contact.ltv) > 0 ||
    toNumber(contact.lifetimeLtv ?? contact.totalPaid ?? contact.total_paid) > 0 ||
    payments.some(isActivePayment) ||
    (!hasPaymentFacts && (
      toBoolean(contact.isCustomer) ||
      toBoolean(contact.is_customer) ||
      toBoolean(contact.isSale) ||
      toBoolean(contact.is_sale) ||
      statusMatches(CUSTOMER_KEYWORDS) ||
      tagsMatch(CUSTOMER_KEYWORDS)
    ))

  if (hasPurchases) {
    return {
      stage: 'customer',
      text: labels.customer,
      variant: CONTACT_STAGE_BADGE_VARIANTS.customer
    }
  }

  const hasAttendedAppointment =
    toBoolean(contact.hasShowedAppointment) ||
    toBoolean(contact.hasAttendedAppointment) ||
    appointments.some(appointment => isAttendedAppointmentStatus(getAppointmentStatus(appointment))) ||
    (!hasAppointmentFacts && (
      statusMatches(ATTENDANCE_KEYWORDS) ||
      tagsMatch(ATTENDANCE_KEYWORDS)
    ))

  if (hasAttendedAppointment) {
    return {
      stage: 'attended',
      text: 'Asistió a Cita',
      variant: CONTACT_STAGE_BADGE_VARIANTS.attended
    }
  }

  const hasAppointments =
    appointments.some(appointment => isActiveAppointmentStatus(getAppointmentStatus(appointment))) ||
    (!hasAppointmentList && (
      toBoolean(contact.hasAppointments) ||
      toBoolean(contact.has_appointments) ||
      Boolean(contact.nextAppointmentDate) ||
      Boolean(contact.firstAppointmentDate) ||
      Boolean(contact.appointment_date)
    )) ||
    (!hasAppointmentFacts && (
      statusMatches(APPOINTMENT_KEYWORDS) ||
      tagsMatch(APPOINTMENT_KEYWORDS)
    ))

  if (hasAppointments) {
    return {
      stage: 'appointment',
      text: 'Agendó cita',
      variant: CONTACT_STAGE_BADGE_VARIANTS.appointment
    }
  }

  return {
    stage: 'lead',
    text: labels.lead,
    variant: CONTACT_STAGE_BADGE_VARIANTS.lead
  }
}
