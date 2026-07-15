export const WHATSAPP_PROVIDER_YCLOUD = 'ycloud'
export const WHATSAPP_PROVIDER_META_DIRECT = 'meta_direct'
export const WHATSAPP_PROVIDER_QR = 'qr'

export const WHATSAPP_SOURCE_ADAPTER_YCLOUD = 'ycloud'
export const WHATSAPP_SOURCE_ADAPTER_META_DIRECT = 'meta_direct'
export const WHATSAPP_SOURCE_ADAPTER_BAILEYS = 'baileys'

export const WHATSAPP_TRANSPORT_API = 'api'
export const WHATSAPP_TRANSPORT_QR = 'qr'

const DEFINITIONS = Object.freeze({
  [WHATSAPP_PROVIDER_YCLOUD]: Object.freeze({
    id: WHATSAPP_PROVIDER_YCLOUD,
    label: 'YCloud',
    officialApi: true,
    directMeta: false,
    coexistenceCapable: true,
    sourceAdapter: WHATSAPP_SOURCE_ADAPTER_YCLOUD
  }),
  [WHATSAPP_PROVIDER_META_DIRECT]: Object.freeze({
    id: WHATSAPP_PROVIDER_META_DIRECT,
    label: 'Meta directo',
    officialApi: true,
    directMeta: true,
    coexistenceCapable: true,
    sourceAdapter: WHATSAPP_SOURCE_ADAPTER_META_DIRECT
  }),
  [WHATSAPP_PROVIDER_QR]: Object.freeze({
    id: WHATSAPP_PROVIDER_QR,
    label: 'WhatsApp QR (Baileys)',
    officialApi: false,
    directMeta: false,
    coexistenceCapable: false,
    sourceAdapter: WHATSAPP_SOURCE_ADAPTER_BAILEYS
  })
})

export function normalizeWhatsAppProvider(value, fallback = WHATSAPP_PROVIDER_YCLOUD) {
  const provider = String(value || '').trim().toLowerCase()
  return DEFINITIONS[provider] ? provider : fallback
}

export function getWhatsAppProviderDefinitions() {
  return Object.values(DEFINITIONS).map(definition => ({ ...definition }))
}

export function isOfficialWhatsAppApiProvider(provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  return DEFINITIONS[normalizedProvider]?.officialApi === true
}

export function resolveWhatsAppSourceAdapter({ provider, transport } = {}) {
  const normalizedTransport = String(transport || '').trim().toLowerCase()
  if (normalizedTransport === WHATSAPP_TRANSPORT_QR) return WHATSAPP_SOURCE_ADAPTER_BAILEYS
  return DEFINITIONS[normalizeWhatsAppProvider(provider)]?.sourceAdapter || WHATSAPP_SOURCE_ADAPTER_YCLOUD
}

export function resolveWhatsAppMessageIdentifiers({ provider, transport, messageId, wamid } = {}) {
  const normalizedProvider = normalizeWhatsAppProvider(provider)
  const normalizedTransport = String(transport || '').trim().toLowerCase()
  const officialApiTransport = normalizedTransport !== WHATSAPP_TRANSPORT_QR
  const providerMessageId = String(messageId || '').trim()
  const canonicalWamid = String(wamid || '').trim()

  return {
    provider: normalizedProvider,
    sourceAdapter: resolveWhatsAppSourceAdapter({ provider: normalizedProvider, transport }),
    providerMessageId,
    ycloudMessageId: officialApiTransport && normalizedProvider === WHATSAPP_PROVIDER_YCLOUD ? providerMessageId : '',
    metaMessageId: officialApiTransport && normalizedProvider === WHATSAPP_PROVIDER_META_DIRECT ? providerMessageId : '',
    wamid: canonicalWamid
  }
}
