import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
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
  resumeConektaRecurringSubscription,
  saveConektaPaymentConfig,
  setConektaFetchForTest,
  cancelConektaRecurringSubscription,
  testConektaPaymentConfig
} from '../src/services/conektaPaymentService.js'

async function snapshotConektaConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'conekta_%'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'conekta_%'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'conekta_%'")
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
      [contactId, `conekta-${Date.now()}@example.test`, 'Cliente Conekta', '5555555555']
    )

    const calls = []
    setConektaFetchForTest(async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })

      if (url.endsWith('/customers?limit=1')) {
        return jsonResponse({ data: [] })
      }

      if (url.endsWith('/customers') && options.method === 'POST') {
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
      title: 'Pago Conekta'
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

    const today = new Date().toISOString().slice(0, 10)
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
