import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSourceUrl = new URL('../src/pages/Sites/Sites.tsx', import.meta.url)
const sitesSource = await readFile(sitesSourceUrl, 'utf8')

const panelStart = sitesSource.indexOf('const MetaFormSubmitSettingsPanel:')
const panelEnd = sitesSource.indexOf('const MetaVideoEventSettings:', panelStart)

assert.ok(panelStart >= 0, 'No se encontró el panel Meta de formularios')
assert.ok(panelEnd > panelStart, 'No se encontró el final del panel Meta de formularios')

const panelSource = sitesSource.slice(panelStart, panelEnd)
const importedBranchStart = panelSource.indexOf('{importedHtmlForm ? (')
const importedBranchEnd = panelSource.indexOf(') : (', importedBranchStart)

assert.match(
  panelSource,
  /const importedHtmlForm = isImportedHtmlSite\(site\)/,
  'la simplificación debe aplicarse únicamente a sitios HTML importados'
)
assert.ok(importedBranchStart >= 0, 'No se encontró la rama para HTML importado')
assert.ok(importedBranchEnd > importedBranchStart, 'No se encontró el final de la rama para HTML importado')

const importedBranch = panelSource.slice(importedBranchStart, importedBranchEnd)

assert.match(importedBranch, /<span>Enviar cuando<\/span>/)
assert.match(importedBranch, />Formulario enviado<\/div>/)
assert.doesNotMatch(
  importedBranch,
  /<CustomSelect/,
  'HTML importado no debe mostrar un dropdown para elegir cuándo enviar el evento'
)
assert.match(
  panelSource,
  /<span>Evento al terminar<\/span>[\s\S]*?<CustomSelect/,
  'el selector de evento debe permanecer disponible'
)
assert.match(
  panelSource,
  /metaSubmitConditionOptions\.map/,
  'los formularios que no son HTML importado deben conservar su configuración actual'
)

console.log('Sites imported HTML Meta form trigger contract OK')
