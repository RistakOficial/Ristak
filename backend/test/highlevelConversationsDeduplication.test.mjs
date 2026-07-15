import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  buildHighLevelConversationWebhookMessage,
  buildHighLevelWebhookFallbackMessageId,
  upsertHighLevelConversationMessage
} from '../src/services/highlevelConversationsSyncService.js'

async function cleanup({ contactId, ghlContactId, phone }) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR ghl_contact_id = ? OR phone = ?', [contactId, ghlContactId, phone]).catch(() => undefined)
}

test('HighLevel webhook fallback message IDs are stable within the same minute', () => {
  const base = {
    contactId: 'ghl_contact_dedupe',
    body: '  Eres tú   Alexis o la IA? ',
    messageType: 'TYPE_WEBCHAT',
    direction: 'inbound',
    attachments: [],
    timestamp: '2026-06-22T23:09:10.000Z'
  }

  assert.equal(
    buildHighLevelWebhookFallbackMessageId(base),
    buildHighLevelWebhookFallbackMessageId({
      ...base,
      body: 'Eres tú Alexis o la IA?',
      timestamp: '2026-06-22T23:09:45.000Z'
    })
  )
})

test('HighLevel webhook preserves sender, recipient and durable provider error', () => {
  const message = buildHighLevelConversationWebhookMessage({
    message: {
      id: 'ghl_webhook_failed_message',
      contactId: 'ghl_webhook_contact',
      type: 'TYPE_WHATSAPP',
      body: 'Intento fallido',
      direction: 'outbound',
      from: '+52 1 81 2380 2444',
      to: '+52 656 742 0000',
      status: 'failed',
      error: {
        message: 'Message failed because more than 24 hours have passed.'
      },
      dateAdded: '2026-07-15T17:14:24.000Z'
    }
  })

  assert.equal(message.fromNumber, '+52 1 81 2380 2444')
  assert.equal(message.toNumber, '+52 656 742 0000')
  assert.equal(message.errorMessage, 'Message failed because more than 24 hours have passed.')
  assert.equal(message.status, 'failed')
})

test('HighLevel webhook and sync messages dedupe when they describe the same inbound bubble', async () => {
  const suffix = randomUUID()
  const contactId = `contact_ghl_dedupe_${suffix}`
  const ghlContactId = `ghl_contact_dedupe_${suffix}`
  const phone = `+52656${Date.now().toString().slice(-7)}`
  const body = 'Eres tú Alexis o la IA?'
  const firstSyntheticId = `ghl_wh_legacy_first_${suffix}`
  const secondSyntheticId = `ghl_wh_legacy_second_${suffix}`
  const realRemoteId = `ghl_real_message_${suffix}`

  await cleanup({ contactId, ghlContactId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, ghlContactId, phone, 'Alexis Dedupe'])

    const first = await upsertHighLevelConversationMessage({
      message: {
        id: firstSyntheticId,
        contactId: ghlContactId,
        messageType: 'TYPE_WEBCHAT',
        body,
        direction: 'inbound',
        createdAt: '2026-06-22T23:09:10.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    const repeatedWebhook = await upsertHighLevelConversationMessage({
      message: {
        id: secondSyntheticId,
        contactId: ghlContactId,
        messageType: 'TYPE_WEBCHAT',
        body,
        direction: 'inbound',
        createdAt: '2026-06-22T23:09:25.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    const syncWithRealId = await upsertHighLevelConversationMessage({
      message: {
        id: realRemoteId,
        contactId: ghlContactId,
        messageType: 'TYPE_WEBCHAT',
        body,
        direction: 'inbound',
        createdAt: '2026-06-22T23:09:40.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    assert.equal(first.isNew, true)
    assert.equal(repeatedWebhook.isNew, false)
    assert.equal(syncWithRealId.isNew, false)

    const rows = await db.all(`
      SELECT ycloud_message_id, transport, direction, message_text
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND message_text = ?
    `, [contactId, body])

    assert.equal(rows.length, 1)
    assert.equal(rows[0].ycloud_message_id, realRemoteId)
    assert.equal(rows[0].transport, 'ghl_webchat')
    assert.equal(rows[0].direction, 'inbound')
  } finally {
    await cleanup({ contactId, ghlContactId, phone })
  }
})

test('HighLevel does not restore a deleted contact until the inbound was persisted', async () => {
  const suffix = randomUUID()
  const contactId = `contact_ghl_unpersisted_${suffix}`
  const ghlContactId = `ghl_contact_unpersisted_${suffix}`
  const phone = `+52657${Date.now().toString().slice(-7)}`

  await cleanup({ contactId, ghlContactId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, ghl_contact_id, phone, full_name, source, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Contacto en papelera', 'test', ?, ?, ?)
    `, [
      contactId,
      ghlContactId,
      phone,
      '2026-07-14T06:24:27.810Z',
      '2026-07-01T00:00:00.000Z',
      '2026-07-14T06:24:27.810Z'
    ])

    for (const messageType of ['TYPE_WHATSAPP', 'TYPE_EMAIL', 'TYPE_FACEBOOK']) {
      const result = await upsertHighLevelConversationMessage({
        message: {
          contactId: ghlContactId,
          messageType,
          body: 'Payload sin ID durable',
          direction: 'inbound',
          dateAdded: '2026-07-15T17:13:48.064Z'
        },
        apiToken: 'test-token',
        locationId: 'test-location',
        notifyNewInbound: false
      })

      assert.equal(result.saved, 0)
      const contact = await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contactId])
      assert.notEqual(contact.deleted_at, null)
    }
  } finally {
    await cleanup({ contactId, ghlContactId, phone })
  }
})

test('HighLevel inbound stores the selected business number and reactivates a deleted contact', async () => {
  const suffix = randomUUID()
  const contactId = `contact_ghl_reengaged_${suffix}`
  const ghlContactId = `ghl_contact_reengaged_${suffix}`
  const customerPhone = `+52656${Date.now().toString().slice(-7)}`
  const businessPhone = '+528123802444'
  const messageId = `ghl_reengaged_message_${suffix}`
  const failedMessageId = `ghl_failed_message_${suffix}`

  await cleanup({ contactId, ghlContactId, phone: customerPhone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, ghl_contact_id, phone, full_name, source, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Cliente que volvió', 'test', ?, ?, ?)
    `, [
      contactId,
      ghlContactId,
      customerPhone,
      '2026-07-14T06:24:27.810Z',
      '2026-07-01T00:00:00.000Z',
      '2026-07-14T06:24:27.810Z'
    ])

    const result = await upsertHighLevelConversationMessage({
      message: {
        id: messageId,
        contactId: ghlContactId,
        messageType: 'TYPE_WHATSAPP',
        body: 'Volví a escribir',
        direction: 'inbound',
        from: customerPhone,
        to: '+52 1 81 2380 2444',
        dateAdded: '2026-07-15T17:13:48.064Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    assert.equal(result.isNew, true)
    const contact = await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.deleted_at, null)

    const message = await db.get(`
      SELECT phone, from_phone, to_phone, business_phone, transport, direction
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [messageId])
    assert.equal(message.phone, customerPhone)
    assert.equal(message.from_phone, customerPhone)
    assert.equal(message.to_phone, businessPhone)
    assert.equal(message.business_phone, businessPhone)
    assert.equal(message.transport, 'ghl_whatsapp')
    assert.equal(message.direction, 'inbound')

    await upsertHighLevelConversationMessage({
      message: {
        id: failedMessageId,
        contactId: ghlContactId,
        messageType: 'TYPE_WHATSAPP',
        body: 'Intento fuera de ventana',
        direction: 'outbound',
        from: businessPhone,
        to: customerPhone,
        status: 'failed',
        error: 'Message failed because more than 24 hours have passed.',
        dateAdded: '2026-07-15T17:14:24.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    const failedMessage = await db.get(`
      SELECT status, error_message, business_phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [failedMessageId])
    assert.equal(failedMessage.status, 'failed')
    assert.equal(failedMessage.error_message, 'Message failed because more than 24 hours have passed.')
    assert.equal(failedMessage.business_phone, businessPhone)
  } finally {
    await cleanup({ contactId, ghlContactId, phone: customerPhone })
  }
})
