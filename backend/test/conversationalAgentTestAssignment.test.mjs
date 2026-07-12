import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, databaseReady } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import { setContactAssignment } from '../src/controllers/contactAssignmentController.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import {
  assignConversationalAgentTestContact,
  cleanupDueConversationalAgentTestAssignments,
  setConversationalAgentTestAssignmentDependenciesForTests
} from '../src/services/conversationalAgentTestAssignmentService.js'

await databaseReady
await runVersionedMigrations()

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 14)}`
}

async function createUser(label) {
  const username = uniqueId(`test_assignment_${label}`)
  await db.run(`
    INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
    VALUES (?, 'test-hash', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [username, `Usuario ${label}`])
  const row = await db.get('SELECT id FROM users WHERE username = ?', [username])
  return { id: String(row.id), username }
}

async function seedAssignmentEffect(label) {
  const previous = await createUser(`${label}_anterior`)
  const target = await createUser(`${label}_destino`)
  const manual = await createUser(`${label}_manual`)
  const contactId = uniqueId(`contact_${label}`)
  const agentId = uniqueId(`agent_${label}`)
  const runId = uniqueId(`run_${label}`)
  const effectId = uniqueId(`effect_${label}`)
  const messageId = uniqueId(`message_${label}`)

  await db.run(`
    INSERT INTO contacts (
      id, full_name, phone, assigned_user_id, source, created_at, updated_at
    ) VALUES (?, 'Contacto de prueba', ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [contactId, `+521${String(Date.now()).slice(-10)}`, previous.id])
  await db.run(`
    INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
    VALUES (?, 'Agente asignación test', 1, 'tool_calling_v2', '{}')
  `, [agentId])
  await db.run(`
    INSERT INTO conversational_agent_test_runs (
      id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
  `, [
    runId,
    agentId,
    previous.id,
    contactId,
    JSON.stringify({ enabled: true, assignUser: true }),
    new Date(Date.now() + 60 * 60 * 1000).toISOString()
  ])
  await db.run(`
    INSERT INTO conversational_agent_test_effects (
      id, run_id, message_id, effect_type, request_hash, status, payload_json
    ) VALUES (?, ?, ?, 'assignment', 'seed', 'processing', '{}')
  `, [effectId, runId, messageId])

  return {
    previous,
    target,
    manual,
    contactId,
    agentId,
    runId,
    effectId,
    requestedByUserId: previous.id
  }
}

async function removeFixture(fixture = {}) {
  if (fixture.effectId) {
    await db.run('DELETE FROM conversational_agent_test_assignments WHERE effect_id = ?', [fixture.effectId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [fixture.effectId]).catch(() => undefined)
  }
  if (fixture.runId) await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [fixture.runId]).catch(() => undefined)
  if (fixture.contactId) {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [fixture.contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [fixture.contactId]).catch(() => undefined)
  }
  if (fixture.agentId) await db.run('DELETE FROM conversational_agents WHERE id = ?', [fixture.agentId]).catch(() => undefined)
  if (fixture.contactId) await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => undefined)
  for (const user of [fixture.previous, fixture.target, fixture.manual]) {
    if (user?.username) await db.run('DELETE FROM users WHERE username = ?', [user.username]).catch(() => undefined)
  }
}

function assignmentInput(fixture, now) {
  return {
    effectId: fixture.effectId,
    testRunId: fixture.runId,
    agentId: fixture.agentId,
    requestedByUserId: fixture.requestedByUserId,
    contactId: fixture.contactId,
    targetUserId: fixture.target.id,
    now
  }
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

test('asigna y notifica de verdad una sola vez, luego restaura al responsable anterior a los cinco minutos', async () => {
  const fixture = await seedAssignmentEffect('restore')
  const now = Date.now()
  const notifications = []
  setConversationalAgentTestAssignmentDependenciesForTests({
    createInternalNotification: async payload => {
      notifications.push(payload)
      return { created: 1, ids: ['notification_test'], push: { sent: 1 } }
    }
  })

  try {
    const assigned = await assignConversationalAgentTestContact(assignmentInput(fixture, now))
    assert.equal(assigned.assigned, true)
    assert.equal(assigned.previousUserId, fixture.previous.id)
    assert.equal(assigned.targetUserId, fixture.target.id)
    assert.equal(assigned.cleanupDueAt, new Date(now + 5 * 60 * 1000).toISOString())

    const contact = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [fixture.contactId]
    )
    assert.equal(String(contact.assigned_user_id), fixture.target.id)
    assert.equal(contact.assignment_test_effect_id, fixture.effectId)
    assert.equal(notifications.length, 1)
    assert.deepEqual(notifications[0].recipientUserIds, [fixture.target.id])
    assert.equal(notifications[0].metadata.testMode, true)
    assert.equal(notifications[0].metadata.testEffectId, fixture.effectId)
    assert.match(notifications[0].title, /PRUEBA/)

    const replay = await assignConversationalAgentTestContact(assignmentInput(fixture, now))
    assert.equal(replay.assigned, true)
    assert.equal(notifications.length, 1)

    const tooSoon = await cleanupDueConversationalAgentTestAssignments({ now: now + 4 * 60 * 1000 })
    assert.equal(tooSoon.scanned, 0)
    const cleanup = await cleanupDueConversationalAgentTestAssignments({ now: now + 5 * 60 * 1000 + 1 })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(cleanup.results[0].restored, true)

    const restored = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [fixture.contactId]
    )
    assert.equal(String(restored.assigned_user_id), fixture.previous.id)
    assert.equal(restored.assignment_test_effect_id, null)
    const effect = await db.get(
      'SELECT status, cleanup_status FROM conversational_agent_test_effects WHERE id = ?',
      [fixture.effectId]
    )
    assert.equal(effect.status, 'cleaned')
    assert.equal(effect.cleanup_status, 'cleaned')
  } finally {
    setConversationalAgentTestAssignmentDependenciesForTests(null)
    await removeFixture(fixture)
  }
})

test('una reasignación humana quita la marca y la limpieza jamás la revierte', async () => {
  const fixture = await seedAssignmentEffect('manual')
  const now = Date.now()
  setConversationalAgentTestAssignmentDependenciesForTests({
    createInternalNotification: async () => ({ created: 1, ids: ['notification_test'], push: { sent: 1 } })
  })

  try {
    await assignConversationalAgentTestContact(assignmentInput(fixture, now))
    const res = mockResponse()
    await setContactAssignment({
      params: { id: fixture.contactId },
      body: { userId: fixture.manual.id }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.assignedUserId, fixture.manual.id)

    const humanChoice = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [fixture.contactId]
    )
    assert.equal(String(humanChoice.assigned_user_id), fixture.manual.id)
    assert.equal(humanChoice.assignment_test_effect_id, null)

    const cleanup = await cleanupDueConversationalAgentTestAssignments({ now: now + 5 * 60 * 1000 + 1 })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(cleanup.results[0].restored, false)
    assert.equal(cleanup.results[0].superseded, true)
    const finalContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [fixture.contactId])
    assert.equal(String(finalContact.assigned_user_id), fixture.manual.id)
  } finally {
    setConversationalAgentTestAssignmentDependenciesForTests(null)
    await removeFixture(fixture)
  }
})

test('también conserva una asignación externa aunque ese camino olvidara limpiar la marca CAS', async () => {
  const fixture = await seedAssignmentEffect('external')
  const now = Date.now()
  setConversationalAgentTestAssignmentDependenciesForTests({
    createInternalNotification: async () => ({ created: 1, ids: ['notification_test'], push: { sent: 1 } })
  })

  try {
    await assignConversationalAgentTestContact(assignmentInput(fixture, now))
    await db.run(
      'UPDATE contacts SET assigned_user_id = ? WHERE id = ?',
      [fixture.manual.id, fixture.contactId]
    )
    const cleanup = await cleanupDueConversationalAgentTestAssignments({ now: now + 5 * 60 * 1000 + 1 })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(cleanup.results[0].restored, false)
    assert.equal(cleanup.results[0].superseded, true)
    const contact = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [fixture.contactId]
    )
    assert.equal(String(contact.assigned_user_id), fixture.manual.id)
    assert.equal(contact.assignment_test_effect_id, null)
  } finally {
    setConversationalAgentTestAssignmentDependenciesForTests(null)
    await removeFixture(fixture)
  }
})

test('un handoff live del agente elimina la marca temporal aunque asigne al mismo contacto', async () => {
  const fixture = await seedAssignmentEffect('live_handoff')
  const now = Date.now()
  setConversationalAgentTestAssignmentDependenciesForTests({
    createInternalNotification: async () => ({ created: 1, ids: ['notification_test'], push: { sent: 1 } })
  })

  try {
    await assignConversationalAgentTestContact(assignmentInput(fixture, now))
    const ctx = {
      runtimeMode: 'tool_calling_v2',
      contactId: fixture.contactId,
      agentId: fixture.agentId,
      channel: 'whatsapp',
      dryRun: false,
      followUpMode: false,
      executionId: uniqueId('handoff_execution'),
      actions: [],
      accountLocale: { currency: 'MXN' },
      config: {
        id: fixture.agentId,
        runtimeMode: 'tool_calling_v2',
        objective: 'custom',
        capabilitiesConfig: {
          schemaVersion: 2,
          items: [{
            id: 'handoff_human',
            enabled: true,
            userId: fixture.manual.id,
            userName: 'Usuario manual'
          }]
        }
      }
    }
    const handoff = createConversationalTools(ctx).find(tool => tool.name === 'send_to_human')
    assert.ok(handoff)
    const result = await handoff.invoke(null, JSON.stringify({
      motivo: 'Validar asignación live',
      resumen: 'Prueba de precedencia sobre el tester'
    }))
    assert.equal(result.ok, true, JSON.stringify(result))

    const liveChoice = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [fixture.contactId]
    )
    assert.equal(String(liveChoice.assigned_user_id), fixture.manual.id)
    assert.equal(liveChoice.assignment_test_effect_id, null)

    const cleanup = await cleanupDueConversationalAgentTestAssignments({ now: now + 5 * 60 * 1000 + 1 })
    assert.equal(cleanup.cleaned, 1)
    assert.equal(cleanup.results[0].superseded, true)
    const finalContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [fixture.contactId])
    assert.equal(String(finalContact.assigned_user_id), fixture.manual.id)
  } finally {
    setConversationalAgentTestAssignmentDependenciesForTests(null)
    await removeFixture(fixture)
  }
})
