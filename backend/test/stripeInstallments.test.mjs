import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import {
  createStripePaymentIntent,
  createStripePaymentLink,
  getPublicStripePayment,
  saveStripePaymentConfig,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

async function snapshotPaymentConfig(callback) {
  const previousRows = await db.all(
    `SELECT config_key, config_value
     FROM app_config
     WHERE config_key LIKE 'stripe_%'
        OR config_key = 'payments_settings'
        OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
  )

  try {
    await db.run(
      `DELETE FROM app_config
       WHERE config_key LIKE 'stripe_%'
          OR config_key = 'payments_settings'
          OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
    )
    return await callback()
  } finally {
    await db.run(
      `DELETE FROM app_config
       WHERE config_key LIKE 'stripe_%'
          OR config_key = 'payments_settings'
          OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
    )
    for (const row of previousRows) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET
           config_value = excluded.config_value,
           updated_at = CURRENT_TIMESTAMP`,
        [row.config_key, row.config_value]
      )
    }
    setStripeFactoryForTest(null)
  }
}

async function configureStripeInstallmentTest() {
  await initializeMasterKey()
  await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
  await savePaymentSettings({ paymentMode: 'test' })
  await saveStripePaymentConfig({
    enabled: true,
    mode: 'test',
    publishableKey: 'pk_test_stripe_installments',
    secretKey: 'sk_test_stripe_installments',
    defaultCurrency: 'MXN'
  })
}

async function cleanupPublicPayments(publicPaymentIds = []) {
  const ids = publicPaymentIds.filter(Boolean)
  if (!ids.length) return
  await db.run(
    `DELETE FROM payments
     WHERE public_payment_id IN (${ids.map(() => '?').join(', ')})`,
    ids
  ).catch(() => undefined)
}

test('Stripe habilita meses sin intereses en PaymentIntent cuando el link lo pide', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const createCalls = []
    let intentSequence = 0
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          intentSequence += 1
          createCalls.push({ params, requestOptions })
          return {
            id: `pi_installments_${intentSequence}`,
            client_secret: `pi_installments_${intentSequence}_secret_test`,
            status: 'requires_payment_method'
          }
        }
      }
    }))

    const createdPublicIds = []
    try {
      const msiLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago Stripe MSI',
        description: 'Pago con meses sin intereses',
        installments: { enabled: true }
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(msiLink.publicPaymentId)

      const publicPayment = await getPublicStripePayment(msiLink.publicPaymentId, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(publicPayment.stripeInstallments.enabled, true)
      assert.equal(publicPayment.stripeInstallments.minAmount, 300)

      const msiIntent = await createStripePaymentIntent(msiLink.publicPaymentId, {
        savePaymentMethod: false
      })
      assert.equal(msiIntent.status, 'requires_payment_method')
      assert.equal(createCalls.length, 1)
      assert.equal(createCalls[0].params.payment_method_options.card.installments.enabled, true)

      const standardLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago Stripe contado',
        description: 'Pago sin meses'
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(standardLink.publicPaymentId)

      await createStripePaymentIntent(standardLink.publicPaymentId, {
        savePaymentMethod: false
      })
      assert.equal(createCalls.length, 2)
      assert.equal(createCalls[1].params.payment_method_options, undefined)
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})
