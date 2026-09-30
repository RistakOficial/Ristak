import { db } from '../config/database.js'
import crypto from 'node:crypto'
import { paymentTaxSnapshotForTotal } from '../utils/paymentTaxSnapshot.js'
import { normalizeGigstackPaymentMode } from './gigstackInvoiceService.js'

const UNPAID_STATUSES = new Set(['scheduled', 'pending', 'waiting_card_authorization'])
const PLAN_STATES = new Set(['installment_plan_active', 'paused', 'waiting_card_authorization'])

function parseMetadata(value) {
  const parsed = value ? JSON.parse(value) : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw conflict('Metadata fiscal inválida.')
  return parsed
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409, code: 'payment_plan_tax_recovery_conflict' })
}

function hasFiscalRecord(metadata) {
  const fiscal = metadata.gigstack
  return Boolean(fiscal && Object.keys(fiscal).length)
}

async function loadRecovery(queryable, planId, sourcePaymentId) {
  const flow = await queryable.get('SELECT * FROM payment_flows WHERE id = ?', [planId])
  if (!flow || flow.payment_provider !== 'stripe' || !PLAN_STATES.has(flow.current_state)) {
    throw conflict('La reparación requiere un plan Stripe activo, pausado o esperando autorización.')
  }
  const source = await queryable.get('SELECT * FROM payments WHERE id = ?', [sourcePaymentId])
  const sourceMetadata = parseMetadata(source?.metadata_json)
  const mode = normalizeGigstackPaymentMode(source?.payment_mode)
  if (!source || source.contact_id !== flow.contact_id || source.currency !== flow.currency
    || sourceMetadata.paymentPlan?.flowId !== flow.id || !mode
    || !['paid', 'succeeded'].includes(source.status)
    || sourceMetadata.applyTax === false || sourceMetadata.tax?.enabled !== true) {
    throw conflict('El impuesto debe proceder de un pago confirmado del mismo contacto, plan y moneda.')
  }
  const metadata = parseMetadata(flow.metadata)
  const tax = paymentTaxSnapshotForTotal(sourceMetadata.tax, flow.total_amount)
  if (metadata.applyTax === false || (metadata.tax != null && metadata.taxRecovery?.sourcePaymentId !== sourcePaymentId)) {
    throw conflict('El plan ya conserva una elección fiscal explícita; esta reparación no la sobrescribe.')
  }
  const installments = await queryable.all(
    `SELECT i.id AS installment_id, i.status AS installment_status, i.amount AS installment_amount,
            p.id, p.contact_id, p.amount, p.currency, p.payment_mode, p.status, p.metadata_json
     FROM installment_payments i LEFT JOIN payments p ON p.id = i.payment_id WHERE i.flow_id = ? ORDER BY i.sequence, i.id`,
    [planId]
  )
  if (installments.some(row => ['processing', 'in_process', 'pending_customer_charge'].includes(row.status)
    || ['processing', 'in_process', 'pending_customer_charge'].includes(row.installment_status))) {
    throw conflict('Hay una parcialidad en proceso de cobro; espera a que termine antes de reparar impuestos.')
  }
  const targets = []
  for (const row of installments) {
    if (!UNPAID_STATUSES.has(row.installment_status)) continue
    if (!row.id || !UNPAID_STATUSES.has(row.status) || row.contact_id !== flow.contact_id
      || row.currency !== flow.currency || normalizeGigstackPaymentMode(row.payment_mode) !== mode
      || Number(row.amount) !== Number(row.installment_amount)) {
      throw conflict('Una parcialidad no coincide con su pago canónico; requiere revisión.')
    }
    const paymentMetadata = parseMetadata(row.metadata_json)
    if (paymentMetadata.paymentPlan?.flowId !== flow.id || paymentMetadata.paymentPlan?.installmentId !== row.installment_id) {
      throw conflict('La relación entre la parcialidad y el plan no coincide.')
    }
    if (paymentMetadata.applyTax === false || (paymentMetadata.tax != null && paymentMetadata.taxRecovery?.sourcePaymentId !== sourcePaymentId)
      || hasFiscalRecord(paymentMetadata)) {
      throw conflict('Una parcialidad pendiente ya tiene una elección o actividad fiscal; no se sobrescribirá.')
    }
    if (paymentMetadata.tax != null) continue
    targets.push({ row, metadata: paymentMetadata, tax: paymentTaxSnapshotForTotal(tax, row.amount) })
  }
  return { flow, metadata, tax, targets, mode }
}

// Explicit repair only. Never infer a plan's tax from today's account settings
// or apply this automatically to historical plans or already paid installments.
export async function recoverPaymentPlanTax(planId, sourcePaymentId, { dryRun = true, actorId, expectedPreviewRevision } = {}) {
  const preview = ({ flow, targets, mode, tax }) => ({
    planId: flow.id, sourcePaymentId, mode, currency: flow.currency,
    previewRevision: crypto.createHash('sha256').update(JSON.stringify({
      planId: flow.id, sourcePaymentId, mode, tax, metadata: flow.metadata,
      payments: targets.map(({ row }) => row)
    })).digest('hex'),
    payments: targets.map(({ row, tax }) => ({
      paymentId: row.id, amount: Number(row.amount),
      subtotalAmount: tax.subtotalAmount, taxAmount: tax.taxAmount,
      rateValue: tax.rateValue, calculationMode: tax.calculationMode
    }))
  })
  if (dryRun !== false) return { dryRun: true, ...preview(await loadRecovery(db, planId, sourcePaymentId)) }

  return db.transaction(async (tx) => {
    const context = await loadRecovery(tx, planId, sourcePaymentId)
    if (!context.targets.length) return { dryRun: false, changed: false, ...preview(context) }
    if (expectedPreviewRevision !== preview(context).previewRevision) throw conflict('Consulta la vista previa y confirma su previewRevision antes de aplicar la reparación.')
    const { flow, metadata, tax, targets } = context
    const audit = { sourcePaymentId, actorId: String(actorId || ''), restoredAt: new Date().toISOString() }
    const claimed = await tx.run(
      `UPDATE payment_flows SET current_state = 'editing'
       WHERE id = ? AND current_state = ? AND COALESCE(metadata, '') = ?`,
      [flow.id, flow.current_state, flow.metadata || '']
    )
    if (Number(claimed?.changes || 0) !== 1) throw conflict('El plan cambió durante la reparación. Vuelve a consultar.')
    for (const target of targets) {
      const { row } = target
      const updated = await tx.run(
        `UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = ? AND amount = ? AND currency = ? AND payment_mode = ?
           AND COALESCE(metadata_json, '') = ?
           AND EXISTS (SELECT 1 FROM installment_payments i WHERE i.id = ? AND i.payment_id = payments.id AND i.status = ?)`,
        [JSON.stringify({ ...target.metadata, tax: target.tax, taxRecovery: audit }),
          row.id, row.status, row.amount, row.currency, row.payment_mode, row.metadata_json || '',
          row.installment_id, row.installment_status]
      )
      if (Number(updated?.changes || 0) !== 1) throw conflict('La parcialidad cambió durante la reparación; no se aplicó ningún cambio.')
    }
    await tx.run(
      `UPDATE payment_flows SET metadata = ?, current_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify({ ...metadata, tax, taxRecovery: audit }), flow.current_state, flow.id]
    )
    return { dryRun: false, changed: true, ...preview(context) }
  })
}
