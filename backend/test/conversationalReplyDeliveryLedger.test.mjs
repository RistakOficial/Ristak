import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE,
  CONVERSATIONAL_REPLY_DELIVERY_MAX_DETAIL_BYTES,
  buildConversationalReplyDeliveryPlanId,
  checkpointConversationalReplyDelivery,
  claimConversationalReplyDelivery,
  getConversationalReplyDeliveryPlan,
  getOrCreateConversationalReplyDeliveryPlan,
  settleConversationalReplyDelivery
} from '../src/services/conversationalAgentService.js'

function replyIdentity(label = 'reply') {
  const suffix = randomUUID()
  return {
    contactId: `contact_${label}_${suffix}`,
    agentId: `agent_${label}_${suffix}`,
    channel: 'wa',
    sourceMessageId: `message_${label}_${suffix}`,
    externalIdPrefix: 'convagent'
  }
}

async function createReplyPlan(label = 'reply', overrides = {}) {
  const identity = replyIdentity(label)
  const candidate = {
    reply: 'Primera idea. Segunda idea.',
    parts: ['Primera idea.', 'Segunda idea.'],
    delaySchedule: [0, 2500],
    splitterMeta: { source: 'ai', reason: 'exact_content_preserved', model: 'gpt-5-nano' },
    ...overrides
  }
  const result = await getOrCreateConversationalReplyDeliveryPlan(identity, candidate)
  return { identity, candidate, ...result }
}

async function deleteReplyPlan(planId) {
  await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [planId]).catch(() => undefined)
}

test('el ID y los externalId del plan son deterministas e incluyen siempre el índice', async () => {
  const identity = replyIdentity('deterministic')
  const sameIdentityWithCanonicalChannel = { ...identity, channel: 'whatsapp' }
  const planId = buildConversationalReplyDeliveryPlanId(identity)

  assert.equal(buildConversationalReplyDeliveryPlanId(sameIdentityWithCanonicalChannel), planId)
  assert.notEqual(
    buildConversationalReplyDeliveryPlanId({ ...identity, externalIdPrefix: 'convagent_followup1' }),
    planId
  )

  try {
    const created = await getOrCreateConversationalReplyDeliveryPlan(identity, {
      reply: 'Un solo globo',
      parts: ['Un solo globo'],
      delaySchedule: [0]
    })
    assert.equal(created.created, true)
    assert.equal(created.plan.eventType, CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE)
    assert.equal(created.plan.id, planId)
    assert.match(created.plan.parts[0].externalId, /^convreply_[a-f0-9]{48}_1$/)
    assert.equal(created.plan.parts[0].status, 'pending')
  } finally {
    await deleteReplyPlan(planId)
  }
})

test('el primer corte guardado gana y un retry no puede regenerar partes distintas', async () => {
  const { identity, plan } = await createReplyPlan('write_once')
  try {
    const replay = await getOrCreateConversationalReplyDeliveryPlan(identity, {
      reply: 'Un corte completamente diferente',
      parts: ['Un corte', 'completamente diferente'],
      delaySchedule: [0, 7000],
      splitterMeta: { source: 'fallback', reason: 'retry_changed' }
    })
    const stored = await getConversationalReplyDeliveryPlan(identity)

    assert.equal(replay.created, false)
    assert.equal(replay.candidateDiscarded, true)
    assert.deepEqual(replay.plan.parts.map((part) => part.text), ['Primera idea.', 'Segunda idea.'])
    assert.deepEqual(stored.delaySchedule, [0, 2500])
    assert.equal(
      Number((await db.get('SELECT COUNT(*) AS total FROM conversational_agent_events WHERE id = ?', [plan.id])).total),
      1
    )
  } finally {
    await deleteReplyPlan(plan.id)
  }
})

test('CAS permite un solo worker y un retry continúa únicamente con las partes pendientes', async () => {
  const { plan } = await createReplyPlan('cas_resume')
  try {
    const claims = await Promise.all([
      claimConversationalReplyDelivery(plan.id, { nowMs: 10_000, leaseMs: 10_000, claimToken: 'claim_a' }),
      claimConversationalReplyDelivery(plan.id, { nowMs: 10_000, leaseMs: 10_000, claimToken: 'claim_b' })
    ])
    const winner = claims.find((claim) => claim.claimed)
    const loser = claims.find((claim) => !claim.claimed)
    assert.ok(winner)
    assert.ok(loser)
    assert.equal(claims.filter((claim) => claim.claimed).length, 1)
    assert.ok(['lease_active', 'claim_conflict'].includes(loser.reason))

    await checkpointConversationalReplyDelivery(plan.id, winner.claimToken, {
      partIndex: 0,
      status: 'sending',
      nowMs: 10_100,
      leaseMs: 10_000
    })
    const sent = await checkpointConversationalReplyDelivery(plan.id, winner.claimToken, {
      partIndex: 0,
      status: 'sent',
      providerMessageId: 'wamid_first_part',
      nowMs: 10_200,
      leaseMs: 10_000
    })
    const originalExternalIds = sent.plan.parts.map((part) => part.externalId)
    await settleConversationalReplyDelivery(plan.id, winner.claimToken, {
      status: 'pending',
      error: 'network_failed_before_next_send',
      nowMs: 10_300
    })

    const retry = await claimConversationalReplyDelivery(plan.id, {
      nowMs: 10_400,
      leaseMs: 10_000,
      claimToken: 'claim_retry'
    })
    assert.equal(retry.claimed, true)
    assert.deepEqual(retry.plan.parts.map((part) => part.status), ['sent', 'pending'])
    assert.deepEqual(retry.plan.parts.map((part) => part.externalId), originalExternalIds)
    assert.equal(retry.plan.parts[0].providerMessageId, 'wamid_first_part')

    await checkpointConversationalReplyDelivery(plan.id, retry.claimToken, {
      partIndex: 1,
      status: 'sending',
      nowMs: 10_500
    })
    await checkpointConversationalReplyDelivery(plan.id, retry.claimToken, {
      partIndex: 1,
      status: 'sent',
      providerMessageId: 'wamid_second_part',
      nowMs: 10_600
    })
    const completed = await settleConversationalReplyDelivery(plan.id, retry.claimToken, {
      status: 'completed',
      nowMs: 10_700
    })
    const terminalClaim = await claimConversationalReplyDelivery(plan.id, { nowMs: 20_000 })
    assert.equal(completed.status, 'completed')
    assert.equal(terminalClaim.claimed, false)
    assert.equal(terminalClaim.completed, true)
  } finally {
    await deleteReplyPlan(plan.id)
  }
})

test('un lease vencido con una parte sending queda ambiguous y jamás se reclama de nuevo', async () => {
  const { plan } = await createReplyPlan('ambiguous')
  try {
    const claim = await claimConversationalReplyDelivery(plan.id, {
      nowMs: 20_000,
      leaseMs: 1000,
      claimToken: 'claim_before_crash'
    })
    await checkpointConversationalReplyDelivery(plan.id, claim.claimToken, {
      partIndex: 0,
      status: 'sending',
      nowMs: 20_100,
      leaseMs: 1000
    })

    const recovery = await claimConversationalReplyDelivery(plan.id, {
      nowMs: 22_000,
      leaseMs: 1000,
      claimToken: 'claim_after_crash'
    })
    const secondRecovery = await claimConversationalReplyDelivery(plan.id, { nowMs: 30_000 })

    assert.equal(recovery.claimed, false)
    assert.equal(recovery.ambiguous, true)
    assert.equal(recovery.plan.status, 'ambiguous')
    assert.equal(recovery.plan.parts[0].status, 'ambiguous')
    assert.equal(recovery.plan.parts[1].status, 'pending')
    assert.equal(secondRecovery.claimed, false)
    assert.equal(secondRecovery.ambiguous, true)
  } finally {
    await deleteReplyPlan(plan.id)
  }
})

test('el JSON se guarda completo sobre 4 KB y rechaza planes mayores al límite seguro', async () => {
  const identity = replyIdentity('json_limit')
  const planId = buildConversationalReplyDeliveryPlanId(identity)
  try {
    const longText = `Inicio ${'á'.repeat(5000)} fin`
    const created = await getOrCreateConversationalReplyDeliveryPlan(identity, {
      reply: longText,
      parts: [longText],
      delaySchedule: [0]
    })
    const row = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [planId])
    assert.ok(Buffer.byteLength(row.detail_json, 'utf8') > 4000)
    assert.equal(JSON.parse(row.detail_json).parts[0].text, longText)
    assert.equal(created.plan.parts[0].text, longText)
  } finally {
    await deleteReplyPlan(planId)
  }

  const oversizedIdentity = replyIdentity('json_too_large')
  const oversizedPlanId = buildConversationalReplyDeliveryPlanId(oversizedIdentity)
  const oversizedText = 'x'.repeat(CONVERSATIONAL_REPLY_DELIVERY_MAX_DETAIL_BYTES)
  await assert.rejects(
    getOrCreateConversationalReplyDeliveryPlan(oversizedIdentity, {
      reply: oversizedText,
      parts: [oversizedText],
      delaySchedule: [0]
    }),
    (error) => error?.code === 'CONVERSATIONAL_REPLY_DELIVERY_PLAN_TOO_LARGE' && error?.statusCode === 413
  )
  assert.equal(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [oversizedPlanId]), null)
})
