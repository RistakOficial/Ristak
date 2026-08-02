import type { Contact } from '../../types'

const optionalSummaryKeys = [
  'lastPurchase',
  'paymentsCount',
  'successfulPaymentsCount',
  'failedPaymentsCount',
  'paymentsTotal',
  'hasPaymentRecords',
  'paymentsTruncated',
  'paymentsNextCursor',
  'appointmentsTotal',
  'appointmentsTruncated',
  'appointmentsNextCursor',
  'firstAppointmentDate',
  'nextAppointmentDate',
  'hasAppointments',
  'hasShowedAppointment',
  'hasAttendedAppointment',
  'hasUpcomingConfirmedAppointmentBadge'
] as const satisfies ReadonlyArray<keyof Contact>

/**
 * Conserva los agregados canónicos del endpoint de detalle aunque las listas
 * de pagos y citas todavía no se hayan cargado. Esas listas son paginadas y no
 * pueden usarse para recalcular totales de vida del contacto.
 */
export function mergeAuthoritativeContactSummary(base: Contact, detail?: Contact | null): Contact {
  if (!detail) return base

  const merged: Contact = {
    ...base,
    ltv: detail.ltv,
    purchases: detail.purchases,
    status: detail.status
  }

  optionalSummaryKeys.forEach((key) => {
    if (detail[key] !== undefined) {
      ;(merged as unknown as Record<string, unknown>)[key] = detail[key]
    }
  })

  return merged
}
