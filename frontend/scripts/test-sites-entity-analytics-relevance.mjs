import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [sitesPage, stageTable] = await Promise.all([
  readFile(new URL('../src/pages/Sites/Sites.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Sites/analytics/StageConversionTable.tsx', import.meta.url), 'utf8')
])

assert.match(
  sitesPage,
  /const showEntityComparisons = !selectedSiteId/,
  'los rankings comparativos deben depender de que no haya un elemento seleccionado'
)
assert.match(
  sitesPage,
  /\{showEntityComparisons && \(\s*<div className=\{styles\.sitesAnalyticsGrid\}>/,
  'los rankings entre sitios o formularios deben ocultarse en el detalle individual'
)
assert.doesNotMatch(
  sitesPage,
  /Elementos en vivo|activeEntityCount/,
  'el inventario de publicación no debe ocupar espacio en las analíticas de rendimiento'
)
assert.match(
  sitesPage,
  /Métricas del \$\{entityLabel\} seleccionado/,
  'el contexto individual debe describir al elemento seleccionado, no resumir el inventario'
)
assert.match(
  sitesPage,
  /<span>Actividad por periodo<\/span>/,
  'la actividad temporal debe permanecer disponible en el alcance global e individual'
)
assert.doesNotMatch(
  stageTable,
  /hasTerminalOutcome|stageKind|\{hasTerminalOutcome \? 'Terminación'/,
  'las etapas no deben repetir etiquetas de tipo o terminación junto a su nombre'
)
assert.match(
  stageTable,
  /<strong>\{stage\.label\}<\/strong>/,
  'el nombre de cada etapa debe permanecer visible'
)

console.log('Sites entity analytics relevance contract OK')
