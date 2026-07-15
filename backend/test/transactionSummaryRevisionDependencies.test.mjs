import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

test('la revisión de transacciones sigue campos de búsqueda y teléfonos alternos', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await runVersionedMigrations()
  const suffix = randomUUID()
  const contactId = `txn-revision-contact-${suffix}`
  const paymentId = `txn-revision-payment-${suffix}`
  const phoneId = `txn-revision-phone-${suffix}`

  const revision = async () => Number((await db.get(
    "SELECT revision FROM payment_list_revisions WHERE scope = 'transactions'"
  ))?.revision || 0)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, email, phone, source,
        attribution_session_source, created_at, updated_at
      ) VALUES (?, 'Nombre viejo', 'Nombre', 'Viejo', ?, '5550000000', 'manual',
        'direct', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `${suffix}@revision.invalid`])
    await db.run(`
      INSERT INTO contact_phone_numbers (id, contact_id, phone, is_primary, created_at, updated_at)
      VALUES (?, ?, '5551111111', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [phoneId, contactId])
    await db.run(`
      INSERT INTO payments (id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
      VALUES (?, ?, 10, 'paid', 'live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [paymentId, contactId])

    const before = await revision()
    await db.run(`
      UPDATE contacts
      SET first_name = 'Nuevo', last_name = 'Nombre', phone = '5552222222',
          source = 'referido', attribution_session_source = 'facebook'
      WHERE id = ?
    `, [contactId])
    assert.equal(await revision(), before + 1)

    await db.run('UPDATE contact_phone_numbers SET phone = ? WHERE id = ?', ['5553333333', phoneId])
    assert.equal(await revision(), before + 2)
    await db.run('DELETE FROM contact_phone_numbers WHERE id = ?', [phoneId])
    assert.equal(await revision(), before + 3)

    await db.run('UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [contactId])
    assert.equal(await revision(), before + 3)
  } finally {
    await db.run('DELETE FROM contact_phone_numbers WHERE id = ?', [phoneId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
