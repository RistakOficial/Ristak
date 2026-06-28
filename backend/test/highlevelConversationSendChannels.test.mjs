import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { sendHighLevelConversationMessageCore } from '../src/controllers/highlevelController.js'
import GHLClient from '../src/services/ghlClient.js'

async function snapshotHighLevelConfig(callback) {
  const previousRows = await db.all('SELECT * FROM highlevel_config').catch(() => [])

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
      ['loc_send_channels_test', 'token_send_channels_test', '{}']
    )
    return await callback()
  } finally {
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)

    for (const row of previousRows) {
      const columns = Object.keys(row).filter(column => row[column] !== undefined)
      if (!columns.length) continue

      await db.run(
        `INSERT INTO highlevel_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

async function cleanupContact(contactId, marker) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR ycloud_message_id LIKE ?', [contactId, `remote_send_${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR meta_message_id LIKE ?', [contactId, `remote_send_${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('HighLevel conversation sender supports WhatsApp, Messenger and Instagram mirrors', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_channels_${marker}`
  const phone = `+52656${marker.slice(0, 10).replace(/[a-f]/g, '7')}`
  const sentPayloads = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_channels_${marker}`, phone, `cliente-${marker}@example.com`, 'Cliente Canales']
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, transport, direction, message_type,
        message_text, status, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, 'ghl_whatsapp', 'inbound', 'text', 'Ventana abierta', 'received', ?, CURRENT_TIMESTAMP)`,
      [`local_reply_window_${marker}`, `local_reply_window_remote_${marker}`, contactId, phone, new Date().toISOString()]
    )

    mock.method(GHLClient.prototype, 'exportConversationMessages', async () => {
      throw new Error('WhatsApp send should use the local reply window in this test')
    })
    mock.method(GHLClient.prototype, 'sendConversationMessage', async function sendConversationMessage(payload) {
      sentPayloads.push(payload)
      return {
        messageId: `remote_send_${marker}_${String(payload.type).toLowerCase()}`,
        status: 'pending'
      }
    })

    try {
      const whatsapp = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'whatsapp_api',
        message: 'Hola por WhatsApp'
      }, { markHumanTakeover: false })
      const messenger = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'messenger',
        message: 'Hola por Messenger'
      }, { markHumanTakeover: false })
      const instagram = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'instagram',
        message: 'Hola por Instagram'
      }, { markHumanTakeover: false })

      assert.deepEqual(sentPayloads.map(payload => payload.type), ['WhatsApp', 'FB', 'IG'])
      assert.deepEqual([whatsapp.status, messenger.status, instagram.status], ['sent', 'sent', 'sent'])
      assert.equal(whatsapp.channel, 'whatsapp_api')
      assert.equal(messenger.channel, 'messenger')
      assert.equal(instagram.channel, 'instagram')

      const whatsappRow = await db.get(
        `SELECT transport, direction, message_type, message_text, status
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        [`remote_send_${marker}_whatsapp`]
      )
      assert.equal(whatsappRow.transport, 'ghl_whatsapp')
      assert.equal(whatsappRow.direction, 'outbound')
      assert.equal(whatsappRow.message_type, 'text')
      assert.equal(whatsappRow.message_text, 'Hola por WhatsApp')
      assert.equal(whatsappRow.status, 'sent')

      const metaRows = await db.all(
        `SELECT platform, direction, message_type, message_text, status
         FROM meta_social_messages
         WHERE meta_message_id IN (?, ?)
         ORDER BY platform ASC`,
        [`remote_send_${marker}_fb`, `remote_send_${marker}_ig`]
      )
      assert.equal(metaRows.length, 2)
      assert.equal(metaRows.find(row => row.platform === 'messenger')?.message_text, 'Hola por Messenger')
      assert.equal(metaRows.find(row => row.platform === 'instagram')?.message_text, 'Hola por Instagram')
      assert.ok(metaRows.every(row => row.direction === 'outbound'))
      assert.ok(metaRows.every(row => row.status === 'sent'))
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})
