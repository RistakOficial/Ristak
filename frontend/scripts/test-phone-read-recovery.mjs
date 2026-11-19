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
