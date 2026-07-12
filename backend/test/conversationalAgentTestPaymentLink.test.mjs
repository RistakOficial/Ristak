import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { db, setAppConfig } from '../src/config/database.js'
import {
  cleanupDueConversationalAgentTestPaymentLinks,
  createConversationalAgentTestPaymentLink,
  setConversationalAgentTestPaymentDependenciesForTests,
  syncConversationalAgentTestPaymentLink
} from '../src/services/conversationalAgentTestPaymentService.js'
import {
  handleMercadoPagoWebhookEvent,
  setMercadoPagoFetchForTest
} from '../src/services/mercadoPagoPaymentService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

const migrationSql = readFileSync(
  new URL('../migrations/versioned/034_conversational_agent_test_payment_links.sql', import.meta.url),
  'utf8'
)

async function ensureTestPaymentSchema() {
  await db.exec(migrationSql)
}

async function seedTestEffect(label) {
  const suffix = `${label}_${randomUUID()}`
  const ids = {
    username: `conv_test_pay_${suffix}`,
    userId: '',
    contactId: `contact_${suffix}`,
    agentId: `agent_${suffix}`,
    runId: `session_${suffix}`,
    effectId: `catfx_${suffix}`,
    messageId: `message_${suffix}`
  }
  await db.run(
    `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
     VALUES (?, 'test-hash', 'Tester de pagos', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.username]
  )
  ids.userId = String((await db.get('SELECT id FROM users WHERE username = ?', [ids.username])).id)
  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, 'Contacto sandbox', 'sandbox@example.test', '+5215550009988', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.contactId]
  )
  await db.run(
    `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente pago sandbox', 1, 'tool_calling_v2', '{}')`,
    [ids.agentId]
  )
  await db.run(
    `INSERT INTO conversational_agent_test_runs (
       id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [
      ids.runId,
      ids.agentId,
      ids.userId,
      ids.contactId,
      JSON.stringify({ enabled: true, collectPayment: true }),
      new Date(Date.now() + 60 * 60 * 1000).toISOString()
    ]
  )
  await db.run(
    `INSERT INTO conversational_agent_test_effects (
       id, run_id, message_id, effect_type, request_hash, status, payload_json
     ) VALUES (?, ?, ?, 'payment', 'seed', 'processing', '{}')`,
    [ids.effectId, ids.runId, ids.messageId]
  )
  return ids
}

async function cleanupSeed(ids = {}) {
  if (ids.effectId) {
    await db.run('DELETE FROM conversational_agent_test_payment_links WHERE effect_id = ?', [ids.effectId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [ids.effectId]).catch(() => undefined)
  }
  if (ids.runId) await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [ids.runId]).catch(() => undefined)
  if (ids.agentId) await db.run('DELETE FROM conversational_agents WHERE id = ?', [ids.agentId]).catch(() => undefined)
  if (ids.contactId) {
    await db.run('DELETE FROM payments WHERE contact_id = ? OR metadata_json LIKE ?', [ids.contactId, `%${ids.effectId || ''}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
  }
  if (ids.username) await db.run('DELETE FROM users WHERE username = ?', [ids.username]).catch(() => undefined)
}

test('el tester fuerza sandbox, deduplica por efecto, reconoce paid y elimina evidencia financiera a los cinco minutos', async () => {
  await ensureTestPaymentSchema()
  const ids = await seedTestEffect('forced')
  const createdAt = Date.parse('2026-07-11T18:00:00.000Z')
  let factoryCalls = 0

  setConversationalAgentTestPaymentDependenciesForTests({
    createPaymentGateLink: async (config, options) => {
      factoryCalls += 1
      assert.equal(config.mode, 'test')
      assert.equal(options.forceTestMode, true)
      assert.equal(options.applyTax, false)
      assert.equal(options.source, 'conversational_agent_test')
      assert.equal(options.metadata.suppressProductionEffects, true)
      const paymentId = `stripe_test_${randomUUID()}`
      const publicPaymentId = `public_test_${randomUUID()}`
      const url = `https://app.example.test/pay/${publicPaymentId}`
      await db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_method, payment_mode,
           payment_provider, public_payment_id, payment_url, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'sent', 'stripe', 'test', 'stripe', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          paymentId,
          ids.contactId,
          config.amount,
          config.currency,
          publicPaymentId,
          url,
          JSON.stringify(options.metadata)
        ]
      )
      return { payment: { id: paymentId }, publicPaymentId, paymentUrl: url }
    }
  })

  try {
    const input = {
      effectId: ids.effectId,
      testRunId: ids.runId,
      agentId: ids.agentId,
      requestedByUserId: ids.userId,
      contact: {
        id: ids.contactId,
        name: 'Contacto sandbox',
        email: 'sandbox@example.test',
        phone: '+5215550009988'
      },
      paymentGateConfig: {
        gateway: 'stripe',
        billingType: 'single',
        amount: 1200,
        currency: 'MXN',
        productName: 'Consulta de prueba'
      },
      baseUrl: 'https://app.example.test',
      now: createdAt
    }
    const created = await createConversationalAgentTestPaymentLink(input)
    assert.equal(created.status, 'ready')
    assert.equal(created.paymentMode, 'test')
    assert.equal(created.amount, 1200)
    assert.equal(created.currency, 'MXN')
    assert.equal(created.provider, 'stripe')
    assert.match(created.url, /^https:\/\/app\.example\.test\/pay\//)
    assert.equal(created.cleanupDueAt, '2026-07-11T18:05:00.000Z')

    const replay = await createConversationalAgentTestPaymentLink(input)
    assert.equal(replay.paymentId, created.paymentId)
    assert.equal(factoryCalls, 1)

    await db.run(
      `UPDATE conversational_agent_test_effects SET status = 'prepared' WHERE id = ?`,
      [ids.effectId]
    )
    await db.run(
      `UPDATE payments
       SET status = 'paid', paid_at = '2026-07-11T18:01:00.000Z', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [created.paymentId]
    )
    const paid = await syncConversationalAgentTestPaymentLink({
      effectId: ids.effectId,
      requestedByUserId: ids.userId
    })
    assert.equal(paid.status, 'paid_test')
    assert.equal(paid.paid, true)
    assert.equal((await db.get('SELECT status FROM conversational_agent_test_effects WHERE id = ?', [ids.effectId])).status, 'paid_test')

    const cleanup = await cleanupDueConversationalAgentTestPaymentLinks({
      now: Date.parse('2026-07-11T18:05:01.000Z')
    })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [created.paymentId]), null)
    const ledger = await db.get(
      'SELECT status, payment_url, cleaned_at FROM conversational_agent_test_payment_links WHERE effect_id = ?',
      [ids.effectId]
    )
    assert.equal(ledger.status, 'cleaned')
    assert.equal(ledger.payment_url, null)
    assert.ok(ledger.cleaned_at)
    assert.equal((await db.get('SELECT status FROM conversational_agent_test_effects WHERE id = ?', [ids.effectId])).status, 'cleaned')
  } finally {
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await cleanupSeed(ids)
  }
})

test('la limpieza recupera por índice un pago creado antes de que el proceso ligara payment_id al ledger', async () => {
  await ensureTestPaymentSchema()
  const ids = await seedTestEffect('crash_recovery')
  const createdAt = Date.parse('2026-07-11T20:00:00.000Z')
  const cleanupDueAt = new Date(createdAt + 5 * 60 * 1000).toISOString()
  const paymentId = `stripe_crash_${randomUUID()}`
  const publicPaymentId = `public_crash_${randomUUID()}`

  try {
    await db.run(
      `INSERT INTO conversational_agent_test_payment_links (
         effect_id, test_run_id, agent_id, requested_by_user_id, request_hash,
         status, payment_mode, cleanup_due_at, metadata_json
       ) VALUES (?, ?, ?, ?, 'crash-window', 'creating', 'test', ?, ?)`,
      [
        ids.effectId,
        ids.runId,
        ids.agentId,
        ids.userId,
        cleanupDueAt,
        JSON.stringify({ testRunId: ids.runId, testEffectId: ids.effectId })
      ]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, public_payment_id, payment_url,
         conversational_test_effect_id, metadata_json, created_at, updated_at
       ) VALUES (?, ?, 850.25, 'MXN', 'sent', 'stripe', 'test', 'stripe', ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        ids.contactId,
        publicPaymentId,
        `https://app.example.test/pay/${publicPaymentId}`,
        ids.effectId,
        // Simula metadata dañada tras el crash: la columna indexada sigue siendo
        // autoridad suficiente para localizar el artefacto sandbox exacto.
        JSON.stringify({ paymentMode: 'test', suppressProductionEffects: true }),
        new Date(createdAt).toISOString(),
        new Date(createdAt).toISOString()
      ]
    )
    await assert.rejects(
      db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_mode, payment_provider,
           conversational_test_effect_id, metadata_json
         ) VALUES (?, ?, 850.25, 'MXN', 'sent', 'test', 'stripe', ?, ?)`,
        [
          `stripe_duplicate_${randomUUID()}`,
          ids.contactId,
          ids.effectId,
          JSON.stringify({ conversationalAgentTest: { testRunId: ids.runId, testEffectId: ids.effectId } })
        ]
      ),
      /unique/i
    )

    const cleanup = await cleanupDueConversationalAgentTestPaymentLinks({
      now: createdAt + 5 * 60 * 1000 + 1
    })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [paymentId]), null)
    const ledger = await db.get(
      'SELECT status, payment_id, invalidation_status FROM conversational_agent_test_payment_links WHERE effect_id = ?',
      [ids.effectId]
    )
    assert.equal(ledger.status, 'cleaned')
    assert.equal(ledger.payment_id, paymentId)
    assert.equal(ledger.invalidation_status, 'deleted')
  } finally {
    await cleanupSeed(ids)
  }
})

test('Mercado Pago usa credenciales test por fila aunque la pasarela activa esté live, expira la preferencia y procesa su webhook sandbox', async () => {
  await ensureTestPaymentSchema()
  await initializeMasterKey()
  const ids = await seedTestEffect('mercadopago')
  const previousConfig = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'"
  )
  const preferenceBodies = []
  const expiredPreferences = []
  let localPaymentId = ''
  const baseNow = Date.now()
  const cleanupDueAt = new Date(baseNow + 5 * 60 * 1000).toISOString()

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'")
    await savePaymentSettings({ paymentMode: 'live' })
    await setAppConfig('mercadopago_enabled', '1')
    await setAppConfig('mercadopago_mode', 'live')
    await setAppConfig('mercadopago_default_currency', 'MXN')
    await setAppConfig('mercadopago_mode_connections', JSON.stringify({
      test: {
        mode: 'test',
        accountLabel: 'MP sandbox',
        userId: 'mp_test_user',
        publicKey: 'TEST-public-key',
        livemode: false,
        accessToken: encrypt('TEST-agent-access-token'),
        connectedAt: new Date().toISOString()
      },
      live: {
        mode: 'live',
        accountLabel: 'MP live',
        userId: 'mp_live_user',
        publicKey: 'APP_USR-live-public-key',
        livemode: true,
        accessToken: encrypt('APP_USR-live-access-token'),
        connectedAt: new Date().toISOString()
      }
    }))

    setMercadoPagoFetchForTest(async (url, options = {}) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && options.method === 'POST') {
        assert.equal(options.headers.Authorization, 'Bearer TEST-agent-access-token')
        const body = JSON.parse(String(options.body || '{}'))
        preferenceBodies.push(body)
        assert.equal(body.expires, true)
        assert.equal(body.expiration_date_to, cleanupDueAt)
        localPaymentId = body.external_reference
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'pref_agent_test_1',
            init_point: 'https://mercadopago.example/live-should-not-win',
            sandbox_init_point: 'https://sandbox.mercadopago.example/pref_agent_test_1'
          })
        }
      }
      if (url === 'https://api.mercadopago.com/v1/payments/mp_agent_test_paid' && options.method === 'GET') {
        assert.equal(options.headers.Authorization, 'Bearer TEST-agent-access-token')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'mp_agent_test_paid',
            status: 'approved',
            status_detail: 'accredited',
            live_mode: false,
            transaction_amount: 800,
            currency_id: 'MXN',
            external_reference: localPaymentId,
            preference_id: 'pref_agent_test_1',
            date_approved: new Date(baseNow + 60 * 1000).toISOString()
          })
        }
      }
      if (url === 'https://api.mercadopago.com/checkout/preferences/pref_agent_test_1' && options.method === 'PUT') {
        assert.equal(options.headers.Authorization, 'Bearer TEST-agent-access-token')
        expiredPreferences.push(JSON.parse(String(options.body || '{}')))
        return { ok: true, status: 200, json: async () => ({ id: 'pref_agent_test_1' }) }
      }
      throw new Error(`Llamada inesperada: ${options.method} ${url}`)
    })

    const created = await createConversationalAgentTestPaymentLink({
      effectId: ids.effectId,
      testRunId: ids.runId,
      agentId: ids.agentId,
      requestedByUserId: ids.userId,
      contact: {
        id: ids.contactId,
        name: 'Contacto sandbox',
        email: 'sandbox@example.test',
        phone: '+5215550009988'
      },
      paymentGateConfig: {
        gateway: 'mercadopago',
        billingType: 'single',
        amount: 800,
        currency: 'MXN',
        productName: 'Sesión sandbox'
      },
      baseUrl: 'https://app.example.test',
      now: baseNow
    })
    assert.equal(created.provider, 'mercadopago')
    assert.equal(created.paymentMode, 'test')
    assert.equal(preferenceBodies.length, 1)
    assert.equal((await db.get('SELECT payment_mode FROM payments WHERE id = ?', [created.paymentId])).payment_mode, 'test')

    const webhook = await handleMercadoPagoWebhookEvent({
      type: 'payment',
      live_mode: false,
      data: { id: 'mp_agent_test_paid' }
    }, {}, {})
    assert.equal(webhook.paymentId, created.paymentId)
    assert.equal(webhook.status, 'paid')
    const synced = await syncConversationalAgentTestPaymentLink({ effectId: ids.effectId })
    assert.equal(synced.status, 'paid_test')

    const cleanup = await cleanupDueConversationalAgentTestPaymentLinks({
      now: baseNow + 5 * 60 * 1000 + 1000
    })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(expiredPreferences.length, 1)
    assert.equal(expiredPreferences[0].expires, true)
    assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [created.paymentId]), null)
  } finally {
    setMercadoPagoFetchForTest(null)
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'").catch(() => undefined)
    for (const row of previousConfig) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP`,
        [row.config_key, row.config_value]
      ).catch(() => undefined)
    }
    await cleanupSeed(ids)
  }
})

test('si Mercado Pago no confirma la expiración, conserva IDs y reintenta sin declarar cleaned', async () => {
  await ensureTestPaymentSchema()
  const ids = await seedTestEffect('mercadopago_cleanup_retry')
  const paymentId = `mp_retry_${randomUUID()}`
  const publicPaymentId = `mp_retry_public_${randomUUID()}`
  const cleanupDueAt = new Date(Date.now() - 1_000).toISOString()
  let expirationAttempts = 0

  try {
    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, public_payment_id, payment_url, mercadopago_preference_id,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, 725, 'MXN', 'sent', 'mercadopago', 'test',
        'mercadopago', ?, ?, 'pref_retry_test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      paymentId,
      ids.contactId,
      publicPaymentId,
      `https://sandbox.mercadopago.example/${publicPaymentId}`,
      JSON.stringify({
        paymentMode: 'test',
        suppressProductionEffects: true,
        conversationalAgentTest: { testRunId: ids.runId, testEffectId: ids.effectId }
      })
    ])
    await db.run(`
      INSERT INTO conversational_agent_test_payment_links (
        effect_id, test_run_id, agent_id, requested_by_user_id, request_hash,
        status, payment_id, public_payment_id, provider, amount, currency,
        payment_mode, payment_url, cleanup_due_at, metadata_json
      ) VALUES (?, ?, ?, ?, 'retry-expiration', 'ready', ?, ?, 'mercadopago',
        725, 'MXN', 'test', ?, ?, ?)
    `, [
      ids.effectId,
      ids.runId,
      ids.agentId,
      ids.userId,
      paymentId,
      publicPaymentId,
      `https://sandbox.mercadopago.example/${publicPaymentId}`,
      cleanupDueAt,
      JSON.stringify({ testRunId: ids.runId, testEffectId: ids.effectId })
    ])
    await db.run("UPDATE conversational_agent_test_effects SET status = 'prepared' WHERE id = ?", [ids.effectId])

    setConversationalAgentTestPaymentDependenciesForTests({
      expireMercadoPagoTestPreference: async () => {
        expirationAttempts += 1
        throw new Error('Mercado Pago temporalmente no disponible')
      }
    })
    const first = await cleanupDueConversationalAgentTestPaymentLinks({ now: Date.now() })
    assert.equal(first.cleaned, 0)
    assert.equal(first.failed, 1)
    assert.equal(expirationAttempts, 1)
    const pendingPayment = await db.get(
      'SELECT status, payment_url, mercadopago_preference_id FROM payments WHERE id = ?',
      [paymentId]
    )
    assert.equal(pendingPayment.status, 'deleted')
    assert.equal(pendingPayment.payment_url, null)
    assert.equal(pendingPayment.mercadopago_preference_id, 'pref_retry_test')
    const pendingLedger = await db.get(`
      SELECT status, payment_id, invalidation_status, invalidation_error
      FROM conversational_agent_test_payment_links WHERE effect_id = ?
    `, [ids.effectId])
    assert.equal(pendingLedger.status, 'cleanup_failed')
    assert.equal(pendingLedger.payment_id, paymentId)
    assert.equal(pendingLedger.invalidation_status, 'provider_expiration_failed')
    assert.match(pendingLedger.invalidation_error, /temporalmente no disponible/i)

    setConversationalAgentTestPaymentDependenciesForTests({
      expireMercadoPagoTestPreference: async () => {
        expirationAttempts += 1
        return { expired: true }
      }
    })
    const second = await cleanupDueConversationalAgentTestPaymentLinks({ now: Date.now() + 1_000 })
    assert.equal(second.cleaned, 1)
    assert.equal(second.failed, 0)
    assert.equal(expirationAttempts, 2)
    assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [paymentId]), null)
    assert.equal(
      (await db.get('SELECT status FROM conversational_agent_test_payment_links WHERE effect_id = ?', [ids.effectId])).status,
      'cleaned'
    )
  } finally {
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await cleanupSeed(ids)
  }
})

test('si una pasarela ignora el override y devuelve live, el tester no entrega el link y apaga el checkout local', async () => {
  await ensureTestPaymentSchema()
  const ids = await seedTestEffect('live_block')
  let unsafePaymentId = ''

  setConversationalAgentTestPaymentDependenciesForTests({
    createPaymentGateLink: async (config, options) => {
      unsafePaymentId = `unsafe_live_${randomUUID()}`
      const publicPaymentId = `unsafe_public_${randomUUID()}`
      await db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_method, payment_mode,
           payment_provider, public_payment_id, payment_url, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'sent', 'stripe', 'live', 'stripe', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          unsafePaymentId,
          ids.contactId,
          config.amount,
          config.currency,
          publicPaymentId,
          `https://app.example.test/pay/${publicPaymentId}`,
          JSON.stringify(options.metadata)
        ]
      )
      return {
        payment: { id: unsafePaymentId },
        publicPaymentId,
        paymentUrl: `https://app.example.test/pay/${publicPaymentId}`
      }
    }
  })

  try {
    await assert.rejects(
      createConversationalAgentTestPaymentLink({
        effectId: ids.effectId,
        testRunId: ids.runId,
        agentId: ids.agentId,
        requestedByUserId: ids.userId,
        contact: { id: ids.contactId },
        paymentGateConfig: {
          gateway: 'stripe',
          billingType: 'single',
          amount: 50,
          currency: 'MXN',
          productName: 'Nunca live'
        },
        baseUrl: 'https://app.example.test'
      }),
      (error) => error?.code === 'test_payment_live_mode_blocked'
    )
    const unsafe = await db.get('SELECT status, payment_url FROM payments WHERE id = ?', [unsafePaymentId])
    assert.equal(unsafe.status, 'deleted')
    assert.equal(unsafe.payment_url, null)
    const ledger = await db.get(
      'SELECT status, payment_url, invalidation_status FROM conversational_agent_test_payment_links WHERE effect_id = ?',
      [ids.effectId]
    )
    assert.equal(ledger.status, 'failed')
    assert.equal(ledger.payment_url, null)
    assert.equal(ledger.invalidation_status, 'local_checkout_blocked')
  } finally {
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await cleanupSeed(ids)
  }
})
