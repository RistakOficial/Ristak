import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  buildApprovedLearningContextMessage,
  generateConversationalLearningVersion,
  getApprovedConversationalLearning,
  getConversationalPolicyVersion,
  listConversationalLearningVersions,
  listConversationalPolicyVersions,
  recordConversationalPolicyVersion,
  reviewConversationalLearningVersion
} from '../src/agents/conversational/intelligence/governance.js'

const suffix = randomUUID()
const agentId = `cagent_governance_${suffix}`

async function insertEvent(type, detail = {}) {
  await db.run(`
    INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
    VALUES (?, NULL, ?, ?, ?)
  `, [`cae_governance_${randomUUID()}`, agentId, type, JSON.stringify({ agentId, ...detail })])
}

test.before(async () => {
  await db.run(`
    INSERT INTO conversational_agents (id, name, enabled, objective, success_action)
    VALUES (?, 'Gobernanza', 0, 'datos', 'ready_for_human')
  `, [agentId])
})

test.after(async () => {
  await db.run('DELETE FROM conversational_agent_learning_versions WHERE agent_id = ?', [agentId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agentId]).catch(() => {})
  await db.run("DELETE FROM conversational_agent_events WHERE detail_json LIKE ?", [`%${agentId}%`]).catch(() => {})
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
})

test('versiona políticas, oculta secretos y permite recuperar una versión anterior', async () => {
  const first = await recordConversationalPolicyVersion({
    agentId,
    configSnapshot: { name: 'Gobernanza', objective: 'datos', apiKey: 'no-debe-guardarse' },
    compiledPolicy: { hash: `hash_a_${suffix}`, objective: { type: 'datos' }, validation: { valid: true } }
  })
  const second = await recordConversationalPolicyVersion({
    agentId,
    configSnapshot: { name: 'Gobernanza v2', objective: 'filtrar' },
    compiledPolicy: { hash: `hash_b_${suffix}`, objective: { type: 'filtrar' }, validation: { valid: true } }
  })

  assert.equal(first.version, 1)
  assert.equal(first.configSnapshot.apiKey, undefined)
  assert.equal(second.version, 2)
  assert.equal(second.active, true)

  const versions = await listConversationalPolicyVersions(agentId)
  assert.equal(versions.length, 2)
  assert.equal(versions[0].active, true)
  assert.equal(versions[1].active, false)
  assert.equal((await getConversationalPolicyVersion(agentId, first.id)).policyHash, first.policyHash)

  const rollback = await recordConversationalPolicyVersion({
    agentId,
    configSnapshot: first.configSnapshot,
    compiledPolicy: { ...first.compiledPolicy, hash: first.policyHash },
    source: 'rollback'
  })
  assert.equal(rollback.version, 3)
  assert.equal(rollback.source, 'rollback')
  assert.equal(rollback.active, true)
})

test('un snapshot aprendido requiere revisión humana antes de entrar al contexto', async () => {
  await insertEvent('follow_up_sent')
  await insertEvent('follow_up_suppressed')
  await insertEvent('follow_up_suppressed')

  const proposed = await generateConversationalLearningVersion({ agentId, basePolicyHash: `hash_b_${suffix}` })
  assert.equal(proposed.status, 'proposed')
  assert.equal(proposed.snapshot.proposals[0]?.kind, 'follow_up_review')
  assert.equal(buildApprovedLearningContextMessage(proposed), null)

  const approved = await reviewConversationalLearningVersion({
    agentId,
    learningId: proposed.id,
    decision: 'approved',
    reviewedBy: 'user_test'
  })
  assert.equal(approved.status, 'approved')
  assert.match(buildApprovedLearningContextMessage(approved)?.content || '', /aprendizaje de esta cuenta/i)
  assert.equal((await getApprovedConversationalLearning(agentId)).id, proposed.id)
  assert.equal((await listConversationalLearningVersions(agentId)).length, 1)
})

test('una propuesta que tocaría configuración crítica no puede aprobarse', async () => {
  await insertEvent('reply_sent')
  await insertEvent('calendar_error')
  await insertEvent('payment_link_failed')

  const proposed = await generateConversationalLearningVersion({ agentId, basePolicyHash: `hash_b_${suffix}` })
  assert.ok(proposed.snapshot.proposals.some((proposal) => proposal.kind === 'configuration_review'))
  const unsafeSnapshot = {
    ...proposed.snapshot,
    proposals: [{
      kind: 'automatic_change',
      title: 'Cambiar precio',
      rationale: 'Una conversión aislada.',
      suggestedChange: 'Subir el monto automáticamente.',
      risk: 'high'
    }]
  }
  await db.run('UPDATE conversational_agent_learning_versions SET snapshot_json = ? WHERE id = ?', [
    JSON.stringify(unsafeSnapshot),
    proposed.id
  ])

  await assert.rejects(
    reviewConversationalLearningVersion({
      agentId,
      learningId: proposed.id,
      decision: 'approved',
      reviewedBy: 'user_test'
    }),
    (error) => error?.code === 'UNSAFE_LEARNING_PROPOSAL'
  )
})
