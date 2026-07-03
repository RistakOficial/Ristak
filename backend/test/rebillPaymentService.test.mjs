import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  confirmPublicRebillPayment,
  createRebillPaymentLink,
  getRebillPaymentConfig,
  mapRebillStatus,
  saveRebillPaymentConfig,
  setRebillFetchForTest,
  testRebillPaymentConfig
} from '../src/services/rebillPaymentService.js'

async function snapshotRebillConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
    setRebillFetchForTest(null)
  }
}

function jsonTextResponse(payload, status = 200) {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    },
    async json() {
      return payload
    }
  }
}

async function cleanupPublicPayment(publicPaymentId) {
  if (!publicPaymentId) return
  await db.run('DELETE FROM installment_payments WHERE payment_id IN (SELECT id FROM payments WHERE public_payment_id = ?)', [publicPaymentId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE public_payment_id = ?', [publicPaymentId]).catch(() => undefined)
}

function installRebillConfigFetchMock(calls = []) {
  setRebillFetchForTest(async (url, options = {}) => {
    const parsed = new URL(url)
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(String(options.body)) : null
    calls.push({
      method,
      path: parsed.pathname,
      apiKey: options.headers?.['x-api-key'],
      body
    })

    if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
      return jsonTextResponse({
        id: 'org_rebill_test',
        name: 'Rebill Test Org',
        status: 'active',
        environment: 'test'
      })
    }

    if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
      return jsonTextResponse({ records: [] })
    }

    if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
      assert.equal(body.url, 'https://app.example.test/api/rebill/webhook')
      assert.deepEqual(body.events, ['payment.created', 'payment.updated'])
      return jsonTextResponse({
        id: 'wh_rebill_test',
        url: body.url,
        events: body.events,
        active: true
      }, 201)
    }

    return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
  })
}

test('Rebill estados: cancelado o expirado queda reintentable y rechazo real falla', () => {
  assert.equal(mapRebillStatus('canceled'), 'pending')
  assert.equal(mapRebillStatus('cancelled'), 'pending')
  assert.equal(mapRebillStatus('expired'), 'pending')
  assert.equal(mapRebillStatus('rejected'), 'failed')
  assert.equal(mapRebillStatus('declined'), 'failed')
  assert.equal(mapRebillStatus('approved'), 'paid')
})

test('Rebill guarda llaves por modo cifradas, valida organización y configura webhook', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    installRebillConfigFetchMock(calls)

    const publicKey = 'pk_test_1234567890abcdef'
    const secretKey = 'sk_test_1234567890abcdef'
    const tested = await testRebillPaymentConfig({
      mode: 'test',
      publicKey,
      secretKey
    })

    assert.equal(tested.ok, true)
    assert.equal(tested.organization.id, 'org_rebill_test')
    assert.equal(calls.at(-1).apiKey, secretKey)

    const config = await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })

    assert.equal(config.configured, true)
    assert.equal(config.mode, 'test')
    assert.equal(config.publicKey, publicKey)
    assert.equal(config.hasSecretKey, true)
    assert.equal(config.secretKey, undefined)
    assert.equal(config.accountLabel, 'Rebill Test Org')
    assert.equal(config.webhookConfigured, true)
    assert.equal(config.webhookStatus, 'configured')

    const modeConnections = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['rebill_mode_connections']
    )
    assert.ok(modeConnections?.config_value)
    assert.equal(modeConnections.config_value.includes(secretKey), false)
    assert.equal(modeConnections.config_value.includes(publicKey), true)

    const selectedTest = await getRebillPaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(selectedTest.secretKey, secretKey)
    assert.equal(selectedTest.publicKey, publicKey)
  })
})

test('Rebill confirma pago público consultando el paymentId en backend antes de marcarlo pagado', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    const publicKey = 'pk_test_abcdef1234567890'
    const secretKey = 'sk_test_abcdef1234567890'

    setRebillFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const method = options.method || 'GET'
      const body = options.body ? JSON.parse(String(options.body)) : null
      calls.push({
        method,
        path: parsed.pathname,
        apiKey: options.headers?.['x-api-key'],
        body
      })

      if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
        return jsonTextResponse({ id: 'org_rebill_charge', name: 'Rebill Charge Org', status: 'active' })
      }
      if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
        return jsonTextResponse({ records: [] })
      }
      if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
        return jsonTextResponse({ id: 'wh_rebill_charge', url: body.url, events: body.events, active: true }, 201)
      }
      if (parsed.pathname === '/v3/payments/pay_rebill_service_test' && method === 'GET') {
        return jsonTextResponse({
          id: 'pay_rebill_service_test',
          status: 'approved',
          amount: 499.5,
          currency: 'MXN',
          approvedAt: '2026-07-03T18:30:00.000Z',
          subscriptionId: 'sub_rebill_service_test',
          customer: { id: 'cus_rebill_service_test' },
          card: {
            id: 'card_rebill_service_test',
            brand: 'visa',
            lastFourDigits: '4242'
          },
          metadata: {
            publicPaymentId
          }
        })
      }

      return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
    })

    await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })

    let publicPaymentId = ''
    try {
      const link = await createRebillPaymentLink({
        amount: 499.5,
        currency: 'MXN',
        title: 'Pago Rebill test',
        description: 'Pago Rebill test',
        email: 'cliente@example.test',
        phone: '+525512345678',
        metadata: { testSource: 'rebillPaymentService.test' }
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      })
      publicPaymentId = link.publicPaymentId

      assert.match(publicPaymentId, /^rstk_pay_[A-Za-z0-9]{20}$/)
      assert.equal(link.payment.provider, 'rebill')
      assert.equal(link.payment.publicKey, publicKey)
      assert.equal(link.payment.instantProduct.currency, 'MXN')
      assert.equal(link.payment.instantProduct.metadata.publicPaymentId, publicPaymentId)

      const beforeConfirm = await db.get('SELECT status, rebill_payment_id FROM payments WHERE public_payment_id = ?', [publicPaymentId])
      assert.equal(beforeConfirm.status, 'sent')
      assert.equal(beforeConfirm.rebill_payment_id, null)

      const result = await confirmPublicRebillPayment(publicPaymentId, {
        rebillPaymentId: 'pay_rebill_service_test'
      }, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(result.rebillPaymentId, 'pay_rebill_service_test')
      assert.equal(result.status, 'approved')
      assert.equal(result.payment.status, 'paid')
      assert.equal(result.payment.rebillPaymentId, 'pay_rebill_service_test')

      const row = await db.get(
        `SELECT status, amount, currency, payment_provider, payment_method, rebill_payment_id,
                rebill_subscription_id, rebill_customer_id, rebill_card_id, paid_at
           FROM payments
          WHERE public_payment_id = ?`,
        [publicPaymentId]
      )
      assert.equal(row.status, 'paid')
      assert.equal(row.amount, 499.5)
      assert.equal(row.currency, 'MXN')
      assert.equal(row.payment_provider, 'rebill')
      assert.equal(row.payment_method, 'rebill_checkout')
      assert.equal(row.rebill_payment_id, 'pay_rebill_service_test')
      assert.equal(row.rebill_subscription_id, 'sub_rebill_service_test')
      assert.equal(row.rebill_customer_id, 'cus_rebill_service_test')
      assert.equal(row.rebill_card_id, 'card_rebill_service_test')
      assert.equal(row.paid_at, '2026-07-03T18:30:00.000Z')

      const paymentFetch = calls.find((call) => call.path === '/v3/payments/pay_rebill_service_test')
      assert.ok(paymentFetch)
      assert.equal(paymentFetch.apiKey, secretKey)
    } finally {
      await cleanupPublicPayment(publicPaymentId)
    }
  })
})
