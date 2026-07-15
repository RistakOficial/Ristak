import assert from 'node:assert/strict'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

const normalizePlan = rows => rows
  .map(row => String(row.detail || row['QUERY PLAN'] || Object.values(row).join(' ')))
  .join('\n')

test('la proyección crea una fila por contacto y ordena actividad sin sort global', async (context) => {
  if (databaseDialect !== 'sqlite') {
    context.skip('prueba focal SQLite')
    return
  }

  await runVersionedMigrations()

  const total = 20_000
  await db.run('DROP TRIGGER IF EXISTS trg_contact_list_activity_contact_insert')
  await db.run(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO contacts(id, full_name, created_at, updated_at)
    SELECT
      printf('coverage-%08d', value),
      printf('Contacto %08d', value),
      datetime('2025-01-01', printf('+%d seconds', value)),
      datetime('2025-01-01', printf('+%d seconds', value))
    FROM sequence
  `, [total])

  // Simula una cuenta existente al instalar 109: no se toca el histórico en
  // la migración, lo completa el worker keyset en lotes.
  await db.run(`
    UPDATE crm_list_projection_state
    SET status = 'backfilling', processed_count = 0, generation = generation + 1
    WHERE projection_key = 'contact_rows'
  `)

  const projectionService = await import(
    `../src/services/crmListProjectionService.js?coverage=${Date.now()}-${Math.random()}`
  )
  const before = await projectionService.getContactListProjectionStatus({ schedule: false })
  assert.deepEqual(before, { available: true, coverageReady: false, ready: false })

  const result = await projectionService.runCrmListProjectionBackfill({ batchSize: 500, yieldMs: 0 })
  assert.equal(result.ready, true)
  assert.ok(result.processed >= total)

  const counts = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM contacts WHERE deleted_at IS NULL) AS contacts_count,
      (SELECT COUNT(*) FROM contact_list_activity) AS projection_count
  `)
  assert.equal(Number(counts.projection_count), Number(counts.contacts_count))

  const priorityPlan = normalizePlan(await db.all(`
    EXPLAIN QUERY PLAN
    SELECT c.id, cla.priority
    FROM contact_list_activity cla INDEXED BY idx_contact_list_activity_priority
    CROSS JOIN contacts c ON c.id = cla.contact_id
    WHERE c.deleted_at IS NULL
    ORDER BY cla.priority DESC, cla.contact_id DESC
    LIMIT 51
  `))
  assert.match(priorityPlan, /idx_contact_list_activity_priority/i)
  assert.doesNotMatch(priorityPlan, /USE TEMP B-TREE FOR ORDER BY/i)

  const createdPlan = normalizePlan(await db.all(`
    EXPLAIN QUERY PLAN
    SELECT c.id, c.created_at
    FROM contacts c INDEXED BY idx_contacts_cursor_created
    CROSS JOIN contact_list_activity cla ON cla.contact_id = c.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 51
  `))
  assert.match(createdPlan, /idx_contacts_cursor_created/i)
  assert.doesNotMatch(createdPlan, /USE TEMP B-TREE FOR ORDER BY/i)
})
