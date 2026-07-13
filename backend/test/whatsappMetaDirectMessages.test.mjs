import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { getContactConversation } from '../src/controllers/contactsController.js'
import { markLatestInboundWhatsAppQrMessageReadForContact } from '../src/services/whatsappQrService.js'
import {
  getWhatsAppApiConfigKeys,
  markLatestInboundWhatsAppApiMessageReadForContact,
  processMetaDirectWebhookPayload,
  sendWhatsAppApiReactionMessage,
  sendWhatsAppApiTextMessage,
  setMetaDirectFetchForTest
} from '../src/services/whatsappApiService.js'

function graphResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body
  }
}

function webhookEnvelope({
  wabaId,
  phoneNumberId,
  businessPhone,
  field = 'messages',
  contacts = [],
  messages = [],
  statuses = [],
  smbMessageEchoes = []
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{
        field,
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: businessPhone,
            phone_number_id: phoneNumberId
          },
          contacts,
          messages,
          statuses,
          ...(smbMessageEchoes.length ? { smb_message_echoes: smbMessageEchoes } : {})
        }
      }]
    }]
  }
}

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

async function readConversation(contactId) {
  const response = createMockResponse()
  await getContactConversation({ params: { id: contactId }, query: {} }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body?.success, true)
  return response.body.data
}

async function withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const touchedKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastWebhookReceivedAt,
    keys.metaLastRelayReceivedAt,
    keys.metaLastSubscriptionRefreshAt
  ]
  const placeholders = touchedKeys.map(() => '?').join(', ')
  const previous = await db.all(
    `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
    touchedKeys
  )

  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, touchedKeys)
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, businessPhone)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta-direct-message-test-token'))
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, qr_send_enabled, qr_status, is_default_sender,
        created_at, updated_at
      ) VALUES (?, 'meta_direct', ?, ?, ?, 'Ristak Meta Test', 'CONNECTED', 1, 0, 'disconnected', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [phoneNumberId, wabaId, businessPhone, businessPhone])

    return await callback()
  } finally {
    setMetaDirectFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, touchedKeys)
    for (const row of previous) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

test('Meta direct persists one text bubble, reconciles status ACKs, and saves CTWA attribution', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_phone_${suffix}`
  const wabaId = `meta_waba_${suffix}`
  const businessPhone = `+1555${Date.now().toString().slice(-7)}`
  const customerPhone = `+5255${Date.now().toString().slice(-8)}`
  const inboundWamid = `wamid.meta.in.${suffix}`
  const outboundWamid = `wamid.meta.out.${suffix}`
  const outboundReplyWamid = `wamid.meta.out.reply.${suffix}`
  const outboundReactionWamid = `wamid.meta.out.reaction.${suffix}`
  const inboundReplyWamid = `wamid.meta.in.reply.${suffix}`
  const inboundReactionWamid = `wamid.meta.in.reaction.${suffix}`
  const failedWamid = `wamid.meta.failed.${suffix}`
  const adId = `120${Date.now().toString().slice(-12)}`
  const externalId = `desktop-chat-${suffix}`
  let contactId = ''

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      const inboundPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente CTWA Meta' } }],
        messages: [{
          id: inboundWamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Quiero información' },
          referral: {
            source_url: 'https://www.facebook.com/ads/example',
            source_id: adId,
            source_type: 'ad',
            headline: 'Agenda tu cita',
            body: 'Conoce la promoción',
            media_type: 'image',
            image_url: 'https://example.test/meta-ad-preview.jpg',
            thumbnail_url: 'https://example.test/meta-ad-thumb.jpg'
          }
        }]
      })
      const [inbound] = await processMetaDirectWebhookPayload({ payload: inboundPayload, eventRowId: `evt-in-${suffix}` })
      contactId = inbound.contactId
      assert.ok(contactId)

      const attribution = await db.get(`
        SELECT detected_source_id, detected_source_type, detected_headline, detected_body, referral_json
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [inboundWamid])
      assert.equal(attribution.detected_source_id, adId)
      assert.equal(attribution.detected_source_type, 'ad')
      assert.equal(attribution.detected_headline, 'Agenda tu cita')
      assert.equal(attribution.detected_body, 'Conoce la promoción')
      assert.equal(JSON.parse(attribution.referral_json).image_url, 'https://example.test/meta-ad-preview.jpg')

      const attributionTouch = await db.get(`
        SELECT detected_source_id, detected_headline
        FROM whatsapp_api_attribution
        WHERE whatsapp_api_message_id = ?
      `, [inbound.messageId])
      assert.equal(attributionTouch.detected_source_id, adId)
      assert.equal(attributionTouch.detected_headline, 'Agenda tu cita')

      const readRequests = []
      setMetaDirectFetchForTest(async (url, options = {}) => {
        readRequests.push({ url, options, body: JSON.parse(options.body) })
        return graphResponse({ success: true })
      })
      const readReceipt = await markLatestInboundWhatsAppApiMessageReadForContact({ contactId })
      assert.equal(readReceipt.attempted, true)
      assert.equal(readReceipt.provider, 'meta_direct')
      assert.equal(readReceipt.providerMessageId, inboundWamid)
      assert.equal(readRequests.length, 1)
      assert.match(readRequests[0].url, new RegExp(`/${phoneNumberId}/messages$`))
      assert.equal(readRequests[0].options.method, 'PUT')
      assert.deepEqual(readRequests[0].body, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: inboundWamid
      })
      assert.equal(
        (await db.get('SELECT status FROM whatsapp_api_messages WHERE wamid = ?', [inboundWamid])).status,
        'read'
      )

      const qrReadProbeId = `qr-read-probe-${suffix}`
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, source_adapter, provider_message_id, wamid,
          contact_id, phone, from_phone, to_phone, business_phone,
          business_phone_number_id, transport, direction, message_type, message_text,
          status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'qr', 'baileys', ?, ?, ?, ?, ?, ?, ?, ?, 'qr', 'inbound', 'text', 'No debe marcarse por QR', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        qrReadProbeId,
        qrReadProbeId,
        qrReadProbeId,
        contactId,
        customerPhone,
        customerPhone,
        businessPhone,
        businessPhone,
        phoneNumberId
      ])
      const qrReadReceipt = await markLatestInboundWhatsAppQrMessageReadForContact({ contactId })
      assert.deepEqual(qrReadReceipt, {
        attempted: false,
        reason: 'official_api_active',
        provider: 'meta_direct'
      })

      const statusPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        statuses: [{
          id: outboundWamid,
          recipient_id: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          status: 'delivered',
          biz_opaque_callback_data: externalId
        }]
      })
      await processMetaDirectWebhookPayload({ payload: statusPayload, eventRowId: `evt-status-${suffix}` })

      const receiptBeforeSend = await db.get(`
        SELECT message_type, message_text, status, contact_id
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [outboundWamid])
      assert.equal(receiptBeforeSend.message_type, 'status')
      assert.equal(receiptBeforeSend.message_text, null)
      assert.equal(receiptBeforeSend.status, 'delivered')
      assert.equal(receiptBeforeSend.contact_id, null)

      await setAppConfig(getWhatsAppApiConfigKeys().metaLastWebhookReceivedAt, '2020-01-01T00:00:00.000Z')
      let graphWamid = outboundWamid
      const sentBodies = []
      const subscriptionRequests = []
      setMetaDirectFetchForTest(async (url, options = {}) => {
        if (url.endsWith(`/${wabaId}/subscribed_apps`)) {
          subscriptionRequests.push({ url, options, body: JSON.parse(options.body) })
          return graphResponse({ success: true })
        }
        const body = JSON.parse(options.body)
        sentBodies.push(body)
        assert.equal(body.messaging_product, 'whatsapp')
        assert.equal(body.to.replace(/\D/g, ''), customerPhone.replace(/\D/g, ''))
        assert.ok(body.biz_opaque_callback_data)
        return graphResponse({
          messaging_product: 'whatsapp',
          contacts: [{ input: customerPhone, wa_id: customerPhone }],
          messages: [{ id: graphWamid, message_status: 'accepted' }]
        })
      })

      const sent = await sendWhatsAppApiTextMessage({
        to: customerPhone,
        from: businessPhone,
        text: 'Hola desde Meta directo',
        externalId,
        contactId,
        phoneNumberId,
        allowQrFallback: false
      })
      assert.equal(sent.wamid, outboundWamid)
      assert.ok(sent.localMessageId)
      assert.equal(sentBodies[0].text.body, 'Hola desde Meta directo')
      assert.equal(sentBodies[0].biz_opaque_callback_data, externalId)
      assert.equal(subscriptionRequests.length, 1)
      assert.equal(subscriptionRequests[0].options.method, 'POST')
      assert.deepEqual(subscriptionRequests[0].body, {})

      const rows = await db.all(`
        SELECT id, provider, source_adapter, meta_message_id, ycloud_message_id,
               wamid, contact_id, message_type, message_text, status, raw_payload_json
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [outboundWamid])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].provider, 'meta_direct')
      assert.equal(rows[0].source_adapter, 'meta_direct')
      assert.equal(rows[0].meta_message_id, outboundWamid)
      assert.equal(rows[0].ycloud_message_id, null)
      assert.equal(rows[0].contact_id, contactId)
      assert.equal(rows[0].message_type, 'text')
      assert.equal(rows[0].message_text, 'Hola desde Meta directo')
      assert.equal(rows[0].status, 'delivered')
      assert.equal(JSON.parse(rows[0].raw_payload_json).deliveryReceipt.status, 'delivered')

      const echoPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        field: 'smb_message_echoes',
        smbMessageEchoes: [{
          id: outboundWamid,
          to: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Hola desde Meta directo' }
        }]
      })
      const [echo] = await processMetaDirectWebhookPayload({ payload: echoPayload, eventRowId: `evt-echo-${suffix}` })
      assert.equal(echo.direction, 'business_echo')
      assert.equal(echo.isNew, false)
      const echoedRows = await db.all(
        'SELECT origin, direction, business_echo, message_type, message_text FROM whatsapp_api_messages WHERE wamid = ?',
        [outboundWamid]
      )
      assert.equal(echoedRows.length, 1)
      assert.deepEqual(echoedRows[0], {
        origin: 'smb_message_echoes',
        direction: 'business_echo',
        business_echo: 1,
        message_type: 'text',
        message_text: 'Hola desde Meta directo'
      })

      graphWamid = outboundReplyWamid
      const reply = await sendWhatsAppApiTextMessage({
        to: customerPhone,
        from: businessPhone,
        text: 'Respuesta al globo',
        externalId: `reply-${suffix}`,
        contactId,
        phoneNumberId,
        replyToMessageId: inbound.messageId,
        allowQrFallback: false
      })
      assert.equal(reply.wamid, outboundReplyWamid)
      assert.equal(sentBodies[1].context.message_id, inboundWamid)

      graphWamid = outboundReactionWamid
      const reaction = await sendWhatsAppApiReactionMessage({
        to: customerPhone,
        from: businessPhone,
        emoji: '👍',
        targetMessageId: inbound.messageId,
        externalId: `reaction-${suffix}`,
        contactId,
        phoneNumberId,
        allowQrFallback: false
      })
      assert.equal(reaction.wamid, outboundReactionWamid)
      assert.equal(sentBodies[2].type, 'reaction')
      assert.deepEqual(sentBodies[2].reaction, { message_id: inboundWamid, emoji: '👍' })

      const inboundReplyPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente CTWA Meta' } }],
        messages: [{
          id: inboundReplyWamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Te respondí este mensaje' },
          context: { from: businessPhone, id: outboundWamid }
        }]
      })
      await processMetaDirectWebhookPayload({ payload: inboundReplyPayload, eventRowId: `evt-in-reply-${suffix}` })

      const inboundReactionPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente CTWA Meta' } }],
        messages: [{
          id: inboundReactionWamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'reaction',
          reaction: { message_id: outboundWamid, emoji: '❤️' }
        }]
      })
      await processMetaDirectWebhookPayload({ payload: inboundReactionPayload, eventRowId: `evt-in-reaction-${suffix}` })

      const readPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        statuses: [{
          id: outboundWamid,
          recipient_id: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          status: 'read'
        }]
      })
      await processMetaDirectWebhookPayload({ payload: readPayload, eventRowId: `evt-read-${suffix}` })

      const afterRead = await db.get(
        'SELECT message_type, message_text, status FROM whatsapp_api_messages WHERE wamid = ?',
        [outboundWamid]
      )
      assert.deepEqual(afterRead, {
        message_type: 'text',
        message_text: 'Hola desde Meta directo',
        status: 'read'
      })

      graphWamid = failedWamid
      const failedSend = await sendWhatsAppApiTextMessage({
        to: customerPhone,
        from: businessPhone,
        text: 'Mensaje que fallará después',
        externalId,
        contactId,
        phoneNumberId,
        allowQrFallback: false
      })
      assert.equal(failedSend.wamid, failedWamid)
      assert.equal(sentBodies[3].text.body, 'Mensaje que fallará después')

      const failedPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        statuses: [{
          id: failedWamid,
          recipient_id: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          status: 'failed',
          errors: [{ code: 131047, message: 'Re-engagement message' }]
        }]
      })
      await processMetaDirectWebhookPayload({ payload: failedPayload, eventRowId: `evt-failed-${suffix}` })

      const failedRows = await db.all(`
        SELECT message_type, message_text, status, error_code
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [failedWamid])
      assert.equal(failedRows.length, 1)
      assert.deepEqual(failedRows[0], {
        message_type: 'text',
        message_text: 'Mensaje que fallará después',
        status: 'failed',
        error_code: '131047'
      })

      const orphanId = `status_orphan_${suffix}`
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, source_adapter, provider_message_id, meta_message_id, wamid,
          contact_id, phone, from_phone, to_phone, business_phone,
          business_phone_number_id, transport, direction, message_type, status,
          message_timestamp, created_at, updated_at
        ) VALUES (?, 'meta_direct', 'meta_direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', 'outbound', 'status', 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        orphanId,
        orphanId,
        orphanId,
        orphanId,
        contactId,
        customerPhone,
        businessPhone,
        customerPhone,
        businessPhone,
        phoneNumberId
      ])

      const conversation = await readConversation(contactId)
      const whatsappMessages = conversation.filter(event => event.type === 'whatsapp_message')
      assert.equal(whatsappMessages.some(event => event.data?.message_type === 'status'), false)
      const ctwaMessage = whatsappMessages.find(event => event.data?.whatsapp_message_id === inboundWamid)
      assert.equal(ctwaMessage.data.referral_source_id, adId)
      assert.equal(ctwaMessage.data.referral_headline, 'Agenda tu cita')
      assert.equal(ctwaMessage.data.referral_image_url, 'https://example.test/meta-ad-preview.jpg')
      const outboundBubbles = whatsappMessages.filter(event => event.data?.whatsapp_message_id === outboundWamid)
      assert.equal(outboundBubbles.length, 1)
      const inboundReply = whatsappMessages.find(event => event.data?.whatsapp_message_id === inboundReplyWamid)
      assert.equal(inboundReply.data.reply_to_provider_message_id, outboundWamid)
      const inboundReaction = whatsappMessages.find(event => event.data?.whatsapp_message_id === inboundReactionWamid)
      assert.equal(inboundReaction.data.reaction_emoji, '❤️')
      assert.equal(inboundReaction.data.reaction_target_provider_message_id, outboundWamid)
      const outboundReplyEvent = whatsappMessages.find(event => event.data?.whatsapp_message_id === outboundReplyWamid)
      assert.equal(outboundReplyEvent.data.reply_to_provider_message_id, inboundWamid)
      const outboundReactionEvent = whatsappMessages.find(event => event.data?.whatsapp_message_id === outboundReactionWamid)
      assert.equal(outboundReactionEvent.data.reaction_emoji, '👍')
      assert.equal(outboundReactionEvent.data.reaction_target_provider_message_id, inboundWamid)
    })
  } finally {
    setMetaDirectFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR detected_source_id = ?', [contactId || '', adId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid IN (?, ?, ?)', [contactId || '', inboundWamid, outboundWamid, failedWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})
