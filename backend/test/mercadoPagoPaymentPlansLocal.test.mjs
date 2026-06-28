import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import {
  createMercadoPagoPaymentLink,
  createMercadoPagoPaymentPlan,
  createMercadoPagoRecurringSubscription,
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
    await setAppConfig('mercadopago_subscription_test_public_key', 'APP_USR-subscription-public-key')
    await setAppConfig('mercadopago_subscription_test_access_token_encrypted', encrypt('APP_USR-subscription-access-token'))
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
      paymentId: '',
      subscriptionId: ''
    }
    const preferenceCalls = []
    const cardPaymentCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.method, 'POST')

      if (url === 'https://api.mercadopago.com/preapproval_plan') {
        assert.equal(options.headers?.Authorization, 'Bearer APP_USR-subscription-access-token')
        const body = JSON.parse(String(options.body || '{}'))
        assert.equal(body.reason, 'Membresía Mercado Pago por link')
        assert.equal(Object.hasOwn(body, 'payer_email'), false)
        assert.equal(Object.hasOwn(body, 'status'), false)
        assert.equal(body.auto_recurring.transaction_amount, 189)
        assert.ok(String(body.back_url).includes('/api/mercadopago/subscriptions/return'))
        assert.ok(String(body.back_url).includes('subscription_id='))
        assert.ok(String(body.notification_url).includes('/api/mercadopago/webhook'))

        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'mp_preapproval_plan_card_link',
            external_reference: body.external_reference,
            init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_card_link',
            sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_card_link',
            auto_recurring: body.auto_recurring,
            status: 'active'
          })
        }
      }

      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')
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
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')
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

      const linkedSubscription = await createSubscription({
        contactId: ids.contactId,
        contactName: 'Cliente Card Mercado Pago',
        contactEmail: 'cliente-card@example.test',
        contactPhone: '+5215555555557',
        name: 'Membresía Mercado Pago por link',
        description: 'Suscripción iniciada por link público',
        amount: 189,
        currency: 'MXN',
        intervalType: 'monthly',
        intervalCount: 1,
        startDate: dateOnlyInDays(7),
        paymentMethod: 'mercadopago_checkout',
        paymentProvider: 'mercadopago',
        status: 'incomplete',
        baseUrl: 'https://app.example.test'
      })
      ids.subscriptionId = linkedSubscription.id
      assert.equal(linkedSubscription.paymentProvider, 'mercadopago')
      assert.equal(linkedSubscription.paymentMethod, 'mercadopago_subscription')
      assert.equal(linkedSubscription.status, 'incomplete')
      assert.equal(linkedSubscription.mercadoPagoPreapprovalId, null)
      assert.equal(linkedSubscription.mercadoPagoPreapprovalPlanId, 'mp_preapproval_plan_card_link')
      assert.equal(linkedSubscription.subscriptionStartUrl, 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_card_link')

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

test('Mercado Pago conserva paid si llega un payment in_process tardío', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const paymentId = `mp_no_downgrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.method, 'GET')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')
      assert.equal(url, 'https://api.mercadopago.com/v1/payments/mp_pending_late')

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'mp_pending_late',
          status: 'in_process',
          status_detail: 'pending_contingency',
          transaction_amount: 123.45,
          currency_id: 'MXN',
          payment_method_id: 'visa',
          payment_type_id: 'credit_card',
          external_reference: paymentId,
          preference_id: 'pref_late_pending',
          date_last_updated: '2026-06-20T20:05:00.000Z'
        })
      }
    })

    try {
      await db.run(
        `INSERT INTO payments (
          id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, mercadopago_payment_id, paid_at,
          date, created_at, updated_at
        ) VALUES (?, 123.45, 'MXN', 'paid', 'credit_card', 'test', 'mercadopago', ?, 'mp_approved_original', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, 'Mercado Pago pagado protegido']
      )

      const result = await handleMercadoPagoWebhookEvent({
        type: 'payment',
        action: 'payment.updated',
        data: { id: 'mp_pending_late' }
      }, {}, {})

      assert.equal(result.received, true)
      assert.equal(result.paymentId, paymentId)
      assert.equal(result.status, 'paid')

      const payment = await db.get(
        'SELECT status, paid_at, mercadopago_payment_id, mercadopago_preference_id, metadata_json FROM payments WHERE id = ?',
        [paymentId]
      )
      assert.equal(payment.status, 'paid')
      assert.ok(payment.paid_at)
      assert.equal(payment.mercadopago_payment_id, 'mp_pending_late')
      assert.equal(payment.mercadopago_preference_id, 'pref_late_pending')
      assert.equal(JSON.parse(payment.metadata_json).mercadoPago.status, 'in_process')
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    }
  })
})

test('Mercado Pago explica Invalid users involved en cobros publicos de prueba', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_invalid_users_${suffix}`,
      paymentId: ''
    }
    const cardPaymentCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'pref_invalid_users',
            init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=invalid_users',
            sandbox_init_point: 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=invalid_users'
          })
        }
      }

      assert.equal(url, 'https://api.mercadopago.com/v1/payments')
      const body = JSON.parse(String(options.body || '{}'))
      cardPaymentCalls.push(body)
      assert.equal(body.payer.email, 'comprador-test@example.com')

      return {
        ok: false,
        status: 400,
        json: async () => ({
          message: 'Invalid users involved',
          error: 'bad_request',
          cause: [
            {
              code: 2034,
              description: 'Invalid users involved'
            }
          ]
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Invalid Users', 'cliente-invalid-users@example.test', '+5215555555558']
    )

    try {
      const created = await createMercadoPagoPaymentLink({
        contactId: ids.contactId,
        contactName: 'Cliente MP Invalid Users',
        email: 'cliente-invalid-users@example.test',
        phone: '+5215555555558',
        amount: 200,
        currency: 'MXN',
        title: 'Pago Mercado Pago Invalid Users',
        description: 'Pago Mercado Pago Invalid Users',
        applyTax: false
      }, { baseUrl: 'https://app.example.test' })
      ids.paymentId = created.payment.id

      await assert.rejects(
        () => createPublicMercadoPagoCardPayment(created.publicPaymentId, {
          token: 'tok_card_test',
          paymentMethodId: 'master',
          installments: 1,
          idempotencyKey: 'card-invalid-users-key',
          payer: {
            email: 'comprador-test@example.com'
          }
        }, { baseUrl: 'https://app.example.test' }),
        (error) => {
          assert.equal(error.status, 400)
          assert.match(error.message, /ayuda de pruebas/i)
          assert.match(error.message, /cualquier correo válido/i)
          assert.match(error.message, /APRO/i)
          assert.match(error.message, /FUND/i)
          assert.equal(error.payload?.cause?.[0]?.code, 2034)
          return true
        }
      )

      assert.equal(cardPaymentCalls.length, 1)
      const saved = await db.get('SELECT status FROM payments WHERE id = ?', [ids.paymentId])
      assert.equal(saved.status, 'sent')
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago limita cuotas configuradas en links de pago unico', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_installments_${suffix}`,
      paymentId: ''
    }
    const preferenceCalls = []
    const cardPaymentCalls = []

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        assert.equal(options.method, 'POST')
        const body = JSON.parse(String(options.body || '{}'))
        preferenceCalls.push(body)

        assert.equal(body.payment_methods.installments, 6)
        assert.equal(body.metadata.mercado_pago_installments.maxInstallments, 6)

        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'pref_installments_6',
            init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=installments_6',
            sandbox_init_point: 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=installments_6'
          })
        }
      }

      assert.equal(url, 'https://api.mercadopago.com/v1/payments')
      const body = JSON.parse(String(options.body || '{}'))
      cardPaymentCalls.push(body)
      assert.equal(body.installments, 6)

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_card_installments_6',
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 600,
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
      [ids.contactId, 'Cliente MSI Mercado Pago', 'cliente-msi@example.test', '+5215555555511']
    )

    try {
      const created = await createMercadoPagoPaymentLink({
        contactId: ids.contactId,
        contactName: 'Cliente MSI Mercado Pago',
        email: 'cliente-msi@example.test',
        phone: '+5215555555511',
        amount: 600,
        currency: 'MXN',
        title: 'Pago con MSI Mercado Pago',
        description: 'Pago con MSI Mercado Pago',
        applyTax: false,
        installments: {
          enabled: true,
          maxInstallments: 6
        }
      }, { baseUrl: 'https://app.example.test' })

      ids.paymentId = created.payment.id
      assert.equal(preferenceCalls.length, 1)
      assert.equal(created.payment.mercadoPagoInstallments.enabled, true)
      assert.equal(created.payment.mercadoPagoInstallments.maxInstallments, 6)

      await assert.rejects(
        () => createPublicMercadoPagoCardPayment(created.publicPaymentId, {
          token: 'tok_card_test',
          paymentMethodId: 'visa',
          issuerId: '123',
          installments: 12,
          idempotencyKey: 'card-installments-too-high',
          payer: { email: 'cliente-msi@example.test' }
        }, { baseUrl: 'https://app.example.test' }),
        /máximo 6 cuotas/i
      )
      assert.equal(cardPaymentCalls.length, 0)

      const charged = await createPublicMercadoPagoCardPayment(created.publicPaymentId, {
        token: 'tok_card_test',
        paymentMethodId: 'visa',
        issuerId: '123',
        installments: 6,
        idempotencyKey: 'card-installments-ok',
        payer: { email: 'cliente-msi@example.test' }
      }, { baseUrl: 'https://app.example.test' })

      assert.equal(cardPaymentCalls.length, 1)
      assert.equal(charged.payment.status, 'paid')
      assert.equal(charged.payment.mercadoPagoInstallments.maxInstallments, 6)
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago explica Invalid test user email en cobros publicos de prueba', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_invalid_email_${suffix}`,
      paymentId: ''
    }

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, 'Bearer TEST-access-token')

      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'pref_invalid_email',
            init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=invalid_email',
            sandbox_init_point: 'https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=invalid_email'
          })
        }
      }

      assert.equal(url, 'https://api.mercadopago.com/v1/payments')
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.payer.email, 'comprador-normal@example.com')

      return {
        ok: false,
        status: 400,
        json: async () => ({
          message: 'Invalid test user email',
          error: 'bad_request',
          cause: [
            {
              code: 2198,
              description: 'Invalid test user email'
            }
          ]
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Invalid Email', 'cliente-invalid-email@example.test', '+5215555555559']
    )

    try {
      const created = await createMercadoPagoPaymentLink({
        contactId: ids.contactId,
        contactName: 'Cliente MP Invalid Email',
        email: 'cliente-invalid-email@example.test',
        phone: '+5215555555559',
        amount: 200,
        currency: 'MXN',
        title: 'Pago Mercado Pago Invalid Email',
        description: 'Pago Mercado Pago Invalid Email',
        applyTax: false
      }, { baseUrl: 'https://app.example.test' })
      ids.paymentId = created.payment.id

      await assert.rejects(
        () => createPublicMercadoPagoCardPayment(created.publicPaymentId, {
          token: 'tok_card_test',
          paymentMethodId: 'master',
          installments: 1,
          idempotencyKey: 'card-invalid-email-key',
          payer: {
            email: 'comprador-normal@example.com'
          }
        }, { baseUrl: 'https://app.example.test' }),
        (error) => {
          assert.equal(error.status, 400)
          assert.match(error.message, /ayuda de pruebas/i)
          assert.match(error.message, /cualquier correo válido/i)
          assert.match(error.message, /APRO/i)
          assert.match(error.message, /FUND/i)
          assert.equal(error.payload?.cause?.[0]?.code, 2198)
          return true
        }
      )

      const saved = await db.get('SELECT status FROM payments WHERE id = ?', [ids.paymentId])
      assert.equal(saved.status, 'sent')
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

test('Mercado Pago bloquea links de suscripcion test sin credenciales APP_USR', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    await db.run("DELETE FROM app_config WHERE config_key IN ('mercadopago_subscription_test_public_key', 'mercadopago_subscription_test_access_token_encrypted')")
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_missing_appusr_${suffix}`,
      subscriptionId: ''
    }

    setMercadoPagoFetchForTest(async () => {
      throw new Error('No debe llamar a Mercado Pago sin credenciales APP_USR de suscripción.')
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sin APP_USR', 'cliente-mp-sin-appusr@example.test', '+5215555555599']
    )

    try {
      await assert.rejects(
        () => createSubscription({
          contactId: ids.contactId,
          name: 'Membresia Mercado Pago Sin APP_USR',
          amount: 149,
          intervalType: 'monthly',
          intervalCount: 1,
          startDate: dateOnlyInDays(1),
          paymentMethod: 'mercadopago_subscription',
          paymentProvider: 'mercadopago',
          status: 'incomplete'
        }),
        (error) => {
          assert.equal(error.status, 400)
          assert.match(error.message, /credenciales TEST/i)
          assert.match(error.message, /APP_USR/i)
          return true
        }
      )
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago crea link abierto de suscripcion con preapproval plan', async () => {
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
      assert.equal(options.headers?.Authorization, 'Bearer APP_USR-subscription-access-token')
      assert.equal(Object.hasOwn(options.headers || {}, 'X-scope'), false)
      assert.equal(url, 'https://api.mercadopago.com/preapproval_plan')
      assert.equal(options.method, 'POST')

      const body = JSON.parse(String(options.body || '{}'))
      calls.push(body)

      assert.equal(body.reason, 'Membresia Mercado Pago')
      assert.equal(Object.hasOwn(body, 'payer_email'), false)
      assert.equal(Object.hasOwn(body, 'status'), false)
      assert.equal(body.auto_recurring.frequency, 1)
      assert.equal(body.auto_recurring.frequency_type, 'months')
      assert.equal(body.auto_recurring.transaction_amount, 149)
      assert.equal(body.auto_recurring.currency_id, 'MXN')
      assert.equal(Object.hasOwn(body.auto_recurring, 'start_date'), false)
      assert.ok(String(body.back_url).includes('/api/mercadopago/subscriptions/return'))
      assert.ok(String(body.back_url).includes('subscription_id='))
      if (body.notification_url) assert.ok(String(body.notification_url).includes('/api/mercadopago/webhook'))
      assert.ok(String(body.external_reference).startsWith('rstk_sub_'))

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_preapproval_plan_test_1',
          external_reference: body.external_reference,
          init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_test_1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_test_1',
          auto_recurring: body.auto_recurring,
          status: 'active',
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
      assert.equal(subscription.mercadoPagoPreapprovalId, null)
      assert.equal(subscription.mercadoPagoPreapprovalPlanId, 'mp_preapproval_plan_test_1')
      assert.equal(subscription.mercadoPagoSandboxInitPoint, 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_test_1')
      assert.equal(subscription.subscriptionStartUrl, 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_test_1')

      const saved = await db.get(
        `SELECT status, payment_provider, payment_method, mercadopago_preapproval_id, mercadopago_preapproval_plan_id, mercadopago_sandbox_init_point
         FROM subscriptions
         WHERE id = ?`,
        [subscription.id]
      )

      assert.equal(saved.status, 'incomplete')
      assert.equal(saved.payment_provider, 'mercadopago')
      assert.equal(saved.payment_method, 'mercadopago_subscription')
      assert.equal(saved.mercadopago_preapproval_id, null)
      assert.equal(saved.mercadopago_preapproval_plan_id, 'mp_preapproval_plan_test_1')
      assert.equal(saved.mercadopago_sandbox_init_point, subscription.mercadoPagoSandboxInitPoint)

      setMercadoPagoFetchForTest(async (url, options = {}) => {
        assert.equal(options.method || 'GET', 'GET')
        if (url === 'https://api.mercadopago.com/authorized_payments/search?preapproval_id=mp_preapproval_authorized_1&limit=20') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              paging: { total: 0, limit: 20, offset: 0 },
              results: []
            })
          }
        }

        assert.equal(url, 'https://api.mercadopago.com/preapproval/mp_preapproval_authorized_1')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'mp_preapproval_authorized_1',
            preapproval_plan_id: 'mp_preapproval_plan_test_1',
            external_reference: subscription.id,
            status: 'authorized',
            payer_id: 'payer_123',
            card_id: 'card_123',
            payment_method_id: 'master',
            next_payment_date: nextPaymentDate,
            auto_recurring: calls[0].auto_recurring
          })
        }
      })

      const webhookResult = await handleMercadoPagoWebhookEvent({
        type: 'subscription_preapproval',
        action: 'subscription_preapproval.updated',
        data: { id: 'mp_preapproval_authorized_1' }
      }, {}, {})

      assert.equal(webhookResult.subscriptionId, subscription.id)
      assert.equal(webhookResult.status, 'active')

      const activated = await db.get(
        `SELECT status, mercadopago_preapproval_id, mercadopago_preapproval_plan_id, mercadopago_next_payment_date
         FROM subscriptions
         WHERE id = ?`,
        [subscription.id]
      )
      assert.equal(activated.status, 'active')
      assert.equal(activated.mercadopago_preapproval_id, 'mp_preapproval_authorized_1')
      assert.equal(activated.mercadopago_preapproval_plan_id, 'mp_preapproval_plan_test_1')
      assert.equal(activated.mercadopago_next_payment_date, new Date(nextPaymentDate).toISOString())
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago sincroniza suscripcion y cobro desde evento de preapproval plan', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_plan_sync_${suffix}`,
      subscriptionId: ''
    }
    const nextPaymentDate = localIsoInDays(31)
    const debitDate = localIsoInDays(0)

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer APP_USR-subscription-access-token')

      if (url === 'https://api.mercadopago.com/preapproval_plan') {
        assert.equal(options.method, 'POST')
        const body = JSON.parse(String(options.body || '{}'))
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'mp_preapproval_plan_sync_1',
            external_reference: body.external_reference,
            init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_sync_1',
            sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_sync_1',
            auto_recurring: body.auto_recurring,
            status: 'active'
          })
        }
      }

      if (url === 'https://api.mercadopago.com/preapproval/search?preapproval_plan_id=mp_preapproval_plan_sync_1&limit=20') {
        assert.equal(options.method || 'GET', 'GET')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paging: { total: 1, limit: 20, offset: 0 },
            results: [{
              id: 'mp_preapproval_sync_1',
              preapproval_plan_id: 'mp_preapproval_plan_sync_1',
              external_reference: ids.subscriptionId,
              status: 'authorized',
              payer_id: 'payer_sync_1',
              card_id: 'card_sync_1',
              payment_method_id: 'master',
              next_payment_date: nextPaymentDate,
              auto_recurring: {
                frequency: 1,
                frequency_type: 'months',
                transaction_amount: 122,
                currency_id: 'MXN'
              }
            }]
          })
        }
      }

      if (url === 'https://api.mercadopago.com/authorized_payments/search?preapproval_id=mp_preapproval_sync_1&limit=20') {
        assert.equal(options.method || 'GET', 'GET')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paging: { total: 1, limit: 20, offset: 0 },
            results: [{
              id: 'auth_pay_sync_1',
              preapproval_id: 'mp_preapproval_sync_1',
              currency_id: 'MXN',
              transaction_amount: 122,
              debit_date: debitDate,
              status: 'processed',
              summarized: 'charged',
              payment: {
                id: 'mp_payment_sync_1',
                status: 'approved',
                status_detail: 'accredited',
                date_approved: debitDate
              }
            }]
          })
        }
      }

      throw new Error(`URL Mercado Pago no esperada: ${url}`)
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sync', 'cliente-mp-sync@example.test', '+5215555555503']
    )

    try {
      const subscription = await createSubscription({
        contactId: ids.contactId,
        name: 'Membresia Mercado Pago Sync',
        amount: 122,
        intervalType: 'monthly',
        intervalCount: 1,
        startDate: dateOnlyInDays(0),
        paymentMethod: 'mercadopago_subscription',
        paymentProvider: 'mercadopago',
        status: 'incomplete'
      })
      ids.subscriptionId = subscription.id

      const webhookResult = await handleMercadoPagoWebhookEvent({
        type: 'subscription_preapproval_plan',
        action: 'subscription_preapproval_plan.updated',
        data: { id: 'mp_preapproval_plan_sync_1' }
      }, {}, {})

      assert.equal(webhookResult.subscriptionId, subscription.id)
      assert.equal(webhookResult.status, 'active')

      const activated = await db.get(
        `SELECT status, mercadopago_preapproval_id, mercadopago_preapproval_plan_id, mercadopago_payment_method_id
         FROM subscriptions
         WHERE id = ?`,
        [subscription.id]
      )
      assert.equal(activated.status, 'active')
      assert.equal(activated.mercadopago_preapproval_id, 'mp_preapproval_sync_1')
      assert.equal(activated.mercadopago_preapproval_plan_id, 'mp_preapproval_plan_sync_1')
      assert.equal(activated.mercadopago_payment_method_id, 'master')

      const payment = await db.get(
        `SELECT status, payment_method, payment_provider, mercadopago_payment_id, reference, amount
         FROM payments
         WHERE metadata_json LIKE ?
         LIMIT 1`,
        [`%${subscription.id}%`]
      )
      assert.equal(payment.status, 'paid')
      assert.equal(payment.payment_method, 'mercadopago_subscription')
      assert.equal(payment.payment_provider, 'mercadopago')
      assert.equal(payment.mercadopago_payment_id, 'mp_payment_sync_1')
      assert.equal(payment.reference, 'mp_authorized_payment:auth_pay_sync_1')
      assert.equal(Number(payment.amount), 122)
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago explica usuario test requerido al crear suscripcion preapproval', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_invalid_users_${suffix}`,
      subscriptionId: ''
    }

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/preapproval')
      assert.equal(options.method, 'POST')
      assert.equal(Object.hasOwn(options.headers || {}, 'X-scope'), false)
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.payer_email, 'cliente-real@example.test')

      return {
        ok: false,
        status: 400,
        json: async () => ({
          message: 'Both payer and collector must be real or test users',
          error: 'bad_request',
          cause: [
            {
              code: 2034,
              description: 'Both payer and collector must be real or test users'
            }
          ]
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sub Error', 'cliente-real@example.test', `+52155${String(Date.now()).slice(-8)}`]
    )

    try {
      await assert.rejects(
        () => createMercadoPagoRecurringSubscription({
          ristakSubscriptionId: `rstk_sub_invalid_users_${suffix}`,
          name: 'Membresia Mercado Pago Error',
          amount: 149,
          currency: 'MXN',
          intervalType: 'monthly',
          intervalCount: 1,
          startDate: dateOnlyInDays(1),
          contactEmail: 'cliente-real@example.test'
        }, { baseUrl: 'https://app.example.test' }),
        (error) => {
          assert.equal(error.status, 400)
          assert.match(error.message, /comprador test de Mercado Pago/i)
          assert.match(error.message, /mismo país/i)
          assert.match(error.message, /modo en vivo/i)
          assert.equal(error.payload?.cause?.[0]?.code, 2034)
          return true
        }
      )
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago explica error interno al crear suscripcion preapproval', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_internal_error_${suffix}`,
      subscriptionId: ''
    }

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/preapproval')
      assert.equal(options.method, 'POST')
      assert.equal(Object.hasOwn(options.headers || {}, 'X-scope'), false)
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.status, 'pending')
      assert.equal(Object.hasOwn(body.auto_recurring, 'start_date'), false)

      return {
        ok: false,
        status: 500,
        json: async () => ({
          message: 'Internal server error',
          error: 'internal_server_error'
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sub 500', 'comprador-test@example.test', `+52156${String(Date.now()).slice(-8)}`]
    )

    try {
      await assert.rejects(
        () => createMercadoPagoRecurringSubscription({
          ristakSubscriptionId: `rstk_sub_internal_error_${suffix}`,
          name: 'Membresia Mercado Pago 500',
          amount: 149,
          currency: 'MXN',
          intervalType: 'monthly',
          intervalCount: 1,
          startDate: dateOnlyInDays(1),
          contactEmail: 'comprador-test@example.test'
        }, { baseUrl: 'https://app.example.test' }),
        (error) => {
          assert.equal(error.status, 500)
          assert.match(error.message, /error interno al crear la suscripción/i)
          assert.match(error.message, /APRO aplica al nombre de tarjeta/i)
          assert.match(error.message, /comprador test/i)
          return true
        }
      )
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago explica policy unauthorized al crear suscripcion preapproval', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_policy_error_${suffix}`,
      subscriptionId: ''
    }

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://api.mercadopago.com/preapproval')
      assert.equal(options.method, 'POST')
      assert.equal(Object.hasOwn(options.headers || {}, 'X-scope'), false)
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.status, 'pending')
      assert.equal(Object.hasOwn(body.auto_recurring, 'start_date'), false)

      return {
        ok: false,
        status: 401,
        json: async () => ({
          message: 'At least one policy returned UNAUTHORIZED.',
          error: 'unauthorized'
        })
      }
    })

    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.contactId, 'Cliente MP Sub Policy', 'comprador-test-policy@example.test', `+52157${String(Date.now()).slice(-8)}`]
    )

    try {
      await assert.rejects(
        () => createMercadoPagoRecurringSubscription({
          ristakSubscriptionId: `rstk_sub_policy_error_${suffix}`,
          name: 'Membresia Mercado Pago Policy',
          amount: 149,
          currency: 'MXN',
          intervalType: 'monthly',
          intervalCount: 1,
          startDate: dateOnlyInDays(1),
          contactEmail: 'comprador-test-policy@example.test'
        }, { baseUrl: 'https://app.example.test' }),
        (error) => {
          assert.equal(error.status, 401)
          assert.match(error.message, /no autorizó crear la suscripción/i)
          assert.match(error.message, /Reconecta Mercado Pago/i)
          assert.match(error.message, /vendedor test y un comprador test/i)
          return true
        }
      )
    } finally {
      await cleanup(ids)
    }
  })
})

test('Mercado Pago no fuerza start_date al crear link pendiente de suscripcion', async () => {
  await initializeMasterKey()

  await snapshotMercadoPagoConfig(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ids = {
      contactId: `contact_mp_sub_today_${suffix}`,
      subscriptionId: ''
    }
    const requestedStartDate = dateOnlyInDays(0)
    setMercadoPagoFetchForTest(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer APP_USR-subscription-access-token')
      assert.equal(url, 'https://api.mercadopago.com/preapproval_plan')
      assert.equal(options.method, 'POST')
      assert.equal(Object.hasOwn(options.headers || {}, 'X-scope'), false)

      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.auto_recurring.frequency, 1)
      assert.equal(body.auto_recurring.frequency_type, 'months')
      assert.equal(Object.hasOwn(body.auto_recurring, 'start_date'), false)
      if (body.notification_url) assert.ok(String(body.notification_url).includes('/api/mercadopago/webhook'))

      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'mp_preapproval_plan_today_test_1',
          external_reference: body.external_reference,
          init_point: 'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_today_test_1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.mx/subscriptions/checkout?preapproval_plan_id=mp_preapproval_plan_today_test_1',
          auto_recurring: body.auto_recurring,
          status: 'active'
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
      assert.equal(subscription.mercadoPagoPreapprovalId, null)
      assert.equal(subscription.mercadoPagoPreapprovalPlanId, 'mp_preapproval_plan_today_test_1')
      assert.ok(new Date(subscription.nextRunAt).getTime() > Date.now())
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
      assert.equal(options.headers?.Authorization, 'Bearer APP_USR-subscription-access-token')
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
