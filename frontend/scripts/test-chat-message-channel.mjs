import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/chatMessageChannel.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const { getChatBubbleColorChannel, resolveChatMessageChannel } = await import(moduleUrl)

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
assert.equal(getChatBubbleColorChannel('email', 'outbound'), undefined)
assert.equal(getChatBubbleColorChannel('sms', 'outbound'), undefined)
assert.equal(getChatBubbleColorChannel('whatsapp_api', 'inbound'), undefined)
assert.equal(getChatBubbleColorChannel('messenger', 'inbound'), undefined)
assert.equal(getChatBubbleColorChannel('whatsapp_api', 'outbound'), 'whatsapp_api')
assert.equal(getChatBubbleColorChannel('whatsapp_qr', 'outbound'), 'whatsapp_qr')

const globalStyles = await readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8')
assert.match(globalStyles, /--chat-bubble-inbound:\s*#ffffff;/)
assert.match(globalStyles, /--chat-bubble-outbound-whatsapp-api:\s*#d9fdd3;/)
assert.match(globalStyles, /--chat-bubble-outbound-whatsapp-qr:\s*#c6efbd;/)

console.log('chat message channel colors OK')
