import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  __conversationalAgentLivePaymentTestHooks,
  createConversationalAgentLivePaymentLink,
  setConversationalAgentLivePaymentDependenciesForTests
} from '../src/services/conversationalAgentLivePaymentService.js'
import {
  conversationalPaymentRequestHash,
  recoverProcessingConversationalPaymentRequest,
  runIdempotentConversationalPaymentLinkCreation
} from '../src/services/paymentFlowService.js'
import { normalizePaymentGateConfig } from '../src/services/publicPaymentGateService.js'
import {
  bindConversationalPaymentSourceEvent,
  recoverPendingConversationalPaymentSourceBindings
} from '../src/services/conversationalAgentService.js'

test.afterEach(async () => {
  await db.run('DELETE FROM conversational_payment_semantic_claims').catch(() => {})
})

function key() {
  return `conv-v2-payment:${createHash('sha256').update(randomUUID()).digest('hex')}`
}

function paymentIdentity(contactId, agentId = 'agent-live', executionId = `message-${randomUUID()}`) {
  return {
    agentId,
    contactId,
    executionId,
    productId: 'product-live',
    priceId: 'price-live',
    channel: 'whatsapp',
    paymentPurpose: 'purchase'
  }
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

test('una reserva semántica huérfana vence y otro inbound toma control con CAS antes del proveedor', async () => {
  const payload = {
    agentId: `agent-orphan-${randomUUID()}`,
    contactId: `contact-orphan-${randomUUID()}`,
    gateway: 'stripe',
    amount: 450,
    currency: 'MXN',
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    productId: 'product-orphan',
    priceId: 'price-orphan',
    installments: { enabled: false, maxInstallments: 0 }
  }
  const oldRequestKey = key()
  const nextRequestKey = key()
  const identity = __conversationalAgentLivePaymentTestHooks.semanticPaymentClaimIdentity(payload)
  const staleAt = new Date(Date.now() - 31_000).toISOString()
  await db.run(
    `INSERT INTO conversational_payment_semantic_claims (
       semantic_key, identity_hash, owner_request_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'processing', ?, ?)`,
    [identity.semanticKey, identity.identityHash, oldRequestKey, staleAt, staleAt]
  )

  const recovered = await __conversationalAgentLivePaymentTestHooks.reserveConversationalPaymentSemanticClaim({
    payload,
    requestKey: nextRequestKey,
    gateway: 'stripe'
  })
  assert.equal(recovered.owner, true)
  assert.equal(recovered.recoveredOrphan, true)
  const stored = await db.get(
    'SELECT owner_request_key, status FROM conversational_payment_semantic_claims WHERE semantic_key = ?',
    [identity.semanticKey]
  )
  assert.equal(stored.owner_request_key, nextRequestKey)
  assert.equal(stored.status, 'processing')
})

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
      idempotencyPayload: paymentIdentity('contact-live', 'agent-live', 'message-live'),
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
        idempotencyKey: key(),
        idempotencyPayload: paymentIdentity('contact-live')
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
  for (const [caseIndex, ledgerOverride] of [
    { payment_provider: 'stripe' },
    { payment_mode: 'test' }
  ].entries()) {
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
          idempotencyPayload: paymentIdentity('contact-live', `agent-ledger-mismatch-${caseIndex}`),
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

test('otro turno reutiliza el link live equivalente sin consultar ni llamar otra vez a la pasarela', async () => {
  const canonicalRequestKey = key()
  const currentRequestKey = key()
  let readinessCalls = 0
  let providerCalls = 0
  let aliasCalls = 0
  const reusable = {
    ledgerPaymentId: 'payment-reusable',
    invoiceId: 'public-reusable',
    publicPaymentId: 'public-reusable',
    paymentLink: 'https://app.example/pay/public-reusable',
    amount: 1200,
    currency: 'MXN',
    status: 'sent',
    provider: 'stripe',
    paymentMode: 'live',
    expiresAt: '2026-07-12T20:00:00.000Z',
    sendMethod: 'chat_reply',
    paymentConfirmed: false,
    reused: true,
    durableReplay: true,
    crossTurnReuse: true,
    canonicalPaymentLinkRequestKey: canonicalRequestKey,
    canonicalBindingEventId: 'event-reusable',
    expirationMinutes: 120,
    installments: { enabled: false, maxInstallments: 0 },
    afterPayment: 'continue'
  }

  setConversationalAgentLivePaymentDependenciesForTests({
    findReusableConversationalLivePaymentLink: async () => reusable,
    recordCrossTurnConversationalPaymentReuse: async ({ reusable: candidate }) => {
      aliasCalls += 1
      return candidate
    },
    getPaymentGateCheckoutKeys: async () => {
      readinessCalls += 1
      return { provider: 'stripe', configured: true, paymentMode: 'live' }
    },
    createPaymentGateLink: async () => {
      providerCalls += 1
      return {}
    }
  })

  try {
    const result = await createConversationalAgentLivePaymentLink({
      contact: { id: 'contact-reusable', name: 'Paty' },
      gateway: 'stripe',
      amount: 1200,
      currency: 'MXN',
      concept: 'Consulta inicial',
      expirationMinutes: 60,
      idempotencyKey: currentRequestKey,
      idempotencyPayload: {
        agentId: 'agent-reusable',
        contactId: 'contact-reusable',
        productId: 'product-reusable',
        priceId: 'price-reusable',
        channel: 'whatsapp',
        paymentPurpose: 'purchase',
        executionId: 'message-second-turn'
      },
      now: Date.parse('2026-07-12T18:00:00.000Z')
    })

    assert.equal(aliasCalls, 1)
    assert.equal(readinessCalls, 0)
    assert.equal(providerCalls, 0)
    assert.equal(result.crossTurnReuse, true)
    assert.equal(result.canonicalPaymentLinkRequestKey, canonicalRequestKey)
    assert.equal(result.paymentLink, reusable.paymentLink)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('dos turnos equivalentes concurrentes comparten claim semántico y sólo uno llama al proveedor', async () => {
  const suffix = randomUUID()
  const contactId = `contact-semantic-race-${suffix}`
  const agentId = `agent-semantic-race-${suffix}`
  const firstKey = key()
  const secondKey = key()
  const now = Date.now()
  let providerCalls = 0

  await db.run(
    `INSERT INTO contacts (id, full_name, created_at, updated_at)
     VALUES (?, 'Carrera semántica', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  setConversationalAgentLivePaymentDependenciesForTests({
    getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
    normalizePaymentGateConfig,
    createPaymentGateLink: async (config, options) => {
      providerCalls += 1
      const paymentId = `payment-semantic-race-${suffix}`
      const publicPaymentId = `public-semantic-race-${suffix}`
      const paymentUrl = `https://app.example/pay/${publicPaymentId}`
      await db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_mode, payment_provider,
           public_payment_id, payment_url, payment_link_request_key, due_date,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'sent', 'live', 'stripe', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, contactId, config.amount, config.currency, publicPaymentId, paymentUrl, options.paymentLinkRequestKey, options.expiresAt]
      )
      return {
        publicPaymentId,
        paymentUrl,
        payment: { id: paymentId, publicPaymentId, amount: config.amount, currency: config.currency, paymentMode: 'live' }
      }
    }
  })

  const invoke = (idempotencyKey, executionId) => createConversationalAgentLivePaymentLink({
    contact: { id: contactId, name: 'Paty' },
    gateway: 'stripe',
    amount: 1200,
    currency: 'MXN',
    concept: 'Consulta concurrente',
    expirationMinutes: 60,
    idempotencyKey,
    idempotencyPayload: {
      ...paymentIdentity(contactId, agentId, executionId),
      productId: `product-semantic-race-${suffix}`,
      priceId: `price-semantic-race-${suffix}`
    },
    now
  }).then(async (result) => {
    if (result.crossTurnReuse === true) return result
    const request = await db.get(
      `SELECT binding_event_id, request_json FROM conversational_payment_link_requests
       WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    const payload = JSON.parse(request.request_json)
    await bindConversationalPaymentSourceEvent({
      eventId: request.binding_event_id,
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId,
        ledgerPaymentId: result.ledgerPaymentId,
        invoiceId: result.invoiceId,
        amount: result.amount,
        currency: result.currency,
        channel: 'whatsapp',
        paymentMode: 'full_payment',
        runtimeMode: 'tool_calling_v2',
        paymentProvider: result.provider,
        paymentEnvironment: result.paymentMode,
        publicPaymentId: result.publicPaymentId,
        paymentPurpose: payload.paymentPurpose,
        afterPayment: payload.afterPayment,
        appointmentDeposit: false,
        executionId: payload.executionId,
        productId: payload.productId,
        priceId: payload.priceId
      }
    })
    return result
  })

  try {
    const [first, second] = await Promise.all([
      invoke(firstKey, `message-first-${suffix}`),
      invoke(secondKey, `message-second-${suffix}`)
    ])
    assert.equal(providerCalls, 1)
    assert.equal(first.paymentLink, second.paymentLink)
    assert.equal([first, second].filter((result) => result.crossTurnReuse === true).length, 1)
    const replay = await invoke(firstKey, `message-first-${suffix}`)
    assert.equal(replay.paymentLink, first.paymentLink)
    assert.equal(providerCalls, 1)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 1)
    const requests = await db.all(
      `SELECT binding_event_id, binding_status FROM conversational_payment_link_requests
       WHERE contact_id = ?`,
      [contactId]
    )
    assert.equal(requests.length, 2)
    assert.ok(requests.every((row) => row.binding_status === 'bound'))
    assert.equal(new Set(requests.map((row) => row.binding_event_id)).size, 1)
    const semanticClaim = await db.get(
      `SELECT status, canonical_request_key
       FROM conversational_payment_semantic_claims
       WHERE owner_request_key IN (?, ?)`,
      [firstKey, secondKey]
    )
    assert.equal(semanticClaim.status, 'bound')
    assert.ok([firstKey, secondKey].includes(semanticClaim.canonical_request_key))
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
    await db.run('DELETE FROM conversational_payment_semantic_claims WHERE owner_request_key IN (?, ?)', [firstKey, secondKey]).catch(() => {})
    await db.run('DELETE FROM conversational_payment_link_requests WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('reuseOnly corta antes de la pasarela cuando el link canónico ya no es reutilizable', async () => {
  let readinessCalls = 0
  let providerCalls = 0
  setConversationalAgentLivePaymentDependenciesForTests({
    findReusableConversationalLivePaymentLink: async () => null,
    getPaymentGateCheckoutKeys: async () => {
      readinessCalls += 1
      return { provider: 'stripe', configured: true, paymentMode: 'live' }
    },
    createPaymentGateLink: async () => {
      providerCalls += 1
      return {}
    }
  })

  try {
    await assert.rejects(
      createConversationalAgentLivePaymentLink({
        contact: { id: 'contact-reuse-only', name: 'Paty' },
        gateway: 'stripe',
        amount: 1200,
        currency: 'MXN',
        concept: 'Anticipo de cita',
        expirationMinutes: 60,
        idempotencyKey: key(),
        reuseOnly: true,
        idempotencyPayload: {
          agentId: 'agent-reuse-only',
          contactId: 'contact-reuse-only',
          productId: 'product-reuse-only',
          priceId: 'price-reuse-only',
          channel: 'whatsapp',
          paymentPurpose: 'appointment_deposit',
          appointmentSelectionEventId: 'selection-reuse-only',
          appointmentSelectionCalendarId: 'calendar-reuse-only',
          appointmentSelectionStartTime: '2026-07-20T18:00:00.000Z',
          appointmentSelectionRequestDraftHash: 'draft-reuse-only',
          appointmentSelectionBookingOwner: 'ai',
          appointmentSelectionTerminalToolName: 'book_appointment',
          appointmentDepositIntentEventId: 'intent-reuse-only'
        }
      }),
      (error) => error?.code === 'live_payment_reusable_link_not_found'
    )
    assert.equal(readinessCalls, 0)
    assert.equal(providerCalls, 0)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('un error buscando reuse falla cerrado y libera el claim sin llamar al proveedor', async () => {
  let providerCalls = 0
  setConversationalAgentLivePaymentDependenciesForTests({
    findReusableConversationalLivePaymentLink: async () => {
      throw Object.assign(new Error('lookup unavailable'), { code: 'lookup_unavailable' })
    },
    getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
    createPaymentGateLink: async () => {
      providerCalls += 1
      return {}
    }
  })
  try {
    await assert.rejects(
      createConversationalAgentLivePaymentLink({
        contact: { id: 'contact-lookup-failure' },
        gateway: 'stripe',
        amount: 500,
        currency: 'MXN',
        expirationMinutes: 60,
        idempotencyKey: key(),
        idempotencyPayload: paymentIdentity('contact-lookup-failure', 'agent-lookup-failure')
      }),
      (error) => error?.code === 'lookup_unavailable'
    )
    assert.equal(providerCalls, 0)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM conversational_payment_semantic_claims')).total), 0)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
  }
})

test('reuso cross-turn exige identidad financiera exacta y sólo admite links pendientes y vigentes', async () => {
  const suffix = randomUUID()
  const contactId = `contact_reusable_${suffix}`
  const agentId = `agent_reusable_${suffix}`
  const paymentId = `payment_reusable_${suffix}`
  const publicPaymentId = `public_reusable_${suffix}`
  const canonicalRequestKey = key()
  const aliasRequestKey = key()
  const canonicalBindingEventId = `event_reusable_${suffix}`
  const nowMs = Date.parse('2026-07-12T18:00:00.000Z')
  const expiresAt = '2026-07-12T20:00:00.000Z'
  const paymentUrl = `https://app.example/pay/${publicPaymentId}`
  const basePayload = {
    agentId,
    contactId,
    executionId: `message_first_${suffix}`,
    gateway: 'stripe',
    amount: 875,
    currency: 'MXN',
    concept: 'Consulta inicial',
    productId: `product_${suffix}`,
    priceId: `price_${suffix}`,
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    installments: { enabled: false, maxInstallments: 0 },
    expirationMinutes: 120,
    afterPayment: 'continue'
  }
  const eventDetail = {
    agentId,
    ledgerPaymentId: paymentId,
    invoiceId: publicPaymentId,
    amount: 875,
    currency: 'MXN',
    paymentProvider: 'stripe',
    paymentEnvironment: 'live',
    paymentPurpose: 'purchase',
    afterPayment: 'continue'
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
       VALUES (?, 'Link reusable', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_events (
         id, contact_id, agent_id, event_type, detail_json, created_at
       ) VALUES (?, ?, ?, 'payment_link_created', ?, CURRENT_TIMESTAMP)`,
      [canonicalBindingEventId, contactId, agentId, JSON.stringify(eventDetail)]
    )
    await db.run(
      `INSERT INTO conversational_payment_link_requests (
         idempotency_key, request_hash, request_json, contact_id, invoice_id,
         status, response_json, binding_event_id, binding_status, bound_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, 'bound', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        canonicalRequestKey,
        conversationalPaymentRequestHash(basePayload),
        JSON.stringify(basePayload),
        contactId,
        publicPaymentId,
        JSON.stringify({ invoiceId: publicPaymentId, paymentLink: paymentUrl }),
        canonicalBindingEventId
      ]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, reference, title, description, date, due_date, sent_at,
         public_payment_id, payment_url, payment_link_request_key, created_at, updated_at
       ) VALUES (?, ?, 875, 'MXN', 'sent', 'stripe', 'live', 'stripe', ?, 'Pago',
                 'Consulta inicial', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?, ?, ?,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, publicPaymentId, expiresAt, publicPaymentId, paymentUrl, canonicalRequestKey]
    )

    const currentPayload = { ...basePayload, executionId: `message_second_${suffix}` }
    const findReusable = (payload = currentPayload, overrides = {}) => (
      __conversationalAgentLivePaymentTestHooks.findReusableConversationalLivePaymentLink({
        contactId: overrides.contactId || payload.contactId,
        gateway: overrides.gateway || payload.gateway,
        idempotencyKey: overrides.idempotencyKey || aliasRequestKey,
        payload,
        now: nowMs
      })
    )
    const reusable = await findReusable()
    assert.ok(reusable)
    assert.equal(reusable.ledgerPaymentId, paymentId)
    assert.equal(reusable.paymentLink, paymentUrl)
    assert.equal(reusable.canonicalPaymentLinkRequestKey, canonicalRequestKey)
    assert.equal(reusable.canonicalBindingEventId, canonicalBindingEventId)
    assert.equal(reusable.afterPayment, 'continue')

    for (const mismatch of [
      { ...currentPayload, agentId: `other_${agentId}` },
      { ...currentPayload, productId: `other_product_${suffix}` },
      { ...currentPayload, amount: 876 },
      { ...currentPayload, currency: 'USD' },
      { ...currentPayload, gateway: 'conekta' },
      { ...currentPayload, channel: 'sms' },
      { ...currentPayload, afterPayment: 'handoff' }
    ]) {
      assert.equal(await findReusable(mismatch), null, JSON.stringify(mismatch))
    }
    assert.equal(await findReusable({ ...currentPayload, contactId: `other_${contactId}` }), null)

    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({ ...eventDetail, afterPayment: 'handoff' }), canonicalBindingEventId]
    )
    assert.equal(await findReusable(), null, 'el evento durable no puede cambiar la acción posterior')
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(eventDetail), canonicalBindingEventId]
    )

    for (const closedStatus of ['paid', 'cancelled', 'void', 'refunded', 'expired', 'failed']) {
      await db.run('UPDATE payments SET status = ? WHERE id = ?', [closedStatus, paymentId])
      assert.equal(await findReusable(), null, closedStatus)
    }
    await db.run("UPDATE payments SET status = 'sent', due_date = ? WHERE id = ?", [
      '2026-07-12T17:59:59.000Z',
      paymentId
    ])
    assert.equal(await findReusable(), null, 'elapsed_expiration')

    await db.run("UPDATE payments SET due_date = ? WHERE id = ?", ['2026-07-12', paymentId])
    assert.ok(await findReusable(), 'business_due_date_is_valid_for_the_whole_business_day')
    await db.run("UPDATE payments SET due_date = ? WHERE id = ?", ['2026-07-11', paymentId])
    assert.equal(await findReusable(), null, 'past_business_due_date')

    await db.run(
      "UPDATE payments SET status = 'sent', due_date = ?, metadata_json = ? WHERE id = ?",
      [expiresAt, JSON.stringify({ stripe: { status: 'canceled' } }), paymentId]
    )
    assert.equal(await findReusable(), null, 'raw_provider_status_cancelled')
    await db.run("UPDATE payments SET metadata_json = NULL WHERE id = ?", [paymentId])
    const reusableBeforeRace = await findReusable()
    setConversationalAgentLivePaymentDependenciesForTests({
      runIdempotentConversationalPaymentLinkCreation: async (options) => {
        const recorded = await runIdempotentConversationalPaymentLinkCreation(options)
        await db.run("UPDATE payments SET status = 'paid' WHERE id = ?", [paymentId])
        return recorded
      }
    })
    await assert.rejects(
      __conversationalAgentLivePaymentTestHooks.recordCrossTurnConversationalPaymentReuse({
        idempotencyKey: aliasRequestKey,
        payload: currentPayload,
        reusable: reusableBeforeRace,
        now: nowMs
      }),
      (error) => error?.code === 'live_payment_reuse_no_longer_valid'
    )
    setConversationalAgentLivePaymentDependenciesForTests(null)
    await db.run("UPDATE payments SET status = 'sent' WHERE id = ?", [paymentId])
    const aliasResult = await __conversationalAgentLivePaymentTestHooks.recordCrossTurnConversationalPaymentReuse({
      idempotencyKey: aliasRequestKey,
      payload: currentPayload,
      reusable: await findReusable(),
      now: nowMs
    })
    assert.equal(aliasResult.crossTurnReuse, true)
    assert.equal(aliasResult.paymentLink, paymentUrl)
    const alias = await db.get(
      `SELECT request_hash, request_json, status, binding_event_id, binding_status
       FROM conversational_payment_link_requests WHERE idempotency_key = ?`,
      [aliasRequestKey]
    )
    assert.equal(alias.status, 'completed')
    assert.equal(alias.binding_status, 'bound')
    assert.equal(alias.binding_event_id, canonicalBindingEventId)
    assert.equal(conversationalPaymentRequestHash(JSON.parse(alias.request_json)), alias.request_hash)

    const aliasReplay = await __conversationalAgentLivePaymentTestHooks.recordCrossTurnConversationalPaymentReuse({
      idempotencyKey: aliasRequestKey,
      payload: currentPayload,
      reusable: await findReusable(currentPayload, { idempotencyKey: key() }),
      now: nowMs
    })
    assert.equal(aliasReplay.crossTurnReuse, true)
    assert.equal(aliasReplay.durableReplay, true)
    assert.equal(aliasReplay.paymentLink, paymentUrl)
  } finally {
    await db.run('DELETE FROM conversational_payment_link_requests WHERE idempotency_key IN (?, ?)', [canonicalRequestKey, aliasRequestKey]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [canonicalBindingEventId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
