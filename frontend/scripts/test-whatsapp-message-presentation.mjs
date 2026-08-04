import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const presentationSource = await readFile(
  new URL('../src/components/common/WhatsAppMessageContent/presentation.ts', import.meta.url),
  'utf8'
)
const compiled = await transform(presentationSource, {
  loader: 'ts',
  format: 'esm',
  target: 'es2020'
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const { normalizeWhatsAppMessagePresentation } = await import(moduleUrl)

assert.deepEqual(normalizeWhatsAppMessagePresentation({
  kind: 'template',
  header: { kind: 'text', text: 'Confirma tu cita' },
  body: 'Aquí está el enlace para conectarnos.',
  footer: 'Mensaje automático',
  buttons: [
    { type: 'url', label: 'Google Meet', url: 'https://example.test/tracked' },
    { type: 'quick_reply', label: 'Confirmar', payload: 'internal-action' }
  ]
}), {
  kind: 'template',
  header: { kind: 'text', text: 'Confirma tu cita', mediaUrl: undefined, fileName: undefined },
  body: 'Aquí está el enlace para conectarnos.',
  footer: 'Mensaje automático',
  buttons: [
    { type: 'url', label: 'Google Meet' },
    { type: 'quick_reply', label: 'Confirmar' }
  ]
})
assert.equal(normalizeWhatsAppMessagePresentation({ kind: 'text', body: 'No aplica' }), undefined)

const componentSource = await readFile(
  new URL('../src/components/common/WhatsAppMessageContent/WhatsAppMessageContent.tsx', import.meta.url),
  'utf8'
)
const componentStyles = await readFile(
  new URL('../src/components/common/WhatsAppMessageContent/WhatsAppMessageContent.module.css', import.meta.url),
  'utf8'
)
const desktopChatSource = await readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8')
const phoneChatSource = await readFile(new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url), 'utf8')

assert.match(componentSource, /data-whatsapp-message-content=/)
assert.doesNotMatch(componentSource, /<a\b|<button\b/, 'la copia histórica no debe ejecutar botones ni enlaces')
assert.match(
  componentStyles,
  /\.action\s*\{[\s\S]*?color:\s*color-mix\(in srgb, var\(--brand-ristak-blue\) 54%, var\(--chat-bubble-text\)\);/
)
assert.match(desktopChatSource, /message\.presentation\s*\?\s*\([\s\S]*?<WhatsAppMessageContent/)
assert.ok(
  phoneChatSource.match(/<WhatsAppMessageContent/g)?.length >= 3,
  'el chat móvil debe conservar la estructura en burbuja, vista previa y detalle'
)

console.log('WhatsApp template and interactive message presentation OK')
