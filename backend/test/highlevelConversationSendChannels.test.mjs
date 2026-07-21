import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
  await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('HighLevel conversational agent preserves the inbound business number when replying', async () => {
  const source = await readFile(
    new URL('../src/agents/conversational/runner.js', import.meta.url),
    'utf8'
  )

  assert.match(source, /fromNumber: replyFromNumber \|\| latest\.business_phone \|\| undefined/)
})

test('HighLevel conversation sender supports explicit WhatsApp, SMS, Messenger, Instagram and Email routes', async () => {
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
        id, ycloud_message_id, contact_id, phone, business_phone, transport, direction, message_type,
        message_text, status, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, 'ghl_whatsapp', 'inbound', 'text', 'Ventana abierta', 'received', ?, CURRENT_TIMESTAMP)`,
      [`local_reply_window_${marker}`, `local_reply_window_remote_${marker}`, contactId, phone, '+19155550188', new Date().toISOString()]
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
        fromNumber: '+19155550188',
        message: 'Hola por WhatsApp'
      }, { markHumanTakeover: false })
      const smsFromNumber = '+19155550199'
      const sms = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'sms_qr',
        fromNumber: smsFromNumber,
        message: 'Hola por SMS'
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
      const email = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'email',
        subject: 'Asunto por correo',
        message: 'Hola por correo',
        html: '<p>Hola por correo</p>'
      }, { markHumanTakeover: false })

      assert.deepEqual(sentPayloads.map(payload => payload.type), ['WhatsApp', 'SMS', 'FB', 'IG', 'Email'])
      assert.deepEqual([whatsapp.status, sms.status, messenger.status, instagram.status, email.status], ['pending', 'pending', 'pending', 'pending', 'pending'])
      assert.equal(whatsapp.channel, 'whatsapp_api')
      assert.equal(sms.channel, 'sms_qr')
      assert.equal(sentPayloads[1].fromNumber, smsFromNumber)
      assert.equal(messenger.channel, 'messenger')
      assert.equal(instagram.channel, 'instagram')
      assert.equal(email.channel, 'email')

      const emailPayload = sentPayloads[4]
      assert.equal(emailPayload.subject, 'Asunto por correo')
      assert.equal(emailPayload.message, 'Hola por correo')
      assert.equal(emailPayload.html, '<p>Hola por correo</p>')
      assert.equal(emailPayload.fromNumber, undefined)
      assert.equal(emailPayload.toNumber, undefined)

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
      assert.equal(whatsappRow.status, 'pending')

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
      assert.ok(metaRows.every(row => row.status === 'pending'))

      const emailRow = await db.get(
        `SELECT direction, status, to_email, subject, message_text, html_body, raw_payload_json
         FROM email_messages
         WHERE contact_id = ? AND subject = ?`,
        [contactId, 'Asunto por correo']
      )
      assert.equal(emailRow.direction, 'outbound')
      assert.equal(emailRow.status, 'pending')
      assert.equal(emailRow.to_email, `cliente-${marker}@example.com`)
      assert.equal(emailRow.subject, 'Asunto por correo')
      assert.equal(emailRow.message_text, 'Hola por correo')
      assert.equal(emailRow.html_body, '<p>Hola por correo</p>')
      assert.equal(JSON.parse(emailRow.raw_payload_json).provider, 'highlevel')
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel WhatsApp never borrows a Meta Direct window or falls back silently to SMS', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_window_scope_${marker}`
  const phone = `+52656${marker.slice(0, 10).replace(/[a-f]/g, '6')}`
  const metaDirectNumber = '+19155550177'
  const selectedHighLevelNumber = '+19155550188'
  const sentPayloads = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Cliente Ventana', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_window_${marker}`, phone]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, business_phone, transport, direction,
        message_type, message_text, status, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, 'api', 'inbound', 'text', 'Inbound por Meta Direct',
        'received', ?, CURRENT_TIMESTAMP)`,
      [`meta_window_${marker}`, `meta_window_remote_${marker}`, contactId, phone, metaDirectNumber, new Date().toISOString()]
    )

    mock.method(GHLClient.prototype, 'exportConversationMessages', async () => ({ messages: [] }))
    mock.method(GHLClient.prototype, 'sendConversationMessage', async payload => {
      sentPayloads.push(payload)
      return { messageId: `should_not_send_${marker}`, status: 'pending' }
    })

    try {
      await assert.rejects(
        sendHighLevelConversationMessageCore({
          contactId,
          channel: 'whatsapp_api',
          fromNumber: selectedHighLevelNumber,
          message: 'No debes convertir esto a SMS'
        }, { markHumanTakeover: false }),
        error => {
          assert.equal(error.statusCode, 409)
          assert.equal(error.code, 'HIGHLEVEL_WHATSAPP_REPLY_WINDOW_CLOSED')
          assert.match(error.message, /fuera de la ventana de 24 horas/i)
          return true
        }
      )
      assert.equal(sentPayloads.length, 0)
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel WhatsApp keeps each reply window scoped to its own business number', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_multinumber_${marker}`
  const phone = `+52658${marker.slice(0, 9).replace(/[a-f]/g, '5')}`
  const staleNumber = '+19155550201'
  const recentNumber = '+19155550202'
  const sentPayloads = []
  let exportCalls = 0

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Cliente Multi Número', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_multinumber_${marker}`, phone]
    )
    for (const [idSuffix, businessPhone, timestamp] of [
      ['stale', staleNumber, new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString()],
      ['recent', recentNumber, new Date().toISOString()]
    ]) {
      await db.run(
        `INSERT INTO whatsapp_api_messages (
          id, ycloud_message_id, contact_id, phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, 'ghl_whatsapp', 'inbound', 'text', ?, 'received', ?, CURRENT_TIMESTAMP)`,
        [`multinumber_${idSuffix}_${marker}`, `multinumber_remote_${idSuffix}_${marker}`, contactId, phone, businessPhone, idSuffix, timestamp]
      )
    }

    mock.method(GHLClient.prototype, 'exportConversationMessages', async () => {
      exportCalls += 1
      return { messages: [] }
    })
    mock.method(GHLClient.prototype, 'sendConversationMessage', async payload => {
      sentPayloads.push(payload)
      return { messageId: `remote_send_${marker}_implicit`, status: 'pending' }
    })

    try {
      await assert.rejects(
        sendHighLevelConversationMessageCore({
          contactId,
          channel: 'whatsapp_api',
          fromNumber: staleNumber,
          message: 'No uses la ventana del otro número'
        }, { markHumanTakeover: false }),
        error => error.code === 'HIGHLEVEL_WHATSAPP_REPLY_WINDOW_CLOSED'
      )

      const implicit = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'whatsapp_api',
        message: 'Responde desde el número que recibió el mensaje'
      }, { markHumanTakeover: false })

      assert.equal(exportCalls, 1)
      assert.equal(sentPayloads.length, 1)
      assert.equal(sentPayloads[0].fromNumber, recentNumber)
      assert.equal(implicit.fromNumber, recentNumber)
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel local reply-window lookup filters the selected number before bounding work', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_window_depth_${marker}`
  const phone = `+52659${marker.slice(0, 9).replace(/[a-f]/g, '4')}`
  const selectedNumber = '+19155550301'
  const noisyNumber = '+19155550302'
  const sentPayloads = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Cliente con Tráfico', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_window_depth_${marker}`, phone]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, business_phone, transport, direction,
        message_type, message_text, status, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, 'ghl_whatsapp', 'inbound', 'text', 'Ventana elegida', 'received', ?, CURRENT_TIMESTAMP)`,
      [`window_depth_selected_${marker}`, `window_depth_selected_remote_${marker}`, contactId, phone, selectedNumber,
        new Date(Date.now() - (60 * 60 * 1000)).toISOString()]
    )
    for (let index = 0; index < 35; index += 1) {
      await db.run(
        `INSERT INTO whatsapp_api_messages (
          id, ycloud_message_id, contact_id, phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, 'ghl_whatsapp', 'inbound', 'text', ?, 'received', ?, CURRENT_TIMESTAMP)`,
        [`window_depth_noise_${index}_${marker}`, `window_depth_noise_remote_${index}_${marker}`, contactId, phone, noisyNumber,
          `Ruido ${index}`, new Date(Date.now() - (index * 1000)).toISOString()]
      )
    }

    mock.method(GHLClient.prototype, 'exportConversationMessages', async () => {
      throw new Error('La ventana local exacta no debe consultar HighLevel')
    })
    mock.method(GHLClient.prototype, 'sendConversationMessage', async payload => {
      sentPayloads.push(payload)
      return { messageId: `remote_send_${marker}_depth`, status: 'pending' }
    })

    try {
      await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'whatsapp_api',
        fromNumber: selectedNumber,
        message: 'La ventana exacta sigue abierta'
      }, { markHumanTakeover: false })

      assert.equal(sentPayloads.length, 1)
      assert.equal(sentPayloads[0].fromNumber, selectedNumber)
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel reply-window lookup follows a bounded export cursor to the selected number', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_window_cursor_${marker}`
  const phone = `+52650${marker.slice(0, 9).replace(/[a-f]/g, '3')}`
  const selectedNumber = '+19155550401'
  const sentPayloads = []
  const cursors = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, 'Cliente Paginado', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_window_cursor_${marker}`, phone]
    )

    mock.method(GHLClient.prototype, 'exportConversationMessages', async options => {
      cursors.push(options.cursor || '')
      if (!options.cursor) {
        return {
          messages: [{
            id: `remote_other_${marker}`,
            direction: 'inbound',
            messageType: 'TYPE_WHATSAPP',
            toNumber: '+19155550402',
            dateAdded: new Date().toISOString()
          }],
          nextCursor: 'cursor-page-2'
        }
      }
      return {
        messages: [{
          id: `remote_selected_${marker}`,
          direction: 'inbound',
          messageType: 'TYPE_WHATSAPP',
          toNumber: selectedNumber,
          dateAdded: new Date().toISOString()
        }]
      }
    })
    mock.method(GHLClient.prototype, 'sendConversationMessage', async payload => {
      sentPayloads.push(payload)
      return { messageId: `remote_send_${marker}_cursor`, status: 'pending' }
    })

    try {
      await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'whatsapp_api',
        fromNumber: selectedNumber,
        message: 'Encontrado en la segunda página'
      }, { markHumanTakeover: false })

      assert.deepEqual(cursors, ['', 'cursor-page-2'])
      assert.equal(sentPayloads.length, 1)
      assert.equal(sentPayloads[0].fromNumber, selectedNumber)
    } finally {
      mock.restoreAll()
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel conversation sender keeps requested media attachments as files', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_file_attachment_${marker}`
  const sentPayloads = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_file_attachment_${marker}`, `+52656${marker.slice(0, 10).replace(/[a-f]/g, '8')}`, `archivo-${marker}@example.com`, 'Cliente Archivo']
    )

    mock.method(GHLClient.prototype, 'sendConversationMessage', async function sendConversationMessage(payload) {
      sentPayloads.push(payload)
      return {
        messageId: `remote_send_${marker}_file`,
        status: 'pending'
      }
    })

    let mediaAssetId = ''
    try {
      const result = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'messenger',
        message: 'Te mando el video como archivo',
        attachmentDataUrls: [{
          dataUrl: `data:video/mp4;base64,${Buffer.from('fake mp4 payload').toString('base64')}`,
          filename: 'video-pesado.mp4',
          mimeType: 'video/mp4',
          kind: 'document'
        }]
      }, {
        markHumanTakeover: false,
        req: {
          protocol: 'https',
          headers: { host: 'ristak.test' },
          body: {},
          get(name) {
            return String(name || '').toLowerCase() === 'host' ? 'ristak.test' : ''
          }
        }
      })

      mediaAssetId = result.localAttachments?.[0]?.mediaAssetId || ''

      assert.equal(sentPayloads.length, 1)
      assert.equal(sentPayloads[0].type, 'FB')
      assert.equal(sentPayloads[0].message, 'Te mando el video como archivo')
      assert.equal(sentPayloads[0].attachments.length, 1)
      assert.match(sentPayloads[0].attachments[0], /^https?:\/\//)
      assert.equal(result.localAttachments?.[0]?.kind, 'document')
      assert.equal(result.localAttachments?.[0]?.mimeType, 'video/mp4')
      assert.equal(result.localAttachments?.[0]?.filename, 'video-pesado.mp4')

      const rawPayloadRow = await db.get(
        `SELECT message_type, media_url, media_mime_type, raw_payload_json
         FROM meta_social_messages
         WHERE contact_id = ? AND direction = 'outbound'
         ORDER BY message_timestamp DESC
         LIMIT 1`,
        [contactId]
      )
      assert.equal(rawPayloadRow.message_type, 'document')
      assert.match(rawPayloadRow.media_url, /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
      assert.equal(rawPayloadRow.media_mime_type, 'video/mp4')
      const rawPayload = JSON.parse(rawPayloadRow.raw_payload_json)
      assert.deepEqual(rawPayload.request.attachments, sentPayloads[0].attachments)
    } finally {
      mock.restoreAll()
      if (mediaAssetId) {
        await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
      }
      await cleanupContact(contactId, marker)
    }
  })
})

test('HighLevel conversation sender persists voice attachments as playable audio in Meta mirrors', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const contactId = `contact_send_audio_attachment_${marker}`
  const sentPayloads = []

  await cleanupContact(contactId, marker)

  await snapshotHighLevelConfig(async () => {
    await db.run(
      `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_send_audio_attachment_${marker}`, `+52656${marker.slice(0, 10).replace(/[a-f]/g, '9')}`, `audio-${marker}@example.com`, 'Cliente Audio']
    )

    mock.method(GHLClient.prototype, 'sendConversationMessage', async function sendConversationMessage(payload) {
      sentPayloads.push(payload)
      return {
        messageId: `remote_send_${marker}_audio`,
        status: 'pending'
      }
    })

    let mediaAssetId = ''
    try {
      const result = await sendHighLevelConversationMessageCore({
        contactId,
        channel: 'messenger',
        message: '',
        audioDataUrl: `data:audio/mp4;base64,${Buffer.from('fake m4a voice payload').toString('base64')}`,
        durationMs: 2400
      }, {
        markHumanTakeover: false,
        req: {
          protocol: 'https',
          headers: { host: 'ristak.test' },
          body: {},
          get(name) {
            return String(name || '').toLowerCase() === 'host' ? 'ristak.test' : ''
          }
        }
      })

      mediaAssetId = result.localMedia?.mediaAssetId || ''

      assert.equal(sentPayloads.length, 1)
      assert.equal(sentPayloads[0].type, 'FB')
      assert.equal(sentPayloads[0].message, undefined)
      assert.equal(sentPayloads[0].attachments.length, 1)
      assert.match(sentPayloads[0].attachments[0], /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
      assert.equal(result.audio?.mimeType, 'audio/mp4')
      assert.equal(result.audio?.durationMs, 2400)
      assert.equal(result.localMedia?.kind, 'audio')
      assert.equal(result.localMedia?.mimeType, 'audio/mp4')

      const audioRow = await db.get(
        `SELECT message_type, message_text, media_url, media_mime_type, raw_payload_json
         FROM meta_social_messages
         WHERE contact_id = ? AND direction = 'outbound'
         ORDER BY message_timestamp DESC
         LIMIT 1`,
        [contactId]
      )
      assert.equal(audioRow.message_type, 'audio')
      assert.equal(audioRow.message_text, '')
      assert.match(audioRow.media_url, /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
      assert.equal(audioRow.media_mime_type, 'audio/mp4')
      const rawPayload = JSON.parse(audioRow.raw_payload_json)
      assert.deepEqual(rawPayload.request.attachments, sentPayloads[0].attachments)
    } finally {
      mock.restoreAll()
      if (mediaAssetId) {
        await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
      }
      await cleanupContact(contactId, marker)
    }
  })
})
