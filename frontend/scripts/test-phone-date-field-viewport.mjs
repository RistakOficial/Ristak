import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [source, styles] = await Promise.all([
  readFile(new URL('../src/components/phone/PhoneDateField.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/phone/PhoneDateField.module.css', import.meta.url), 'utf8')
])

assert.match(
  source,
  /useAnchoredPortal\(triggerRef, open && useInlinePanel/,
  'PhoneDateField debe usar el posicionamiento flotante compartido en escritorio'
)
assert.match(
  source,
  /createPortal\([\s\S]*document\.body/,
  'PhoneDateField debe portalar el calendario para escapar del overflow del modal'
)
assert.match(
  source,
  /hostRef\.current\?\.contains\(target\)[\s\S]*panelRef\.current\?\.contains\(target\)/,
  'PhoneDateField debe conservar abierto el calendario portaleado al interactuar con el panel'
)
assert.match(
  source,
  /align:\s*'end'[\s\S]*viewportPadding:\s*12/,
  'PhoneDateField debe alinear el panel al borde final y respetar el margen del viewport'
)

const popoverBlock = styles.match(/\.popoverPanel\s*\{([^}]*)\}/)?.[1] || ''
assert.ok(popoverBlock, 'PhoneDateField debe conservar el estilo visual del calendario')
assert.doesNotMatch(
  popoverBlock,
  /\b(?:position|top|right|bottom|left|z-index)\s*:/,
  'PhoneDateField no debe sobreescribir la posición calculada por el portal compartido'
)
assert.match(
  popoverBlock,
  /overflow-y:\s*auto/,
  'PhoneDateField debe permitir scroll interno cuando el calendario no cabe completo'
)

console.log('PhoneDateField viewport contract OK')
