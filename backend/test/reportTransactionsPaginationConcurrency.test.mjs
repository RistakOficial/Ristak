import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { listReportTransactionsPage } from '../src/services/reportTransactionsPaginationService.js'

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
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout esperando consultas de Reportes')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function isSummaryAggregate(sql) {
  return /COUNT\(\*\)\s+AS count[\s\S]*SUM\(p\.amount\)/i.test(String(sql || ''))
}

function isRowsQuery(sql) {
  return /SELECT\s+p\.id,\s*p\.contact_id[\s\S]*FROM payments p[\s\S]*LIMIT \?/i.test(String(sql || ''))
}

function isFilteredCount(sql) {
  return /COUNT\(\*\)\s+AS total[\s\S]*FROM payments p/i.test(String(sql || ''))
}

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_transaction_summary_cache'")
  if (table) return
  const migration = await readFile(
    new URL('../migrations/versioned/081_report_transaction_summary_cache.sqlite.sql', import.meta.url),
    'utf8'
  )
  await db.exec(migration)
})

test('resumen y filas arrancan juntos sin superar dos consultas; COUNT espera a filas', { concurrency: false }, async () => {
  await db.run('DELETE FROM report_transaction_summary_cache')

  const originals = { all: db.all, get: db.get }
  const summaryGate = deferred()
  const rowsGate = deferred()
  let active = 0
  let maxActive = 0
  let summaryStarted = false
  let rowsStarted = false
  let rowsFinished = false
  let filteredCountStarted = false
  let filteredCountStartedAfterRows = false

  const enter = () => {
    active += 1
    maxActive = Math.max(maxActive, active)
  }
  const leave = () => {
    active -= 1
  }

  db.get = async function observedGet(sql, ...args) {
    if (isSummaryAggregate(sql)) {
      summaryStarted = true
      enter()
      try {
        await summaryGate.promise
        return await originals.get.call(this, sql, ...args)
      } finally {
        leave()
      }
    }
    if (isFilteredCount(sql)) {
      filteredCountStarted = true
      filteredCountStartedAfterRows = rowsFinished
      enter()
      try {
        return await originals.get.call(this, sql, ...args)
      } finally {
        leave()
      }
    }
    return originals.get.call(this, sql, ...args)
  }

  db.all = async function observedAll(sql, ...args) {
    if (!isRowsQuery(sql)) return originals.all.call(this, sql, ...args)
    rowsStarted = true
    enter()
    try {
      await rowsGate.promise
      return await originals.all.call(this, sql, ...args)
    } finally {
      rowsFinished = true
      leave()
    }
  }

  try {
    const request = listReportTransactionsPage({
      startDate: '2097-07-15',
      endDate: '2097-07-15',
      search: `sin-resultados-${process.pid}-${Date.now()}`,
      limit: 25
    })

    await waitFor(() => summaryStarted && rowsStarted)
    assert.equal(filteredCountStarted, false, 'el COUNT filtrado no debe competir con la consulta de filas')
    assert.equal(maxActive, 2, 'summary y filas deben aprovechar los dos carriles disponibles')

    rowsGate.resolve()
    await waitFor(() => filteredCountStarted)
    assert.equal(filteredCountStartedAfterRows, true, 'el COUNT sólo arranca después de terminar filas')
    assert.ok(maxActive <= 2, `se observaron ${maxActive} consultas simultáneas`)

    summaryGate.resolve()
    const result = await request
    assert.deepEqual(result.transactions, [])
    assert.equal(result.pagination.total, 0)
    assert.ok(maxActive <= 2, `la carga completa rebasó el límite: ${maxActive}`)
  } finally {
    summaryGate.resolve()
    rowsGate.resolve()
    db.all = originals.all
    db.get = originals.get
  }
})

test('cancelar la página propaga AbortSignal a summary y filas sin dejarlas colgadas', { concurrency: false }, async () => {
  await db.run('DELETE FROM report_transaction_summary_cache')

  const originals = { all: db.all, get: db.get }
  let summarySignal
  let rowsSignal

  function pendingUntilAbort(signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason || Object.assign(new Error('cancelada'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      }))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  db.get = async function cancellableGet(sql, params, options = {}) {
    if (!isSummaryAggregate(sql)) return originals.get.call(this, sql, params, options)
    summarySignal = options.signal
    return pendingUntilAbort(summarySignal)
  }
  db.all = async function cancellableAll(sql, params, options = {}) {
    if (!isRowsQuery(sql)) return originals.all.call(this, sql, params, options)
    rowsSignal = options.signal
    return pendingUntilAbort(rowsSignal)
  }

  try {
    const controller = new AbortController()
    const request = listReportTransactionsPage({
      startDate: '2097-07-16',
      endDate: '2097-07-16',
      signal: controller.signal
    })

    await waitFor(() => summarySignal && rowsSignal)
    controller.abort()

    await assert.rejects(request, error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
    await waitFor(() => summarySignal.aborted && rowsSignal.aborted)
    assert.equal(summarySignal.aborted, true)
    assert.equal(rowsSignal.aborted, true)
  } finally {
    db.all = originals.all
    db.get = originals.get
  }
})
