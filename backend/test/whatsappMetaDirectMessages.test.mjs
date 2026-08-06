import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { getDeployDrainSnapshot } from '../src/utils/deployDrainTracker.js'
import { getContactConversation } from '../src/controllers/contactsController.js'
import { markLatestInboundWhatsAppQrMessageReadForContact } from '../src/services/whatsappQrService.js'
import {
  captureQrChatMessage,
  getWhatsAppApiConfigKeys,
  markLatestInboundWhatsAppApiMessageReadForContact,
  processMetaDirectWebhookPayload,
  processMetaDirectWebhookRelay,
  processMetaDirectInboundEnrichmentJob,
  repairWhatsAppProtocolMessageIdentities,
  sendWhatsAppApiReactionMessage,
  sendWhatsAppApiTemplateMessage,
  sendWhatsAppApiTextMessage,
  setMetaDirectInboundMediaHydratorForTest,
  setMetaDirectInboundSideEffectsForTest,
  setMetaDirectFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  CHAT_DELIVERY_JOB_KIND,
  getChatDeliveryJob
} from '../src/services/chatDeliveryOutboxService.js'
import {
  drainMetaDirectChatDeliveryJobs,
  resetMetaDirectChatDeliveryHandlersForTest,
  setMetaDirectChatDeliveryHandlersForTest
} from '../src/jobs/metaDirectChatDelivery.cron.js'

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
  setMetaDirectChatDeliveryHandlersForTest({
    connectionChecker: async () => false,
    pushSender: async () => ({ sent: 1, attempted: 1, retryableFailures: 0 })
  })
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
    keys.metaLastSubscriptionRefreshAt,
    keys.metaLastError
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
    resetMetaDirectChatDeliveryHandlersForTest()
  }
}

test('Meta direct activo ignora el eco vivo de Baileys y conserva la plantilla como API', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_qr_echo_phone_${suffix}`
  const wabaId = `meta_qr_echo_waba_${suffix}`
  const businessPhone = `+1588${Date.now().toString().slice(-7)}`
  const customerPhone = `+5288${Date.now().toString().slice(-8)}`
  const contactId = `rstk_contact_meta_qr_echo_${suffix}`
  const templateId = `rstk_template_meta_qr_echo_${suffix}`
  const templateName = `meta_qr_echo_${suffix.replaceAll('-', '_')}`
  const wamid = `wamid.meta.template.qr.echo.${suffix}`
  const renderedText = 'Hola Abner, esta plantilla salió por Meta.'

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      await db.run(`
        UPDATE whatsapp_api_phone_numbers
        SET qr_send_enabled = 1,
            qr_status = 'connected',
            qr_connected_phone = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [businessPhone, phoneNumberId])
      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, 'Abner Prueba', 'Abner', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [contactId, customerPhone])
      await db.run(`
        INSERT INTO whatsapp_api_templates (
          id, provider, source_adapter, provider_template_id, official_template_id,
          waba_id, name, language, category, status, components_json, raw_payload_json,
          created_at, updated_at
        ) VALUES (?, 'meta_direct', 'meta_direct', ?, ?, ?, ?, 'es_MX', 'MARKETING',
          'APPROVED', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        templateId,
        `meta_template_${suffix}`,
        `meta_template_${suffix}`,
        wabaId,
        templateName,
        JSON.stringify([{ type: 'BODY', text: 'Hola {{1}}, esta plantilla salió por Meta.' }])
      ])

      setMetaDirectFetchForTest(async () => graphResponse({
        messaging_product: 'whatsapp',
        contacts: [{ input: customerPhone, wa_id: customerPhone.replace(/\D/g, '') }],
        messages: [{ id: wamid, message_status: 'accepted' }]
      }))

      const sent = await sendWhatsAppApiTemplateMessage({
        to: customerPhone,
        from: businessPhone,
        templateId,
        variables: { 1: 'Abner' },
        contactId,
        phoneNumberId,
        allowQrFallback: true
      })
      assert.equal(sent.wamid, wamid)

      const qrEcho = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid,
        messageType: 'template',
        text: renderedText,
        contactPhone: customerPhone,
        timestamp: new Date().toISOString()
      })

      assert.deepEqual(qrEcho, {
        skipped: true,
        reason: 'official_api_active'
      })

      const historyEcho = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid,
        messageType: 'template',
        text: renderedText,
        contactPhone: customerPhone,
        timestamp: new Date().toISOString(),
        historyImport: true
      })
      assert.deepEqual(historyEcho, {
        skipped: true,
        reason: 'official_api_message_exists',
        messageId: sent.localMessageId
      })

      const stored = await db.get(`
        SELECT provider, source_adapter, transport, routing_reason,
               meta_message_id, ycloud_message_id, message_type, message_text
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [wamid])
      assert.equal(stored.provider, 'meta_direct')
      assert.equal(stored.source_adapter, 'meta_direct')
      assert.equal(stored.transport, 'api')
      assert.equal(stored.routing_reason, null)
      assert.equal(stored.meta_message_id, wamid)
      assert.equal(stored.ycloud_message_id, null)
      assert.equal(stored.message_type, 'template')
      assert.equal(stored.message_text, renderedText)

      const fallbackAttempts = await db.get(`
        SELECT COUNT(*) AS total
        FROM whatsapp_api_qr_fallback_attempts
        WHERE api_message_id = (SELECT id FROM whatsapp_api_messages WHERE wamid = ?)
      `, [wamid])
      assert.equal(Number(fallbackAttempts.total), 0)

      await db.run(`
        UPDATE whatsapp_api_messages
        SET provider = 'ycloud',
            source_adapter = 'baileys',
            origin = 'whatsapp.qr.message.synced',
            transport = 'qr',
            routing_reason = 'Capturado desde la sesión de WhatsApp Web.'
        WHERE wamid = ?
      `, [wamid])

      const repair = await repairWhatsAppProtocolMessageIdentities({ force: true })
      assert.equal(repair.officialRestored, 1)

      const restored = await db.get(`
        SELECT provider, source_adapter, origin, transport, routing_reason,
               provider_message_id, meta_message_id, ycloud_message_id
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [wamid])
      assert.deepEqual(restored, {
        provider: 'meta_direct',
        source_adapter: 'meta_direct',
        origin: 'whatsapp.message.updated',
        transport: 'api',
        routing_reason: null,
        provider_message_id: wamid,
        meta_message_id: wamid,
        ycloud_message_id: null
      })

      await db.run(`
        UPDATE whatsapp_api_messages
        SET provider = 'meta_direct',
            source_adapter = 'baileys',
            origin = 'whatsapp.qr.message.fallback_sent',
            transport = 'qr',
            routing_reason = 'Fallback QR real y auditado.'
        WHERE wamid = ?
      `, [wamid])
      await db.run(`
        INSERT INTO whatsapp_api_qr_fallback_attempts (
          api_message_id, provider, provider_message_id, fallback_reason, status
        ) VALUES (?, 'meta_direct', ?, 'Fallback QR real y auditado.', 'sent')
      `, [sent.localMessageId, wamid])

      const protectedFallbackRepair = await repairWhatsAppProtocolMessageIdentities({ force: true })
      assert.equal(protectedFallbackRepair.officialRestored, 0)
      const protectedFallback = await db.get(`
        SELECT source_adapter, transport, routing_reason
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [wamid])
      assert.deepEqual(protectedFallback, {
        source_adapter: 'baileys',
        transport: 'qr',
        routing_reason: 'Fallback QR real y auditado.'
      })
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_qr_fallback_attempts WHERE api_message_id IN (SELECT id FROM whatsapp_api_messages WHERE wamid = ?)', [wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

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
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR detected_source_id = ?', [contactId || '', adId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid IN (?, ?, ?)', [contactId || '', inboundWamid, outboundWamid, failedWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})

test('un rechazo ambiguo al marcar leído no desconecta Meta, pero un token inválido sí', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_phone_read_guard_${suffix}`
  const wabaId = `meta_waba_read_guard_${suffix}`
  const businessPhone = `+1555${Date.now().toString().slice(-7)}`
  const customerPhone = `+5255${Date.now().toString().slice(-8)}`
  const inboundWamid = `wamid.meta.read.guard.${suffix}`
  let contactId = ''

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      const [inbound] = await processMetaDirectWebhookPayload({
        payload: webhookEnvelope({
          wabaId,
          phoneNumberId,
          businessPhone,
          contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Read Guard' } }],
          messages: [{
            id: inboundWamid,
            from: customerPhone,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'Mensaje para probar el acuse' }
          }]
        }),
        eventRowId: `evt-read-guard-${suffix}`
      })
      contactId = inbound.contactId

      setMetaDirectFetchForTest(async () => graphResponse({
        error: {
          code: 100,
          error_subcode: 33,
          message: 'Unsupported request for this message receipt.'
        }
      }, 400))

      await assert.rejects(
        () => markLatestInboundWhatsAppApiMessageReadForContact({ contactId }),
        /Unsupported request/
      )
      assert.equal(await db.get(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        [getWhatsAppApiConfigKeys().metaStatus]
      ).then(row => row?.config_value), 'connected')
      assert.deepEqual(await db.get(
        'SELECT status, api_send_enabled FROM whatsapp_api_phone_numbers WHERE id = ?',
        [phoneNumberId]
      ), { status: 'CONNECTED', api_send_enabled: 1 })

      setMetaDirectFetchForTest(async () => graphResponse({
        error: {
          code: 190,
          message: 'Invalid OAuth access token.'
        }
      }, 401))

      await assert.rejects(
        () => markLatestInboundWhatsAppApiMessageReadForContact({ contactId }),
        /perdió permisos en Meta/
      )
      assert.equal(await db.get(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        [getWhatsAppApiConfigKeys().metaStatus]
      ).then(row => row?.config_value), 'reconnect_required')
      assert.deepEqual(await db.get(
        'SELECT status, api_send_enabled FROM whatsapp_api_phone_numbers WHERE id = ?',
        [phoneNumberId]
      ), { status: 'AUTHORIZATION_REQUIRED', api_send_enabled: 0 })
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('Meta direct confirma fila y callback antes de hidratar media, luego actualiza la misma burbuja', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_media_phone_${suffix}`
  const wabaId = `meta_media_waba_${suffix}`
  const businessPhone = `+1556${Date.now().toString().slice(-7)}`
  const customerPhone = `+5256${Date.now().toString().slice(-8)}`
  const wamid = `wamid.meta.media.${suffix}`
  const mediaId = `meta_media_${suffix}`
  let contactId = ''
  let callbackCount = 0
  let releaseHydration
  let reportHydrationStarted
  let hydrationCallCount = 0
  const hydrationGate = new Promise(resolve => { releaseHydration = resolve })
  const hydrationStarted = new Promise(resolve => { reportHydrationStarted = resolve })

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      setMetaDirectChatDeliveryHandlersForTest({
        connectionChecker: async () => false,
        pushSender: async () => ({ sent: 1 })
      })
      setMetaDirectInboundMediaHydratorForTest(async ({ media }) => {
        hydrationCallCount += 1
        reportHydrationStarted()
        await hydrationGate
        return {
          ...media,
          mediaUrl: `/media/assets/${mediaId}/file`,
          mediaMimeType: 'image/jpeg',
          mediaFilename: 'foto-meta.jpg'
        }
      })

      let resolvePersisted
      const persisted = new Promise(resolve => { resolvePersisted = resolve })
      const payload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Media Meta' } }],
        messages: [{
          id: wamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'image',
          image: { id: mediaId, mime_type: 'image/jpeg', caption: 'Mira esta foto' }
        }]
      })

      const processing = processMetaDirectWebhookPayload({
        payload,
        eventRowId: `evt-media-${suffix}`,
        onInboundPersisted: (result) => {
          callbackCount += 1
          resolvePersisted(result)
        }
      })

      const preliminary = await persisted
      contactId = preliminary.contactId
      assert.ok(contactId)
      assert.equal(preliminary.mediaUrl, '')

      const [completed] = await Promise.race([
        processing,
        new Promise((resolve, reject) => setTimeout(
          () => reject(new Error('El ACK local esperó indebidamente la hidratación de Meta')),
          250
        ))
      ])
      assert.equal(completed.messageId, preliminary.messageId)
      assert.equal(completed.mediaUrl, '')
      assert.equal(hydrationCallCount, 0)

      const beforeHydration = await db.get(
        'SELECT id, media_url, message_text FROM whatsapp_api_messages WHERE wamid = ?',
        [wamid]
      )
      assert.ok(beforeHydration?.id)
      assert.equal(beforeHydration.media_url, null)
      assert.equal(beforeHydration.message_text, 'Mira esta foto')
      assert.equal(callbackCount, 1)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM chat_inbound_message_claims WHERE message_id = ?', [beforeHydration.id])).total,
        1
      )

      const pendingJob = await getChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
        messageId: beforeHydration.id
      })
      assert.equal(pendingJob?.status, 'pending')
      assert.doesNotMatch(
        JSON.stringify(pendingJob?.payload || {}),
        /system.?user.?token|authorization|secret/i,
        'el outbox nunca debe persistir credenciales Meta'
      )

      const draining = drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0
      })
      await hydrationStarted
      releaseHydration()
      const drainResult = await draining
      assert.equal(drainResult.completed, 1)
      assert.equal(hydrationCallCount, 1)

      const afterHydration = await db.get(
        'SELECT id, media_url, media_mime_type, media_filename FROM whatsapp_api_messages WHERE wamid = ?',
        [wamid]
      )
      assert.deepEqual(afterHydration, {
        id: beforeHydration.id,
        media_url: `/media/assets/${mediaId}/file`,
        media_mime_type: 'image/jpeg',
        media_filename: 'foto-meta.jpg'
      })

      await processMetaDirectWebhookPayload({
        payload,
        eventRowId: `evt-media-retry-${suffix}`,
        onInboundPersisted: () => { callbackCount += 1 }
      })
      assert.equal(callbackCount, 1)
      assert.equal(hydrationCallCount, 1)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM whatsapp_api_messages WHERE wamid = ?', [wamid])).total,
        1
      )
    })
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    setMetaDirectInboundMediaHydratorForTest(null)
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid = ?', [contactId || '', wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})

test('el relay Meta responde ACK después del claim y antes de descargar media', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_relay_phone_${suffix}`
  const wabaId = `meta_relay_waba_${suffix}`
  const businessPhone = `+1559${Date.now().toString().slice(-7)}`
  const customerPhone = `+5259${Date.now().toString().slice(-8)}`
  const wamid = `wamid.meta.relay.${suffix}`
  const mediaId = `meta_relay_media_${suffix}`
  const licenseKey = `license-${suffix}`
  const installationId = `installation-${suffix}`
  let contactId = ''
  let hydrationCallCount = 0
  let releaseHydration
  let reportHydrationStarted
  let releaseSideEffects
  let reportSideEffectsStarted
  const hydrationGate = new Promise(resolve => { releaseHydration = resolve })
  const hydrationStarted = new Promise(resolve => { reportHydrationStarted = resolve })
  const sideEffectsGate = new Promise(resolve => { releaseSideEffects = resolve })
  const sideEffectsStarted = new Promise(resolve => { reportSideEffectsStarted = resolve })
  const previousIdentity = await db.all(`
    SELECT config_key, config_value
    FROM app_config
    WHERE config_key IN ('license_key', 'installation_id')
  `)

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      await setAppConfig('license_key', licenseKey)
      await setAppConfig('installation_id', installationId)
      setMetaDirectChatDeliveryHandlersForTest({
        connectionChecker: async () => false,
        pushSender: async () => ({ sent: 1 })
      })
      setMetaDirectInboundSideEffectsForTest(async () => {
        reportSideEffectsStarted()
        await sideEffectsGate
      })
      setMetaDirectFetchForTest(async () => graphResponse({ data: [] }))
      setMetaDirectInboundMediaHydratorForTest(async ({ media }) => {
        hydrationCallCount += 1
        reportHydrationStarted()
        await hydrationGate
        return {
          ...media,
          mediaUrl: `/media/assets/${mediaId}/file`,
          mediaMimeType: 'image/jpeg',
          mediaFilename: 'relay.jpg'
        }
      })

      const payload = {
        id: `relay-event-${suffix}`,
        ...webhookEnvelope({
          wabaId,
          phoneNumberId,
          businessPhone,
          contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Relay Meta' } }],
          messages: [{
            id: wamid,
            from: customerPhone,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'image',
            image: { id: mediaId, mime_type: 'image/jpeg' }
          }]
        })
      }
      const rawBody = JSON.stringify(payload)
      const signatureTimestamp = String(Date.now())
      const signatureNonce = `nonce-${suffix}`
      const signature = createHmac('sha256', licenseKey)
        .update(`${signatureTimestamp}.${signatureNonce}.${rawBody}`)
        .digest('hex')

      const relayResult = await Promise.race([
        processMetaDirectWebhookRelay({
          payload,
          rawBody,
          headers: { signature, signatureTimestamp, signatureNonce, installationId }
        }),
        new Promise((resolve, reject) => setTimeout(
          () => reject(new Error('El relay no respondió antes de la hidratación')),
          250
        ))
      ])
      assert.equal(relayResult.processed, true)
      assert.equal(hydrationCallCount, 0)
      await sideEffectsStarted
      assert.equal(getDeployDrainSnapshot().byKind['meta-direct-inbound-side-effects'], 1)

      const stored = await db.get(
        'SELECT id, contact_id, media_url FROM whatsapp_api_messages WHERE wamid = ?',
        [wamid]
      )
      assert.ok(stored?.id)
      contactId = stored.contact_id
      assert.equal(stored.media_url, null)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM chat_inbound_message_claims WHERE message_id = ?', [stored.id])).total,
        1
      )
      assert.equal(
        (await getChatDeliveryJob({
          jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
          messageId: stored.id
        }))?.status,
        'pending'
      )

      const draining = drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0
      })
      await hydrationStarted
      assert.equal(hydrationCallCount, 1)
      releaseHydration()
      assert.equal((await draining).completed, 1)
      releaseSideEffects()
      await new Promise(resolve => setImmediate(resolve))
    })
  } finally {
    releaseHydration?.()
    releaseSideEffects?.()
    resetMetaDirectChatDeliveryHandlersForTest()
    setMetaDirectInboundSideEffectsForTest(null)
    setMetaDirectInboundMediaHydratorForTest(null)
    setMetaDirectFetchForTest(null)
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE id = ?', [`relay-event-${suffix}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_meta_direct_nonces WHERE nonce = ?', [`nonce-${suffix}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid = ?', [contactId || '', wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run("DELETE FROM app_config WHERE config_key IN ('license_key', 'installation_id')")
    for (const row of previousIdentity) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
})

test('enrichment reconstruye attribution si el worker encuentra la fila base ausente', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_attr_race_phone_${suffix}`
  const wabaId = `meta_attr_race_waba_${suffix}`
  const businessPhone = `+1560${Date.now().toString().slice(-7)}`
  const customerPhone = `+5260${Date.now().toString().slice(-8)}`
  const wamid = `wamid.meta.attr.race.${suffix}`
  const adId = `ad-race-${suffix}`
  let contactId = ''

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      setMetaDirectChatDeliveryHandlersForTest({
        connectionChecker: async () => false,
        pushSender: async () => ({ sent: 1 })
      })
      const payload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Attribution Race' } }],
        messages: [{
          id: wamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Vengo del anuncio' },
          referral: {
            source_id: adId,
            source_type: 'ad',
            headline: 'Anuncio durable',
            image_url: 'https://example.test/preview-no-remoto.jpg'
          }
        }]
      })
      const [result] = await processMetaDirectWebhookPayload({
        payload,
        eventRowId: `evt-attr-race-${suffix}`
      })
      contactId = result.contactId
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ?', [result.messageId])).total,
        1,
        'la attribution base debe confirmarse dentro del mismo commit que el outbox'
      )

      await db.run('DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ?', [result.messageId])
      const drained = await drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0
      })
      assert.equal(drained.completed, 1)
      const rebuilt = await db.get(`
        SELECT detected_source_id, detected_headline
        FROM whatsapp_api_attribution
        WHERE whatsapp_api_message_id = ?
      `, [result.messageId])
      assert.deepEqual(rebuilt, {
        detected_source_id: adId,
        detected_headline: 'Anuncio durable'
      })
    })
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR detected_source_id = ?', [contactId || '', adId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid = ?', [contactId || '', wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})

test('retry de media Meta recupera la misma fila sin duplicar claim ni callback push', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_media_retry_phone_${suffix}`
  const wabaId = `meta_media_retry_waba_${suffix}`
  const businessPhone = `+1557${Date.now().toString().slice(-7)}`
  const customerPhone = `+5257${Date.now().toString().slice(-8)}`
  const wamid = `wamid.meta.media.retry.${suffix}`
  const mediaId = `meta_media_retry_${suffix}`
  let contactId = ''
  let callbackCount = 0
  let hydrationCallCount = 0

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      setMetaDirectChatDeliveryHandlersForTest({
        connectionChecker: async () => false,
        pushSender: async () => ({ sent: 1 })
      })
      const payload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Retry Meta' } }],
        messages: [{
          id: wamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'document',
          document: { id: mediaId, mime_type: 'application/pdf', filename: 'cotizacion.pdf' }
        }]
      })

      setMetaDirectInboundMediaHydratorForTest(async () => {
        hydrationCallCount += 1
        throw new Error('Graph temporalmente no disponible')
      })
      const [acknowledged] = await processMetaDirectWebhookPayload({
        payload,
        eventRowId: `evt-media-failed-${suffix}`,
        onInboundPersisted: (result) => {
          callbackCount += 1
          contactId = result.contactId
        }
      })
      assert.ok(acknowledged.messageId)

      const firstRow = await db.get(
        'SELECT id, contact_id, media_url FROM whatsapp_api_messages WHERE wamid = ?',
        [wamid]
      )
      assert.ok(firstRow?.id)
      contactId = firstRow.contact_id
      assert.equal(firstRow.media_url, null)
      assert.equal(callbackCount, 1)

      const failedDrain = await drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0,
        maxJobs: 1
      })
      assert.equal(failedDrain.failed, 1)
      const pendingRetry = await getChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
        messageId: firstRow.id
      })
      assert.equal(pendingRetry?.status, 'pending')
      assert.match(pendingRetry?.last_error || '', /Graph temporalmente no disponible/)

      setMetaDirectInboundMediaHydratorForTest(async ({ media }) => {
        hydrationCallCount += 1
        return {
          ...media,
          mediaUrl: `/media/assets/${mediaId}/file`,
          mediaMimeType: 'application/pdf',
          mediaFilename: 'cotizacion.pdf'
        }
      })
      const recoveredDrain = await drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0
      })
      assert.equal(recoveredDrain.completed, 1)

      const [retried] = await processMetaDirectWebhookPayload({
        payload,
        eventRowId: `evt-media-retry-${suffix}`,
        onInboundPersisted: () => { callbackCount += 1 }
      })

      assert.equal(retried.messageId, firstRow.id)
      assert.equal(retried.isNew, false)
      assert.equal(retried.mediaUrl, `/media/assets/${mediaId}/file`)
      assert.equal(callbackCount, 1)
      assert.equal(hydrationCallCount, 2)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM whatsapp_api_messages WHERE wamid = ?', [wamid])).total,
        1
      )
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM chat_inbound_message_claims WHERE message_id = ?', [firstRow.id])).total,
        1
      )
    })
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    setMetaDirectInboundMediaHydratorForTest(null)
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid = ?', [contactId || '', wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})

test('duplicados concurrentes Meta crean un solo job y una sola hidratación durable', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_media_concurrent_phone_${suffix}`
  const wabaId = `meta_media_concurrent_waba_${suffix}`
  const businessPhone = `+1558${Date.now().toString().slice(-7)}`
  const customerPhone = `+5258${Date.now().toString().slice(-8)}`
  const wamid = `wamid.meta.media.concurrent.${suffix}`
  const mediaId = `meta_media_concurrent_${suffix}`
  let contactId = ''
  let callbackCount = 0
  let hydrationCallCount = 0

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      setMetaDirectChatDeliveryHandlersForTest({
        connectionChecker: async () => false,
        pushSender: async () => ({ sent: 1 })
      })
      setMetaDirectInboundMediaHydratorForTest(async ({ media }) => {
        hydrationCallCount += 1
        return {
          ...media,
          mediaUrl: `/media/assets/${mediaId}/file`,
          mediaMimeType: 'image/jpeg',
          mediaFilename: 'concurrente.jpg'
        }
      })

      const payload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        contacts: [{ wa_id: customerPhone, profile: { name: 'Cliente Concurrente Meta' } }],
        messages: [{
          id: wamid,
          from: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'image',
          image: { id: mediaId, mime_type: 'image/jpeg' }
        }]
      })

      const [firstResults, secondResults] = await Promise.all([
        processMetaDirectWebhookPayload({
          payload,
          eventRowId: `evt-concurrent-a-${suffix}`,
          onInboundPersisted: result => {
            callbackCount += 1
            contactId = result.contactId
          }
        }),
        processMetaDirectWebhookPayload({
          payload,
          eventRowId: `evt-concurrent-b-${suffix}`,
          onInboundPersisted: result => {
            callbackCount += 1
            contactId = result.contactId
          }
        })
      ])

      const messageId = firstResults[0]?.messageId || secondResults[0]?.messageId
      contactId = firstResults[0]?.contactId || secondResults[0]?.contactId || contactId
      assert.ok(messageId)
      assert.equal(callbackCount, 1)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM whatsapp_api_messages WHERE wamid = ?', [wamid])).total,
        1
      )
      assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM chat_inbound_message_claims WHERE message_id = ?', [messageId])).total,
        1
      )
      assert.equal(
        (await db.get(`
          SELECT COUNT(*) AS total
          FROM chat_delivery_outbox
          WHERE job_kind = 'meta_enrichment' AND message_id = ?
        `, [messageId])).total,
        1
      )

      const drained = await drainMetaDirectChatDeliveryJobs({
        requireConnected: false,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT],
        retryDelayMs: 0
      })
      assert.equal(drained.completed, 1)
      assert.equal(hydrationCallCount, 1)

      const rerun = await processMetaDirectInboundEnrichmentJob({
        messageId,
        payload: {
          attribution: {},
          shouldHydrateAttributionPreview: false,
          hasMedia: true,
          businessPhoneNumberId: phoneNumberId
        }
      })
      assert.equal(rerun.changed, false)
      assert.equal(hydrationCallCount, 1, 'un mensaje ya hidratado debe ser no-op')
    })
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    setMetaDirectInboundMediaHydratorForTest(null)
    await db.run('DELETE FROM chat_delivery_outbox WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR wamid = ?', [contactId || '', wamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId || '']).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId || '', customerPhone]).catch(() => undefined)
  }
})
