import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { listInvoiceSchedules } from '../src/controllers/highlevelController.js'
import { getCachedTransactionQuery } from '../src/services/paymentListSummaryCacheService.js'

const readSource = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8')

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await db.exec(await readSource('../migrations/versioned/071_payment_lists_cursor_summary.sqlite.sql'))
})

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
      return this
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

test('Pagos propaga cancelación y deadlines desde HTTP hasta cada SQL pesada', async () => {
  const [cacheSource, analyticsSource, transactionsController, paymentPlansController] = await Promise.all([
    readSource('../src/services/paymentListSummaryCacheService.js'),
    readSource('../src/services/analyticsService.js'),
    readSource('../src/controllers/transactionsController.js'),
    readSource('../src/controllers/highlevelController.js')
  ])
  const transactionSummary = analyticsSource.split('export async function buildTransactionSummary')[1]
    .split('export async function buildCampaignSummary')[0]
  const transactionFacetsHandler = transactionsController.split('export const getTransactionFacets')[1]
    .split('export const syncTransactions')[0]
  const transactionSummaryHandler = transactionsController.split('export const getTransactionSummary')[1]
    .split('export const updateTransaction')[0]
  const paymentPlanList = paymentPlansController.split('async function getPaymentPlansSummary')[1]
    .split('async function getLocalInvoiceSchedule')[0]
  const paymentPlanHandler = paymentPlansController.split('export const listInvoiceSchedules')[1]
    .split('export const getInvoiceSchedule')[0]

  assert.match(cacheSource, /PAYMENT_SUMMARY_MAX_CONCURRENT_BUILDS = 2/)
  assert.match(cacheSource, /PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT = 1/)
  assert.match(cacheSource, /PAYMENT_SUMMARY_BUILD_DEADLINE_MS = 16_000/)
  assert.doesNotMatch(cacheSource, /summaryBuildQueue/)
  assert.match(cacheSource, /ORDER BY source_revision DESC, built_at DESC\s+LIMIT 1/)
  const exactCacheReader = cacheSource.split('async function readCachedSummary')[1]
    .split('async function readLatestSummary')[0]
  assert.doesNotMatch(exactCacheReader, /UPDATE payment_list_summary_cache/)

  assert.match(transactionSummary, /resolveDateRangeWithGHLTimezone\(\{ startDate, endDate, signal \}\)/)
  assert.match(transactionSummary, /getHiddenContactFilters\(\{ signal \}\)/)
  assert.ok(
    (transactionSummary.match(/,\s*\{ signal \}\s*\)/g) || []).length >= 4,
    'las cuatro agregaciones SQL del resumen deben compartir la señal'
  )

  assert.match(transactionsController, /createTransactionsRequestAbortScope\(req, res, timeoutMs = 18_000\)/)
  assert.match(transactionsController, /signal: controller\.signal,\s*abort,/)
  for (const handler of [transactionFacetsHandler, transactionSummaryHandler]) {
    assert.match(handler, /signal: requestScope\.signal/)
    assert.match(handler, /requestScope\.abort\(error\)/)
    assert.match(handler, /Retry-After/)
    assert.match(handler, /payment_request_deadline/)
    assert.match(handler, /retryable/)
  }

  assert.match(paymentPlansController, /createPaymentPlanListAbortScope\(req, res, timeoutMs = PAYMENT_PLAN_LIST_REQUEST_DEADLINE_MS\)/)
  assert.match(paymentPlansController, /PAYMENT_PLAN_LIST_REQUEST_DEADLINE_MS = 18_000/)
  assert.match(paymentPlansController, /signal: controller\.signal,\s*abort,/)
  assert.match(paymentPlanList, /buildSignal => getPaymentPlansSummary\(buildSignal\)/)
  assert.match(paymentPlanList, /getCachedPaymentListSummary\([\s\S]*\{ signal \}/)
  assert.match(paymentPlanHandler, /requestScope\.abort\(error\)/)
  assert.match(paymentPlanHandler, /Retry-After/)
  assert.match(paymentPlanHandler, /payment_request_deadline/)
  assert.match(paymentPlanHandler, /retryable/)
})

test('el cliente cancela lecturas de Pagos y conserva KPIs previos ante error', async () => {
  const [transactionsService, transactionsPage] = await Promise.all([
    readSource('../../frontend/src/services/transactionsService.ts'),
    readSource('../../frontend/src/pages/Transactions/Transactions.tsx')
  ])
  const summaryReader = transactionsService.split('async getSummary')[1]
    .split('async getFacets')[0]
  const facetsReader = transactionsService.split('async getFacets')[1]
    .split('async syncTransactions')[0]

  assert.match(transactionsService, /TRANSACTIONS_VIEW_REQUEST_TIMEOUT_MS = 20_000/)
  assert.doesNotMatch(transactionsService, /EMPTY_TRANSACTION_SUMMARY/)
  assert.match(summaryReader, /withRequestTimeout/)
  assert.match(facetsReader, /withRequestTimeout/)
  assert.match(transactionsPage, /paymentPlansAbortRef\.current\?\.abort\(\)/)
  assert.match(transactionsPage, /forceRefresh: options\.forceRefresh,[\s\S]*signal: controller\.signal/)
  assert.match(transactionsPage, /insightsController\.abort\(\)/)
  assert.match(transactionsPage, /Resumen de pagos no disponible/)
  assert.doesNotMatch(summaryReader, /totalRevenue:\s*0/)
})

test('cuando no hay capacidad, planes responde 503 retryable y cancela la rama SQL hermana', async () => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  await db.run(databaseDialect === 'postgres'
    ? `INSERT INTO payment_list_revisions (scope, revision, updated_at)
       VALUES ('transactions', 0, CURRENT_TIMESTAMP)
       ON CONFLICT(scope) DO NOTHING`
    : `INSERT OR IGNORE INTO payment_list_revisions (scope, revision, updated_at)
       VALUES ('transactions', 0, CURRENT_TIMESTAMP)`)
  await db.run('DELETE FROM payment_list_summary_cache WHERE scope = ?', ['payment_plans'])

  let started = 0
  let releaseBuilds
  const release = new Promise(resolve => { releaseBuilds = resolve })
  const blockers = [0, 1].map(index => getCachedTransactionQuery(
    `payment_endpoint_busy_${suffix}_${index}`,
    async () => {
      started += 1
      await release
      return { index }
    }
  ))
  const settledBlockers = Promise.allSettled(blockers)
  const originalDbAll = db.all
  let siblingSignal = null
  let siblingCancelled = false

  db.all = async (sql, params = [], options = {}) => {
    const statement = String(sql || '')
    if (statement.includes('FROM payment_plans') && statement.includes('LIMIT ?')) {
      siblingSignal = options?.signal || null
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          siblingCancelled = true
          reject(siblingSignal?.reason || new Error('Consulta hermana cancelada'))
        }
        if (siblingSignal?.aborted) {
          onAbort()
          return
        }
        siblingSignal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return originalDbAll.call(db, sql, params, options)
  }

  try {
    for (let attempt = 0; attempt < 100 && started < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.equal(started, 2)

    const response = responseRecorder()
    await listInvoiceSchedules({ query: {}, aborted: false }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.payload?.code, 'payment_summary_busy')
    assert.equal(response.payload?.retryable, true)
    assert.equal(response.headers['retry-after'], '1')
    assert.ok(siblingSignal, 'la SELECT hermana debe recibir la señal del request')
    assert.equal(siblingSignal.aborted, true)
    assert.equal(siblingCancelled, true)
  } finally {
    db.all = originalDbAll
    releaseBuilds()
    await settledBlockers
  }
})
