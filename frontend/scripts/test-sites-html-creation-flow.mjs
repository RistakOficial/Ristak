import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sitesSourceUrl = new URL('../src/pages/Sites/Sites.tsx', import.meta.url)
const sitesSource = await readFile(sitesSourceUrl, 'utf8')

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

console.log('Sites HTML creation flow contract OK')
