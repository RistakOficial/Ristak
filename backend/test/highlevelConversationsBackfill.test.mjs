import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import GHLClient from '../src/services/ghlClient.js'
import { syncHighLevelConversationHistory } from '../src/services/highlevelConversationsSyncService.js'

const LAST_SYNC_CONFIG_KEY = 'highlevel_conversations_last_synced_at'

async function upsertCheckpoint(value) {
  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [LAST_SYNC_CONFIG_KEY, value])
}

async function cleanup(ids = []) {
  await db.run(`DELETE FROM app_config WHERE config_key = ?`, [LAST_SYNC_CONFIG_KEY]).catch(() => undefined)
  for (const id of ids) {
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ?', [id.contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR ycloud_message_id LIKE ?', [id.contactId, `${id.messagePrefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR meta_message_id LIKE ?', [id.contactId, `${id.messagePrefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM email_messages WHERE contact_id = ?', [id.contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR ghl_contact_id = ?', [id.contactId, id.ghlContactId]).catch(() => undefined)
  }
}

async function seedContact({ contactId, ghlContactId, phone, name }) {
  await db.run(`
    INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [contactId, ghlContactId, phone, name])
}

test('HighLevel full conversation sync backfills via conversations search and per-conversation messages', async () => {
  const suffix = randomUUID()
  const ids = [
    {
      contactId: `contact_backfill_a_${suffix}`,
      ghlContactId: `ghl_backfill_a_${suffix}`,
      phone: '+526561110001',
      name: 'Backfill Uno',
      messagePrefix: `msg_backfill_a_${suffix}`
    },
    {
      contactId: `contact_backfill_b_${suffix}`,
      ghlContactId: `ghl_backfill_b_${suffix}`,
      phone: '+526561110002',
      name: 'Backfill Dos',
      messagePrefix: `msg_backfill_b_${suffix}`
    }
  ]

  await cleanup(ids)
  await Promise.all(ids.map(seedContact))

  const searchCalls = []
  const messageCalls = []

  mock.method(GHLClient.prototype, 'exportConversationMessages', async () => {
    throw new Error('full sync must not use messages/export')
  })

  mock.method(GHLClient.prototype, 'searchConversations', async function searchConversations(options) {
    searchCalls.push(options)
    assert.equal(options.id, undefined)

    if (!options.startAfterDate) {
      return {
        total: 2,
        conversations: [{
          id: `conv_backfill_a_${suffix}`,
          contactId: ids[0].ghlContactId,
          lastMessageDate: 2000,
          lastMessageType: 'TYPE_WHATSAPP'
        }]
      }
    }

    assert.equal(options.startAfterDate, '2000')
    return {
      total: 2,
      conversations: [{
        id: `conv_backfill_b_${suffix}`,
        contactId: ids[1].ghlContactId,
        lastMessageDate: 1000,
        lastMessageType: 'TYPE_CUSTOM_SMS'
      }]
    }
  })

  mock.method(GHLClient.prototype, 'getConversationMessages', async function getConversationMessages(conversationId, options) {
    messageCalls.push({ conversationId, options })

    if (conversationId === `conv_backfill_a_${suffix}` && !options.lastMessageId) {
      return {
        messages: {
          nextPage: true,
          lastMessageId: `${ids[0].messagePrefix}_1`,
          messages: [{
            id: `${ids[0].messagePrefix}_1`,
            contactId: ids[0].ghlContactId,
            conversationId,
            messageType: 'TYPE_WHATSAPP',
            body: 'Primer WhatsApp',
            direction: 'inbound',
            dateAdded: '2026-06-01T10:00:00.000Z'
          }]
        }
      }
    }

    if (conversationId === `conv_backfill_a_${suffix}` && options.lastMessageId === `${ids[0].messagePrefix}_1`) {
      return {
        messages: {
          nextPage: false,
          messages: [{
            id: `${ids[0].messagePrefix}_2`,
            contactId: ids[0].ghlContactId,
            conversationId,
            messageType: 'TYPE_WHATSAPP',
            body: 'Segundo WhatsApp',
            direction: 'outbound',
            dateAdded: '2026-05-31T10:00:00.000Z'
          }]
        }
      }
    }

    return {
      messages: {
        nextPage: false,
        messages: [{
          id: `${ids[1].messagePrefix}_1`,
          contactId: ids[1].ghlContactId,
          conversationId,
          type: 20,
          body: 'SMS con type numerico',
          direction: 'inbound',
          dateAdded: '2026-05-30T10:00:00.000Z'
        }]
      }
    }
  })

  try {
    const result = await syncHighLevelConversationHistory({
      locationId: 'loc_test',
      apiToken: 'token_test',
      fullSync: true,
      notifyNewInbound: false
    })

    assert.equal(result.strategy, 'conversation_backfill')
    assert.equal(result.incomplete, false)
    assert.equal(result.checkpointUpdated, true)
    assert.equal(result.conversations, 2)
    assert.equal(result.saved, 3)
    assert.equal(searchCalls.length, 2)
    assert.equal(messageCalls.length, 3)

    const rows = await db.all(`
      SELECT ycloud_message_id, transport, direction, message_text
      FROM whatsapp_api_messages
      WHERE ycloud_message_id LIKE ?
      ORDER BY ycloud_message_id ASC
    `, [`msg_backfill_%_${suffix}%`])

    assert.equal(rows.length, 3)
    assert.equal(rows.find(row => row.ycloud_message_id === `${ids[1].messagePrefix}_1`)?.transport, 'ghl_sms')
    assert.equal(rows.find(row => row.ycloud_message_id === `${ids[1].messagePrefix}_1`)?.message_text, 'SMS con type numerico')
  } finally {
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('HighLevel incremental export keeps previous checkpoint when export cursor repeats', async () => {
  const suffix = randomUUID()
  const checkpoint = '2026-06-20T12:00:00.000Z'
  const id = {
    contactId: `contact_export_cursor_${suffix}`,
    ghlContactId: `ghl_export_cursor_${suffix}`,
    phone: '+526561110003',
    name: 'Cursor Repetido',
    messagePrefix: `msg_export_cursor_${suffix}`
  }

  await cleanup([id])
  await seedContact(id)
  await upsertCheckpoint(checkpoint)

  let exportCalls = 0

  mock.method(GHLClient.prototype, 'searchConversations', async () => {
    throw new Error('incremental sync must not use conversations/search when checkpoint exists')
  })

  mock.method(GHLClient.prototype, 'exportConversationMessages', async function exportConversationMessages(options) {
    exportCalls++
    assert.ok(options.startDate)

    return {
      total: 300,
      nextCursor: 'cursor_repetido',
      messages: [{
        id: `${id.messagePrefix}_${exportCalls}`,
        contactId: id.ghlContactId,
        messageType: 'TYPE_WHATSAPP',
        body: `Mensaje ${exportCalls}`,
        direction: 'inbound',
        dateAdded: `2026-06-2${exportCalls}T10:00:00.000Z`
      }]
    }
  })

  try {
    const result = await syncHighLevelConversationHistory({
      locationId: 'loc_test',
      apiToken: 'token_test',
      fullSync: false,
      notifyNewInbound: false
    })

    assert.equal(result.strategy, 'export')
    assert.equal(result.incomplete, true)
    assert.equal(result.incompleteReason, 'repeated_export_cursor')
    assert.equal(result.checkpointUpdated, false)
    assert.equal(exportCalls, 2)

    const storedCheckpoint = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      [LAST_SYNC_CONFIG_KEY]
    )
    assert.equal(storedCheckpoint.config_value, checkpoint)
  } finally {
    mock.restoreAll()
    await cleanup([id])
  }
})
