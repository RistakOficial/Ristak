import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/highLevelChatSend.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const {
  getHighLevelChatSendOutcome,
  getHighLevelRouteChangeMessage,
  getHighLevelWhatsAppRouteLabel,
  getLatestHighLevelWhatsAppInboundSender,
  resolveHighLevelChatFromNumber
} = await import(moduleUrl)

const accepted = getHighLevelChatSendOutcome({
  success: true,
  data: {
    messageId: 'ghl-1',
    localMessageId: 'local-1',
    channel: 'whatsapp_api',
    transport: 'ghl_whatsapp',
    status: 'sent'
  }
}, 'whatsapp_api')

assert.equal(accepted.accepted, true)
assert.equal(accepted.status, 'pending', 'HTTP 200/sent sólo confirma aceptación del proveedor')
assert.equal(accepted.effectiveChannel, 'whatsapp_api')
assert.equal(accepted.localMessageId, 'local-1')
assert.equal(accepted.providerMessageId, 'ghl-1')

const failed = getHighLevelChatSendOutcome({
  success: true,
  data: {
    channel: 'whatsapp_api',
    status: 'failed',
    errorMessage: 'La ventana de 24 horas está cerrada.'
  }
}, 'whatsapp_api')

assert.equal(failed.accepted, false)
assert.equal(failed.status, 'error')
assert.equal(failed.errorReason, 'La ventana de 24 horas está cerrada.')

const switched = getHighLevelChatSendOutcome({
  success: true,
  data: {
    channel: 'sms_qr',
    requestedChannel: 'whatsapp_api',
    status: 'queued',
    fallbackApplied: true,
    fallbackReason: 'outside_24h'
  }
}, 'whatsapp_api')

assert.equal(switched.status, 'pending')
assert.equal(switched.routeChanged, true)
assert.match(getHighLevelRouteChangeMessage(switched), /WhatsApp a SMS/)

const delivered = getHighLevelChatSendOutcome({
  success: true,
  data: { channel: 'sms_qr', status: 'delivered' }
}, 'sms_qr')

assert.equal(delivered.status, 'delivered')

const verifiedWhatsAppSender = getLatestHighLevelWhatsAppInboundSender([
  {
    id: 'ghl-old',
    direction: 'inbound',
    transport: 'ghl_whatsapp',
    businessPhone: '+1 555 000 1111',
    date: '2026-07-15T10:00:00.000Z'
  },
  {
    id: 'native-newer',
    direction: 'inbound',
    transport: 'api',
    businessPhone: '+1 555 000 9999',
    date: '2026-07-15T12:00:00.000Z'
  },
  {
    id: 'sms-newer',
    direction: 'inbound',
    transport: 'ghl_sms',
    businessPhone: '+1 555 000 8888',
    date: '2026-07-15T13:00:00.000Z'
  },
  {
    id: 'outbound-newer',
    direction: 'outbound',
    transport: 'ghl_whatsapp',
    businessPhone: '+1 555 000 7777',
    date: '2026-07-15T14:00:00.000Z'
  },
  {
    id: 'ghl-new',
    direction: 'inbound',
    transport: 'GHL-WhatsApp-API',
    businessPhone: '+1 555 000 2222',
    date: '2026-07-15T11:00:00.000Z'
  }
])

assert.deepEqual(verifiedWhatsAppSender, {
  source: 'verified_inbound',
  fromNumber: '+1 555 000 2222',
  messageId: 'ghl-new',
  receivedAt: '2026-07-15T11:00:00.000Z'
})
assert.equal(getHighLevelWhatsAppRouteLabel(verifiedWhatsAppSender), 'WhatsApp · HighLevel · +1 555 000 2222')
assert.equal(
  resolveHighLevelChatFromNumber('whatsapp_api', {
    smsFromNumber: '+1 555 000 3333',
    whatsappSender: verifiedWhatsAppSender
  }),
  '+1 555 000 2222',
  'WhatsApp jamás debe reutilizar el remitente del catálogo SMS'
)
assert.equal(
  resolveHighLevelChatFromNumber('sms_qr', {
    smsFromNumber: '+1 555 000 3333',
    whatsappSender: verifiedWhatsAppSender
  }),
  '+1 555 000 3333'
)
assert.equal(resolveHighLevelChatFromNumber('messenger', {
  smsFromNumber: '+1 555 000 3333',
  whatsappSender: verifiedWhatsAppSender
}), '')

const unverifiedSender = getLatestHighLevelWhatsAppInboundSender([
  {
    direction: 'inbound',
    transport: 'ghl_whatsapp',
    from: '+1 555 000 4444',
    date: '2026-07-15T15:00:00.000Z'
  }
])
assert.equal(unverifiedSender, null, '`from` del contacto no prueba el número de negocio')
assert.equal(getHighLevelWhatsAppRouteLabel(unverifiedSender), 'WhatsApp · HighLevel')
assert.equal(resolveHighLevelChatFromNumber('whatsapp_api', {
  smsFromNumber: '+1 555 000 3333',
  whatsappSender: unverifiedSender
}), '', 'sin evidencia inbound el backend debe resolver o fallar cerrado')

console.log(`highlevel chat send outcome OK (${pathToFileURL(sourceUrl.pathname).pathname})`)
