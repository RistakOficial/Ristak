import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { updateContactsStats } from '../src/utils/updateContactsStats.js'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

test('updateContactsStats recalcula en lotes y conserva estadisticas correctas', async () => {
  const runId = suffix()
  const contactIds = [1, 2, 3].map(value => `stats_batch_${runId}_${value}`)
  const paymentIds = [1, 2, 3].map(value => `stats_batch_payment_${runId}_${value}`)

  try {
    for (const contactId of contactIds) {
      await db.run(
        `INSERT INTO contacts (
          id, full_name, total_paid, purchases_count, last_purchase_date, created_at, updated_at
        ) VALUES (?, ?, 999, 999, '2020-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId, `Contacto ${contactId}`]
      )
    }

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, date, created_at
      ) VALUES (?, ?, 120, 'MXN', 'paid', 'live', '2026-01-01T10:00:00.000Z', CURRENT_TIMESTAMP)`,
      [paymentIds[0], contactIds[0]]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, date, created_at
      ) VALUES (?, ?, 80, 'MXN', 'succeeded', 'live', '2026-01-02T10:00:00.000Z', CURRENT_TIMESTAMP)`,
      [paymentIds[1], contactIds[0]]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, date, created_at
      ) VALUES (?, ?, 50, 'MXN', 'refunded', 'live', '2026-01-03T10:00:00.000Z', CURRENT_TIMESTAMP)`,
      [paymentIds[2], contactIds[1]]
    )

    const result = await updateContactsStats({ batchSize: 2 })
    assert.equal(result.batchSize, 2)
    assert.ok(result.processed >= contactIds.length)

    const rows = await db.all(
      `SELECT id, total_paid, purchases_count, last_purchase_date
       FROM contacts
       WHERE id IN (?, ?, ?)
       ORDER BY id`,
      contactIds
    )

    assert.equal(Number(rows[0].total_paid), 200)
    assert.equal(Number(rows[0].purchases_count), 2)
    assert.equal(rows[0].last_purchase_date, '2026-01-02T10:00:00.000Z')
    assert.equal(Number(rows[1].total_paid), 0)
    assert.equal(Number(rows[1].purchases_count), 0)
    assert.equal(rows[1].last_purchase_date, null)
    assert.equal(Number(rows[2].total_paid), 0)
    assert.equal(Number(rows[2].purchases_count), 0)
  } finally {
    await db.run('DELETE FROM payments WHERE id IN (?, ?, ?)', paymentIds).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?, ?)', contactIds).catch(() => undefined)
  }
})

test('sync HighLevel no dispara barrido global de estadisticas al final', () => {
  const highLevelSource = readFileSync(new URL('../src/services/highlevelSyncService.js', import.meta.url), 'utf8')
  const statsSource = readFileSync(new URL('../src/utils/updateContactsStats.js', import.meta.url), 'utf8')

  assert.doesNotMatch(highLevelSource, /updateContactsStats\(\)/)
  assert.match(statsSource, /SELECT id\s+FROM contacts\s+WHERE id > \?/)
  assert.match(statsSource, /WHERE id IN \(\$\{placeholders\}\)/)
  assert.doesNotMatch(statsSource, /await db\.run\(updateQuery\)\s*\n\s*\/\/ Obtener estadísticas actualizadas/)
})
