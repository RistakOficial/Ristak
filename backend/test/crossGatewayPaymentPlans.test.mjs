import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { listInvoiceSchedules } from '../src/controllers/highlevelController.js'
import { createConektaPaymentPlan, saveConektaPaymentConfig, setConektaFetchForTest } from '../src/services/conektaPaymentService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { createStripePaymentPlan, saveStripePaymentConfig, setStripeFactoryForTest } from '../src/services/stripePaymentService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

function suffix(label = 'cross_gateway') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM stripe_payment_methods WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conekta_payment_sources WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function snapshotRows(tableName, whereClause = '', params = []) {
  const rows = await db.all(`SELECT * FROM ${tableName} ${whereClause}`, params).catch(() => [])

  return {
    rows,
    async restore() {
      await db.run(`DELETE FROM ${tableName} ${whereClause}`, params).catch(() => undefined)

      for (const row of rows) {
        const columns = Object.keys(row)
        if (!columns.length) continue
        const quotedColumns = columns.map((column) => `"${column}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        await db.run(
          `INSERT INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`,
          columns.map((column) => row[column])
        )
      }
    }
  }
}

async function withIsolatedGatewayConfig(callback) {
  const appConfigSnapshot = await snapshotRows(
    'app_config',
    "WHERE config_key LIKE 'stripe_%' OR config_key LIKE 'conekta_%' OR config_key = 'payments_settings'"
  )
  const highLevelSnapshot = await snapshotRows('highlevel_config')

  try {
    await db.run(
      "DELETE FROM app_config WHERE config_key LIKE 'stripe_%' OR config_key LIKE 'conekta_%' OR config_key = 'payments_settings'"
    )
    await db.run('DELETE FROM highlevel_config')
    return await callback()
  } finally {
    setStripeFactoryForTest(null)
    setConektaFetchForTest(null)
    await appConfigSnapshot.restore()
    await highLevelSnapshot.restore()
  }
}

async function collectListInvoiceSchedules(params = {}) {
  const req = { query: params }

  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        if (this.statusCode >= 400 || payload?.success === false) {
          reject(new Error(payload?.error || `listInvoiceSchedules failed with ${this.statusCode}`))
          return
        }
        resolve(payload)
      }
    }

    listInvoiceSchedules(req, res).catch(reject)
  })
}

test('planes de pago: Stripe y Conekta coexisten para el mismo contacto y el listado devuelve ambos', async () => {
  await initializeMasterKey()

  const idSuffix = suffix()
  const contactId = `contact_${idSuffix}`
  const stripeCustomerId = `cus_${idSuffix}`
  const stripePaymentMethodId = `pm_${idSuffix}`
  const stripeSavedMethodId = `stripe_pm_${idSuffix}`
  const conektaCustomerId = `conekta_cus_${idSuffix}`
  const conektaSourceId = `src_${idSuffix}`
  const conektaSavedSourceId = `conekta_source_${idSuffix}`
  const phone = testPhoneFromSuffix(idSuffix)
  const contact = {
    id: contactId,
    name: 'Cliente Pasarelas Cruzadas',
    email: `${contactId}@example.test`,
    phone
  }

  await cleanupContact(contactId)

  await withIsolatedGatewayConfig(async () => {
    setStripeFactoryForTest(() => ({
      paymentMethods: {
        retrieve: async () => ({
          id: stripePaymentMethodId,
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2035,
            funding: 'credit',
            country: 'MX'
          }
        })
      },
      paymentIntents: {
        create: async () => {
          throw new Error('No se esperaba cobrar Stripe en esta prueba.')
        }
      }
    }))
    setConektaFetchForTest(async () => {
      throw new Error('No se esperaba llamar Conekta en esta prueba.')
    })

    await savePaymentSettings({ paymentMode: 'test' })
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_cross_gateway',
      secretKey: 'sk_test_cross_gateway',
      defaultCurrency: 'MXN'
    })
    await saveConektaPaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publicKey: 'key_test_cross_gateway_public',
          privateKey: 'key_test_cross_gateway_private'
        }
      }
    })

    await db.run(
      `INSERT INTO contacts (
        id, full_name, email, phone, source, stripe_customer_id, conekta_customer_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'test', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, contact.name, contact.email, phone, stripeCustomerId, conektaCustomerId]
    )
    await db.run(
      `INSERT INTO stripe_payment_methods (
        id, contact_id, stripe_customer_id, stripe_payment_method_id,
        brand, last4, exp_month, exp_year, funding, country, mode, is_default,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'credit', 'MX', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [stripeSavedMethodId, contactId, stripeCustomerId, stripePaymentMethodId]
    )
    await db.run(
      `INSERT INTO conekta_payment_sources (
        id, contact_id, conekta_customer_id, conekta_payment_source_id,
        brand, last4, exp_month, exp_year, mode, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'visa', '4242', 12, 2035, 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [conektaSavedSourceId, contactId, conektaCustomerId, conektaSourceId]
    )

    const stripePlan = await createStripePaymentPlan({
      contact,
      title: 'Plan Stripe mismo contacto',
      description: 'Plan Stripe mismo contacto',
      totalAmount: 1200,
      paymentMethodId: stripeSavedMethodId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 1200, dueDate: addDaysDateOnly(20), frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    const conektaPlan = await createConektaPaymentPlan({
      contact,
      title: 'Plan Conekta mismo contacto',
      description: 'Plan Conekta mismo contacto',
      totalAmount: 850,
      paymentMethodId: conektaSourceId,
      firstPayment: { enabled: false },
      remainingFrequency: 'custom',
      remainingPayments: [
        { sequence: 1, amount: 850, dueDate: addDaysDateOnly(35), frequency: 'custom' }
      ]
    }, { baseUrl: 'https://example.test' })

    assert.notEqual(stripePlan.flowId, conektaPlan.flowId)

    const mirrors = await db.all(
      `SELECT id, source, total
       FROM payment_plans
       WHERE contact_id = ?
       ORDER BY source ASC`,
      [contactId]
    )
    assert.equal(mirrors.length, 2)
    assert.deepEqual(new Set(mirrors.map((row) => row.id)), new Set([stripePlan.flowId, conektaPlan.flowId]))
    assert.deepEqual(new Set(mirrors.map((row) => row.source)), new Set(['stripe', 'conekta']))

    const listed = await collectListInvoiceSchedules({ activeOnly: 'false' })
    const listedForContact = (listed.data || []).filter((plan) => plan.contactId === contactId)
    assert.equal(listedForContact.length, 2)
    assert.deepEqual(new Set(listedForContact.map((plan) => plan.id)), new Set([stripePlan.flowId, conektaPlan.flowId]))
    assert.deepEqual(new Set(listedForContact.map((plan) => plan.source)), new Set(['stripe', 'conekta']))
  })

  await cleanupContact(contactId)
})
