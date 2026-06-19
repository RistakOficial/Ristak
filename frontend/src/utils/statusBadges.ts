import type { BadgeVariant } from '@/components/common/Badge'

/**
 * Vocabulario de estados unificado para toda la app (transacciones, planes de
 * pago y citas). Fuente única de verdad: reemplaza los mapas duplicados que
 * vivían en Dashboard / Transactions / Appointments y corrige los desajustes de
 * wording detectados (p. ej. "Pago parcial", "Reprogramada") y de tono (parcial
 * = warning, no error). Cada estado se renderiza con <Badge variant=...>.
 */
export interface StatusBadgeDescriptor {
  label: string
  variant: BadgeVariant
}

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase()

const pick = (
  map: Record<string, StatusBadgeDescriptor>,
  status: unknown,
  fallback: StatusBadgeDescriptor
): StatusBadgeDescriptor => map[normalize(status)] ?? fallback

// ===== Transacciones / pagos =====
export const TRANSACTION_STATUS_BADGES: Record<string, StatusBadgeDescriptor> = {
  draft: { label: 'Borrador', variant: 'neutral' },
  sent: { label: 'Enviado', variant: 'info' },
  paid: { label: 'Pagado', variant: 'success' },
  succeeded: { label: 'Pagado', variant: 'success' },
  pending: { label: 'Pendiente', variant: 'warning' },
  partial: { label: 'Pago parcial', variant: 'warning' },
  overdue: { label: 'Vencido', variant: 'error' },
  void: { label: 'Anulado', variant: 'error' },
  voided: { label: 'Anulado', variant: 'error' },
  refunded: { label: 'Reembolsado', variant: 'error' },
  failed: { label: 'Fallido', variant: 'error' },
  deleted: { label: 'Eliminado', variant: 'neutral' },
  test: { label: 'Prueba', variant: 'warning' }
}

export const getTransactionStatusBadge = (status: unknown): StatusBadgeDescriptor =>
  pick(TRANSACTION_STATUS_BADGES, status, { label: 'Borrador', variant: 'neutral' })

// ===== Planes de pago =====
export const PAYMENT_PLAN_STATUS_BADGES: Record<string, StatusBadgeDescriptor> = {
  active: { label: 'Activo', variant: 'info' },
  pending: { label: 'Pendiente', variant: 'warning' },
  scheduled: { label: 'Programado', variant: 'warning' },
  paused: { label: 'Pausado', variant: 'warning' },
  cancelled: { label: 'Cancelado', variant: 'error' },
  canceled: { label: 'Cancelado', variant: 'error' },
  completed: { label: 'Completado', variant: 'success' },
  inactive: { label: 'Inactivo', variant: 'neutral' }
}

export const getPaymentPlanStatusBadge = (status: unknown): StatusBadgeDescriptor =>
  pick(PAYMENT_PLAN_STATUS_BADGES, status, { label: 'Inactivo', variant: 'neutral' })

// ===== Citas =====
export const APPOINTMENT_STATUS_BADGES: Record<string, StatusBadgeDescriptor> = {
  confirmed: { label: 'Confirmada', variant: 'info' },
  confirmada: { label: 'Confirmada', variant: 'info' },
  pending: { label: 'Pendiente', variant: 'warning' },
  pendiente: { label: 'Pendiente', variant: 'warning' },
  cancelled: { label: 'Cancelada', variant: 'error' },
  canceled: { label: 'Cancelada', variant: 'error' },
  cancelada: { label: 'Cancelada', variant: 'error' },
  showed: { label: 'Asistió', variant: 'success' },
  attended: { label: 'Asistió', variant: 'success' },
  completed: { label: 'Asistió', variant: 'success' },
  noshow: { label: 'No asistió', variant: 'neutral' },
  no_show: { label: 'No asistió', variant: 'neutral' },
  rescheduled: { label: 'Reprogramada', variant: 'purple' }
}

export const getAppointmentStatusBadge = (status: unknown): StatusBadgeDescriptor =>
  pick(APPOINTMENT_STATUS_BADGES, status, { label: 'Pendiente', variant: 'warning' })

/** Etiquetas planas (sin tono) por si algún consumidor solo necesita el texto. */
export const TRANSACTION_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(TRANSACTION_STATUS_BADGES).map(([key, { label }]) => [key, label])
)
export const APPOINTMENT_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(APPOINTMENT_STATUS_BADGES).map(([key, { label }]) => [key, label])
)
