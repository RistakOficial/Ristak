import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

if (process.env.DATABASE_URL) {
  throw new Error('sitesFormProgressRuntime.test.mjs solo puede ejecutarse con SQLite local; elimina DATABASE_URL.')
}
if (process.env.RISTAK_SQLITE_PATH) {
  throw new Error('sitesFormProgressRuntime.test.mjs exige la SQLite temporal de node:test; elimina RISTAK_SQLITE_PATH.')
}

const { databaseReady, db } = await import('../src/config/database.js')
const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
const { ingestSiteFlowEventBatch } = await import('../src/services/siteFlowEventsService.js')

await databaseReady

const SITE_ID = 'site_form_progress_runtime'
const PAGE_ID = 'page_runtime'
const FIELD_ID = 'field_runtime'

const runtimeSite = {
  id: SITE_ID,
  name: 'Formulario runtime',
  title: 'Formulario runtime',
  description: '',
  slug: 'formulario-runtime',
  siteType: 'interactive_form',
  status: 'published',
  theme: {
    pages: [
      { id: PAGE_ID, title: 'Pregunta', sortOrder: 0 }
    ]
  },
  blocks: [
    {
      id: FIELD_ID,
      siteId: SITE_ID,
      blockType: 'short_text',
      label: 'Respuesta',
      content: '',
      placeholder: '',
      required: true,
      options: [],
      sortOrder: 0,
      settings: { pageId: PAGE_ID }
    }
  ]
}

let renderedHtmlPromise = null

async function renderedHtml() {
  if (!renderedHtmlPromise) {
    renderedHtmlPromise = renderPublicSiteHtml(runtimeSite, {
      pageId: PAGE_ID,
      trackingEnabled: true,
      preview: false
    })
  }
  return renderedHtmlPromise
}

async function trackingRuntimeSource() {
  const html = await renderedHtml()
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(script => script.includes("const FLOW_ENDPOINT = '/api/sites/public/form-progress'"))
  assert.ok(source, 'el HTML público debe incluir el runtime de progreso')
  return source
}

class MemoryStorage {
  constructor() {
    this.values = new Map()
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null
  }

  setItem(key, value) {
    this.values.set(String(key), String(value))
  }

  removeItem(key) {
    this.values.delete(String(key))
  }
}

function runtimeHarness(source, {
  sessionStorage = new MemoryStorage(),
  localStorage = new MemoryStorage(),
  fetchImpl = async () => ({ ok: true })
} = {}) {
  const timers = []
  const listeners = new Map()
  const fetchCalls = []
  let clock = Date.UTC(2026, 6, 30, 6, 0, 0)
  let uuidCounter = 0

  class ControlledDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]))
    }

    static now() {
      return clock
    }
  }

  const rememberListener = (scope, name, listener) => {
    const key = `${scope}:${name}`
    const current = listeners.get(key) || []
    current.push(listener)
    listeners.set(key, current)
  }
  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    cookie: '',
    referrer: '',
    title: 'Formulario runtime',
    head: {
      appendChild(node) {
        if (typeof node.onerror === 'function') node.onerror()
      }
    },
    documentElement: {
      appendChild(node) {
        if (typeof node.onerror === 'function') node.onerror()
      }
    },
    createElement() {
      return {}
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
    addEventListener(name, listener) {
      rememberListener('document', name, listener)
    }
  }
  const location = {
    search: '',
    href: 'https://example.test/formulario-runtime',
    protocol: 'https:',
    host: 'example.test',
    hostname: 'example.test',
    pathname: '/formulario-runtime',
    hash: ''
  }
  const sandbox = {
    Blob,
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type
      }
    },
    Date: ControlledDate,
    Intl,
    Math,
    Promise,
    Set,
    URL,
    URLSearchParams,
    console,
    crypto: {
      randomUUID() {
        uuidCounter += 1
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
      }
    },
    document,
    fetch(...args) {
      fetchCalls.push(args)
      return fetchImpl(...args)
    },
    localStorage,
    location,
    navigator: {
      language: 'es-MX',
      userLanguage: 'es-MX',
      userAgent: 'Ristak runtime test',
      sendBeacon() {
        return false
      }
    },
    screen: { width: 1280 },
    sessionStorage,
    setTimeout(callback, delay = 0) {
      const timer = {
        callback,
        delay: Number(delay) || 0,
        cancelled: false
      }
      timers.push(timer)
      return timers.length
    },
    clearTimeout(timerId) {
      const timer = timers[Number(timerId) - 1]
      if (timer) timer.cancelled = true
    }
  }

  sandbox.window = sandbox
  sandbox.history = {
    pushState() {},
    replaceState() {}
  }
  sandbox.addEventListener = (name, listener) => {
    rememberListener('window', name, listener)
  }
  sandbox.dispatchEvent = () => true

  vm.runInNewContext(source, sandbox)

  return {
    fetchCalls,
    localStorage,
    sandbox,
    sessionStorage,
    timers,
    advance(ms) {
      clock += Number(ms) || 0
    },
    async runNextTimer() {
      let timer = null
      while (timers.length && !timer) {
        const candidate = timers.shift()
        if (!candidate.cancelled) timer = candidate
      }
      assert.ok(timer, 'se esperaba un reintento pendiente')
      timer.callback()
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      return timer.delay
    }
  }
}

function flowContext(overrides = {}) {
  return {
    formSiteId: SITE_ID,
    flowRevision: 'revision_runtime_12345678',
    stepId: PAGE_ID,
    stepIndex: 1,
    stepTotal: 1,
    stepKind: 'form_page',
    ...overrides
  }
}

function readQueue(storage) {
  const raw = storage.getItem(`rstk:flow::queue:${SITE_ID}`)
  return raw ? JSON.parse(raw).items : []
}

function findAttemptState(storage, flowRevision) {
  const suffix = `:${SITE_ID}:${flowRevision}`
  const entry = [...storage.values.entries()].find(([key]) => (
    key.startsWith(`rstk:flow::${SITE_ID}:`) && key.endsWith(suffix)
  ))
  assert.ok(entry, `se esperaba el estado para ${flowRevision}`)
  return {
    key: entry[0],
    value: JSON.parse(entry[1])
  }
}

test('progress runtime deduplicates fields and never revives a completed or expired attempt by reading/rendering', async () => {
  const source = await trackingRuntimeSource()
  const neverResolve = () => new Promise(() => {})
  const harness = runtimeHarness(source, { fetchImpl: neverResolve })
  const { sandbox, sessionStorage } = harness
  const context = flowContext()

  const firstIdentity = sandbox.ristakFormProgressTrack('step_view', context)
  const answeredIdentity = sandbox.ristakFormProgressTrack('field_answered', {
    ...context,
    fieldId: FIELD_ID,
    responseValue: 'ESTO JAMÁS DEBE SALIR DEL NAVEGADOR'
  })
  const duplicateIdentity = sandbox.ristakFormProgressTrack('field_answered', {
    ...context,
    fieldId: FIELD_ID,
    responseValue: 'OTRO VALOR PRIVADO'
  })

  assert.equal(firstIdentity.eventSequence, 2)
  assert.equal(answeredIdentity.eventSequence, 3)
  assert.equal(duplicateIdentity.eventSequence, 3)
  assert.deepEqual(
    readQueue(sessionStorage).map(item => item.event.eventName),
    ['attempt_start', 'step_view', 'field_answered']
  )
  assert.doesNotMatch(
    JSON.stringify(readQueue(sessionStorage)),
    /ESTO JAMÁS|OTRO VALOR|responseValue/
  )

  const activeState = findAttemptState(sessionStorage, context.flowRevision)
  const expiredState = {
    ...activeState.value,
    lastActivity: ControlledEpoch.expired
  }
  sessionStorage.setItem(activeState.key, JSON.stringify(expiredState))
  const storedBeforeRead = sessionStorage.getItem(activeState.key)
  assert.equal(sandbox.ristakFormProgressIdentity(context), null)
  assert.equal(
    sessionStorage.getItem(activeState.key),
    storedBeforeRead,
    'consultar identidad no debe tocar ni reabrir un intento vencido'
  )

  const terminalContext = flowContext({ flowRevision: 'revision_terminal_123456' })
  const terminalIdentity = sandbox.ristakFormProgressTrack('step_view', terminalContext)
  assert.ok(terminalIdentity)
  assert.equal(sandbox.ristakFormProgressFinish(terminalContext)?.attemptId, terminalIdentity.attemptId)
  assert.equal(sandbox.ristakFormProgressIdentity(terminalContext), null)
  const completedState = findAttemptState(sessionStorage, terminalContext.flowRevision)
  const queueSizeAfterFinish = readQueue(sessionStorage).length

  assert.equal(
    sandbox.ristakFormProgressTrack('step_view', terminalContext),
    null,
    'un render automático posterior al submit no debe crear un intento fantasma'
  )
  assert.equal(findAttemptState(sessionStorage, terminalContext.flowRevision).value.attemptId, completedState.value.attemptId)
  assert.equal(readQueue(sessionStorage).length, queueSizeAfterFinish)

  assert.equal(
    sandbox.ristakFormProgressTrack('field_answered', {
      ...terminalContext,
      fieldId: FIELD_ID,
      allowNewAttempt: false
    }),
    null,
    'el prefill programático posterior al reset no debe abrir otro intento'
  )
  assert.equal(readQueue(sessionStorage).length, queueSizeAfterFinish)

  const explicitNewAttempt = sandbox.ristakFormProgressTrack('field_answered', {
    ...terminalContext,
    fieldId: FIELD_ID,
    allowNewAttempt: true
  })
  assert.notEqual(explicitNewAttempt.attemptId, completedState.value.attemptId)
  assert.deepEqual(
    readQueue(sessionStorage)
      .filter(item => item.attemptId === explicitNewAttempt.attemptId)
      .map(item => item.event.eventName),
    ['attempt_start', 'step_view', 'field_answered'],
    'una interacción real sí abre otro intento y registra que alcanzó la etapa'
  )
})

const ControlledEpoch = {
  expired: Date.UTC(2026, 6, 30, 5, 0, 0)
}

test('progress runtime preserves real revisits and distinct branches without duplicate renders', async () => {
  const source = await trackingRuntimeSource()
  const harness = runtimeHarness(source, { fetchImpl: () => new Promise(() => {}) })
  const context = flowContext({ flowRevision: 'revision_navigation_12345' })
  const { sandbox, sessionStorage } = harness

  const firstView = sandbox.ristakFormProgressTrack('step_view', {
    ...context,
    stepId: 'step_a'
  })
  const duplicateRender = sandbox.ristakFormProgressTrack('step_view', {
    ...context,
    stepId: 'step_a'
  })
  sandbox.ristakFormProgressTrack('step_complete', {
    ...context,
    stepId: 'step_a',
    targetStepId: 'step_b'
  })
  sandbox.ristakFormProgressTrack('step_view', {
    ...context,
    stepId: 'step_b'
  })
  sandbox.ristakFormProgressTrack('step_view', {
    ...context,
    stepId: 'step_a'
  })
  const alternateBranch = sandbox.ristakFormProgressTrack('step_complete', {
    ...context,
    stepId: 'step_a',
    targetStepId: 'step_c'
  })

  assert.equal(duplicateRender.eventSequence, firstView.eventSequence)
  assert.equal(alternateBranch.eventSequence, 6)
  assert.deepEqual(
    readQueue(sessionStorage).map(item => ({
      name: item.event.eventName,
      step: item.event.stepId,
      target: item.event.targetStepId
    })),
    [
      { name: 'attempt_start', step: 'step_a', target: '' },
      { name: 'step_view', step: 'step_a', target: '' },
      { name: 'step_complete', step: 'step_a', target: 'step_b' },
      { name: 'step_view', step: 'step_b', target: '' },
      { name: 'step_view', step: 'step_a', target: '' },
      { name: 'step_complete', step: 'step_a', target: 'step_c' }
    ]
  )
})

test('offline A to B to A navigation flushes contiguous batches that ingest in sequence', async () => {
  const source = await trackingRuntimeSource()
  const sharedSessionStorage = new MemoryStorage()
  const sharedLocalStorage = new MemoryStorage()
  const offlineHarness = runtimeHarness(source, {
    sessionStorage: sharedSessionStorage,
    localStorage: sharedLocalStorage,
    fetchImpl: () => new Promise(() => {})
  })
  const revision = 'revision_cross_page_queue_1234'
  const pageAContext = flowContext({
    flowRevision: revision,
    formContextToken: 'token-page-a',
    stepId: PAGE_ID,
    stepIndex: 1,
    stepTotal: 2
  })
  const pageBContext = flowContext({
    flowRevision: revision,
    formContextToken: 'token-page-b',
    stepId: 'step_b',
    stepIndex: 2,
    stepTotal: 2
  })

  offlineHarness.sandbox.ristakFormProgressTrack('step_view', pageAContext)
  offlineHarness.sandbox.ristakFormProgressTrack('field_answered', {
    ...pageBContext,
    fieldId: FIELD_ID
  })
  offlineHarness.sandbox.ristakFormProgressTrack('step_view', pageAContext)
  assert.deepEqual(
    readQueue(sharedSessionStorage).map(item => item.event.eventSequence),
    [1, 2, 3, 4, 5]
  )

  const reloadedHarness = runtimeHarness(source, {
    sessionStorage: sharedSessionStorage,
    localStorage: sharedLocalStorage,
    fetchImpl: async () => ({ ok: true, status: 202 })
  })
  await reloadedHarness.runNextTimer()
  await reloadedHarness.runNextTimer()
  await reloadedHarness.runNextTimer()

  const payloads = reloadedHarness.fetchCalls.map(call => JSON.parse(call[1].body))
  assert.deepEqual(
    payloads.map(payload => payload.events.map(event => event.eventSequence)),
    [[1, 2], [3, 4], [5]]
  )
  assert.deepEqual(
    payloads.map(payload => payload.formContextToken),
    ['token-page-a', 'token-page-b', 'token-page-a']
  )

  const attemptId = payloads[0].attemptId
  try {
    for (const payload of payloads) {
      await ingestSiteFlowEventBatch({
        body: {
          attemptId: payload.attemptId,
          events: payload.events
        },
        context: {
          siteId: SITE_ID,
          formSiteId: SITE_ID,
          publicPageId: payload.formContextToken === 'token-page-b'
            ? 'public_page_b'
            : 'public_page_a',
          flowRevision: revision,
          validStepIds: [PAGE_ID, 'step_b'],
          validFieldIds: [FIELD_ID],
          visitorId: payload.visitorId,
          sessionId: payload.sessionId,
          receivedAt: new Date()
        }
      })
    }

    const persisted = await db.all(`
      SELECT event_sequence, public_page_id
      FROM site_flow_events
      WHERE attempt_id = ?
      ORDER BY event_sequence ASC
    `, [attemptId])
    assert.deepEqual(
      persisted.map(row => [Number(row.event_sequence), row.public_page_id]),
      [
        [1, 'public_page_a'],
        [2, 'public_page_a'],
        [3, 'public_page_b'],
        [4, 'public_page_b'],
        [5, 'public_page_a']
      ]
    )
  } finally {
    await db.run(
      'DELETE FROM site_flow_events WHERE attempt_id = ?',
      [attemptId]
    )
  }
})

test('progress queue survives a reload, retries and sends deterministic batches of at most 50 events', async () => {
  const source = await trackingRuntimeSource()
  const sharedSessionStorage = new MemoryStorage()
  const sharedLocalStorage = new MemoryStorage()
  const firstHarness = runtimeHarness(source, {
    sessionStorage: sharedSessionStorage,
    localStorage: sharedLocalStorage,
    fetchImpl: async () => {
      throw new Error('red temporalmente caída')
    }
  })
  const context = flowContext({ flowRevision: 'revision_queue_123456789' })

  for (let index = 0; index < 60; index += 1) {
    firstHarness.sandbox.ristakFormProgressTrack('step_view', {
      ...context,
      stepId: `step_${index}`,
      stepIndex: index + 1,
      stepTotal: 60
    })
  }

  assert.equal(readQueue(sharedSessionStorage).length, 61)
  await firstHarness.runNextTimer()
  assert.equal(firstHarness.fetchCalls.length, 1)
  assert.equal(JSON.parse(firstHarness.fetchCalls[0][1].body).events.length, 50)
  assert.equal(readQueue(sharedSessionStorage).length, 61, 'un fallo de red no descarta la cola')

  const legacyQueue = readQueue(sharedSessionStorage)
  legacyQueue.forEach(item => {
    item.contactId = 'contacto-que-no-debe-persistir'
    item.contact_id = 'otro-contacto-que-tampoco'
    item.event.contactId = 'contacto-anidado'
    item.event.responseValue = 'respuesta-privada'
  })
  sharedSessionStorage.setItem(
    `rstk:flow::queue:${SITE_ID}`,
    JSON.stringify({ version: 0, items: legacyQueue })
  )

  const successfulCalls = []
  const reloadedHarness = runtimeHarness(source, {
    sessionStorage: sharedSessionStorage,
    localStorage: sharedLocalStorage,
    fetchImpl: async (...args) => {
      successfulCalls.push(args)
      return { ok: true }
    }
  })
  assert.equal(
    /contacto|respuesta-privada|responseValue/.test(
      JSON.stringify(readQueue(sharedSessionStorage))
    ),
    false,
    'la migración de cola elimina asociaciones de contacto heredadas antes de reintentar'
  )

  await reloadedHarness.runNextTimer()
  await reloadedHarness.runNextTimer()

  assert.deepEqual(
    successfulCalls.map(call => JSON.parse(call[1].body).events.length),
    [50, 11]
  )
  assert.equal(readQueue(sharedSessionStorage).length, 0)
  const replayedEvents = successfulCalls.flatMap(call => JSON.parse(call[1].body).events)
  assert.equal(replayedEvents[0].eventName, 'attempt_start')
  assert.equal(new Set(replayedEvents.map(event => event.eventId)).size, 61)
})

test('progress queue retires stale revisions and continues with current events after a permanent 409', async () => {
  const source = await trackingRuntimeSource()
  const responses = [
    { ok: false, status: 409 },
    { ok: true, status: 202 }
  ]
  const harness = runtimeHarness(source, {
    fetchImpl: async () => responses.shift()
  })

  harness.sandbox.ristakFormProgressTrack('step_view', flowContext({
    flowRevision: 'revision_stale_123456789'
  }))
  harness.sandbox.ristakFormProgressTrack('step_view', flowContext({
    flowRevision: 'revision_current_1234567'
  }))

  assert.equal(readQueue(harness.sessionStorage).length, 4)
  await harness.runNextTimer()
  assert.equal(readQueue(harness.sessionStorage).length, 2)
  await harness.runNextTimer()

  assert.equal(readQueue(harness.sessionStorage).length, 0)
  assert.deepEqual(
    harness.fetchCalls.map(call => JSON.parse(call[1].body).flowRevision),
    ['revision_stale_123456789', 'revision_current_1234567']
  )
})

test('pre-submit barrier waits for form progress delivery but remains telemetry-only', async () => {
  const source = await trackingRuntimeSource()
  let resolveProgressRequest = null
  const harness = runtimeHarness(source, {
    fetchImpl: async (url) => {
      if (url !== '/api/sites/public/form-progress') return { ok: true, status: 200 }
      return new Promise(resolve => {
        resolveProgressRequest = resolve
      })
    }
  })
  const context = flowContext({ flowRevision: 'revision_submit_barrier_1234' })

  harness.sandbox.ristakFormProgressTrack('field_answered', {
    ...context,
    fieldId: FIELD_ID
  })
  let barrierSettled = false
  const barrier = harness.sandbox
    .ristakFormProgressFlushBeforeSubmit(context)
    .then(result => {
      barrierSettled = true
      return result
    })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.fetchCalls.length, 1)
  assert.equal(barrierSettled, false, 'el submit no debe adelantar al attempt_start pendiente')
  assert.equal(typeof resolveProgressRequest, 'function')

  resolveProgressRequest({ ok: true, status: 202 })
  assert.equal(await barrier, true)
  assert.equal(readQueue(harness.sessionStorage).length, 0)
})

test('pre-submit barrier times out without making telemetry a submit dependency', async () => {
  const source = await trackingRuntimeSource()
  const harness = runtimeHarness(source, {
    fetchImpl: () => new Promise(() => {})
  })
  const context = flowContext({ flowRevision: 'revision_submit_timeout_1234' })

  harness.sandbox.ristakFormProgressTrack('step_view', context)
  const barrier = harness.sandbox.ristakFormProgressFlushBeforeSubmit(context)

  await harness.runNextTimer()
  await harness.runNextTimer()

  assert.equal(await barrier, false)
  assert.equal(
    readQueue(harness.sessionStorage).length,
    2,
    'el timeout conserva telemetry para un reintento posterior'
  )
})

test('public renderer finishes terminal background flows and finishes before reset can render again', async () => {
  const html = await renderedHtml()

  assert.match(html, /const FLOW_QUEUE_KEY = \[/)
  assert.match(html, /reopenCompleted: details\.allowNewAttempt === true/)
  assert.match(html, /allowNewAttempt: event\.isTrusted === true/)
  const backgroundFlushIndex = html.indexOf(
    'await window.ristakFormProgressFlushBeforeSubmit(backgroundFlow.flow)'
  )
  const backgroundSubmitIndex = html.indexOf(
    'const backgroundAccepted = submitSubmissionInBackground(backgroundPayload);'
  )
  assert.ok(backgroundFlushIndex >= 0, 'el cierre en segundo plano debe esperar telemetry')
  assert.ok(backgroundSubmitIndex > backgroundFlushIndex, 'el cierre no debe adelantarse al primer lote')

  const normalFlushIndex = html.indexOf(
    'await window.ristakFormProgressFlushBeforeSubmit(submissionFlow.flow)'
  )
  const normalSubmitIndex = html.indexOf(
    'let submission = await postSubmission(requestBody);'
  )
  assert.ok(normalFlushIndex >= 0, 'el submit normal debe esperar telemetry')
  assert.ok(normalSubmitIndex > normalFlushIndex, 'el POST final no debe adelantarse al progreso')
  assert.match(html, /renderStep\(\{ track: false \}\);/)
  assert.match(html, /renderEmbeddedForm\(state, \{ track: false \}\);/)

  const finishIndex = html.indexOf('window.ristakFormProgressFinish(submissionFlow.flow);')
  const resetIndex = html.indexOf('form.reset();', finishIndex)
  assert.ok(finishIndex >= 0, 'el submit normal debe cerrar el intento')
  assert.ok(resetIndex > finishIndex, 'el intento debe quedar cerrado antes del reset/render')
})
