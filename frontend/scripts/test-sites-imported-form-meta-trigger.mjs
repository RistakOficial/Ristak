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

const detectedFormsStart = sitesSource.indexOf('const getMetaDetectedFormSurfaces =')
const detectedFormsEnd = sitesSource.indexOf('const getMetaDetectedCalendarSurfaces =', detectedFormsStart)
assert.ok(detectedFormsStart >= 0 && detectedFormsEnd > detectedFormsStart, 'No se encontró la detección Meta por página')
const detectedFormsSource = sitesSource.slice(detectedFormsStart, detectedFormsEnd)
assert.match(detectedFormsSource, /activePage\?\.importedAssetPath/)
assert.match(detectedFormsSource, /activeHtmlFormIds/)
assert.match(detectedFormsSource, /collectImportedPanelFormGroups/)
assert.match(
  detectedFormsSource,
  /normalizeImportedDestinationKey\(group\.formId, ''\)/,
  'los IDs del HTML deben normalizarse igual que los IDs guardados'
)
assert.match(
  detectedFormsSource,
  /normalizeImportedDestinationKey\(String\(form\?\.id \|\| form\?\.selector \|\| ''\), ''\)/,
  'la detección Meta no debe perder formularios por diferencias entre guiones y guiones bajos'
)
assert.match(
  detectedFormsSource,
  /const activeForms = detectedForms\.length \? detectedForms : fallbackMappings/,
  'si la detección importada queda obsoleta debe usar los mapeos activos de la página'
)

const panelFormsStart = sitesSource.indexOf('const collectImportedPanelFormGroups =')
const panelFormsEnd = sitesSource.indexOf('const collectImportedPanelFormFields =', panelFormsStart)
assert.ok(panelFormsStart >= 0 && panelFormsEnd > panelFormsStart, 'No se encontró la detección de formularios del Panel de contenido')
assert.match(
  sitesSource.slice(panelFormsStart, panelFormsEnd),
  /filter\(form => !isImportedCalendarBookingFormElement\(form\)\)/,
  'el formulario interno del calendario no debe mostrarse ni configurarse como formulario independiente'
)
assert.match(
  sitesSource.slice(panelFormsStart, panelFormsEnd),
  /const choiceIdentity = getImportedPanelChoiceGroupIdentity\(input, element\)/,
  'radio y checkbox deben agruparse por respuesta lógica aunque cada opción traiga un ID distinto'
)

console.log('Sites imported HTML Meta form trigger contract OK')
