import { canRecoverConversationalAppointmentDepositReservation } from '../../services/conversationalAgentService.js'

export const SUCCESS_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'captured',
  'approved',
  'accredited'
])

export const NON_LIVE_PAYMENT_MODES = new Set([
  'test',
  'sandbox',
  'demo',
  'preview',
  'simulation',
  'simulated',
  // Una foto recibida sólo prueba que hay algo que revisar, no que los fondos
  // hayan llegado. Incluso un cambio accidental de status no debe desbloquearla.
  'manual_review',
  'manual review'
])

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bp\s*\.\s*m\s*\.?\b/g, 'pm')
    .replace(/\ba\s*\.\s*m\s*\.?\b/g, 'am')
    .replace(/[^a-z0-9:/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : ''
}

function normalizeAmount(value) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null
}

function amountsMatch(left, right) {
  const a = normalizeAmount(left)
  const b = normalizeAmount(right)
  return a !== null && b !== null && Math.abs(a - b) < 0.005
}

/**
 * Comprueba si un monto cumple el requisito de anticipo configurado
 * (fijo exacto o dentro del rango). Lo usan el candado de evidencia y la
 * validación del comprobante por transferencia para no duplicar criterios.
 */
export function depositRequirementAmountMatches(requirement = {}, amount) {
  const candidate = normalizeAmount(amount)
  if (candidate === null) return false
  const mode = String(requirement.mode || 'fixed').trim() === 'range' ? 'range' : 'fixed'
  if (mode === 'range') {
    const minAmount = normalizeAmount(requirement.minAmount)
    const maxAmount = normalizeAmount(requirement.maxAmount)
    return (!minAmount || candidate >= minAmount) && (!maxAmount || candidate <= maxAmount)
  }
  return amountsMatch(candidate, requirement.amount)
}

function timestampToMs(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  // SQLite guarda UTC sin sufijo; no permitimos que la zona local del proceso
  // cambie la edad de la evidencia al interpretarlo.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = value ? JSON.parse(value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function revalidateAppointmentSlot({
  calendarId,
  requestedStartTime,
  windowStart,
  windowEnd,
  lookupSlots
}) {
  let availability
  try {
    availability = await lookupSlots(calendarId, windowStart, windowEnd, null, {
      ignoreAppointmentConflicts: true
    })
  } catch (error) {
    return {
      ok: false,
      actionCompleted: false,
      availabilityCheckFailed: true,
      transferRequired: true,
      retryable: true,
      technicalError: error?.message || String(error),
      error: 'No se pudo revalidar la disponibilidad real del calendario. No se agendó nada. Reintenta la consulta y, si sigue fallando, pasa la conversación a una persona.'
    }
  }

  if (!Array.isArray(availability)) {
    return {
      ok: false,
      actionCompleted: false,
      availabilityCheckFailed: true,
      transferRequired: true,
      retryable: true,
      error: 'El calendario devolvió una respuesta inválida al revalidar el horario. No se agendó nada; pasa la conversación a una persona si el problema continúa.'
    }
  }

  const requestedMs = new Date(requestedStartTime).getTime()
  const bookableSlots = availability.flatMap((day) => (
    Array.isArray(day?.slots) ? day.slots : []
  )).map((iso) => ({ iso, ms: new Date(iso).getTime() }))
    .filter((slot) => Number.isFinite(slot.ms))

  const matched = bookableSlots.find((slot) => Math.abs(slot.ms - requestedMs) < 60000)
  if (!matched) {
    return {
      ok: false,
      actionCompleted: false,
      invalidSlot: true,
      error: 'Ese horario no aparece como slot real y disponible del calendario. No se agendó nada; consulta get_free_slots y ofrece únicamente un horario devuelto por la herramienta.'
    }
  }

  return { ok: true, matchedStartTime: matched.iso }
}

export async function findVerifiedPaymentEvidence({
  database,
  contactId,
  agentId = null,
  requiredPurpose = '',
  reconciliationId = '',
  appointmentRequestId = ''
}) {
  if (!database || !contactId) return { ok: false, reason: 'missing_contact' }

  const stateParams = [contactId]
  let stateSql = `
    SELECT activated_at, created_at
    FROM conversational_agent_state
    WHERE contact_id = ?`
  if (agentId) {
    stateSql += ' AND agent_id = ?'
    stateParams.push(agentId)
  }
  stateSql += `
    ORDER BY COALESCE(activated_at, created_at) DESC
    LIMIT 1`

  const [state, payments, nativeEvents] = await Promise.all([
    database.get(stateSql, stateParams).catch(() => null),
    database.all(`
      SELECT id, amount, currency, status, payment_mode, payment_provider,
             title, description, reference, paid_at, date, created_at
      FROM payments
      WHERE contact_id = ?
      ORDER BY COALESCE(paid_at, date, created_at) DESC
      LIMIT 100
    `, [contactId]).catch(() => []),
    database.all(`
      SELECT id, agent_id, event_type, detail_json, created_at
      FROM conversational_agent_events
      WHERE contact_id = ?
        AND event_type IN ('payment_reconciliation_v2', 'deposit_payment_consumed')
      ORDER BY created_at DESC
      LIMIT 120
    `, [contactId]).catch(() => [])
  ])

  const stateStartMs = timestampToMs(state?.activated_at || state?.created_at)
  const fallbackStartMs = Date.now() - 30 * 24 * 60 * 60 * 1000
  const evidenceStartMs = stateStartMs ? stateStartMs - 24 * 60 * 60 * 1000 : fallbackStartMs
  const cleanAgentId = String(agentId || '').trim()
  const cleanRequiredPurpose = String(requiredPurpose || '').trim().toLowerCase()
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanAppointmentRequestId = String(appointmentRequestId || '').trim()
  if (!cleanAgentId || !cleanRequiredPurpose) {
    return { ok: false, reason: 'native_payment_binding_missing' }
  }

  const reservationByReconciliation = new Map()
  for (const event of nativeEvents || []) {
    if (event.event_type !== 'deposit_payment_consumed') continue
    const detail = parseJsonObject(event.detail_json)
    const linkedReconciliationId = String(detail.reconciliationId || '').trim()
    if (linkedReconciliationId) reservationByReconciliation.set(linkedReconciliationId, detail)
  }
  const paymentById = new Map((payments || []).map((payment) => [String(payment.id || '').trim(), payment]))
  const nowMs = Date.now()

  for (const event of nativeEvents || []) {
    if (event.event_type !== 'payment_reconciliation_v2') continue
    if (String(event.agent_id || '').trim() !== cleanAgentId) continue
    if (cleanReconciliationId && event.id !== cleanReconciliationId) continue
    const reservation = reservationByReconciliation.get(event.id)
    const reservationStatus = String(reservation?.status || (reservation ? 'consumed' : '')).trim().toLowerCase()
    if (reservationStatus === 'consumed') continue
    if (
      reservationStatus === 'reserved' &&
      (!cleanAppointmentRequestId || reservation.appointmentRequestId !== cleanAppointmentRequestId)
    ) {
      const recoverable = cleanAppointmentRequestId
        ? await canRecoverConversationalAppointmentDepositReservation({
            reconciliationId: event.id,
            contactId,
            agentId: cleanAgentId,
            appointmentRequestId: cleanAppointmentRequestId
          })
        : false
      if (!recoverable) continue
    }

    const detail = parseJsonObject(event.detail_json)
    const status = String(detail.status || '').trim().toLowerCase()
    const purpose = String(detail.paymentPurpose || '').trim().toLowerCase()
    const eventTimestamp = timestampToMs(event.created_at)
    const exactProcessingResume = Boolean(
      cleanReconciliationId &&
      event.id === cleanReconciliationId &&
      status === 'processing' &&
      detail.verifiedEventAppliedAt &&
      detail.claimToken &&
      timestampToMs(detail.leaseUntilAt) > nowMs
    )
    const completed = status === 'completed' && detail.result?.matched === true
    if (!completed && !exactProcessingResume) continue
    if (purpose !== cleanRequiredPurpose) continue
    if (cleanRequiredPurpose === 'appointment_deposit' && detail.appointmentDeposit !== true) continue
    if (String(detail.paymentEnvironment || '').trim().toLowerCase() !== 'live') continue
    if (!cleanReconciliationId && eventTimestamp < evidenceStartMs) continue

    const ledgerPaymentId = String(detail.ledgerPaymentId || '').trim()
    const payment = paymentById.get(ledgerPaymentId)
    if (!payment) continue
    const paymentStatus = normalizeText(payment.status)
    const paymentMode = normalizeText(payment.payment_mode)
    const frozenCurrency = normalizeCurrency(detail.currency)
    const frozenAmount = normalizeAmount(detail.amount)
    const paymentCurrency = normalizeCurrency(payment.currency)
    const paymentAmount = normalizeAmount(payment.amount)
    if (!SUCCESS_PAYMENT_STATUSES.has(paymentStatus)) continue
    if (paymentMode !== 'live') continue
    if (!frozenCurrency || !frozenAmount) continue
    if (paymentCurrency !== frozenCurrency || !amountsMatch(paymentAmount, frozenAmount)) continue

    return {
      ok: true,
      evidence: {
        paymentId: payment.id,
        reconciliationId: event.id,
        paymentPurpose: purpose,
        amount: paymentAmount,
        currency: paymentCurrency,
        status: paymentStatus,
        provider: payment.payment_provider || null,
        paidAt: payment.paid_at || payment.date || payment.created_at || null
      }
    }
  }

  return { ok: false, reason: 'no_bound_verified_payment' }
}
