import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

const [tableSource, serviceSource] = await Promise.all([
  readFile(join(repoRoot, 'frontend/src/components/common/SessionsTable/SessionsTable.tsx'), 'utf8'),
  readFile(join(repoRoot, 'frontend/src/services/trackingService.ts'), 'utf8')
])

test('la tabla consulta tracking con cursor y un contrato sin COUNT', () => {
  assert.match(serviceSource, /export interface TrackingSessionsSearchInput/)
  assert.match(serviceSource, /export interface TrackingSessionsSearchResponse/)
  assert.match(serviceSource, /items: TrackingSession\[\]/)
  assert.match(serviceSource, /nextCursor: string \| null/)
  assert.match(serviceSource, /'\/api\/tracking\/sessions\/search'/)
  assert.match(serviceSource, /const query = input\.q\?\.trim\(\) \?\? ''/)
  assert.match(serviceSource, /query && query\.length < 3[\s\S]*searchMinLength: 3/)
  assert.match(serviceSource, /start: input\.start[\s\S]*end: input\.end[\s\S]*filters: input\.filters \?\? \{\}[\s\S]*q: query[\s\S]*column: input\.column \|\| 'all'[\s\S]*cursor: input\.cursor \?\? null[\s\S]*limit/)
  assert.match(serviceSource, /Math\.min\(100, Math\.max\(20,/)
  assert.match(serviceSource, /withRequestTimeout\(\{[\s\S]*?signal: options\.signal[\s\S]*?request: signal => apiClient\.post/)
  assert.match(serviceSource, /'\/api\/tracking\/sessions\/search'[\s\S]*?\{ signal \}/)
  assert.doesNotMatch(serviceSource, /searchSessions[\s\S]{0,1200}\btotal\b/)
})

test('la tabla usa busqueda remota cancelable y descarta respuestas atrasadas', () => {
  assert.match(tableSource, /range: SessionsTableRange/)
  assert.match(tableSource, /filters\?: TrackingSessionsFilters/)
  assert.match(tableSource, /const SEARCH_DEBOUNCE_MS = 300/)
  assert.match(tableSource, /new AbortController\(\)/)
  assert.match(tableSource, /activeRequestRef\.current\?\.abort\(\)/)
  assert.match(tableSource, /requestId !== requestSequenceRef\.current/)
  assert.match(tableSource, /if \(loadingSessions \|\| !hasMore \|\| !nextCursor \|\| loadingMoreRef\.current\) return/)
  assert.match(tableSource, /disabled=\{loadingSessions \|\| loadingMore \|\| !hasMore \|\| !nextCursor\}/)
  assert.match(tableSource, /trackingService\.searchSessions\(\{[\s\S]*q: debouncedSearchQuery[\s\S]*column: searchColumn[\s\S]*cursor:/)
  assert.doesNotMatch(tableSource, /buildSearchIndex|prepareSearchQuery|searchIndexIncludes/)
  assert.doesNotMatch(tableSource, /filteredSessions|useExternalData|getSessionsPaginated/)
})

test('la tabla pagina de 50 en 50 y permite volver sin descartar filas silenciosamente', () => {
  assert.match(tableSource, /const PAGE_SIZE = 50/)
  assert.match(tableSource, /setSessions\(response\.items\.slice\(0, PAGE_SIZE\)\)/)
  assert.match(tableSource, /response\.nextCursor/)
  assert.match(tableSource, /useState<Array<string \| null>>\(\[\]\)/)
  assert.match(tableSource, /loadPreviousPage/)
  assert.match(tableSource, /Página \{cursorHistory\.length \+ 1\}/)
  assert.match(tableSource, /\bAnterior\b/)
  assert.match(tableSource, /\bSiguiente\b/)
  assert.doesNotMatch(tableSource, /slice\(-MAX_RENDERED_SESSIONS\)/)
  assert.match(tableSource, /\{sessions\.map\(/)
  assert.doesNotMatch(tableSource, /IntersectionObserver/)
  assert.doesNotMatch(tableSource, /\(\{total\} total\)/)
})

test('editar y borrar refrescan la primera pagina del contrato acotado', () => {
  assert.match(tableSource, /deleteSessions\(idsToDelete\)[\s\S]*loadInitialSessions\(true\)/)
  assert.match(tableSource, /updateSession\(editingSession\.id, updates\)[\s\S]*loadInitialSessions\(true\)/)
  assert.equal((tableSource.match(/onSessionsChanged\?\.\(\)/g) || []).length, 2)
  assert.match(tableSource, /getSessionById\(sessionId\)/)
})

test('cerrar la vista expandida elimina de inmediato la busqueda oculta', () => {
  const toggleHandler = tableSource.match(/const handleToggleExpanded = \(\) => \{([\s\S]*?)\n  \}/)?.[1]

  assert.ok(toggleHandler)
  assert.match(toggleHandler, /if \(isExpanded\)/)
  assert.match(toggleHandler, /setSearchQuery\(''\)/)
  assert.match(toggleHandler, /setDebouncedSearchQuery\(''\)/)
  assert.match(toggleHandler, /setSearchColumn\('all'\)/)
  assert.match(tableSource, /compactSessions\.slice\(0, 10\)/)
})
