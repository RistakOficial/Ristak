import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createConversationalAgentLivePaymentLink,
  setConversationalAgentLivePaymentDependenciesForTests
} from '../src/services/conversationalAgentLivePaymentService.js'
import {
  conversationalPaymentRequestHash,
  recoverProcessingConversationalPaymentRequest,
  runIdempotentConversationalPaymentLinkCreation
} from '../src/services/paymentFlowService.js'
import { normalizePaymentGateConfig } from '../src/services/publicPaymentGateService.js'
import { recoverPendingConversationalPaymentSourceBindings } from '../src/services/conversationalAgentService.js'

function key() {
  return `conv-v2-payment:${createHash('sha256').update(randomUUID()).digest('hex')}`
}

function liveLedger(overrides = {}) {
  return {
    id: 'payment-canonical',
    contact_id: 'contact-live',
    amount: 1200,
    currency: 'MXN',
    status: 'sent',
    payment_mode: 'live',
    payment_provider: 'conekta',
    ghl_invoice_id: null,
    public_payment_id: 'public-canonical',
    payment_url: 'https://app.example/pay/public-canonical',
    payment_link_request_key: overrides.payment_link_request_key,
    due_date: overrides.due_date,
    sent_at: new Date().toISOString(),
    ...overrides
  }
}

test('el cobro live usa exactamente la pasarela elegida y devuelve sólo la URL canónica del ledger', async () => {
  const idempotencyKey = key()
  const now = Date.parse('2026-07-12T18:00:00.000Z')
  const expectedExpiration = '2026-07-12T19:00:00.000Z'
  let capturedConfig = null
  let capturedOptions = null
  let providerCalls = 0

  setConversationalAgentLivePaymentDependenciesForTests({
    getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
    normalizePaymentGateConfig,
    runIdempotentConversationalPaymentLinkCreation: async ({ create }) => create(),
    createPaymentGateLink: async (config, options) => {
      providerCalls += 1
      capturedConfig = config
      capturedOptions = options
      return {
        publicPaymentId: 'public-canonical',
        paymentUrl: 'https://provider.example/NO-DEBE-SALIR',
        payment: {
          id: 'payment-canonical',
          publicPaymentId: 'public-canonical',
          amount: 1200,
          currency: 'MXN',
          paymentMode: 'live'
        }
      }
    },
    loadExactPaymentLedger: async () => liveLedger({
      payment_link_request_key: idempotencyKey,
      due_date: expectedExpiration
    })
  })

  try {
    const result = await createConversationalAgentLivePaymentLink({
      contact: { id: 'contact-live', name: 'Paty' },
      gateway: 'conekta',
      amount: 1200,
      currency: 'MXN',
      concept: 'Consulta inicial',
      installments: { enabled: true, maxInstallments: 6 },
      expirationMinutes: 60,
      afterPayment: 'handoff',
      idempotencyKey,
      idempotencyPayload: { agentId: 'agent-live', executionId: 'message-live' },
      now
    })

    assert.equal(providerCalls, 1)
    assert.equal(capturedConfig.gateway, 'conekta')
    assert.deepEqual(capturedConfig.msi, { enabled: true, maxInstallments: 6 })
    assert.equal(capturedOptions.paymentLinkRequestKey, idempotencyKey)
    assert.equal(capturedOptions.expiresAt, expectedExpiration)
    assert.equal(capturedOptions.applyTax, false)
    assert.equal(result.provider, 'conekta')
    assert.equal(result.paymentMode, 'live')
    assert.equal(result.paymentLink, 'https://app.example/pay/public-canonical')
    assert.equal(result.afterPayment, 'handoff')
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('el runtime live falla cerrado antes de crear si la pasarela está en sandbox', async () => {
  let providerCalls = 0
  setConversationalAgentLivePaymentDependenciesForTests({
    getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'test' }),
    createPaymentGateLink: async () => {
      providerCalls += 1
      return {}
    }
  })

  try {
    await assert.rejects(
      createConversationalAgentLivePaymentLink({
        contact: { id: 'contact-live' },
        gateway: 'stripe',
        amount: 500,
        currency: 'MXN',
        expirationMinutes: 60,
        idempotencyKey: key()
      }),
      (error) => error?.code === 'live_payment_gateway_not_live'
    )
    assert.equal(providerCalls, 0)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('rechaza antes del proveedor un monto que REAL perdería en PostgreSQL', async () => {
  let providerCalls = 0
  setConversationalAgentLivePaymentDependenciesForTests({
    getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
    createPaymentGateLink: async () => {
      providerCalls += 1
      return {}
    }
  })

  try {
    await assert.rejects(
      createConversationalAgentLivePaymentLink({
        contact: { id: 'contact-live' },
        gateway: 'stripe',
        amount: 999999.99,
        currency: 'MXN',
        expirationMinutes: 60,
        idempotencyKey: key()
      }),
      (error) => error?.code === 'live_payment_amount_precision_unsafe'
    )
    assert.equal(providerCalls, 0)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('el runtime no entrega un link si el ledger cambia provider o payment_mode', async () => {
  for (const ledgerOverride of [
    { payment_provider: 'stripe' },
    { payment_mode: 'test' }
  ]) {
    const idempotencyKey = key()
    const expiresAt = '2026-07-12T19:00:00.000Z'
    setConversationalAgentLivePaymentDependenciesForTests({
      getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
      normalizePaymentGateConfig,
      runIdempotentConversationalPaymentLinkCreation: async ({ create }) => create(),
      createPaymentGateLink: async () => ({
        publicPaymentId: 'public-canonical',
        payment: { id: 'payment-canonical', publicPaymentId: 'public-canonical', amount: 1200, currency: 'MXN', paymentMode: 'live' }
      }),
      loadExactPaymentLedger: async () => liveLedger({
        payment_link_request_key: idempotencyKey,
        due_date: expiresAt,
        ...ledgerOverride
      })
    })
    try {
      await assert.rejects(
        createConversationalAgentLivePaymentLink({
          contact: { id: 'contact-live' },
          gateway: 'conekta',
          amount: 1200,
          currency: 'MXN',
          expirationMinutes: 60,
          idempotencyKey,
          now: Date.parse('2026-07-12T18:00:00.000Z')
        }),
        (error) => error?.code === 'live_payment_ledger_mismatch'
      )
    } finally {
      setConversationalAgentLivePaymentDependenciesForTests(null)
    }
  }
})

test('recovery tras crash usa public_payment_id y no vuelve a llamar al proveedor', async () => {
  const suffix = randomUUID()
  const contactId = `contact_live_recovery_${suffix}`
  const paymentId = `payment_live_recovery_${suffix}`
  const publicPaymentId = `public_live_recovery_${suffix}`
  const idempotencyKey = key()
  const paymentUrl = `https://app.example/pay/${publicPaymentId}`
  const request = {
    agentId: 'agent-live-recovery',
    contactId,
    executionId: `message_${suffix}`,
    gateway: 'stripe',
    amount: 875,
    currency: 'MXN',
    paymentPurpose: 'purchase',
    expiresAt: '2026-07-13T18:00:00.000Z'
  }
  const requestHash = conversationalPaymentRequestHash(request)
  const now = new Date().toISOString()

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
       VALUES (?, 'Recovery live', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_payment_link_requests (
         idempotency_key, request_hash, request_json, contact_id, status,
         binding_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'processing', 'pending', ?, ?)`,
      [idempotencyKey, requestHash, JSON.stringify(request), contactId, now, now]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, reference, title, description, date, due_date, sent_at,
         public_payment_id, payment_url, payment_link_request_key, created_at, updated_at
       ) VALUES (?, ?, 875, 'MXN', 'sent', 'stripe', 'live', 'stripe', ?, 'Pago',
                 'Pago', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, publicPaymentId, now, request.expiresAt, now, publicPaymentId, paymentUrl, idempotencyKey]
    )
    const row = await db.get(
      'SELECT * FROM conversational_payment_link_requests WHERE idempotency_key = ?',
      [idempotencyKey]
    )
    const recovered = await recoverProcessingConversationalPaymentRequest(db, row, requestHash)
    assert.equal(recovered.provider, 'stripe')
    assert.equal(recovered.publicPaymentId, publicPaymentId)
    assert.equal(recovered.paymentLink, paymentUrl)
    assert.equal(recovered.paymentMode, 'live')

    let providerCalls = 0
    const replay = await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload: request,
      create: async () => {
        providerCalls += 1
        return { paymentLink: 'https://duplicate.invalid' }
      }
    })
    assert.equal(providerCalls, 0)
    assert.equal(replay.paymentLink, paymentUrl)
    assert.equal(replay.durableReplay, true)

    const binding = await recoverPendingConversationalPaymentSourceBindings({
      contactId,
      invoiceId: publicPaymentId,
      reconcilePaid: false
    })
    assert.equal(binding.bound, 1)
    const storedRequest = await db.get(
      'SELECT binding_status, binding_event_id FROM conversational_payment_link_requests WHERE idempotency_key = ?',
      [idempotencyKey]
    )
    assert.equal(storedRequest.binding_status, 'bound')
    assert.ok(storedRequest.binding_event_id)
  } finally {
    await db.run(
      `DELETE FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('payment_link_created', 'payment_link_reused')`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_payment_link_requests WHERE idempotency_key = ?', [idempotencyKey]).catch(() => {})
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
