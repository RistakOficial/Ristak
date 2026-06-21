import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import { actionInvoiceSchedule, getInvoiceSchedule } from '../src/controllers/highlevelController.js'
import {
  createMercadoPagoPaymentLink,
  createMercadoPagoPaymentPlan,
  createPublicMercadoPagoCardPayment,
  ensurePublicMercadoPagoPreference,
  processDueMercadoPagoPaymentPlanCharges,
  setMercadoPagoFetchForTest
} from '../src/services/mercadoPagoPaymentService.js'
import { encrypt } from '../src/utils/encryption.js'
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

async function snapshotMercadoPagoConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'mercadopago_%'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%'")
    await setAppConfig('mercadopago_enabled', '1')
    await setAppConfig('mercadopago_mode', 'test')
    await setAppConfig('mercadopago_default_currency', 'MXN')
    await setAppConfig('mercadopago_account_label', 'Mercado Pago Test')
    await setAppConfig('mercadopago_public_key', 'TEST-public-key')
    await setAppConfig('mercadopago_user_id', '123456789')
    await setAppConfig('mercadopago_token_type', 'bearer')
    await setAppConfig('mercadopago_livemode', '0')
    await setAppConfig('mercadopago_access_token_encrypted', encrypt('TEST-access-token'))
    await setAppConfig('mercadopago_connected_at', new Date().toISOString())

    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
    setMercadoPagoFetchForTest(null)
  }
}

async function cleanup(ids) {
  if (ids.paymentId) {
    await db.run('DELETE FROM payments WHERE id = ?', [ids.paymentId]).catch(() => undefined)
  }
  if (ids.flowId) {
    await db.run('DELETE FROM payment_plans WHERE id = ?', [ids.flowId]).catch(() => undefined)
    await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [ids.flowId]).catch(() => undefined)
    await db.run('DELETE FROM payment_flows WHERE id = ?', [ids.flowId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE metadata_json LIKE ?', [`%${ids.flowId}%`]).catch(() => undefined)
  }
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

test('Mercado Pago crea planes locales y el cron genera links vencidos sin duplicar', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_plan_${suffix}`,
      flowId: ''
    }
    const preferenceCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/checkout/preferences')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      const body = JSON.parse(String(options.body || '{}'))
      preferenceCalls.push(body)

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: `pref_mp_${preferenceCalls.length}`,
          init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=${preferenceCalls.length}`,
          sandbox_init_point: `https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=${preferenceCalls.length}`
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente Mercado Pago', 'cliente-mp@example.test', '+5215555555555']
    )

    try {
      const plan = await createMercadoPagoPaymentPlan({
        contact: {
          id: ids.contactId,
          name: 'Cliente Mercado Pago',
          email: 'cliente-mp@example.test',
          phone: '+5215555555555'
        },
        totalAmount: 300,
        currency: 'MXN',
        title: 'Plan local Mercado Pago',
        description: 'Plan local Mercado Pago',
        firstPayment: {
          enabled: true,
          amount: 100,
          date: '2000-01-01',
          method: 'mercadopago'
        },
        remainingFrequency: 'monthly',
        remainingPayments: [
          {
            sequence: 1,
            amount: 200,
            dueDate: '2000-01-01',
            frequency: 'monthly'
          }
        ]
      }, { baseUrl: 'https://app.example.test' })
      ids.flowId = plan.flowId

      assert.equal(preferenceCalls.length, 1)
      assert.equal(plan.firstPaymentLink, 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=1')
      assert.equal(plan.scheduledPayments.length, 1)

      const scheduleRes = createResponse()
      await getInvoiceSchedule({ params: { scheduleId: ids.flowId } }, scheduleRes)

      assert.equal(scheduleRes.statusCode, 200)
      assert.equal(scheduleRes.payload.success, true)
      assert.equal(scheduleRes.payload.source, 'local_mercadopago')
      assert.equal(scheduleRes.payload.data.source, 'mercadopago')

      const firstCronRun = await processDueMercadoPagoPaymentPlanCharges({
        baseUrl: 'https://app.example.test'
      })
      assert.equal(firstCronRun.length, 1)
      assert.equal(firstCronRun[0].generated, true)
      assert.equal(firstCronRun[0].paymentUrl, 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=2')
      assert.equal(preferenceCalls.length, 2)

      const installment = await db.get(
        'SELECT status, mercadopago_preference_id FROM installment_payments WHERE flow_id = ?',
        [ids.flowId]
      )
      const scheduledPayment = await db.get(
        `SELECT status, mercadopago_preference_id, payment_url
         FROM payments
         WHERE metadata_json LIKE ?
           AND payment_method = 'mercadopago_checkout'
           AND amount = 200`,
        [`%${ids.flowId}%`]
      )

      assert.equal(installment.status, 'sent')
      assert.equal(installment.mercadopago_preference_id, 'pref_mp_2')
      assert.equal(scheduledPayment.status, 'sent')
      assert.equal(scheduledPayment.mercadopago_preference_id, 'pref_mp_2')

      const secondCronRun = await processDueMercadoPagoPaymentPlanCharges({
        baseUrl: 'https://app.example.test'
      })
      assert.equal(secondCronRun.length, 0)
      assert.equal(preferenceCalls.length, 2)

      const cancelRes = createResponse()
      await actionInvoiceSchedule({
        params: { scheduleId: ids.flowId },
        body: { action: 'cancel' }
      }, cancelRes)

      assert.equal(cancelRes.statusCode, 200)
      assert.equal(cancelRes.payload.success, true)
      assert.equal(cancelRes.payload.source, 'local_mercadopago')
      assert.equal(cancelRes.payload.data.status, 'cancelled')

      const flow = await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [ids.flowId])
      assert.equal(flow.current_state, 'cancelled')
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago cobra tarjeta en la pagina publica sin confiar en el monto del navegador', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_card_${suffix}`,
      paymentId: ''
    }
    const preferenceCalls = []
    const cardPaymentCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        const body = JSON.parse(String(options.body || '{}'))
        preferenceCalls.push(body)

        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: `pref_card_${preferenceCalls.length}`,
            init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=card_${preferenceCalls.length}`,
            sandbox_init_point: `https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=card_${preferenceCalls.length}`
          })
        }
      }

      assert.equal(url, 'https://api.mercadopago.com/v1/payments')
      assert.equal(options.headers?.['X-Idempotency-Key'], 'card-test-key-123')
      const body = JSON.parse(String(options.body || '{}'))
      cardPaymentCalls.push(body)

      assert.equal(body.transaction_amount, 123.45)
      assert.equal(body.token, 'tok_card_test')
      assert.equal(body.payment_method_id, 'visa')
      assert.equal(body.installments, 1)
      assert.equal(body.payer.email, 'cliente-card@example.test')
      assert.equal(body.external_reference, ids.paymentId)
      assert.equal(body.metadata.ristak_payment_id, ids.paymentId)

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_card_payment_1',
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 123.45,
          currency_id: 'MXN',
          payment_method_id: 'visa',
          payment_type_id: 'credit_card',
          external_reference: ids.paymentId,
          metadata: {
            ristak_payment_id: ids.paymentId
          },
          date_approved: '2026-06-20T20:00:00.000Z'
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente Card Mercado Pago', 'cliente-card@example.test', '+5215555555557']
    )

    try {
      const created = await createMercadoPagoPaymentLink({
        contactId: ids.contactId,
        contactName: 'Cliente Card Mercado Pago',
        email: 'cliente-card@example.test',
        phone: '+5215555555557',
        amount: 123.45,
        currency: 'MXN',
        title: 'Pago con tarjeta Mercado Pago',
        description: 'Pago con tarjeta Mercado Pago',
        applyTax: false
      }, { baseUrl: 'https://app.example.test' })
      ids.paymentId = created.payment.id

      const charged = await createPublicMercadoPagoCardPayment(created.publicPaymentId, {
        token: 'tok_card_test',
        paymentMethodId: 'visa',
        issuerId: '123',
        installments: 1,
        idempotencyKey: 'card-test-key-123',
        transaction_amount: 1,
        payer: {
          email: 'cliente-card@example.test',
          identification: {
            type: 'RFC',
            number: 'XAXX010101000'
          }
        }
      }, { baseUrl: 'https://app.example.test' })

      assert.equal(preferenceCalls.length, 1)
      assert.equal(cardPaymentCalls.length, 1)
      assert.equal(charged.payment.status, 'paid')
      assert.equal(charged.payment.mercadoPagoPaymentId, 'mp_card_payment_1')
      assert.equal(charged.status, 'approved')

      const saved = await db.get(
        `SELECT status, amount, payment_method, mercadopago_payment_id, paid_at, metadata_json
         FROM payments
         WHERE id = ?`,
        [ids.paymentId]
      )
      assert.equal(saved.status, 'paid')
      assert.equal(saved.amount, 123.45)
      assert.equal(saved.payment_method, 'credit_card')
      assert.equal(saved.mercadopago_payment_id, 'mp_card_payment_1')
      assert.ok(saved.paid_at)
      assert.ok(!String(saved.metadata_json).includes('tok_card_test'))
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago sincroniza la parcialidad cuando la preferencia se genera desde el link publico', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_public_${suffix}`,
      flowId: ''
    }
    const preferenceCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/checkout/preferences')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      preferenceCalls.push(JSON.parse(String(options.body || '{}')))

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: `pref_public_${preferenceCalls.length}`,
          init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=public_${preferenceCalls.length}`,
          sandbox_init_point: `https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=public_${preferenceCalls.length}`
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente Mercado Pago Publico', 'cliente-mp-public@example.test', '+5215555555556']
    )

    try {
      const plan = await createMercadoPagoPaymentPlan({
        contact: {
          id: ids.contactId,
          name: 'Cliente Mercado Pago Publico',
          email: 'cliente-mp-public@example.test',
          phone: '+5215555555556'
        },
        totalAmount: 200,
        currency: 'MXN',
        title: 'Plan publico Mercado Pago',
        description: 'Plan publico Mercado Pago',
        firstPayment: {
          enabled: false,
          amount: 0,
          method: 'mercadopago'
        },
        remainingPayments: [
          {
            sequence: 1,
            amount: 200,
            dueDate: '2000-01-01',
            frequency: 'monthly'
          }
        ]
      }, { baseUrl: 'https://app.example.test' })
      ids.flowId = plan.flowId

      assert.equal(preferenceCalls.length, 0)
      assert.equal(plan.scheduledPayments.length, 1)

      const scheduledPayment = await db.get(
        `SELECT public_payment_id
         FROM payments
         WHERE id = ?`,
        [plan.scheduledPayments[0].paymentId]
      )

      const generated = await ensurePublicMercadoPagoPreference(scheduledPayment.public_payment_id, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(generated.preferenceId, 'pref_public_1')
      assert.equal(generated.paymentUrl, 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=public_1')

      const installment = await db.get(
        'SELECT status, mercadopago_preference_id FROM installment_payments WHERE flow_id = ?',
        [ids.flowId]
      )
      const payment = await db.get(
        `SELECT status, mercadopago_preference_id, payment_url
         FROM payments
         WHERE id = ?`,
        [plan.scheduledPayments[0].paymentId]
      )

      assert.equal(installment.status, 'sent')
      assert.equal(installment.mercadopago_preference_id, 'pref_public_1')
      assert.equal(payment.status, 'sent')
      assert.equal(payment.mercadopago_preference_id, 'pref_public_1')

      const scheduleRes = createResponse()
      await getInvoiceSchedule({ params: { scheduleId: ids.flowId } }, scheduleRes)
      assert.equal(scheduleRes.payload.data.raw.schedule.installments[0].status, 'sent')
      assert.equal(scheduleRes.payload.data.raw.schedule.installments[0].preferenceId, 'pref_public_1')

      const secondEnsure = await ensurePublicMercadoPagoPreference(scheduledPayment.public_payment_id, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(secondEnsure.preferenceId, 'pref_public_1')
      assert.equal(preferenceCalls.length, 1)
    } finally {
      await cleanup(ids)
    }
  })
})
