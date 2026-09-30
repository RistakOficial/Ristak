import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { db } from '../src/config/database.js'
import { recoverPaymentPlanTax } from '../src/services/paymentPlanTaxRecoveryService.js'

async function fixture(run) {
  const id = crypto.randomUUID()
  const planId = `plan_${id}`
  const sourcePaymentId = `source_${id}`
  const paidId = `paid_${id}`
  const nextId = `next_${id}`
  const contactId = `contact_${id}`
  await db.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [contactId, 'Fiscal recovery fixture'])
  await db.run("INSERT INTO payment_flows (id, contact_id, total_amount, currency, concept, payment_provider, current_state, metadata) VALUES (?, ?, 2320, 'MXN', 'Legacy plan', 'stripe', 'installment_plan_active', '{}')", [planId, contactId])
  const tax = { enabled: true, taxName: 'IVA', rateValue: 16, rateType: 'percentage', calculationMode: 'inclusive', totalAmount: 25, subtotalAmount: 21.55, taxAmount: 3.45 }
  await db.run("INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, metadata_json) VALUES (?, ?, 25, 'MXN', 'paid', 'live', ?)", [sourcePaymentId, contactId, JSON.stringify({ tax, paymentPlan: { flowId: planId, trigger: 'card_setup' } })])
  for (const [index, paymentId] of [paidId, nextId].entries()) {
    const status = index === 0 ? 'paid' : 'scheduled'
    const installmentId = `installment_${paymentId}`
    await db.run("INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, payment_provider, due_date, metadata_json) VALUES (?, ?, 1160, 'MXN', ?, 'live', 'stripe', '2099-10-05 16:00:00', ?)", [paymentId, contactId, status, JSON.stringify({ paymentPlan: { flowId: planId, installmentId } })])
    await db.run("INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, status, payment_id) VALUES (?, ?, ?, 1160, '2099-10-05 16:00:00', ?, ?)", [installmentId, planId, index + 1, status, paymentId])
  }
  const read = async () => ({
    flow: await db.get('SELECT * FROM payment_flows WHERE id = ?', [planId]),
    payments: await db.all('SELECT * FROM payments WHERE id IN (?, ?, ?) ORDER BY id', [sourcePaymentId, paidId, nextId]),
    installments: await db.all('SELECT * FROM installment_payments WHERE flow_id = ? ORDER BY id', [planId])
  })
  try { await run({ planId, sourcePaymentId, paidId, nextId, read }) } finally {
    await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [planId])
    await db.run('DELETE FROM payments WHERE id IN (?, ?, ?)', [sourcePaymentId, paidId, nextId])
    await db.run('DELETE FROM payment_flows WHERE id = ?', [planId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

test('legacy tax repair previews without writes and preserves amounts, dates and paid history', async () => {
  await fixture(async ({ planId, sourcePaymentId, paidId, nextId, read }) => {
    const before = await read()
    const preview = await recoverPaymentPlanTax(planId, sourcePaymentId)
    assert.deepEqual(await read(), before)
    assert.deepEqual(preview.payments, [{ paymentId: nextId, amount: 1160, subtotalAmount: 1000, taxAmount: 160, rateValue: 16, calculationMode: 'inclusive' }])
    const result = await recoverPaymentPlanTax(planId, sourcePaymentId, { dryRun: false, actorId: 'admin_fixture', expectedPreviewHash: preview.previewHash })
    assert.equal(result.changed, true)
    const after = await read()
    assert.deepEqual(after.installments, before.installments)
    assert.equal(after.flow.current_state, before.flow.current_state)
    assert.equal(after.flow.total_amount, before.flow.total_amount)
    assert.equal(JSON.parse(after.flow.metadata).tax.totalAmount, 2320)
    for (const payment of after.payments) {
      const original = before.payments.find(row => row.id === payment.id)
      if (payment.id !== nextId) {
        assert.deepEqual(payment, original)
      } else {
        assert.deepEqual({ ...payment, metadata_json: original.metadata_json, updated_at: original.updated_at }, original)
        const metadata = JSON.parse(payment.metadata_json)
        assert.equal(metadata.tax.taxAmount, 160)
        assert.equal(metadata.taxRecovery.sourcePaymentId, sourcePaymentId)
        assert.equal(metadata.taxRecovery.actorId, 'admin_fixture')
      }
    }
    assert.equal(JSON.parse(after.payments.find(row => row.id === paidId).metadata_json).tax, undefined)
    assert.equal((await recoverPaymentPlanTax(planId, sourcePaymentId, { dryRun: false })).changed, false)
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM gigstack_invoice_jobs WHERE payment_id = ?', [nextId])).count, 0)
  })
})

test('legacy repair requires the reviewed preview and rejects a changed amount', async () => {
  await fixture(async ({ planId, sourcePaymentId, nextId, read }) => {
    const before = await read()
    await assert.rejects(() => recoverPaymentPlanTax(planId, sourcePaymentId, { dryRun: false }), /previewHash/)
    assert.deepEqual(await read(), before)
    const preview = await recoverPaymentPlanTax(planId, sourcePaymentId)
    await db.run('UPDATE payments SET amount = 2320 WHERE id = ?', [nextId])
    await db.run('UPDATE installment_payments SET amount = 2320 WHERE payment_id = ?', [nextId])
    const changed = await read()
    await assert.rejects(() => recoverPaymentPlanTax(planId, sourcePaymentId, { dryRun: false, expectedPreviewHash: preview.previewHash }), /previewHash/)
    assert.deepEqual(await read(), changed)
  })
})

test('legacy repair does not infer tax, overwrite explicit choices, or race a charge', async () => {
  for (const mutation of [
    async ({ sourcePaymentId }) => db.run("UPDATE payments SET metadata_json = '{}' WHERE id = ?", [sourcePaymentId]),
    async ({ planId }) => db.run("UPDATE payment_flows SET metadata = ? WHERE id = ?", [JSON.stringify({ tax: { enabled: false } }), planId]),
    async ({ nextId, planId }) => db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [JSON.stringify({ tax: { enabled: false }, paymentPlan: { flowId: planId, installmentId: `installment_${nextId}` } }), nextId]),
    async ({ nextId }) => db.run("UPDATE payments SET status = 'processing' WHERE id = ?", [nextId]),
    async ({ nextId }) => db.run("UPDATE payments SET payment_mode = 'test' WHERE id = ?", [nextId]),
    async ({ nextId }) => db.run("UPDATE payments SET currency = 'USD' WHERE id = ?", [nextId])
  ]) {
    await fixture(async (context) => {
      await mutation(context)
      const before = await context.read()
      await assert.rejects(() => recoverPaymentPlanTax(context.planId, context.sourcePaymentId), { code: 'payment_plan_tax_recovery_conflict' })
      assert.deepEqual(await context.read(), before)
    })
  }
})
