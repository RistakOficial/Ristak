import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import {
  actionSubscription,
  createSubscription,
  deleteSubscription
} from '../src/services/subscriptionsService.js'
import {
  createConektaPaymentLink,
  createConektaPaymentPlan,
  createConektaRecurringSubscription,
  createConektaSavedCardPayment,
  createPublicConektaCardPayment,
  getConektaPaymentConfig,
  pauseConektaRecurringSubscription,
  processDueConektaPaymentPlanCharges,
  reconcileConektaOrderFromWebhook,
  reconcileConektaSubscriptionFromWebhook,
  resumeConektaRecurringSubscription,
  saveConektaPaymentConfig,
  setConektaFetchForTest,
  cancelConektaRecurringSubscription,
  testConektaPaymentConfig
} from '../src/services/conektaPaymentService.js'

async function snapshotConektaConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'conekta_%' OR config_key = 'payments_settings'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'conekta_%' OR config_key = 'payments_settings'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'conekta_%' OR config_key = 'payments_settings'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
    setConektaFetchForTest(null)
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

function todayConektaDateOnly() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

test('Conekta manual: el modo global de pasarelas selecciona las credenciales activas', async () => {
  await initializeMasterKey()

  await snapshotConektaConfig(async () => {
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publicKey: 'key_test_global_public',
          privateKey: 'key_test_global_private'
        },
        live: {
          publicKey: 'key_live_global_public',
          privateKey: 'key_live_global_private'
        }
      }
    })

    await savePaymentSettings({ paymentMode: 'test' })
    const testConfig = await getConektaPaymentConfig({ includeSecrets: true })
    assert.equal(testConfig.mode, 'test')
    assert.equal(testConfig.configured, true)
    assert.equal(testConfig.publicKey, 'key_test_global_public')
    assert.equal(testConfig.privateKey, 'key_test_global_private')

    await savePaymentSettings({ paymentMode: 'live' })
    const liveConfig = await getConektaPaymentConfig({ includeSecrets: true })
    assert.equal(liveConfig.mode, 'live')
    assert.equal(liveConfig.configured, true)
    assert.equal(liveConfig.publicKey, 'key_live_global_public')
    assert.equal(liveConfig.privateKey, 'key_live_global_private')
  })
})

test('Conekta manual: guarda llaves por modo cifradas y conserva privadas enmascaradas', async () => {
  await initializeMasterKey()

  await snapshotConektaConfig(async () => {
    const config = await saveConektaPaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publicKey: 'key_test_public',
          privateKey: 'key_test_private'
        },
        live: {
          publicKey: 'key_live_public',
          privateKey: 'key_live_private'
        }
      }
    })

    assert.equal(config.configured, true)
    assert.equal(config.mode, 'live')
    assert.equal(config.publicKey, 'key_live_public')
    assert.equal(config.hasPrivateKey, true)
    assert.equal(config.privateKey, undefined)
    assert.equal(config.manualModes.test.configured, true)
    assert.equal(config.manualModes.live.configured, true)

    const privateRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['conekta_private_key_encrypted']
    )
    assert.ok(privateRow?.config_value)
    assert.equal(privateRow.config_value.includes('key_live_private'), false)

    const modesRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['conekta_mode_connections']
    )
    assert.ok(modesRow?.config_value)
    assert.equal(modesRow.config_value.includes('key_test_private'), false)
    assert.equal(modesRow.config_value.includes('key_live_private'), false)

    const masked = await getConektaPaymentConfig()
    const preserved = await saveConektaPaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        live: {
          publicKey: 'key_live_public',
          privateKey: masked.manualModes.live.privateKeyPreview
        }
      }
    })

    assert.equal(preserved.configured, true)
    assert.equal(preserved.hasPrivateKey, true)
  })
})

test('Conekta payment flow: crea link, guarda payment_source y cobra tarjeta guardada', async () => {
  await initializeMasterKey()

  const contactId = `contact_conekta_${Date.now()}`
  const createdPaymentIds = []

  await snapshotConektaConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, email, full_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `conekta-${Date.now()}@example.test`, 'Cliente_QA 2026 *** Conekta', '5555555555']
    )

    const calls = []
    setConektaFetchForTest(async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })

      if (url.endsWith('/customers?limit=1')) {
        return jsonResponse({ data: [] })
      }

      if (url.endsWith('/customers') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.name, 'Cliente QA Conekta')
        assert.doesNotMatch(body.name, /[0-9_*]/)
        return jsonResponse({ id: 'cus_test_123' })
      }

      if (url.endsWith('/customers/cus_test_123/payment_sources') && options.method === 'POST') {
        assert.equal(JSON.parse(options.body).token_id, 'tok_test_123')
        return jsonResponse({
          id: 'src_test_123',
          object: 'payment_source',
          type: 'card',
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030
        })
      }

      if (url.endsWith('/orders') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.currency, 'MXN')
        assert.equal(body.customer_info.customer_id, 'cus_test_123')
        assert.equal(body.charges[0].payment_method.type, 'card')
        assert.doesNotMatch(body.line_items[0].name, /[_*]/)
        assert.doesNotMatch(body.line_items[0].description, /[_*]/)
        return jsonResponse({
          id: `ord_${calls.length}`,
          payment_status: 'paid',
          charges: {
            data: [{
              id: `charge_${calls.length}`,
              status: 'paid',
              payment_method: {
                type: 'card',
                payment_source_id: body.charges[0].payment_method.payment_source_id || 'src_test_123'
              }
            }]
          }
        })
      }

      if (url.endsWith('/plans') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.currency, 'MXN')
        assert.equal(body.amount > 0, true)
        assert.equal(['week', 'month', 'year'].includes(body.interval), true)
        return jsonResponse({
          id: body.id || 'plan_test_123',
          name: body.name,
          amount: body.amount,
          currency: body.currency,
          interval: body.interval,
          frequency: body.frequency,
          status: 'active'
        })
      }

      if (url.endsWith('/checkouts') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.type, 'PaymentLink')
        assert.deepEqual(body.allowed_payment_methods, ['card'])
        assert.equal(Array.isArray(body.plan_ids), true)
        assert.equal(body.needs_shipping_contact, false)
        assert.equal(body.order_template.customer_info.email.includes('@example.test'), true)
        return jsonResponse({
          id: 'checkout_test_123',
          object: 'checkout',
          url: 'https://pay.conekta.com/link/subscription_test_123'
        })
      }

      if (url.endsWith('/customers/cus_test_123/subscriptions') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(Boolean(body.plan_id), true)
        assert.equal(body.card_id, 'src_test_123')
        return jsonResponse({
          id: 'sub_test_123',
          status: 'active',
          billing_cycle_start: 1782000000,
          billing_cycle_end: 1784678400,
          next_billing_at: 1784678400
        })
      }

      if (url.endsWith('/customers/cus_test_123/subscriptions/sub_test_123/pause') && options.method === 'POST') {
        return jsonResponse({ id: 'sub_test_123', status: 'paused' })
      }

      if (url.endsWith('/customers/cus_test_123/subscriptions/sub_test_123/resume') && options.method === 'POST') {
        return jsonResponse({ id: 'sub_test_123', status: 'active' })
      }

      if (url.endsWith('/customers/cus_test_123/subscriptions/sub_test_123/cancel') && options.method === 'POST') {
        return jsonResponse({ id: 'sub_test_123', status: 'canceled' })
      }

      return jsonResponse({ message: 'unexpected request' }, 500)
    })

    await savePaymentSettings({ paymentMode: 'test' })
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publicKey: 'key_test_public',
          privateKey: 'key_test_private'
        }
      }
    })

    const testResult = await testConektaPaymentConfig()
    assert.equal(testResult.ok, true)

    const linkResult = await createConektaPaymentLink({
      contactId,
      contactName: 'Cliente Conekta',
      email: `conekta-${Date.now()}@example.test`,
      amount: 100,
      currency: 'MXN',
      title: 'Pago_QA *** Conekta',
      description: 'Pago_QA *** Conekta'
    }, { baseUrl: 'https://app.example.test' })
    createdPaymentIds.push(linkResult.payment.id)

    assert.equal(linkResult.payment.provider, 'conekta')
    assert.match(linkResult.paymentUrl, /^https:\/\/app\.example\.test\/pay\/pay_/)

    const publicResult = await createPublicConektaCardPayment(linkResult.publicPaymentId, {
      tokenId: 'tok_test_123',
      savePaymentSource: true
    }, { baseUrl: 'https://app.example.test' })

    assert.equal(publicResult.payment.status, 'paid')
    assert.equal(publicResult.conektaPaymentSourceId, 'src_test_123')

    const savedSources = await db.all(
      'SELECT * FROM conekta_payment_sources WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(savedSources.length, 1)
    assert.equal(savedSources[0].conekta_payment_source_id, 'src_test_123')

    const savedCardResult = await createConektaSavedCardPayment({
      contactId,
      paymentSourceId: 'src_test_123',
      amount: 50,
      currency: 'MXN',
      title: 'Segundo cobro'
    })
    createdPaymentIds.push(savedCardResult.payment.id)

    assert.equal(savedCardResult.payment.status, 'paid')
    assert.equal(savedCardResult.payment.conektaOrderId.startsWith('ord_'), true)

    const contact = await db.get('SELECT conekta_customer_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.conekta_customer_id, 'cus_test_123')

    const today = todayConektaDateOnly()
    const linkedSubscription = await createSubscription({
      contactId,
      contactName: 'Cliente Conekta',
      contactEmail: `conekta-${Date.now()}@example.test`,
      contactPhone: '5555555555',
      name: 'Membresía Conekta por link',
      description: 'Suscripción iniciada por link público',
      amount: 210,
      currency: 'MXN',
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: today,
      paymentProvider: 'conekta',
      paymentMethod: 'conekta_link',
      status: 'incomplete',
      baseUrl: 'https://app.example.test'
    })

    assert.equal(linkedSubscription.paymentProvider, 'conekta')
    assert.equal(linkedSubscription.paymentMethod, 'conekta_link')
    assert.equal(linkedSubscription.status, 'incomplete')
    assert.equal(linkedSubscription.conektaSubscriptionId, null)
    assert.equal(linkedSubscription.conektaCheckoutUrl, 'https://pay.conekta.com/link/subscription_test_123')
    assert.equal(linkedSubscription.subscriptionStartUrl, 'https://pay.conekta.com/link/subscription_test_123')
    assert.equal(linkedSubscription.subscriptionStartPublicPaymentId, null)

    const planResult = await createConektaPaymentPlan({
      contact: {
        id: contactId,
        name: 'Cliente Conekta',
        email: `conekta-${Date.now()}@example.test`,
        phone: '5555555555'
      },
      totalAmount: 150,
      currency: 'MXN',
      title: 'Plan Conekta',
      description: 'Plan Conekta',
      firstPayment: {
        enabled: true,
        amount: 50,
        date: today,
        method: 'cash'
      },
      remainingPayments: [{
        sequence: 1,
        amount: 100,
        dueDate: today,
        frequency: 'monthly'
      }],
      remainingFrequency: 'monthly',
      cardSetupAmount: 25
    }, { baseUrl: 'https://app.example.test' })

    assert.equal(planResult.currentState, 'waiting_card_authorization')
    assert.match(planResult.cardSetupLink, /^https:\/\/app\.example\.test\/pay\/pay_/)
    assert.equal(planResult.scheduledPayments.length, 1)

    const firstPlanPayment = await db.get(
      'SELECT status, payment_provider, payment_mode FROM payments WHERE id = ?',
      [planResult.firstPaymentPaymentId]
    )
    assert.equal(firstPlanPayment.status, 'paid')
    assert.equal(firstPlanPayment.payment_provider, 'manual')
    assert.equal(firstPlanPayment.payment_mode, 'test')

    const setupPayment = await db.get('SELECT public_payment_id FROM payments WHERE id = ?', [planResult.cardSetupPaymentId])
    assert.ok(setupPayment?.public_payment_id)
    await createPublicConektaCardPayment(setupPayment.public_payment_id, {
      tokenId: 'tok_test_123',
      savePaymentSource: true
    }, { baseUrl: 'https://app.example.test' })

    const activeFlow = await db.get('SELECT current_state, conekta_payment_source_id FROM payment_flows WHERE id = ?', [planResult.flowId])
    assert.equal(activeFlow.current_state, 'installment_plan_active')
    assert.equal(activeFlow.conekta_payment_source_id, 'src_test_123')

    const dueRun = await processDueConektaPaymentPlanCharges({ limit: 5 })
    assert.equal(dueRun.succeeded >= 1, true)

    const paidInstallment = await db.get('SELECT status FROM installment_payments WHERE flow_id = ? AND sequence = 1', [planResult.flowId])
    assert.equal(paidInstallment.status, 'paid')

    const subscription = await createConektaRecurringSubscription({
      ristakSubscriptionId: `sub_${Date.now()}`,
      contactId,
      paymentMethodId: 'src_test_123',
      name: 'Membresía Conekta',
      amount: 200,
      currency: 'MXN',
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: today
    })
    assert.equal(subscription.conektaSubscriptionId, 'sub_test_123')
    assert.equal(subscription.conektaPaymentSourceId, 'src_test_123')
    assert.equal(subscription.status, 'active')

    const paused = await pauseConektaRecurringSubscription('cus_test_123', 'sub_test_123')
    assert.equal(paused.payload.status, 'paused')
    const resumed = await resumeConektaRecurringSubscription('cus_test_123', 'sub_test_123')
    assert.equal(resumed.payload.status, 'active')
    const cancelled = await cancelConektaRecurringSubscription('cus_test_123', 'sub_test_123')
    assert.equal(cancelled.payload.status, 'canceled')

    const localSubscription = await createSubscription({
      contactId,
      name: 'Membresía local Conekta',
      description: 'Suscripción creada desde subscriptionsService',
      amount: 210,
      currency: 'MXN',
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: today,
      paymentProvider: 'conekta',
      paymentMethod: 'conekta_subscription',
      conektaPaymentSourceId: 'src_test_123'
    })
    assert.equal(localSubscription.paymentProvider, 'conekta')
    assert.equal(localSubscription.conektaSubscriptionId, 'sub_test_123')

    const pausedLocal = await actionSubscription(localSubscription.id, 'pause')
    assert.equal(pausedLocal.status, 'paused')
    const resumedLocal = await actionSubscription(localSubscription.id, 'resume')
    assert.equal(resumedLocal.status, 'active')
    const cancelledLocal = await actionSubscription(localSubscription.id, 'cancel')
    assert.equal(cancelledLocal.status, 'cancelled')
    const deletedLocal = await deleteSubscription(localSubscription.id)
    assert.equal(deletedLocal, true)
  })

  try {
    await db.run('DELETE FROM subscriptions WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conekta_payment_sources WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  } catch {
    // Limpieza best-effort para no ocultar la aserción principal.
  }
})

test('Conekta suscripciones: link crea checkout hospedado y webhook activa suscripcion', async () => {
  await initializeMasterKey()

  const idSuffix = Date.now()
  const contactId = `contact_conekta_subscription_link_${idSuffix}`
  const planId = `plan_subscription_link_${idSuffix}`
  const checkoutId = `checkout_subscription_link_${idSuffix}`
  const subscriptionId = `sub_subscription_link_${idSuffix}`
  const orderId = `ord_subscription_link_${idSuffix}`
  const chargeId = `charge_subscription_link_${idSuffix}`
  const failedOrderId = `ord_subscription_link_failed_${idSuffix}`
  const secondOrderId = `ord_subscription_link_second_${idSuffix}`
  const secondChargeId = `charge_subscription_link_second_${idSuffix}`
  const customerId = `cus_subscription_link_${idSuffix}`
  const cardId = `src_subscription_link_${idSuffix}`
  const phone = `55${String(idSuffix).slice(-8)}`

  await snapshotConektaConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, email, full_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `conekta-sub-link-${idSuffix}@example.test`, 'Cliente Suscripcion Conekta', phone]
    )

    const calls = []
    setConektaFetchForTest(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null
      calls.push({ url, method: options.method || 'GET', body })

      if (url.endsWith('/orders')) {
        assert.fail('El link de suscripción Conekta no debe crear una orden de pago único.')
      }

      if (url.endsWith('/plans') && options.method === 'POST') {
        assert.equal(body.currency, 'MXN')
        assert.equal(body.interval, 'month')
        return jsonResponse({
          id: planId,
          name: body.name,
          amount: body.amount,
          currency: body.currency,
          interval: body.interval,
          frequency: body.frequency,
          status: 'active'
        })
      }

      if (url.endsWith('/checkouts') && options.method === 'POST') {
        assert.equal(body.type, 'PaymentLink')
        assert.deepEqual(body.allowed_payment_methods, ['card'])
        assert.deepEqual(body.plan_ids, [planId])
        assert.equal(body.needs_shipping_contact, false)
        assert.equal(body.order_template.customer_info.email, `conekta-sub-link-${idSuffix}@example.test`)
        assert.equal(body.order_template.metadata.ristak_subscription_id.startsWith('rstk_sub_'), true)
        assert.ok(String(body.success_url).includes('/transactions/subscriptions'))
        return jsonResponse({
          id: checkoutId,
          object: 'checkout',
          url: `https://pay.conekta.com/link/subscription_link_${idSuffix}`
        })
      }

      return jsonResponse({ message: 'unexpected request' }, 500)
    })

    await savePaymentSettings({ paymentMode: 'test' })
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publicKey: 'key_test_public_subscription_link',
          privateKey: 'key_test_private_subscription_link'
        }
      }
    })

    const today = todayConektaDateOnly()
    const created = await createSubscription({
      contactId,
      contactName: 'Cliente Suscripcion Conekta',
      contactEmail: `conekta-sub-link-${idSuffix}@example.test`,
      contactPhone: phone,
      name: 'Membresía link Conekta',
      amount: 210,
      currency: 'MXN',
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: today,
      paymentProvider: 'conekta',
      paymentMethod: 'conekta_link',
      status: 'incomplete',
      baseUrl: 'https://app.example.test'
    })

    assert.equal(created.status, 'incomplete')
    assert.equal(created.conektaSubscriptionId, null)
    assert.equal(created.conektaPlanId, planId)
    assert.equal(created.conektaCheckoutId, checkoutId)
    assert.equal(created.conektaCheckoutUrl, `https://pay.conekta.com/link/subscription_link_${idSuffix}`)
    assert.equal(created.subscriptionStartUrl, `https://pay.conekta.com/link/subscription_link_${idSuffix}`)
    assert.equal(created.subscriptionStartPublicPaymentId, null)
    assert.equal(calls.some((call) => call.url.endsWith('/orders')), false)

    const webhookResult = await reconcileConektaSubscriptionFromWebhook({
      id: 'evt_subscription_paid_link',
      type: 'subscription.paid',
      created_at: 1782000100,
      data: {
        object: {
          id: subscriptionId,
          status: 'active',
          object: 'subscription',
          charge_id: chargeId,
          created_at: 1782000000,
          subscription_start: 1782000000,
          canceled_at: null,
          paused_at: null,
          billing_cycle_start: 1782000000,
          billing_cycle_end: 1784678400,
          trial_start: null,
          trial_end: null,
          plan_id: planId,
          last_billing_cycle_order_id: orderId,
          customer_id: customerId,
          card_id: cardId
        }
      }
    })

    assert.equal(webhookResult.matched, true)
    assert.equal(webhookResult.status, 'active')
    assert.equal(webhookResult.paymentSynced, true)
    assert.equal(webhookResult.paymentCreated, true)

    const subscriptionRow = await db.get(
      `SELECT status, payment_method, conekta_subscription_id, conekta_payment_source_id
       FROM subscriptions
       WHERE id = ?`,
      [created.id]
    )
    assert.equal(subscriptionRow.status, 'active')
    assert.equal(subscriptionRow.payment_method, 'conekta_subscription')
    assert.equal(subscriptionRow.conekta_subscription_id, subscriptionId)
    assert.equal(subscriptionRow.conekta_payment_source_id, cardId)

    const syncedStartPayment = await db.get(
      `SELECT status, payment_method, conekta_order_id, conekta_charge_id, conekta_payment_source_id
       FROM payments
       WHERE id = ?`,
      [webhookResult.paymentId]
    )
    assert.equal(syncedStartPayment.status, 'paid')
    assert.equal(syncedStartPayment.payment_method, 'conekta_subscription')
    assert.equal(syncedStartPayment.conekta_order_id, orderId)
    assert.equal(syncedStartPayment.conekta_charge_id, chargeId)
    assert.equal(syncedStartPayment.conekta_payment_source_id, cardId)

    const failedWebhookResult = await reconcileConektaSubscriptionFromWebhook({
      id: 'evt_subscription_failed_link',
      type: 'subscription.payment_failed',
      created_at: 1784678500,
      data: {
        object: {
          id: subscriptionId,
          status: 'past_due',
          object: 'subscription',
          charge_id: null,
          billing_cycle_start: 1784678400,
          billing_cycle_end: 1787356800,
          plan_id: planId,
          last_billing_cycle_order_id: failedOrderId,
          customer_id: customerId,
          card_id: cardId
        }
      }
    })
    assert.equal(failedWebhookResult.matched, true)
    assert.equal(failedWebhookResult.status, 'past_due')

    const subscriptionAfterFailedWebhook = await db.get(
      `SELECT status, conekta_next_billing_at, current_period_start, current_period_end
       FROM subscriptions
       WHERE id = ?`,
      [created.id]
    )
    assert.equal(subscriptionAfterFailedWebhook.status, 'past_due')
    assert.ok(subscriptionAfterFailedWebhook.current_period_start)
    assert.ok(subscriptionAfterFailedWebhook.current_period_end)

    const secondPaidWebhookResult = await reconcileConektaSubscriptionFromWebhook({
      id: 'evt_subscription_paid_link_second',
      type: 'subscription.paid',
      created_at: 1787356900,
      data: {
        object: {
          id: subscriptionId,
          status: 'active',
          object: 'subscription',
          charge_id: secondChargeId,
          billing_cycle_start: 1787356800,
          billing_cycle_end: 1790035200,
          plan_id: planId,
          last_billing_cycle_order_id: secondOrderId,
          customer_id: customerId,
          card_id: cardId
        }
      }
    })
    assert.equal(secondPaidWebhookResult.matched, true)
    assert.equal(secondPaidWebhookResult.status, 'active')
    assert.equal(secondPaidWebhookResult.paymentSynced, true)
    assert.equal(secondPaidWebhookResult.paymentCreated, true)

    const insertedRecurringPayment = await db.get(
      `SELECT amount, status, payment_method, conekta_order_id, conekta_charge_id
       FROM payments
       WHERE id = ?`,
      [secondPaidWebhookResult.paymentId]
    )
    assert.equal(insertedRecurringPayment.amount, 210)
    assert.equal(insertedRecurringPayment.status, 'paid')
    assert.equal(insertedRecurringPayment.payment_method, 'conekta_subscription')
    assert.equal(insertedRecurringPayment.conekta_order_id, secondOrderId)
    assert.equal(insertedRecurringPayment.conekta_charge_id, secondChargeId)

    await db.run('DELETE FROM subscriptions WHERE id = ?', [created.id])
    await db.run('DELETE FROM payments WHERE id = ?', [webhookResult.paymentId])
    await db.run('DELETE FROM payments WHERE id = ?', [secondPaidWebhookResult.paymentId])
    await db.run('DELETE FROM conekta_payment_sources WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  })
})

test('Conekta planes: el webhook de domiciliación activa el plan con primer pago offline', async () => {
  await initializeMasterKey()

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contactId = `contact_conekta_webhook_${suffix}`
  const conektaCustomerId = `cus_webhook_${suffix}`
  const conektaSourceId = `src_webhook_${suffix}`
  const orderId = `ord_webhook_${suffix}`
  const chargeId = `charge_webhook_${suffix}`

  await snapshotConektaConfig(async () => {
    const apiCalls = []
    setConektaFetchForTest(async (url, options = {}) => {
      apiCalls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })

      if (url.endsWith('/customers') && options.method === 'POST') {
        return jsonResponse({ id: conektaCustomerId })
      }

      if (url.endsWith(`/customers/${conektaCustomerId}/payment_sources`) && options.method === 'POST') {
        assert.equal(JSON.parse(options.body).token_id, 'tok_setup_webhook')
        return jsonResponse({
          id: conektaSourceId,
          object: 'payment_source',
          type: 'card',
          brand: 'visa',
          last4: '4242',
          exp_month: 11,
          exp_year: 2030
        })
      }

      if (url.endsWith('/orders') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.customer_info.customer_id, conektaCustomerId)
        assert.equal(body.charges[0].payment_method.payment_source_id, conektaSourceId)
        return jsonResponse({
          id: orderId,
          payment_status: 'pending',
          charges: {
            data: [{
              id: chargeId,
              status: 'pending',
              payment_method: {
                type: 'card',
                payment_source_id: conektaSourceId
              }
            }]
          }
        })
      }

      return jsonResponse({ message: 'unexpected request' }, 500)
    })

    await savePaymentSettings({ paymentMode: 'test' })
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publicKey: 'key_test_public_webhook',
          privateKey: 'key_test_private_webhook'
        }
      }
    })

    await db.run(
      `INSERT INTO contacts (id, email, full_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `conekta-webhook-${suffix}@example.test`, 'Cliente Webhook Conekta', '5555555555']
    )

    const today = todayConektaDateOnly()
    const planResult = await createConektaPaymentPlan({
      contact: {
        id: contactId,
        name: 'Cliente Webhook Conekta',
        email: `conekta-webhook-${suffix}@example.test`,
        phone: '5555555555'
      },
      totalAmount: 500,
      currency: 'MXN',
      title: 'Plan webhook Conekta',
      description: 'Plan webhook Conekta',
      firstPayment: {
        enabled: true,
        amount: 100,
        date: today,
        method: 'cash'
      },
      remainingPayments: [{
        sequence: 1,
        amount: 400,
        dueDate: today,
        frequency: 'monthly'
      }],
      remainingFrequency: 'monthly',
      cardSetupAmount: 25
    }, { baseUrl: 'https://app.example.test' })

    assert.equal(planResult.currentState, 'waiting_card_authorization')
    assert.ok(planResult.cardSetupPaymentId)

    const setupPayment = await db.get(
      'SELECT public_payment_id FROM payments WHERE id = ?',
      [planResult.cardSetupPaymentId]
    )
    assert.ok(setupPayment?.public_payment_id)

    const setupAttempt = await createPublicConektaCardPayment(setupPayment.public_payment_id, {
      tokenId: 'tok_setup_webhook',
      savePaymentSource: false
    }, { baseUrl: 'https://app.example.test' })
    assert.equal(setupAttempt.status, 'pending')
    assert.equal(setupAttempt.conektaPaymentSourceId, conektaSourceId)

    const waitingFlow = await db.get(
      'SELECT current_state, card_setup_status, conekta_payment_source_id FROM payment_flows WHERE id = ?',
      [planResult.flowId]
    )
    assert.equal(waitingFlow.current_state, 'waiting_card_authorization')
    assert.equal(waitingFlow.card_setup_status, 'pending')
    assert.equal(waitingFlow.conekta_payment_source_id, null)

    const webhookResult = await reconcileConektaOrderFromWebhook({
      type: 'order.paid',
      data: {
        object: {
          id: orderId,
          payment_status: 'paid',
          charges: {
            data: [{
              id: chargeId,
              status: 'paid',
              payment_method: {
                type: 'card',
                payment_source_id: conektaSourceId
              }
            }]
          }
        }
      }
    })

    assert.equal(webhookResult.matched, true)
    assert.equal(webhookResult.changed, true)
    assert.equal(webhookResult.status, 'paid')
    assert.equal(webhookResult.planSynced, true)

    const stalePendingWebhookResult = await reconcileConektaOrderFromWebhook({
      type: 'order.pending_payment',
      data: {
        object: {
          id: orderId,
          payment_status: 'pending_payment',
          charges: {
            data: [{
              id: chargeId,
              status: 'pending_payment',
              payment_method: {
                type: 'card',
                payment_source_id: conektaSourceId
              }
            }]
          }
        }
      }
    })

    assert.equal(stalePendingWebhookResult.matched, true)
    assert.equal(stalePendingWebhookResult.changed, false)
    assert.equal(stalePendingWebhookResult.status, 'paid')

    const protectedPayment = await db.get(
      'SELECT status, paid_at FROM payments WHERE id = ?',
      [planResult.cardSetupPaymentId]
    )
    assert.equal(protectedPayment.status, 'paid')
    assert.ok(protectedPayment.paid_at)

    const activeFlow = await db.get(
      `SELECT current_state, card_setup_status, conekta_payment_source_id, installment_plan_active_at
       FROM payment_flows
       WHERE id = ?`,
      [planResult.flowId]
    )
    assert.equal(activeFlow.current_state, 'installment_plan_active')
    assert.equal(activeFlow.card_setup_status, 'paid')
    assert.equal(activeFlow.conekta_payment_source_id, conektaSourceId)
    assert.ok(activeFlow.installment_plan_active_at)

    const scheduledInstallment = await db.get(
      'SELECT status, payment_method FROM installment_payments WHERE flow_id = ? AND sequence = 1',
      [planResult.flowId]
    )
    assert.equal(scheduledInstallment.status, 'scheduled')
    assert.equal(scheduledInstallment.payment_method, 'conekta_saved_card')

    assert.ok(apiCalls.some((call) => call.url.endsWith(`/customers/${conektaCustomerId}/payment_sources`)))
  })

  try {
    await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conekta_payment_sources WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  } catch {
    // Limpieza best-effort para no ocultar la aserción principal.
  }
})

test('Conekta planes: conserva varios planes del mismo contacto y procesa solo vencidos', async () => {
  await initializeMasterKey()

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contactId = `contact_conekta_multi_${suffix}`
  const conektaCustomerId = `cus_multi_${suffix}`
  const conektaSourceId = `src_multi_${suffix}`

  await snapshotConektaConfig(async () => {
    const orderCalls = []
    setConektaFetchForTest(async (url, options = {}) => {
      if (url.endsWith('/orders') && options.method === 'POST') {
        const body = JSON.parse(options.body)
        orderCalls.push({
          url,
          body,
          idempotencyKey: options.headers?.['Idempotency-Key']
        })

        assert.equal(body.currency, 'MXN')
        assert.equal(body.customer_info.customer_id, conektaCustomerId)
        assert.equal(body.charges[0].payment_method.type, 'card')
        assert.equal(body.charges[0].payment_method.payment_source_id, conektaSourceId)
        assert.ok(options.headers?.['Idempotency-Key'])

        return jsonResponse({
          id: `ord_multi_${orderCalls.length}`,
          payment_status: 'paid',
          charges: {
            data: [{
              id: `charge_multi_${orderCalls.length}`,
              status: 'paid',
              payment_method: {
                type: 'card',
                payment_source_id: conektaSourceId
              }
            }]
          }
        })
      }

      return jsonResponse({ message: 'unexpected request' }, 500)
    })

    await savePaymentSettings({ paymentMode: 'test' })
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publicKey: 'key_test_public_multi',
          privateKey: 'key_test_private_multi'
        }
      }
    })

    await db.run(
      `INSERT INTO contacts (
        id, email, full_name, phone, conekta_customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        contactId,
        `conekta-multi-${suffix}@example.test`,
        'Cliente Multi Conekta',
        '5555555555',
        conektaCustomerId
      ]
    )

    await db.run(
      `INSERT INTO conekta_payment_sources (
        id, contact_id, conekta_customer_id, conekta_payment_source_id,
        brand, last4, exp_month, exp_year, mode, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`conekta_source_${suffix}`, contactId, conektaCustomerId, conektaSourceId]
    )

    const today = todayConektaDateOnly()
    const futureTimedDue = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const contact = {
      id: contactId,
      name: 'Cliente Multi Conekta',
      email: `conekta-multi-${suffix}@example.test`,
      phone: '5555555555'
    }

    const firstPlan = await createConektaPaymentPlan({
      contact,
      totalAmount: 350,
      currency: 'MXN',
      title: 'Plan Conekta vencido',
      description: 'Plan Conekta vencido',
      paymentMethodId: conektaSourceId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [{
        sequence: 1,
        amount: 350,
        dueDate: today,
        frequency: 'custom'
      }]
    }, { baseUrl: 'https://app.example.test' })

    const secondPlan = await createConektaPaymentPlan({
      contact,
      totalAmount: 475,
      currency: 'MXN',
      title: 'Plan Conekta futuro',
      description: 'Plan Conekta futuro',
      paymentMethodId: conektaSourceId,
      firstPayment: { enabled: false },
      remainingFrequency: 'scheduled_time',
      remainingPayments: [{
        sequence: 1,
        amount: 475,
        dueDate: futureTimedDue,
        frequency: 'scheduled_time'
      }]
    }, { baseUrl: 'https://app.example.test' })

    assert.notEqual(firstPlan.flowId, secondPlan.flowId)

    const flows = await db.all(
      `SELECT id, total_amount, current_state
       FROM payment_flows
       WHERE contact_id = ? AND payment_provider = 'conekta'
       ORDER BY total_amount ASC`,
      [contactId]
    )
    assert.equal(flows.length, 2)
    assert.deepEqual(flows.map((row) => row.id).sort(), [firstPlan.flowId, secondPlan.flowId].sort())
    assert.deepEqual(flows.map((row) => Number(row.total_amount)), [350, 475])
    assert.ok(flows.every((row) => row.current_state === 'installment_plan_active'))

    const mirrors = await db.all(
      `SELECT id, total, source
       FROM payment_plans
       WHERE contact_id = ? AND source = 'conekta'
       ORDER BY total ASC`,
      [contactId]
    )
    assert.equal(mirrors.length, 2)
    assert.deepEqual(mirrors.map((row) => row.id).sort(), [firstPlan.flowId, secondPlan.flowId].sort())
    assert.deepEqual(mirrors.map((row) => Number(row.total)), [350, 475])

    const firstRun = await processDueConektaPaymentPlanCharges({ limit: 10 })
    assert.equal(firstRun.processed, 1)
    assert.equal(firstRun.succeeded, 1)
    assert.equal(firstRun.failed, 0)
    assert.equal(orderCalls.length, 1)
    assert.equal(orderCalls[0].body.line_items[0].unit_price, 35000)
    assert.match(orderCalls[0].idempotencyKey, /^ristak_conekta_charge_conekta_installment_/)

    const firstInstallment = await db.get(
      'SELECT status, conekta_order_id FROM installment_payments WHERE id = ?',
      [firstPlan.scheduledPayments[0].installmentId]
    )
    const secondInstallment = await db.get(
      'SELECT status, conekta_order_id FROM installment_payments WHERE id = ?',
      [secondPlan.scheduledPayments[0].installmentId]
    )
    assert.equal(firstInstallment.status, 'paid')
    assert.equal(firstInstallment.conekta_order_id, 'ord_multi_1')
    assert.equal(secondInstallment.status, 'scheduled')
    assert.equal(secondInstallment.conekta_order_id, null)

    const secondRun = await processDueConektaPaymentPlanCharges({ limit: 10 })
    assert.equal(secondRun.processed, 0)
    assert.equal(orderCalls.length, 1)

    await db.run(
      `UPDATE installment_payments
       SET due_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [new Date(Date.now() - 2 * 60 * 1000).toISOString(), secondPlan.scheduledPayments[0].installmentId]
    )

    const timedRun = await processDueConektaPaymentPlanCharges({ limit: 10 })
    assert.equal(timedRun.processed, 1)
    assert.equal(timedRun.succeeded, 1)
    assert.equal(timedRun.failed, 0)
    assert.equal(orderCalls.length, 2)
    assert.equal(orderCalls[1].body.line_items[0].unit_price, 47500)

    const paidTimedInstallment = await db.get(
      'SELECT status, frequency, conekta_order_id FROM installment_payments WHERE id = ?',
      [secondPlan.scheduledPayments[0].installmentId]
    )
    assert.equal(paidTimedInstallment.status, 'paid')
    assert.equal(paidTimedInstallment.frequency, 'scheduled_time')
    assert.equal(paidTimedInstallment.conekta_order_id, 'ord_multi_2')

    const duplicateTimedRun = await processDueConektaPaymentPlanCharges({ limit: 10 })
    assert.equal(duplicateTimedRun.processed, 0)
    assert.equal(orderCalls.length, 2)
  })

  try {
    await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM installment_payments WHERE flow_id IN (SELECT id FROM payment_flows WHERE contact_id = ?)', [contactId])
    await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conekta_payment_sources WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  } catch {
    // Limpieza best-effort para no ocultar la aserción principal.
  }
})
