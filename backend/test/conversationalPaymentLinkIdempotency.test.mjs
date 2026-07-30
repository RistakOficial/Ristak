import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  __paymentFlowServiceTestHooks,
  buildConversationalPaymentLinkIdempotencyKey,
  runIdempotentConversationalPaymentLinkCreation
} from '../src/services/paymentFlowService.js'
import {
  completeConversationalAgentSalePaymentFromInvoice,
  ensureConversationState,
  recoverPendingConversationalPaymentSourceBindings,
  setConversationalPaymentResumeHandlerForTest,
  setConversationalPriorityNotificationSenderForTest
} from '../src/services/conversationalAgentService.js'

test('v2 nunca reutiliza un invoice genérico por contacto+monto+concepto; sólo su ledger fuerte', () => {
  assert.equal(__paymentFlowServiceTestHooks.shouldUseRecentEquivalentPaymentLink({
    source: 'conversational_agent_v2',
    agentId: 'agent-a',
    productId: 'product-a',
    priceId: 'price-a'
  }), false)
  assert.equal(__paymentFlowServiceTestHooks.shouldUseRecentEquivalentPaymentLink({
    source: 'conversational_agent'
  }), true)
  assert.equal(__paymentFlowServiceTestHooks.shouldUseRecentEquivalentPaymentLink({}), true)
})

function uniquePaymentKey() {
  const digest = createHash('sha256').update(randomUUID()).digest('hex')
  return `conv-v2-payment:${digest}`
}

async function cleanup(key) {
  await db.run(
    'DELETE FROM conversational_payment_link_requests WHERE idempotency_key = ?',
    [key]
  ).catch(() => {})
}

test('dos cobros v2 simultáneos reservan una sola creación y los reintentos reproducen el link durable', async () => {
  const idempotencyKey = uniquePaymentKey()
  const payload = {
    agentId: 'agent-safe',
    contactId: 'contact-safe',
    productId: 'product-safe',
    priceId: 'price-safe',
    amount: 125,
    currency: 'MXN'
  }
  const expected = {
    invoiceId: 'invoice-safe',
    paymentLink: 'https://pay.example.com/invoice-safe',
    amount: 125,
    currency: 'MXN',
    status: 'sent',
    sendMethod: 'whatsapp'
  }
  let creations = 0
  const create = async () => {
    creations += 1
    await new Promise((resolve) => setTimeout(resolve, 60))
    return expected
  }

  try {
    const concurrent = await Promise.all([
      runIdempotentConversationalPaymentLinkCreation({ idempotencyKey, payload, create }),
      runIdempotentConversationalPaymentLinkCreation({ idempotencyKey, payload, create })
    ])

    assert.equal(creations, 1)
    assert.deepEqual(concurrent.map((result) => result.paymentLink), [expected.paymentLink, expected.paymentLink])
    assert.equal(concurrent.filter((result) => result.durableReplay === true).length, 1)

    const replay = await runIdempotentConversationalPaymentLinkCreation({ idempotencyKey, payload, create })
    assert.equal(creations, 1)
    assert.equal(replay.paymentLink, expected.paymentLink)
    assert.equal(replay.reused, true)
    assert.equal(replay.durableReplay, true)

    const stored = await db.get(
      `SELECT status, request_hash, response_json
       FROM conversational_payment_link_requests
       WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(stored.status, 'completed')
    assert.equal(stored.request_hash.length, 64)
    assert.equal(JSON.parse(stored.response_json).paymentLink, expected.paymentLink)
  } finally {
    await cleanup(idempotencyKey)
  }
})

test('la identidad del inbound reusa el mismo cobro pero permite otro cobro legítimo desde otro inbound', async () => {
  const base = {
    agentId: 'agent-execution-safe',
    contactId: 'contact-execution-safe',
    productId: 'product-execution-safe',
    priceId: 'price-execution-safe',
    amount: 240,
    currency: 'MXN',
    channel: 'whatsapp'
  }
  const firstPayload = { ...base, executionId: `message_1_${randomUUID()}` }
  const secondPayload = { ...base, executionId: `message_2_${randomUUID()}` }
  const firstKey = buildConversationalPaymentLinkIdempotencyKey(firstPayload)
  const repeatedKey = buildConversationalPaymentLinkIdempotencyKey({ ...firstPayload })
  const secondKey = buildConversationalPaymentLinkIdempotencyKey(secondPayload)
  assert.equal(repeatedKey, firstKey)
  assert.notEqual(secondKey, firstKey)

  let creations = 0
  const create = async () => {
    creations += 1
    return {
      invoiceId: `invoice-${creations}`,
      paymentLink: `https://pay.example.com/invoice-${creations}`,
      amount: 240,
      currency: 'MXN'
    }
  }

  try {
    const first = await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey: firstKey,
      payload: firstPayload,
      create
    })
    const replay = await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey: repeatedKey,
      payload: firstPayload,
      create
    })
    const second = await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey: secondKey,
      payload: secondPayload,
      create
    })

    assert.equal(creations, 2)
    assert.equal(replay.paymentLink, first.paymentLink)
    assert.equal(replay.durableReplay, true)
    assert.notEqual(second.paymentLink, first.paymentLink)
  } finally {
    await cleanup(firstKey)
    await cleanup(secondKey)
  }
})

test('un fallo del proveedor queda bloqueado y jamás vuelve a crear otro link con la misma llave', async () => {
  const idempotencyKey = uniquePaymentKey()
  const payload = { contactId: 'contact-failed', amount: 80, currency: 'MXN' }
  let creations = 0
  const create = async () => {
    creations += 1
    const error = new Error('proveedor no disponible')
    error.status = 502
    throw error
  }

  try {
    await assert.rejects(
      runIdempotentConversationalPaymentLinkCreation({ idempotencyKey, payload, create }),
      /proveedor no disponible/
    )
    await assert.rejects(
      runIdempotentConversationalPaymentLinkCreation({
        idempotencyKey,
        payload,
        create: async () => {
          creations += 1
          return { paymentLink: 'https://pay.example.com/duplicate' }
        }
      }),
      (error) => error?.code === 'payment_link_previous_attempt_failed'
    )
    assert.equal(creations, 1)
  } finally {
    await cleanup(idempotencyKey)
  }
})

test('si la reserva durable falla, el proveedor no se ejecuta', async () => {
  const idempotencyKey = uniquePaymentKey()
  let creations = 0
  const unavailableDatabase = {
    run: async () => {
      throw new Error('ledger no disponible')
    },
    get: async () => null
  }

  await assert.rejects(
    runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload: { contactId: 'contact-safe', amount: 100, currency: 'MXN' },
      database: unavailableDatabase,
      create: async () => {
        creations += 1
        return { paymentLink: 'https://pay.example.com/unsafe' }
      }
    }),
    /ledger no disponible/
  )
  assert.equal(creations, 0)
})

test('un processing tras crash se reconstruye sólo desde su invoice exacto y no llama dos veces al proveedor', async () => {
  const suffix = randomUUID()
  const idempotencyKey = uniquePaymentKey()
  const contactId = `contact_processing_recovery_${suffix}`
  const invoiceId = `invoice_processing_recovery_${suffix}`
  const paymentLink = `https://pay.example.com/${invoiceId}`
  const payload = {
    agentId: `agent_processing_recovery_${suffix}`,
    contactId,
    productId: `product_${suffix}`,
    priceId: `price_${suffix}`,
    amount: 315,
    currency: 'MXN',
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    executionId: `message_${suffix}`
  }
  let providerCalls = 0
  const crashBeforeCompletionDatabase = {
    get: (...args) => db.get(...args),
    run: async (sql, params) => {
      if (
        String(sql).includes('UPDATE conversational_payment_link_requests') &&
        String(sql).includes("SET status = 'completed'")
      ) {
        return { changes: 0 }
      }
      return db.run(sql, params)
    }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente processing recovery', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    await assert.rejects(
      runIdempotentConversationalPaymentLinkCreation({
        idempotencyKey,
        payload,
        database: crashBeforeCompletionDatabase,
        create: async () => {
          providerCalls += 1
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_mode, payment_provider,
              ghl_invoice_id, invoice_number, payment_url, payment_link_request_key,
              sent_at, created_at, updated_at
            ) VALUES (?, ?, 315, 'MXN', 'sent', 'live', 'highlevel', ?, ?, ?, ?,
                      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [invoiceId, contactId, invoiceId, `INV-${suffix}`, paymentLink, idempotencyKey]
          )
          return {
            invoiceId,
            paymentLink,
            amount: 315,
            currency: 'MXN',
            sendMethod: 'whatsapp',
            status: 'sent'
          }
        }
      }),
      (error) => error?.code === 'payment_link_ledger_commit_failed'
    )
    assert.equal(providerCalls, 1)
    const stranded = await db.get(
      'SELECT status, response_json FROM conversational_payment_link_requests WHERE idempotency_key = ?',
      [idempotencyKey]
    )
    assert.equal(stranded.status, 'processing')
    assert.equal(stranded.response_json, null)

    const startupRecovery = await recoverPendingConversationalPaymentSourceBindings({
      contactId,
      reconcilePaid: false
    })
    assert.equal(startupRecovery.bound, 1, JSON.stringify(startupRecovery))
    const recoveredBinding = await db.get(
      `SELECT binding_event_id, binding_status
       FROM conversational_payment_link_requests
       WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(recoveredBinding.binding_status, 'bound')
    const recoveredSource = await db.get(
      `SELECT event_type, detail_json
       FROM conversational_agent_events
       WHERE id = ?`,
      [recoveredBinding.binding_event_id]
    )
    const recoveredSourceDetail = JSON.parse(recoveredSource.detail_json)
    assert.equal(recoveredSource.event_type, 'payment_link_created')
    assert.equal(recoveredSourceDetail.recoveredBinding, true)
    assert.equal(recoveredSourceDetail.paymentConversationBinding.status, 'unavailable')
    assert.equal(
      recoveredSourceDetail.paymentConversationBinding.reason,
      'payment_source_cycle_not_sealed'
    )
    assert.equal(recoveredSourceDetail.paymentConversationBinding.conversationScopeId, null)
    assert.deepEqual(recoveredSourceDetail.actionScopedContactData, {})

    const recovered = await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload,
      create: async () => {
        providerCalls += 1
        throw new Error('el proveedor no debe volver a ejecutarse')
      }
    })

    assert.equal(providerCalls, 1)
    assert.equal(recovered.invoiceId, invoiceId)
    assert.equal(recovered.paymentLink, paymentLink)
    assert.equal(recovered.amount, 315)
    assert.equal(recovered.currency, 'MXN')
    assert.equal(recovered.status, 'sent')
    assert.equal(recovered.sendMethod, 'recovered')
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.reused, true)
    assert.equal(recovered.durableReplay, true)

    const completed = await db.get(
      `SELECT status, response_json
       FROM conversational_payment_link_requests WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(completed.status, 'completed')
    assert.equal(JSON.parse(completed.response_json).invoiceId, invoiceId)
  } finally {
    await db.run('DELETE FROM payments WHERE payment_link_request_key = ?', [idempotencyKey]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await cleanup(idempotencyKey)
  }
})

test('un crash después de crear el link conserva payload suficiente y recovery sella el source event', async () => {
  const suffix = randomUUID()
  const idempotencyKey = uniquePaymentKey()
  const contactId = `contact_binding_recovery_${suffix}`
  const agentId = `agent_binding_recovery_${suffix}`
  const invoiceId = `invoice_binding_recovery_${suffix}`
  const payload = {
    agentId,
    contactId,
    productId: `product_${suffix}`,
    priceId: `price_${suffix}`,
    amount: 430,
    currency: 'MXN',
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    afterPayment: 'handoff',
    executionId: `message_${suffix}`
  }

  try {
    setConversationalPriorityNotificationSenderForTest(async () => ({ sent: true }))
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente binding recovery', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload,
      create: async () => ({
        invoiceId,
        paymentLink: `https://pay.example.com/${invoiceId}`,
        sendMethod: 'whatsapp',
        amount: 430,
        currency: 'MXN',
        status: 'sent'
      })
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 430, 'MXN', 'paid', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`ledger_${suffix}`, contactId, invoiceId]
    )
    const pending = await db.get(
      `SELECT request_json, binding_event_id, binding_status
       FROM conversational_payment_link_requests WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(JSON.parse(pending.request_json).paymentPurpose, 'purchase')
    assert.match(pending.binding_event_id, /^cae_payment_/)
    assert.equal(pending.binding_status, 'pending')

    const recovered = await recoverPendingConversationalPaymentSourceBindings({
      contactId,
      reconcilePaid: false
    })
    assert.equal(recovered.bound, 1, JSON.stringify(recovered))
    const stored = await db.get(
      `SELECT binding_status, bound_at FROM conversational_payment_link_requests
       WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(stored.binding_status, 'bound')
    assert.ok(stored.bound_at)
    const event = await db.get(
      `SELECT event_type, detail_json FROM conversational_agent_events
       WHERE id = ?`,
      [pending.binding_event_id]
    )
    const detail = JSON.parse(event.detail_json)
    assert.equal(event.event_type, 'payment_link_created')
    assert.equal(detail.ledgerPaymentId, `ledger_${suffix}`)
    assert.equal(detail.paymentPurpose, 'purchase')
    assert.equal(detail.appointmentDeposit, false)
    assert.equal(detail.recoveredBinding, true)
    assert.equal(detail.afterPayment, 'handoff')
    assert.equal(detail.paymentConversationBinding.status, 'unavailable')
    assert.equal(
      detail.paymentConversationBinding.reason,
      'payment_source_cycle_not_sealed'
    )
    assert.equal(detail.paymentConversationBinding.stateId, null)
    assert.equal(detail.paymentConversationBinding.activationCycleId, null)
    assert.equal(detail.paymentConversationBinding.conversationScopeId, null)
    assert.deepEqual(detail.actionScopedContactData, {})
    assert.match(detail.actionScopedContactDataHash, /^[a-f0-9]{64}$/)

    const completion = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      paymentId: `ledger_${suffix}`,
      amount: 430,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(completion.matched, true)
    assert.equal(completion.handoffCompleted, false)
    assert.equal(completion.manualReviewRequired, true)
    assert.equal(completion.statePreserved, true)
    assert.equal(completion.signal, 'payment_confirmed_state_preserved')
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agentId]
    ), null)

    await assert.rejects(
      runIdempotentConversationalPaymentLinkCreation({
        idempotencyKey,
        payload: { ...payload, amount: 431 },
        create: async () => ({ invoiceId: `duplicate_${suffix}` })
      }),
      (error) => error?.code === 'payment_link_idempotency_mismatch'
    )
  } finally {
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await cleanup(idempotencyKey)
  }
})

test('recovery bloquea request_json mutado y nunca reclasifica una compra como anticipo', async () => {
  const suffix = randomUUID()
  const idempotencyKey = uniquePaymentKey()
  const contactId = `contact_binding_hash_${suffix}`
  const agentId = `agent_binding_hash_${suffix}`
  const invoiceId = `invoice_binding_hash_${suffix}`
  const payload = {
    agentId,
    contactId,
    productId: `product_${suffix}`,
    priceId: `price_${suffix}`,
    amount: 510,
    currency: 'MXN',
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    executionId: `message_${suffix}`
  }
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente hash recovery', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload,
      create: async () => ({
        invoiceId,
        paymentLink: `https://pay.example.com/${invoiceId}`,
        sendMethod: 'whatsapp',
        amount: 510,
        currency: 'MXN',
        status: 'sent'
      })
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
       ) VALUES (?, ?, 510, 'MXN', 'sent', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`ledger_hash_${suffix}`, contactId, invoiceId]
    )
    await db.run(
      `UPDATE conversational_payment_link_requests SET request_json = ?
       WHERE idempotency_key = ?`,
      [JSON.stringify({ ...payload, paymentPurpose: 'appointment_deposit' }), idempotencyKey]
    )

    const recovered = await recoverPendingConversationalPaymentSourceBindings({
      contactId,
      reconcilePaid: false
    })
    assert.equal(recovered.bound, 0)
    assert.equal(recovered.failed, 1)
    const stored = await db.get(
      `SELECT status, binding_status FROM conversational_payment_link_requests
       WHERE idempotency_key = ?`,
      [idempotencyKey]
    )
    assert.equal(stored.status, 'failed')
    assert.equal(stored.binding_status, 'failed')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_events WHERE contact_id = ?',
      [contactId]
    )).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await cleanup(idempotencyKey)
  }
})

test('un pago legacy recuperado no reanuda el ciclo actual aunque afterPayment sea continue', async () => {
  const suffix = randomUUID()
  const idempotencyKey = uniquePaymentKey()
  const contactId = `contact_recovered_continue_${suffix}`
  const agentId = `agent_recovered_continue_${suffix}`
  const invoiceId = `invoice_recovered_continue_${suffix}`
  const ledgerPaymentId = `ledger_recovered_continue_${suffix}`
  const payload = {
    agentId,
    contactId,
    productId: `product_${suffix}`,
    priceId: `price_${suffix}`,
    amount: 275,
    currency: 'MXN',
    channel: 'whatsapp',
    paymentPurpose: 'purchase',
    afterPayment: 'continue',
    executionId: `message_old_cycle_${suffix}`
  }
  let resumeCalls = 0

  try {
    setConversationalPriorityNotificationSenderForTest(async () => ({ sent: true }))
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true, queued: false }
    })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente ciclo nuevo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await runIdempotentConversationalPaymentLinkCreation({
      idempotencyKey,
      payload,
      create: async () => ({
        invoiceId,
        paymentLink: `https://pay.example.com/${invoiceId}`,
        sendMethod: 'whatsapp',
        amount: 275,
        currency: 'MXN',
        status: 'sent'
      })
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 275, 'MXN', 'paid', 'live', 'highlevel', ?,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ledgerPaymentId, contactId, invoiceId]
    )
    const recovered = await recoverPendingConversationalPaymentSourceBindings({
      contactId,
      reconcilePaid: false
    })
    assert.equal(recovered.bound, 1, JSON.stringify(recovered))

    // Este estado representa una conversación distinta que nació después del
    // cobro legacy. El recovery no conoce el ciclo original y no puede
    // apropiarse de éste sólo porque contacto y agente coincidan.
    await db.run(
      `INSERT INTO conversational_agents
        (id, name, enabled, runtime_mode)
       VALUES (?, 'Agente ciclo nuevo', 1, 'tool_calling_v2')`,
      [agentId]
    )
    const stateBefore = await ensureConversationState(contactId, {
      agentId,
      channel: 'whatsapp'
    })
    assert.equal(stateBefore.status, 'active')
    assert.equal(stateBefore.signal, null)
    assert.ok(stateBefore.activationCycleId)

    const completion = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      paymentId: ledgerPaymentId,
      amount: 275,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(resumeCalls, 0)
    assert.equal(completion.matched, true)
    assert.equal(completion.handoffCompleted, false)
    assert.equal(completion.manualReviewRequired, true)
    assert.equal(completion.statePreserved, true)
    assert.equal(completion.resumed, false)
    assert.equal(completion.queued, false)
    assert.equal(completion.signal, 'payment_confirmed_state_preserved')

    const stateAfter = await db.get(
      `SELECT status, signal, activation_cycle_id
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agentId]
    )
    assert.equal(stateAfter.status, 'active')
    assert.equal(stateAfter.signal, null)
    assert.equal(stateAfter.activation_cycle_id, stateBefore.activationCycleId)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await cleanup(idempotencyKey)
  }
})
