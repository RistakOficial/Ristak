import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationReadQueue } from '../src/pages/PhoneChat/conversationReadQueue.ts'
import { refreshAnalyticsRead } from '../src/pages/PhoneAnalytics/refreshAnalyticsRead.ts'

function deferred() {
  return Promise.withResolvers()
}

test('abrir primero, plegar los avisos y descartar el contacto anterior', async () => {
  const queue = new ConversationReadQueue()
  const first = deferred()
  const reads = []
  const record = () => { reads.push('refresh'); return Promise.resolve() }
  const opening = queue.run('A', true, () => { reads.push('open'); return first.promise })
  const refresh = queue.run('A', false, record)
  assert.equal(refresh, queue.run('A', false, record))
  assert.deepEqual(reads, ['open'])
  first.resolve()
  await Promise.all([opening, refresh])
  assert.deepEqual(reads, ['open', 'refresh'])

  const stale = deferred()
  let oldSignal
  queue.run('A', true, signal => { oldSignal = signal; return stale.promise })
  const pending = queue.run('A', false, record)
  await queue.run('B', true, () => { reads.push('B'); return Promise.resolve() })
  stale.resolve()
  await pending
  assert.equal(oldSignal.aborted, true)
  assert.deepEqual(reads, ['open', 'refresh', 'B'])
})

test('las analíticas recuperan datos, dan prioridad a la red y cancelan la consulta al salir', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout })
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const net = { onLine: true }
  const previous = Object.fromEntries(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: browser, document: page, navigator: net })) {
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const updates = []
  let request = deferred()
  let attempts = 0
  let currentSignal
  const start = () => refreshAnalyticsRead({
    read: signal => { attempts++; currentSignal = signal; return request.promise },
    cached: () => 7,
    apply: (value, live) => updates.push([value, live]),
    denied: () => updates.push('denied')
  })
  let stop = start()
  request.resolve(12)
  await request.promise
  t.mock.timers.tick(350)
  assert.deepEqual(updates, [[12, true]])
  stop()

  request = deferred()
  stop = start()
  request.reject(new TypeError('offline'))
  await request.promise.catch(() => {})
  assert.deepEqual(updates.at(-1), [7, false])
  request = deferred()
  t.mock.timers.tick(2_000)
  browser.dispatchEvent(new Event('online'))
  assert.equal(attempts, 3)
  request.resolve(14)
  await request.promise
  assert.deepEqual(updates.at(-1), [14, true])
  stop()

  request = deferred()
  stop = start()
  request.reject({ status: 403 })
  await request.promise.catch(() => {})
  t.mock.timers.tick(60_000)
  assert.equal(updates.at(-1), 'denied')
  assert.equal(attempts, 4)
  stop()

  net.onLine = false
  request = deferred()
  stop = start()
  assert.equal(attempts, 4)
  assert.deepEqual(updates.at(-1), [7, false])
  net.onLine = true
  browser.dispatchEvent(new Event('online'))
  assert.equal(attempts, 5)
  stop()
  assert.ok(currentSignal.aborted)
  request.resolve(19)
  await request.promise
  assert.deepEqual(updates.at(-1), [7, false])
})

test('el último periodo sobrevive al cambio de día sin mezclar filtros, accesos ni fechas de los paneles', async t => {
  const { build } = await import('esbuild')
  const { fileURLToPath } = await import('node:url')
  const { outputFiles } = await build({
    stdin: {
      contents: "export * from './src/pages/PhoneAnalytics/periodCache'; export * from './src/services/phoneDailyCache'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'esm', write: false,
    tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url))
  })
  const { refreshPeriodReading, getSavedAnalyticsSections, getPhoneDailyCacheKey, writePhoneDailyCache, prunePhoneDailyCache } =
    await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))

  const entries = new Map()
  const storage = {
    get length() { return entries.size },
    key: i => Array.from(entries.keys())[i],
    getItem: k => entries.get(k) ?? null,
    setItem: (k, v) => entries.set(k, v),
    removeItem: k => entries.delete(k)
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-19T04:00:00Z') })
  const net = { onLine: true }
  const browser = Object.assign(new EventTarget(), { localStorage: storage, setTimeout, clearTimeout })
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  for (const [key, value] of Object.entries({ window: browser, document: page, navigator: net })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
  }

  const timezone = 'America/Mexico_City'
  const scope = (currency = 'MXN', webAccess = true, account = 'A', zone = timezone) =>
    getPhoneDailyCacheKey('analytics', '/api', account, 'user', zone, currency, webAccess)
  const yesterday = { scope: scope(), period: '30d', rangeKey: '2026-10-20:2026-11-18:1', through: '2026-11-18', timezone }
  const today = { ...yesterday, rangeKey: '2026-10-21:2026-11-19:1', through: '2026-11-19' }
  const filters = ['chart', 'revenue-spend', 'all', 'day']
  const updates = []
  const denied = () => updates.push('denied')
  let reply = deferred()
  const watch = (query, selection = filters) => refreshPeriodReading(query, selection, {
    read: () => reply.promise, apply: (data, through) => updates.push([data, through]), denied
  })
  const settled = () => new Promise(resolve => setImmediate(resolve))

  storage.setItem('auth_token', 'test-session-A')
  let stop = watch(yesterday)
  reply.resolve(7)
  await settled()
  stop()
  assert.deepEqual(updates.splice(0), [[7, '2026-11-18']])

  // Una lectura antigua exacta de la versión previa también se puede conservar.
  const prior = ['funnel', 'campaigns']
  writePhoneDailyCache(getPhoneDailyCacheKey(yesterday.scope, yesterday.rangeKey, ...prior), [], {}, timezone)
  net.onLine = false
  watch(yesterday, prior)()
  assert.deepEqual(updates.splice(0), [[[], '2026-11-18']])

  t.mock.timers.setTime(Date.parse('2026-11-19T08:00:00Z'))
  prunePhoneDailyCache(timezone)
  for (const other of [
    { ...today, period: '60d' }, { ...today, scope: scope('USD') },
    { ...today, scope: scope('MXN', false) }, { ...today, scope: scope('MXN', true, 'B') },
    { ...today, scope: scope('MXN', true, 'A', 'UTC'), timezone: 'UTC' }
  ]) watch(other)()
  watch(today, ['chart', 'revenue-spend', 'campaigns', 'day'])()
  assert.deepEqual(updates, [])
  watch(today, prior)()
  assert.deepEqual(updates.splice(0), [[[], '2026-11-18']])

  reply = deferred()
  stop = watch(today)
  assert.deepEqual(updates.splice(0), [[7, '2026-11-18']])
  net.onLine = true
  browser.dispatchEvent(new Event('online'))
  reply.resolve(0)
  await settled()
  assert.deepEqual(updates.splice(0), [[0, '2026-11-19']])
  stop()
  assert.deepEqual(Array.from(getSavedAnalyticsSections(today.through, [
    ['Indicadores y origen', today.through], ['Gráfica', yesterday.through],
    ['Embudo', false], ['Origen por número', yesterday.through]
  ])), [[yesterday.through, ['Gráfica', 'Origen por número']]])

  // Una pestaña detenida ayer puede entregar su respuesta después de la de hoy.
  reply = deferred()
  stop = watch(yesterday)
  reply.resolve(2)
  await settled()
  stop()
  net.onLine = false
  updates.length = 0
  watch(today)()
  assert.deepEqual(updates.splice(0), [[0, '2026-11-19']])

  net.onLine = true
  reply = deferred()
  stop = watch(today)
  reply.reject({ status: 403 })
  await settled()
  stop()
  net.onLine = false
  watch(today)()
  assert.deepEqual(updates.splice(0), ['denied'])

  net.onLine = true
  reply = deferred()
  stop = watch(today)
  storage.setItem('auth_token', 'test-session-B')
  reply.resolve(99)
  await settled()
  stop()
  net.onLine = false
  watch(today)()
  assert.deepEqual(updates, [])

  // Un navegador puede permitir leer localStorage pero bloquear sus operaciones.
  net.onLine = true
  storage.getItem = storage.setItem = storage.removeItem = () => { throw new Error('Storage no disponible') }
  reply = deferred()
  stop = watch(today)
  reply.resolve(42)
  await settled()
  stop()
  assert.deepEqual(updates, [[42, '2026-11-19']])
})
