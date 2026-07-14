const PAID_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'registered'
])

const cleanStatus = (value) => String(value || '').trim().toLowerCase()

/**
 * Convierte el avance materializado del calendario en un estado canónico.
 * Sólo devuelve true cuando existe al menos un cobro real y todos los cobros
 * visibles terminaron; así la lista y sus KPIs no necesitan interpretar JSON.
 */
export function isPaymentPlanScheduleFullyPaid({
  firstPaymentAmount = 0,
  firstPaymentStatus = '',
  installments = []
} = {}) {
  const hasFirstPayment = Number(firstPaymentAmount || 0) > 0
  const visibleInstallments = (Array.isArray(installments) ? installments : []).filter((installment) => (
    !['cancelled', 'canceled', 'deleted', 'void'].includes(cleanStatus(installment?.status))
  ))
  const hasAnyPayment = hasFirstPayment || visibleInstallments.length > 0
  if (!hasAnyPayment) return false
  if (hasFirstPayment && !PAID_STATUSES.has(cleanStatus(firstPaymentStatus))) return false
  return visibleInstallments.every((installment) => PAID_STATUSES.has(cleanStatus(installment?.status)))
}
