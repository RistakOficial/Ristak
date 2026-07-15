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

test('Dashboard conecta el signal al consumidor, no al fetch compartido', async () => {
  const source = await readFile(join(repoRoot, 'frontend/src/services/dashboardService.ts'), 'utf8')
  const metricsMethod = source.slice(
    source.indexOf('async getDashboardMetrics'),
    source.indexOf('async getOperationalSnapshot')
  )

  assert.match(metricsMethod, /getOrCreateSharedRequest\(\{/)
  assert.match(metricsMethod, /inflight: dashboardMetricsInflight/)
  assert.match(metricsMethod, /signal: options\.signal/)
  assert.match(metricsMethod, /fetch\(apiUrl\(`\/api\/dashboard\/metrics\?\$\{queryParams\}`\)\)/)
  assert.doesNotMatch(metricsMethod, /fetch\([\s\S]*signal:\s*options\.signal/)
})
