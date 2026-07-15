import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WHATSAPP_PROVIDER_META_DIRECT,
  WHATSAPP_PROVIDER_QR,
  WHATSAPP_PROVIDER_YCLOUD,
  getWhatsAppProviderDefinitions,
  isOfficialWhatsAppApiProvider,
  resolveWhatsAppMessageIdentifiers,
  resolveWhatsAppSourceAdapter
} from '../src/services/whatsapp/providers/providerRegistry.js'
import {
  extractWhatsAppClientMessageKeyFromWamid,
  resolveWhatsAppProtocolMessageKey,
  wamidContainsWhatsAppClientMessageKey
} from '../src/utils/whatsappProtocolIdentity.js'

test('declares YCloud and Meta Direct as distinct official providers', () => {
  const providers = getWhatsAppProviderDefinitions()
  assert.deepEqual(providers.map(item => item.id), [
    WHATSAPP_PROVIDER_YCLOUD,
    WHATSAPP_PROVIDER_META_DIRECT,
    WHATSAPP_PROVIDER_QR
  ])
  assert.equal(isOfficialWhatsAppApiProvider(WHATSAPP_PROVIDER_YCLOUD), true)
  assert.equal(isOfficialWhatsAppApiProvider(WHATSAPP_PROVIDER_META_DIRECT), true)
  assert.equal(isOfficialWhatsAppApiProvider(WHATSAPP_PROVIDER_QR), false)
  assert.equal(isOfficialWhatsAppApiProvider('future_provider_not_registered'), false)
})

test('keeps provider IDs in their own legacy columns', () => {
  assert.deepEqual(resolveWhatsAppMessageIdentifiers({
    provider: WHATSAPP_PROVIDER_YCLOUD,
    transport: 'api',
    messageId: 'ycloud-id',
    wamid: 'wamid.shared'
  }), {
    provider: WHATSAPP_PROVIDER_YCLOUD,
    sourceAdapter: 'ycloud',
    providerMessageId: 'ycloud-id',
    ycloudMessageId: 'ycloud-id',
    metaMessageId: '',
    wamid: 'wamid.shared'
  })

  assert.deepEqual(resolveWhatsAppMessageIdentifiers({
    provider: WHATSAPP_PROVIDER_META_DIRECT,
    transport: 'api',
    messageId: 'wamid.meta',
    wamid: 'wamid.meta'
  }), {
    provider: WHATSAPP_PROVIDER_META_DIRECT,
    sourceAdapter: 'meta_direct',
    providerMessageId: 'wamid.meta',
    ycloudMessageId: '',
    metaMessageId: 'wamid.meta',
    wamid: 'wamid.meta'
  })
})

test('labels every QR transport as Baileys without impersonating an official adapter', () => {
  assert.equal(resolveWhatsAppSourceAdapter({ provider: WHATSAPP_PROVIDER_YCLOUD, transport: 'qr' }), 'baileys')
  assert.deepEqual(resolveWhatsAppMessageIdentifiers({
    provider: WHATSAPP_PROVIDER_META_DIRECT,
    transport: 'qr',
    messageId: 'baileys-id'
  }), {
    provider: WHATSAPP_PROVIDER_META_DIRECT,
    sourceAdapter: 'baileys',
    providerMessageId: 'baileys-id',
    ycloudMessageId: '',
    metaMessageId: '',
    wamid: ''
  })
})

test('reconciles the YCloud coexistence WAMID with the exact Baileys message key', () => {
  const baileysKey = '2AB6D0F198A01CB993EA'
  const coexistenceWamid = 'wamid.HBgNNTIxNDQ0MjA3Njc4NhUCABEYFDJBQjZEMEYxOThBMDFDQjk5M0VBAA=='

  assert.equal(extractWhatsAppClientMessageKeyFromWamid(coexistenceWamid), baileysKey)
  assert.equal(resolveWhatsAppProtocolMessageKey({ transport: 'api', wamid: coexistenceWamid }), baileysKey)
  assert.equal(resolveWhatsAppProtocolMessageKey({ transport: 'qr', wamid: baileysKey }), baileysKey)
  assert.equal(wamidContainsWhatsAppClientMessageKey(coexistenceWamid, baileysKey), true)
  assert.equal(wamidContainsWhatsAppClientMessageKey(coexistenceWamid, '2A107A68B47DA3E71797'), false)
})

test('does not invent protocol identities for opaque provider IDs', () => {
  assert.equal(extractWhatsAppClientMessageKeyFromWamid('ycloud-message-id'), '')
  assert.equal(resolveWhatsAppProtocolMessageKey({ transport: 'qr', wamid: 'wamid.not-base64' }), '')
  assert.equal(resolveWhatsAppProtocolMessageKey({ transport: 'qr', wamid: 'short' }), '')
})
