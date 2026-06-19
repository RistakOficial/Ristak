import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  actionInvoiceSchedule,
  getInvoiceSchedule
} from '../src/controllers/highlevelController.js'

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

async function cleanup(ids) {
  await db.run('DELETE FROM payment_plans WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE id IN (?, ?)', [ids.cardSetupPaymentId, ids.installmentPaymentId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

async function seedStripePlan() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ids = {
    contactId: `contact_stripe_plan_${suffix}`,
    flowId: `stripe_flow_${suffix}`,
    cardSetupPaymentId: `stripe_payment_setup_${suffix}`,
    installmentId: `stripe_installment_${suffix}`,
    installmentPaymentId: `stripe_plan_payment_${suffix}`
  }

  await cleanup(ids)

  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.contactId, 'Cliente Stripe', 'cliente@example.test', '+5215555555555']
  )

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      card_setup_required, card_setup_status, card_setup_invoice_id, card_setup_payment_link,
      payment_provider, current_state, state_history, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, 'MXN', ?, 'partial', 1, 'pending', ?, ?, 'stripe', 'waiting_card_authorization', '[]', ?)`,
    [
      ids.flowId,
      ids.contactId,
      'Cliente Stripe',
      'cliente@example.test',
      '+5215555555555',
      1000,
      'Plan local Stripe',
      ids.cardSetupPaymentId,
      'https://example.test/pay/setup',
      JSON.stringify({ remainingFrequency: 'monthly' })
    ]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, public_payment_id, payment_url, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, 25, 'MXN', 'sent', 'stripe', 'test', 'stripe', ?, ?, 'pay_setup_test', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.cardSetupPaymentId,
      ids.contactId,
      'Domiciliación de tarjeta',
      'Domiciliación de tarjeta',
      'https://example.test/pay/setup',
      JSON.stringify({
        paymentPlan: {
          flowId: ids.flowId,
          trigger: 'card_setup'
        }
      })
    ]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, 975, 'MXN', 'pending', 'stripe_scheduled_card', 'test', 'stripe', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.installmentPaymentId,
      ids.contactId,
      'Plan local Stripe - pago 1',
      'Plan local Stripe - pago 1',
      JSON.stringify({
        paymentPlan: {
          flowId: ids.flowId,
          installmentId: ids.installmentId,
          sequence: 1,
          trigger: 'scheduled_installment'
        }
      })
    ]
  )

  await db.run(
    `INSERT INTO installment_payments (
      id, flow_id, sequence, amount, due_date, frequency, payment_method,
      automatic, status, payment_id, created_at, updated_at
    ) VALUES (?, ?, 1, 975, '2099-01-01', 'monthly', 'stripe_pending_card', 1, 'waiting_card_authorization', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.installmentId, ids.flowId, ids.installmentPaymentId]
  )

  await db.run(
    `INSERT INTO payment_plans (
      id, contact_id, contact_name, email, phone, name, title, status,
      total, currency, description, recurrence_label, start_date, next_run_at,
      item_count, source, schedule_json, raw_json, created_at, updated_at
    ) VALUES (?, ?, 'Cliente Stripe', 'cliente@example.test', '+5215555555555', 'Plan local Stripe', 'Plan local Stripe', 'scheduled',
      1000, 'MXN', 'Plan local Stripe', 'Mensual', CURRENT_TIMESTAMP, '2099-01-01',
      1, 'stripe', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.flowId,
      ids.contactId,
      JSON.stringify({ provider: 'stripe', flowId: ids.flowId }),
      JSON.stringify({ provider: 'stripe', paymentFlow: { id: ids.flowId } })
    ]
  )

  return ids
}

test('abre un plan local de Stripe sin depender de HighLevel', async () => {
  const ids = await seedStripePlan()

  try {
    const res = createResponse()
    await getInvoiceSchedule({ params: { scheduleId: ids.flowId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.source, 'local_stripe')
    assert.equal(res.payload.data.id, ids.flowId)
    assert.equal(res.payload.data.source, 'stripe')
  } finally {
    await cleanup(ids)
  }
})

test('cancela un plan Stripe local y anula pagos pendientes ligados', async () => {
  const ids = await seedStripePlan()

  try {
    const res = createResponse()
    await actionInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: { action: 'cancel' }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.status, 'cancelled')

    const flow = await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [ids.flowId])
    const installment = await db.get('SELECT status FROM installment_payments WHERE id = ?', [ids.installmentId])
    const setupPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.cardSetupPaymentId])
    const installmentPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.installmentPaymentId])

    assert.equal(flow.current_state, 'cancelled')
    assert.equal(installment.status, 'cancelled')
    assert.equal(setupPayment.status, 'void')
    assert.equal(installmentPayment.status, 'void')
  } finally {
    await cleanup(ids)
  }
})
