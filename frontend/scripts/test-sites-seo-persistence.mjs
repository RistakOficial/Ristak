import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSource = await readFile(new URL('../src/pages/Sites/Sites.tsx', import.meta.url), 'utf8')

const sourceBetween = (startMarker, endMarker) => {
  const start = sitesSource.indexOf(startMarker)
  const end = sitesSource.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return sitesSource.slice(start, end)
}

const toolbarSaveSource = sourceBetween(
  'const patchEditorToolbarSettingsSite =',
  'const editorHistoryControls ='
)
assert.match(
  toolbarSaveSource,
  /const saveEditorToolbarSeoSite = \(\) => flushPendingEditorSaves\(\{ silent: true, forceSite: true \}\)/,
  'Guardar SEO debe forzar la persistencia aunque el editor general tenga el autoguardado apagado'
)

const editorSeoModalSource = sourceBetween(
  '{!formEditMode && editorToolbarSettingsSite && seoModalOpen && (',
  '{!formEditMode && editorToolbarSettingsSite && hasEditablePages'
)
assert.match(editorSeoModalSource, /onAutoSave=\{saveEditorToolbarSettingsSite\}/)
assert.match(editorSeoModalSource, /onSave=\{saveEditorToolbarSeoSite\}/)

const modalSource = sourceBetween(
  'const SeoOptimizationModal:',
  'const MetaEventParametersEditor:'
)
assert.match(
  modalSource,
  /const saved = await onSave\(\)\s+if \(saved !== false\) onClose\(\)/,
  'el modal solo debe cerrarse después de que el servidor confirme el guardado'
)
for (const field of [
  'title',
  'description',
  'seoKeywords',
  'seoAuthor',
  'seoImage',
  'seoMetaTags',
  'seoCanonicalLinks',
  'seoLanguage'
]) {
  assert.match(modalSource, new RegExp(field), `el modal debe conservar el campo ${field}`)
}

console.log('Sites SEO persistence contract OK')
