import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSource = await readFile(
  new URL('../src/pages/Sites/Sites.tsx', import.meta.url),
  'utf8'
)

const sourceBetween = (startMarker, endMarker) => {
  const start = sitesSource.indexOf(startMarker)
  const end = sitesSource.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return sitesSource.slice(start, end)
}

const embeddedInspectorSource = sourceBetween(
  'function FormEmbedEditorPanel({',
  '// Lets a field block'
)
assert.match(
  embeddedInspectorSource,
  /const embeddedInspectorSelectionKey = `\$\{block\.id\}:\$\{activeElement\}:\$\{activeField\?\.id \|\| 'none'\}:\$\{activeField\?\.blockType \|\| 'none'\}`/,
  'la identidad del inspector debe distinguir formulario, superficie, elemento y tipo de bloque'
)
assert.match(
  embeddedInspectorSource,
  /<InspectorTabbedPanel[\s\S]*?key=\{`embedded-form-inspector:\$\{embeddedInspectorSelectionKey\}`\}[\s\S]*?defaultTab=\{showElementEditor \? 'edit' : 'formDesign'\}/,
  'cambiar la selección interna debe remontar el inspector en Editar; seleccionar la superficie debe abrir Diseño'
)

const embeddedCanvasSource = sourceBetween(
  'const EmbeddedFormCanvasFields:',
  '// Inline prompt shown inside a freshly added field block'
)
assert.match(
  embeddedCanvasSource,
  /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\)\s*editor\.onSelectField\(field\.id\)\s*\}\}/,
  'cada elemento interno debe detener el click del formulario y seleccionar su propio inspector'
)

const embeddedBridgeSource = sourceBetween(
  'const embeddedFormEditorBridge:',
  'const videoFormGateEditorBridge:'
)
assert.match(
  embeddedBridgeSource,
  /onSelectSurface: \(\) => \{\s*setActiveEmbeddedFormSubmitSelected\(false\)\s*setActiveEmbeddedFormFieldId\(''\)/,
  'seleccionar la superficie debe volver al inspector general del formulario'
)
assert.match(
  embeddedBridgeSource,
  /onSelectField: \(fieldId\) => \{\s*setActiveEmbeddedFormSubmitSelected\(false\)\s*setActiveEmbeddedFormFieldId\(fieldId\)/,
  'seleccionar texto, perfil o campo debe activar ese elemento en el inspector'
)
assert.match(
  embeddedBridgeSource,
  /onSelectSubmit: \(\) => \{\s*setActiveEmbeddedFormSubmitSelected\(true\)/,
  'seleccionar el botón debe abrir su inspector específico'
)

console.log('Sites embedded form inspector contract OK')
