import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [desktopChatSource, desktopChatStyles] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
])

const metadataBlocks = [...desktopChatSource.matchAll(
  /<span className=\{styles\.chatRowMeta\}>([\s\S]*?)<\/span>\s*<\/span>/g
)].map(([, block]) => block)

assert.equal(
  metadataBlocks.length,
  2,
  'las filas normales y prioritarias deben compartir el orden del contador y la fecha'
)

for (const block of metadataBlocks) {
  const unreadIndex = block.indexOf('styles.unread')
  const timestampIndex = block.indexOf('<small>')

  assert.ok(unreadIndex >= 0, 'el contador de mensajes nuevos debe vivir junto a la fecha')
  assert.ok(timestampIndex >= 0, 'la fila debe conservar la fecha del ultimo mensaje')
  assert.ok(
    unreadIndex < timestampIndex,
    'el contador de mensajes nuevos debe renderizarse antes de la hora o el dia'
  )
}

assert.match(
  desktopChatStyles,
  /\.chatRowMeta\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?gap:\s*7px;/,
  'el contador y la fecha deben mantenerse alineados como una sola pieza visual'
)

console.log('Desktop Chat unread counter order contract OK')
