import { db } from '../config/database.js'

const LOCAL_PAYMENT_PLAN_PROVIDERS = new Set([
  'offline',
  'stripe',
  'conekta',
  'mercadopago',
  'rebill'
])

const PAYMENT_ACTIVITY_STATUSES = Object.freeze([
  'processing',
  'in_process',
  'in_mediation',
  'authorized',
  'captured',
  'accredited',
  'requires_action',
  'requires_payment_method',
  'requires_confirmation',
  'requires_capture',
  'pending_customer_charge',
  'sent',
  'paid',
  'registered',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'approved',
  'failed',
  'failure',
  'declined',
  'rejected',
  'error',
  'refunded',
  'chargeback',
  'charged_back',
  'disputed'
])

const NAMING_KEYS = Object.freeze(['name', 'title', 'description', 'termsNotes'])

function cleanString(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = value ? JSON.parse(value) : fallback
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function createHttpError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key)
}

function namingValue(input, key, fallback, maxLength, { allowEmpty = false } = {}) {
  if (!hasOwn(input, key)) return fallback
  const value = cleanString(input[key], maxLength)
  if (!allowEmpty && !value) {
    throw createHttpError(key === 'name'
      ? 'El nombre del plan no puede quedar vacío.'
      : 'El título de la factura no puede quedar vacío.')
  }
  return value
}

function paymentTitle(title, sequence, totalPayments, provider) {
  if (provider === 'offline') {
    return totalPayments > 1 ? `${title} - Pago ${sequence} de ${totalPayments}` : title
  }
  const safeTotal = totalPayments > 0 ? totalPayments : Math.max(sequence, 1)
  return `${title} - Pago ${sequence}/${safeTotal}`
}

function activityStatusPlaceholders() {
  return PAYMENT_ACTIVITY_STATUSES.map(() => '?').join(', ')
}

async function loadNamingContext(queryable, flowId) {
  const flow = await queryable.get('SELECT * FROM payment_flows WHERE id = ? LIMIT 1', [flowId])
  if (!flow || !LOCAL_PAYMENT_PLAN_PROVIDERS.has(cleanString(flow.payment_provider, 40).toLowerCase())) {
    throw createHttpError('Plan de pago local no encontrado.', 404)
  }

  const mirror = await queryable.get('SELECT * FROM payment_plans WHERE id = ? LIMIT 1', [flowId])
  const metadata = parseJson(flow.metadata)
  const raw = parseJson(mirror?.raw_json)
  const planName = cleanString(metadata.planName || flow.concept || mirror?.name || 'Plan de pago', 300)
  const invoiceTitle = cleanString(metadata.invoiceTitle || mirror?.title || planName, 300)
  const invoiceDescription = cleanString(metadata.invoiceDescription || mirror?.description || invoiceTitle, 1000)
  const termsNotes = cleanString(metadata.termsNotes ?? raw.termsNotes ?? '', 12000)

  return {
    flow,
    mirror,
    metadata,
    raw,
    naming: { planName, invoiceTitle, invoiceDescription, termsNotes }
  }
}

function resolveRequestedNaming(context, input = {}) {
  const current = context.naming
  const planName = namingValue(input, 'name', current.planName, 300)
  const shouldFollowLegacyName = hasOwn(input, 'name')
    && !hasOwn(input, 'title')
    && current.invoiceTitle === current.planName
  const invoiceTitle = namingValue(
    input,
    'title',
    shouldFollowLegacyName ? planName : current.invoiceTitle,
    300
  )
  const shouldFollowInvoiceTitle = !hasOwn(input, 'description')
    && current.invoiceDescription === current.invoiceTitle
    && (hasOwn(input, 'title') || shouldFollowLegacyName)
  const invoiceDescription = namingValue(
    input,
    'description',
    shouldFollowInvoiceTitle ? invoiceTitle : current.invoiceDescription,
    1000,
    { allowEmpty: true }
  )
  const termsNotes = namingValue(input, 'termsNotes', current.termsNotes, 12000, { allowEmpty: true })
  const next = { planName, invoiceTitle, invoiceDescription, termsNotes }
  const changed = Object.keys(next).some(key => next[key] !== current[key])
  return { current, next, changed }
}

async function getPaymentPlanActivity(queryable, flowId) {
  const placeholders = activityStatusPlaceholders()
  const row = await queryable.get(
    `SELECT
       (SELECT COUNT(*)
        FROM payment_flows f
        WHERE f.id = ?
          AND LOWER(COALESCE(f.first_payment_status, '')) IN (${placeholders})) AS first_activity,
       (SELECT COUNT(*)
        FROM installment_payments i
        WHERE i.flow_id = ?
          AND LOWER(COALESCE(i.status, '')) IN (${placeholders})) AS installment_activity,
       (SELECT COUNT(*)
        FROM payments p
        WHERE (
          p.id = (SELECT first_payment_invoice_id FROM payment_flows WHERE id = ?)
          OR EXISTS (
            SELECT 1 FROM installment_payments i
            WHERE i.flow_id = ? AND i.payment_id = p.id
          )
        )
          AND (
            LOWER(COALESCE(p.status, '')) IN (${placeholders})
            OR p.sent_at IS NOT NULL
            OR p.paid_at IS NOT NULL
          )) AS payment_activity,
       (SELECT COUNT(*)
        FROM payment_automation_dispatches d
        WHERE LOWER(COALESCE(d.status, '')) IN ('sent', 'delivered', 'completed')
          AND EXISTS (
            SELECT 1 FROM payments p
            WHERE p.id = d.payment_id
              AND (
                p.id = (SELECT first_payment_invoice_id FROM payment_flows WHERE id = ?)
                OR EXISTS (
                  SELECT 1 FROM installment_payments i
                  WHERE i.flow_id = ? AND i.payment_id = p.id
                )
              )
          )) AS reminder_activity`,
    [
      flowId, ...PAYMENT_ACTIVITY_STATUSES,
      flowId, ...PAYMENT_ACTIVITY_STATUSES,
      flowId, flowId, ...PAYMENT_ACTIVITY_STATUSES,
      flowId, flowId
    ]
  )

  return {
    firstPayment: Number(row?.first_activity || 0),
    installments: Number(row?.installment_activity || 0),
    payments: Number(row?.payment_activity || 0),
    reminders: Number(row?.reminder_activity || 0),
    hasActivity: Number(row?.first_activity || 0)
      + Number(row?.installment_activity || 0)
      + Number(row?.payment_activity || 0)
      + Number(row?.reminder_activity || 0) > 0
  }
}

export function hasPaymentPlanNamingInput(input = {}) {
  return NAMING_KEYS.some(key => hasOwn(input, key))
}

export async function assertPaymentPlanNamingChangeAllowed(flowId, input = {}) {
  if (!hasPaymentPlanNamingInput(input)) return { changed: false, hasActivity: false }
  const id = cleanString(flowId, 200)
  const context = await loadNamingContext(db, id)
  const requested = resolveRequestedNaming(context, input)
  if (!requested.changed) return { changed: false, hasActivity: false, ...requested }

  const activity = await getPaymentPlanActivity(db, id)
  if (activity.hasActivity) {
    throw createHttpError('El nombre ya no puede cambiar porque el plan tuvo un cobro, un intento de cobro o un recordatorio enviado.', 409)
  }

  return { changed: true, ...activity, ...requested }
}

export async function updatePaymentPlanNaming(flowId, input = {}) {
  const id = cleanString(flowId, 200)
  if (!id) throw createHttpError('Plan de pago requerido.')
  if (!hasPaymentPlanNamingInput(input)) throw createHttpError('Indica el nombre del plan o el título de la factura.')

  return db.transaction(async (tx) => {
    const context = await loadNamingContext(tx, id)
    const requested = resolveRequestedNaming(context, input)
    if (!requested.changed) return context.mirror

    const activity = await getPaymentPlanActivity(tx, id)
    if (activity.hasActivity) {
      throw createHttpError('El nombre ya no puede cambiar porque el plan tuvo un cobro, un intento de cobro o un recordatorio enviado.', 409)
    }

    const originalState = context.flow.current_state ?? null
    const claim = await tx.run(
      `UPDATE payment_flows
       SET current_state = 'editing', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND payment_provider = ? AND COALESCE(current_state, '') = COALESCE(?, '')`,
      [id, context.flow.payment_provider, originalState]
    )
    if (Number(claim?.changes || 0) !== 1) {
      throw createHttpError('El plan cambió mientras lo editabas. Actualiza y vuelve a intentarlo.', 409)
    }

    const activityAfterClaim = await getPaymentPlanActivity(tx, id)
    if (activityAfterClaim.hasActivity) {
      throw createHttpError('El nombre ya no puede cambiar porque el plan tuvo un cobro, un intento de cobro o un recordatorio enviado.', 409)
    }

    const installments = await tx.all(
      `SELECT id, sequence, payment_id
       FROM installment_payments
       WHERE flow_id = ?
       ORDER BY sequence ASC, id ASC`,
      [id]
    )
    const hasFirstPayment = Boolean(cleanString(context.flow.first_payment_invoice_id, 200))
    const totalPayments = installments.length + (hasFirstPayment ? 1 : 0)

    if (hasFirstPayment) {
      await tx.run(
        'UPDATE payments SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [
          paymentTitle(requested.next.invoiceTitle, 1, totalPayments, context.flow.payment_provider),
          paymentTitle(requested.next.invoiceDescription || requested.next.invoiceTitle, 1, totalPayments, context.flow.payment_provider),
          context.flow.first_payment_invoice_id
        ]
      )
    }

    for (const installment of installments) {
      if (!installment.payment_id) continue
      const sequence = Number(installment.sequence || 0) + (hasFirstPayment ? 1 : 0)
      await tx.run(
        'UPDATE payments SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [
          paymentTitle(requested.next.invoiceTitle, sequence, totalPayments, context.flow.payment_provider),
          paymentTitle(requested.next.invoiceDescription || requested.next.invoiceTitle, sequence, totalPayments, context.flow.payment_provider),
          installment.payment_id
        ]
      )
    }

    const nextMetadata = {
      ...context.metadata,
      planName: requested.next.planName,
      invoiceTitle: requested.next.invoiceTitle,
      invoiceDescription: requested.next.invoiceDescription,
      termsNotes: requested.next.termsNotes
    }
    const nextRaw = {
      ...context.raw,
      name: requested.next.planName,
      title: requested.next.invoiceTitle,
      description: requested.next.invoiceDescription,
      termsNotes: requested.next.termsNotes
    }

    await tx.run(
      `UPDATE payment_flows
       SET concept = ?, metadata = ?, current_state = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND current_state = 'editing'`,
      [requested.next.planName, JSON.stringify(nextMetadata), originalState, id]
    )
    await tx.run(
      `UPDATE payment_plans
       SET name = ?, title = ?, description = ?, raw_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        requested.next.planName,
        requested.next.invoiceTitle,
        requested.next.invoiceDescription,
        JSON.stringify(nextRaw),
        id
      ]
    )

    return tx.get('SELECT * FROM payment_plans WHERE id = ? LIMIT 1', [id])
  })
}

export function paymentPlanNamingFromMetadata(flow = {}, metadata = {}) {
  const planName = cleanString(metadata.planName || flow.concept || 'Plan de pagos', 300)
  const invoiceTitle = cleanString(metadata.invoiceTitle || planName, 300)
  const invoiceDescription = cleanString(metadata.invoiceDescription || invoiceTitle, 1000)
  const termsNotes = cleanString(metadata.termsNotes ?? '', 12000)
  return { planName, invoiceTitle, invoiceDescription, termsNotes }
}
