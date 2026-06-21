import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createStripePaymentPlan,
  createStripeSavedCardPayment,
  getStripeSavedPaymentMethods,
  handleStripeWebhookEvent,
  processDueStripePaymentPlanCharges,
  saveStripePaymentConfig,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import { createSubscription } from '../src/services/subscriptionsService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

const STRIPE_ENV_KEYS = ['STRIPE_CONNECT_OAUTH_ENABLED']

function suffix(label = 'live_parity') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function snapshotStripeConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'stripe_%'"
  )
  const previousEnv = Object.fromEntries(STRIPE_ENV_KEYS.map((key) => [key, process.env[key]]))

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    setStripeFactoryForTest(null)
  }
}

async function cleanupContact(contactId) {
  await db.run(
    `DELETE FROM installment_payments
     WHERE flow_id IN (SELECT id FROM payment_flows WHERE contact_id = ?)
        OR payment_id IN (SELECT id FROM payments WHERE contact_id = ?)`,
    [contactId, contactId]
  ).catch(() => undefined)

  await db.run(
    `DELETE FROM payment_plans
     WHERE contact_id = ?
        OR id IN (SELECT id FROM payment_flows WHERE contact_id = ?)`,
    [contactId, contactId]
  ).catch(() => undefined)

  await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM subscriptions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM stripe_payment_methods WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function seedDualModeContact(label = 'live_parity') {
  const idSuffix = suffix(label)
  const contactId = `contact_${idSuffix}`
  const contact = {
    id: contactId,
    name: `Cliente ${label}`,
    email: `${contactId}@example.test`,
    phone: `+521${idSuffix.replace(/[^0-9]/g, '').padEnd(10, '5').slice(0, 10)}`
  }

  await cleanupContact(contactId)
  await db.run(
    `INSERT INTO contacts (
      id, full_name, email, phone, source, stripe_customer_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, contact.name, contact.email, contact.phone, 'cus_test_cached']
  )

  await db.run(
    `INSERT INTO stripe_payment_methods (
      id, contact_id, stripe_customer_id, stripe_payment_method_id,
      brand, last4, exp_month, exp_year, funding, country, mode, is_default,
      created_at, updated_at
    ) VALUES
      (?, ?, 'cus_test_cached', 'pm_test_cached', 'visa', '4242', 12, 2035, 'credit', 'MX', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      (?, ?, 'cus_live_saved', 'pm_live_saved', 'mastercard', '4444', 11, 2036, 'credit', 'MX', 'live', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [`stripe_pm_test_${idSuffix}`, contactId, `stripe_pm_live_${idSuffix}`, contactId]
  )

  return {
    contactId,
    contact,
    testSavedMethodId: `stripe_pm_test_${idSuffix}`,
    liveSavedMethodId: `stripe_pm_live_${idSuffix}`
  }
}

function createStripeModeMock() {
  const calls = {
    paymentIntentsCreate: [],
    paymentMethodsList: [],
    customersRetrieve: [],
    customersCreate: [],
    customersUpdate: [],
    productsCreate: [],
    pricesCreate: [],
    subscriptionsCreate: [],
    webhooksConstructEvent: []
  }
  const state = {
    webhookMode: 'live'
  }

  function modeFromSecret(secretKey) {
    if (secretKey.includes('_live_')) return 'live'
    return 'test'
  }

  function paymentMethod(paymentMethodId) {
    const live = paymentMethodId.includes('live')
    return {
      id: paymentMethodId,
      type: 'card',
      card: {
        brand: live ? 'mastercard' : 'visa',
        last4: live ? '4444' : '4242',
        exp_month: live ? 11 : 12,
        exp_year: live ? 2036 : 2035,
        funding: 'credit',
        country: 'MX'
      }
    }
  }

  function stripeFor(secretKey) {
    const mode = modeFromSecret(secretKey)
    const connectedAccountId = mode === 'live' ? 'acct_live_connected' : 'acct_test_connected'
    const webhookSecret = mode === 'live' ? 'whsec_manual_live' : 'whsec_manual_test'

    return {
      accounts: {
        retrieve: async (accountId) => ({
          id: accountId,
          email: `${accountId}@stripe.test`,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          business_profile: {
            name: accountId.includes('live') ? 'Stripe Live' : 'Stripe Test'
          }
        })
      },
      webhookEndpoints: {
        create: async (payload, options = {}) => {
          assert.equal(payload.connect, undefined)
          assert.deepEqual(options, {})
          return {
            id: `we_${payload.metadata.stripe_account_id}`,
            url: payload.url,
            secret: payload.metadata.stripe_account_id.includes('live')
              ? 'whsec_acct_live_connected'
              : 'whsec_acct_test_connected'
          }
        },
        del: async () => ({ deleted: true })
      },
      balance: {
        retrieve: async () => ({
          livemode: mode === 'live',
          available: [{ amount: 1000, currency: 'mxn' }]
        })
      },
      paymentIntents: {
        create: async (params, options) => {
          calls.paymentIntentsCreate.push({ mode, params, options })
          assert.equal(mode, 'live')
          assert.equal(params.customer, 'cus_live_saved')
          assert.equal(params.payment_method, 'pm_live_saved')
          return {
            id: `pi_live_${calls.paymentIntentsCreate.length}`,
            status: 'succeeded',
            amount: params.amount,
            amount_received: params.amount,
            currency: params.currency,
            customer: params.customer,
            payment_method: params.payment_method,
            latest_charge: `ch_live_${calls.paymentIntentsCreate.length}`,
            metadata: params.metadata
          }
        },
        retrieve: async () => {
          throw new Error('No se esperaba retrieve de PaymentIntent en esta prueba.')
        }
      },
      paymentMethods: {
        retrieve: async (paymentMethodId) => paymentMethod(paymentMethodId),
        list: async (params, options) => {
          calls.paymentMethodsList.push({ mode, params, options })
          if (mode === 'live' && params.customer === 'cus_test_cached') {
            const error = new Error('No such customer in live mode.')
            error.statusCode = 404
            throw error
          }
          if (mode === 'live' && params.customer === 'cus_live_saved') {
            return { data: [paymentMethod('pm_live_saved')] }
          }
          return { data: [paymentMethod('pm_test_cached')] }
        }
      },
      customers: {
        retrieve: async (customerId, options) => {
          calls.customersRetrieve.push({ mode, customerId, options })
          if (mode === 'live' && customerId !== 'cus_live_saved') {
            const error = new Error('No such customer in live mode.')
            error.statusCode = 404
            throw error
          }
          return { id: customerId }
        },
        create: async (params, options) => {
          calls.customersCreate.push({ mode, params, options })
          return { id: `cus_created_${mode}` }
        },
        update: async (customerId, params, options) => {
          calls.customersUpdate.push({ mode, customerId, params, options })
          assert.equal(mode, 'live')
          assert.equal(customerId, 'cus_live_saved')
          assert.equal(params.invoice_settings.default_payment_method, 'pm_live_saved')
          return { id: customerId }
        }
      },
      products: {
        create: async (params, options) => {
          calls.productsCreate.push({ mode, params, options })
          assert.equal(mode, 'live')
          return { id: 'prod_live_parity' }
        }
      },
      prices: {
        create: async (params, options) => {
          calls.pricesCreate.push({ mode, params, options })
          assert.equal(mode, 'live')
          return { id: 'price_live_parity' }
        }
      },
      subscriptions: {
        create: async (params, options) => {
          calls.subscriptionsCreate.push({ mode, params, options })
          assert.equal(mode, 'live')
          assert.equal(params.customer, 'cus_live_saved')
          assert.equal(params.default_payment_method, 'pm_live_saved')
          return {
            id: 'sub_live_parity',
            status: 'active',
            current_period_start: 2524608000,
            current_period_end: 2527286400,
            latest_invoice: {
              object: 'invoice',
              id: 'in_live_parity',
              status: 'paid',
              currency: 'mxn',
              amount_paid: 125000,
              subscription: 'sub_live_parity',
              customer: 'cus_live_saved',
              hosted_invoice_url: 'https://stripe.example.test/in_live_parity',
              metadata: params.metadata,
              subscription_details: {
                metadata: params.metadata
              },
              status_transitions: {
                paid_at: 2524608010
              },
              lines: {
                data: [
                  {
                    period: {
                      start: 2524608000,
                      end: 2527286400
                    }
                  }
                ]
              }
            }
          }
        }
      },
      webhooks: {
        constructEvent: (rawBody, signature, secret) => {
          calls.webhooksConstructEvent.push({ mode, rawBody, signature, secret })
          if (state.webhookMode === 'test' && secret !== 'whsec_acct_test_connected') {
            throw new Error('Firma test no corresponde a secret live.')
          }
          if (state.webhookMode !== 'test' && secret !== webhookSecret) {
            throw new Error('Firma live no corresponde a este secret.')
          }

          const eventMode = state.webhookMode
          return {
            type: 'account.updated',
            account: eventMode === 'live_other' ? 'acct_other_connected' : (eventMode === 'live' ? connectedAccountId : 'acct_test_connected'),
            data: {
              object: { object: 'account' }
            }
          }
        }
      }
    }
  }

  return {
    calls,
    state,
    factory: (secretKey) => stripeFor(secretKey)
  }
}

async function configureManualStripeLive() {
  const liveConfig = await saveStripePaymentConfig({
    enabled: true,
    mode: 'live',
    publishableKey: 'pk_live_manual_public',
    secretKey: 'sk_live_manual_secret',
    webhookSecret: 'whsec_manual_live',
    accountLabel: 'Stripe manual live'
  })

  assert.equal(liveConfig.mode, 'live')
  assert.equal(liveConfig.connectionType, 'manual')
  assert.equal(liveConfig.configurationStatus, 'configured_manually')
  assert.equal(liveConfig.connectedAccountId, '')
  assert.equal(liveConfig.hasSecretKey, true)
  assert.equal(liveConfig.hasWebhookSecret, true)
}

test('Stripe live parity: configuración manual live usa customer y tarjeta live en pagos, planes y suscripciones', async () => {
  await initializeMasterKey()
  const stripeMock = createStripeModeMock()
  setStripeFactoryForTest(stripeMock.factory)

  await snapshotStripeConfig(async () => {
    await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
    await configureManualStripeLive()

    const { contactId, contact, liveSavedMethodId } = await seedDualModeContact('live_modes')
    try {
      const methods = await getStripeSavedPaymentMethods(contactId)
      assert.equal(methods.length, 1)
      assert.equal(methods[0].mode, 'live')
      assert.equal(methods[0].stripeCustomerId, 'cus_live_saved')
      assert.equal(methods[0].stripePaymentMethodId, 'pm_live_saved')
      assert.ok(stripeMock.calls.paymentMethodsList.some((call) => call.params.customer === 'cus_live_saved'))
      assert.ok(stripeMock.calls.paymentMethodsList.some((call) => call.params.customer === 'cus_test_cached'))

      const savedPayment = await createStripeSavedCardPayment({
        contactId,
        paymentMethodId: liveSavedMethodId,
        amount: 432.1,
        title: 'Pago live simulado'
      })
      assert.equal(savedPayment.payment.status, 'paid')
      assert.equal(stripeMock.calls.paymentIntentsCreate.at(-1).params.amount, 43210)

      const plan = await createStripePaymentPlan({
        contact,
        title: 'Plan live simulado',
        totalAmount: 1000,
        paymentMethodId: liveSavedMethodId,
        firstPayment: { enabled: false },
        remainingPayments: [
          { sequence: 1, amount: 250, dueDate: '2000-01-01', frequency: 'monthly' },
          { sequence: 2, amount: 750, dueDate: '2099-01-01', frequency: 'monthly' }
        ]
      }, { baseUrl: 'https://app.example.com' })
      assert.equal(plan.currentState, 'installment_plan_active')

      const dueRun = await processDueStripePaymentPlanCharges({ limit: 10 })
      assert.equal(dueRun.length, 1)
      assert.equal(dueRun[0].charged, true)
      assert.equal(stripeMock.calls.paymentIntentsCreate.at(-1).params.amount, 25000)

      const subscription = await createSubscription({
        contactId,
        contactName: contact.name,
        contactEmail: contact.email,
        contactPhone: contact.phone,
        name: 'Suscripción live simulada',
        amount: 1250,
        intervalType: 'monthly',
        intervalCount: 1,
        paymentMethod: 'stripe_saved_card',
        paymentProvider: 'stripe',
        stripePaymentMethodId: liveSavedMethodId
      })

      assert.equal(subscription.status, 'active')
      assert.equal(subscription.paymentMode, 'live')
      assert.equal(subscription.stripeCustomerId, 'cus_live_saved')
      assert.equal(subscription.stripePaymentMethodId, 'pm_live_saved')
      assert.equal(stripeMock.calls.customersCreate.length, 0)
      assert.equal(stripeMock.calls.customersUpdate.at(-1).customerId, 'cus_live_saved')
      assert.equal(stripeMock.calls.subscriptionsCreate.at(-1).params.customer, 'cus_live_saved')
    } finally {
      await cleanupContact(contactId)
    }
  })
})

test('Stripe live parity: webhook manual live valida con el signing secret guardado', async () => {
  await initializeMasterKey()
  const stripeMock = createStripeModeMock()
  setStripeFactoryForTest(stripeMock.factory)

  await snapshotStripeConfig(async () => {
    await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
    await configureManualStripeLive()

    stripeMock.state.webhookMode = 'live'
    const liveResult = await handleStripeWebhookEvent(Buffer.from('{}'), 'sig_live')
    assert.equal(liveResult.received, true)
    assert.equal(liveResult.type, 'account.updated')
    assert.equal(stripeMock.calls.webhooksConstructEvent.at(0).secret, 'whsec_manual_live')

    stripeMock.state.webhookMode = 'test'
    await assert.rejects(
      () => handleStripeWebhookEvent(Buffer.from('{}'), 'sig_test'),
      /Firma test no corresponde/
    )
    assert.equal(stripeMock.calls.webhooksConstructEvent.length, 2)
  })
})
