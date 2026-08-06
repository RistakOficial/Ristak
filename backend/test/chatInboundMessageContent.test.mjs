import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getContactJourney } from '../src/controllers/contactsController.js'

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

test('el journey repara formatos históricos y marca contenido retenido por WhatsApp', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_content_${suffix}`
  const phone = `+52656${Date.now().toString().slice(-7)}`
  const unsupportedId = `waapi_msg_unsupported_${suffix}`
  const editId = `waapi_msg_edit_${suffix}`

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, first_name, source)
      VALUES (?, ?, 'Prueba formatos', 'Prueba', 'WhatsApp_API')
    `, [contactId, phone])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, provider_message_id, contact_id, phone, from_phone,
        business_phone, transport, direction, message_type, message_text,
        status, error_code, error_message, raw_payload_json, message_timestamp
      ) VALUES (?, 'meta_direct', ?, ?, ?, ?, '+526561000001', 'api', 'inbound',
        'unsupported', '', 'received', '131051', 'Message type unknown', ?, '2026-08-06T18:00:00.000Z')
    `, [
      unsupportedId,
      `wamid.unsupported.${suffix}`,
      contactId,
      phone,
      phone,
      JSON.stringify({ type: 'unsupported', unsupported: { type: 'unknown' } })
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, provider_message_id, contact_id, phone, from_phone,
        business_phone, transport, direction, message_type, message_text,
        status, raw_payload_json, message_timestamp
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, '+526561000001', 'api', 'inbound',
        'edit', '', 'received', ?, '2026-08-06T18:01:00.000Z')
    `, [
      editId,
      `wamid.edit.${suffix}`,
      contactId,
      phone,
      phone,
      JSON.stringify({
        type: 'edit',
        edit: { message: { type: 'text', text: { body: 'Texto editado desde historial' } } }
      })
    ])

    const res = createMockResponse()
    await getContactJourney({
      params: { id: contactId },
      query: {
        chatMessagesOnly: 'true',
        includeBusinessMessages: 'true',
        messageLimit: '20',
        refreshExternalStatuses: 'false'
      },
      user: { id: `user_${suffix}` }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    const events = res.body.data.filter(event => event.type === 'whatsapp_message')
    const unsupported = events.find(event => event.data.whatsapp_api_message_id === unsupportedId)
    const edited = events.find(event => event.data.whatsapp_api_message_id === editId)

    assert.equal(unsupported?.data.content_unavailable, 1)
    assert.equal(unsupported?.data.error_code, '131051')
    assert.equal(edited?.data.message_text, 'Texto editado desde historial')
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id IN (?, ?)', [unsupportedId, editId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
