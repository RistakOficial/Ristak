import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  sendReplyParts, buildConversationalTransportRetryPlan, failInboundAndQueueTransportRetry,
  getInboundMandatoryHandoffEscalationReason
} from '../src/agents/conversational/runner.js'
import {
  getConversationalReplyDeliveryPlan, getOrCreateConversationalReplyDeliveryPlan,
  claimConversationalReplyDelivery, checkpointConversationalReplyDelivery,
  settleConversationalReplyDelivery, recoverUnsentLegacyQrReplyPlan
} from '../src/services/conversationalAgentService.js'

const ledger = {
  get: getConversationalReplyDeliveryPlan, create: getOrCreateConversationalReplyDeliveryPlan,
  claim: claimConversationalReplyDelivery, checkpoint: checkpointConversationalReplyDelivery,
  settle: settleConversationalReplyDelivery
}
const disconnected = () => Object.assign(new Error('QR reconectando'), {
  code: 'WHATSAPP_QR_CONNECTION_NOT_READY', providerSendAttempted: false
})

async function withDelivery(callback) {
  const suffix = randomUUID()
  const identity = { contactId: `contact_${suffix}`, agentId: `agent_${suffix}`, sourceMessageId: `inbound_${suffix}`, channel: 'whatsapp' }
  const input = {
    contactId: identity.contactId, phone: '+525500000001', latest: { id: identity.sourceMessageId },
    agentConfig: { id: identity.agentId, replyDelivery: { splitMessagesEnabled: false } }, reply: 'Respuesta pendiente',
    dependencies: {
      replyDeliveryLedger: ledger, forceSingleMessage: true, loadNewerInbound: async () => null,
      loadPreventiveMeasure: async () => null, withSafetyDeliveryLock: async fn => fn(),
      recordEvent: async () => {}, markReplyComplete: async () => {}, sendTextMessage: async () => ({ id: 'accepted' })
    }
  }
  try { await callback(input, identity) } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [identity.contactId])
  }
}

test('QR se prepara fuera del fence; si aún no conecta conserva el plan y reintenta sin duplicar', async () => {
  await withDelivery(async (input, identity) => {
    let inFence = false
    let prepares = 0
    let sends = 0
    input.dependencies.withSafetyDeliveryLock = async fn => {
      inFence = true
      try { return await fn() } finally { inFence = false }
    }
    input.dependencies.prepareDelivery = async () => {
      assert.equal(inFence, false)
      if (++prepares === 1) throw disconnected()
    }
    input.dependencies.beforeSendFence = async ({ send }) => ({ allowed: true, sent: true, deliveryResult: await send() })
    input.dependencies.sendTextMessage = async () => { assert.equal(inFence, true); sends += 1; return { id: 'accepted' } }
    let failure
    await assert.rejects(sendReplyParts(input), error => { failure = error; return true })
    assert.equal(sends, 0)
    assert.equal(failure.conversationalReplyDelivery.providerSendAttempted, false)
    assert.equal((await ledger.get(identity)).status, 'pending')
    assert.equal(buildConversationalTransportRetryPlan(failure, { nowMs: 0 }).scheduledFor, '1970-01-01T00:00:30.000Z')
    await sendReplyParts(input)
    await sendReplyParts(input)
    assert.equal(sends, 1)
    assert.equal((await ledger.get(identity)).status, 'completed')
  })
})

test('una desconexión probada antes de sendMessage libera sending; una falla desconocida no se repite', async () => {
  for (const provenUnsent of [true, false]) {
    await withDelivery(async (input, identity) => {
      let sends = 0
      input.dependencies.sendTextMessage = async () => { sends += 1; throw provenUnsent ? disconnected() : new Error('timeout del proveedor') }
      await assert.rejects(sendReplyParts(input))
      const plan = await ledger.get(identity)
      assert.equal(plan.status, provenUnsent ? 'pending' : 'ambiguous')
      if (provenUnsent) {
        assert.equal(plan.parts[0].status, 'pending')
        input.dependencies.sendTextMessage = async () => { sends += 1; return { id: 'accepted' } }
      }
      await sendReplyParts(input)
      assert.equal(sends, provenUnsent ? 2 : 1)
    })
  }
})

test('recupera el falso ambiguo histórico del QR y conserva las partes ya entregadas', async () => {
  await withDelivery(async (input, identity) => {
    const { plan } = await ledger.create(identity, { reply: 'Una. Dos.', parts: ['Una.', 'Dos.'], delaySchedule: [0, 0] })
    const claim = await ledger.claim(plan.id)
    await ledger.checkpoint(plan.id, claim.claimToken, { partIndex: 0, status: 'sending' })
    await ledger.checkpoint(plan.id, claim.claimToken, { partIndex: 0, status: 'sent', providerMessageId: 'accepted_first' })
    await ledger.checkpoint(plan.id, claim.claimToken, { partIndex: 1, status: 'sending' })
    await ledger.settle(plan.id, claim.claimToken, { status: 'ambiguous', error: 'provider_send_attempted_before_failure:El QR no está conectado. Abre Configuración > WhatsApp y escanea el código.' })
    const delivered = []
    input.dependencies.sendTextMessage = async ({ text }) => { delivered.push(text); return { id: 'accepted_second' } }
    await sendReplyParts(input)
    assert.deepEqual(delivered, ['Dos.'])
    assert.equal((await ledger.get(identity)).status, 'completed')
  })
})

test('la reparación histórica nunca reabre entregas con aceptación, crashes ni errores genéricos', () => {
  const error = 'provider_send_attempted_before_failure:El QR no está conectado. Abre Configuración > WhatsApp y escanea el código.'
  const base = { channel: 'whatsapp', status: 'ambiguous', ambiguousReason: error, parts: [{ status: 'ambiguous', lastError: error }] }
  assert.ok(recoverUnsentLegacyQrReplyPlan(base, '2026-09-22T22:00:00Z'))
  for (const changed of [
    { ...base, channel: 'email' }, { ...base, ambiguousReason: 'delivery_lease_expired_after_send_started' },
    { ...base, parts: [{ ...base.parts[0], providerMessageId: 'accepted' }] },
    { ...base, parts: [{ ...base.parts[0], sentAt: '2026-09-22T22:00:00Z' }] },
    { ...base, parts: [{ ...base.parts[0], lastError: 'network timeout' }] }
  ]) assert.equal(recoverUnsentLegacyQrReplyPlan(changed), null)
})

test('reintentos QR tienen límite y se guardan antes de programarlos, sin activar handoff', async () => {
  assert.equal(getInboundMandatoryHandoffEscalationReason({
    state: { inboundProcessingLastError: 'WHATSAPP_QR_CONNECTION_NOT_READY: QR reconectando' },
    attemptCount: 5, policyConfigured: true
  }), null)
  const error = disconnected()
  error.conversationalReplyDelivery = { durableStatus: 'pending', providerSendUncheckpointed: false, attemptCount: 5 }
  const plan = buildConversationalTransportRetryPlan(error, { nowMs: 0 })
  assert.equal(plan.delayMs, 300_000)
  error.conversationalReplyDelivery.attemptCount = 6
  assert.equal(buildConversationalTransportRetryPlan(error), null)
  error.conversationalReplyDelivery.attemptCount = 1
  error.conversationalReplyDelivery.providerSendUncheckpointed = true
  assert.equal(buildConversationalTransportRetryPlan(error), null)
  const calls = []
  const args = { contactId: 'retry_contact', claim: { messageId: 'inbound', claimToken: 'owner', agentId: 'agent', channel: 'whatsapp' }, error, plan }
  const dependencies = {
    database: { transaction: async fn => { calls.push('begin'); const result = await fn(); calls.push('commit'); return result } },
    failInbound: async () => { calls.push('failed'); return { failed: true } },
    persistRerun: async (_key, entry) => { assert.equal(entry.mandatoryHandoffRetry, undefined); calls.push('persisted') },
    scheduleRerun: () => calls.push('scheduled')
  }
  assert.equal((await failInboundAndQueueTransportRetry(args, dependencies)).queued, true)
  assert.deepEqual(calls, ['begin', 'failed', 'persisted', 'commit', 'scheduled'])
  calls.length = 0
  dependencies.persistRerun = async () => { throw new Error('database unavailable') }
  await assert.rejects(failInboundAndQueueTransportRetry(args, dependencies))
  assert.ok(!calls.includes('scheduled'))
})
