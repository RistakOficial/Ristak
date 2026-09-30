import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { paymentTaxSnapshotForTotal } from '../utils/paymentTaxSnapshot.js'
import { normalizeGigstackPaymentMode } from './gigstackApiService.js'

const paid = row => ['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'].includes(row?.status)
const conflict = message => Object.assign(new Error(message), { status: 409, code: 'payment_fiscal_tax_recovery_conflict' })
const metadata = row => {
  const value = JSON.parse(row?.metadata_json || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw conflict('Metadata fiscal inválida.')
  return value
}

async function loadRecovery(queryable, paymentId, sourcePaymentId) {
  if (paymentId === sourcePaymentId) throw conflict('El pago fuente debe ser otro pago confirmado del mismo plan.')
  const target = await queryable.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  const source = await queryable.get('SELECT * FROM payments WHERE id = ?', [sourcePaymentId])
  const targetMetadata = metadata(target)
  const sourceMetadata = metadata(source)
  const mode = normalizeGigstackPaymentMode(target?.payment_mode)
  const planId = targetMetadata.paymentPlan?.flowId
  if (!paid(target) || !paid(source) || !mode || normalizeGigstackPaymentMode(source.payment_mode) !== mode
    || !target.contact_id || target.contact_id !== source.contact_id || target.currency !== source.currency
    || !planId || planId !== sourceMetadata.paymentPlan?.flowId
    || sourceMetadata.applyTax === false || sourceMetadata.tax?.enabled !== true) {
    throw conflict('La reparación exige pagos confirmados del mismo contacto, plan, moneda y ambiente, con impuesto explícito en el pago fuente.')
  }
  const flow = await queryable.get('SELECT id, contact_id, currency, first_payment_invoice_id FROM payment_flows WHERE id = ?', [planId])
  const installments = await queryable.all('SELECT payment_id FROM installment_payments WHERE flow_id = ?', [planId])
  const related = new Set([flow?.first_payment_invoice_id, ...installments.map(row => row.payment_id)])
  if (!flow || flow.contact_id !== target.contact_id || flow.currency !== target.currency
    || !related.has(paymentId) || !related.has(sourcePaymentId)) throw conflict('Los pagos no pertenecen al plan canónico indicado.')
  if (targetMetadata.applyTax === false || (targetMetadata.tax != null && targetMetadata.fiscalTaxRecovery?.sourcePaymentId !== sourcePaymentId)) {
    throw conflict('El pago ya conserva una elección fiscal explícita; no se sobrescribirá.')
  }
  const fiscal = targetMetadata.gigstack || {}
  const job = await queryable.get('SELECT status, remote_payment_id, lease_until_at_ms FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
  if (Object.keys(fiscal).length || job?.remote_payment_id || job?.status === 'processing' || job?.status === 'registered') {
    throw conflict('El pago ya tiene actividad fiscal; requiere conciliación, no reconstruir su impuesto.')
  }
  const tax = sourceMetadata.tax
  const round = value => Math.round(Number(value) * 100) / 100
  if (!Number.isFinite(Number(tax.rateValue)) || Number(tax.rateValue) < 0
    || round(tax.totalAmount) !== round(source.amount)
    || round(Number(tax.subtotalAmount) + Number(tax.taxAmount)) !== round(source.amount)) {
    throw conflict('El desglose fiscal del pago fuente no coincide con su importe confirmado.')
  }
  return { target, source, targetMetadata, tax: paymentTaxSnapshotForTotal(tax, target.amount), mode, planId }
}

function preview(context) {
  const { target, source, tax, mode, planId } = context
  return {
    paymentId: target.id, sourcePaymentId: source.id, planId, mode, currency: target.currency,
    amount: Number(target.amount), subtotalAmount: tax.subtotalAmount, taxAmount: tax.taxAmount,
    rateValue: tax.rateValue, calculationMode: tax.calculationMode,
    previewRevision: crypto.createHash('sha256').update(JSON.stringify({ target, source, tax })).digest('hex')
  }
}

// An explicit administrative repair of a missing snapshot, not a new charge or
// a blanket tax inference for historical payments. Existing elections win.
export async function recoverPaymentFiscalTax(paymentId, sourcePaymentId, { dryRun = true, expectedPreviewRevision, actorId } = {}) {
  if (dryRun !== false) return { dryRun: true, ...preview(await loadRecovery(db, paymentId, sourcePaymentId)) }
  return db.transaction(async tx => {
    const context = await loadRecovery(tx, paymentId, sourcePaymentId)
    const result = preview(context)
    if (context.targetMetadata.tax != null) return { dryRun: false, changed: false, ...result }
    if (expectedPreviewRevision !== result.previewRevision) throw conflict('Revisa la vista previa actual antes de restaurar el impuesto.')
    const next = {
      ...context.targetMetadata, tax: context.tax,
      fiscalTaxRecovery: { sourcePaymentId, actorId: String(actorId || ''), restoredAt: new Date().toISOString() }
    }
    const updated = await tx.run(`UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ? AND contact_id = ? AND amount = ? AND currency = ? AND payment_mode = ?
      AND COALESCE(metadata_json, '') = ?`, [JSON.stringify(next), paymentId, context.target.status,
      context.target.contact_id, context.target.amount, context.target.currency, context.target.payment_mode, context.target.metadata_json || ''])
    if (Number(updated?.changes || 0) !== 1) throw conflict('El pago cambió durante la reparación; no se aplicó ningún cambio.')
    return { dryRun: false, changed: true, ...result }
  })
}
