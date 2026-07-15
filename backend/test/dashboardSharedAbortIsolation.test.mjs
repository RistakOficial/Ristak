import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const requireFromFrontend = createRequire(join(repoRoot, 'frontend/package.json'))

async function importSharedRequestModule() {
  const typescript = requireFromFrontend('typescript')
  const source = await readFile(join(repoRoot, 'frontend/src/services/sharedRequest.ts'), 'utf8')
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
      target: typescript.ScriptTarget.ES2020
    },
    fileName: 'sharedRequest.ts'
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('un consumidor aborta sin cancelar el singleflight que otro consumidor comparte', async () => {
  const { getOrCreateSharedRequest } = await importSharedRequestModule()
  const inflight = new Map()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const expected = { ingresosNetos: { value: 123, variation: 4 } }
  let resolveRequest
  let requestCount = 0

  const createRequest = () => {
    requestCount += 1
    return new Promise(resolve => {
      resolveRequest = resolve
    })
  }

  const first = getOrCreateSharedRequest({
    inflight,
    key: '2026-07-01:2026-07-31',
    createRequest,
    signal: firstController.signal
  })
  const second = getOrCreateSharedRequest({
    inflight,
    key: '2026-07-01:2026-07-31',
    createRequest,
    signal: secondController.signal
  })

  assert.equal(requestCount, 1)
  assert.equal(inflight.size, 1)

  const firstRejected = assert.rejects(first, error => error?.name === 'AbortError')
  firstController.abort()
  await firstRejected

  resolveRequest(expected)
  assert.equal(await second, expected)
  await Promise.resolve()
  assert.equal(inflight.size, 0)
  assert.equal(requestCount, 1)
})

test('desregistrar un singleflight conserva consumidores viejos y fuerza transporte nuevo', async () => {
  const { detachSharedRequests, getOrCreateSharedRequest } = await importSharedRequestModule()
  const inflight = new Map()
  const firstGate = deferred()
  let requestCount = 0
  let firstSignal

  const createRequest = signal => {
    requestCount += 1
    if (requestCount === 1) {
      firstSignal = signal
      return firstGate.promise
    }
    return Promise.resolve({ revision: 2 })
  }

  const first = getOrCreateSharedRequest({
    inflight,
    key: 'same-range',
    createRequest,
    abortWhenUnused: true
  })
  detachSharedRequests(inflight)

  assert.equal(firstSignal?.aborted, false)
  const second = getOrCreateSharedRequest({
    inflight,
    key: 'same-range',
    createRequest,
    abortWhenUnused: true
  })
  assert.equal(requestCount, 2)
  assert.deepEqual(await second, { revision: 2 })

  firstGate.resolve({ revision: 1 })
  assert.deepEqual(await first, { revision: 1 })
  await Promise.resolve()
  assert.equal(inflight.size, 0)
})

test('Dashboard cancela el fetch compartido sólo cuando se va el último consumidor', async () => {
  const source = await readFile(join(repoRoot, 'frontend/src/services/dashboardService.ts'), 'utf8')
  const metricsMethod = source.slice(
    source.indexOf('async getDashboardMetrics'),
    source.indexOf('async getOperationalSnapshot')
  )

  assert.match(metricsMethod, /getOrCreateSharedRequest\(\{/)
  assert.match(metricsMethod, /inflight: dashboardMetricsInflight/)
  assert.match(metricsMethod, /signal: options\.signal/)
  assert.match(metricsMethod, /abortWhenUnused: true/)
  assert.match(metricsMethod, /createRequest: sharedSignal => scheduleDashboardHeavyRead\(\{[\s\S]*signal: sharedSignal/)
  assert.match(metricsMethod, /fetch\(apiUrl\(`\/api\/dashboard\/metrics\?\$\{queryParams\}`\), \{ signal \}\)/)
  assert.doesNotMatch(metricsMethod, /fetch\([\s\S]*signal:\s*options\.signal/)
})
