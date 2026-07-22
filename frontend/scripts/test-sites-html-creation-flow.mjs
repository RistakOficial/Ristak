import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSourceUrl = new URL('../src/pages/Sites/Sites.tsx', import.meta.url)
const sitesStylesUrl = new URL('../src/pages/Sites/Sites.module.css', import.meta.url)
const sitesSource = await readFile(sitesSourceUrl, 'utf8')
const sitesStyles = await readFile(sitesStylesUrl, 'utf8')

const sourceBetween = (startMarker, endMarker) => {
  const start = sitesSource.indexOf(startMarker)
  const end = sitesSource.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return sitesSource.slice(start, end)
}

const landingStartSource = sourceBetween(
  "{step === 'landing-start' && (",
  "{step === 'landing-template' && ("
)
const landingChoiceLabels = [...landingStartSource.matchAll(/<strong>([^<]+)<\/strong>/g)]
  .map(match => match[1].trim())

assert.deepEqual(
  landingChoiceLabels,
  ['En blanco', 'Desde plantilla', 'Crear desde HTML'],
  'Nuevo sitio web debe mostrar exactamente tres opciones principales, en este orden'
)
assert.doesNotMatch(
  landingStartSource,
  /Pegar código HTML|Subir HTML o ZIP|Diseñar con ChatGPT o Claude|Usando IA/,
  'las variantes HTML no deben volver a aparecer como opciones principales'
)

const htmlCreationModalSource = sourceBetween(
  'const HtmlCreationModal:',
  'const CreateFlowPanel:'
)
for (const expectedAction of [
  'Abrir editor HTML',
  'Subir HTML o ZIP',
  'Diseñar con la IA de Ristak',
  'Preparar para ChatGPT, Claude o Codex'
]) {
  assert.match(
    htmlCreationModalSource,
    new RegExp(expectedAction),
    `Crear desde HTML debe conservar la acción: ${expectedAction}`
  )
}

const importedHtmlGuideSource = sourceBetween(
  'const IMPORTED_HTML_AI_GUIDE =',
  'const IMPORTED_HTML_MOBILE_PREVIEW_STYLE ='
)
assert.match(
  importedHtmlGuideSource,
  /\$\{buildImportedHtmlMobileRulesText\(\)\}/,
  'la guía visible debe seguir incluyendo el contrato móvil compartido completo'
)
assert.match(
  sitesSource,
  /<details className=\{styles\.importedCodeGuide\}>/,
  'las reglas HTML deben iniciar plegadas y poder abrirse con el control nativo'
)
assert.doesNotMatch(
  sitesSource,
  /<details className=\{styles\.importedCodeGuide\}\s+open>/,
  'las reglas HTML no deben ocupar espacio hasta que el usuario las abra'
)

assert.match(
  sitesSource,
  /const \[codeAssistantOpen, setCodeAssistantOpen\] = useState\(false\)/,
  'el asistente de código debe iniciar oculto'
)
assert.match(
  sitesSource,
  /aria-label=\{codeAssistantOpen \? 'Ocultar asistente de código' : 'Abrir asistente de código'\}/,
  'el botón de chat debe comunicar si abre o cierra el asistente'
)
assert.match(
  sitesSource,
  /\{codeAssistantOpen && \(\s*<div id=\{codeAssistantPanelId\} className=\{styles\.importedCodeAssistantPanel\}>/,
  'el panel del asistente solo debe montarse cuando el usuario lo abra'
)

const importedFileHandlerSource = sourceBetween(
  'const handleImportHtmlFile = async',
  'const handleImportedContentUpdated ='
)
assert.match(
  importedFileHandlerSource,
  /pendingImportedSiteRedirectRef\.current = \{[\s\S]*?sourceSiteId: openEditorSiteId,[\s\S]*?siteId: site\.id,[\s\S]*?editorPath/,
  'subir paginas desde un editor debe registrar la transicion antes de seleccionar el sitio importado'
)
assert.match(
  importedFileHandlerSource,
  /editorOpenRequestRef\.current \+= 1[\s\S]*?setSelectedSite\(site\)[\s\S]*?navigate\(editorPath\)/,
  'la importacion debe invalidar cargas viejas antes de abrir el proyecto nuevo'
)

const routeRestoreSource = sourceBetween(
  'const pendingImportedRedirect = pendingImportedSiteRedirectRef.current',
  'if (routeState.siteId) {'
)
assert.match(
  routeRestoreSource,
  /routeState\.siteId === pendingImportedRedirect\.sourceSiteId[\s\S]*?return/,
  'el restaurador de URL no debe reabrir el sitio anterior durante la transicion importada'
)

const openSiteSource = sourceBetween(
  'const openSite = async',
  'const selectSite ='
)
assert.match(
  openSiteSource,
  /editorOpenRequestRef\.current !== requestId\) return/,
  'una carga vieja del editor no debe reemplazar una seleccion mas reciente'
)

const importedFieldMappingRowSource = sourceBetween(
  '<div key={`${field.fieldId}:${fieldIndex}`} className={styles.importedFieldMappingRow}>',
  '</div>\n                        )'
)
const importedFieldMappingStatusIndex = importedFieldMappingRowSource.indexOf('<Badge')
const importedFieldMappingSelectIndex = importedFieldMappingRowSource.indexOf('<CustomSelect')
assert.ok(
  importedFieldMappingStatusIndex >= 0 && importedFieldMappingStatusIndex < importedFieldMappingSelectIndex,
  'el estado del campo debe permanecer junto al titulo, antes del selector que ocupa toda la fila'
)
assert.match(
  importedFieldMappingRowSource,
  /<Badge\s+className=\{styles\.importedFieldMappingStatus\}/,
  'el estado del campo debe usar la alineacion compacta del panel'
)
assert.match(
  sitesStyles,
  /\.importedFieldMappingStatus\s*\{[\s\S]*?justify-self:\s*end;[\s\S]*?\}/,
  'la etiqueta de estado no debe estirarse a todo el ancho de la cuadricula'
)

console.log('Sites HTML creation flow contract OK')
