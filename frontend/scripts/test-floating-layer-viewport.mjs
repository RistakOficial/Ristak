import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readSource = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [
  dropdownSource,
  dropdownStyles,
  globalStyles,
  anchoredPortalSource,
  sitesStyles,
  viewSelectorSource,
  customSelectSource,
  tagPickerSource,
  contactSearchSource
] = await Promise.all([
  readSource('../src/components/common/DropdownMenu/DropdownMenu.tsx'),
  readSource('../src/components/common/DropdownMenu/DropdownMenu.module.css'),
  readSource('../src/styles/index.css'),
  readSource('../src/hooks/useAnchoredPortal.ts'),
  readSource('../src/pages/Sites/Sites.module.css'),
  readSource('../src/components/common/ViewSelector/ViewSelector.tsx'),
  readSource('../src/components/common/CustomSelect/CustomSelect.tsx'),
  readSource('../src/components/common/TagPicker/TagPicker.tsx'),
  readSource('../src/components/common/ContactSearchInput/ContactSearchInput.tsx')
])

assert.match(
  dropdownSource,
  /collisionPadding = 12[\s\S]*avoidCollisions = true[\s\S]*sticky = 'always'/,
  'DropdownMenu debe evitar colisiones con un margen visible por default'
)
assert.match(
  dropdownSource,
  /position: 'relative'[\s\S]*top: 'auto'[\s\S]*bottom: 'auto'/,
  'DropdownMenu debe neutralizar posicionamiento absoluto heredado de consumidores legacy'
)
assert.match(
  dropdownStyles,
  /max-height:\s*min\(calc\(100dvh - 24px\), var\(--radix-dropdown-menu-content-available-height\)\)/,
  'DropdownMenu debe limitar su altura al espacio que Radix calculó dentro del viewport'
)
assert.match(
  dropdownStyles,
  /overflow-y:\s*auto/,
  'las opciones deben seguir accesibles mediante scroll cuando ninguna dirección tiene altura suficiente'
)
assert.match(
  globalStyles,
  /\[data-ristak-dropdown-panel\][\s\S]*max-height:\s*min\([\s\S]*--radix-dropdown-menu-content-available-height[\s\S]*overflow-y:\s*auto/,
  'todo panel desplegable identificado por el sistema debe respetar la altura del viewport'
)

assert.match(
  anchoredPortalSource,
  /const available = openAbove \? spaceAbove : spaceBelow[\s\S]*const height = Math\.min\(maxHeight, available\)/,
  'el portal anclado debe usar el espacio real disponible, sin mínimos que lo saquen de pantalla'
)
assert.doesNotMatch(
  anchoredPortalSource,
  /Math\.max\((?:120|140|160|180|220),\s*openAbove/,
  'el portal anclado no debe imponer una altura mínima mayor que el viewport'
)
assert.match(
  anchoredPortalSource,
  /const width = Math\.min\(preferredWidth, maxWidth \|\| preferredWidth, viewportContentWidth\)/,
  'el portal anclado también debe caber horizontalmente'
)

const siteMenuBlocks = [...sitesStyles.matchAll(/\.pageMenu\s*\{([^}]*)\}/g)]
assert.ok(siteMenuBlocks.length > 0, 'Sitios debe conservar el estilo visual de su menú de acciones')
for (const [, block] of siteMenuBlocks) {
  assert.doesNotMatch(
    block,
    /\b(?:position|top|right|bottom|left)\s*:/,
    'Sitios no debe volver a sobreescribir la posición calculada por DropdownMenu'
  )
}

assert.match(
  viewSelectorSource,
  /<DropdownMenu[\s\S]*<DropdownMenuContent/,
  'ViewSelector debe usar el menú global con detección de colisiones'
)
for (const [name, source] of [
  ['CustomSelect', customSelectSource],
  ['TagPicker', tagPickerSource],
  ['ContactSearchInput', contactSearchSource]
]) {
  assert.match(
    source,
    /useAnchoredPortal/,
    `${name} debe compartir el posicionamiento adaptativo de portales`
  )
}
assert.match(tagPickerSource, /portal = true/, 'TagPicker debe portalar por default para evitar recortes')
assert.match(contactSearchSource, /portal = true/, 'ContactSearchInput debe portalar por default para evitar recortes')

console.log('Floating layer viewport contract OK')
