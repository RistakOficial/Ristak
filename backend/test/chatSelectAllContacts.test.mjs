import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getChatContacts } from '../src/controllers/contactsController.js'

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function cleanup(contactIds) {
  for (const contactId of contactIds) {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
}

test('idsOnly devuelve todas las conversaciones aunque limit sea menor', async () => {
  const suffix = randomUUID()
  const firstContactId = `select_all_first_${suffix}`
  const secondContactId = `select_all_second_${suffix}`
  const contactWithoutChatId = `select_all_no_chat_${suffix}`
  const deletedContactId = `select_all_deleted_${suffix}`
  const contactIds = [firstContactId, secondContactId, contactWithoutChatId, deletedContactId]

  await cleanup(contactIds)

  try {
    for (const [index, contactId] of contactIds.entries()) {
      await db.run(`
        INSERT INTO contacts (id, full_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `, [
        contactId,
        `Contacto seleccion ${index + 1}`,
        `2099-07-14T12:0${index}:00.000Z`,
        `2099-07-14T12:0${index}:00.000Z`
      ])
    }
    await db.run(
      'UPDATE contacts SET deleted_at = ? WHERE id = ?',
      ['2099-07-14T12:05:00.000Z', deletedContactId]
    )

    for (const [index, contactId] of [firstContactId, secondContactId, deletedContactId].entries()) {
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, contact_id, provider, transport, direction, message_type,
          message_text, message_timestamp, created_at, updated_at
        ) VALUES (?, ?, 'ycloud', 'api', 'inbound', 'text', ?, ?, ?, ?)
      `, [
        `select_all_message_${index}_${suffix}`,
        contactId,
        `Mensaje ${index + 1}`,
        `2099-07-14T12:1${index}:00.000Z`,
        `2099-07-14T12:1${index}:00.000Z`,
        `2099-07-14T12:1${index}:00.000Z`
      ])
    }

    const response = createMockResponse()
    await getChatContacts({
      query: { idsOnly: 'true', limit: '1' },
      user: { id: `select_all_user_${suffix}` }
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body?.success, true)
    assert.ok(Array.isArray(response.body?.data))
    assert.ok(response.body.data.every(value => typeof value === 'string'))
    assert.ok(response.body.data.includes(firstContactId))
    assert.ok(response.body.data.includes(secondContactId))
    assert.equal(response.body.data.includes(contactWithoutChatId), false)
    assert.equal(response.body.data.includes(deletedContactId), false)
  } finally {
    await cleanup(contactIds)
  }
})
