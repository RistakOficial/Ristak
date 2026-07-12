import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMetaDirectWebhookPayload } from '../src/services/whatsapp/providers/metaDirectWebhookAdapter.js'

const config = {
  displayPhoneNumber: '+15550001111',
  phoneNumberId: 'phone-number-id',
  wabaId: 'waba-id'
}

function envelope(value, field = 'messages') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-id', changes: [{ field, value }] }]
  }
}

test('normalizes inbound messages and preserves Meta user identity', () => {
  const [item] = normalizeMetaDirectWebhookPayload(envelope({
    metadata: { display_phone_number: '+15550001111', phone_number_id: 'phone-number-id' },
    contacts: [{
      wa_id: '5215551234567',
      parent_wa_id: 'US.parent',
      profile: { name: 'Ana', username: '@ana' }
    }],
    messages: [{ id: 'wamid.inbound', from: '5215551234567', timestamp: '1710000000', type: 'text', text: { body: 'Hola' } }]
  }), config)

  assert.equal(item.direction, 'inbound')
  assert.equal(item.kind, 'message')
  assert.equal(item.historyImport, false)
  assert.equal(item.message.provider, 'meta_direct')
  assert.equal(item.message.metaMessageId, 'wamid.inbound')
  assert.equal(item.message.customerProfile.name, 'Ana')
  assert.equal(item.message.customerProfile.username, '@ana')
  assert.equal(item.message.customerProfile.whatsappUserId, '5215551234567')
  assert.equal(item.message.customerProfile.parentWhatsAppUserId, 'US.parent')
})

test('normalizes app echoes and delivery statuses separately', () => {
  const items = normalizeMetaDirectWebhookPayload(envelope({
    metadata: { display_phone_number: '+15550001111', phone_number_id: 'phone-number-id' },
    smb_message_echoes: [{ id: 'wamid.echo', to: '5215551234567', timestamp: '1710000001', type: 'text', text: { body: 'Desde la app' } }],
    statuses: [{ id: 'wamid.sent', recipient_id: '5215551234567', timestamp: '1710000002', status: 'delivered' }]
  }), config)

  assert.equal(items[0].direction, 'business_echo')
  assert.equal(items[0].message.businessEcho, true)
  assert.equal(items[1].direction, 'outbound')
  assert.equal(items[1].kind, 'status')
  assert.equal(items[1].message.status, 'delivered')
})

test('preserves the official Click to WhatsApp referral payload', () => {
  const referral = {
    source_url: 'https://www.facebook.com/ads/example',
    source_id: '120123456789',
    source_type: 'ad',
    headline: 'Agenda tu cita',
    body: 'Conoce la promoción',
    media_type: 'image',
    image_url: 'https://lookaside.fbsbx.com/ad-preview.jpg',
    thumbnail_url: 'https://lookaside.fbsbx.com/ad-thumb.jpg'
  }
  const [item] = normalizeMetaDirectWebhookPayload(envelope({
    metadata: { display_phone_number: '+15550001111', phone_number_id: 'phone-number-id' },
    contacts: [{ wa_id: '5215551234567', profile: { name: 'Ana' } }],
    messages: [{
      id: 'wamid.ctwa',
      from: '5215551234567',
      timestamp: '1710000000',
      type: 'text',
      text: { body: 'Quiero información' },
      referral
    }]
  }), config)

  assert.deepEqual(item.message.referral, referral)
})

test('marks Coexistence history as import so it cannot trigger live side effects', () => {
  const items = normalizeMetaDirectWebhookPayload(envelope({
    metadata: { display_phone_number: '+15550001111', phone_number_id: 'phone-number-id' },
    history: [{
      threads: [{
        id: 'thread-1',
        messages: [
          { id: 'wamid.old.in', from: '5215551234567', timestamp: '1700000000', type: 'text', text: { body: 'Mensaje viejo' } },
          { id: 'wamid.old.out', from: '+15550001111', to: '5215551234567', timestamp: '1700000001', type: 'text', text: { body: 'Respuesta vieja' } }
        ]
      }]
    }]
  }, 'history'), config)

  assert.equal(items.length, 2)
  assert.equal(items[0].historyImport, true)
  assert.equal(items[0].message.historyImport, true)
  assert.equal(items[0].direction, 'inbound')
  assert.equal(items[1].direction, 'business_echo')
})
