import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, databaseReady } from '../src/config/database.js'

await databaseReady

test('SQLite aplica foreign_keys tanto en la conexión principal como dentro de transacciones', {
  skip: Boolean(process.env.DATABASE_URL)
}, async () => {
  const globalPragma = await db.get('PRAGMA foreign_keys')
  assert.equal(Number(globalPragma?.foreign_keys), 1)

  const transactionPragma = await db.transaction(tx => tx.get('PRAGMA foreign_keys'))
  assert.equal(Number(transactionPragma?.foreign_keys), 1)
})

test('appointment_participants no deja huérfanos con DELETE directo, dentro o fuera de transacción', {
  skip: Boolean(process.env.DATABASE_URL)
}, async () => {
  const contactId = `fk_contact_${randomUUID()}`
  const appointmentIds = [`fk_appt_${randomUUID()}`, `fk_appt_${randomUUID()}`]
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto FK', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    for (const appointmentId of appointmentIds) {
      await db.run(
        `INSERT INTO appointments (id, contact_id, start_time, end_time)
         VALUES (?, ?, '2026-07-11T20:00:00.000Z', '2026-07-11T21:00:00.000Z')`,
        [appointmentId, contactId]
      )
      await db.run(
        `INSERT INTO appointment_participants (id, appointment_id, role, position, contact_id)
         VALUES (?, ?, 'requester', 0, ?)`,
        [`fk_participant_${randomUUID()}`, appointmentId, contactId]
      )
    }

    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentIds[0]])
    await db.transaction(async tx => {
      await tx.run('DELETE FROM appointments WHERE id = ?', [appointmentIds[1]])
    })

    const remaining = await db.get(
      `SELECT COUNT(*) AS total FROM appointment_participants
       WHERE appointment_id IN (?, ?)`,
      appointmentIds
    )
    assert.equal(Number(remaining?.total || 0), 0)
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id IN (?, ?)', appointmentIds).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', appointmentIds).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
