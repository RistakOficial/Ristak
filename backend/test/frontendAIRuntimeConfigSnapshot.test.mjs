import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const requireFromFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url))
const typescript = requireFromFrontend('typescript')
let moduleSequence = 0

async function importAIRuntimeService(testEnvironment) {
  const [source, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    readFile(new URL('../../frontend/src/services/aiRuntimeService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/sharedRequest.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/requestTimeout.ts', import.meta.url), 'utf8')
  ])
  const compile = (input) => typescript.transpileModule(input, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText

  moduleSequence += 1
  const [sharedRequest, requestTimeout] = await Promise.all([
    import(`data:text/javascript;base64,${Buffer.from(compile(sharedRequestSource)).toString('base64')}#shared-${moduleSequence}`),
    import(`data:text/javascript;base64,${Buffer.from(compile(requestTimeoutSource)).toString('base64')}#timeout-${moduleSequence}`)
  ])
  Object.assign(testEnvironment, sharedRequest, requestTimeout)

  globalThis.__ristakAIRuntimeConfigTestEnvironment = testEnvironment
  let compiled = compile(source)
    .replace(
      /^import \{ apiUrl \} from '\.\/apiBaseUrl';$/m,
      'const { apiUrl } = globalThis.__ristakAIRuntimeConfigTestEnvironment;'
    )
    .replace(
      /^import \{ getAuthScopedCacheRevision, registerAuthScopedCacheInvalidator, syncAuthScopedCachePrincipal \} from '\.\/authPrincipalCache';$/m,
      'const { getAuthScopedCacheRevision, registerAuthScopedCacheInvalidator, syncAuthScopedCachePrincipal } = globalThis.__ristakAIRuntimeConfigTestEnvironment;'
    )
    .replace(
      /^import \{ withRequestTimeout \} from '\.\/requestTimeout';$/m,
      'const { withRequestTimeout } = globalThis.__ristakAIRuntimeConfigTestEnvironment;'
    )
    .replace(
      /^import \{ abortAndClearSharedRequests, getOrCreateSharedRequest \} from '\.\/sharedRequest';$/m,
      'const { abortAndClearSharedRequests, getOrCreateSharedRequest } = globalThis.__ristakAIRuntimeConfigTestEnvironment;'
    )

  moduleSequence += 1
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#runtime-${moduleSequence}`)
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data })
  }
}

function errorResponse(message, status = 503) {
  return {
    ok: false,
    status,
    json: async () => ({ error: message })
  }
}

function createStatus(label, configured = true) {
  return {
    configured,
    businessProfile: {
      configured: true,
      businessName: label
    }
  }
}

function createTestEnvironment(accountState, invalidators) {
  return {
    apiUrl: (path) => path,
    getAuthScopedCacheRevision: () => accountState.revision,
    registerAuthScopedCacheInvalidator: (invalidator) => {
      invalidators.add(invalidator)
      return () => invalidators.delete(invalidator)
    },
    syncAuthScopedCachePrincipal: () => false
  }
}

test('la configuración compartida de IA deduplica lecturas, cambia de cuenta y permite reintentar', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const invalidators = new Set()
  const accountState = { principal: 'account-a', revision: 0, token: 'token-a' }
  const calls = []
  let failNextGet = false

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      principal: accountState.principal,
      authorization: options.headers?.Authorization
    })
    if (failNextGet) {
      failNextGet = false
      return errorResponse('fallo temporal')
    }
    return jsonResponse(createStatus(accountState.principal))
  }

  try {
    const environment = createTestEnvironment(accountState, invalidators)
    const { aiRuntimeService } = await importAIRuntimeService(environment)
    const [first, second] = await Promise.all([
      aiRuntimeService.getConfig(),
      aiRuntimeService.getConfig()
    ])

    assert.equal(first.businessProfile.businessName, 'account-a')
    assert.equal(second.businessProfile.businessName, 'account-a')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/ai-runtime/config')
    assert.equal(calls[0].authorization, 'Bearer token-a')
    assert.equal((await aiRuntimeService.getConfig()).businessProfile.businessName, 'account-a')
    assert.equal(calls.length, 1)

    accountState.principal = 'account-b'
    accountState.revision += 1
    accountState.token = 'token-b'
    invalidators.forEach((invalidate) => invalidate())

    const [accountBFirst, accountBSecond] = await Promise.all([
      aiRuntimeService.getConfig(),
      aiRuntimeService.getConfig()
    ])
    assert.equal(accountBFirst.businessProfile.businessName, 'account-b')
    assert.equal(accountBSecond.businessProfile.businessName, 'account-b')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].authorization, 'Bearer token-b')

    accountState.principal = 'account-c'
    accountState.revision += 1
    accountState.token = 'token-c'
    invalidators.forEach((invalidate) => invalidate())
    failNextGet = true

    await assert.rejects(aiRuntimeService.getConfig(), /fallo temporal/)
    assert.equal((await aiRuntimeService.getConfig()).businessProfile.businessName, 'account-c')
    assert.equal(calls.length, 4, 'un error no debe quedar cacheado')
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    delete globalThis.__ristakAIRuntimeConfigTestEnvironment
  }
})

test('cancelar consumidores aborta el transporte sólo cuando ya no queda ningún dueño', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const invalidators = new Set()
  const accountState = { revision: 0, token: 'token-a' }
  let transportSignal
  let fetchCalls = 0

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.fetch = (_url, options = {}) => {
    fetchCalls += 1
    transportSignal = options.signal
    if (fetchCalls > 1) return Promise.resolve(jsonResponse(createStatus('retry')))
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }

  try {
    const { aiRuntimeService } = await importAIRuntimeService(
      createTestEnvironment(accountState, invalidators)
    )
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = aiRuntimeService.getConfig({ signal: firstController.signal })
    const second = aiRuntimeService.getConfig({ signal: secondController.signal })
    assert.equal(fetchCalls, 1)

    const firstRejection = assert.rejects(first, (error) => error?.name === 'AbortError')
    firstController.abort()
    await firstRejection
    assert.equal(transportSignal.aborted, false)

    const secondRejection = assert.rejects(second, (error) => error?.name === 'AbortError')
    secondController.abort()
    await secondRejection
    await new Promise((resolve) => queueMicrotask(resolve))
    assert.equal(transportSignal.aborted, true)

    assert.equal((await aiRuntimeService.getConfig()).businessProfile.businessName, 'retry')
    assert.equal(fetchCalls, 2)
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    delete globalThis.__ristakAIRuntimeConfigTestEnvironment
  }
})

test('guardar el perfil publica el snapshot nuevo sin releer datos obsoletos', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  const invalidators = new Set()
  const accountState = { revision: 0, token: 'token-a' }
  const calls = []
  const events = []

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.window = {
    dispatchEvent: (event) => {
      events.push(event.type)
      return true
    }
  }
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null
    })
    if (options.method === 'PUT') {
      return jsonResponse({
        ...createStatus('Clínica Horizonte'),
        businessContext: 'Clínica Horizonte atiende de lunes a sábado.'
      })
    }
    return jsonResponse({
      ...createStatus('Perfil anterior'),
      businessContext: 'Perfil anterior'
    })
  }

  try {
    const { aiRuntimeService, AI_RUNTIME_CONFIG_CHANGED_EVENT } = await importAIRuntimeService(
      createTestEnvironment(accountState, invalidators)
    )

    assert.equal((await aiRuntimeService.getConfig()).businessContext, 'Perfil anterior')
    const saved = await aiRuntimeService.saveBusinessProfile('Clínica Horizonte atiende de lunes a sábado.')

    assert.equal(saved.businessContext, 'Clínica Horizonte atiende de lunes a sábado.')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], {
      url: '/api/ai-runtime/business-profile',
      method: 'PUT',
      body: { businessContext: 'Clínica Horizonte atiende de lunes a sábado.' }
    })
    assert.equal((await aiRuntimeService.getConfig()).businessContext, saved.businessContext)
    assert.equal(calls.length, 2, 'la lectura posterior debe reutilizar el snapshot confirmado')
    assert.deepEqual(events, [AI_RUNTIME_CONFIG_CHANGED_EVENT])
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    globalThis.window = previousWindow
    delete globalThis.__ristakAIRuntimeConfigTestEnvironment
  }
})
