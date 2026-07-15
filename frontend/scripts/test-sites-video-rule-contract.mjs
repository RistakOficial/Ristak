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

const manifestParserSource = sourceBetween(
  'const parseImportedNativeVideoRuleManifest =',
  'const detectImportedNativeElementSlots ='
)
assert.match(
  manifestParserSource,
  /videoActionTargetKinds\.has\(normalized\.action\)\s*&&\s*!normalized\.targetBlockId/,
  'el manifiesto HTML debe rechazar acciones que requieren target cuando no declaran ninguno'
)
assert.match(
  manifestParserSource,
  /está incompleta o no tiene un target válido/,
  'el editor debe mostrar un diagnóstico entendible para la regla inválida'
)

const normalizerSource = sourceBetween(
  'const normalizeVideoActionRule =',
  'const getVideoActionRules ='
)
assert.doesNotMatch(
  normalizerSource,
  /videoActionTargetKinds\.has/,
  'el normalizador compartido debe seguir aceptando el borrador de una acción nueva antes de elegir target'
)

const mountLifecycleSource = sourceBetween(
  'useEffect(() => {\n    importedNativeElementMountedRef.current = true',
  'useEffect(() => {\n    const saveWasActive = importedNativeElementGlobalSaveWasActiveRef.current'
)
assert.ok(
  mountLifecycleSource.indexOf('importedNativeElementMountedRef.current = true') <
    mountLifecycleSource.indexOf('return () => {') &&
    mountLifecycleSource.indexOf('return () => {') <
    mountLifecycleSource.indexOf('importedNativeElementMountedRef.current = false'),
  'StrictMode debe reactivar el guard de montaje antes de registrar su cleanup'
)

console.log('Sites imported video rule contract OK')
