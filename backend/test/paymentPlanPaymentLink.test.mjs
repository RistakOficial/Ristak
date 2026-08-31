import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { ensurePaymentPlanPaymentLink } from '../src/controllers/transactionsController.js'

function uniquePrefix(label) {
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

function createRequest(paymentId) {
  return {
    params: { id: paymentId },
    protocol: 'https',
    headers: {
      host: 'app.example.test',
      'x-forwarded-proto': 'https'
    }
  }
}

async function cleanup(prefix) {
  await db.run('DELETE FROM installment_payments WHERE flow_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payment_plans WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

async function seedPlanPayment({ prefix, provider = 'stripe', method = 'stripe_saved_card' }) {
  const contactId = `${prefix}_contact`
  const flowId = `${prefix}_flow`
  const paymentId = `${prefix}_payment`
  const installmentId = `${prefix}_installment`

  await db.run(
    `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
     VALUES (?, 'Plan link test', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  await db.run(
    `INSERT INTO payment_flows (
       id, contact_id, contact_name, total_amount, currency, concept,
       payment_type, payment_provider, current_state, state_history,
       first_payment_amount, metadata, created_at, updated_at
     ) VALUES (?, ?, 'Plan link test', 300, 'MXN', 'Plan con liga',
       'partial', ?, 'active', '[]', 0, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [flowId, contactId, provider]
  )
  await db.run(
    `INSERT INTO payments (
       id, contact_id, amount, currency, status, payment_method, payment_mode,
       payment_provider, title, description, metadata_json, date, due_date,
       created_at, updated_at
     ) VALUES (?, ?, 300, 'MXN', 'scheduled', ?, 'live', ?, 'Pago 1/1',
       'Pago 1/1', ?, '2099-01-01', '2099-01-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      paymentId,
      contactId,
      method,
      provider,
      JSON.stringify({ paymentPlan: { flowId, installmentId, sequence: 1 } })
    ]
  )
  await db.run(
    `INSERT INTO installment_payments (
       id, flow_id, sequence, amount, due_date, frequency, payment_method,
       automatic, status, payment_id, created_at, updated_at
     ) VALUES (?, ?, 1, 300, '2099-01-01', 'monthly', ?, 1, 'scheduled', ?,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [installmentId, flowId, method, paymentId]
  )

  return { paymentId }
}

test('parcialidad con tarjeta obtiene una liga pública estable al copiarla', async () => {
  const prefix = uniquePrefix('payment_plan_copy_link')

  try {
    const { paymentId } = await seedPlanPayment({ prefix })
    const firstResponse = createResponse()
    const concurrentResponse = createResponse()
    await Promise.all([
      ensurePaymentPlanPaymentLink(createRequest(paymentId), firstResponse),
      ensurePaymentPlanPaymentLink(createRequest(paymentId), concurrentResponse)
    ])

    assert.equal(firstResponse.statusCode, 200)
    assert.match(firstResponse.payload?.data?.link || '', /^https:\/\/app\.example\.test\/pay\/rstk_pay_/)
    assert.equal(concurrentResponse.statusCode, 200)
    assert.equal(concurrentResponse.payload.data.link, firstResponse.payload.data.link)

    const stored = await db.get(
      'SELECT public_payment_id, payment_url FROM payments WHERE id = ?',
      [paymentId]
    )
    assert.match(stored.public_payment_id, /^rstk_pay_/)
    assert.equal(stored.payment_url, firstResponse.payload.data.link)

    const secondResponse = createResponse()
    await ensurePaymentPlanPaymentLink(createRequest(paymentId), secondResponse)
    assert.equal(secondResponse.statusCode, 200)
    assert.equal(secondResponse.payload.data.link, firstResponse.payload.data.link)
  } finally {
    await cleanup(prefix)
  }
})

test('parcialidad manual no fabrica una liga de tarjeta', async () => {
  const prefix = uniquePrefix('payment_plan_manual_no_link')

  try {
    const { paymentId } = await seedPlanPayment({
      prefix,
      provider: 'stripe',
      method: 'bank_transfer'
    })
    await db.run(
      `UPDATE payments
       SET public_payment_id = 'legacy_manual_link',
           payment_url = 'https://app.example.test/pay/legacy_manual_link'
       WHERE id = ?`,
      [paymentId]
    )
    const response = createResponse()
    await ensurePaymentPlanPaymentLink(createRequest(paymentId), response)

    assert.equal(response.statusCode, 409)
    assert.match(response.payload?.error || '', /no usa tarjeta/i)
    const stored = await db.get('SELECT public_payment_id, payment_url FROM payments WHERE id = ?', [paymentId])
    assert.equal(stored.public_payment_id, 'legacy_manual_link')
    assert.equal(stored.payment_url, 'https://app.example.test/pay/legacy_manual_link')
  } finally {
    await cleanup(prefix)
  }
})
