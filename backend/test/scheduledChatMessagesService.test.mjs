import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { db } from '../src/config/database.js'
import {
  cancelScheduledChatMessage,
  createScheduledChatMessage,
  listScheduledChatMessages
} from '../src/services/scheduledChatMessagesService.js'
import { subscribeChatLiveEvents } from '../src/services/chatLiveEventsService.js'

class FakeResponse extends EventEmitter {
  statusCode = 0
  headers = {}
  chunks = []
  writableEnded = false
  destroyed = false

  status(code) {
    this.statusCode = code
    return this
  }

  set(headers) {
    this.headers = { ...this.headers, ...headers }
    return this
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }
}

function futureIso(minutes = 30) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

async function insertContact(id, phone = '+5215512345678') {
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, phone, email, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, `Contacto ${id}`, 'Contacto', phone, `${id}@test.local`]
  )
}

async function cleanup(contactId) {
  await db.run('DELETE FROM scheduled_chat_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('createScheduledChatMessage conserva mensajes de texto programados', async () => {
  const contactId = `scheduled_text_${Date.now()}`
  await insertContact(contactId)

  try {
    const scheduled = await createScheduledChatMessage({
      contactId,
      provider: 'whatsapp_api',
      transport: 'api',
      text: 'Hola {{contact.firstName}}',
      fromPhone: '+5215599999999',
      scheduledAt: futureIso(45)
    })

    assert.equal(scheduled.contactId, contactId)
    assert.equal(scheduled.messageType, 'text')
    assert.equal(scheduled.text, 'Hola {{contact.firstName}}')

    const rows = await listScheduledChatMessages({ contactId })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].messageType, 'text')
    assert.equal(rows[0].templateId, '')
  } finally {
    await cleanup(contactId)
  }
})

test('createScheduledChatMessage guarda plantillas programadas para WhatsApp API', async () => {
  const contactId = `scheduled_template_${Date.now()}`
  await insertContact(contactId)

  try {
    const scheduled = await createScheduledChatMessage({
      contactId,
      provider: 'whatsapp_api',
      messageType: 'template',
      text: 'Plantilla: bienvenida_cliente',
      templateId: 'tpl_welcome_test',
      templateName: 'bienvenida_cliente',
      templateLanguage: 'es_MX',
      templateVariables: { nombre: '{{contact.firstName}}' },
      fromPhone: '+5215599999999',
      businessPhoneNumberId: 'wa_phone_test',
      scheduledAt: futureIso(60)
    })

    assert.equal(scheduled.contactId, contactId)
    assert.equal(scheduled.messageType, 'template')
    assert.equal(scheduled.templateId, 'tpl_welcome_test')
    assert.equal(scheduled.templateName, 'bienvenida_cliente')
    assert.equal(scheduled.templateLanguage, 'es_MX')
    assert.deepEqual(scheduled.templateVariables, { nombre: '{{contact.firstName}}' })

    const rows = await listScheduledChatMessages({ contactId })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].messageType, 'template')
    assert.equal(rows[0].templateId, 'tpl_welcome_test')
    assert.equal(rows[0].templateName, 'bienvenida_cliente')
  } finally {
    await cleanup(contactId)
  }
})

test('crear y cancelar publican invalidaciones realtime para otros dispositivos', async () => {
  const contactId = `scheduled_realtime_${Date.now()}`
  const req = new EventEmitter()
  const res = new FakeResponse()
  const stopStream = subscribeChatLiveEvents(req, res)
  await insertContact(contactId)

  try {
    const scheduled = await createScheduledChatMessage({
      contactId,
      provider: 'whatsapp_api',
      transport: 'api',
      text: 'Mensaje sincronizado',
      fromPhone: '+5215599999999',
      scheduledAt: futureIso(30)
    })
    await cancelScheduledChatMessage({ id: scheduled.id, contactId })

    const output = res.chunks.join('')
    const changedFrames = output.match(/event: chat_data_changed/g) || []
    assert.equal(changedFrames.length, 2)
    assert.match(output, new RegExp(`"contactId":"${contactId}"`))
    assert.match(output, /"domains":\["scheduled_messages"\]/)
    assert.match(output, new RegExp(`"entityId":"${scheduled.id}"`))
  } finally {
    stopStream()
    await cleanup(contactId)
  }
})
