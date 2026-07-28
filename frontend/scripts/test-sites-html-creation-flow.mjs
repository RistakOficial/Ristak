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
  importedHtmlGuideSource,
  /\$\{buildImportedHtmlFaviconRulesText\(\)\}/,
  'la guía visible debe exigir favicon en todos los documentos HTML'
)
assert.match(
  sitesSource,
  /<title>Sitio HTML en blanco<\/title>\s+\$\{DEFAULT_IMPORTED_HTML_FAVICON_TAG\}/,
  'un sitio HTML en blanco debe iniciar con favicon de respaldo'
)

const importedAIRegionPromptSource = sourceBetween(
  'const buildImportedAIRegionPrompt =',
  'const buildImportedAIPagePrompt ='
)
const importedAIPagePromptSource = sourceBetween(
  'const buildImportedAIPagePrompt =',
  'const normalizeImportedAIRegionPreviewHtml ='
)
const externalCompatibilitySource = sourceBetween(
  'const buildExternalAICompatibilityText =',
  'const copyTextToClipboard ='
)
for (const [label, source] of [
  ['edición de zona', importedAIRegionPromptSource],
  ['edición de página', importedAIPagePromptSource],
  ['instrucciones para IA externa', externalCompatibilitySource]
]) {
  assert.match(
    source,
    /buildImportedHtmlFaviconRulesText/,
    `${label} debe conservar el contrato obligatorio de favicon`
  )
}
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
  /const replacementSiteId = openEditorSite && isImportedHtmlSite\(openEditorSite\)[\s\S]*?\{ siteId: replacementSiteId \}/,
  'subir páginas desde un editor HTML debe actualizar el sitio abierto en lugar de crear otro'
)
assert.match(
  importedFileHandlerSource,
  /pendingImportedSiteRedirectRef\.current = replacementSiteId[\s\S]*?\? null[\s\S]*?: \{[\s\S]*?sourceSiteId: openEditorSiteId,[\s\S]*?siteId: site\.id,[\s\S]*?editorPath/,
  'solo una importación nueva debe registrar la transición hacia otro sitio'
)
assert.match(
  importedFileHandlerSource,
  /editorOpenRequestRef\.current \+= 1[\s\S]*?setSelectedSite\(site\)[\s\S]*?navigate\(editorPath\)/,
  'la importacion debe invalidar cargas viejas antes de abrir el proyecto nuevo'
)
assert.match(
  importedFileHandlerSource,
  /replacementSiteId \? 'Sitio HTML actualizado' : 'HTML importado'/,
  'la resubida debe confirmar que actualizó el código y conservó asociaciones'
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

const importedSystemFieldOptionsSource = sourceBetween(
  'const importedSystemFieldOptions = [',
  'const normalizeImportedDestinationKey ='
)
const importedSystemFieldLabels = [...importedSystemFieldOptionsSource.matchAll(/label: '([^']+)'/g)]
  .map(match => match[1])
assert.deepEqual(
  importedSystemFieldLabels,
  [
    'Nombre completo',
    'Correo electrónico',
    'Teléfono / WhatsApp',
    'Ciudad',
    'Dirección 1',
    'Empresa',
    'Nombre',
    'Apellido',
    'Mensaje o nota'
  ],
  'el selector debe priorizar identidad, contacto y ubicación antes de los destinos secundarios'
)

const importedFieldPrioritySource = sourceBetween(
  'const getPrioritizedImportedSystemFieldOptions =',
  'interface SitesLibraryPanelProps'
)
assert.match(
  importedFieldPrioritySource,
  /currentValue\.startsWith\('standard:'\)[\s\S]*?filter\(option => option\.value === selectedKey\)[\s\S]*?filter\(option => option\.value !== selectedKey\)/,
  'la asociación de sistema detectada o elegida debe subir al primer lugar sin duplicarse'
)
assert.match(
  importedFieldPrioritySource,
  /currentValue\.startsWith\('custom:'\)[\s\S]*?filter\(field => field\.definitionId === selectedDefinitionId\)[\s\S]*?filter\(field => field\.definitionId !== selectedDefinitionId\)/,
  'el campo personalizado existente ya asociado debe subir antes de los demás personalizados'
)
assert.match(
  importedFieldMappingRowSource,
  /<optgroup label="Campos del sistema">[\s\S]*?<optgroup label="Campos personalizados existentes">[\s\S]*?<optgroup label="Crear campo nuevo">/,
  'los destinos existentes deben aparecer antes de la opción que crea un campo nuevo'
)

console.log('Sites HTML creation flow contract OK')
