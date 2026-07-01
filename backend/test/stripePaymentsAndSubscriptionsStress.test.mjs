import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createStripePaymentPlan,
  handleStripeWebhookEvent,
  processDueStripePaymentPlanCharges,
  saveStripePaymentConfig,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import {
  actionSubscription,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription
} from '../src/services/subscriptionsService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'

function suffix(label = 'stress') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function todayDateOnly() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function addDaysDateOnly(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function testPhoneFromSuffix(idSuffix) {
  const digits = String(idSuffix).replace(/[^0-9]/g, '')
  const entropyDigits = Array.from(String(idSuffix))
    .map((char) => String(char.charCodeAt(0) % 10))
    .join('')
  return `+521${`${digits}${entropyDigits}`.slice(-10).padStart(10, '5')}`
}

async function configureStripe({ webhookSecret = '' } = {}) {
  await initializeMasterKey()
  await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
  await savePaymentSettings({ paymentMode: 'test' })
  await saveStripePaymentConfig({
    enabled: true,
    mode: 'test',
    publishableKey: 'pk_test_local_stress_suite',
    secretKey: 'sk_test_local_stress_suite',
    webhookSecret,
    defaultCurrency: 'MXN'
  })
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

async function seedContactWithSavedCard(label = 'stress') {
  const idSuffix = suffix(label)
  const contactId = `contact_${idSuffix}`
  const stripeCustomerId = `cus_${idSuffix}`
  const stripePaymentMethodId = `pm_${idSuffix}`
  const savedMethodId = `stripe_pm_${idSuffix}`
  const phone = testPhoneFromSuffix(idSuffix)

  await cleanupContact(contactId)

  await db.run(
    `INSERT INTO contacts (
      id, full_name, email, phone, source, stripe_customer_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      contactId,
      `Cliente ${label}`,
      `${contactId}@example.test`,
      phone,
      stripeCustomerId
    ]
  )

  await db.run(
    `INSERT INTO stripe_payment_methods (
      id, contact_id, stripe_customer_id, stripe_payment_method_id,
      brand, last4, exp_month, exp_year, funding, country, mode, is_default,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'credit', 'MX', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [savedMethodId, contactId, stripeCustomerId, stripePaymentMethodId]
  )

  return {
    contactId,
    contact: {
      id: contactId,
      name: `Cliente ${label}`,
      email: `${contactId}@example.test`,
      phone
    },
    stripeCustomerId,
    stripePaymentMethodId,
    savedMethodId
  }
}

function createStripeMock({ failAmounts = new Set(), webhookEvent = null } = {}) {
  const calls = {
    paymentIntentsCreate: [],
    paymentMethodsRetrieve: [],
    customersRetrieve: [],
    customersCreate: [],
    customersUpdate: [],
    productsCreate: [],
    productsUpdate: [],
    pricesCreate: [],
    checkoutSessionsCreate: [],
    subscriptionsCreate: [],
    subscriptionsRetrieve: [],
    subscriptionsUpdate: [],
    subscriptionsCancel: [],
    webhooksConstructEvent: []
  }

  let paymentIntentCounter = 0
  let productCounter = 0
  let priceCounter = 0
  let checkoutSessionCounter = 0
  let subscriptionCounter = 0

  const stripe = {
    paymentIntents: {
      create: async (params, options) => {
        calls.paymentIntentsCreate.push({ params, options })
        if (failAmounts.has(params.amount)) {
          const error = new Error('Stripe requiere autenticacion para esta tarjeta.')
          error.code = 'authentication_required'
          error.payment_intent = {
            id: `pi_requires_action_${calls.paymentIntentsCreate.length}`,
            status: 'requires_action'
          }
          throw error
        }

        paymentIntentCounter += 1
        return {
          id: `pi_stress_${paymentIntentCounter}`,
          status: 'succeeded',
          amount: params.amount,
          amount_received: params.amount,
          currency: params.currency,
          customer: params.customer,
          payment_method: params.payment_method,
          latest_charge: `ch_stress_${paymentIntentCounter}`,
          metadata: params.metadata
        }
      },
      retrieve: async (paymentIntentId) => ({
        id: paymentIntentId,
        status: 'succeeded',
        amount: 10000,
        amount_received: 10000,
        currency: 'mxn',
        customer: 'cus_retrieved',
        payment_method: 'pm_retrieved',
        latest_charge: `ch_${paymentIntentId}`,
        metadata: {}
      })
    },
    paymentMethods: {
      retrieve: async (paymentMethodId) => {
        calls.paymentMethodsRetrieve.push(paymentMethodId)
        return {
          id: paymentMethodId,
          type: 'card',
          card: {
            brand: paymentMethodId.includes('mastercard') ? 'mastercard' : 'visa',
            last4: paymentMethodId.includes('mastercard') ? '4444' : '4242',
            exp_month: 12,
            exp_year: 2035,
            funding: 'credit',
            country: 'MX'
          }
        }
      },
      list: async () => ({ data: [] })
    },
    customers: {
      retrieve: async (customerId) => {
        calls.customersRetrieve.push(customerId)
        return { id: customerId }
      },
      create: async (params, options) => {
        calls.customersCreate.push({ params, options })
        return { id: `cus_created_${calls.customersCreate.length}` }
      },
      update: async (customerId, params, options) => {
        calls.customersUpdate.push({ customerId, params, options })
        return { id: customerId }
      }
    },
    products: {
      create: async (params, options) => {
        productCounter += 1
        calls.productsCreate.push({ params, options })
        return { id: `prod_stress_${productCounter}` }
      },
      update: async (productId, params, options) => {
        calls.productsUpdate.push({ productId, params, options })
        return { id: productId }
      }
    },
    prices: {
      create: async (params, options) => {
        priceCounter += 1
        calls.pricesCreate.push({ params, options })
        return { id: `price_stress_${priceCounter}` }
      }
    },
    checkout: {
      sessions: {
        create: async (params, options) => {
          checkoutSessionCounter += 1
          calls.checkoutSessionsCreate.push({ params, options })
          return {
            id: `cs_stress_${checkoutSessionCounter}`,
            object: 'checkout.session',
            url: `https://checkout.stripe.test/cs_stress_${checkoutSessionCounter}`,
            mode: params.mode,
            customer: params.customer,
            payment_status: 'unpaid',
            subscription: null,
            metadata: params.metadata
          }
        }
      }
    },
    subscriptions: {
      create: async (params, options) => {
        subscriptionCounter += 1
        calls.subscriptionsCreate.push({ params, options })
        const subscriptionId = `sub_stress_${subscriptionCounter}`
        const latestPrice = calls.pricesCreate.at(-1)?.params || {}
        return {
          id: subscriptionId,
          status: 'active',
          current_period_start: 2524608000,
          current_period_end: 2527286400,
          latest_invoice: {
            object: 'invoice',
            id: `in_stress_${subscriptionCounter}`,
            status: 'paid',
            currency: latestPrice.currency || 'mxn',
            amount_paid: latestPrice.unit_amount || 0,
            subscription: subscriptionId,
            customer: params.customer,
            hosted_invoice_url: `https://pay.stripe.test/in_stress_${subscriptionCounter}`,
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
      },
      retrieve: async (subscriptionId, params, options) => {
        calls.subscriptionsRetrieve.push({ subscriptionId, params, options })
        return {
          id: subscriptionId,
          status: 'active',
          current_period_start: 2524608000,
          current_period_end: 2527286400,
          items: {
            data: [
              {
                id: `si_${subscriptionId}`,
                price: {
                  id: 'price_current',
                  product: 'prod_current'
                }
              }
            ]
          }
        }
      },
      update: async (subscriptionId, params, options) => {
        calls.subscriptionsUpdate.push({ subscriptionId, params, options })
        return {
          id: subscriptionId,
          status: params.pause_collection ? 'paused' : 'active',
          current_period_start: 2524608000,
          current_period_end: 2527286400
        }
      },
      cancel: async (subscriptionId, params, options) => {
        calls.subscriptionsCancel.push({ subscriptionId, params, options })
        return {
          id: subscriptionId,
          status: 'canceled',
          current_period_start: 2524608000,
          current_period_end: 2527286400
        }
      }
    },
    webhooks: {
      constructEvent: (rawBody, signature, secret) => {
        calls.webhooksConstructEvent.push({ rawBody, signature, secret })
        return webhookEvent
      }
    }
  }

  return { stripe, calls }
}

test('planes Stripe: cobra calendario irregular, deja meses sin cobro y no duplica cargos', async () => {
  const { contactId, contact, savedMethodId, stripeCustomerId, stripePaymentMethodId } = await seedContactWithSavedCard('irregular')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const dueToday = todayDateOnly()
    const futureDueDate = addDaysDateOnly(45)

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan irregular stress',
      description: 'Plan con meses saltados y montos variables',
      totalAmount: 10000,
      paymentMethodId: savedMethodId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 1200, percentage: 12, dueDate: dueToday, frequency: 'custom' },
        { sequence: 2, amount: 3300, percentage: 33, dueDate: dueToday, frequency: 'custom' },
        { sequence: 3, amount: 5500, percentage: 55, dueDate: futureDueDate, frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    assert.equal(plan.currentState, 'installment_plan_active')
    assert.equal(plan.scheduledPayments.length, 3)
    assert.equal(calls.paymentIntentsCreate.length, 0)

    const firstRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(firstRun.length, 2)
    assert.equal(calls.paymentIntentsCreate.length, 2)
    assert.deepEqual(
      calls.paymentIntentsCreate.map((call) => call.params.amount),
      [120000, 330000]
    )
    assert.ok(calls.paymentIntentsCreate.every((call) => call.params.customer === stripeCustomerId))
    assert.ok(calls.paymentIntentsCreate.every((call) => call.params.payment_method === stripePaymentMethodId))

    const installments = await db.all(
      `SELECT sequence, amount, due_date, status, stripe_payment_intent_id
       FROM installment_payments
       WHERE flow_id = ?
       ORDER BY sequence ASC`,
      [plan.flowId]
    )
    assert.equal(installments.length, 3)
    assert.deepEqual(installments.map((row) => row.status), ['paid', 'paid', 'scheduled'])
    assert.equal(installments[2].stripe_payment_intent_id, null)

    const payments = await db.all(
      `SELECT amount, status, stripe_payment_intent_id
       FROM payments
       WHERE id IN (?, ?, ?)
       ORDER BY amount ASC`,
      plan.scheduledPayments.map((payment) => payment.paymentId)
    )
    assert.deepEqual(payments.map((row) => row.status), ['paid', 'paid', 'scheduled'])

    const mirror = await db.get('SELECT status, schedule_json FROM payment_plans WHERE id = ?', [plan.flowId])
    const schedule = JSON.parse(mirror.schedule_json || '{}')
    assert.equal(mirror.status, 'active')
    assert.deepEqual(schedule.installments.map((row) => row.status), ['paid', 'paid', 'scheduled'])

    const secondRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(secondRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 2)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('planes Stripe: conserva varios planes del mismo contacto y cobra solo los vencidos', async () => {
  const contactA = await seedContactWithSavedCard('multi_plan_same_contact')
  const contactB = await seedContactWithSavedCard('multi_plan_other_contact')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const dueToday = todayDateOnly()
    const futureDueDate = addDaysDateOnly(35)

    const firstPlan = await createStripePaymentPlan({
      contact: contactA.contact,
      title: 'Plan A con anticipo offline',
      description: 'Plan A con primer pago offline',
      totalAmount: 500,
      paymentMethodId: contactA.savedMethodId,
      firstPayment: {
        enabled: true,
        amount: 100,
        date: dueToday,
        method: 'cash'
      },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 400, dueDate: dueToday, frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    const firstPlanPayment = await db.get(
      'SELECT status, payment_provider, payment_mode FROM payments WHERE id = ?',
      [firstPlan.firstPaymentPaymentId]
    )
    assert.equal(firstPlanPayment.status, 'paid')
    assert.equal(firstPlanPayment.payment_provider, 'manual')
    assert.equal(firstPlanPayment.payment_mode, 'test')

    const secondPlan = await createStripePaymentPlan({
      contact: contactA.contact,
      title: 'Plan B futuro mismo contacto',
      description: 'Plan B para el mismo contacto en otra fecha',
      totalAmount: 800,
      paymentMethodId: contactA.savedMethodId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 800, dueDate: futureDueDate, frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    const otherContactPlan = await createStripePaymentPlan({
      contact: contactB.contact,
      title: 'Plan C otro contacto',
      description: 'Plan vencido de otro contacto',
      totalAmount: 600,
      paymentMethodId: contactB.savedMethodId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 600, dueDate: dueToday, frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    assert.notEqual(firstPlan.flowId, secondPlan.flowId)
    assert.notEqual(firstPlan.flowId, otherContactPlan.flowId)
    assert.notEqual(secondPlan.flowId, otherContactPlan.flowId)

    const contactAFlows = await db.all(
      `SELECT id, concept, current_state
       FROM payment_flows
       WHERE contact_id = ? AND payment_provider = 'stripe'
       ORDER BY created_at ASC`,
      [contactA.contactId]
    )
    const contactBFlows = await db.all(
      `SELECT id, concept, current_state
       FROM payment_flows
       WHERE contact_id = ? AND payment_provider = 'stripe'`,
      [contactB.contactId]
    )
    assert.equal(contactAFlows.length, 2)
    assert.equal(contactBFlows.length, 1)
    assert.deepEqual(new Set(contactAFlows.map((row) => row.id)), new Set([firstPlan.flowId, secondPlan.flowId]))

    const contactAMirrors = await db.all(
      `SELECT id, total, source
       FROM payment_plans
       WHERE contact_id = ? AND source = 'stripe'
       ORDER BY total ASC`,
      [contactA.contactId]
    )
    const contactBMirrors = await db.all(
      `SELECT id, total, source
       FROM payment_plans
       WHERE contact_id = ? AND source = 'stripe'`,
      [contactB.contactId]
    )
    assert.equal(contactAMirrors.length, 2)
    assert.deepEqual(contactAMirrors.map((row) => row.id).sort(), [firstPlan.flowId, secondPlan.flowId].sort())
    assert.deepEqual(contactAMirrors.map((row) => Number(row.total)), [500, 800])
    assert.equal(contactBMirrors.length, 1)
    assert.equal(contactBMirrors[0].id, otherContactPlan.flowId)

    const offlineFirstPayment = await db.get(
      `SELECT status, payment_provider, payment_method, amount
       FROM payments
       WHERE id = ?`,
      [firstPlan.firstPaymentPaymentId]
    )
    assert.equal(offlineFirstPayment.status, 'paid')
    assert.equal(offlineFirstPayment.payment_provider, 'manual')
    assert.equal(offlineFirstPayment.payment_method, 'cash')
    assert.equal(offlineFirstPayment.amount, 100)

    const firstRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(firstRun.length, 2)
    assert.equal(calls.paymentIntentsCreate.length, 2)
    assert.deepEqual(
      calls.paymentIntentsCreate.map((call) => call.params.amount).sort((left, right) => left - right),
      [40000, 60000]
    )

    const firstPlanInstallment = await db.get(
      'SELECT status FROM installment_payments WHERE id = ?',
      [firstPlan.scheduledPayments[0].installmentId]
    )
    const secondPlanInstallment = await db.get(
      'SELECT status FROM installment_payments WHERE id = ?',
      [secondPlan.scheduledPayments[0].installmentId]
    )
    const otherPlanInstallment = await db.get(
      'SELECT status FROM installment_payments WHERE id = ?',
      [otherContactPlan.scheduledPayments[0].installmentId]
    )
    assert.equal(firstPlanInstallment.status, 'paid')
    assert.equal(secondPlanInstallment.status, 'scheduled')
    assert.equal(otherPlanInstallment.status, 'paid')

    const secondRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(secondRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 2)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactA.contactId)
    await cleanupContact(contactB.contactId)
  }
})

test('planes Stripe: cobra primer pago inmediato con tarjeta guardada y deja futuros programados', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('first')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const dueToday = todayDateOnly()
    const futureDueDate = addDaysDateOnly(30)

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan con enganche inmediato',
      description: 'Primer pago inmediato y parcialidad futura',
      totalAmount: 3000,
      paymentMethodId: savedMethodId,
      firstPayment: {
        enabled: true,
        amount: 800,
        date: dueToday,
        method: 'saved_card'
      },
      remainingPayments: [
        { sequence: 1, amount: 2200, percentage: null, dueDate: futureDueDate, frequency: 'monthly' }
      ]
    }, { baseUrl: 'https://example.test' })

    assert.equal(calls.paymentIntentsCreate.length, 1)
    assert.equal(calls.paymentIntentsCreate[0].params.amount, 80000)

    const flow = await db.get(
      `SELECT current_state, first_payment_status, first_payment_invoice_id
       FROM payment_flows
       WHERE id = ?`,
      [plan.flowId]
    )
    const firstPayment = await db.get('SELECT status, stripe_payment_intent_id FROM payments WHERE id = ?', [flow.first_payment_invoice_id])
    const installment = await db.get('SELECT status FROM installment_payments WHERE flow_id = ?', [plan.flowId])

    assert.equal(flow.current_state, 'installment_plan_active')
    assert.equal(flow.first_payment_status, 'paid')
    assert.equal(firstPayment.status, 'paid')
    assert.equal(firstPayment.stripe_payment_intent_id, 'pi_stress_1')
    assert.equal(installment.status, 'scheduled')

    const dueRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(dueRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 1)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('planes Stripe: payment ya pagado sincroniza parcialidad sin recobrar tarjeta', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('already_paid')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const dueToday = todayDateOnly()

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan ya pagado',
      description: 'Parcialidad ya pagada por webhook previo',
      totalAmount: 450,
      paymentMethodId: savedMethodId,
      firstPayment: { enabled: false },
      remainingPayments: [
        { sequence: 1, amount: 450, dueDate: dueToday, frequency: 'monthly' }
      ]
    }, { baseUrl: 'https://example.test' })

    const paymentId = plan.scheduledPayments[0].paymentId
    const installmentId = plan.scheduledPayments[0].installmentId
    await db.run(
      `UPDATE payments
       SET status = 'paid',
           stripe_payment_intent_id = 'pi_paid_before_cron',
           paid_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId]
    )

    const result = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(result.length, 1)
    assert.equal(result[0].skipped, true)
    assert.equal(calls.paymentIntentsCreate.length, 0)

    const installment = await db.get('SELECT status FROM installment_payments WHERE id = ?', [installmentId])
    assert.equal(installment.status, 'paid')
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('planes Stripe: tarjeta con requires_action marca error y evita reintentos duplicados', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('requires_action')
  const failedStripeAmount = 77700
  const { stripe, calls } = createStripeMock({ failAmounts: new Set([failedStripeAmount]) })
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const dueToday = todayDateOnly()

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan con tarjeta bloqueada',
      description: 'Parcialidad que requiere autenticacion',
      totalAmount: 777,
      paymentMethodId: savedMethodId,
      firstPayment: { enabled: false },
      remainingPayments: [
        { sequence: 1, amount: 777, dueDate: dueToday, frequency: 'monthly' }
      ]
    }, { baseUrl: 'https://example.test' })

    const paymentId = plan.scheduledPayments[0].paymentId
    const installmentId = plan.scheduledPayments[0].installmentId
    const firstRun = await processDueStripePaymentPlanCharges({ limit: 10 })

    assert.equal(firstRun.length, 1)
    assert.match(firstRun[0].error, /autenticacion|autenticación|requiere/i)
    assert.equal(calls.paymentIntentsCreate.length, 1)

    const payment = await db.get('SELECT status, stripe_payment_intent_id FROM payments WHERE id = ?', [paymentId])
    const installment = await db.get('SELECT status, stripe_payment_intent_id, notes FROM installment_payments WHERE id = ?', [installmentId])
    assert.equal(payment.status, 'pending')
    assert.equal(payment.stripe_payment_intent_id, 'pi_requires_action_1')
    assert.equal(installment.status, 'requires_action')
    assert.equal(installment.stripe_payment_intent_id, 'pi_requires_action_1')

    const secondRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(secondRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 1)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('planes Stripe: respeta hora programada interna y no cobra antes ni duplica', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('timed_plan')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const futureDue = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan con hora exacta',
      description: 'Parcialidad programada por timestamp interno',
      totalAmount: 275,
      paymentMethodId: savedMethodId,
      firstPayment: { enabled: false },
      remainingFrequency: 'scheduled_time',
      remainingPayments: [
        { sequence: 1, amount: 275, dueDate: futureDue, frequency: 'scheduled_time' }
      ]
    }, { baseUrl: 'https://example.test' })

    const earlyRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(earlyRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 0)

    const pastDue = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    await db.run(
      `UPDATE installment_payments
       SET due_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [pastDue, plan.scheduledPayments[0].installmentId]
    )

    const dueRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(dueRun.length, 1)
    assert.equal(dueRun[0].charged, true)
    assert.equal(calls.paymentIntentsCreate.length, 1)
    assert.equal(calls.paymentIntentsCreate[0].params.amount, 27500)

    const duplicateRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(duplicateRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 1)

    const installment = await db.get(
      'SELECT status, frequency, stripe_payment_intent_id FROM installment_payments WHERE id = ?',
      [plan.scheduledPayments[0].installmentId]
    )
    assert.equal(installment.status, 'paid')
    assert.equal(installment.frequency, 'scheduled_time')
    assert.equal(installment.stripe_payment_intent_id, 'pi_stress_1')
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('planes Stripe: primer pago con hora exacta no se cobra antes de la hora programada', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('timed_first_payment')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()
    const futureFirstPayment = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const futureInstallment = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

    const plan = await createStripePaymentPlan({
      contact,
      title: 'Plan con primer pago exacto',
      description: 'Primer pago programado por hora exacta',
      totalAmount: 300,
      paymentMethodId: savedMethodId,
      firstPayment: {
        enabled: true,
        amount: 100,
        date: futureFirstPayment,
        frequency: 'scheduled_time',
        method: 'saved_card'
      },
      remainingFrequency: 'scheduled_time',
      remainingPayments: [
        { sequence: 1, amount: 200, dueDate: futureInstallment, frequency: 'scheduled_time' }
      ]
    }, { baseUrl: 'https://example.test' })

    assert.equal(calls.paymentIntentsCreate.length, 0)

    const earlyRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(earlyRun.length, 0)
    assert.equal(calls.paymentIntentsCreate.length, 0)

    const pastDue = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    await db.run(
      `UPDATE payment_flows
       SET first_payment_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [pastDue, plan.flowId]
    )

    const dueRun = await processDueStripePaymentPlanCharges({ limit: 10 })
    assert.equal(dueRun.length, 1)
    assert.equal(dueRun[0].firstPayment, true)
    assert.equal(dueRun[0].charged, true)
    assert.equal(calls.paymentIntentsCreate.length, 1)
    assert.equal(calls.paymentIntentsCreate[0].params.amount, 10000)

    const flow = await db.get(
      'SELECT first_payment_status FROM payment_flows WHERE id = ?',
      [plan.flowId]
    )
    const payment = await db.get(
      'SELECT status, stripe_payment_intent_id FROM payments WHERE id = ?',
      [plan.firstPaymentPaymentId]
    )
    assert.equal(flow.first_payment_status, 'paid')
    assert.equal(payment.status, 'paid')
    assert.equal(payment.stripe_payment_intent_id, 'pi_stress_1')
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('suscripciones Stripe test: crea, sube/baja precio, pausa, reanuda, cancela y permite limpieza total', async () => {
  const { contactId, contact, savedMethodId, stripeCustomerId, stripePaymentMethodId } = await seedContactWithSavedCard('subscription_lifecycle')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()

    const created = await createSubscription({
      contactId,
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      name: 'Membresia stress',
      description: 'Suscripcion con lifecycle completo',
      amount: 1000,
      intervalType: 'monthly',
      intervalCount: 1,
      paymentMethod: 'stripe_saved_card',
      paymentProvider: 'stripe',
      stripePaymentMethodId: savedMethodId
    })

    assert.equal(created.status, 'active')
    assert.equal(created.amount, 1000)
    assert.equal(created.currency, 'MXN')
    assert.equal(created.stripeCustomerId, stripeCustomerId)
    assert.equal(created.stripePaymentMethodId, stripePaymentMethodId)
    assert.equal(calls.customersUpdate[0].params.invoice_settings.default_payment_method, stripePaymentMethodId)
    assert.equal(calls.productsCreate.length, 1)
    assert.equal(calls.pricesCreate[0].params.unit_amount, 100000)
    assert.deepEqual(calls.pricesCreate[0].params.recurring, { interval: 'month', interval_count: 1 })
    assert.equal(calls.subscriptionsCreate.length, 1)

    const initialPayment = await db.get(
      `SELECT amount, status, payment_method, reference
       FROM payments
       WHERE contact_id = ? AND payment_method = 'stripe_subscription'
       LIMIT 1`,
      [contactId]
    )
    assert.equal(initialPayment.amount, 1000)
    assert.equal(initialPayment.status, 'paid')
    assert.equal(initialPayment.payment_method, 'stripe_subscription')
    assert.equal(initialPayment.reference, 'in_stress_1')

    const increased = await updateSubscription(created.id, {
      name: 'Membresia stress pro',
      description: 'Sube de precio y cambia frecuencia',
      amount: 1500,
      intervalType: 'weekly',
      intervalCount: 2,
      paymentMethod: 'stripe_saved_card',
      paymentProvider: 'stripe'
    })

    assert.equal(increased.amount, 1500)
    assert.equal(increased.intervalType, 'weekly')
    assert.equal(increased.intervalCount, 2)
    assert.equal(calls.productsUpdate.length, 1)
    assert.equal(calls.pricesCreate[1].params.unit_amount, 150000)
    assert.deepEqual(calls.pricesCreate[1].params.recurring, { interval: 'week', interval_count: 2 })
    assert.equal(calls.subscriptionsUpdate.at(-1).params.proration_behavior, 'none')

    const decreased = await updateSubscription(created.id, {
      amount: 499.99,
      intervalType: 'monthly',
      intervalCount: 1,
      paymentMethod: 'stripe_saved_card',
      paymentProvider: 'stripe'
    })
    assert.equal(decreased.amount, 499.99)
    assert.equal(calls.pricesCreate.at(-1).params.unit_amount, 49999)

    await assert.rejects(
      () => updateSubscription(created.id, {
        paymentMethod: 'manual',
        paymentProvider: 'manual',
        amount: 499.99
      }),
      /Cancélala antes de cambiarla/
    )

    const paused = await actionSubscription(created.id, 'pause')
    assert.equal(paused.status, 'paused')
    assert.deepEqual(calls.subscriptionsUpdate.at(-1).params.pause_collection, { behavior: 'void' })

    const resumed = await actionSubscription(created.id, 'resume', { nextRunAt: '2099-05-01' })
    assert.equal(resumed.status, 'active')
    assert.equal(resumed.nextRunAt, '2099-05-01T06:00:00.000Z')
    assert.equal(calls.subscriptionsUpdate.at(-1).params.pause_collection, null)

    const pastDue = await actionSubscription(created.id, 'mark_past_due')
    assert.equal(pastDue.status, 'past_due')

    const cancelled = await actionSubscription(created.id, 'cancel')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(calls.subscriptionsCancel.length, 1)

    const deleted = await deleteSubscription(created.id)
    assert.equal(deleted, true)

    const removed = await getSubscription(created.id)
    const paymentAfterDelete = await db.get(
      `SELECT id
       FROM payments
       WHERE contact_id = ? AND payment_method = 'stripe_subscription'
       LIMIT 1`,
      [contactId]
    )
    assert.equal(removed, null)
    assert.equal(paymentAfterDelete, null)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('suscripciones Stripe: link crea Checkout de suscripcion en Stripe', async () => {
  const { contactId, contact, stripeCustomerId } = await seedContactWithSavedCard('subscription_checkout_link')
  const { stripe, calls } = createStripeMock()
  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe()

    const created = await createSubscription({
      contactId,
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      name: 'Membresia por link',
      description: 'Suscripcion activada por Checkout',
      amount: 750,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: addDaysDateOnly(7),
      cancelAt: addDaysDateOnly(120),
      paymentMethod: 'stripe_link',
      paymentProvider: 'stripe',
      status: 'incomplete',
      baseUrl: 'https://app.example.test'
    })

    assert.equal(created.status, 'incomplete')
    assert.equal(created.paymentMethod, 'stripe_link')
    assert.equal(created.paymentProvider, 'stripe')
    assert.equal(created.stripeCustomerId, stripeCustomerId)
    assert.equal(created.stripeCheckoutSessionId, 'cs_stress_1')
    assert.equal(created.stripeCheckoutUrl, 'https://checkout.stripe.test/cs_stress_1')
    assert.equal(created.subscriptionStartUrl, 'https://checkout.stripe.test/cs_stress_1')
    assert.equal(calls.checkoutSessionsCreate.length, 1)
    assert.equal(calls.checkoutSessionsCreate[0].params.mode, 'subscription')
    assert.equal(
      calls.checkoutSessionsCreate[0].params.success_url,
      `https://app.example.test/pay/${created.subscriptionStartPublicPaymentId}?payment=success&stripe_subscription=success&session_id={CHECKOUT_SESSION_ID}`
    )
    assert.equal(
      calls.checkoutSessionsCreate[0].params.cancel_url,
      `https://app.example.test/pay/${created.subscriptionStartPublicPaymentId}?payment=success&stripe_subscription=cancelled&session_id={CHECKOUT_SESSION_ID}`
    )
    assert.equal(calls.checkoutSessionsCreate[0].params.metadata.ristak_subscription_id, created.id)
    assert.equal(calls.checkoutSessionsCreate[0].params.metadata.public_payment_id, created.subscriptionStartPublicPaymentId)
    assert.ok(calls.checkoutSessionsCreate[0].params.success_url.includes(`/pay/${created.subscriptionStartPublicPaymentId}`))
    assert.equal(calls.checkoutSessionsCreate[0].params.subscription_data.metadata.ristak_subscription_id, created.id)
    assert.equal(calls.subscriptionsCreate.length, 0)
    assert.match(created.subscriptionStartPublicPaymentId || '', /^rstk_pay_[A-Za-z0-9]{20}$/)

    const saved = await db.get(
      `SELECT status, payment_method, payment_provider, stripe_subscription_id, metadata_json
       FROM subscriptions
       WHERE id = ?`,
      [created.id]
    )
    const metadata = JSON.parse(saved.metadata_json)
    assert.equal(saved.status, 'incomplete')
    assert.equal(saved.payment_method, 'stripe_link')
    assert.equal(saved.payment_provider, 'stripe')
    assert.equal(saved.stripe_subscription_id, null)
    assert.equal(metadata.subscriptionStartPayment.provider, 'stripe')
    assert.equal(metadata.subscriptionStartPayment.paymentUrl, 'https://checkout.stripe.test/cs_stress_1')
    assert.equal(metadata.subscriptionStartPayment.status, 'pending_checkout')
    assert.equal(metadata.subscriptionStartPayment.publicPaymentId, created.subscriptionStartPublicPaymentId)
    assert.equal(metadata.stripeCheckout.sessionId, 'cs_stress_1')

    const withCheckout = await getSubscription(created.id)
    assert.equal(withCheckout.stripeCheckoutSessionId, 'cs_stress_1')
    assert.equal(withCheckout.stripeCheckoutUrl, 'https://checkout.stripe.test/cs_stress_1')
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('suscripciones Stripe: Checkout hospedado activa suscripcion en webhook', async () => {
  const { contactId, contact } = await seedContactWithSavedCard('subscription_public_link_activation')
  const webhookSecret = 'whsec_subscription_public_link'
  let webhookEvent = null
  const { stripe, calls } = createStripeMock()

  stripe.webhooks.constructEvent = (rawBody, signature, secret) => {
    calls.webhooksConstructEvent.push({ rawBody, signature, secret })
    return webhookEvent
  }

  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe({ webhookSecret })

    const created = await createSubscription({
      contactId,
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      name: 'Membresia link publico',
      description: 'Activa con primer pago publico',
      amount: 640,
      intervalType: 'monthly',
      intervalCount: 1,
      paymentMethod: 'stripe_link',
      paymentProvider: 'stripe',
      status: 'incomplete',
      baseUrl: 'https://app.example.test'
    })

    assert.equal(created.subscriptionStartUrl, 'https://checkout.stripe.test/cs_stress_1')
    assert.match(created.subscriptionStartPublicPaymentId || '', /^rstk_pay_[A-Za-z0-9]{20}$/)
    assert.equal(calls.checkoutSessionsCreate.length, 1)

    webhookEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          object: 'checkout.session',
          id: created.stripeCheckoutSessionId,
          payment_status: 'paid',
          customer: 'cus_subscription_checkout',
          subscription: 'sub_subscription_checkout',
          metadata: {
            ristak_subscription_id: created.id
          }
        }
      }
    }

    const webhookResult = await handleStripeWebhookEvent(Buffer.from('{}'), 'sig_test')
    assert.equal(webhookResult.received, true)
    assert.equal(calls.subscriptionsCreate.length, 0)

    const activated = await getSubscription(created.id)
    assert.equal(activated.status, 'active')
    assert.equal(activated.paymentMethod, 'stripe_link')
    assert.equal(activated.stripeSubscriptionId, 'sub_subscription_checkout')
    assert.equal(activated.subscriptionStartPaymentStatus, 'paid')
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})

test('suscripciones: elimina una suscripcion local sin cobros registrados', async () => {
  const { contactId, contact } = await seedContactWithSavedCard('subscription_delete_empty')

  try {
    await configureStripe()

    const created = await createSubscription({
      contactId,
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      name: 'Suscripcion sin cobros',
      description: 'Borrable porque no tiene historial de pagos',
      amount: 100,
      intervalType: 'monthly',
      intervalCount: 1,
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })

    assert.equal(created.status, 'active')
    const deleted = await deleteSubscription(created.id)
    assert.equal(deleted, true)
    assert.equal(await getSubscription(created.id), null)
  } finally {
    await cleanupContact(contactId)
  }
})

test('suscripciones Stripe: webhook invoice.payment_succeeded registra pago recurrente sin duplicar', async () => {
  const { contactId, contact, savedMethodId } = await seedContactWithSavedCard('subscription_webhook')
  const webhookSecret = 'whsec_local_stress_suite'
  const invoiceId = `in_${suffix('subscription_invoice')}`
  let invoiceEvent = null
  const { stripe, calls } = createStripeMock({
    get webhookEvent() {
      return invoiceEvent
    }
  })

  // Object getter syntax does not flow through the helper argument after creation,
  // so override constructEvent with a closure that sees the current event.
  stripe.webhooks.constructEvent = (rawBody, signature, secret) => {
    calls.webhooksConstructEvent.push({ rawBody, signature, secret })
    return invoiceEvent
  }

  setStripeFactoryForTest(() => stripe)

  try {
    await configureStripe({ webhookSecret })

    const created = await createSubscription({
      contactId,
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      name: 'Webhook recurrente stress',
      description: 'Valida pagos recurrentes por invoice webhook',
      amount: 888.88,
      intervalType: 'monthly',
      intervalCount: 1,
      paymentMethod: 'stripe_saved_card',
      paymentProvider: 'stripe',
      stripePaymentMethodId: savedMethodId
    })

    invoiceEvent = {
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          object: 'invoice',
          id: invoiceId,
          customer: created.stripeCustomerId,
          subscription: created.stripeSubscriptionId,
          currency: 'mxn',
          amount_paid: 88888,
          hosted_invoice_url: 'https://stripe.example.test/invoice',
          metadata: {
            ristak_subscription_id: created.id
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
          },
          status_transitions: {
            paid_at: 2524608123
          }
        }
      }
    }

    const firstWebhook = await handleStripeWebhookEvent(Buffer.from('{}'), 'sig_test')
    assert.equal(firstWebhook.received, true)
    assert.equal(calls.webhooksConstructEvent[0].secret, webhookSecret)

    const refreshed = await getSubscription(created.id)
    assert.equal(refreshed.status, 'active')
    assert.equal(refreshed.nextRunAt, '2050-02-01T00:00:00.000Z')

    const recurrentPayments = await db.all(
      `SELECT amount, status, payment_method, reference, payment_url, metadata_json
       FROM payments
       WHERE contact_id = ? AND payment_method = 'stripe_subscription'
      ORDER BY created_at ASC`,
      [contactId]
    )
    assert.equal(recurrentPayments.length, 2)
    const webhookPayment = recurrentPayments.find((payment) => payment.reference === invoiceId)
    assert.equal(webhookPayment.amount, 888.88)
    assert.equal(webhookPayment.status, 'paid')
    assert.equal(webhookPayment.payment_url, 'https://stripe.example.test/invoice')
    assert.equal(JSON.parse(webhookPayment.metadata_json).ristakSubscriptionId, created.id)

    const duplicateWebhook = await handleStripeWebhookEvent(Buffer.from('{}'), 'sig_test')
    assert.equal(duplicateWebhook.received, true)
    const countAfterDuplicate = await db.get(
      `SELECT COUNT(*) AS count
       FROM payments
      WHERE contact_id = ? AND payment_method = 'stripe_subscription'`,
      [contactId]
    )
    assert.equal(countAfterDuplicate.count, 2)
  } finally {
    setStripeFactoryForTest(null)
    await cleanupContact(contactId)
  }
})
