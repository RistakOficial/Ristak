import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const requireFromFrontend = createRequire(join(repoRoot, 'frontend/package.json'))
const repoFile = path => readFile(join(repoRoot, path), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function stripImports(source) {
  return source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
}

async function importTypeScriptSource(source, fileName) {
  const typescript = requireFromFrontend('typescript')
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
      target: typescript.ScriptTarget.ES2020
    },
    fileName
  }).outputText
  const encoded = Buffer.from(transpiled, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

async function importReportsServiceModule() {
  const [reportsSource, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    repoFile('frontend/src/services/reportsService.ts'),
    repoFile('frontend/src/services/sharedRequest.ts'),
    repoFile('frontend/src/services/requestTimeout.ts')
  ])
  const source = `${`
    const apiClient = globalThis.__ristakReportsTestApiClient
    const getAuthScopedCacheRevision = () => globalThis.__ristakReportsTestRevision || 0
    const registerAuthScopedCacheInvalidator = () => () => undefined
    const syncAuthScopedCachePrincipal = () => false
    const registerRistakApiReadCacheInvalidator = (invalidator, options) => {
      globalThis.__ristakReportsTestInvalidators?.push({ invalidator, options })
      return () => undefined
    }
  `}\n${stripImports(sharedRequestSource)}\n${stripImports(requestTimeoutSource)}\n${stripImports(reportsSource)}`
  return importTypeScriptSource(source, 'reportsService.behavior.ts')
}

function reportSnapshot(revision) {
  return {
    metrics: [],
    range: { start: null, end: null, timezone: 'America/Ciudad_Juarez', filtered: false },
    summary: { payments: {}, campaigns: {} },
    cache: {
      stale: false,
      consistency: 'exact',
      exactAtBuiltAt: true,
      builtAt: `2026-07-14T00:00:0${revision}.000Z`,
      builtSourceRevision: String(revision),
      currentSourceRevision: String(revision),
      ageMs: 0,
      revalidateAfter: '2026-07-14T00:00:30.000Z',
      maxStaleAgeMs: 300_000
    }
  }
}

test('Reportes comparte inflight, conserva el snapshot ante eventos vivos y sólo invalida duro', async () => {
  const previousClient = globalThis.__ristakReportsTestApiClient
  const previousRevision = globalThis.__ristakReportsTestRevision
  const previousInvalidators = globalThis.__ristakReportsTestInvalidators
  const firstResponse = deferred()
  const calls = []
  globalThis.__ristakReportsTestRevision = 0
  globalThis.__ristakReportsTestInvalidators = []
  globalThis.__ristakReportsTestApiClient = {
    get: (path, options) => {
      calls.push({ path, options })
      return calls.length === 1
        ? firstResponse.promise
        : Promise.resolve(reportSnapshot(calls.length))
    },
    put: () => Promise.reject(new Error('PUT inesperado en esta prueba'))
  }

  try {
    const { reportsService } = await importReportsServiceModule()
    const query = {
      from: '2026-07-01',
      to: '2026-07-14',
      groupBy: 'day',
      scope: 'all'
    }
    assert.equal(globalThis.__ristakReportsTestInvalidators.length, 1)
    assert.deepEqual(
      globalThis.__ristakReportsTestInvalidators[0].options?.pathPrefixes,
      ['/api/reports']
    )

    const first = reportsService.getSnapshot(query)
    const second = reportsService.getSnapshot(query)
    assert.equal(calls.length, 1, 'dos consumidores equivalentes deben compartir transporte')

    const initial = reportSnapshot(1)
    firstResponse.resolve(initial)
    assert.equal(await first, initial)
    assert.equal(await second, initial)
    assert.equal(await reportsService.getSnapshot(query), initial)
    assert.equal(calls.length, 1, 'volver durante el TTL debe pintar el snapshot sin otra red')

    const [{ invalidator }] = globalThis.__ristakReportsTestInvalidators
    invalidator({ abortInflight: false })
    assert.equal(await reportsService.getSnapshot(query), initial)
    assert.equal(calls.length, 1, 'un evento vivo frecuente no debe enfriar Reportes')

    invalidator({ abortInflight: true })
    const afterMutation = await reportsService.getSnapshot(query)
    assert.equal(afterMutation.cache.builtSourceRevision, '2')
    assert.equal(calls.length, 2, 'una mutación explícita sí debe forzar una lectura nueva')
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakReportsTestApiClient
    else globalThis.__ristakReportsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakReportsTestRevision
    else globalThis.__ristakReportsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakReportsTestInvalidators
    else globalThis.__ristakReportsTestInvalidators = previousInvalidators
  }
})
