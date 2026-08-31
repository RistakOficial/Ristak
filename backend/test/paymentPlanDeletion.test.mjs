import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { actionInvoiceSchedule } from '../src/controllers/highlevelController.js'
import { applyStripePaymentPlanAction } from '../src/services/stripePaymentService.js'
import { applyConektaPaymentPlanAction } from '../src/services/conektaPaymentService.js'
import { applyRebillPaymentPlanAction } from '../src/services/rebillPaymentService.js'
import { applyMercadoPagoPaymentPlanAction } from '../src/services/mercadoPagoPaymentService.js'
import { applyOfflinePaymentPlanAction } from '../src/services/offlinePaymentPlanService.js'
import {
  getPaymentPlanAuditSummary,
  hardDeleteRemovablePaymentPlan
} from '../src/services/paymentRecordSafetyService.js'

const providerActions = {
  stripe: applyStripePaymentPlanAction,
  conekta: applyConektaPaymentPlanAction,
  rebill: applyRebillPaymentPlanAction,
  mercadopago: applyMercadoPagoPaymentPlanAction,
  offline: applyOfflinePaymentPlanAction
}

function uniqueId(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function cleanup(prefix) {
  await db.run('DELETE FROM payment_automation_dispatches WHERE payment_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM installment_payments WHERE flow_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payment_plans WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payment_plan_creation_requests WHERE flow_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

async function seedLocalPlan({ prefix, provider, paymentStatus = 'scheduled', installmentStatus = paymentStatus }) {
  const contactId = `${prefix}_${provider}_contact`
  const flowId = `${prefix}_${provider}_flow`
  const paymentId = `${prefix}_${provider}_payment`
  const installmentId = `${prefix}_${provider}_installment`

  await db.run(
    `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
     VALUES (?, 'Plan deletion test', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  await db.run(
    `INSERT INTO payment_flows (
       id, contact_id, contact_name, total_amount, currency, concept,
       payment_type, payment_provider, current_state, state_history,
       first_payment_amount, first_payment_status, metadata, created_at, updated_at
     ) VALUES (?, ?, 'Plan deletion test', 300, 'MXN', 'Plan sin cobros',
       'partial', ?, 'inactive', '[]', 0, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [flowId, contactId, provider, JSON.stringify({ paymentMode: 'live' })]
  )
  await db.run(
    `INSERT INTO payments (
       id, contact_id, amount, currency, status, payment_method, payment_mode,
       payment_provider, title, description, public_payment_id, payment_url,
       metadata_json, date, created_at, updated_at
     ) VALUES (?, ?, 300, 'MXN', ?, ?, 'live', ?, 'Pago programado',
       'Pago programado', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      paymentId,
      contactId,
      paymentStatus,
      `${provider}_saved_card`,
      provider,
      `${prefix}_${provider}_public`,
      `https://example.test/pay/${prefix}_${provider}_public`,
      JSON.stringify({ paymentPlan: { flowId, installmentId } })
    ]
  )
  await db.run(
    `INSERT INTO installment_payments (
       id, flow_id, sequence, amount, due_date, frequency, payment_method,
       automatic, status, payment_id, created_at, updated_at
     ) VALUES (?, ?, 1, 300, '2099-01-01', 'monthly', ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [installmentId, flowId, `${provider}_saved_card`, installmentStatus, paymentId]
  )
  await db.run(
    `INSERT INTO payment_plans (
       id, contact_id, contact_name, name, title, status, total, currency,
       source, schedule_json, raw_json, created_at, updated_at
     ) VALUES (?, ?, 'Plan deletion test', 'Plan sin cobros', 'Plan sin cobros',
       'inactive', 300, 'MXN', ?, '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [flowId, contactId, provider, JSON.stringify({ provider, liveMode: true })]
  )

  return { contactId, flowId, paymentId, installmentId }
}

test('planes live sin transacciones se borran aunque tengan cargos programados', async () => {
  const prefix = uniqueId('payment_plan_unused_delete')

  try {
    for (const [provider, applyAction] of Object.entries(providerActions)) {
      const ids = await seedLocalPlan({ prefix, provider })
      const result = await applyAction(ids.flowId, 'delete')

      assert.equal(result.deleted, true, `${provider} debe confirmar el borrado`)
      assert.equal(await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId]), null)
      assert.equal(await db.get('SELECT id FROM payment_flows WHERE id = ?', [ids.flowId]), null)
      assert.equal(await db.get('SELECT id FROM installment_payments WHERE id = ?', [ids.installmentId]), null)
      assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [ids.paymentId]), null)
    }
  } finally {
    await cleanup(prefix)
  }
})

test('un plan live con una transacción registrada conserva todo su historial', async () => {
  const prefix = uniqueId('payment_plan_paid_guard')

  try {
    const ids = await seedLocalPlan({
      prefix,
      provider: 'stripe',
      paymentStatus: 'paid',
      installmentStatus: 'paid'
    })

    await assert.rejects(
      () => applyStripePaymentPlanAction(ids.flowId, 'delete'),
      error => Number(error?.status) === 422 && /actividad financiera|pagos|intentos/i.test(error.message)
    )

    assert.ok(await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId]))
    assert.ok(await db.get('SELECT id FROM payments WHERE id = ?', [ids.paymentId]))
  } finally {
    await cleanup(prefix)
  }
})

test('un plan offline con una transacción registrada conserva todo su historial', async () => {
  const prefix = uniqueId('payment_plan_offline_paid_guard')

  try {
    const ids = await seedLocalPlan({
      prefix,
      provider: 'offline',
      paymentStatus: 'paid',
      installmentStatus: 'paid'
    })

    await assert.rejects(
      () => applyOfflinePaymentPlanAction(ids.flowId, 'delete'),
      error => Number(error?.status) === 422 && /pagos|intentos|actividad financiera/i.test(error.message)
    )

    assert.ok(await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId]))
    assert.ok(await db.get('SELECT id FROM payments WHERE id = ?', [ids.paymentId]))
  } finally {
    await cleanup(prefix)
  }
})

test('un plan offline ya marcado como eliminado y sin cobros se purga al reintentar', async () => {
  const prefix = uniqueId('payment_plan_offline_stale_delete')

  try {
    const ids = await seedLocalPlan({
      prefix,
      provider: 'offline',
      paymentStatus: 'sent',
      installmentStatus: 'sent'
    })
    await db.run(
      "UPDATE payment_flows SET current_state = 'offline_plan_deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [ids.flowId]
    )
    await db.run(
      "UPDATE payment_plans SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [ids.flowId]
    )
    await db.run(
      'UPDATE payments SET sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [ids.paymentId]
    )

    const result = await applyOfflinePaymentPlanAction(ids.flowId, 'delete')

    assert.equal(result.deleted, true)
    assert.equal(await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId]), null)
    assert.equal(await db.get('SELECT id FROM payment_flows WHERE id = ?', [ids.flowId]), null)
    assert.equal(await db.get('SELECT id FROM installment_payments WHERE id = ?', [ids.installmentId]), null)
    assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [ids.paymentId]), null)
  } finally {
    await cleanup(prefix)
  }
})

test('un estado financiero desconocido falla cerrado y conserva el plan', async () => {
  const prefix = uniqueId('payment_plan_unknown_activity_guard')

  try {
    const ids = await seedLocalPlan({
      prefix,
      provider: 'stripe',
      installmentStatus: 'provider_review'
    })

    const audit = await getPaymentPlanAuditSummary(ids.flowId)
    assert.equal(audit.hasLedgerActivity, true)

    const deletion = await hardDeleteRemovablePaymentPlan(ids.flowId)
    assert.equal(deletion.deleted, false)
    assert.equal(deletion.reason, 'financial_activity')
    assert.ok(await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId]))
  } finally {
    await cleanup(prefix)
  }
})

test('un espejo HighLevel ya eliminado y sin facturas se purga sin volver a llamar al proveedor', async () => {
  const prefix = uniqueId('payment_plan_ghl_stale')
  const scheduleId = `${prefix}_schedule`

  try {
    await db.run(
      `INSERT INTO payment_plans (
         id, ghl_schedule_id, name, title, status, total, currency, source,
         schedule_json, raw_json, created_at, updated_at
       ) VALUES (?, ?, 'Plan HighLevel eliminado', 'Plan HighLevel eliminado',
         'deleted', 300, 'MXN', 'ghl', '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [scheduleId, scheduleId, JSON.stringify({ status: 'deleted', liveMode: true, invoices: [] })]
    )

    const res = createResponse()
    await actionInvoiceSchedule(
      { params: { scheduleId }, body: { action: 'delete' } },
      res
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.deleted, true)
    assert.equal(await db.get('SELECT id FROM payment_plans WHERE id = ?', [scheduleId]), null)
  } finally {
    await cleanup(prefix)
  }
})

test('las facturas generadas por HighLevel cuentan como actividad y bloquean el borrado', async () => {
  const prefix = uniqueId('payment_plan_ghl_invoice_guard')
  const scheduleId = `${prefix}_schedule`

  try {
    await db.run(
      `INSERT INTO payment_plans (
         id, ghl_schedule_id, name, title, status, total, currency, source,
         schedule_json, raw_json, created_at, updated_at
       ) VALUES (?, ?, 'Plan HighLevel con cobro', 'Plan HighLevel con cobro',
         'deleted', 300, 'MXN', 'ghl', '{}', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        scheduleId,
        scheduleId,
        JSON.stringify({
          status: 'deleted',
          liveMode: true,
          invoices: [{ _id: `${prefix}_invoice`, status: 'paid', amountPaid: 300 }]
        })
      ]
    )

    const audit = await getPaymentPlanAuditSummary(scheduleId)
    assert.equal(audit.hasLedgerActivity, true)
    assert.equal(audit.providerTransactions.length, 1)

    const directDeletion = await hardDeleteRemovablePaymentPlan(scheduleId)
    assert.equal(directDeletion.deleted, false)
    assert.equal(directDeletion.reason, 'financial_activity')

    const res = createResponse()
    await actionInvoiceSchedule(
      { params: { scheduleId }, body: { action: 'delete' } },
      res
    )

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /cobros o facturas generadas/i)
    assert.ok(await db.get('SELECT id FROM payment_plans WHERE id = ?', [scheduleId]))
  } finally {
    await cleanup(prefix)
  }
})
