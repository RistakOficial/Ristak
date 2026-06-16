import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  db,
  repairWhatsAppApiContactIdentityFromMessages
} from '../src/config/database.js'
import {
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName
} from '../src/utils/whatsappContactProfile.js'

async function cleanup({ contactId, apiContactId, messageId, phone }) {
  await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ? OR contact_id = ? OR phone = ?', [apiContactId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

test('normaliza nombres reales de YCloud y descarta los genéricos', () => {
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp_API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('+524433948272', '+524433948272'), '')
  assert.equal(extractWhatsAppProfileName({
    customerProfile: {
      name: 'Ana López',
      username: '@ana'
    }
  }, '+524433948272'), 'Ana López')
})

test('repara contactos importados de WhatsApp API con nombre y primera fecha del historial', async () => {
  const id = randomUUID()
  const phone = `+52999${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_test_${id}`
  const realMessageAt = '2024-02-03T04:05:06.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Contacto WhatsApp API',
      'Contacto WhatsApp API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Contacto WhatsApp_API',
      JSON.stringify({ nickname: 'Contacto WhatsApp API' }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z',
      1,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, origin, ycloud_message_id, whatsapp_api_contact_id,
        contact_id, phone, from_phone, to_phone, direction, message_type,
        message_text, status, message_timestamp, raw_payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      messageId,
      'ycloud',
      'whatsapp.smb.history',
      'ycloud_history_1',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Hola',
      'received',
      realMessageAt,
      JSON.stringify({
        id: 'ycloud_history_1',
        customerProfile: { name: 'Ana López', username: '@ana' },
        from: phone,
        to: '+526561000000',
        sendTime: realMessageAt,
        type: 'text',
        text: { body: 'Hola' }
      }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)
    assert.ok(repaired.apiContacts >= 1)

    const contact = await db.get('SELECT full_name, first_name, created_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')
    assert.equal(new Date(contact.created_at).toISOString(), realMessageAt)

    const apiContact = await db.get('SELECT profile_name, first_seen_at FROM whatsapp_api_contacts WHERE id = ?', [apiContactId])
    assert.equal(apiContact.profile_name, 'Ana López')
    assert.equal(new Date(apiContact.first_seen_at).toISOString(), realMessageAt)
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
  }
})
