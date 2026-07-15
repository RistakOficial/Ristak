import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const serviceSource = readFileSync(
  new URL('../src/services/trackingAnalyticsService.js', import.meta.url),
  'utf8'
)

function functionSource(startMarker, endMarker) {
  const start = serviceSource.indexOf(startMarker)
  const end = serviceSource.indexOf(endMarker, start)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró el cierre de ${startMarker}`)
  return serviceSource.slice(start, end)
}

test('las facetas PostgreSQL podan cada dimensión antes del UNION sin materialización explosiva', () => {
  const source = functionSource(
    'async function queryPostgresSessionFacetsWithoutConversionFilter',
    '\nfunction hierarchyNodeKey'
  )
  const executableSource = source.replace(/^\s*\/\/.*$/gm, '')

  assert.doesNotMatch(
    executableSource,
    /GROUPING\s+SETS/i,
    'GROUPING SETS conserva simultáneamente todas las cardinalidades y vuelve a derramar GiB a temporales'
  )
  assert.doesNotMatch(
    executableSource,
    /\bMATERIALIZED\b/i,
    'las ramas deben filtrar sessions directamente; no se permite materializar el rango completo'
  )

  assert.match(source, /const facetBranches = dimensions\.map\(/)
  assert.match(source, /const branchParams = \[range\.startUtc, range\.endExclusiveUtc\]/)
  assert.match(source, /params\.push\(\.\.\.branchParams\)/)
  assert.match(source, /FROM sessions s\s+WHERE \$\{conditions\.join\(' AND '\)\}/)
  assert.match(
    source,
    /conditions\.push\(`COALESCE\(CAST\(\$\{value\} AS TEXT\), ''\) != ''`\)/,
    'los valores vacíos deben descartarse antes de agregar'
  )

  const branchStart = source.indexOf('const facetBranches = dimensions.map(')
  const earlyLimit = source.indexOf('LIMIT ${FACET_LIMIT}', branchStart)
  const union = source.indexOf("facetBranches.join('\\nUNION ALL\\n')", branchStart)
  assert.ok(earlyLimit > branchStart, 'cada rama debe aplicar su top-N')
  assert.ok(union > earlyLimit, 'el LIMIT debe ocurrir dentro de cada rama, antes del UNION ALL')

  assert.match(source, /dimension === 'topVisitors'\s+\? 'COUNT\(\*\)'/)
  assert.match(source, /`COUNT\(DISTINCT \$\{identity\}\)`/)
  assert.match(
    source,
    /CAST\(MAX\(COALESCE\(\$\{label\}, \$\{value\}, ''\)\) AS TEXT\) AS label/,
    'la optimización debe conservar el label propio de cada dimensión'
  )
  assert.match(source, /ORDER BY item_count DESC, value ASC\s+LIMIT \$\{FACET_LIMIT\}/)
  assert.match(source, /ORDER BY dimension ASC, item_count DESC, value ASC/)
})
