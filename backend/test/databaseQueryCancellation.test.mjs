import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

import {
  runCancelablePostgresQuery
} from '../src/utils/postgresCancelableQuery.js'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''

test('el adapter global usa un pool reservado y propaga options.signal', async () => {
  const databaseSource = await readFile(new URL('../src/config/database.js', import.meta.url), 'utf8')
  assert.match(databaseSource, /const cancellationPool = new pg\.default\.Pool/)
  assert.match(databaseSource, /runCancelablePostgresQuery\(\{/)
  assert.match(databaseSource, /signal: options\?\.signal/)
  assert.match(databaseSource, /activeTransaction\.all\(sql, params, options\)/)
  assert.match(databaseSource, /pinnedConnection\.db\.get\(sql, params, options\)/)
})

test('espera la cancelacion antes de reutilizar la conexion y devuelve AbortError', async () => {
  const controller = new AbortController()
  let rejectActiveQuery
  let cancellationFinished = false
  const client = {
    processID: 42,
    query: () => new Promise((_, reject) => {
      rejectActiveQuery = reject
    })
  }

  const pending = runCancelablePostgresQuery({
    client,
    sql: 'SELECT expensive_scan()',
    signal: controller.signal,
    cancelBackend: async (processId) => {
      assert.equal(processId, 42)
      await new Promise(resolve => setTimeout(resolve, 20))
      cancellationFinished = true
      rejectActiveQuery(Object.assign(new Error('canceling statement'), { code: '57014' }))
    }
  })
  controller.abort()

  await assert.rejects(pending, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR')
  assert.equal(cancellationFinished, true)
})

test('una señal ya cancelada no llega a PostgreSQL', async () => {
  const controller = new AbortController()
  controller.abort()
  let queries = 0

  await assert.rejects(
    runCancelablePostgresQuery({
      client: { processID: 7, query: async () => { queries += 1 } },
      sql: 'SELECT 1',
      signal: controller.signal,
      cancelBackend: async () => undefined
    }),
    error => error?.name === 'AbortError'
  )
  assert.equal(queries, 0)
})

test('PostgreSQL real corta pg_sleep y la misma sesión queda utilizable', {
  skip: !connectionString
}, async () => {
  const worker = new pg.Client({ connectionString })
  const canceller = new pg.Client({ connectionString })
  await Promise.all([worker.connect(), canceller.connect()])
  try {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = runCancelablePostgresQuery({
      client: worker,
      sql: 'SELECT pg_sleep(5)',
      signal: controller.signal,
      cancelBackend: (processId) => canceller.query(
        'SELECT pg_cancel_backend($1) AS cancelled',
        [processId]
      )
    })
    setTimeout(() => controller.abort(), 75)

    await assert.rejects(pending, error => error?.name === 'AbortError')
    assert.ok(Date.now() - startedAt < 2_000, 'la consulta abandonada no debe seguir cinco segundos')
    assert.equal((await worker.query('SELECT 1 AS ok')).rows[0]?.ok, 1)
  } finally {
    await Promise.allSettled([worker.end(), canceller.end()])
  }
})
