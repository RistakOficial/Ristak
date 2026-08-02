import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [desktopChatSource, desktopChatStyles] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
])

const messageErrorBadgeSource = desktopChatSource.slice(
  desktopChatSource.indexOf('const MessageErrorBadge:'),
  desktopChatSource.indexOf('function getDefaultAppointmentRange')
)

assert.ok(messageErrorBadgeSource, 'Desktop Chat debe incluir el indicador persistente de error')
assert.match(
  messageErrorBadgeSource,
  /useAnchoredPortal\(triggerRef, open,[\s\S]*createPortal\(/,
  'el detalle de error debe usar el portal anclado y quedar fuera de contenedores con overflow'
)
assert.match(
  messageErrorBadgeSource,
  /triggerRef\.current\?\.contains\(target\) \|\| panelRef\.current\?\.contains\(target\)[\s\S]*setOpen\(false\)/,
  'interactuar con el indicador o con el texto del error no debe cerrar el detalle'
)
assert.match(
  messageErrorBadgeSource,
  /document\.addEventListener\('pointerdown', handlePointerDown, true\)/,
  'tocar fuera del detalle de error debe cerrarlo'
)
assert.match(
  messageErrorBadgeSource,
  /event\.key !== 'Escape'[\s\S]*triggerRef\.current\?\.focus\(\)/,
  'Escape debe cerrar el detalle y devolver el foco al indicador'
)
assert.match(
  messageErrorBadgeSource,
  /aria-expanded=\{open\}[\s\S]*onClick=\{\(\) => setOpen\(\(current\) => !current\)\}/,
  'el indicador debe abrir y cerrar el detalle de forma persistente mediante clic'
)

const messageErrorPopoverBlock = desktopChatStyles.match(/\.messageErrorPopover\s*\{([^}]*)\}/)?.[1] || ''
assert.ok(messageErrorPopoverBlock, 'Desktop Chat debe conservar el estilo del detalle de error')
assert.doesNotMatch(
  messageErrorPopoverBlock,
  /\b(?:position|top|right|bottom|left)\s*:/,
  'el detalle de error no debe anular las coordenadas calculadas por el portal común'
)
assert.match(
  messageErrorPopoverBlock,
  /user-select:\s*text/,
  'el texto del error debe poder seleccionarse y copiarse'
)
assert.doesNotMatch(
  desktopChatStyles,
  /\.messageErrorBadge::after/,
  'el error no debe volver al tooltip CSS que se recorta dentro del historial'
)

console.log('Desktop Chat persistent error popover contract OK')
