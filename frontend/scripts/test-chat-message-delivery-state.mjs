import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/chatMessageDeliveryState.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const { isChatMessageSendInFlight } = await import(moduleUrl)

for (const status of ['sending', 'enviando', 'enviando por QR']) {
  assert.equal(isChatMessageSendInFlight(status), true, `${status} debe conservar el loader local`)
}

for (const status of ['pending', 'queued', 'processing', 'accepted', 'sent', 'delivered', 'read', 'failed', 'scheduled', '']) {
  assert.equal(isChatMessageSendInFlight(status), false, `${status || 'vacío'} ya no debe pintar un envío atorado`)
}

const chatSurfaces = [
  new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url),
  new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url),
  new URL('../src/components/common/ContactDetailsModal/ContactDetailsModal.tsx', import.meta.url)
]

for (const chatSurface of chatSurfaces) {
  const chatSource = await readFile(chatSurface, 'utf8')
  assert.match(chatSource, /isChatMessageSendInFlight/, `${chatSurface.pathname} debe usar el contrato compartido`)
  assert.doesNotMatch(chatSource, /PENDING_MESSAGE_STATUSES/, `${chatSurface.pathname} no debe confundir pending del proveedor con un POST activo`)
}

console.log(`chat delivery state OK (${pathToFileURL(sourceUrl.pathname).pathname})`)
