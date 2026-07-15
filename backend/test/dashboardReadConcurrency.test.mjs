import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashboardReadLimiter } from '../src/controllers/dashboardController.js'

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

test('el carril compartido nunca ejecuta más de dos lecturas a la vez', async () => {
  const runRead = createDashboardReadLimiter(undefined, 2)
  const gates = Array.from({ length: 8 }, () => deferred())
  const started = []
  let active = 0
  let maxActive = 0

  const reads = gates.map((gate, index) => runRead(async () => {
    started.push(index)
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await gate.promise
      return index
    } finally {
      active -= 1
    }
  }))

  await waitUntil(() => started.length === 2, 'debieron iniciar exactamente dos lecturas')
  assert.equal(maxActive, 2)

  for (let index = 0; index < gates.length; index += 1) {
    gates[index].resolve()
    await waitUntil(
      () => started.length === Math.min(index + 3, gates.length),
      `la lectura ${index + 2} debió tomar el siguiente slot`
    )
  }

  assert.deepEqual(await Promise.all(reads), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(maxActive, 2)
})

test('abortar elimina lecturas en espera y no deja promesas colgadas', async () => {
  const controller = new AbortController()
  const runRead = createDashboardReadLimiter(controller.signal, 1)
  const runningGate = deferred()
  let queuedStarted = false

  const running = runRead(() => runningGate.promise)
  const queued = runRead(async () => {
    queuedStarted = true
    return 'no debe iniciar'
  })
  const queuedRejection = assert.rejects(queued, error => error?.name === 'AbortError')

  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new DOMException('request cerrado', 'AbortError'))
  await queuedRejection
  assert.equal(queuedStarted, false)

  await assert.rejects(
    runRead(() => Promise.resolve('tampoco debe iniciar')),
    error => error?.name === 'AbortError'
  )

  runningGate.resolve('terminó')
  assert.equal(await running, 'terminó')
})
