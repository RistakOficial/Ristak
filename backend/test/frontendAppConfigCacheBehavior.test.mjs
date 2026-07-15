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

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init
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

async function importAppConfigServiceModule() {
  const [serviceSource, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    repoFile('frontend/src/services/appConfigService.ts'),
    repoFile('frontend/src/services/sharedRequest.ts'),
    repoFile('frontend/src/services/requestTimeout.ts')
  ])

  return importTypeScriptSource(`${`
    const apiUrl = path => path
    const getAuthScopedCacheRevision = () => globalThis.__ristakConfigTestAuthRevision || 0
    const syncAuthScopedCachePrincipal = () => false
    const registerAuthScopedCacheInvalidator = invalidator => {
      globalThis.__ristakConfigTestAuthInvalidators.push(invalidator)
      return () => undefined
    }
    const registerRistakApiReadCacheInvalidator = (invalidator, options) => {
      globalThis.__ristakConfigTestApiInvalidators.push({ invalidator, options })
      return () => undefined
    }
  `}\n${stripImports(sharedRequestSource)}\n${stripImports(requestTimeoutSource)}\n${stripImports(serviceSource)}`, 'appConfigService.behavior.ts')
}

async function importUseAppConfigModule() {
  const hookSource = await repoFile('frontend/src/hooks/useAppConfig.ts')
  return importTypeScriptSource(`${`
    const useState = initialValue => [
      typeof initialValue === 'function' ? initialValue() : initialValue,
      () => undefined
    ]
    const useEffect = () => undefined
    const useCallback = callback => callback
    const useRef = initialValue => ({ current: initialValue })
    const apiUrl = path => path
    const getAppConfigValues = () => Promise.resolve({})
    const clearAppConfigReadCache = () => {
      globalThis.__ristakConfigHookTestInvalidations += 1
    }
  `}\n${stripImports(hookSource)}`, 'useAppConfig.behavior.ts')
}

async function withAppConfigService(fetchImpl, run) {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const previousAuthRevision = globalThis.__ristakConfigTestAuthRevision
  const previousAuthInvalidators = globalThis.__ristakConfigTestAuthInvalidators
  const previousApiInvalidators = globalThis.__ristakConfigTestApiInvalidators
  const storage = new Map([['auth_token', 'principal-a']])

  globalThis.fetch = fetchImpl
  globalThis.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  }
  globalThis.__ristakConfigTestAuthRevision = 0
  globalThis.__ristakConfigTestAuthInvalidators = []
  globalThis.__ristakConfigTestApiInvalidators = []

  try {
    const service = await importAppConfigServiceModule()
    return await run(service, {
      authInvalidators: globalThis.__ristakConfigTestAuthInvalidators,
      apiInvalidators: globalThis.__ristakConfigTestApiInvalidators,
      storage
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousLocalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousLocalStorage
    if (previousAuthRevision === undefined) delete globalThis.__ristakConfigTestAuthRevision
    else globalThis.__ristakConfigTestAuthRevision = previousAuthRevision
    if (previousAuthInvalidators === undefined) delete globalThis.__ristakConfigTestAuthInvalidators
    else globalThis.__ristakConfigTestAuthInvalidators = previousAuthInvalidators
    if (previousApiInvalidators === undefined) delete globalThis.__ristakConfigTestApiInvalidators
    else globalThis.__ristakConfigTestApiInvalidators = previousApiInvalidators
  }
}

test('config comparte una sola lectura simultánea y reutiliza el JSON fresco', async () => {
  const networkResponse = deferred()
  const calls = []

  await withAppConfigService(
    (url, options) => {
      calls.push({ url, options })
      return networkResponse.promise
    },
    async ({ getAppConfigValues }, { apiInvalidators }) => {
      const first = getAppConfigValues(['table_transactions', 'account_currency'])
      const second = getAppConfigValues(['account_currency', 'table_transactions'])
      const third = getAppConfigValues([' table_transactions ', 'account_currency', 'account_currency'])

      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/api/config?keys=account_currency%2Ctable_transactions')
      assert.equal(calls[0].options.headers.Authorization, 'Bearer principal-a')
      assert.equal(apiInvalidators.length, 1)
      assert.deepEqual(apiInvalidators[0].options, { pathPrefixes: ['/api/config'] })

      const expected = {
        account_currency: 'MXN',
        table_transactions: '[{"id":"date","visible":true}]'
      }
      networkResponse.resolve(jsonResponse({ success: true, config: expected }))

      assert.deepEqual(await first, expected)
      assert.deepEqual(await second, expected)
      assert.deepEqual(await third, expected)
      assert.deepEqual(
        await getAppConfigValues(['account_currency', 'table_transactions']),
        expected
      )
      assert.equal(calls.length, 1, 'el snapshot fresco no repite red')
    }
  )
})

test('config invalida sólo su snapshot después de mutación o cambio de cuenta', async () => {
  let calls = 0

  await withAppConfigService(
    async () => {
      calls += 1
      return jsonResponse({ success: true, config: { account_currency: calls === 1 ? 'MXN' : calls === 2 ? 'USD' : 'EUR' } })
    },
    async ({ getAppConfigValues }, { authInvalidators, apiInvalidators, storage }) => {
      assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'MXN')
      assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'MXN')
      assert.equal(calls, 1)

      apiInvalidators[0].invalidator({ abortInflight: true })
      assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'USD')
      assert.equal(calls, 2)

      storage.set('auth_token', 'principal-b')
      globalThis.__ristakConfigTestAuthRevision += 1
      authInvalidators[0]()
      assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'EUR')
      assert.equal(calls, 3)
    }
  )
})

test('config no cachea errores ni respuestas tardías de la cuenta anterior', async () => {
  const oldPrincipalResponse = deferred()
  let calls = 0

  await withAppConfigService(
    async (_url, options) => {
      calls += 1
      if (calls === 1) {
        // Simula un transporte defectuoso que no honra AbortSignal. La revisión
        // de cuenta debe impedir que esa respuesta tardía pueble el snapshot.
        return oldPrincipalResponse.promise
      }
      if (calls === 2) return jsonResponse({ error: 'temporal' }, { status: 503 })
      return jsonResponse({ success: true, config: { account_currency: 'USD' } })
    },
    async ({ getAppConfigValues }, { authInvalidators, storage }) => {
      const oldRead = getAppConfigValues(['account_currency'])
      storage.set('auth_token', 'principal-b')
      globalThis.__ristakConfigTestAuthRevision += 1
      authInvalidators[0]()
      oldPrincipalResponse.resolve(jsonResponse({ success: true, config: { account_currency: 'MXN' } }))
      assert.equal((await oldRead).account_currency, 'MXN')

      await assert.rejects(
        getAppConfigValues(['account_currency']),
        /Failed to fetch config/
      )
      assert.equal(calls, 2)

      assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'USD')
      assert.equal(calls, 3, 'ni la respuesta vieja ni el 503 quedan cacheados')
    }
  )
})

test('invalidar config cancela la lectura compartida activa', async () => {
  let requestSignal

  await withAppConfigService(
    (_url, options) => {
      requestSignal = options.signal
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    },
    async ({ getAppConfigValues }, { apiInvalidators }) => {
      const request = getAppConfigValues(['table_contacts_v2'])
      apiInvalidators[0].invalidator({ abortInflight: true })

      await assert.rejects(request, error => error?.name === 'AbortError')
      assert.equal(requestSignal.aborted, true)
    }
  )
})

test('config corta un transporte colgado, no cachea el timeout y permite reintentar', async () => {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  let calls = 0
  let timedOutSignal

  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback)
    return 1
  }
  globalThis.clearTimeout = () => undefined

  try {
    await withAppConfigService(
      (_url, options) => {
        calls += 1
        if (calls > 1) {
          return Promise.resolve(jsonResponse({
            success: true,
            config: { account_currency: 'USD' }
          }))
        }
        timedOutSignal = options.signal
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      },
      async ({ getAppConfigValues }) => {
        await assert.rejects(
          getAppConfigValues(['account_currency']),
          error => error?.name === 'RequestTimeoutError'
        )
        assert.equal(timedOutSignal.aborted, true, 'el deadline debe abortar el fetch real')

        globalThis.setTimeout = previousSetTimeout
        globalThis.clearTimeout = previousClearTimeout
        assert.equal((await getAppConfigValues(['account_currency'])).account_currency, 'USD')
        assert.equal(calls, 2, 'el timeout no debe quedar compartido ni cacheado')
      }
    )
  } finally {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
  }
})

test('useAppConfig invalida el snapshot sólo después de guardar con éxito', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  const previousCustomEvent = globalThis.CustomEvent
  const previousInvalidations = globalThis.__ristakConfigHookTestInvalidations
  const storage = new Map([['auth_token', 'principal-a']])
  const dispatchedEvents = []
  let response = jsonResponse({ success: true })

  globalThis.__ristakConfigHookTestInvalidations = 0
  globalThis.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  }
  globalThis.window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: event => dispatchedEvents.push(event)
  }
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type
      this.detail = init.detail
    }
  }
  globalThis.fetch = async () => response

  try {
    const { useAppConfig } = await importUseAppConfigModule()
    const [, updateValue] = useAppConfig('account_currency', 'MXN')

    await updateValue('USD')
    assert.equal(globalThis.__ristakConfigHookTestInvalidations, 1)
    assert.equal(storage.get('rstk_config_account_currency'), '"USD"')
    assert.deepEqual(dispatchedEvents.map(event => ({ type: event.type, detail: event.detail })), [{
      type: 'config-sync',
      detail: { key: 'account_currency', value: 'USD' }
    }])

    response = jsonResponse({ error: 'temporal' }, { status: 503 })
    await assert.rejects(updateValue('EUR'), /Failed to save config/)
    assert.equal(
      globalThis.__ristakConfigHookTestInvalidations,
      1,
      'un POST fallido conserva el snapshot válido y permite reintentar'
    )
    assert.equal(storage.get('rstk_config_account_currency'), '"USD"')
  } finally {
    globalThis.fetch = previousFetch
    if (previousLocalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousLocalStorage
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent
    else globalThis.CustomEvent = previousCustomEvent
    if (previousInvalidations === undefined) delete globalThis.__ristakConfigHookTestInvalidations
    else globalThis.__ristakConfigHookTestInvalidations = previousInvalidations
  }
})
