import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [sitesPage, stageTable, stageStyles] = await Promise.all([
  readFile(new URL('../src/pages/Sites/Sites.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Sites/analytics/StageConversionTable.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Sites/analytics/StageConversionTable.module.css', import.meta.url), 'utf8')
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
assert.doesNotMatch(
  sitesPage,
  /Métricas del \$\{entityLabel\} seleccionado/,
  'el detalle individual no debe repetir el elemento seleccionado ni su zona horaria'
)
assert.match(
  sitesPage,
  /\{\(isVideosView \|\| !selectedSiteId\) && \(\s*<div className=\{styles\.sitesAnalyticsScope\}>/,
  'el encabezado de alcance debe ocultarse en el detalle individual de embudos y formularios'
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
assert.doesNotMatch(
  sitesPage,
  /Conversiones sin atribución web|totalUnattributedConversions/,
  'la interfaz no debe exponer diagnósticos internos de atribución web'
)
assert.doesNotMatch(
  stageTable,
  /methodNotes|una misma persona puede contar más de una vez|Antes de eso se mantiene como En curso/,
  'el recorrido no debe ocupar espacio con notas metodológicas para el usuario'
)
assert.doesNotMatch(
  stageStyles,
  /\.methodNotes/,
  'los estilos de las notas metodológicas deben eliminarse junto con su interfaz'
)
assert.doesNotMatch(
  stageTable,
  /label="Avance \/ final"|label="No avanzaron"/,
  'la tabla de recorrido no debe mostrar columnas redundantes de avance o abandono'
)
assert.doesNotMatch(
  stageTable,
  /<Badge[^>]*className=\{styles\.rateValue\}/,
  'la tasa debe mostrarse como texto plano y no como badge o chip de estado'
)
assert.match(
  stageTable,
  /formatPercent\(stage\.progressionRate\)/,
  'la tasa visible debe usar la progresión de identidades únicas'
)

console.log('Sites entity analytics relevance contract OK')
