import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { captureWhatsAppMessageDeletion, processMetaDirectWebhookPayload, processMetaDirectInboundEnrichmentJob, markLatestInboundWhatsAppApiMessageReadForContact } from '../src/services/whatsappApiService.js'
import { handleQrMessageUpdates } from '../src/services/whatsappQrService.js'
import { processMetaSocialWebhook, upsertMetaSocialMessage, setMetaSocialMediaTransportForTest } from '../src/services/metaSocialMessagingService.js'
import { subscribeChatLiveEvents } from '../src/services/chatLiveEventsService.js'
import { getContactConversation } from '../src/controllers/contactsController.js'
import { enqueueChatDeliveryJob, getChatDeliveryJob } from '../src/services/chatDeliveryOutboxService.js'
import { redactRemovedChatMessage } from '../src/utils/chatMessageDeletion.js'

const business = '+15550001111', customer = '+15550002222'
const originalTimestamp = '2026-07-13T18:10:00.000Z'
const id = prefix => `${prefix}_${randomUUID()}`
function envelope(messages, field = 'messages', statuses = []) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba-delete-test', changes: [{ field,
    value: { metadata: { display_phone_number: business, phone_number_id: 'phone-delete-test' }, messages, statuses }
  }] }] }
}
async function seedContact() {
  const existing = await db.get('SELECT id FROM contacts WHERE phone = ?', [customer])
  if (existing) return existing.id
  const contactId = id('contact')
  await db.run("INSERT INTO contacts (id, phone, full_name) VALUES (?, ?, 'Delete fixture')", [contactId, customer])
  return contactId
}
async function seedWhatsApp(direction = 'inbound', protocolKey = null) {
  const messageId = id('message'), wamid = `wamid.${randomUUID()}`, contactId = await seedContact()
  await db.run(`INSERT INTO whatsapp_api_messages (id, contact_id, provider, source_adapter, provider_message_id,
    meta_message_id, wamid, protocol_message_key_id, business_phone, phone, from_phone, to_phone,
    direction, transport, status, message_type, message_text, media_url, media_mime_type,
    context_json, raw_payload_json, message_timestamp)
    VALUES (?, ?, 'meta_direct', 'meta_direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', 'delivered',
    'image', 'Foto privada', 'https://cdn.example.test/private.jpg', 'image/jpeg', ?, ?, ?)`,
  [messageId, contactId, wamid, wamid, wamid, protocolKey, business, customer,
    direction === 'inbound' ? customer : business, direction === 'inbound' ? business : customer,
    direction, '{"quotedText":"Privado"}', '{"image":{"url":"https://cdn.example.test/private.jpg"}}', originalTimestamp])
  return { messageId, wamid, contactId }
}
async function conversation(contactId) {
  const res = { status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  await getContactConversation({ params: { id: contactId }, query: {} }, res)
  assert.equal(res.body?.success, true, JSON.stringify(res.body))
  return res.body.data
}
for (const direction of ['inbound', 'outbound']) {
  test(`WhatsApp revoke ${direction}: elimina texto/media, refresca chat y no revive con ACK/eco`, async () => {
    const { messageId, wamid, contactId } = await seedWhatsApp(direction)
    await enqueueChatDeliveryJob({ jobKind: 'push', messageId, contactId, provider: 'meta_direct', payload: { text: 'Foto privada' } })
    const stream = []
    const unsubscribe = subscribeChatLiveEvents({ on() {} }, { status() {}, set() {}, on() {}, write(chunk) { stream.push(chunk) } })
    try {
      const payload = envelope([{ id: id('revoke'), from: direction === 'inbound' ? customer : business,
        ...(direction === 'outbound' ? { to: customer } : {}), type: 'revoke',
        revoke: { original_message_id: wamid }, timestamp: '1783966260' }],
      direction === 'outbound' ? 'smb_message_echoes' : 'messages')
      for (let i = 0; i < 2; i++) {
        const result = await processMetaDirectWebhookPayload({ payload })
        assert.equal(result[0].messageId, messageId)
        assert.equal(result[0].isNew, false)
      }
      await processMetaDirectWebhookPayload({ payload: envelope([], 'messages', [{ id: wamid, recipient_id: customer, status: 'read' }]) })
      await processMetaDirectWebhookPayload({ payload: envelope([{ id: wamid, from: customer, type: 'image', image: { id: 'must-not-download' } }]) })
      const stored = await db.get('SELECT * FROM whatsapp_api_messages WHERE id = ?', [messageId])
      assert.equal(stored.status, 'removed')
      assert.equal(stored.message_text, 'Mensaje anulado')
      assert.equal(stored.media_url, null)
      assert.equal(stored.context_json, null)
      assert.equal(new Date(stored.message_timestamp).toISOString(), originalTimestamp)
      assert.equal(stored.raw_payload_json.includes('private.jpg'), false)
      assert.equal((await getChatDeliveryJob({ jobKind: 'push', messageId })).status, 'completed')
      assert.ok(stream.join('').includes(`"messageId":"${messageId}"`))
      assert.ok(stream.join('').includes('"isNew":false'))
      const event = (await conversation(contactId)).find(item => item.data?.whatsapp_api_message_id === messageId)
      assert.equal(event.data.message_text, 'Mensaje anulado')
      assert.equal(event.data.media_url, undefined)
      assert.equal(event.data.message_presentation, undefined)
      assert.equal((await processMetaDirectInboundEnrichmentJob({ messageId, payload: { hasMedia: true } })).reason, 'message_removed')
    } finally { unsubscribe() }
  })
}
test('WhatsApp: anulación anterior al original no crea contactos ni unread', async () => {
  const wamid = `wamid.${randomUUID()}`, before = await db.get('SELECT COUNT(*) AS count FROM contacts')
  await processMetaDirectWebhookPayload({ payload: envelope([{ id: id('event'), from: customer, type: 'revoke', revoke: { original_message_id: wamid } }]) })
  const [result] = await processMetaDirectWebhookPayload({ payload: envelope([{ id: wamid, from: customer, type: 'text', text: { body: 'No debe revivir' } }]) })
  assert.equal(result.status, 'removed')
  assert.equal(result.isNew, false)
  assert.equal(result.contactId, null)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM contacts')).count, before.count)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM chat_inbound_message_claims WHERE message_id = ?', [result.messageId])).count, 0)
})
test('WhatsApp: ignora otro negocio/participante y revoke sin destino', async () => {
  const { messageId, wamid } = await seedWhatsApp()
  for (const fields of [{ businessPhone: '+15550009999' }, { contactPhone: '+15550009999' }, { providerMessageId: '' }]) {
    const result = await captureWhatsAppMessageDeletion({ providerMessageId: wamid, businessPhone: business, contactPhone: customer, ...fields })
    assert.equal(result.ignored, true)
  }
  assert.equal((await db.get('SELECT status FROM whatsapp_api_messages WHERE id = ?', [messageId])).status, 'delivered')
})
test('abrir el chat no marca como leído ni revive un WhatsApp anulado', async () => {
  const { messageId, wamid } = await seedWhatsApp()
  const contactId = id('read-deleted-contact')
  await db.run("INSERT INTO contacts (id, full_name) VALUES (?, 'Read deleted fixture')", [contactId])
  await db.run('UPDATE whatsapp_api_messages SET contact_id = ? WHERE id = ?', [contactId, messageId])
  await captureWhatsAppMessageDeletion({ providerMessageId: wamid, businessPhone: business, contactPhone: customer })
  const result = await markLatestInboundWhatsAppApiMessageReadForContact({ contactId })
  assert.equal(result.attempted, false)
  assert.equal(result.reason, 'no_unread_inbound_message')
  assert.equal((await db.get('SELECT status FROM whatsapp_api_messages WHERE id = ?', [messageId])).status, 'removed')
})
test('QR REVOKE encuentra la copia API por identidad; update vacío no borra', async () => {
  const protocolKey = '3ABC0123456789ABCDEF0123456789ABC', { messageId } = await seedWhatsApp('inbound', protocolKey)
  const phone = { id: 'phone-qr-delete', expectedPhone: business }
  const key = { id: protocolKey, remoteJid: '15550002222@s.whatsapp.net', fromMe: false }
  await handleQrMessageUpdates(phone, [{ key, update: { message: null } }])
  assert.equal((await db.get('SELECT status FROM whatsapp_api_messages WHERE id = ?', [messageId])).status, 'delivered')
  await handleQrMessageUpdates(phone, [{ key, update: { message: null, messageStubType: 1 } }])
  assert.equal((await db.get('SELECT status FROM whatsapp_api_messages WHERE id = ?', [messageId])).status, 'removed')
  await handleQrMessageUpdates(phone, [{ key, update: { status: 4 } }])
  assert.equal((await db.get('SELECT status FROM whatsapp_api_messages WHERE id = ?', [messageId])).status, 'removed')
})
for (const platform of ['instagram', 'messenger']) {
  for (const direction of ['inbound', 'outbound']) {
    test(`${platform} ${direction}: anula MID importado sin crear perfil ni conservar media`, async () => {
      await setAppConfig(`meta_${platform}_messaging_enabled`, '1')
      const messageId = id('imported'), mid = id('mid'), contactId = await seedContact()
      const businessId = `${platform}-delete-business`, participant = `${platform}-delete-customer`
      const sender = direction === 'outbound' ? businessId : participant, recipient = direction === 'outbound' ? participant : businessId
      await db.run(`INSERT INTO meta_social_messages (id, platform, meta_message_id, contact_id, sender_id, recipient_id,
        direction, status, message_type, message_text, media_url, message_timestamp, raw_payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', 'image', 'Privado', 'https://cdn.example.test/private.jpg', ?, '{"text":"Privado"}')`,
      [messageId, platform, mid, contactId, sender, recipient, direction, originalTimestamp])
      const payload = { object: platform === 'instagram' ? 'instagram' : 'page', entry: [{ id: businessId, messaging: [{
        sender: { id: sender }, recipient: { id: recipient }, message: { mid, is_deleted: true,
          ...(direction === 'outbound' ? { is_echo: true } : {}), text: 'Texto residual',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/private.jpg' } }] }
      }] }] }
      const before = await db.get('SELECT COUNT(*) AS count FROM contacts')
      await processMetaSocialWebhook({ payload, signaturePreverified: true })
      await processMetaSocialWebhook({ payload, signaturePreverified: true })
      const stored = await db.get('SELECT * FROM meta_social_messages WHERE id = ?', [messageId])
      assert.equal(stored.status, 'removed')
      assert.equal(stored.media_url, null)
      assert.equal(stored.message_text, 'Mensaje anulado')
      assert.equal(stored.raw_payload_json.includes('private.jpg'), false)
      assert.equal(stored.raw_payload_json.includes('Texto residual'), false)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM contacts')).count, before.count)
      setMetaSocialMediaTransportForTest({ downloader: async () => { assert.fail('no descargar media anulada') } })
      try {
        const replay = await upsertMetaSocialMessage({ socialContactId: null, contactId, socialMessage: {
          platform, metaMessageId: mid, senderId: participant, recipientId: businessId, direction, status: 'sent',
          messageType: 'image', messageText: 'Texto viejo', mediaUrl: 'https://lookaside.fbsbx.com/old.jpg', messageTimestamp: originalTimestamp
        } })
        assert.equal(replay.isNew, false)
        assert.equal(replay.messageId, messageId)
      } finally { setMetaSocialMediaTransportForTest({}) }
    })
  }
}
for (const platform of ['instagram', 'messenger']) {
  test(`${platform}: anulación sin eco antes del original conserva identidad y no crea contactos`, async () => {
    await setAppConfig(`meta_${platform}_messaging_enabled`, '1')
    const businessId = id('business'), participant = id('customer'), mid = id('mid')
    const event = { sender: { id: businessId }, recipient: { id: participant }, message: { mid, is_deleted: true } }
    const payload = { object: platform === 'instagram' ? 'instagram' : 'page', entry: [{ id: businessId, messaging: [event] }] }
    const before = await db.get('SELECT COUNT(*) AS count FROM contacts')
    await processMetaSocialWebhook({ payload, signaturePreverified: true })
    event.message = { mid, is_echo: true, text: 'No debe reaparecer' }
    await processMetaSocialWebhook({ payload, signaturePreverified: true })
    const rows = await db.all('SELECT * FROM meta_social_messages WHERE meta_message_id = ?', [mid])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'removed')
    assert.equal(rows[0].direction, 'outbound')
    assert.equal(rows[0].contact_id, null)
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM contacts')).count, before.count)
  })
}
test('Meta: anula copias heredadas del mismo MID y respeta otro participante', async () => {
  await setAppConfig('meta_messenger_messaging_enabled', '1')
  const mid = id('duplicate-mid'), businessId = id('page'), participant = id('customer')
  const messageIds = [id('copy'), id('copy'), id('other')]
  for (const [index, messageId] of messageIds.entries()) {
    await db.run(`INSERT INTO meta_social_messages (id, platform, meta_message_id, sender_id, recipient_id,
      direction, status, message_type, message_text, message_timestamp)
      VALUES (?, 'messenger', ?, ?, ?, 'inbound', 'received', 'text', 'Privado', ?)`,
    [messageId, mid, index === 2 ? id('other-customer') : participant, businessId, originalTimestamp])
  }
  await processMetaSocialWebhook({ signaturePreverified: true, payload: { object: 'page', entry: [{ id: businessId, messaging: [{
    sender: { id: participant }, recipient: { id: businessId }, message: { mid, is_deleted: true }
  }] }] } })
  for (const [index, messageId] of messageIds.entries()) {
    const row = await db.get('SELECT status, message_text FROM meta_social_messages WHERE id = ?', [messageId])
    assert.equal(row.status, index === 2 ? 'received' : 'removed')
    assert.equal(row.message_text, index === 2 ? 'Privado' : 'Mensaje anulado')
  }
})
test('chat anulado no reconstruye plantilla, ubicación ni media legacy', () => {
  assert.deepEqual(redactRemovedChatMessage({ status: 'removed', message_type: 'template', direction: 'outbound',
    provider_message_id: 'mid', message_text: 'privado', media_url: 'url', postback_payload: 'secreto',
    message_presentation: { body: 'privado' }, referral_body: 'privado', latitude: 10 }),
  { status: 'removed', message_type: 'text', message_text: 'Mensaje anulado', direction: 'outbound', provider_message_id: 'mid' })
})
