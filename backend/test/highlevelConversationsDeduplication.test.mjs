import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
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
