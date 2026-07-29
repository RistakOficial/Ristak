import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [sitesSource, sitesStyles] = await Promise.all([
  readFile(new URL('../src/pages/Sites/Sites.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Sites/Sites.module.css', import.meta.url), 'utf8')
])

const cssBlock = (selector) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = sitesStyles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `No se encontró el bloque CSS de ${selector}`)
  return match[1]
}

const sharedStickyHeader = cssBlock('.inspectorStickyTop')
assert.match(
  sharedStickyHeader,
  /position:\s*sticky/,
  'el encabezado compartido del inspector debe permanecer fijo durante el scroll'
)
assert.match(
  sharedStickyHeader,
  /background:\s*var\(--design-panel-bg/,
  'el encabezado fijo debe conservar un fondo opaco temado'
)

const importedDetailHeader = cssBlock('.importedContentDetailHeader')
assert.match(
  importedDetailHeader,
  /position:\s*sticky/,
  'el encabezado de detalle del editor HTML debe permanecer fijo'
)
assert.match(
  importedDetailHeader,
  /z-index:\s*13/,
  'el encabezado de detalle debe quedar por encima del encabezado compartido que se desplaza debajo'
)
assert.match(
  importedDetailHeader,
  /background:\s*var\(--surface\)/,
  'el encabezado de detalle debe tapar por completo el contenido desplazado'
)

assert.match(
  sitesStyles,
  /\.importedNativeElementInspector \.inspectorStickyTop,\s*[\s\S]*?\.importedNativeElementInspector \.inspectorStickyTop\s*\{[\s\S]*?position:\s*static;[\s\S]*?z-index:\s*auto;/,
  'un inspector anidado debe perder tanto la posición fija como su capa flotante'
)

assert.match(
  sitesSource,
  /<InspectorTabbedPanel[\s\S]*?className=\{styles\.importedNativeElementInspector\}[\s\S]*?defaultTab="edit"/,
  'el inspector avanzado del elemento HTML debe usar el contrato anidado sin capa flotante'
)

const sharedInspectorUses = sitesSource.match(/<InspectorTabbedPanel\b/g) || []
assert.ok(
  sharedInspectorUses.length >= 6,
  'los editores de Sites deben seguir compartiendo el mismo encabezado de inspector'
)

console.log('Sites inspector stacking contract OK')
