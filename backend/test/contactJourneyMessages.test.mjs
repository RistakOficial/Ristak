import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getChatContacts, getContactJourney } from '../src/controllers/contactsController.js'

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

async function readJourney(contactId, query = {}) {
  const res = createMockResponse()
  await getContactJourney({ params: { id: contactId }, query }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function readChatContacts(query = {}) {
  const res = createMockResponse()
  await getChatContacts({ query }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function cleanup(contactId, phone) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

test('contact journey defaults to contact-authored messages only', async () => {
  const id = randomUUID()
  const contactId = `journey_msg_${id}`
  const phone = `+52991${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Journey',
      'Cliente',
      'manual',
      '2026-06-16T10:00:00.000Z',
      '2026-06-16T10:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_inbound_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'text',
      'Mensaje del contacto',
      '2026-06-16T10:01:00.000Z',
      '2026-06-16T10:01:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_outbound_${id}`,
      contactId,
      phone,
      '+526561000000',
      phone,
      '+526561000000',
      'api',
      'outbound',
      'text',
      'Mensaje del negocio',
      '2026-06-16T10:02:00.000Z',
      '2026-06-16T10:02:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_echo_${id}`,
      contactId,
      phone,
      '+526561000000',
      phone,
      '+526561000000',
      'api',
      'business_echo',
      'text',
      'Eco del negocio',
      '2026-06-16T10:03:00.000Z',
      '2026-06-16T10:03:00.000Z'
    ])

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, recipient_id,
        direction, status, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `meta_inbound_${id}`,
      'instagram',
      `meta_inbound_message_${id}`,
      contactId,
      'ig_customer',
      'ig_business',
      'inbound',
      'received',
      'text',
      'DM del contacto',
      '2026-06-16T10:04:00.000Z',
      '2026-06-16T10:04:00.000Z'
    ])

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, recipient_id,
        direction, status, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `meta_outbound_${id}`,
      'instagram',
      `meta_outbound_message_${id}`,
      contactId,
      'ig_business',
      'ig_customer',
      'outbound',
      'sent',
      'text',
      'DM del negocio',
      '2026-06-16T10:05:00.000Z',
      '2026-06-16T10:05:00.000Z'
    ])

    const journey = await readJourney(contactId)
    const messageEvents = journey.filter(event => event.type === 'whatsapp_message' || event.type === 'meta_message')

    assert.deepEqual(
      messageEvents.map(event => `${event.type}:${event.data.direction}:${event.data.message_text}`),
      [
        'whatsapp_message:inbound:Mensaje del contacto',
        'meta_message:inbound:DM del contacto'
      ]
    )

    const fullConversationJourney = await readJourney(contactId, { includeBusinessMessages: 'true' })
    const fullConversationMessages = fullConversationJourney
      .filter(event => event.type === 'whatsapp_message' || event.type === 'meta_message')

    assert.deepEqual(
      fullConversationMessages.map(event => `${event.type}:${event.data.direction}:${event.data.message_text}`),
      [
        'whatsapp_message:inbound:Mensaje del contacto',
        'whatsapp_message:outbound:Mensaje del negocio',
        'whatsapp_message:business_echo:Eco del negocio',
        'meta_message:inbound:DM del contacto',
        'meta_message:outbound:DM del negocio'
      ]
    )
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey exposes playable WhatsApp audio media from raw payload', async () => {
  const id = randomUUID()
  const contactId = `journey_audio_${id}`
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const audioUrl = `https://cdn.ristak.test/audio/${id}.ogg`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Audio',
      'Cliente',
      'manual',
      '2026-06-16T10:10:00.000Z',
      '2026-06-16T10:10:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at,
        raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_audio_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'audio',
      '>AUDIO< [Received on Ristak]',
      '2026-06-16T10:11:00.000Z',
      '2026-06-16T10:11:00.000Z',
      JSON.stringify({
        type: 'audio',
        audio: {
          id: `media_${id}`,
          downloadUrl: audioUrl,
          mimeType: 'audio/ogg',
          fileName: 'nota-de-voz.ogg',
          durationMs: 12400
        }
      })
    ])

    const journey = await readJourney(contactId)
    const audioEvent = journey.find(event => event.type === 'whatsapp_message' && event.data.message_type === 'audio')

    assert.ok(audioEvent)
    assert.equal(audioEvent.data.media_url, audioUrl)
    assert.equal(audioEvent.data.media_id, `media_${id}`)
    assert.equal(audioEvent.data.media_mime_type, 'audio/ogg')
    assert.equal(audioEvent.data.media_filename, 'nota-de-voz.ogg')
    assert.equal(audioEvent.data.media_duration_ms, 12400)
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat history includes WhatsApp messages matched by phone when contact_id is missing', async () => {
  const id = randomUUID()
  const contactId = `journey_phone_match_${id}`
  const phone = `+52992${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Phone Match',
      'Cliente',
      'manual',
      '2026-06-16T11:00:00.000Z',
      '2026-06-16T11:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_phone_only_${id}`,
      phone,
      phone,
      businessPhone,
      businessPhone,
      'api',
      'inbound',
      'text',
      'Mensaje entrante sin contacto enlazado',
      '2026-06-16T11:01:00.000Z',
      '2026-06-16T11:01:00.000Z'
    ])

    const journey = await readJourney(contactId, { includeBusinessMessages: 'true' })
    const whatsappMessages = journey.filter(event => event.type === 'whatsapp_message')

    assert.deepEqual(
      whatsappMessages.map(event => `${event.data.direction}:${event.data.message_text}`),
      ['inbound:Mensaje entrante sin contacto enlazado']
    )

    const chats = await readChatContacts({ limit: '100' })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.messageCount, 1)
    assert.equal(chat.lastMessageText, 'Mensaje entrante sin contacto enlazado')
    assert.equal(chat.lastMessageDirection, 'inbound')
  } finally {
    await cleanup(contactId, phone)
  }
})
