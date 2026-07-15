import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  getReportTransactionSummary,
  REPORT_TRANSACTION_SUMMARY_CACHE_LIMITS
} from '../src/services/reportTransactionSummaryCacheService.js'

test.before(async () => {
  const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_transaction_summary_cache'")
  if (table) return
  const migration = await readFile(
    new URL('../migrations/versioned/081_report_transaction_summary_cache.sqlite.sql', import.meta.url),
    'utf8'
  )
  await db.exec(migration)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout esperando condición')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function clearKey(cacheKey) {
  await db.run('DELETE FROM report_transaction_summary_cache WHERE cache_key = ?', [cacheKey])
}

test('tres misses fríos sólo arrancan dos agregados globales', async () => {
  assert.equal(REPORT_TRANSACTION_SUMMARY_CACHE_LIMITS.activeBuilds, 2)
  const gates = [deferred(), deferred()]
  const keys = Array.from({ length: 3 }, () => `concurrency-${randomUUID()}`)
  await Promise.all(keys.map(clearKey))
  let started = 0
  let active = 0
  let maxActive = 0

  const build = async () => {
    const gate = gates[started]
    started += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    await gate.promise
    active -= 1
    return { count: 1, totalAmount: 10 }
  }

  const first = getReportTransactionSummary({ cacheKey: keys[0], buildSummary: build })
  const second = getReportTransactionSummary({ cacheKey: keys[1], buildSummary: build })
  await waitFor(() => started === 2)

  await assert.rejects(
    getReportTransactionSummary({
      cacheKey: keys[2],
      buildSummary: async () => assert.fail('el tercer builder no debe iniciar')
    }),
    error => error?.status === 503 && error?.code === 'report_transaction_summary_busy'
  )
  assert.equal(maxActive, 2)

  gates.forEach(gate => gate.resolve())
  await Promise.all([first, second])
})

test('dos consumidores comparten build y cancelar uno no corta al otro', async () => {
  const cacheKey = `coalesce-${randomUUID()}`
  await clearKey(cacheKey)
  const gate = deferred()
  const firstController = new AbortController()
  let builds = 0
  let internalSignal
  const buildSummary = async (signal) => {
    builds += 1
    internalSignal = signal
    await gate.promise
    return { count: 2, totalAmount: 25 }
  }

  const first = getReportTransactionSummary({
    cacheKey,
    buildSummary,
    signal: firstController.signal
  })
  const second = getReportTransactionSummary({ cacheKey, buildSummary })
  await waitFor(() => builds === 1)
  firstController.abort()
  await assert.rejects(first, error => error?.name === 'AbortError')
  assert.equal(internalSignal.aborted, false)

  gate.resolve()
  const result = await second
  assert.equal(result.count, 2)
  assert.equal(builds, 1)
})

test('cancelar el último consumidor aborta DB y el retry crea un build limpio', async () => {
  const cacheKey = `last-waiter-${randomUUID()}`
  await clearKey(cacheKey)
  const controller = new AbortController()
  let firstInternalSignal
  let firstStarted = false

  const first = getReportTransactionSummary({
    cacheKey,
    signal: controller.signal,
    buildSummary: signal => new Promise((resolve, reject) => {
      firstStarted = true
      firstInternalSignal = signal
      const onAbort = () => reject(signal.reason || new DOMException('cancelado', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
  })
  await waitFor(() => firstStarted)
  controller.abort()
  await assert.rejects(first, error => error?.name === 'AbortError')
  await waitFor(() => firstInternalSignal.aborted)

  let retryBuilds = 0
  const result = await getReportTransactionSummary({
    cacheKey,
    buildSummary: async () => {
      retryBuilds += 1
      return { count: 3, totalAmount: 90 }
    }
  })
  assert.equal(result.count, 3)
  assert.equal(retryBuilds, 1)
})

test('la capacidad no se libera hasta que el builder cancelado termina de verdad', async () => {
  const keys = Array.from({ length: 3 }, () => `cancel-cap-${randomUUID()}`)
  await Promise.all(keys.map(clearKey))
  const controllers = [new AbortController(), new AbortController()]
  const gates = [deferred(), deferred()]
  let started = 0

  const calls = controllers.map((controller, index) => getReportTransactionSummary({
    cacheKey: keys[index],
    signal: controller.signal,
    // Simula un driver que observa la cancelación pero tarda en confirmar que
    // la consulta terminó. El cupo no debe quedar libre durante ese intervalo.
    buildSummary: async () => {
      started += 1
      await gates[index].promise
      return { count: 1, totalAmount: 1 }
    }
  }))
  await waitFor(() => started === 2)
  controllers.forEach(controller => controller.abort())
  await Promise.all(calls.map(call => assert.rejects(call, error => error?.name === 'AbortError')))

  await assert.rejects(
    getReportTransactionSummary({
      cacheKey: keys[2],
      buildSummary: async () => assert.fail('no debe rebasar los dos builders reales')
    }),
    error => error?.status === 503 && error?.code === 'report_transaction_summary_busy'
  )

  gates.forEach(gate => gate.resolve())
  await waitFor(async () => {
    try {
      const result = await getReportTransactionSummary({
        cacheKey: keys[2],
        buildSummary: async () => ({ count: 4, totalAmount: 40 })
      })
      return result.count === 4
    } catch {
      return false
    }
  })
})
