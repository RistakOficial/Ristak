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
