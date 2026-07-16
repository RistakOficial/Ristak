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

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

function jsonResponse(value) {
  const body = JSON.stringify(value)
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    }
  })
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

test('las lecturas acotadas abortan el fetch real y rechazan en vez de dejar loaders infinitos', async () => {
  const requestTimeoutSource = await repoFile('frontend/src/services/requestTimeout.ts')
  const { RequestTimeoutError, withRequestTimeout } = await importTypeScriptSource(
    requestTimeoutSource,
    'requestTimeout.behavior.ts'
  )
  let requestSignal

  await assert.rejects(
    withRequestTimeout({
      timeoutMs: 10,
      timeoutMessage: 'La consulta excedió el tiempo permitido.',
      request: signal => {
        requestSignal = signal
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    }),
    error => error instanceof RequestTimeoutError
      && error.message === 'La consulta excedió el tiempo permitido.'
  )

  assert.equal(requestSignal?.aborted, true)
})

async function importAuthFetchModule() {
  const source = stripImports(await repoFile('frontend/src/services/authFetch.ts'))
  return importTypeScriptSource(`${`
    const getApiBaseUrl = () => ''
    const finishRistakApiRequest = () => undefined
    const startRistakApiRequest = () => 1
    const syncAuthScopedCachePrincipal = () => false
  `}\n${source}`, 'authFetch.ts')
}

async function withInstalledAuthFetch(originalFetch, run) {
  const previousWindow = globalThis.window
  const previousLocalStorage = globalThis.localStorage
  const values = new Map([['auth_token', 'test-principal']])
  const localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  }
  const windowMock = {
    fetch: originalFetch,
    localStorage,
    location: {
      origin: 'https://app.ristak.test',
      hostname: 'app.ristak.test',
      pathname: '/dashboard',
      href: 'https://app.ristak.test/dashboard'
    },
    setTimeout,
    clearTimeout
  }

  globalThis.window = windowMock
  globalThis.localStorage = localStorage

  try {
    const authFetch = await importAuthFetchModule()
    authFetch.installAuthFetch()
    return await run(authFetch, windowMock)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousLocalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousLocalStorage
  }
}

test('una invalidación path-scoped notifica únicamente snapshots del mismo módulo', async () => {
  await withInstalledAuthFetch(
    async () => jsonResponse({}),
    async ({
      invalidateRistakApiReadCache,
      registerRistakApiReadCacheInvalidator
    }) => {
      let analyticsInvalidations = 0
      let contactsInvalidations = 0
      registerRistakApiReadCacheInvalidator(
        () => { analyticsInvalidations += 1 },
        { pathPrefixes: ['/api/tracking'] }
      )
      registerRistakApiReadCacheInvalidator(
        () => { contactsInvalidations += 1 },
        { pathPrefixes: ['/api/contacts'] }
      )

      invalidateRistakApiReadCache({ pathPrefixes: ['/api/contacts/chats'] })
      assert.equal(contactsInvalidations, 1)
      assert.equal(analyticsInvalidations, 0)

      invalidateRistakApiReadCache({ pathPrefixes: ['/api/tracking/sessions'] })
      assert.equal(contactsInvalidations, 1)
      assert.equal(analyticsInvalidations, 1)

      invalidateRistakApiReadCache()
      assert.equal(contactsInvalidations, 2)
      assert.equal(analyticsInvalidations, 2)
    }
  )
})

test('una invalidación viva marca stale sin cancelar una lectura activa', async () => {
  await withInstalledAuthFetch(
    async () => jsonResponse({}),
    async ({
      invalidateRistakApiReadCache,
      registerRistakApiReadCacheInvalidator
    }) => {
      const contexts = []
      registerRistakApiReadCacheInvalidator(
        context => contexts.push(context),
        { pathPrefixes: ['/api/tracking'] }
      )

      invalidateRistakApiReadCache({
        pathPrefixes: ['/api/tracking'],
        abortInflight: false
      })
      assert.deepEqual(contexts, [{ abortInflight: false }])
    }
  )
})

test('authFetch no materializa ni deduplica cuerpos GET globalmente', async () => {
  const firstNetworkResponse = deferred()
  let networkRequests = 0

  await withInstalledAuthFetch(
    async () => {
      networkRequests += 1
      if (networkRequests === 1) return firstNetworkResponse.promise
      return jsonResponse({ source: 'second-network-read' })
    },
    async (_authFetch, windowMock) => {
      const firstRead = windowMock.fetch('/api/analytics/overview')
      const secondRead = windowMock.fetch('/api/analytics/overview')

      firstNetworkResponse.resolve(jsonResponse({ source: 'first-network-read' }))

      assert.deepEqual(await (await firstRead).json(), { source: 'first-network-read' })
      assert.deepEqual(await (await secondRead).json(), { source: 'second-network-read' })
      assert.equal(networkRequests, 2)
    }
  )
})

test('una mutación invalida sólo los snapshots especializados que dependen de su módulo', async () => {
  await withInstalledAuthFetch(
    async () => jsonResponse({ ok: true }),
    async ({ registerRistakApiReadCacheInvalidator }, windowMock) => {
      // Inicializa el principal antes de registrar snapshots. El primer principal
      // invalida todo por seguridad; ése no es el evento bajo prueba.
      await windowMock.fetch('/api/health')
      let contactsInvalidations = 0
      let sitesInvalidations = 0
      let dashboardInvalidations = 0
      registerRistakApiReadCacheInvalidator(
        () => { contactsInvalidations += 1 },
        { pathPrefixes: ['/api/contacts'] }
      )
      registerRistakApiReadCacheInvalidator(
        () => { sitesInvalidations += 1 },
        { pathPrefixes: ['/api/sites'] }
      )
      registerRistakApiReadCacheInvalidator(
        () => { dashboardInvalidations += 1 },
        { pathPrefixes: ['/api/dashboard'] }
      )

      const response = await windowMock.fetch('/api/contacts/contact-1', { method: 'PATCH' })
      assert.equal(response.ok, true)
      assert.equal(contactsInvalidations, 1)
      assert.equal(sitesInvalidations, 0)
      assert.equal(dashboardInvalidations, 1)

      await windowMock.fetch('/api/contacts/chats/contact-1/read', { method: 'POST' })
      assert.equal(contactsInvalidations, 2)
      assert.equal(dashboardInvalidations, 1, 'marcar leído no cambia métricas analíticas')

      await windowMock.fetch('/api/calendars/appointment-1', { method: 'PATCH' })
      assert.equal(dashboardInvalidations, 2, 'calendars plural sí invalida métricas')
    }
  )
})

async function importAnalyticsServiceModule() {
  const [analyticsSource, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    repoFile('frontend/src/services/analyticsService.ts'),
    repoFile('frontend/src/services/sharedRequest.ts'),
    repoFile('frontend/src/services/requestTimeout.ts')
  ])
  const source = `${`
    const apiClient = globalThis.__ristakAnalyticsTestApiClient
    const getAuthScopedCacheRevision = () => globalThis.__ristakAnalyticsTestRevision || 0
    const registerAuthScopedCacheInvalidator = () => () => undefined
    const syncAuthScopedCachePrincipal = () => false
    const registerRistakApiReadCacheInvalidator = (invalidator, options) => {
      globalThis.__ristakAnalyticsTestInvalidators?.push({ invalidator, options })
      return () => undefined
    }
  `}\n${stripImports(sharedRequestSource)}\n${stripImports(requestTimeoutSource)}\n${stripImports(analyticsSource)}`
  return importTypeScriptSource(source, 'analyticsService.behavior.ts')
}

async function importApiClientModule() {
  const source = stripImports(await repoFile('frontend/src/services/apiClient.ts'))
  return importTypeScriptSource(`const getApiBaseUrl = () => ''\n${source}`, 'apiClient.behavior.ts')
}

async function importDashboardServiceModule() {
  const [dashboardSource, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    repoFile('frontend/src/services/dashboardService.ts'),
    repoFile('frontend/src/services/sharedRequest.ts'),
    repoFile('frontend/src/services/requestTimeout.ts')
  ])
  const source = `${`
    const apiUrl = path => path
    const formatDateToISO = value => value.toISOString().slice(0, 10)
    const formatEndDateToISO = value => value.toISOString().slice(0, 10)
    const trackingService = {}
    const getAuthScopedCacheRevision = () => globalThis.__ristakDashboardTestRevision || 0
    const registerAuthScopedCacheInvalidator = () => () => undefined
    const syncAuthScopedCachePrincipal = () => false
    const registerRistakApiReadCacheInvalidator = (invalidator, options) => {
      globalThis.__ristakDashboardTestInvalidators?.push({ invalidator, options })
      return () => undefined
    }
  `}\n${stripImports(sharedRequestSource)}\n${stripImports(requestTimeoutSource)}\n${stripImports(dashboardSource)}`
  return importTypeScriptSource(source, 'dashboardService.behavior.ts')
}

test('el plan inicial de Analíticas difiere la frescura stale y excluye topVisitors del lote por viewport', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  globalThis.__ristakAnalyticsTestApiClient = {
    post: () => Promise.reject(new Error('POST inesperado durante el plan inicial')),
    get: () => Promise.reject(new Error('GET inesperado durante el plan inicial'))
  }
  globalThis.__ristakAnalyticsTestInvalidators = []

  try {
    const {
      TRACKING_ANALYTICS_VIEWPORT_DISTRIBUTION_DIMENSIONS,
      scheduleTrackingAnalyticsStaleRevalidation
    } = await importAnalyticsServiceModule()
    assert.deepEqual(
      [...TRACKING_ANALYTICS_VIEWPORT_DISTRIBUTION_DIMENSIONS],
      ['sources', 'placements', 'devices', 'os', 'browsers']
    )
    assert.equal(TRACKING_ANALYTICS_VIEWPORT_DISTRIBUTION_DIMENSIONS.includes('topVisitors'), false)

    const now = Date.parse('2026-07-16T12:00:00.000Z')
    const scheduled = []
    let refreshes = 0
    const timer = scheduleTrackingAnalyticsStaleRevalidation(
      { stale: true, revalidateAfter: '2026-07-16T11:59:00.000Z' },
      () => { refreshes += 1 },
      {
        now,
        setTimer: (callback, delayMs) => {
          scheduled.push({ callback, delayMs })
          return 41
        }
      }
    )

    assert.equal(timer, 41)
    assert.equal(refreshes, 0, 'la revalidación no debe arrancar dentro de la carga inicial')
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].delayMs, 30_000)
    scheduled[0].callback()
    assert.equal(refreshes, 1)

    const freshTimer = scheduleTrackingAnalyticsStaleRevalidation(
      { stale: false, revalidateAfter: '2026-07-16T12:00:00.000Z' },
      () => { refreshes += 1 },
      { now, setTimer: () => 42 }
    )
    assert.equal(freshTimer, null)
    assert.equal(refreshes, 1)
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('el snapshot especializado de Analíticas declara que sólo depende de tracking', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  globalThis.__ristakAnalyticsTestApiClient = {
    post: () => Promise.reject(new Error('POST inesperado durante el import')),
    get: () => Promise.reject(new Error('GET inesperado durante el import'))
  }
  globalThis.__ristakAnalyticsTestInvalidators = []

  try {
    await importAnalyticsServiceModule()
    assert.equal(globalThis.__ristakAnalyticsTestInvalidators.length, 1)
    assert.ok(
      globalThis.__ristakAnalyticsTestInvalidators[0].options?.pathPrefixes
        ?.some(prefix => prefix === '/api/tracking' || prefix.startsWith('/api/tracking/')),
      'el cache especializado de Analíticas debe declarar que sólo depende de tracking'
    )
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('el resumen de Analíticas comparte el request en vuelo y reutiliza el snapshot fresco', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousRevision = globalThis.__ristakAnalyticsTestRevision
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  const networkResponse = deferred()
  const calls = []
  globalThis.__ristakAnalyticsTestRevision = 0
  globalThis.__ristakAnalyticsTestInvalidators = []
  globalThis.__ristakAnalyticsTestApiClient = {
    post: (path, body, options) => {
      calls.push({ path, body, options })
      return networkResponse.promise
    },
    get: () => Promise.reject(new Error('GET inesperado en esta prueba'))
  }

  try {
    const { getTrackingAnalyticsSummary } = await importAnalyticsServiceModule()
    const firstInput = {
      start: '2026-07-01',
      end: '2026-07-14',
      groupBy: 'day',
      filters: {
        source: ['meta', 'google'],
        device: ['mobile']
      }
    }
    const equivalentInput = {
      start: '2026-07-01',
      end: '2026-07-14',
      groupBy: 'day',
      filters: {
        device: ['mobile'],
        source: ['google', 'meta']
      }
    }

    const first = getTrackingAnalyticsSummary(firstInput)
    const second = getTrackingAnalyticsSummary(equivalentInput)
    assert.equal(calls.length, 1)

    const expected = { snapshot: { stale: false, revision: 17 } }
    networkResponse.resolve(expected)
    assert.equal(await first, expected)
    assert.equal(await second, expected)

    assert.equal(await getTrackingAnalyticsSummary(firstInput), expected)
    assert.equal(calls.length, 1)
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakAnalyticsTestRevision
    else globalThis.__ristakAnalyticsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('Analíticas reintenta warming máximo tres veces y nunca reintenta busy/deadline', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousRevision = globalThis.__ristakAnalyticsTestRevision
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  globalThis.__ristakAnalyticsTestRevision = 0
  globalThis.__ristakAnalyticsTestInvalidators = []
  let calls = 0
  globalThis.__ristakAnalyticsTestApiClient = {
    post: () => {
      calls += 1
      return Promise.reject(Object.assign(new Error('warming'), {
        status: 503,
        body: { code: 'tracking_analytics_projection_warming', retryable: true },
        retryAfterMs: 0
      }))
    },
    get: () => Promise.reject(new Error('GET inesperado'))
  }

  try {
    const { getTrackingAnalyticsSummary } = await importAnalyticsServiceModule()
    await assert.rejects(
      getTrackingAnalyticsSummary({
        start: '2026-07-01',
        end: '2026-07-16',
        groupBy: 'day',
        includeFacets: false
      }),
      error => error?.body?.code === 'tracking_analytics_projection_warming'
    )
    assert.equal(calls, 3)

    calls = 0
    globalThis.__ristakAnalyticsTestApiClient.post = () => {
      calls += 1
      return Promise.reject(Object.assign(new Error('busy'), {
        status: 503,
        body: { code: 'tracking_analytics_busy', retryable: true },
        retryAfterMs: 0
      }))
    }
    const freshModule = await importAnalyticsServiceModule()
    await assert.rejects(
      freshModule.getTrackingAnalyticsSummary({
        start: '2026-07-02',
        end: '2026-07-16',
        groupBy: 'day',
        includeFacets: false
      }),
      error => error?.body?.code === 'tracking_analytics_busy'
    )
    assert.equal(calls, 1)
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakAnalyticsTestRevision
    else globalThis.__ristakAnalyticsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('Retry-After se normaliza y la espera de warming es abortable', async () => {
  const { parseRetryAfterMs } = await importApiClientModule()
  assert.equal(parseRetryAfterMs('2'), 2_000)
  assert.equal(
    parseRetryAfterMs('Thu, 16 Jul 2026 12:00:05 GMT', Date.parse('Thu, 16 Jul 2026 12:00:00 GMT')),
    5_000
  )
  assert.equal(parseRetryAfterMs('no-es-fecha'), undefined)

  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  globalThis.__ristakAnalyticsTestApiClient = {
    post: () => Promise.reject(new Error('POST inesperado')),
    get: () => Promise.reject(new Error('GET inesperado'))
  }
  globalThis.__ristakAnalyticsTestInvalidators = []
  try {
    const { waitForTrackingAnalyticsRetry } = await importAnalyticsServiceModule()
    const controller = new AbortController()
    const waiting = waitForTrackingAnalyticsRetry(10_000, controller.signal)
    controller.abort()
    await assert.rejects(waiting, error => error?.name === 'AbortError')
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('el core sin facetas no comparte cache con el contrato legacy y cada faceta se deduplica por dimensión', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousRevision = globalThis.__ristakAnalyticsTestRevision
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  const calls = []
  globalThis.__ristakAnalyticsTestRevision = 0
  globalThis.__ristakAnalyticsTestInvalidators = []
  globalThis.__ristakAnalyticsTestApiClient = {
    post: (path, body) => {
      calls.push({ path, body })
      if (path.endsWith('/facets')) {
        return Promise.resolve({
          range: { start: body.start, end: body.end, timezone: 'America/Ciudad_Juarez' },
          facet: { dimension: body.dimension, items: [{ value: body.dimension, label: body.dimension, count: 1 }] },
          snapshot: { stale: false, revision: 4 }
        })
      }
      return Promise.resolve({ snapshot: { stale: false, revision: body.includeFacets === false ? 2 : 3 } })
    },
    get: () => Promise.reject(new Error('GET inesperado en esta prueba'))
  }

  try {
    const { getTrackingAnalyticsFacet, getTrackingAnalyticsSummary } = await importAnalyticsServiceModule()
    const common = { start: '2026-07-01', end: '2026-07-14', groupBy: 'day', filters: {} }
    await getTrackingAnalyticsSummary({ ...common, includeFacets: false })
    await getTrackingAnalyticsSummary(common)
    assert.equal(calls.filter(call => call.path.endsWith('/summary')).length, 2)
    assert.equal(calls[0].body.includeFacets, false)

    const facetInput = {
      start: common.start,
      end: common.end,
      filters: { device_type: ['mobile'] },
      dimension: 'devices'
    }
    const [first, second] = await Promise.all([
      getTrackingAnalyticsFacet(facetInput),
      getTrackingAnalyticsFacet({ ...facetInput, filters: { device_type: ['mobile'] } })
    ])
    assert.deepEqual(first, second)
    assert.equal(calls.filter(call => call.path.endsWith('/facets')).length, 1)

    await getTrackingAnalyticsFacet(facetInput)
    assert.equal(calls.filter(call => call.path.endsWith('/facets')).length, 1, 'la faceta fresca debe reutilizarse')
    await getTrackingAnalyticsFacet({ ...facetInput, dimension: 'browsers' })
    assert.equal(calls.filter(call => call.path.endsWith('/facets')).length, 2, 'otra dimensión requiere su propio agregado')
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakAnalyticsTestRevision
    else globalThis.__ristakAnalyticsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('el request compartido de Analíticas sólo aborta el fetch cuando se va el último consumidor', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousRevision = globalThis.__ristakAnalyticsTestRevision
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  let calls = 0
  let sharedSignal
  const freshSnapshot = { snapshot: { stale: false, revision: 21 } }
  globalThis.__ristakAnalyticsTestRevision = 0
  globalThis.__ristakAnalyticsTestInvalidators = []
  globalThis.__ristakAnalyticsTestApiClient = {
    post: (_path, _body, options) => {
      calls += 1
      if (calls > 1) return Promise.resolve(freshSnapshot)
      sharedSignal = options?.signal
      return new Promise((resolve, reject) => {
        sharedSignal?.addEventListener('abort', () => reject(sharedSignal.reason), { once: true })
      })
    },
    get: () => Promise.reject(new Error('GET inesperado en esta prueba'))
  }

  try {
    const { getTrackingAnalyticsSummary } = await importAnalyticsServiceModule()
    const input = {
      start: '2026-07-03',
      end: '2026-07-14',
      groupBy: 'day',
      filters: { utm_campaign: ['shared-abort'] }
    }
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = getTrackingAnalyticsSummary(input, { signal: firstController.signal })
    const second = getTrackingAnalyticsSummary(input, { signal: secondController.signal })
    assert.equal(calls, 1)

    firstController.abort()
    await assert.rejects(first, error => error?.name === 'AbortError')
    assert.equal(sharedSignal?.aborted, false, 'un consumidor activo debe conservar el fetch')

    secondController.abort()
    await assert.rejects(second, error => error?.name === 'AbortError')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sharedSignal?.aborted, true, 'el último consumidor debe cancelar el fetch real')

    assert.equal(await getTrackingAnalyticsSummary(input), freshSnapshot)
    assert.equal(calls, 2, 'una lectura posterior debe iniciar un request limpio')
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakAnalyticsTestRevision
    else globalThis.__ristakAnalyticsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('un evento vivo conserva el inflight y snapshot de Analíticas durante su TTL', async () => {
  const previousClient = globalThis.__ristakAnalyticsTestApiClient
  const previousRevision = globalThis.__ristakAnalyticsTestRevision
  const previousInvalidators = globalThis.__ristakAnalyticsTestInvalidators
  const gate = deferred()
  let calls = 0
  let sharedSignal
  globalThis.__ristakAnalyticsTestRevision = 0
  globalThis.__ristakAnalyticsTestInvalidators = []
  globalThis.__ristakAnalyticsTestApiClient = {
    post: (_path, _body, options) => {
      calls += 1
      if (calls === 1) sharedSignal = options?.signal
      return calls === 1 ? gate.promise : Promise.resolve({ snapshot: { revision: 2 } })
    },
    get: () => Promise.reject(new Error('GET inesperado en esta prueba'))
  }

  try {
    const { getTrackingAnalyticsSummary } = await importAnalyticsServiceModule()
    const input = {
      start: '2026-07-01',
      end: '2026-07-14',
      groupBy: 'day',
      filters: {}
    }
    const first = getTrackingAnalyticsSummary(input)
    const [{ invalidator }] = globalThis.__ristakAnalyticsTestInvalidators
    invalidator({ abortInflight: false })
    assert.equal(sharedSignal?.aborted, false)

    const shared = getTrackingAnalyticsSummary(input)
    assert.equal(calls, 1, 'la invalidación suave no debe abrir un transporte duplicado')

    gate.resolve({ snapshot: { revision: 1 } })
    assert.deepEqual(await first, { snapshot: { revision: 1 } })
    assert.deepEqual(await shared, { snapshot: { revision: 1 } })
    assert.deepEqual(await getTrackingAnalyticsSummary(input), { snapshot: { revision: 1 } })
    assert.equal(calls, 1, 'el snapshot fresco debe seguir reutilizándose dentro del TTL')

    invalidator({ abortInflight: true })
    assert.deepEqual(await getTrackingAnalyticsSummary(input), { snapshot: { revision: 2 } })
    assert.equal(calls, 2, 'una invalidación explícita sí debe forzar una lectura nueva')
  } finally {
    if (previousClient === undefined) delete globalThis.__ristakAnalyticsTestApiClient
    else globalThis.__ristakAnalyticsTestApiClient = previousClient
    if (previousRevision === undefined) delete globalThis.__ristakAnalyticsTestRevision
    else globalThis.__ristakAnalyticsTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakAnalyticsTestInvalidators
    else globalThis.__ristakAnalyticsTestInvalidators = previousInvalidators
  }
})

test('la invalidación suave conserva inflight y snapshot de Dashboard; la dura los reemplaza', async () => {
  const previousFetch = globalThis.fetch
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const gate = deferred()
  let calls = 0
  let firstSignal
  const oldMetrics = { ingresosNetos: { value: 10, variation: 0 } }
  const freshMetrics = { ingresosNetos: { value: 20, variation: 1 } }

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.fetch = (_url, options) => {
    calls += 1
    if (calls === 1) {
      firstSignal = options?.signal
      return gate.promise
    }
    return Promise.resolve(jsonResponse(freshMetrics))
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const range = {
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-07-14T23:59:59.000Z')
    }
    const first = dashboardService.getDashboardMetrics(range)
    await waitUntil(() => calls === 1, 'la primera lectura de métricas debió iniciar')
    globalThis.__ristakDashboardTestInvalidators.forEach(({ invalidator }) => {
      invalidator({ abortInflight: false })
    })

    assert.equal(firstSignal?.aborted, false)
    const shared = dashboardService.getDashboardMetrics(range)
    assert.equal(calls, 1, 'la lectura suave debe compartir la familia pesada que sigue activa')

    gate.resolve(jsonResponse(oldMetrics))
    assert.deepEqual(await Promise.all([first, shared]), [oldMetrics, oldMetrics])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await dashboardService.getDashboardMetrics(range), oldMetrics)
    assert.equal(calls, 1, 'el evento vivo debe conservar el snapshot durante su TTL')

    globalThis.__ristakDashboardTestInvalidators.forEach(({ invalidator }) => {
      invalidator({ abortInflight: true })
    })
    const fresh = dashboardService.getDashboardMetrics(range)
    await waitUntil(() => calls === 2, 'la invalidación dura debió abrir un transporte nuevo')
    assert.deepEqual(await fresh, freshMetrics)
    assert.deepEqual(await dashboardService.getDashboardMetrics(range), freshMetrics)
    assert.equal(calls, 2, 'el snapshot fresco debe reutilizarse después de la invalidación dura')
  } finally {
    globalThis.fetch = previousFetch
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('el Dashboard abre máximo dos familias pesadas y prioriza el primer paint', async () => {
  const previousFetch = globalThis.fetch
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const pending = []
  const started = []
  let active = 0
  let maxActive = 0

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.fetch = (url) => {
    const gate = deferred()
    const href = String(url)
    started.push(href)
    active += 1
    maxActive = Math.max(maxActive, active)
    pending.push({
      href,
      resolve(value) {
        active -= 1
        gate.resolve(jsonResponse(value))
      }
    })
    return gate.promise
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const range = {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-08-31T23:59:59.000Z')
    }

    // Se invocan deliberadamente al revés para probar que el batch del mismo
    // flush prioriza datos de primer paint, no el orden accidental de los effects.
    const origin = dashboardService.getOriginDistribution({ ...range })
    const funnel = dashboardService.getFunnelData({ ...range })
    const financial = dashboardService.getFinancialChart({ ...range })
    const operational = dashboardService.getOperationalSnapshot({ ...range })
    const metrics = dashboardService.getDashboardMetrics({ ...range })

    const expectedOrder = [
      '/api/dashboard/metrics?',
      '/api/dashboard/operational-snapshot?',
      '/api/dashboard/financial-overview?',
      '/api/dashboard/funnel?',
      '/api/dashboard/origin-distribution?'
    ]
    const responseFor = href => {
      if (href.includes('/metrics?')) return { ingresosNetos: { value: 1, variation: 0 } }
      if (href.includes('/operational-snapshot?')) {
        return { data: { transactions: [], contacts: [], appointments: [] } }
      }
      if (href.includes('/financial-overview?')) return { success: true, data: [] }
      if (href.includes('/funnel?')) return { success: true, data: [] }
      return { success: true, data: { traffic: {}, leads: [], appointments: [], conversions: [] } }
    }

    await waitUntil(() => started.length === 2, 'debieron iniciar los dos carriles prioritarios')
    assert.match(started[0], new RegExp(expectedOrder[0].replace(/[?]/g, '\\?')))
    assert.match(started[1], new RegExp(expectedOrder[1].replace(/[?]/g, '\\?')))
    assert.equal(active, 2)

    for (let index = 0; index < expectedOrder.length - 2; index += 1) {
      pending[index].resolve(responseFor(started[index]))
      await waitUntil(() => started.length === index + 3, `debió iniciar la familia ${index + 3}`)
      assert.match(started[index + 2], new RegExp(expectedOrder[index + 2].replace(/[?]/g, '\\?')))
      assert.equal(active, 2)
    }
    pending[3].resolve(responseFor(started[3]))
    pending[4].resolve(responseFor(started[4]))

    await Promise.all([origin, funnel, financial, operational, metrics])
    assert.equal(maxActive, 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('una tercera familia no consume su timeout de ejecución mientras espera en cola', async () => {
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const pending = []
  const started = []
  const observedTimeouts = []

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    observedTimeouts.push(Number(delay))
    return previousSetTimeout(callback, delay, ...args)
  }
  globalThis.fetch = (url) => {
    const gate = deferred()
    const href = String(url)
    started.push(href)
    pending.push({ href, resolve: value => gate.resolve(jsonResponse(value)) })
    return gate.promise
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const range = {
      start: new Date('2026-11-01T00:00:00.000Z'),
      end: new Date('2026-11-30T23:59:59.000Z')
    }
    const metrics = dashboardService.getDashboardMetrics(range)
    const operational = dashboardService.getOperationalSnapshot(range)
    const financial = dashboardService.getFinancialChart(range)

    await waitUntil(() => started.length === 2, 'las dos primeras familias debieron ocupar los carriles')
    assert.equal(
      observedTimeouts.filter(delay => delay === 20_000).length,
      2,
      'sólo las familias admitidas deben iniciar el timeout de ejecución'
    )
    assert.equal(started.some(href => href.includes('/financial-overview?')), false)

    pending[0].resolve({ ingresosNetos: { value: 1, variation: 0 } })
    await waitUntil(() => started.length === 3, 'la tercera familia debió entrar al liberarse un carril')
    assert.match(started[2], /\/api\/dashboard\/financial-overview\?/)
    assert.equal(
      observedTimeouts.filter(delay => delay === 20_000).length,
      3,
      'la tercera familia recibe su deadline completo sólo después de ser admitida'
    )

    pending[1].resolve({ data: { transactions: [], contacts: [], appointments: [] } })
    pending[2].resolve({ success: true, data: [] })
    await Promise.all([metrics, operational, financial])
  } finally {
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('fuentes de tráfico espera el scheduler y nunca abre un tercer transporte', async () => {
  const previousFetch = globalThis.fetch
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const pending = []
  const started = []
  let active = 0
  let maxActive = 0

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.fetch = (url) => {
    const gate = deferred()
    const href = String(url)
    started.push(href)
    active += 1
    maxActive = Math.max(maxActive, active)
    pending.push({
      href,
      resolve(value) {
        active -= 1
        gate.resolve(jsonResponse(value))
      }
    })
    return gate.promise
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const range = {
      start: new Date('2026-12-01T00:00:00.000Z'),
      end: new Date('2026-12-31T23:59:59.000Z')
    }
    const metrics = dashboardService.getDashboardMetrics(range)
    const operational = dashboardService.getOperationalSnapshot(range)
    const trafficSources = dashboardService.getTrafficSources(range)

    await waitUntil(() => started.length === 2, 'las familias prioritarias debieron ocupar ambos carriles')
    assert.equal(started.some(href => href.includes('/traffic-sources?')), false)
    assert.equal(active, 2)

    pending[0].resolve({ ingresosNetos: { value: 1, variation: 0 } })
    await waitUntil(() => started.length === 3, 'fuentes de tráfico debió entrar al liberarse un carril')
    assert.match(started[2], /\/api\/dashboard\/traffic-sources\?/)
    assert.equal(active, 2)

    pending[1].resolve({ data: { transactions: [], contacts: [], appointments: [] } })
    pending[2].resolve({ success: true, data: [{ name: 'Directo', value: 3 }] })
    assert.deepEqual(await trafficSources, [{ name: 'Directo', value: 3 }])
    await Promise.all([metrics, operational])
    assert.equal(maxActive, 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('la segunda serie arranca durante el dwell de la primera sin agotar su deadline en cola', async () => {
  const previousFetch = globalThis.fetch
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const pending = []
  const started = []
  const secondStarted = deferred()
  let active = 0
  let maxActive = 0

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.fetch = (url) => {
    const gate = deferred()
    started.push(String(url))
    if (started.length === 2) secondStarted.resolve()
    active += 1
    maxActive = Math.max(maxActive, active)
    pending.push({
      resolve(value) {
        active -= 1
        gate.resolve(jsonResponse(value))
      }
    })
    return gate.promise
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const params = {
      start: new Date('2026-10-01T00:00:00.000Z'),
      end: new Date('2026-10-31T23:59:59.000Z'),
      groupBy: 'day'
    }

    // El componente encola el par junto. La primera lectura queda
    // deliberadamente abierta: la segunda debe ocupar el otro carril y sólo
    // entonces iniciar su propio deadline de ejecución.
    const visitors = dashboardService.getVisitorsData(params)
    const leads = dashboardService.getLeadsData(params)

    let dwellTimeout
    const secondStartedWithinBudget = await Promise.race([
      secondStarted.promise.then(() => true),
      new Promise(resolve => {
        dwellTimeout = setTimeout(() => resolve(false), 100)
      })
    ])
    clearTimeout(dwellTimeout)
    assert.equal(secondStartedWithinBudget, true, 'la segunda serie no debe consumir el deadline esperando a la primera')
    assert.match(started[0], /\/api\/dashboard\/visitors\?/)
    assert.match(started[1], /\/api\/dashboard\/leads\?/)
    assert.equal(active, 2)

    // La segunda termina mientras la primera continúa lenta.
    pending[1].resolve([{ label: '2026-10-01', value: 2 }])
    assert.deepEqual(await leads, [{ label: '2026-10-01', value: 2 }])
    assert.equal(started.length, 2)

    pending[0].resolve([{ label: '2026-10-01', value: 3 }])

    assert.deepEqual(await visitors, [{ label: '2026-10-01', value: 3 }])
    assert.equal(maxActive, 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('navegar fuera aborta una familia pesada todavía en cola sin iniciar su fetch', async () => {
  const previousFetch = globalThis.fetch
  const previousRevision = globalThis.__ristakDashboardTestRevision
  const previousInvalidators = globalThis.__ristakDashboardTestInvalidators
  const pending = []
  const started = []

  globalThis.__ristakDashboardTestRevision = 0
  globalThis.__ristakDashboardTestInvalidators = []
  globalThis.fetch = (url) => {
    const gate = deferred()
    const href = String(url)
    started.push(href)
    pending.push({ href, resolve: value => gate.resolve(jsonResponse(value)) })
    return gate.promise
  }

  try {
    const { dashboardService } = await importDashboardServiceModule()
    const range = {
      start: new Date('2026-09-01T00:00:00.000Z'),
      end: new Date('2026-09-30T23:59:59.000Z')
    }
    const metrics = dashboardService.getDashboardMetrics(range)
    const operational = dashboardService.getOperationalSnapshot(range)
    const controller = new AbortController()
    const origin = dashboardService.getOriginDistribution({ ...range, signal: controller.signal })
    const originRejection = assert.rejects(origin, error => error?.name === 'AbortError')

    await waitUntil(() => started.length === 2, 'las dos lecturas prioritarias debieron ocupar los carriles')
    assert.match(started[0], /\/api\/dashboard\/metrics\?/)
    assert.match(started[1], /\/api\/dashboard\/operational-snapshot\?/)
    controller.abort(new DOMException('salió del Dashboard', 'AbortError'))
    await originRejection

    pending[0].resolve({ ingresosNetos: { value: 1, variation: 0 } })
    pending[1].resolve({ data: { transactions: [], contacts: [], appointments: [] } })
    await Promise.all([metrics, operational])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(started.length, 2, 'la distribución abortada nunca debe abrir transporte')
  } finally {
    globalThis.fetch = previousFetch
    if (previousRevision === undefined) delete globalThis.__ristakDashboardTestRevision
    else globalThis.__ristakDashboardTestRevision = previousRevision
    if (previousInvalidators === undefined) delete globalThis.__ristakDashboardTestInvalidators
    else globalThis.__ristakDashboardTestInvalidators = previousInvalidators
  }
})

test('los streams vivos usan invalidación suave para no reiniciar loaders pesados', async () => {
  const [chatLive, paymentLive] = await Promise.all([
    repoFile('frontend/src/services/chatLiveEventsService.ts'),
    repoFile('frontend/src/services/paymentLiveEventsService.ts')
  ])
  assert.ok((chatLive.match(/abortInflight: false/g) || []).length >= 2)
  assert.match(paymentLive, /abortInflight: false/)
})

test('el prefetch del shell de Sites no inicia el workspace pesado', async () => {
  const routeModules = await repoFile('frontend/src/routing/routeModules.tsx')
  const sitesLoader = routeModules.slice(
    routeModules.indexOf('const sites = createLazyRoute'),
    routeModules.indexOf('const automations = createLazyRoute')
  )

  assert.match(sitesLoader, /import\('@\/pages\/Sites\/SitesRoute'\)/)
  assert.doesNotMatch(sitesLoader, /prefetchSitesWorkspace|\.then\s*\(/)
  assert.doesNotMatch(sitesLoader, /import\('@\/pages\/Sites\/Sites'\)/)
})

test('Contactos monta una sola vez la tabla que sincroniza table_contacts_v2 durante la carga inicial', async () => {
  const [contactsSource, tableSource, appConfigSource, appConfigServiceSource] = await Promise.all([
    repoFile('frontend/src/pages/Contacts/Contacts.tsx'),
    repoFile('frontend/src/components/common/Table/Table.tsx'),
    repoFile('frontend/src/hooks/useAppConfig.ts'),
    repoFile('frontend/src/services/appConfigService.ts')
  ])

  const initialLoadingMatch = contactsSource.match(
    /const \[loading, setLoading\] = useState\((true|false)\)/
  )
  const initialLoadedMatch = contactsSource.match(
    /const \[hasLoadedContacts, setHasLoadedContacts\] = useState\((true|false)\)/
  )

  assert.ok(initialLoadingMatch, 'Contactos debe declarar su estado de carga inicial')
  assert.ok(initialLoadedMatch, 'Contactos debe distinguir la primera carga de los refresh posteriores')
  assert.match(
    contactsSource,
    /if \(loading && !hasLoadedContacts\)\s*{[\s\S]*?<PageHeader[\s\S]*?title="Contactos"[\s\S]*?<Loading message="Cargando contactos\.\.\."/,
    'Contactos debe pintar su cabecera antes de esperar la primera página'
  )
  assert.equal((contactsSource.match(/tableId="contacts_v2"/g) || []).length, 1)
  assert.match(tableSource, /useTableConfig\(tableId \|\| 'default'\)/)
  assert.match(appConfigSource, /const key = `table_\$\{tableId\}`/)
  assert.match(appConfigSource, /getAppConfigValues\(\[key\]\)/)
  assert.match(appConfigServiceSource, /new URLSearchParams\(\{ keys: normalizedKeys\.join\(','\) \}\)/)
  assert.match(appConfigServiceSource, /fetch\(apiUrl\(`\/api\/config\?\$\{params\.toString\(\)\}`\)/)

  const lifecycle = [
    {
      loading: initialLoadingMatch[1] === 'true',
      hasLoadedContacts: initialLoadedMatch[1] === 'true'
    },
    { loading: true, hasLoadedContacts: false },
    { loading: false, hasLoadedContacts: true }
  ]
  let tableMounted = false
  let tableConfigReads = 0

  for (const state of lifecycle) {
    const nextTableMounted = !(state.loading && !state.hasLoadedContacts)
    if (nextTableMounted && !tableMounted) tableConfigReads += 1
    tableMounted = nextTableMounted
  }

  assert.equal(
    tableConfigReads,
    1,
    'la tabla no debe montar, desmontar y repetir GET /api/config?keys=table_contacts_v2'
  )
})

test('Magnetismo reutiliza la navegación al sincronizar la ruta del iframe', async () => {
  const page = await repoFile('frontend/src/pages/MDPProgram/MDPProgram.tsx')
  const navigationEffect = page.slice(
    page.indexOf('React.useEffect(() => {\n    if (navigation)'),
    page.indexOf('React.useEffect(() => {\n    if (!launchItem?.launchUrl)')
  )

  assert.match(navigationEffect, /if \(navigation\) \{[\s\S]*setLaunchItem\(selectItem\(navigation\.items \|\| \[\], requestedItemId\)\)[\s\S]*return/)
  assert.equal(
    (navigationEffect.match(/void load\(requestedItemId\)/g) || []).length,
    1,
    'la navegación remota sólo debe consultarse cuando todavía no existe snapshot local'
  )
  assert.match(navigationEffect, /\[requestedItemId, load, navigation\]/)
})
