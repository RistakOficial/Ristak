import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/chatMessageReconciliation.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const {
  getChatSendResponseIds,
  reconcileServerMessageIntoOptimistic
} = await import(moduleUrl)

const preview = 'data:image/jpeg;base64,preview-local'
const optimistic = {
  id: 'desktop-chat-1-attachment-0',
  optimisticId: 'desktop-chat-1-attachment-0',
  text: 'caption',
  date: '2026-07-10T18:00:00.000Z',
  direction: 'outbound',
  status: 'enviando',
  attachment: {
    type: 'image',
    dataUrl: preview,
    name: 'foto.jpg',
    mimeType: 'image/jpeg'
  }
}
const server = {
  id: 'db-message-1',
  providerMessageId: 'wamid-1',
  text: 'caption',
  date: '2026-07-10T18:00:02.000Z',
  direction: 'outbound',
  status: 'delivered',
  attachment: {
    type: 'image',
    url: 'https://cdn.example.com/foto.jpg',
    name: 'whatsapp-image.jpg',
    mimeType: 'image/jpeg'
  }
}

const reconciled = reconcileServerMessageIntoOptimistic(server, optimistic)
assert.equal(reconciled.id, optimistic.id, 'el id visible no debe cambiar')
assert.equal(reconciled.serverMessageId, server.id, 'la fila remota se guarda aparte')
assert.equal(reconciled.providerMessageId, server.providerMessageId)
assert.equal(reconciled.date, optimistic.date, 'la fecha visible no debe reordenar el globo')
assert.equal(reconciled.status, 'delivered')
assert.equal(reconciled.attachment.dataUrl, preview, 'el preview local debe permanecer')
assert.equal(reconciled.attachment.url, server.attachment.url, 'la URL remota queda lista para el próximo montaje')

assert.deepEqual(getChatSendResponseIds({
  id: 'wamid-2',
  localMessageId: 'db-message-2'
}), {
  serverMessageId: 'db-message-2',
  providerMessageId: 'wamid-2'
})
assert.deepEqual(getChatSendResponseIds({
  data: { id: 'provider-nested', localMessageId: 'db-nested' }
}), {
  serverMessageId: 'db-nested',
  providerMessageId: 'provider-nested'
})

console.log(`chat reconciliation OK (${pathToFileURL(sourceUrl.pathname).pathname})`)
