import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  createClipPaymentLink,
  createPublicClipCardPayment,
  getClipPaymentConfig,
  saveClipPaymentConfig,
  setClipFetchForTest,
  testClipPaymentConfig
} from '../src/services/clipPaymentService.js'

async function snapshotClipConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'clip_%' OR config_key = 'payments_settings'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'clip_%' OR config_key = 'payments_settings'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'clip_%' OR config_key = 'payments_settings'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
    setClipFetchForTest(null)
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

async function cleanupPublicPayment(publicPaymentId) {
  if (!publicPaymentId) return
  await db.run('DELETE FROM installment_payments WHERE payment_id IN (SELECT id FROM payments WHERE public_payment_id = ?)', [publicPaymentId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE public_payment_id = ?', [publicPaymentId]).catch(() => undefined)
}

test('CLIP guarda API Keys por modo cifradas y desconecta un modo sin borrar el otro', async () => {
  await initializeMasterKey()

  await snapshotClipConfig(async () => {
    const testConfig = await saveClipPaymentConfig({
      enabled: true,
      mode: 'test',
      accountLabel: 'CLIP Test',
      apiKey: 'clip_test_secret_config'
    })
    assert.equal(testConfig.configured, true)
    assert.equal(testConfig.mode, 'test')
    assert.equal(testConfig.hasApiKey, true)
    assert.equal(testConfig.apiKey, undefined)

    const liveConfig = await saveClipPaymentConfig({
      enabled: true,
      mode: 'live',
      accountLabel: 'CLIP Live',
      apiKey: 'clip_live_secret_config'
    })
    assert.equal(liveConfig.configured, true)
    assert.equal(liveConfig.mode, 'live')

    const modeConnectionsRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['clip_mode_connections']
    )
    assert.ok(modeConnectionsRow?.config_value)
    assert.equal(modeConnectionsRow.config_value.includes('clip_test_secret_config'), false)
    assert.equal(modeConnectionsRow.config_value.includes('clip_live_secret_config'), false)

    const selectedTest = await getClipPaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(selectedTest.apiKey, 'clip_test_secret_config')

    const disconnectedTest = await saveClipPaymentConfig({
      mode: 'test',
      disconnectMode: true
    })
    assert.equal(disconnectedTest.mode, 'live')
    assert.equal(disconnectedTest.configured, true)

    const afterTest = await getClipPaymentConfig({ includeSecrets: true, mode: 'test' })
    const afterLive = await getClipPaymentConfig({ includeSecrets: true, mode: 'live' })
    assert.equal(afterTest.configured, false)
    assert.equal(afterTest.apiKey, '')
    assert.equal(afterLive.configured, true)
    assert.equal(afterLive.apiKey, 'clip_live_secret_config')
  })
})

test('CLIP rechaza links fuera de MXN antes de crear pagos locales', async () => {
  await initializeMasterKey()

  await snapshotClipConfig(async () => {
    await saveClipPaymentConfig({
      enabled: true,
      mode: 'test',
      accountLabel: 'CLIP Test',
      apiKey: 'clip_test_secret_currency'
    })

    await assert.rejects(
      () => createClipPaymentLink({
        amount: 500,
        currency: 'USD',
        title: 'Pago USD',
        email: 'cliente@example.test',
        phone: '+525512345678'
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      }),
      /solo acepta MXN/
    )
  })
})

test('CLIP valida credencial SDK sin llamar endpoints de Payments', async () => {
  await initializeMasterKey()

  await snapshotClipConfig(async () => {
    let calls = 0
    setClipFetchForTest(async () => {
      calls += 1
      throw new Error('La validacion SDK no debe llamar a CLIP Payments')
    })

    const apiKey = 'test_f5688896-335f-4e71-9438-43eeb72b0382'
    const result = await testClipPaymentConfig({
      mode: 'test',
      accountLabel: apiKey,
      apiKey: 'clip_secret_not_required_for_sdk'
    })

    assert.equal(result.ok, true)
    assert.equal(result.mode, 'test')
    assert.equal(result.validationMode, 'sdk_credentials')
    assert.equal(result.sdkScriptUrl, 'https://sdk.clip.mx/js/clip-sdk.js')
    assert.equal(result.apiKeyPreview, 'test_f****0382')
    assert.equal(calls, 0)

    await saveClipPaymentConfig({
      enabled: true,
      mode: 'test',
      accountLabel: apiKey,
      apiKey: 'clip_secret_not_required_for_sdk'
    })
    const saved = await getClipPaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(saved.apiKey, apiKey)
    assert.equal(saved.accountLabel, 'CLIP prueba')
  })
})

test('CLIP procesa token del SDK, guarda pago aprobado y usa approved_at como fecha de pago', async () => {
  await initializeMasterKey()

  await snapshotClipConfig(async () => {
    await saveClipPaymentConfig({
      enabled: true,
      mode: 'test',
      accountLabel: 'CLIP Test',
      apiKey: 'clip_test_secret_charge'
    })

    const calls = []
    setClipFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      calls.push({
        method: options.method || 'GET',
        path: parsed.pathname,
        authorization: options.headers?.Authorization,
        body
      })

      if (parsed.pathname === '/payments' && (options.method || 'GET') === 'POST') {
        return jsonResponse({
          id: 'clip_pay_service_test',
          amount: body.amount,
          currency: body.currency,
          external_reference: body.external_reference,
          receipt_no: 'clip_receipt_service_test',
          status: 'approved',
          status_detail: { code: 'AP-PAI01', message: 'paid' },
          approved_at: '2026-07-02T18:30:00.000Z',
          payment_method: {
            type: 'credit_card',
            token: body.payment_method.token,
            card: { last_digits: '4242' }
          },
          pending_action: {}
        }, 201)
      }

      return jsonResponse({ error_code: 'not_found', message: 'No esperado' }, 404)
    })

    let publicPaymentId = ''
    try {
      const link = await createClipPaymentLink({
        amount: 500,
        currency: 'MXN',
        title: 'Pago CLIP test',
        description: 'Pago CLIP test',
        email: 'cliente@example.test',
        phone: '+525512345678',
        metadata: { testSource: 'clipPaymentService.test' }
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      })
      publicPaymentId = link.publicPaymentId

      const result = await createPublicClipCardPayment(publicPaymentId, {
        tokenId: 'clip_card_token_test',
        email: 'cliente@example.test',
        phone: '+525512345678'
      }, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(result.status, 'approved')
      assert.equal(result.clipPaymentId, 'clip_pay_service_test')
      assert.equal(result.clipReceiptNo, 'clip_receipt_service_test')
      assert.equal(result.payment.status, 'paid')

      const payment = await db.get(
        `SELECT status, payment_provider, payment_method, payment_mode, clip_payment_id, clip_receipt_no, paid_at
         FROM payments
         WHERE public_payment_id = ?`,
        [publicPaymentId]
      )
      assert.equal(payment.status, 'paid')
      assert.equal(payment.payment_provider, 'clip')
      assert.equal(payment.payment_method, 'clip_card')
      assert.equal(payment.payment_mode, 'test')
      assert.equal(payment.clip_payment_id, 'clip_pay_service_test')
      assert.equal(payment.clip_receipt_no, 'clip_receipt_service_test')
      assert.equal(payment.paid_at, '2026-07-02T18:30:00.000Z')

      const postCall = calls.find((call) => call.method === 'POST' && call.path === '/payments')
      assert.ok(postCall)
      assert.equal(postCall.authorization, 'Bearer clip_test_secret_charge')
      assert.equal(postCall.body.currency, 'MXN')
      assert.equal(postCall.body.customer.email, 'cliente@example.test')
      assert.equal(postCall.body.customer.phone, '+525512345678')
      assert.equal(postCall.body.payment_method.token, 'clip_card_token_test')
      assert.equal(postCall.body.webhook_url, 'https://app.example.test/api/clip/webhook')
    } finally {
      await cleanupPublicPayment(publicPaymentId)
    }
  })
})
