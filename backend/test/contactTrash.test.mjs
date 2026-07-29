import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  emptyContactTrash,
  getTrashedContacts
} from '../src/controllers/contactsController.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function callController(handler, req = {}) {
  const response = createResponse()
  await handler({
    params: {},
    query: {},
    body: {},
    user: null,
    ...req
  }, response)
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.equal(response.body?.success, true)
  return response.body
}

async function insertContact({
  id,
  fullName,
  email,
  phone,
  deletedAt = null
}) {
  await db.run(
    `INSERT INTO contacts (
      id, full_name, email, phone, source, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'contact_trash_test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, fullName, email, phone, deletedAt]
  )
}

test('la papelera busca en toda la base sin sensibilidad a mayúsculas, acentos ni formato telefónico', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const accentId = `trash_accent_${suffix}`
  const emailId = `trash_email_${suffix}`
  const phoneId = `trash_phone_${suffix}`
  const activeId = `trash_active_${suffix}`
  const ids = [accentId, emailId, phoneId, activeId]

  try {
    await insertContact({
      id: accentId,
      fullName: 'ÁNGELA Núñez',
      email: `${suffix}@accent.invalid`,
      phone: '+525500000001',
      deletedAt: '2099-08-01T10:00:00.000Z'
    })
    await insertContact({
      id: emailId,
      fullName: 'Correo de prueba',
      email: `Contacto.${suffix}@Example.COM`,
      phone: '+525500000002',
      deletedAt: '2099-08-01T11:00:00.000Z'
    })
    await insertContact({
      id: phoneId,
      fullName: 'Teléfono de prueba',
      email: `${suffix}@phone.invalid`,
      phone: '+526567825555',
      deletedAt: '2099-08-01T12:00:00.000Z'
    })
    await insertContact({
      id: activeId,
      fullName: 'Ángela activa',
      email: `${suffix}@active.invalid`,
      phone: '+526567825556',
      deletedAt: null
    })

    const byName = await callController(getTrashedContacts, {
      query: { search: 'angela nunez', limit: '1' }
    })
    assert.deepEqual(byName.contacts.map(contact => contact.id), [accentId])
    assert.equal(byName.total, 3)
    assert.equal(byName.returned, 1)

    const byEmail = await callController(getTrashedContacts, {
      query: { search: `CONTACTO.${suffix}@example.com` }
    })
    assert.deepEqual(byEmail.contacts.map(contact => contact.id), [emailId])

    const byPhone = await callController(getTrashedContacts, {
      query: { search: '(656) 782-5555' }
    })
    assert.deepEqual(byPhone.contacts.map(contact => contact.id), [phoneId])
  } finally {
    await db.run(
      `DELETE FROM contacts WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids
    ).catch(() => undefined)
  }
})

test('vaciar la papelera es transaccional, conserva pagos y no toca contactos activos', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const firstTrashId = `trash_empty_first_${suffix}`
  const secondTrashId = `trash_empty_second_${suffix}`
  const activeId = `trash_empty_active_${suffix}`
  const firstPaymentId = `trash_payment_first_${suffix}`
  const secondPaymentId = `trash_payment_second_${suffix}`
  const activePaymentId = `trash_payment_active_${suffix}`
  const actorId = `trash_actor_${suffix}`
  const messageIds = [
    `trash_claim_first_${suffix}`,
    `trash_claim_second_${suffix}`,
    `trash_claim_active_${suffix}`
  ]

  try {
    await insertContact({
      id: firstTrashId,
      fullName: 'Papelera Uno',
      email: `${suffix}.one@test.invalid`,
      phone: '+525511111111',
      deletedAt: '2099-08-02T10:00:00.000Z'
    })
    await insertContact({
      id: secondTrashId,
      fullName: 'Papelera Dos',
      email: `${suffix}.two@test.invalid`,
      phone: '+525522222222',
      deletedAt: '2099-08-02T11:00:00.000Z'
    })
    await insertContact({
      id: activeId,
      fullName: 'Contacto activo',
      email: `${suffix}.active@test.invalid`,
      phone: '+525533333333'
    })

    for (const [paymentId, contactId] of [
      [firstPaymentId, firstTrashId],
      [secondPaymentId, secondTrashId],
      [activePaymentId, activeId]
    ]) {
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_mode, date, created_at, updated_at
        ) VALUES (?, ?, 100, 'MXN', 'paid', 'live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, contactId]
      )
    }

    for (const [messageId, contactId] of [
      [messageIds[0], firstTrashId],
      [messageIds[1], secondTrashId],
      [messageIds[2], activeId]
    ]) {
      await db.run(
        `INSERT INTO chat_inbound_message_claims (
          channel, message_id, contact_id, message_timestamp
        ) VALUES ('whatsapp', ?, ?, CURRENT_TIMESTAMP)`,
        [messageId, contactId]
      )
    }

    const result = await callController(emptyContactTrash, {
      user: { id: actorId, email: `${actorId}@test.invalid` }
    })
    assert.equal(result.deleted, 2)

    const remainingContacts = await db.all(
      `SELECT id FROM contacts
       WHERE id IN (?, ?, ?)
       ORDER BY id`,
      [firstTrashId, secondTrashId, activeId]
    )
    assert.deepEqual(remainingContacts.map(contact => contact.id), [activeId])

    const payments = await db.all(
      `SELECT id, contact_id
       FROM payments
       WHERE id IN (?, ?, ?)
       ORDER BY id`,
      [firstPaymentId, secondPaymentId, activePaymentId]
    )
    const paymentById = new Map(payments.map(payment => [payment.id, payment]))
    assert.equal(paymentById.get(firstPaymentId)?.contact_id, null)
    assert.equal(paymentById.get(secondPaymentId)?.contact_id, null)
    assert.equal(paymentById.get(activePaymentId)?.contact_id, activeId)

    const claims = await db.all(
      `SELECT message_id, contact_id
       FROM chat_inbound_message_claims
       WHERE message_id IN (?, ?, ?)
       ORDER BY message_id`,
      messageIds
    )
    assert.deepEqual(claims, [{ message_id: messageIds[2], contact_id: activeId }])

    const repeated = await callController(emptyContactTrash, {
      user: { id: actorId, email: `${actorId}@test.invalid` }
    })
    assert.equal(repeated.deleted, 0)
  } finally {
    await db.run(
      `DELETE FROM chat_inbound_message_claims WHERE message_id IN (?, ?, ?)`,
      messageIds
    ).catch(() => undefined)
    await db.run(
      `DELETE FROM payments WHERE id IN (?, ?, ?)`,
      [firstPaymentId, secondPaymentId, activePaymentId]
    ).catch(() => undefined)
    await db.run(
      `DELETE FROM contacts WHERE id IN (?, ?, ?)`,
      [firstTrashId, secondTrashId, activeId]
    ).catch(() => undefined)
    await db.run('DELETE FROM audit_log WHERE actor_user_id = ?', [actorId]).catch(() => undefined)
  }
})
