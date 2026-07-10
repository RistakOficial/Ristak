import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'

const CONTACT_PREFIX = 'test_database_tx_'

async function removeContacts() {
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${CONTACT_PREFIX}%`]).catch(() => undefined)
}

test('transacciones concurrentes aíslan conexiones y enrutan helpers globales al mismo tx', async (t) => {
  await removeContacts()
  t.after(removeContacts)

  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => db.transaction(async (tx) => {
    const contactId = `${CONTACT_PREFIX}${index}`
    await tx.run(`
      INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `+5255500010${index}`, `${contactId}@transaction.test`, `Tx ${index}`])

    // Estas llamadas usan db global a propósito. AsyncLocalStorage debe
    // mantenerlas dentro de la conexión transaccional, no abrir otra.
    await db.run('UPDATE contacts SET full_name = ? WHERE id = ?', [`Tx global ${index}`, contactId])
    const visibleBeforeCommit = await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId])
    assert.equal(visibleBeforeCommit.full_name, `Tx global ${index}`)
    return contactId
  })))

  assert.equal(new Set(results).size, 4)
  const stored = await db.all(
    'SELECT id, full_name FROM contacts WHERE id LIKE ? ORDER BY id ASC',
    [`${CONTACT_PREFIX}%`]
  )
  assert.equal(stored.length, 4)
  stored.forEach((row, index) => assert.equal(row.full_name, `Tx global ${index}`))
})
