import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createSubscription,
  updateSubscription
} from '../src/services/subscriptionsService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'

function uniqueName(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function deleteSubscriptions(ids) {
  for (const id of ids) {
    await db.run('DELETE FROM payments WHERE metadata_json LIKE ?', [`%${id}%`]).catch(() => undefined)
    await db.run('DELETE FROM subscriptions WHERE id = ?', [id]).catch(() => undefined)
  }
}

test('suscripciones nuevas suman el IVA al total por defecto y conservan la elección fiscal', async () => {
  const previousPaymentSettings = await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY)
  const subscriptionIds = []

  try {
    // Aunque la configuración histórica de la cuenta diga "incluido", el alta
    // interactiva nueva debe comenzar en "se suma al total".
    await savePaymentSettings({
      taxes: {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        calculationMode: 'inclusive'
      }
    })

    const exclusive = await createSubscription({
      name: uniqueName('subscription_tax_exclusive'),
      amount: 100,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    subscriptionIds.push(exclusive.id)

    assert.equal(exclusive.configuredAmount, 100)
    assert.equal(exclusive.amount, 116)
    assert.equal(exclusive.tax?.calculationMode, 'exclusive')
    assert.equal(exclusive.tax?.subtotalAmount, 100)
    assert.equal(exclusive.tax?.taxAmount, 16)
    assert.equal(exclusive.tax?.totalAmount, 116)

    const inclusive = await createSubscription({
      name: uniqueName('subscription_tax_inclusive'),
      amount: 100,
      applyTax: true,
      taxCalculationMode: 'inclusive',
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    subscriptionIds.push(inclusive.id)

    assert.equal(inclusive.configuredAmount, 100)
    assert.equal(inclusive.amount, 100)
    assert.equal(inclusive.tax?.calculationMode, 'inclusive')
    assert.equal(inclusive.tax?.taxAmount, 13.79)
    assert.equal(inclusive.tax?.totalAmount, 100)

    const withoutTax = await createSubscription({
      name: uniqueName('subscription_without_tax'),
      amount: 100,
      applyTax: false,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    subscriptionIds.push(withoutTax.id)

    assert.equal(withoutTax.amount, 100)
    assert.equal(withoutTax.configuredAmount, 100)
    assert.equal(withoutTax.tax, null)

    await savePaymentSettings({ taxes: { rateValue: 8 } })
    const edited = await updateSubscription(exclusive.id, { description: 'Edición sin tocar el IVA' })

    assert.equal(edited.amount, 116)
    assert.equal(edited.configuredAmount, 100)
    assert.equal(edited.tax?.rateValue, 16)
    assert.equal(edited.tax?.taxAmount, 16)
  } finally {
    await deleteSubscriptions(subscriptionIds)
    if (previousPaymentSettings === null) {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [PAYMENT_SETTINGS_CONFIG_KEY])
    } else {
      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, previousPaymentSettings)
    }
  }
})
