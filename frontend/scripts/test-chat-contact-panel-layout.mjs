import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [desktopChatSource, desktopChatStyles] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
])

const chatShellBlock = desktopChatStyles.match(/\.chatShell\s*\{([^}]*)\}/)?.[1] || ''
const infoPanelBlocks = [...desktopChatStyles.matchAll(/\.infoPanel\s*\{([^}]*)\}/g)]
  .map(([, block]) => block)
  .join('\n')

assert.ok(chatShellBlock, 'Desktop Chat debe conservar la cuadrícula principal')
assert.match(
  chatShellBlock,
  /--chat-inbox-column:\s*clamp\(280px, 20vw, 340px\)/,
  'la bandeja debe liberar espacio de forma fluida sin crecer de más'
)
assert.match(
  chatShellBlock,
  /--chat-info-column:\s*clamp\(280px, 18vw, 340px\)/,
  'la ficha del contacto debe mantenerse compacta y legible'
)
assert.match(
  chatShellBlock,
  /grid-template-columns:\s*var\(--chat-inbox-column\) minmax\(400px, 1fr\) var\(--chat-info-column\)/,
  'el historial debe recibir todo el espacio liberado por las columnas laterales'
)
assert.doesNotMatch(
  desktopChatStyles,
  /minmax\(400px, 470px\)/,
  'la ficha no debe volver al ancho excesivo anterior'
)
assert.match(infoPanelBlocks, /min-width:\s*0/, 'la ficha debe permitir que sus hijos se ajusten sin desbordarse')
assert.match(infoPanelBlocks, /overflow:\s*auto/, 'la ficha debe conservar scroll para todo su contenido')
assert.match(
  desktopChatSource,
  /className=\{styles\.whatsappReplySelect\}[\s\S]*aria-label="WhatsApp de respuesta del contacto"/,
  'el selector de WhatsApp debe activar su ajuste legible dentro de la ficha compacta'
)
assert.match(
  desktopChatSource,
  /className=\{styles\.referrerField\}[\s\S]*label="Recomendado por"[\s\S]*density="compact"/,
  'el recomendador debe conservar la densidad compacta y su separación dentro de la ficha'
)
assert.match(
  desktopChatStyles,
  /\.referrerField\s*\{[\s\S]*?margin-top:\s*18px;[\s\S]*?padding-top:\s*18px;[\s\S]*?border-top:\s*1px solid var\(--chat-border\)/,
  'los datos de referencia deben formar un bloque legible separado de la identidad principal'
)
assert.match(
  infoPanelBlocks,
  /--chat-border:\s*var\(--border\)/,
  'la ficha debe usar los bordes temados del sistema de diseño'
)
assert.match(
  desktopChatStyles,
  /\.infoSection\s*\{[\s\S]*?padding:\s*18px/,
  'todas las secciones de la ficha deben compartir el mismo ritmo interior'
)
assert.match(
  desktopChatSource,
  /<Button[\s\S]*?variant="secondary"[\s\S]*?className=\{styles\.automationButton\}/,
  'la acción de automatización debe usar el botón global del producto'
)
assert.match(
  desktopChatStyles,
  /\.whatsappReplySelect \[data-ristak-dropdown-trigger\] > span:first-child\s*\{[\s\S]*?white-space:\s*normal/,
  'el número de respuesta debe mostrar su texto completo en varias líneas cuando haga falta'
)
assert.match(
  desktopChatStyles,
  /\.metricsGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/,
  'los resúmenes deben encogerse dentro de la ficha sin forzar su ancho'
)
assert.match(
  desktopChatStyles,
  /@media \(max-width: 1240px\)[\s\S]*?\.infoPanel\s*\{\s*display:\s*none/,
  'el breakpoint angosto debe conservar el espacio completo para la conversación'
)

console.log('Desktop Chat contact panel responsive layout contract OK')
