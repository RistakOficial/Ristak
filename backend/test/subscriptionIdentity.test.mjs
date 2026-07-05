import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { db, setAppConfig } from '../src/config/database.js'
import {
  createSubscription,
  listSubscriptions
} from '../src/services/subscriptionsService.js'
import { setRebillFetchForTest } from '../src/services/rebillPaymentService.js'

function uniqueSuffix(label = 'subscription_identity') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function cleanup({ contactId, subscriptionIds = [] }) {
  for (const subscriptionId of subscriptionIds) {
    await db.run(
      `DELETE FROM payments
       WHERE metadata_json LIKE ?
          OR id IN (
            SELECT json_extract(metadata_json, '$.subscriptionStartPayment.paymentId')
            FROM subscriptions
            WHERE id = ?
          )`,
      [`%${subscriptionId}%`, subscriptionId]
    ).catch(() => undefined)
    await db.run('DELETE FROM subscriptions WHERE id = ?', [subscriptionId]).catch(() => undefined)
  }
  await db.run('DELETE FROM subscriptions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function withRebillConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'rebill_%'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%'")
    await setAppConfig('rebill_enabled', '1')
    await setAppConfig('rebill_mode', 'test')
    await setAppConfig('rebill_default_currency', 'MXN')
    await setAppConfig('rebill_mode_connections', JSON.stringify({
      test: {
        mode: 'test',
        accountLabel: 'Rebill Test',
        publicKey: 'pk_test_1234567890abcdef',
        secretKey: 'sk_test_1234567890abcdef',
        webhookId: '',
        webhookUrl: '',
        webhookConfigured: false,
        webhookStatus: '',
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      live: null
    }))
    return await callback()
  } finally {
    setRebillFetchForTest(null)
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

function jsonTextResponse(payload, status = 200) {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    }
  }
}

test('suscripciones: dos filas del mismo contacto conservan identidad independiente', async () => {
  const suffix = uniqueSuffix()
  const contactId = `contact_${suffix}`
  const phone = '+5215557778899'
  const email = `${contactId}@example.test`
  const subscriptionIds = []

  await cleanup({ contactId })

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente con varias suscripciones', email, phone]
    )

    const first = await createSubscription({
      contactId,
      name: 'Membresia principal',
      amount: 1000,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    const second = await createSubscription({
      contactId,
      name: 'Soporte adicional',
      amount: 500,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'manual',
      paymentProvider: 'manual'
    })
    subscriptionIds.push(first.id, second.id)

    const result = await listSubscriptions()
    const createdRows = result.subscriptions
      .filter((subscription) => subscriptionIds.includes(subscription.id))
      .sort((left, right) => left.name.localeCompare(right.name))

    assert.equal(createdRows.length, 2)
    assert.deepEqual(createdRows.map((subscription) => subscription.contactId), [contactId, contactId])
    assert.notEqual(createdRows[0].id, createdRows[1].id)
    assert.deepEqual(createdRows.map((subscription) => subscription.name), ['Membresia principal', 'Soporte adicional'])
  } finally {
    await cleanup({ contactId, subscriptionIds })
  }
})

test('suscripciones: CLIP no se puede usar como pasarela recurrente', async () => {
  await assert.rejects(
    () => createSubscription({
      name: 'Suscripción CLIP no soportada',
      amount: 1000,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'clip_link',
      paymentProvider: 'clip'
    }),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /CLIP solo está disponible para pagos únicos/)
      return true
    }
  )

  await assert.rejects(
    () => createSubscription({
      name: 'Suscripción con método CLIP disfrazado',
      amount: 1000,
      intervalType: 'monthly',
      intervalCount: 1,
      startDate: '2099-01-01',
      nextRunAt: '2099-01-01',
      paymentMethod: 'clip_payment_link',
      paymentProvider: 'stripe'
    }),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /CLIP solo está disponible para pagos únicos/)
      return true
    }
  )
})

test('suscripciones: Rebill crea plan y checkout hospedado para autorizar la suscripción', async () => {
  const suffix = uniqueSuffix('rebill_subscription')
  const contactId = `contact_${suffix}`
  const subscriptionIds = []

  await cleanup({ contactId })

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Raul', `${contactId}@example.test`, '+5216567426612']
    )

    await withRebillConfig(async () => {
      const calls = []
      setRebillFetchForTest(async (url, options = {}) => {
        const parsed = new URL(url)
        const method = options.method || 'GET'
        const body = options.body ? JSON.parse(String(options.body)) : null
        calls.push({ method, path: parsed.pathname, body })

        if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
          return jsonTextResponse({ records: [] })
        }

        if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
          assert.deepEqual(body.events, ['payment.created', 'payment.updated', 'subscription.created', 'subscription.updated'])
          return jsonTextResponse({ id: 'wh_rebill_subscriptions', url: body.url, events: body.events, active: true }, 201)
        }

        if (parsed.pathname === '/v3/plans' && method === 'POST') {
          assert.equal(body.frequency.period, 'month')
          assert.equal(body.frequency.count, 1)
          assert.deepEqual(body.prices, [{ amount: 1200, currency: 'MXN', isDefault: true }])
          assert.equal(body.metadata.contactId, contactId)
          assert.ok(body.metadata.ristakSubscriptionId)
          return jsonTextResponse({
            id: 'pln_rebill_test',
            status: 'active',
            frequency: body.frequency,
            prices: body.prices,
            metadata: body.metadata
          }, 201)
        }

        if (parsed.pathname === '/v3/payment-links' && method === 'POST') {
          assert.equal(body.type, undefined)
          assert.equal(body.plan, 'pln_rebill_test')
          assert.deepEqual(body.paymentMethods, [{ methods: ['card'], currency: 'MXN' }])
          assert.equal(body.showCoupon, false)
          assert.equal(body.metadata.rebillPlanId, 'pln_rebill_test')
          assert.equal(body.prefilledFields.customer.email, `${contactId}@example.test`)
          assert.equal(body.prefilledFields.customer.fullName, 'Raul Ristak')
          assert.equal(body.prefilledFields.customer.phoneNumber, '6567426612')
          assert.equal(body.prefilledFields.customer.countryCode, '+52')
          return jsonTextResponse({
            id: 'pl_rebill_subscription_test',
            url: 'https://pay.rebill.com/ristak/test_pl_rebill_subscription_test',
            status: 'active',
            type: 'plan',
            metadata: body.metadata
          }, 201)
        }

        return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
      })

      const created = await createSubscription({
        contactId,
        name: 'Membresia Rebill',
        amount: 1200,
        intervalType: 'monthly',
        intervalCount: 1,
        startDate: '2099-01-01',
        paymentMethod: 'rebill_subscription',
        paymentProvider: 'rebill',
        baseUrl: 'https://app.example.test'
      })
      subscriptionIds.push(created.id)

      assert.equal(created.paymentProvider, 'rebill')
      assert.equal(created.paymentMethod, 'rebill_subscription')
      assert.equal(created.status, 'incomplete')
      assert.equal(created.rebillPlanId, 'pln_rebill_test')
      assert.equal(created.rebillPaymentLinkId, 'pl_rebill_subscription_test')
      assert.equal(created.subscriptionStartUrl, 'https://pay.rebill.com/ristak/test_pl_rebill_subscription_test')

      const startPayment = await db.get(
        `SELECT payment_method, payment_provider, reference, metadata_json
         FROM payments
         WHERE metadata_json LIKE ?
         LIMIT 1`,
        [`%${created.id}%`]
      )
      assert.equal(startPayment.payment_method, 'rebill_subscription')
      assert.equal(startPayment.payment_provider, 'rebill')
      assert.equal(startPayment.reference, 'pl_rebill_subscription_test')
      assert.ok(calls.some((call) => call.path === '/v3/plans'))
      assert.ok(calls.some((call) => call.path === '/v3/payment-links'))
    })
  } finally {
    await cleanup({ contactId, subscriptionIds })
  }
})

test('frontend: apiClient no deduplica payloads completos por telefono o email', () => {
  const frontendSrcPath = fileURLToPath(new URL('../../frontend/src', import.meta.url))
  const contactDedupPath = fileURLToPath(new URL('../../frontend/src/utils/contactDedup.ts', import.meta.url))
  const apiClientSource = readFileSync(
    fileURLToPath(new URL('../../frontend/src/services/apiClient.ts', import.meta.url)),
    'utf8'
  )

  function readFrontendSources(dir) {
    const sources = []
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`
      const stats = statSync(path)
      if (stats.isDirectory()) {
        sources.push(...readFrontendSources(path))
        continue
      }
      if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        sources.push(readFileSync(path, 'utf8'))
      }
    }
    return sources
  }

  assert.doesNotMatch(apiClientSource, /dedupeContactsPayload/)
  assert.equal(existsSync(contactDedupPath), false)
  assert.equal(readFrontendSources(frontendSrcPath).some((source) => /contactDedup/.test(source)), false)
})
