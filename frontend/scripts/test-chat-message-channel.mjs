import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/chatMessageChannel.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const {
  getChatBubbleColorChannel,
  getChatMessageSourceLabel,
  resolveChatCommentPlatform,
  resolveChatMessageChannel
} = await import(moduleUrl)

assert.equal(resolveChatMessageChannel({ eventType: 'whatsapp_message', transport: 'api' }), 'whatsapp_api')
assert.equal(resolveChatMessageChannel({ eventType: 'whatsapp_message', transport: 'qr' }), 'whatsapp_qr')
assert.equal(resolveChatMessageChannel({ channel: 'whatsapp', transport: 'baileys' }), 'whatsapp_qr')
assert.equal(resolveChatMessageChannel({ channel: 'whatsapp_qr' }), 'whatsapp_qr')
assert.equal(resolveChatMessageChannel({ channel: 'whatsapp', provider: 'qr' }), 'whatsapp_qr')
assert.equal(resolveChatMessageChannel({ eventType: 'meta_message', transport: 'api', platform: 'instagram' }), 'instagram')
assert.equal(resolveChatMessageChannel({ channel: 'facebook_comment' }), 'messenger')
assert.equal(resolveChatMessageChannel({ eventType: 'email_message', transport: 'smtp' }), 'email')
assert.equal(resolveChatMessageChannel({ channel: 'sms_qr', transport: 'qr' }), 'sms')
assert.equal(resolveChatMessageChannel({ eventType: 'sms_message' }), 'sms')
assert.equal(resolveChatMessageChannel({ eventType: 'whatsapp_message', transport: 'ghl_webchat' }), 'webchat')
assert.equal(
  resolveChatMessageChannel({
    eventType: 'whatsapp_message',
    channel: 'whatsapp_api',
    transport: 'api',
    provider: 'meta_direct',
    commentPlatform: 'messenger',
    messageType: 'text'
  }),
  'whatsapp_api',
  'un valor legacy de commentPlatform no debe convertir WhatsApp en Messenger'
)
assert.equal(resolveChatCommentPlatform('text', 'messenger'), undefined)
assert.equal(resolveChatCommentPlatform('comment', 'instagram'), 'instagram')
assert.equal(resolveChatCommentPlatform('comment_reply_public', 'facebook'), 'messenger')
assert.equal(
  resolveChatMessageChannel({
    channel: 'whatsapp_api',
    commentPlatform: 'instagram',
    messageType: 'comment'
  }),
  'instagram',
  'un comentario real sí debe respetar su plataforma social'
)
assert.equal(getChatBubbleColorChannel('email', 'outbound'), undefined)
assert.equal(getChatBubbleColorChannel('sms', 'outbound'), undefined)
assert.equal(getChatBubbleColorChannel('whatsapp_api', 'inbound'), undefined)
assert.equal(getChatBubbleColorChannel('messenger', 'inbound'), undefined)
assert.equal(getChatBubbleColorChannel('whatsapp_api', 'outbound'), 'whatsapp_api')
assert.equal(getChatBubbleColorChannel('whatsapp_qr', 'outbound'), 'whatsapp_qr')

assert.equal(getChatMessageSourceLabel({ channel: 'whatsapp_api', transport: 'api', provider: 'ycloud' }), 'WhatsApp API')
assert.equal(getChatMessageSourceLabel({ channel: 'whatsapp', transport: 'qr', provider: 'qr' }), 'WhatsApp QR')
assert.equal(getChatMessageSourceLabel({ channel: 'whatsapp_api', transport: 'ghl_whatsapp', provider: 'highlevel' }), 'GHL · WhatsApp')
assert.equal(getChatMessageSourceLabel({ channel: 'sms_qr', transport: 'ghl_sms', provider: 'highlevel' }), 'GHL · SMS')
assert.equal(getChatMessageSourceLabel({ channel: 'instagram', transport: 'ghl_instagram', provider: 'highlevel' }), 'GHL · Instagram')
assert.equal(getChatMessageSourceLabel({ channel: 'messenger', transport: 'ghl_messenger', provider: 'highlevel' }), 'GHL · Messenger')
assert.equal(getChatMessageSourceLabel({ channel: 'email', transport: 'ghl_email', provider: 'highlevel', hasEmail: true }), 'GHL · Email')
assert.equal(getChatMessageSourceLabel({ eventType: 'whatsapp_message', transport: 'ghl_webchat', provider: 'highlevel' }), 'GHL · Webchat')
assert.equal(getChatMessageSourceLabel({ channel: 'messenger', messageType: 'comment', commentPlatform: 'facebook' }), 'Facebook')
assert.equal(getChatMessageSourceLabel({}), 'Sin canal')

const globalStyles = await readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8')
assert.match(globalStyles, /--chat-bubble-inbound:\s*#ffffff;/)
assert.match(globalStyles, /--chat-bubble-outbound-whatsapp-api:\s*#d9fdd3;/)
assert.match(globalStyles, /--chat-bubble-outbound-whatsapp-qr:\s*#c6efbd;/)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-inbound:\s*#242527;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-outbound-neutral:\s*#303135;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-outbound-whatsapp-api:\s*#0b4939;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-outbound-whatsapp-qr:\s*#124f3b;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-outbound-instagram:\s*#4a263d;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-outbound-messenger:\s*#1b3c66;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-text:\s*#f5f5f7;/s)
assert.match(globalStyles, /body\.dark\s*\{[^}]*--chat-bubble-meta:\s*#b7b7bd;/s)

const desktopChatSource = await readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8')
const phoneChatSource = await readFile(new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url), 'utf8')
assert.match(desktopChatSource, /getChatMessageSourceLabel\(\{[\s\S]*?transport:\s*message\.transport,[\s\S]*?provider:\s*message\.provider,/)
assert.match(desktopChatSource, /if \(message\.direction !== 'outbound'\) return \{ label, reason: '' \}/)
assert.match(phoneChatSource, /getChatMessageSourceLabel\(\{[\s\S]*?transport:\s*message\.transport,[\s\S]*?provider:\s*message\.provider,/)

console.log('chat message channel colors and source labels OK')
