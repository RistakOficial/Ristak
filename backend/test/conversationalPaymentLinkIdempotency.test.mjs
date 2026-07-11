import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  __paymentFlowServiceTestHooks,
  buildConversationalPaymentLinkIdempotencyKey,
  runIdempotentConversationalPaymentLinkCreation
} from '../src/services/paymentFlowService.js'
import { recoverPendingConversationalPaymentSourceBindings } from '../src/services/conversationalAgentService.js'

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
    executionId: `message_${suffix}`
  }

  try {
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
      ) VALUES (?, ?, 430, 'MXN', 'sent', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
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

    await assert.rejects(
      runIdempotentConversationalPaymentLinkCreation({
        idempotencyKey,
        payload: { ...payload, amount: 431 },
        create: async () => ({ invoiceId: `duplicate_${suffix}` })
      }),
      (error) => error?.code === 'payment_link_idempotency_mismatch'
    )
  } finally {
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
