import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

await runVersionedMigrations()

test('migración de reingreso libera el historial y conserva una sola ejecución activa', async () => {
  const suffix = randomUUID()
  const automationId = `migration_reentry_${suffix}`
  const contactId = `migration_contact_${suffix}`

  try {
    const indexes = await db.all('PRAGMA index_list(automation_enrollments)')
    assert.equal(
      indexes.some((index) => index.name === 'uq_automation_enrollments_auto_contact'),
      false
    )
    assert.equal(
      indexes.some((index) => index.name === 'uq_automation_enrollments_active_contact' && Number(index.unique) === 1),
      true
    )

    await db.run(
      `INSERT INTO automation_enrollments
         (id, automation_id, contact_id, dedupe_contact_id, status, current_node_id, log, context)
       VALUES (?, ?, ?, ?, 'completed', 'done', '[]', '{}')`,
      [`enrollment_history_${suffix}`, automationId, contactId, contactId]
    )
    await db.run(
      `INSERT INTO automation_enrollments
         (id, automation_id, contact_id, dedupe_contact_id, status, current_node_id, log, context)
       VALUES (?, ?, ?, ?, 'waiting', 'wait', '[]', '{}')`,
      [`enrollment_active_${suffix}`, automationId, contactId, contactId]
    )

    await assert.rejects(
      db.run(
        `INSERT INTO automation_enrollments
           (id, automation_id, contact_id, dedupe_contact_id, status, current_node_id, log, context)
         VALUES (?, ?, ?, ?, 'active', 'start', '[]', '{}')`,
        [`enrollment_duplicate_${suffix}`, automationId, contactId, contactId]
      ),
      /unique/i
    )

    await db.run(
      `UPDATE automation_enrollments
       SET status = 'completed'
       WHERE id = ?`,
      [`enrollment_active_${suffix}`]
    )
    await db.run(
      `INSERT INTO automation_enrollments
         (id, automation_id, contact_id, dedupe_contact_id, status, current_node_id, log, context)
       VALUES (?, ?, ?, ?, 'active', 'start', '[]', '{}')`,
      [`enrollment_reentry_${suffix}`, automationId, contactId, contactId]
    )
  } finally {
    await db.run(
      'DELETE FROM automation_enrollments WHERE automation_id = ?',
      [automationId]
    )
  }
})
