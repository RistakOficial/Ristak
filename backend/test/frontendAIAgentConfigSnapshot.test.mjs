import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const requireFromFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url))
const typescript = requireFromFrontend('typescript')
let moduleSequence = 0

async function importAIAgentService(testEnvironment) {
  const [source, sharedRequestSource, requestTimeoutSource] = await Promise.all([
    readFile(new URL('../../frontend/src/services/aiAgentService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/sharedRequest.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/requestTimeout.ts', import.meta.url), 'utf8')
  ])
  const compiledSharedRequest = typescript.transpileModule(sharedRequestSource, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText
  const compiledRequestTimeout = typescript.transpileModule(requestTimeoutSource, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText
  moduleSequence += 1
  const [sharedRequest, requestTimeout] = await Promise.all([
    import(`data:text/javascript;base64,${Buffer.from(compiledSharedRequest).toString('base64')}#shared-${moduleSequence}`),
    import(`data:text/javascript;base64,${Buffer.from(compiledRequestTimeout).toString('base64')}#timeout-${moduleSequence}`)
  ])
  Object.assign(testEnvironment, sharedRequest, requestTimeout)

  let compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText

  globalThis.__ristakAIAgentConfigTestEnvironment = testEnvironment
  compiled = compiled
    .replace(
      /^import \{ apiUrl \} from '\.\/apiBaseUrl';$/m,
      'const { apiUrl } = globalThis.__ristakAIAgentConfigTestEnvironment;'
    )
    .replace(
      /^import \{ getAuthScopedCacheRevision, registerAuthScopedCacheInvalidator, syncAuthScopedCachePrincipal \} from '\.\/authPrincipalCache';$/m,
      'const { getAuthScopedCacheRevision, registerAuthScopedCacheInvalidator, syncAuthScopedCachePrincipal } = globalThis.__ristakAIAgentConfigTestEnvironment;'
    )
    .replace(
      /^import \{ refreshIntegrationsStatusAfter \} from '\.\/integrationsService';$/m,
      'const { refreshIntegrationsStatusAfter } = globalThis.__ristakAIAgentConfigTestEnvironment;'
    )
    .replace(
      /^import \{ withRequestTimeout \} from '\.\/requestTimeout';$/m,
      'const { withRequestTimeout } = globalThis.__ristakAIAgentConfigTestEnvironment;'
    )
    .replace(
      /^import \{ abortAndClearSharedRequests, getOrCreateSharedRequest \} from '\.\/sharedRequest';$/m,
      'const { abortAndClearSharedRequests, getOrCreateSharedRequest } = globalThis.__ristakAIAgentConfigTestEnvironment;'
    )

  moduleSequence += 1
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${moduleSequence}`)
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

function createStatus(model, configured = true) {
  return {
    configured,
    model,
    tokenPreview: configured ? 'sk-...test' : null,
    businessContext: '',
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: '',
    actionCustomizations: '',
    researchDomains: '',
    responseStyle: 'advisor',
    recommendationMode: 'when_useful',
    webSearchEnabled: true,
    updatedAt: '2026-07-15T00:00:00.000Z'
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
    syncAuthScopedCachePrincipal: () => false,
    refreshIntegrationsStatusAfter: async (mutation) => mutation
  }
}

test('la configuración del agente comparte una red y conserva coherencia tras mutar y cambiar de cuenta', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const invalidators = new Set()
  const accountState = { principal: 'account-a', revision: 0, token: 'token-a' }
  const calls = []
  let failNextGet = false
  let failNextMutation = false
  const statuses = {
    'account-a': createStatus('model-a'),
    'account-b': createStatus('model-b'),
    'account-c': createStatus('model-c')
  }

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET'
    calls.push({ url: String(url), method, principal: accountState.principal })
    if (method === 'GET' && failNextGet) {
      failNextGet = false
      return errorResponse('fallo temporal')
    }
    if (method !== 'GET' && failNextMutation) {
      failNextMutation = false
      return errorResponse('mutación rechazada')
    }
    if (method === 'DELETE' && String(url).endsWith('/config')) {
      statuses[accountState.principal] = createStatus('model-a-deleted', false)
    } else if (method === 'POST') {
      statuses[accountState.principal] = createStatus('model-a-mutated')
    }
    return jsonResponse(statuses[accountState.principal])
  }

  try {
    const environment = createTestEnvironment(accountState, invalidators)
    const { aiAgentService } = await importAIAgentService(environment)

    const [first, second] = await Promise.all([
      aiAgentService.getConfig(),
      aiAgentService.getConfig()
    ])
    assert.equal(first.model, 'model-a')
    assert.equal(second.model, 'model-a')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1)

    assert.equal((await aiAgentService.getConfig()).model, 'model-a')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1, 'el segundo dueño debe usar el snapshot especializado')

    failNextMutation = true
    await assert.rejects(aiAgentService.saveConfig({}), /mutación rechazada/)
    assert.equal((await aiAgentService.getConfig()).model, 'model-a')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1, 'una mutación fallida debe conservar el último snapshot confirmado')

    const mutated = await aiAgentService.saveConfig({})
    assert.equal(mutated.model, 'model-a-mutated')
    assert.equal((await aiAgentService.getConfig()).model, 'model-a-mutated')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1, 'una mutación confirmada debe publicar su respuesta sin otro GET')

    failNextMutation = true
    await assert.rejects(aiAgentService.deleteConfig(), /mutación rechazada/)
    assert.equal((await aiAgentService.getConfig()).model, 'model-a-mutated')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1, 'un DELETE fallido tampoco debe borrar el snapshot confirmado')

    await aiAgentService.deleteConfig()
    const deleted = await aiAgentService.getConfig()
    assert.equal(deleted.configured, false)
    assert.equal(calls.filter((call) => call.method === 'GET').length, 2, 'un DELETE exitoso sí debe obligar a leer el estado borrado')

    accountState.principal = 'account-b'
    accountState.revision += 1
    accountState.token = 'token-b'
    invalidators.forEach((invalidate) => invalidate())

    const [accountBFirst, accountBSecond] = await Promise.all([
      aiAgentService.getConfig(),
      aiAgentService.getConfig()
    ])
    assert.equal(accountBFirst.model, 'model-b')
    assert.equal(accountBSecond.model, 'model-b')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 3, 'la cuenta nueva abre una sola red propia')

    accountState.principal = 'account-c'
    accountState.revision += 1
    accountState.token = 'token-c'
    invalidators.forEach((invalidate) => invalidate())
    failNextGet = true
    await assert.rejects(aiAgentService.getConfig(), /fallo temporal/)
    assert.equal((await aiAgentService.getConfig()).model, 'model-c')
    assert.equal(calls.filter((call) => call.method === 'GET').length, 5, 'un error no debe quedar cacheado')
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    delete globalThis.__ristakAIAgentConfigTestEnvironment
  }
})

test('cancelar un consumidor no tumba el transporte compartido mientras quede otro dueño', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const invalidators = new Set()
  const accountState = { principal: 'account-a', revision: 0, token: 'token-a' }
  let transportSignal
  let fetchCalls = 0

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.fetch = (_url, options = {}) => {
    fetchCalls += 1
    transportSignal = options.signal
    if (fetchCalls > 1) return Promise.resolve(jsonResponse(createStatus('retry-model')))
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }

  try {
    const { aiAgentService } = await importAIAgentService(createTestEnvironment(accountState, invalidators))
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = aiAgentService.getConfig({ signal: firstController.signal })
    const second = aiAgentService.getConfig({ signal: secondController.signal })
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

    assert.equal((await aiAgentService.getConfig()).model, 'retry-model')
    assert.equal(fetchCalls, 2)
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    delete globalThis.__ristakAIAgentConfigTestEnvironment
  }
})

test('el GET compartido vence a los 20 segundos, aborta transporte y permite retry limpio', async () => {
  const previousFetch = globalThis.fetch
  const previousLocalStorage = globalThis.localStorage
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  const invalidators = new Set()
  const accountState = { principal: 'account-a', revision: 0, token: 'token-a' }
  let fetchCalls = 0
  let timeoutCalls = 0
  let requestedTimeoutMs = 0
  let firstTransportSignal

  globalThis.localStorage = {
    getItem: (key) => key === 'auth_token' ? accountState.token : null
  }
  globalThis.fetch = (_url, options = {}) => {
    fetchCalls += 1
    if (fetchCalls > 1) return Promise.resolve(jsonResponse(createStatus('retry-after-timeout')))
    firstTransportSignal = options.signal
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }

  try {
    const { aiAgentService } = await importAIAgentService(createTestEnvironment(accountState, invalidators))
    globalThis.setTimeout = (callback, timeoutMs) => {
      timeoutCalls += 1
      requestedTimeoutMs = timeoutMs
      if (timeoutCalls === 1) queueMicrotask(callback)
      return timeoutCalls
    }
    globalThis.clearTimeout = () => undefined

    await assert.rejects(
      aiAgentService.getConfig(),
      (error) => error?.name === 'RequestTimeoutError'
    )
    assert.equal(requestedTimeoutMs, 20_000)
    assert.equal(firstTransportSignal.aborted, true)

    assert.equal((await aiAgentService.getConfig()).model, 'retry-after-timeout')
    assert.equal(fetchCalls, 2, 'el timeout no debe quedar cacheado ni bloquear el siguiente intento')
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousLocalStorage
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
    delete globalThis.__ristakAIAgentConfigTestEnvironment
  }
})
