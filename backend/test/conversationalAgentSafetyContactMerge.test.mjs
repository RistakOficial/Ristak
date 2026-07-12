import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, databaseReady } from '../src/config/database.js'
import { mergeContactIds } from '../src/services/contactIdentityService.js'
import { applyConversationalAgentPreventiveMeasure } from '../src/services/conversationalAgentSafetyService.js'

await databaseReady

const temporaryPolicy = {
  id: 'merge-temporary',
  version: '1',
  quarantine: { mode: 'temporary', durationMinutes: 10 },
  notification: { enabled: false, audience: 'account_admins' }
}

const indefinitePolicy = {
  id: 'merge-indefinite',
  version: '1',
  quarantine: { mode: 'indefinite' },
  notification: { enabled: false, audience: 'human_review' }
}

async function cleanupContacts(contactIds) {
  for (const contactId of contactIds) {
    await db.run(`
      DELETE FROM conversational_agent_safety_audit
      WHERE case_id IN (SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?)
    `, [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_safety_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_safety_cases WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
}

test('fusionar contactos consolida casos safety y conserva la cuarentena activa más fuerte', async () => {
  const suffix = randomUUID()
  const sourceId = `safety_merge_source_${suffix}`
  const targetId = `safety_merge_target_${suffix}`
  const now = Date.parse('2026-07-11T22:00:00.000Z')
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
       VALUES (?, 'Origen', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sourceId, `+52656${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`]
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
       VALUES (?, 'Destino', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [targetId, `+52657${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`]
    )

    await applyConversationalAgentPreventiveMeasure({
      agentId: `agent_target_${suffix}`,
      contactId: targetId,
      channel: 'whatsapp',
      sourceMessageId: `message_target_${suffix}`,
      category: 'spam',
      severity: 'high',
      reason: 'Caso temporal del contacto sobreviviente.',
      serverPolicy: temporaryPolicy,
      now
    })
    const sourceMeasure = await applyConversationalAgentPreventiveMeasure({
      agentId: `agent_source_${suffix}`,
      contactId: sourceId,
      channel: 'whatsapp',
      sourceMessageId: `message_source_${suffix}`,
      category: 'phishing',
      severity: 'critical',
      reason: 'Caso crítico del contacto absorbido.',
      serverPolicy: indefinitePolicy,
      now: now + 1000
    })

    await mergeContactIds({ fromId: sourceId, toId: targetId })

    assert.equal(await db.get('SELECT id FROM contacts WHERE id = ?', [sourceId]), null)
    const cases = await db.all(
      'SELECT * FROM conversational_agent_safety_cases WHERE contact_id = ? AND channel = ?',
      [targetId, 'whatsapp']
    )
    assert.equal(cases.length, 1)
    assert.equal(cases[0].status, 'active')
    assert.equal(cases[0].block_mode, 'indefinite')
    assert.equal(cases[0].severity, 'critical')
    assert.equal(cases[0].category, 'phishing')
    assert.equal(Number(cases[0].event_count), 2)

    const events = await db.all(
      'SELECT case_id, contact_id FROM conversational_agent_safety_events WHERE contact_id = ?',
      [targetId]
    )
    assert.equal(events.length, 2)
    assert.ok(events.every(event => event.case_id === cases[0].id))
    const staleAudits = await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_safety_audit WHERE case_id = ?',
      [sourceMeasure.case.id]
    )
    assert.equal(Number(staleAudits?.total || 0), 0)
  } finally {
    await cleanupContacts([sourceId, targetId])
  }
})
