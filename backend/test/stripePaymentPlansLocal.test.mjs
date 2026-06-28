import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  actionInvoiceSchedule,
  getInvoiceSchedule,
  updateInvoiceSchedule
} from '../src/controllers/highlevelController.js'
import {
  getPublicStripePayment,
  processDueStripePaymentPlanCharges,
  refreshStripePaymentFromIntent,
  saveStripePaymentConfig,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

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
  await db.run('DELETE FROM payments WHERE id IN (?, ?, ?)', [ids.cardSetupPaymentId, ids.firstPaymentId, ids.installmentPaymentId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE metadata_json LIKE ?', [`%${ids.flowId}%`]).catch(() => undefined)
  await db.run('DELETE FROM stripe_payment_methods WHERE contact_id = ?', [ids.contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

async function seedStripePlan() {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ids = {
    contactId: `contact_stripe_plan_${suffix}`,
    flowId: `stripe_flow_${suffix}`,
    cardSetupPaymentId: `stripe_payment_setup_${suffix}`,
    firstPaymentId: `stripe_first_payment_${suffix}`,
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

async function ensurePublicStripeConfig() {
  await initializeMasterKey()
  await savePaymentSettings({ paymentMode: 'test' })
  await saveStripePaymentConfig({
    enabled: true,
    mode: 'test',
    publishableKey: 'pk_test_public_plan_summary',
    secretKey: 'sk_test_public_plan_summary',
    defaultCurrency: 'MXN'
  })
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

test('expone resumen de plan en el link público de domiciliación Stripe', async () => {
  const ids = await seedStripePlan()

  try {
    await ensurePublicStripeConfig()

    const payment = await getPublicStripePayment('pay_setup_test', { baseUrl: 'https://example.test' })

    assert.ok(payment)
    assert.equal(payment.provider, 'stripe')
    assert.equal(payment.paymentPlan.flowId, ids.flowId)
    assert.equal(payment.paymentPlan.trigger, 'card_setup')
    assert.equal(payment.paymentPlan.total, 1000)
    assert.equal(payment.paymentPlan.currency, 'MXN')
    assert.equal(payment.paymentPlan.cardSetupRequired, true)
    assert.equal(payment.paymentPlan.installments.length, 1)
    assert.equal(payment.paymentPlan.installments[0].amount, 975)
    assert.equal(payment.paymentPlan.installments[0].dueDate, '2099-01-01')
    assert.equal(payment.paymentPlan.changeSummary, null)
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

test('elimina físicamente un plan Stripe local de prueba y sus pagos ligados', async () => {
  const ids = await seedStripePlan()

  try {
    const res = createResponse()
    await actionInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: { action: 'delete' }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.status, 'deleted')
    assert.equal(res.payload.data.deleted, true)

    const flow = await db.get('SELECT id FROM payment_flows WHERE id = ?', [ids.flowId])
    const mirror = await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId])
    const installment = await db.get('SELECT id FROM installment_payments WHERE id = ?', [ids.installmentId])
    const setupPayment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.cardSetupPaymentId])
    const installmentPayment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.installmentPaymentId])

    assert.equal(flow, null)
    assert.equal(mirror, null)
    assert.equal(installment, null)
    assert.equal(setupPayment, null)
    assert.equal(installmentPayment, null)
  } finally {
    await cleanup(ids)
  }
})

test('elimina físicamente un plan Stripe local ya archivado como eliminado sin historial contable', async () => {
  const ids = await seedStripePlan()

  try {
    await db.run(
      `UPDATE payment_flows
       SET current_state = 'deleted'
       WHERE id = ?`,
      [ids.flowId]
    )
    await db.run(
      `UPDATE payment_plans
       SET status = 'deleted'
       WHERE id = ?`,
      [ids.flowId]
    )
    await db.run(
      `UPDATE installment_payments
       SET status = 'deleted'
       WHERE flow_id = ?`,
      [ids.flowId]
    )
    await db.run(
      `UPDATE payments
       SET status = 'deleted',
           payment_mode = 'live',
           metadata_json = ?
       WHERE id IN (?, ?)`,
      ['{}', ids.cardSetupPaymentId, ids.installmentPaymentId]
    )

    const res = createResponse()
    await actionInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: { action: 'delete' }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.deleted, true)

    const flow = await db.get('SELECT id FROM payment_flows WHERE id = ?', [ids.flowId])
    const mirror = await db.get('SELECT id FROM payment_plans WHERE id = ?', [ids.flowId])
    const installment = await db.get('SELECT id FROM installment_payments WHERE id = ?', [ids.installmentId])
    const setupPayment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.cardSetupPaymentId])
    const installmentPayment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.installmentPaymentId])

    assert.equal(flow, null)
    assert.equal(mirror, null)
    assert.equal(installment, null)
    assert.equal(setupPayment, null)
    assert.equal(installmentPayment, null)
  } finally {
    await cleanup(ids)
  }
})

test('bloquea borrar físicamente un plan Stripe ya eliminado si conserva un pago live registrado', async () => {
  const ids = await seedStripePlan()

  try {
    await db.run(
      `UPDATE payment_flows
       SET current_state = 'deleted'
       WHERE id = ?`,
      [ids.flowId]
    )
    await db.run(
      `UPDATE payment_plans
       SET status = 'deleted'
       WHERE id = ?`,
      [ids.flowId]
    )
    await db.run(
      `UPDATE payments
       SET status = 'paid',
           payment_mode = 'live',
           stripe_payment_intent_id = 'pi_deleted_live_guard',
           paid_at = CURRENT_TIMESTAMP,
           metadata_json = ?
       WHERE id = ?`,
      ['{}', ids.cardSetupPaymentId]
    )
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live',
           metadata_json = ?
       WHERE id = ?`,
      ['{}', ids.installmentPaymentId]
    )

    const res = createResponse()
    await actionInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: { action: 'delete' }
    }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /no se puede eliminar|conservar el historial/i)

    const flow = await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [ids.flowId])
    const setupPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.cardSetupPaymentId])

    assert.equal(flow.current_state, 'deleted')
    assert.equal(setupPayment.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('bloquea eliminar un plan Stripe live cuando ya tiene un pago registrado', async () => {
  const ids = await seedStripePlan()

  try {
    await db.run(
      `UPDATE payments
       SET status = 'paid',
           payment_mode = 'live',
           stripe_payment_intent_id = 'pi_plan_delete_guard',
           paid_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [ids.cardSetupPaymentId]
    )
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live'
       WHERE id = ?`,
      [ids.installmentPaymentId]
    )

    const res = createResponse()
    await actionInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: { action: 'delete' }
    }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /no se puede eliminar|conservar el historial/i)

    const flow = await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [ids.flowId])
    const setupPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.cardSetupPaymentId])

    assert.equal(flow.current_state, 'waiting_card_authorization')
    assert.equal(setupPayment.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('edita calendario de pagos de un plan Stripe local', async () => {
  const ids = await seedStripePlan()

  try {
    const res = createResponse()
    await updateInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: {
        payload: {
          name: 'Plan local Stripe editado',
          remainingFrequency: 'monthly',
          installments: [
            {
              id: ids.installmentId,
              amount: 500,
              dueDate: '2099-02-01',
              method: 'stripe_auto'
            },
            {
              amount: 250,
              dueDate: '2099-03-01',
              method: 'bank_transfer'
            }
          ]
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.source, 'local_stripe')
    assert.equal(res.payload.data.total, 750)
    assert.equal(res.payload.data.name, 'Plan local Stripe editado')

    const flow = await db.get('SELECT total_amount, concept FROM payment_flows WHERE id = ?', [ids.flowId])
    const installments = await db.all(
      `SELECT amount, due_date, automatic, payment_method, status
       FROM installment_payments
       WHERE flow_id = ? AND status != 'deleted'
       ORDER BY sequence ASC`,
      [ids.flowId]
    )

    assert.equal(flow.total_amount, 750)
    assert.equal(flow.concept, 'Plan local Stripe editado')
    assert.equal(installments.length, 2)
    assert.equal(installments[0].amount, 500)
    assert.equal(installments[0].due_date, '2099-02-01')
    assert.equal(installments[0].automatic, 1)
    assert.equal(installments[1].amount, 250)
    assert.equal(installments[1].payment_method, 'bank_transfer')
    assert.equal(installments[1].automatic, 0)

    await ensurePublicStripeConfig()
    const publicPayment = await getPublicStripePayment('pay_setup_test', { baseUrl: 'https://example.test' })
    const addedInstallment = publicPayment.paymentPlan.installments.find((installment) => installment.changeType === 'added')

    assert.equal(publicPayment.paymentPlan.changeSummary.addedInstallmentCount, 1)
    assert.equal(publicPayment.paymentPlan.changeSummary.label, '1 pago agregado')
    assert.ok(addedInstallment)
    assert.equal(addedInstallment.amount, 250)
    assert.equal(addedInstallment.dueDate, '2099-03-01')
  } finally {
    await cleanup(ids)
  }
})

test('permite sumar un primer pago pendiente a un plan Stripe local', async () => {
  const ids = await seedStripePlan()

  try {
    const res = createResponse()
    await updateInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: {
        payload: {
          name: 'Plan local Stripe con primer pago',
          remainingFrequency: 'monthly',
          firstPayment: {
            amount: 125,
            dueDate: '2098-12-01',
            method: 'stripe_auto'
          },
          installments: [
            {
              id: ids.installmentId,
              amount: 975,
              dueDate: '2099-01-01',
              method: 'stripe_auto'
            }
          ]
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.total, 1100)

    const flow = await db.get(
      `SELECT total_amount, first_payment_amount, first_payment_method, first_payment_status, first_payment_invoice_id
       FROM payment_flows
       WHERE id = ?`,
      [ids.flowId]
    )
    const firstPayment = await db.get('SELECT amount, status, payment_method FROM payments WHERE id = ?', [flow.first_payment_invoice_id])

    assert.equal(flow.total_amount, 1100)
    assert.equal(flow.first_payment_amount, 125)
    assert.equal(flow.first_payment_method, 'payment_link')
    assert.equal(flow.first_payment_status, 'pending')
    assert.ok(flow.first_payment_invoice_id)
    assert.equal(firstPayment.amount, 125)
    assert.equal(firstPayment.status, 'pending')
    assert.equal(firstPayment.payment_method, 'stripe_pending_card')
  } finally {
    await cleanup(ids)
  }
})

test('permite restar pagos pendientes de un plan Stripe local', async () => {
  const ids = await seedStripePlan()

  try {
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'pending', 'stripe', 'test', 'stripe', ?, ?, ?, '2098-12-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.firstPaymentId,
        ids.contactId,
        'Plan local Stripe - primer pago',
        'Plan local Stripe - primer pago',
        JSON.stringify({
          source: 'stripe_payment_plan_first_link',
          paymentPlan: {
            flowId: ids.flowId,
            trigger: 'first_payment'
          }
        })
      ]
    )

    await db.run(
      `UPDATE payment_flows
       SET first_payment_amount = 100,
           first_payment_value = 100,
           first_payment_date = '2098-12-01',
           first_payment_method = 'card',
           first_payment_status = 'pending',
           first_payment_invoice_id = ?,
           total_amount = 1075
       WHERE id = ?`,
      [ids.firstPaymentId, ids.flowId]
    )

    const res = createResponse()
    await updateInvoiceSchedule({
      params: { scheduleId: ids.flowId },
      body: {
        payload: {
          name: 'Plan local Stripe reducido',
          remainingFrequency: 'monthly',
          firstPayment: null,
          installments: []
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.total, 0)

    const flow = await db.get(
      `SELECT total_amount, first_payment_amount, first_payment_invoice_id, first_payment_status
       FROM payment_flows
       WHERE id = ?`,
      [ids.flowId]
    )
    const firstPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.firstPaymentId])
    const installment = await db.get('SELECT status FROM installment_payments WHERE id = ?', [ids.installmentId])
    const linkedInstallmentPayment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.installmentPaymentId])

    assert.equal(flow.total_amount, 0)
    assert.equal(flow.first_payment_amount, 0)
    assert.equal(flow.first_payment_invoice_id, null)
    assert.equal(flow.first_payment_status, null)
    assert.equal(firstPayment.status, 'deleted')
    assert.equal(installment.status, 'deleted')
    assert.equal(linkedInstallmentPayment.status, 'deleted')
  } finally {
    await cleanup(ids)
  }
})

test('cobra automáticamente parcialidades vencidas con tarjeta guardada sin duplicar', async () => {
  const ids = await seedStripePlan()
  const createCalls = []
  const stripeCustomerId = `cus_test_${Date.now()}`
  const stripePaymentMethodId = `pm_test_${Date.now()}`

  setStripeFactoryForTest(() => ({
    paymentIntents: {
      create: async (params, options) => {
        createCalls.push({ params, options })
        return {
          id: `pi_test_${createCalls.length}`,
          status: 'succeeded',
          amount: params.amount,
          amount_received: params.amount,
          currency: params.currency,
          customer: params.customer,
          payment_method: params.payment_method,
          latest_charge: `ch_test_${createCalls.length}`,
          metadata: params.metadata
        }
      }
    },
    paymentMethods: {
      retrieve: async (paymentMethodId) => ({
        id: paymentMethodId,
        type: 'card',
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2035,
          funding: 'credit',
          country: 'MX'
        }
      }),
      list: async () => ({ data: [] })
    }
  }))

  try {
    await initializeMasterKey()
    await savePaymentSettings({ paymentMode: 'test' })
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_local_automatic_plan',
      secretKey: 'sk_test_local_automatic_plan',
      defaultCurrency: 'MXN'
    })

    await db.run(
      `UPDATE contacts
       SET stripe_customer_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [stripeCustomerId, ids.contactId]
    )

    await db.run(
      `INSERT INTO stripe_payment_methods (
        id, contact_id, stripe_customer_id, stripe_payment_method_id,
        brand, last4, exp_month, exp_year, funding, country, mode, is_default,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'credit', 'MX', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`stripe_pm_${Date.now()}`, ids.contactId, stripeCustomerId, stripePaymentMethodId]
    )

    await db.run(
      `UPDATE payment_flows
       SET current_state = 'installment_plan_active',
           stripe_customer_id = ?,
           stripe_payment_method_id = ?,
           stripe_payment_method_label = 'VISA 4242',
           card_setup_status = 'paid',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [stripeCustomerId, stripePaymentMethodId, ids.flowId]
    )

    await db.run(
      `UPDATE installment_payments
       SET status = 'processing',
           payment_method = 'stripe_saved_card',
           due_date = '2000-01-01',
           updated_at = datetime('now', '-20 minutes')
       WHERE id = ?`,
      [ids.installmentId]
    )

    await db.run(
      `UPDATE payments
       SET status = 'pending',
           payment_method = 'stripe_scheduled_card',
           due_date = '2000-01-01',
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify({ legacyScheduledPayment: true }), ids.installmentPaymentId]
    )

    const firstRun = await processDueStripePaymentPlanCharges({ limit: 5 })
    assert.equal(firstRun.length, 1)
    assert.equal(firstRun[0].charged, true)
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].params.customer, stripeCustomerId)
    assert.equal(createCalls[0].params.payment_method, stripePaymentMethodId)
    assert.equal(createCalls[0].params.off_session, true)
    assert.equal(createCalls[0].params.confirm, true)
    assert.match(
      createCalls[0].options.idempotencyKey,
      new RegExp(`^ristak:${ids.installmentPaymentId}:off-session-charge:\\d{4}-\\d{2}-\\d{2}$`)
    )

    const payment = await db.get(
      'SELECT status, stripe_payment_intent_id, stripe_charge_id FROM payments WHERE id = ?',
      [ids.installmentPaymentId]
    )
    const installment = await db.get(
      'SELECT status, stripe_payment_intent_id FROM installment_payments WHERE id = ?',
      [ids.installmentId]
    )
    const mirroredPlan = await db.get('SELECT status, schedule_json FROM payment_plans WHERE id = ?', [ids.flowId])
    const mirroredSchedule = JSON.parse(mirroredPlan.schedule_json || '{}')

    assert.equal(payment.status, 'paid')
    assert.equal(payment.stripe_payment_intent_id, 'pi_test_1')
    assert.equal(payment.stripe_charge_id, 'ch_test_1')
    assert.equal(installment.status, 'paid')
    assert.equal(installment.stripe_payment_intent_id, 'pi_test_1')
    assert.equal(mirroredPlan.status, 'active')
    assert.equal(mirroredSchedule.installments[0].status, 'paid')

    const secondRun = await processDueStripePaymentPlanCharges({ limit: 5 })
    assert.equal(secondRun.length, 0)
    assert.equal(createCalls.length, 1)
  } finally {
    setStripeFactoryForTest(null)
    await cleanup(ids)
  }
})

test('usa la nueva tarjeta domiciliada en cobros automáticos posteriores', async () => {
  const ids = await seedStripePlan()
  const createCalls = []
  const stripeCustomerId = `cus_change_${Date.now()}`
  const oldPaymentMethodId = `pm_old_${Date.now()}`
  const newPaymentMethodId = `pm_new_${Date.now()}`
  const cardUpdatePaymentId = `stripe_payment_change_card_${Date.now()}`

  setStripeFactoryForTest(() => ({
    paymentIntents: {
      retrieve: async (paymentIntentId) => ({
        id: paymentIntentId,
        status: 'succeeded',
        amount: 2500,
        amount_received: 2500,
        currency: 'mxn',
        customer: stripeCustomerId,
        payment_method: newPaymentMethodId,
        latest_charge: 'ch_change_card',
        metadata: {
          ristak_payment_id: cardUpdatePaymentId
        }
      }),
      create: async (params, options) => {
        createCalls.push({ params, options })
        return {
          id: `pi_followup_${createCalls.length}`,
          status: 'succeeded',
          amount: params.amount,
          amount_received: params.amount,
          currency: params.currency,
          customer: params.customer,
          payment_method: params.payment_method,
          latest_charge: `ch_followup_${createCalls.length}`,
          metadata: params.metadata
        }
      }
    },
    paymentMethods: {
      retrieve: async (paymentMethodId) => ({
        id: paymentMethodId,
        type: 'card',
        card: paymentMethodId === newPaymentMethodId
          ? {
              brand: 'mastercard',
              last4: '4444',
              exp_month: 11,
              exp_year: 2034,
              funding: 'credit',
              country: 'MX'
            }
          : {
              brand: 'visa',
              last4: '4242',
              exp_month: 12,
              exp_year: 2035,
              funding: 'credit',
              country: 'MX'
            }
      }),
      list: async () => ({ data: [] })
    }
  }))

  try {
    await initializeMasterKey()
    await savePaymentSettings({ paymentMode: 'test' })
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_local_change_card',
      secretKey: 'sk_test_local_change_card',
      defaultCurrency: 'MXN'
    })

    await db.run(
      `UPDATE contacts
       SET stripe_customer_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [stripeCustomerId, ids.contactId]
    )

    await db.run(
      `INSERT INTO stripe_payment_methods (
        id, contact_id, stripe_customer_id, stripe_payment_method_id,
        brand, last4, exp_month, exp_year, funding, country, mode, is_default,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'credit', 'MX', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`stripe_pm_old_${Date.now()}`, ids.contactId, stripeCustomerId, oldPaymentMethodId]
    )

    await db.run(
      `UPDATE payment_flows
       SET current_state = 'installment_plan_active',
           stripe_customer_id = ?,
           stripe_payment_method_id = ?,
           stripe_payment_method_label = 'VISA 4242',
           card_setup_status = 'paid',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [stripeCustomerId, oldPaymentMethodId, ids.flowId]
    )

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, 25, 'MXN', 'pending', 'stripe', 'test', 'stripe', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        cardUpdatePaymentId,
        ids.contactId,
        'Cambio de tarjeta domiciliada',
        'Cambio de tarjeta domiciliada',
        JSON.stringify({
          paymentPlan: {
            flowId: ids.flowId,
            trigger: 'card_setup',
            reason: 'card_update'
          }
        })
      ]
    )

    await refreshStripePaymentFromIntent('pi_change_card')

    const flowAfterChange = await db.get(
      `SELECT stripe_payment_method_id, stripe_payment_method_label, card_setup_status
       FROM payment_flows
       WHERE id = ?`,
      [ids.flowId]
    )
    const oldCard = await db.get(
      'SELECT is_default FROM stripe_payment_methods WHERE stripe_payment_method_id = ?',
      [oldPaymentMethodId]
    )
    const newCard = await db.get(
      'SELECT is_default, brand, last4 FROM stripe_payment_methods WHERE stripe_payment_method_id = ?',
      [newPaymentMethodId]
    )

    assert.equal(flowAfterChange.stripe_payment_method_id, newPaymentMethodId)
    assert.match(flowAfterChange.stripe_payment_method_label, /MASTERCARD.*4444/)
    assert.equal(flowAfterChange.card_setup_status, 'paid')
    assert.equal(Number(oldCard.is_default), 0)
    assert.equal(Number(newCard.is_default), 1)
    assert.equal(newCard.brand, 'mastercard')
    assert.equal(newCard.last4, '4444')

    await db.run(
      `UPDATE installment_payments
       SET status = 'scheduled',
           payment_method = 'stripe_saved_card',
           due_date = '2000-01-01',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [ids.installmentId]
    )

    await db.run(
      `UPDATE payments
       SET status = 'pending',
           payment_method = 'stripe_scheduled_card',
           due_date = '2000-01-01',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [ids.installmentPaymentId]
    )

    const dueRun = await processDueStripePaymentPlanCharges({ limit: 5 })

    assert.equal(dueRun.length, 1)
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].params.payment_method, newPaymentMethodId)
    assert.equal(createCalls[0].params.customer, stripeCustomerId)
  } finally {
    setStripeFactoryForTest(null)
    await cleanup(ids)
  }
})
