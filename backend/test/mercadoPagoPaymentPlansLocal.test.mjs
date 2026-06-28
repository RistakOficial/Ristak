import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import {
  createMercadoPagoPaymentLink,
  createMercadoPagoPaymentPlan,
  ensurePublicMercadoPagoPreference,
  createPublicMercadoPagoCardPayment,
  handleMercadoPagoWebhookEvent,
  setMercadoPagoFetchForTest
} from '../src/services/mercadoPagoPaymentService.js'
import { createSubscription } from '../src/services/subscriptionsService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { encrypt } from '../src/utils/encryption.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

function dateOnlyInDays(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function localIsoInDays(days) {
  return `${dateOnlyInDays(days)}T10:00:00.000-06:00`
}

async function snapshotMercadoPagoConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'")
    await savePaymentSettings({ paymentMode: 'test' })
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
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'")
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
  if (ids.subscriptionId) {
    await db.run('DELETE FROM payments WHERE metadata_json LIKE ?', [`%${ids.subscriptionId}%`]).catch(() => undefined)
    await db.run('DELETE FROM subscriptions WHERE id = ?', [ids.subscriptionId]).catch(() => undefined)
  }
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

test('Mercado Pago rechaza nuevos planes de pago por parcialidades sin dejar registros a medias', async () => {
  const contactId = `contact_mp_plan_disabled_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)

  try {
    await assert.rejects(
      () => createMercadoPagoPaymentPlan({
        contact: { id: contactId, name: 'Cliente Mercado Pago' },
        totalAmount: 300,
        currency: 'MXN',
        title: 'Plan no permitido',
        description: 'Plan no permitido',
        firstPayment: { enabled: false, amount: 0, method: 'mercadopago' },
        remainingPayments: [{ sequence: 1, amount: 300, dueDate: '2099-01-01', frequency: 'monthly' }]
      }, { baseUrl: 'https://app.example.test' }),
      (error) => {
        assert.equal(error.status, 422)
        assert.match(error.message, /Mercado Pago no está disponible para planes de pago/i)
        return true
      }
    )

    const leftovers = await Promise.all([
      db.get('SELECT COUNT(*) AS count FROM payment_flows WHERE contact_id = ?', [contactId]),
      db.get('SELECT COUNT(*) AS count FROM payment_plans WHERE contact_id = ?', [contactId]),
      db.get('SELECT COUNT(*) AS count FROM payments WHERE contact_id = ?', [contactId])
    ])
    assert.deepEqual(leftovers.map((row) => Number(row.count)), [0, 0, 0])
  } finally {
    await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  }
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
      assert.equal(created.paymentUrl, `https://app.example.test/pay/${created.publicPaymentId}`)
      assert.equal(created.payment.paymentUrl, `https://app.example.test/pay/${created.publicPaymentId}`)

      const checkoutFallback = await ensurePublicMercadoPagoPreference(created.publicPaymentId, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(checkoutFallback.paymentUrl, 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=card_1')
      assert.equal(checkoutFallback.checkoutUrl, 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=card_1')
      assert.equal(preferenceCalls.length, 1)

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

test('Mercado Pago no genera parcialidades publicas porque los planes estan deshabilitados', async () => {
  await assert.rejects(
    () => createMercadoPagoPaymentPlan({
      contact: { id: 'contact_mp_public_disabled', name: 'Cliente Mercado Pago Publico' },
      totalAmount: 200,
      currency: 'MXN',
      title: 'Plan publico no permitido',
      description: 'Plan publico no permitido',
      firstPayment: { enabled: false, amount: 0, method: 'mercadopago' },
      remainingPayments: [{ sequence: 1, amount: 200, dueDate: '2099-01-01', frequency: 'monthly' }]
    }, { baseUrl: 'https://app.example.test' }),
    /Mercado Pago no está disponible para planes de pago/i
  )
})

test('Mercado Pago crea suscripcion recurrente real con preapproval pendiente', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_${suffix}`,
      subscriptionId: ''
    }
    const startDate = dateOnlyInDays(1)
    const nextPaymentDate = localIsoInDays(31)
    const calls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')
      assert.equal(url, 'https://api.mercadopago.com/preapproval')
      assert.equal(options.method, 'POST')

      const body = JSON.parse(String(options.body || '{}'))
      calls.push(body)

      assert.equal(body.reason, 'Membresia Mercado Pago')
      assert.equal(body.payer_email, 'cliente-mp-sub@example.test')
      assert.equal(body.status, 'pending')
      assert.equal(body.auto_recurring.frequency, 1)
      assert.equal(body.auto_recurring.frequency_type, 'months')
      assert.equal(body.auto_recurring.transaction_amount, 149)
      assert.equal(body.auto_recurring.currency_id, 'MXN')
      assert.ok(String(body.back_url).includes('/transactions/subscriptions'))
      assert.ok(String(body.external_reference).startsWith('rstk_sub_'))

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_preapproval_test_1',
          external_reference: body.external_reference,
          init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=mp_preapproval_test_1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_id=mp_preapproval_test_1',
          auto_recurring: body.auto_recurring,
          payer_id: 'payer_123',
          status: 'pending',
          next_payment_date: nextPaymentDate
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sub', 'cliente-mp-sub@example.test', '+5215555555501']
    )

    try {
      const subscription = await createSubscription({
        contactId: ids.contactId,
        name: 'Membresia Mercado Pago',
        amount: 149,
        intervalType: 'monthly',
        intervalCount: 1,
        startDate,
        paymentMethod: 'mercadopago_subscription',
        paymentProvider: 'mercadopago',
        status: 'incomplete'
      })
      ids.subscriptionId = subscription.id

      assert.equal(calls.length, 1)
      assert.equal(subscription.paymentProvider, 'mercadopago')
      assert.equal(subscription.paymentMethod, 'mercadopago_subscription')
      assert.equal(subscription.status, 'incomplete')
      assert.equal(subscription.mercadoPagoPreapprovalId, 'mp_preapproval_test_1')
      assert.equal(subscription.mercadoPagoSandboxInitPoint, 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_id=mp_preapproval_test_1')

      const saved = await db.get(
        `SELECT status, payment_provider, payment_method, mercadopago_preapproval_id, mercadopago_sandbox_init_point
         FROM subscriptions
         WHERE id = ?`,
        [subscription.id]
      )

      assert.equal(saved.status, 'incomplete')
      assert.equal(saved.payment_provider, 'mercadopago')
      assert.equal(saved.payment_method, 'mercadopago_subscription')
      assert.equal(saved.mercadopago_preapproval_id, 'mp_preapproval_test_1')
      assert.equal(saved.mercadopago_sandbox_init_point, subscription.mercadoPagoSandboxInitPoint)
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago ajusta suscripciones que inician hoy a una fecha futura', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_today_${suffix}`,
      subscriptionId: ''
    }
    const requestedStartDate = dateOnlyInDays(0)
    const beforeCreate = Date.now()

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/preapproval')
      assert.equal(options.method, 'POST')

      const body = JSON.parse(String(options.body || '{}'))
      const sentStartDate = new Date(body.auto_recurring.start_date)
      assert.equal(body.auto_recurring.frequency, 1)
      assert.equal(body.auto_recurring.frequency_type, 'months')
      assert.ok(!Number.isNaN(sentStartDate.getTime()))
      assert.ok(
        sentStartDate.getTime() >= beforeCreate + (9 * 60 * 1000),
        `expected Mercado Pago start_date to be safely in the future, got ${body.auto_recurring.start_date}`
      )

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_preapproval_today_test_1',
          external_reference: body.external_reference,
          init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=mp_preapproval_today_test_1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_id=mp_preapproval_today_test_1',
          auto_recurring: body.auto_recurring,
          status: 'pending',
          next_payment_date: body.auto_recurring.start_date
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Hoy', 'cliente-mp-hoy@example.test', '+5215555555502']
    )

    try {
      const subscription = await createSubscription({
        contactId: ids.contactId,
        name: 'Membresia Mercado Pago Hoy',
        amount: 149,
        intervalType: 'monthly',
        intervalCount: 1,
        startDate: requestedStartDate,
        paymentMethod: 'mercadopago_subscription',
        paymentProvider: 'mercadopago',
        status: 'incomplete'
      })
      ids.subscriptionId = subscription.id

      assert.equal(subscription.paymentProvider, 'mercadopago')
      assert.equal(subscription.status, 'incomplete')
      assert.equal(subscription.mercadoPagoPreapprovalId, 'mp_preapproval_today_test_1')
      assert.ok(new Date(subscription.nextRunAt).getTime() >= beforeCreate + (9 * 60 * 1000))
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago registra cobro recurrente por webhook subscription_authorized_payment', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_pay_${suffix}`,
      subscriptionId: `rstk_sub_mp_pay_${suffix}`
    }
    const startDate = dateOnlyInDays(1)
    const nextPaymentDate = localIsoInDays(31)

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')
      assert.equal(url, 'https://api.mercadopago.com/authorized_payments/auth_pay_1')
      assert.equal(options.method, 'GET')

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'auth_pay_1',
          type: 'scheduled',
          preapproval_id: 'mp_preapproval_pay_1',
          reason: 'Membresia MP cobrada',
          external_reference: ids.subscriptionId,
          currency_id: 'MXN',
          transaction_amount: '199.50',
          debit_date: nextPaymentDate,
          status: 'processed',
          summarized: 'charged',
          payment: {
            id: 'mp_payment_sub_1',
            status: 'approved',
            status_detail: 'accredited'
          }
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Cobro', 'cliente-mp-pay@example.test', '+5215555555502']
    )

    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, contact_email, contact_phone, name, description, status,
        amount, currency, interval_type, interval_count, start_date, next_run_at,
        payment_method, payment_provider, payment_mode, source, mercadopago_preapproval_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'MXN', 'monthly', 1, ?, ?, 'mercadopago_subscription', 'mercadopago', 'test', 'ristak', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.subscriptionId,
        ids.contactId,
        'Cliente MP Cobro',
        'cliente-mp-pay@example.test',
        '+5215555555502',
        'Membresia MP cobrada',
        '',
        199.5,
        startDate,
        nextPaymentDate,
        'mp_preapproval_pay_1'
      ]
    )

    try {
      const result = await handleMercadoPagoWebhookEvent({
        type: 'subscription_authorized_payment',
        action: 'subscription_authorized_payment.updated',
        data: { id: 'auth_pay_1' }
      }, {}, {})

      assert.equal(result.received, true)
      assert.equal(result.subscriptionId, ids.subscriptionId)
      assert.equal(result.status, 'approved')

      const payment = await db.get(
        `SELECT status, amount, currency, payment_method, payment_provider, reference, mercadopago_payment_id, metadata_json
         FROM payments
         WHERE mercadopago_payment_id = ?`,
        ['mp_payment_sub_1']
      )

      assert.equal(payment.status, 'paid')
      assert.equal(payment.amount, 199.5)
      assert.equal(payment.currency, 'MXN')
      assert.equal(payment.payment_method, 'mercadopago_subscription')
      assert.equal(payment.payment_provider, 'mercadopago')
      assert.equal(payment.reference, 'mp_authorized_payment:auth_pay_1')
      assert.ok(String(payment.metadata_json).includes(ids.subscriptionId))
    } finally {
      await cleanup(ids)
    }
  })
})
