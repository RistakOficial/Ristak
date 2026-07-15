import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import { mergeContactIds } from '../src/services/contactIdentityService.js'
import { acquireConversationalInboundCommitLock } from '../src/services/conversationalInboundCommitLockService.js'

await databaseReady

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('SQLite no permite que un merge mueva un inbound entre el fence final y el INSERT de cita', async () => {
  const suffix = randomUUID()
  const sourceId = `merge_lock_source_${suffix}`
  const targetId = `merge_lock_target_${suffix}`
  const messageId = `merge_lock_message_${suffix}`
  const appointmentId = `merge_lock_appointment_${suffix}`
  let releaseTerminal
  let terminalStarted
  let terminalPromise = null
  let mergePromise = null
  const terminalReleaseGate = new Promise(resolve => { releaseTerminal = resolve })
  const terminalStartedGate = new Promise(resolve => { terminalStarted = resolve })

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
       VALUES (?, 'Origen merge lock', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sourceId, `+52656${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`]
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
       VALUES (?, 'Destino merge lock', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [targetId, `+52657${Math.floor(Math.random() * 10_000_000).toString().padStart(7, '0')}`]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
         id, contact_id, direction, message_type, message_text, message_timestamp
       ) VALUES (?, ?, 'inbound', 'text', 'fecha corregida', CURRENT_TIMESTAMP)`,
      [messageId, sourceId]
    )

    terminalPromise = db.transaction(async (transactionDatabase) => {
      await acquireConversationalInboundCommitLock({
        contactId: targetId,
        channel: 'whatsapp',
        database: transactionDatabase,
        dialect: 'sqlite'
      })
      const newerAtTarget = await transactionDatabase.get(
        'SELECT id FROM whatsapp_api_messages WHERE id = ? AND contact_id = ?',
        [messageId, targetId]
      )
      assert.equal(newerAtTarget, null)
      terminalStarted()
      await terminalReleaseGate
      await transactionDatabase.run(
        `INSERT INTO appointments (id, contact_id, title, status, start_time, end_time)
         VALUES (?, ?, 'Cita protegida', 'confirmed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [appointmentId, targetId]
      )
    })

    await Promise.race([
      terminalStartedGate,
      terminalPromise.then(
        () => { throw new Error('La transacción terminal terminó antes de abrir su fence') },
        error => { throw error }
      )
    ])
    let mergeSettled = false
    mergePromise = mergeContactIds({ fromId: sourceId, toId: targetId })
      .finally(() => { mergeSettled = true })

    await delay(75)
    assert.equal(mergeSettled, false)

    releaseTerminal()
    await terminalPromise
    await mergePromise

    assert.equal((await db.get(
      'SELECT contact_id FROM whatsapp_api_messages WHERE id = ?',
      [messageId]
    ))?.contact_id, targetId)
    assert.equal((await db.get(
      'SELECT contact_id FROM appointments WHERE id = ?',
      [appointmentId]
    ))?.contact_id, targetId)
    assert.equal(await db.get('SELECT id FROM contacts WHERE id = ?', [sourceId]), null)
  } finally {
    releaseTerminal?.()
    await terminalPromise?.catch(() => undefined)
    await mergePromise?.catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [messageId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [sourceId, targetId]).catch(() => undefined)
  }
})
