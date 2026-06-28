import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { deleteTransaction, voidTransaction } from '../src/controllers/transactionsController.js'

function suffix(label = 'payment_safety') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
    },
    send(payload) {
      this.payload = payload
      return this
    }
  }
}

async function cleanup(ids) {
  await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payment_plans WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run(
    `DELETE FROM payments
     WHERE id IN (?, ?, ?, ?) OR contact_id = ?`,
    [ids.paidPaymentId, ids.pendingLinkPaymentId, ids.planPaymentId, ids.voidPaymentId, ids.contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

async function seedSafetyRows(label = 'payment_safety') {
  const idSuffix = suffix(label)
  const ids = {
    contactId: `contact_${idSuffix}`,
    paidPaymentId: `payment_paid_${idSuffix}`,
    pendingLinkPaymentId: `payment_link_${idSuffix}`,
    planPaymentId: `payment_plan_${idSuffix}`,
    voidPaymentId: `payment_void_${idSuffix}`,
    flowId: `stripe_flow_${idSuffix}`,
    installmentId: `stripe_installment_${idSuffix}`
  }

  await cleanup(ids)

  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, 'Cliente seguridad pagos', ?, '+5215551112222', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.contactId, `${ids.contactId}@example.test`]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, paid_at, date, created_at, updated_at
    ) VALUES (?, ?, 500, 'MXN', 'paid', 'cash', 'live', 'manual', 'REC-1', 'Pago pagado', 'Pago pagado',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.paidPaymentId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, public_payment_id, payment_url, date, created_at, updated_at
    ) VALUES (?, ?, 800, 'MXN', 'sent', 'stripe', 'test', 'stripe', 'Link pendiente', 'Link pendiente',
      'pay_safety_public', 'https://example.test/pay/pay_safety_public', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.pendingLinkPaymentId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, total_amount, currency, concept, payment_type,
      payment_provider, current_state, state_history, created_at, updated_at
    ) VALUES (?, ?, 'Cliente seguridad pagos', 1000, 'MXN', 'Plan protegido', 'partial',
      'stripe', 'installment_plan_active', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.flowId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, 1000, 'MXN', 'scheduled', 'stripe_scheduled_card', 'test', 'stripe',
      'Pago plan protegido', 'Pago plan protegido', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.planPaymentId,
      ids.contactId,
      JSON.stringify({
        paymentPlan: {
          flowId: ids.flowId,
          installmentId: ids.installmentId,
          trigger: 'scheduled_installment'
        }
      })
    ]
  )

  await db.run(
    `INSERT INTO installment_payments (
      id, flow_id, sequence, amount, due_date, frequency, payment_method,
      automatic, status, payment_id, created_at, updated_at
    ) VALUES (?, ?, 1, 1000, '2099-01-01', 'monthly', 'stripe_saved_card', 1, 'scheduled', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.installmentId, ids.flowId, ids.planPaymentId]
  )

  await db.run(
    `INSERT INTO payment_plans (
      id, contact_id, contact_name, name, title, status, total, currency,
      source, schedule_json, raw_json, created_at, updated_at
    ) VALUES (?, ?, 'Cliente seguridad pagos', 'Plan protegido', 'Plan protegido', 'active', 1000, 'MXN',
      'stripe', '{}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.flowId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, date, created_at, updated_at
    ) VALUES (?, ?, 300, 'MXN', 'paid', 'cash', 'live', 'manual', 'Pago no anulable', 'Pago no anulable',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.voidPaymentId, ids.contactId]
  )

  return ids
}

test('seguridad pagos: no borra una transacción pagada', async () => {
  const ids = await seedSafetyRows('paid_delete')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /actividad de pago|no se puede borrar/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una transacción pagada cuando es de prueba', async () => {
  const ids = await seedSafetyRows('paid_test_delete')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'test',
           metadata_json = ?
       WHERE id = ?`,
      [JSON.stringify({ paymentMode: 'test' }), ids.paidPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: archiva un link live pendiente sin borrar la fila', async () => {
  const ids = await seedSafetyRows('pending_link')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live'
       WHERE id = ?`,
      [ids.pendingLinkPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT status, public_payment_id, payment_url FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
    assert.equal(row.status, 'deleted')
    assert.equal(row.public_payment_id, 'pay_safety_public')
    assert.equal(row.payment_url, 'https://example.test/pay/pay_safety_public')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra un link test pendiente aunque tenga URL externa', async () => {
  const ids = await seedSafetyRows('pending_link_test')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
    assert.equal(row, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no borra una transacción live individual ligada a un plan', async () => {
  const ids = await seedSafetyRows('plan_link')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live'
       WHERE id = ?`,
      [ids.planPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.planPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /plan de pagos/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.planPaymentId])
    assert.equal(row.status, 'scheduled')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una transacción test ligada a un plan y limpia la parcialidad', async () => {
  const ids = await seedSafetyRows('plan_link_test')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.planPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.planPaymentId])
    const installment = await db.get('SELECT status, payment_id FROM installment_payments WHERE id = ?', [ids.installmentId])

    assert.equal(row, null)
    assert.equal(installment.status, 'deleted')
    assert.equal(installment.payment_id, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no anula un pago ya completado', async () => {
  const ids = await seedSafetyRows('void_paid')

  try {
    const res = createResponse()
    await voidTransaction({ params: { id: ids.voidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /reembolso/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.voidPaymentId])
    assert.equal(row.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})
