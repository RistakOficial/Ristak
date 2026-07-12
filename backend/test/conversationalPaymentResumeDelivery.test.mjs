import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  deliverVerifiedPaymentTerminalReply
} from '../src/agents/conversational/runner.js'
import {
  checkpointConversationalReplyDelivery,
  claimConversationalReplyDelivery,
  getConversationalReplyDeliveryPlan,
  getOrCreateConversationalReplyDeliveryPlan,
  notifyConversationalHumanBookingDeposit,
  setConversationalPriorityNotificationSenderForTest,
  settleConversationalReplyDelivery
} from '../src/services/conversationalAgentService.js'

function deliveryLedger() {
  return {
    get: getConversationalReplyDeliveryPlan,
    create: getOrCreateConversationalReplyDeliveryPlan,
    claim: claimConversationalReplyDelivery,
    checkpoint: checkpointConversationalReplyDelivery,
    settle: settleConversationalReplyDelivery
  }
}

function paymentReplyDependencies({ agentId, contactId, sent, preventiveMeasure = null }) {
  return {
    getAgent: async () => ({
      id: agentId,
      enabled: true,
      replyDelivery: { mode: 'single', splitMessagesEnabled: false }
    }),
    getContact: async () => ({ id: contactId, phone: '+526560001234' }),
    getLatestInbound: async () => ({
      id: `inbound_${contactId}`,
      phone: '+526560001234',
      channel: 'whatsapp'
    }),
    assertClaim: async () => ({ valid: true }),
    deliveryDependencies: {
      sendTextMessage: async (message) => {
        sent.push(message)
        return { messageId: `provider_${sent.length}` }
      },
      replyDeliveryLedger: deliveryLedger(),
      loadPreventiveMeasure: async () => preventiveMeasure,
      withSafetyDeliveryLock: async (callback) => callback(),
      wait: async () => {}
    }
  }
}

test('la confirmación post-pago usa un plan durable y recovery jamás reenvía el mismo mensaje', async () => {
  const suffix = randomUUID()
  const reconciliationId = `reconciliation_delivery_${suffix}`
  const contactId = `contact_delivery_${suffix}`
  const agentId = `agent_delivery_${suffix}`
  const sent = []
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Cliente entrega durable', '+526560001234', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const dependencies = paymentReplyDependencies({ agentId, contactId, sent })
    const first = await deliverVerifiedPaymentTerminalReply({
      reconciliationId,
      reconciliationClaimToken: `claim_${suffix}`,
      contactId,
      agentId,
      terminalType: 'ai',
      reply: 'Tu pago quedó confirmado y tu cita quedó agendada.'
    }, dependencies)
    const recovered = await deliverVerifiedPaymentTerminalReply({
      reconciliationId,
      reconciliationClaimToken: `claim_recovery_${suffix}`,
      contactId,
      agentId,
      terminalType: 'ai'
    }, dependencies)

    assert.equal(first.sent, true)
    assert.equal(recovered.sent, true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, 'Tu pago quedó confirmado y tu cita quedó agendada.')
    const replyEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id = ? AND event_type = 'payment_resume_reply_sent'`,
      [`${reconciliationId}_reply`]
    )
    assert.equal(Number(replyEvents.total), 1)
    const plans = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'reply_delivery_plan_v1'`,
      [contactId]
    )
    assert.equal(plans.length, 1)
    assert.equal(JSON.parse(plans[0].detail_json).status, 'completed')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('recovery libera una interrupción por inbound sólo cuando ninguna parte alcanzó al proveedor', async () => {
  const suffix = randomUUID()
  const reconciliationId = `reconciliation_inbound_${suffix}`
  const contactId = `contact_inbound_${suffix}`
  const agentId = `agent_inbound_${suffix}`
  const sent = []
  try {
    const identity = {
      contactId,
      agentId,
      channel: 'whatsapp',
      sourceMessageId: reconciliationId,
      externalIdPrefix: 'convagent_payment_resume'
    }
    const created = await getOrCreateConversationalReplyDeliveryPlan(identity, {
      reply: 'Tu cita ya quedó confirmada.',
      parts: ['Tu cita ya quedó confirmada.'],
      delaySchedule: [0]
    })
    const claim = await claimConversationalReplyDelivery(created.plan.id)
    assert.equal(claim.claimed, true)
    await settleConversationalReplyDelivery(created.plan.id, claim.claimToken, {
      status: 'interrupted',
      interruptedByMessageId: `new_inbound_${suffix}`
    })

    const recovered = await deliverVerifiedPaymentTerminalReply({
      reconciliationId,
      reconciliationClaimToken: `claim_${suffix}`,
      contactId,
      agentId,
      terminalType: 'ai'
    }, paymentReplyDependencies({ agentId, contactId, sent }))
    assert.equal(recovered.sent, true)
    assert.equal(sent.length, 1)
    assert.equal((await getConversationalReplyDeliveryPlan(created.plan.id)).status, 'completed')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})

test('una medida preventiva suprime la confirmación post-pago y queda sellada sin reintentos eternos', async () => {
  const suffix = randomUUID()
  const reconciliationId = `reconciliation_suppressed_${suffix}`
  const contactId = `contact_suppressed_${suffix}`
  const agentId = `agent_suppressed_${suffix}`
  const sent = []
  try {
    const dependencies = paymentReplyDependencies({
      agentId,
      contactId,
      sent,
      preventiveMeasure: { id: `safety_${suffix}`, category: 'spam' }
    })
    const result = await deliverVerifiedPaymentTerminalReply({
      reconciliationId,
      reconciliationClaimToken: `claim_${suffix}`,
      contactId,
      agentId,
      terminalType: 'human'
    }, dependencies)
    const replay = await deliverVerifiedPaymentTerminalReply({
      reconciliationId,
      reconciliationClaimToken: `claim_recovery_${suffix}`,
      contactId,
      agentId,
      terminalType: 'human'
    }, dependencies)
    assert.equal(result.suppressed, true)
    assert.equal(replay.suppressed, true)
    assert.equal(sent.length, 0)
    assert.equal((await db.get(
      'SELECT event_type FROM conversational_agent_events WHERE id = ?',
      [`${reconciliationId}_reply_suppressed`]
    )).event_type, 'payment_resume_reply_suppressed')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})

test('push crítico fallido o processing vencido se retoma; sólo sent dedupea para siempre', async () => {
  const suffix = randomUUID()
  const reconciliationId = `reconciliation_push_retry_${suffix}`
  const contactId = `contact_push_retry_${suffix}`
  let calls = 0
  const deliveredPayloads = []
  try {
    setConversationalPriorityNotificationSenderForTest(async (payload) => {
      calls += 1
      if (calls === 1) throw new Error('push caído')
      deliveredPayloads.push(payload)
      return { sent: 1 }
    })
    await assert.rejects(notifyConversationalHumanBookingDeposit({
      reconciliationId,
      contactId,
      title: 'Consulta',
      startTime: '2026-07-21T18:00:00.000Z'
    }), /push caído/)
    const pendingId = `${reconciliationId}_human_booking_notification_pending`
    const failedRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [pendingId]
    )
    const failed = JSON.parse(failedRow.detail_json)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.attempts, 1)

    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({
        ...failed,
        status: 'processing',
        claimToken: 'claim_crashed_worker',
        leaseUntilAt: new Date(Date.now() - 1000).toISOString()
      }), pendingId]
    )
    const retried = await notifyConversationalHumanBookingDeposit({
      reconciliationId,
      contactId,
      title: 'Consulta',
      startTime: '2026-07-20T16:00:00.000Z'
    })
    const deduped = await notifyConversationalHumanBookingDeposit({
      reconciliationId,
      contactId,
      title: 'Consulta',
      startTime: '2026-07-20T16:00:00.000Z'
    })
    assert.equal(retried.sent, 1)
    assert.equal(deduped.reason, 'deduped_event_id')
    assert.equal(calls, 2)
    assert.equal(deliveredPayloads[0].summary, 'Consulta: 2026-07-21T18:00:00.000Z')
    const sentState = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [pendingId]
    )).detail_json)
    assert.equal(sentState.status, 'sent')
    assert.equal(sentState.attempts, 2)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id = ? AND event_type = 'priority_push_notification'`,
      [`${reconciliationId}_human_booking_notification`]
    )).total), 1)
  } finally {
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})

test('dos workers de push crítico no envían en paralelo bajo un lease vivo', async () => {
  const suffix = randomUUID()
  const reconciliationId = `reconciliation_push_concurrent_${suffix}`
  const contactId = `contact_push_concurrent_${suffix}`
  let releaseSender
  let senderStarted
  let calls = 0
  const started = new Promise((resolve) => { senderStarted = resolve })
  const blocked = new Promise((resolve) => { releaseSender = resolve })
  try {
    setConversationalPriorityNotificationSenderForTest(async () => {
      calls += 1
      senderStarted()
      await blocked
      return { sent: 1 }
    })
    const payload = {
      reconciliationId,
      contactId,
      title: 'Consulta',
      startTime: '2026-07-20T16:00:00.000Z'
    }
    const first = notifyConversationalHumanBookingDeposit(payload)
    await started
    await assert.rejects(
      notifyConversationalHumanBookingDeposit(payload),
      /sigue en proceso de entrega/
    )
    releaseSender()
    assert.equal((await first).sent, 1)
    assert.equal((await notifyConversationalHumanBookingDeposit(payload)).reason, 'deduped_event_id')
    assert.equal(calls, 1)
  } finally {
    releaseSender?.()
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})
