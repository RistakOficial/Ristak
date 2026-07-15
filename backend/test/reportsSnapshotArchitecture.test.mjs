import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { getReportsSnapshot as getReportsSnapshotController } from '../src/controllers/reportsController.js'
import {
  getReportsSnapshot,
  REPORTS_SNAPSHOT_CACHE_LIMITS
} from '../src/services/reportsSnapshotService.js'

const readRepoFile = relative => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function databaseAbortError() {
  const error = new Error('Database operation aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

async function installReportsSnapshotSchema() {
  const [campaignRevisionSql, migrationSql, timeDependenciesSql] = await Promise.all([
    readFile(new URL('../migrations/versioned/070_campaign_performance_materialized_cache.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/100_reports_snapshot_cache.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/107_reports_snapshot_time_dependencies.sqlite.sql', import.meta.url), 'utf8')
  ])
  await db.exec(campaignRevisionSql)
  await db.exec(migrationSql)
  await db.exec(timeDependenciesSql)
}

function isTargetContactAggregate(sql, params, date) {
  return /WITH ranged_contacts AS/i.test(String(sql || '')) &&
    params.some(value => String(value || '').includes(date))
}

async function waitForReleaseOrAbort({ release, signal, aborted }) {
  if (signal?.aborted) {
    aborted.resolve()
    throw databaseAbortError()
  }

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort)
      aborted.resolve()
      reject(databaseAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    release.promise.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, reject)
  })
}

test('la UI de Reportes consume un solo read-model y conserva los endpoints legacy', async () => {
  const [controller, routes, service, metricsService, page, phone, frontendService] = await Promise.all([
    readRepoFile('backend/src/controllers/reportsController.js'),
    readRepoFile('backend/src/routes/reports.routes.js'),
    readRepoFile('backend/src/services/reportsSnapshotService.js'),
    readRepoFile('backend/src/services/reportMetricsAggregationService.js'),
    readRepoFile('frontend/src/pages/Reports/Reports.tsx'),
    readRepoFile('frontend/src/pages/PhoneApp/PhoneApp.tsx'),
    readRepoFile('frontend/src/services/reportsService.ts')
  ])

  assert.match(routes, /router\.get\('\/snapshot', getReportsSnapshot\)/)
  assert.match(routes, /router\.use\(requireAuth\)/)
  assert.match(routes, /router\.use\(requireModuleAccess\('reports'\)\)/)
  assert.match(routes, /router\.get\('\/metrics', getMetrics\)/)
  assert.match(routes, /router\.get\('\/summary', getSummary\)/)
  assert.match(controller, /getReportsSnapshotReadModel/)
  assert.doesNotMatch(controller, /principal:\s*req\.user/)
  assert.match(controller, /req\.once\?\.\('aborted', abortIfDisconnected\)/)
  assert.match(controller, /res\.once\?\.\('close', abortIfDisconnected\)/)
  assert.match(controller, /signal: requestScope\.signal/)
  assert.match(controller, /requestScope\.disconnected/)
  assert.match(controller, /createReportsRequestAbortScope\(req, res, \{ timeoutMs: 18_000 \}\)/)
  assert.match(controller, /code: 'reports_snapshot_deadline'/)
  assert.match(service, /buildAggregatedReportMetrics\(\{ \.\.\.query, signal \}\)/)
  assert.match(service, /buildReportComparisonTotals/)
  assert.match(service, /entry\.waiters \+= 1/)
  assert.match(service, /SNAPSHOT_MAX_QUEUED_BUILDS = 8/)
  assert.match(service, /SNAPSHOT_BUILD_DEADLINE_MS = 18_000/)
  assert.match(service, /REPORTS_SHARED_PRINCIPAL_SCOPE = 'authorized-reports-read-v1'/)
  assert.match(service, /async function readPostgresSnapshotContext/)
  assert.match(service, /WITH account_context AS MATERIALIZED/)
  assert.match(service, /revision_context AS MATERIALIZED/)
  assert.match(service, /LEFT JOIN LATERAL \([\s\S]*?FROM reports_snapshot_cache/)
  assert.match(service, /if \(databaseDialect === 'postgres'\) \{[\s\S]*?readPostgresSnapshotContext/)
  assert.match(service, /encodeMovingRevision/)
  assert.match(service, /db\.withAdvisoryLock\([\s\S]*\}, \{ signal \}\)/)
  assert.match(service, /activeBuilds >= SNAPSHOT_MAX_CONCURRENT_BUILDS[\s\S]*return withCacheMetadata\(cached\.payload/)
  assert.match(service, /entry\.waiters === 0 && !entry\.keepAlive/)
  assert.match(service, /entry\.controller\.abort\(\)/)
  assert.match(metricsService, /buildAggregatedReportMetrics\(\{ startDate, endDate, groupBy = 'day', scope = 'all', signal \}/)
  assert.match(metricsService, /runBoundedQueryTasks\([\s\S]*?\], 2, signal\)/)
  assert.doesNotMatch(service, /buildContactStats|buildTransactionSummary|buildCampaignSummary/)
  assert.match(page, /reportsService\.getSnapshot/)
  assert.doesNotMatch(page, /reportsService\.getMetrics\(/)
  assert.doesNotMatch(page, /reportsService\.getSummary\(/)
  assert.match(page, /snapshotRequestRef\.current === requestId/)
  assert.match(page, /controller\.abort\(\)/)
  assert.match(page, /result\.cache\.stale/)
  assert.match(page, /result\.cache\.revalidateAfter/)
  assert.match(
    page,
    /if \(\(loadingMetrics \|\| loadingSummary\) && !hasLoadedReports\) \{[\s\S]*?<PageHeader title="Reportes"[\s\S]*?<Loading message="Cargando reportes\.\.\."/,
    'el encabezado de Reportes debe aparecer antes de que termine el primer snapshot'
  )
  assert.match(phone, /reportsService\.getSnapshot/)
  assert.doesNotMatch(phone, /reportsService\.getMetrics\(/)
  assert.doesNotMatch(phone, /reportsService\.getSummary\(/)
  assert.match(frontendService, /apiClient\.get<ReportsSnapshot>\('\/reports\/snapshot'/)
  assert.equal(REPORTS_SNAPSHOT_CACHE_LIMITS.maxConcurrentBuilds, 2)
  assert.ok(REPORTS_SNAPSHOT_CACHE_LIMITS.entriesPerSharedScope <= 64)
  assert.ok(REPORTS_SNAPSHOT_CACHE_LIMITS.entriesPerAccount <= 256)
  assert.equal(REPORTS_SNAPSHOT_CACHE_LIMITS.refreshIntervalMs, 30_000)
  assert.ok(REPORTS_SNAPSHOT_CACHE_LIMITS.staleMaxAgeMs <= 5 * 60_000)
})

test('PostgreSQL resuelve cuenta, revisiones y cache exacto de Reportes en una lectura coherente', {
  skip: databaseDialect !== 'postgres'
}, async () => {
  const date = `2199-${randomUUID()}`.slice(0, 40)
  const query = { startDate: date, endDate: date, groupBy: 'day', scope: 'all' }
  const cacheKey = createHash('sha256').update(JSON.stringify({ version: 1, ...query })).digest('hex')
  const principalScope = 'authorized-reports-read-v1'
  const [location, reportsRevision, campaignRevision, visitorRevision] = await Promise.all([
    db.get('SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1'),
    db.get('SELECT last_value, is_called FROM reports_snapshot_revision_seq'),
    db.get('SELECT core_revision FROM campaign_performance_revision WHERE id = 1'),
    db.get('SELECT last_value, is_called FROM campaign_performance_visitor_revision_seq')
  ])
  const accountScope = `account:${String(location?.location_id || '').trim().slice(0, 240) || 'local-database'}`
  const sourceRevision = [
    `reports:${reportsRevision?.is_called ? Number(reportsRevision.last_value || 0) : 0}`,
    `core:${Number(campaignRevision?.core_revision || 0)}`,
    `visitor:${visitorRevision?.is_called ? Number(visitorRevision.last_value || 0) : 0}`
  ].join('|')
  const builtAt = new Date().toISOString()
  const payload = {
    metrics: [{ date, revenue: 123 }],
    range: { start: date, end: date, timezone: 'UTC', filtered: true },
    summary: { payments: {}, campaigns: {} }
  }

  await db.run(`
    INSERT INTO reports_snapshot_cache (
      account_scope, principal_scope, cache_key, source_revision,
      payload_json, built_at, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_scope, principal_scope, cache_key) DO UPDATE SET
      source_revision = excluded.source_revision,
      payload_json = excluded.payload_json,
      built_at = excluded.built_at,
      last_accessed_at = excluded.last_accessed_at
  `, [
    accountScope,
    principalScope,
    cacheKey,
    sourceRevision,
    JSON.stringify(payload),
    builtAt,
    builtAt
  ])

  const originalGet = db.get
  const originalRun = db.run
  const reads = []
  const writes = []
  const controller = new AbortController()
  db.get = async function observedGet(sql, params = [], options = {}) {
    reads.push({ sql: String(sql || ''), options })
    return originalGet.call(this, sql, params, options)
  }
  db.run = async function observedRun(sql, params = [], options = {}) {
    writes.push(String(sql || ''))
    return originalRun.call(this, sql, params, options)
  }

  try {
    const result = await getReportsSnapshot({ ...query, signal: controller.signal })
    assert.equal(result.cache.stale, false)
    assert.equal(result.cache.consistency, 'exact')
    assert.deepEqual(result.metrics, payload.metrics)
    assert.equal(reads.length, 1, 'el cache hit PostgreSQL no debe adquirir el pool cinco veces')
    assert.match(reads[0].sql, /FROM highlevel_config/)
    assert.match(reads[0].sql, /FROM reports_snapshot_revision_seq/)
    assert.match(reads[0].sql, /FROM campaign_performance_revision/)
    assert.match(reads[0].sql, /FROM campaign_performance_visitor_revision_seq/)
    assert.match(reads[0].sql, /FROM reports_snapshot_cache/)
    assert.equal(reads[0].options.signal, controller.signal)
    assert.equal(writes.length, 0, 'un cache hit reciente no debe escribir otra vez el LRU')
  } finally {
    db.get = originalGet
    db.run = originalRun
    await db.run(`
      DELETE FROM reports_snapshot_cache
      WHERE account_scope = ? AND principal_scope = ? AND cache_key = ?
    `, [accountScope, principalScope, cacheKey])
  }
})

test('la revision extra de Reportes no duplica hot paths ni invalida por config ajena', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()
  const triggerRows = await db.all(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'trg_reports_snapshot_%'
    ORDER BY name
  `)
  const triggerNames = triggerRows.map(row => row.name)
  assert.equal(triggerNames.some(name => /contacts_(?:insert|update|delete)$/.test(name)), false)
  assert.deepEqual(
    triggerNames.filter(name => /payments_|appointments_/.test(name)),
    [
      'trg_reports_snapshot_appointments_time_update',
      'trg_reports_snapshot_payments_time_update'
    ]
  )
  assert.equal(triggerNames.some(name => /attendance_|ads_|sessions_/.test(name)), false)
  assert.match(
    triggerRows.find(row => row.name === 'trg_reports_snapshot_app_config_update')?.sql || '',
    /account_timezone.*attribution_calendar_ids/s
  )

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const contactId = `reports-revision-hot-path-${suffix}`
  const irrelevantConfigKey = `reports_irrelevant_${suffix}`
  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES (?, 'Revision hot path', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `${suffix}@reports.invalid`])
    const before = await Promise.all([
      db.get('SELECT core_revision FROM campaign_performance_revision WHERE id = 1'),
      db.get('SELECT revision FROM reports_snapshot_revision WHERE singleton = 1')
    ])

    await db.run('UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [contactId])
    await db.run(
      'INSERT INTO app_config (config_key, config_value) VALUES (?, ?)',
      [irrelevantConfigKey, 'irrelevant']
    )
    const after = await Promise.all([
      db.get('SELECT core_revision FROM campaign_performance_revision WHERE id = 1'),
      db.get('SELECT revision FROM reports_snapshot_revision WHERE singleton = 1')
    ])
    assert.equal(Number(after[0]?.core_revision || 0), Number(before[0]?.core_revision || 0))
    assert.equal(Number(after[1]?.revision || 0), Number(before[1]?.revision || 0))
  } finally {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [irrelevantConfigKey]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('editar la fecha de pago o cita invalida el snapshot durable de Reportes', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const contactId = `reports-time-contact-${suffix}`
  const paymentId = `reports-time-payment-${suffix}`
  const appointmentId = `reports-time-appointment-${suffix}`

  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES (?, 'Snapshot time', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `${suffix}@reports.invalid`])
    await db.run(`
      INSERT INTO payments (id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
      VALUES (?, ?, 10, 'paid', 'live', '2090-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [paymentId, contactId])
    await db.run(`
      INSERT INTO appointments (id, contact_id, status, appointment_status, date_added, date_updated)
      VALUES (?, ?, 'confirmed', 'confirmed', '2090-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)
    `, [appointmentId, contactId])

    const before = Number((await db.get(
      'SELECT revision FROM reports_snapshot_revision WHERE singleton = 1'
    ))?.revision || 0)
    await db.run('UPDATE payments SET date = ? WHERE id = ?', ['2090-02-01T00:00:00.000Z', paymentId])
    await db.run('UPDATE appointments SET date_added = ? WHERE id = ?', ['2090-03-01T00:00:00.000Z', appointmentId])
    const after = Number((await db.get(
      'SELECT revision FROM reports_snapshot_revision WHERE singleton = 1'
    ))?.revision || 0)

    assert.equal(after, before + 2)
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('SQLite sirve stale inmediatamente, comparte la reconstruccion e invalida por revision durable', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2096-07-14'
  const query = {
    principal: `reports-principal-a-${suffix}`,
    startDate: date,
    endDate: date,
    groupBy: 'day',
    scope: 'all'
  }
  const contactId = `reports-snapshot-contact-${suffix}`
  const sessionId = randomUUID()

  const first = await getReportsSnapshot(query)
  const exact = await getReportsSnapshot(query)
  const baselineLeads = first.metrics.find(row => row.date === date)?.leads || 0

  assert.equal(first.cache.stale, false)
  assert.equal(exact.cache.stale, false)
  assert.equal(exact.cache.builtAt, first.cache.builtAt)
  assert.deepEqual(exact.metrics, first.metrics)

  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES (?, 'Snapshot Reportes', ?, ?, ?)
    `, [contactId, `${suffix}@reports.invalid`, `${date}T18:00:00.000Z`, `${date}T18:00:00.000Z`])

    const stale = await getReportsSnapshot(query)
    assert.equal(stale.cache.stale, true)
    assert.equal(stale.cache.builtAt, first.cache.builtAt)
    assert.equal(stale.metrics.find(row => row.date === date)?.leads || 0, baselineLeads)

    // waitForFresh se une a la promesa que ya arranco el stale; no crea un
    // segundo agregado para la misma cuenta, principal y rango.
    const fresh = await getReportsSnapshot({ ...query, waitForFresh: true })
    assert.notEqual(fresh.cache.builtAt, first.cache.builtAt)
    assert.equal(fresh.metrics.find(row => row.date === date)?.leads, baselineLeads + 1)

    const baselineVisitors = fresh.metrics.find(row => row.date === date)?.visitors || 0
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, event_name, started_at, created_at
      ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
    `, [
      sessionId,
      `reports-session-${suffix}`,
      `reports-visitor-${suffix}`,
      contactId,
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`
    ])

    const visitorStale = await getReportsSnapshot(query)
    assert.equal(visitorStale.cache.stale, true)
    const visitorFresh = await getReportsSnapshot({ ...query, waitForFresh: true })
    assert.equal(visitorFresh.metrics.find(row => row.date === date)?.visitors, baselineVisitors + 1)

    const beforeOtherPrincipal = Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0)
    const sharedPrincipal = await getReportsSnapshot({ ...query, principal: `reports-principal-b-${suffix}` })
    const afterOtherPrincipal = Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0)
    assert.equal(afterOtherPrincipal, beforeOtherPrincipal)
    assert.equal(sharedPrincipal.cache.builtAt, visitorFresh.cache.builtAt)
  } finally {
    await db.run('DELETE FROM sessions WHERE id = ?', [sessionId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('un build cuya revisión cambia se persiste como moving-window sin declarar exactitud', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()
  const date = '2094-04-14'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const contactId = `reports-fence-contact-${suffix}`
  const query = {
    principal: `reports-fence-principal-${suffix}`,
    startDate: date,
    endDate: date,
    groupBy: 'day',
    scope: 'all',
    waitForFresh: true
  }
  const started = deferred()
  const release = deferred()
  const originalAll = db.all
  let holdFirstBuild = true

  db.all = async (sql, params = [], options = {}) => {
    if (holdFirstBuild && isTargetContactAggregate(sql, params, date)) {
      holdFirstBuild = false
      started.resolve()
      await release.promise
    }
    return originalAll.call(db, sql, params, options)
  }

  try {
    const beforeRows = Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0)
    const firstBuild = getReportsSnapshot(query)
    await started.promise
    await db.run(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES (?, 'Revision fence', ?, ?, ?)
    `, [contactId, `${suffix}@reports.invalid`, `${date}T18:00:00.000Z`, `${date}T18:00:00.000Z`])
    release.resolve()

    const raced = await firstBuild
    assert.equal(raced.cache.stale, true)
    assert.equal(raced.cache.exactAtBuiltAt, false)
    assert.equal(raced.cache.consistency, 'moving-window')
    assert.ok(raced.cache.builtAt)
    assert.notEqual(raced.cache.builtSourceRevision, raced.cache.currentSourceRevision)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0), beforeRows + 1)

    const coalesced = await getReportsSnapshot(query)
    assert.equal(coalesced.cache.stale, true)
    assert.equal(coalesced.cache.builtAt, raced.cache.builtAt)

    await db.run(
      'UPDATE reports_snapshot_cache SET built_at = ? WHERE built_at = ?',
      [new Date(Date.now() - REPORTS_SNAPSHOT_CACHE_LIMITS.refreshIntervalMs - 1_000).toISOString(), raced.cache.builtAt]
    )
    const retry = await getReportsSnapshot(query)
    assert.equal(retry.cache.stale, false)
    assert.ok(retry.cache.builtAt)
  } finally {
    release.resolve()
    db.all = originalAll
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('Reportes coalesce varios builds bajo escrituras continuas y comparte cache entre principals', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()
  const date = '2094-04-15'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const query = {
    principal: `reports-continuous-a-${suffix}`,
    startDate: date,
    endDate: date,
    groupBy: 'day',
    scope: 'all',
    waitForFresh: true
  }
  const originalAll = db.all
  const insertedContacts = []
  let mutateNextBuild = false
  let targetQueries = 0
  let mutations = 0

  db.all = async (sql, params = [], options = {}) => {
    const result = await originalAll.call(db, sql, params, options)
    if (isTargetContactAggregate(sql, params, date)) {
      targetQueries += 1
      if (mutateNextBuild) {
        mutateNextBuild = false
        mutations += 1
        const contactId = `reports-continuous-contact-${suffix}-${mutations}`
        insertedContacts.push(contactId)
        await db.run(`
          INSERT INTO contacts (id, full_name, email, created_at, updated_at)
          VALUES (?, 'Continuous snapshot', ?, ?, ?)
        `, [
          contactId,
          `${suffix}-${mutations}@reports.invalid`,
          `${date}T18:00:00.000Z`,
          `${date}T18:00:00.000Z`
        ])
      }
    }
    return result
  }

  try {
    const rowsBefore = Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0)

    let moving = null
    for (let build = 0; build < 3; build += 1) {
      mutateNextBuild = true
      if (build === 0) {
        const [firstPrincipal, secondPrincipal] = await Promise.all([
          getReportsSnapshot({ ...query, principal: `reports-continuous-a-${suffix}` }),
          getReportsSnapshot({ ...query, principal: `reports-continuous-b-${suffix}` })
        ])
        moving = firstPrincipal
        assert.equal(secondPrincipal.cache.builtAt, firstPrincipal.cache.builtAt)
      } else {
        moving = await getReportsSnapshot({
          ...query,
          principal: `reports-continuous-${build % 2 ? 'b' : 'a'}-${suffix}`
        })
      }
      assert.equal(moving.cache.stale, true)
      assert.equal(moving.cache.exactAtBuiltAt, false)
      assert.equal(moving.cache.consistency, 'moving-window')
      assert.ok(Date.parse(moving.cache.revalidateAfter) > Date.now())

      const callsAfterBuild = targetQueries
      const coalesced = await getReportsSnapshot({
        ...query,
        principal: `reports-continuous-other-${build}-${suffix}`
      })
      assert.equal(coalesced.cache.builtAt, moving.cache.builtAt)
      assert.equal(coalesced.cache.stale, true)
      assert.equal(targetQueries, callsAfterBuild, 'waitForFresh no debe iniciar otro build dentro de la ventana')

      await db.run(
        'UPDATE reports_snapshot_cache SET built_at = ? WHERE built_at = ?',
        [
          new Date(Date.now() - REPORTS_SNAPSHOT_CACHE_LIMITS.refreshIntervalMs - 1_000).toISOString(),
          moving.cache.builtAt
        ]
      )
    }

    assert.equal(mutations, 3)
    mutateNextBuild = false
    const exact = await getReportsSnapshot({
      ...query,
      principal: `reports-continuous-final-${suffix}`
    })
    assert.equal(exact.cache.stale, false)
    assert.equal(exact.cache.exactAtBuiltAt, true)
    assert.equal(exact.cache.consistency, 'exact')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM reports_snapshot_cache'
    ))?.total || 0), rowsBefore + 1, 'todos los principals deben compartir una sola fila durable')
  } finally {
    mutateNextBuild = false
    db.all = originalAll
    for (const contactId of insertedContacts) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  }
})

test('cancelar un consumidor no aborta el build compartido que otro consumidor sigue esperando', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()

  const date = '2095-05-10'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const query = {
    principal: `reports-cancel-shared-${suffix}`,
    startDate: date,
    endDate: date,
    groupBy: 'day',
    scope: 'all'
  }
  const started = deferred()
  const release = deferred()
  const internallyAborted = deferred()
  const secondCacheRead = deferred()
  const originalAll = db.all
  const originalGet = db.get
  let targetBuilds = 0
  let cacheReads = 0
  let internalSignal
  let firstRequest
  let secondRequest

  db.get = async (sql, params = [], options = {}) => {
    const result = await originalGet.call(db, sql, params, options)
    if (/FROM reports_snapshot_cache/i.test(String(sql || ''))) {
      cacheReads += 1
      if (cacheReads === 2) secondCacheRead.resolve()
    }
    return result
  }
  db.all = async (sql, params = [], options = {}) => {
    if (isTargetContactAggregate(sql, params, date)) {
      targetBuilds += 1
      internalSignal = options?.signal
      started.resolve()
      await waitForReleaseOrAbort({
        release,
        signal: internalSignal,
        aborted: internallyAborted
      })
    }
    return originalAll.call(db, sql, params, options)
  }

  try {
    const firstController = new AbortController()
    const secondController = new AbortController()
    firstRequest = getReportsSnapshot({ ...query, signal: firstController.signal })
    await started.promise

    secondRequest = getReportsSnapshot({ ...query, signal: secondController.signal })
    await secondCacheRead.promise
    await new Promise(resolve => setImmediate(resolve))
    firstController.abort()

    await assert.rejects(firstRequest, error => (
      error?.name === 'AbortError' && error?.code === 'ABORT_ERR'
    ))
    assert.ok(internalSignal, 'el agregado pesado debe recibir un AbortSignal interno')
    assert.equal(internalSignal.aborted, false)

    release.resolve()
    const snapshot = await secondRequest
    assert.equal(snapshot.cache.stale, false)
    assert.equal(targetBuilds, 1)
  } finally {
    release.resolve()
    db.all = originalAll
    db.get = originalGet
    await Promise.allSettled([firstRequest, secondRequest].filter(Boolean))
  }
})

test('el ultimo consumidor cancelado corta el agregado y un retry no hereda el build abortado', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()

  const date = '2095-05-11'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const query = {
    principal: `reports-cancel-last-${suffix}`,
    startDate: date,
    endDate: date,
    groupBy: 'day',
    scope: 'all'
  }
  const started = deferred()
  const release = deferred()
  const internallyAborted = deferred()
  const originalAll = db.all
  let blockFirstBuild = true
  let targetBuilds = 0
  let request

  db.all = async (sql, params = [], options = {}) => {
    if (isTargetContactAggregate(sql, params, date)) {
      targetBuilds += 1
      if (blockFirstBuild) {
        blockFirstBuild = false
        started.resolve()
        await waitForReleaseOrAbort({
          release,
          signal: options?.signal,
          aborted: internallyAborted
        })
      }
    }
    return originalAll.call(db, sql, params, options)
  }

  try {
    const controller = new AbortController()
    request = getReportsSnapshot({ ...query, signal: controller.signal })
    await started.promise
    controller.abort()

    await assert.rejects(request, error => (
      error?.name === 'AbortError' && error?.code === 'ABORT_ERR'
    ))
    await internallyAborted.promise

    // El entry abortado puede seguir cerrando sus workers unos microtasks. El
    // retry debe reemplazarlo y su finally nunca debe borrar el build nuevo.
    const retry = await getReportsSnapshot(query)
    assert.equal(retry.cache.stale, false)
    assert.equal(targetBuilds, 2)
  } finally {
    release.resolve()
    db.all = originalAll
    await Promise.allSettled([request].filter(Boolean))
  }
})

test('cerrar el HTTP aborta la lectura pesada y el controller no escribe sobre el socket muerto', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await installReportsSnapshotSchema()

  const date = '2095-05-12'
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const started = deferred()
  const release = deferred()
  const internallyAborted = deferred()
  const originalAll = db.all
  let responsePromise

  db.all = async (sql, params = [], options = {}) => {
    if (isTargetContactAggregate(sql, params, date)) {
      started.resolve()
      await waitForReleaseOrAbort({
        release,
        signal: options?.signal,
        aborted: internallyAborted
      })
    }
    return originalAll.call(db, sql, params, options)
  }

  const req = new EventEmitter()
  Object.assign(req, {
    aborted: false,
    query: { from: date, to: date, groupBy: 'day', scope: 'all' },
    user: { id: `reports-http-close-${suffix}` }
  })
  const res = new EventEmitter()
  Object.assign(res, {
    destroyed: false,
    finished: false,
    headersSent: false,
    writable: true,
    writableEnded: false,
    statusCode: 200,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      this.finished = true
      this.writableEnded = true
      return this
    }
  })

  try {
    responsePromise = getReportsSnapshotController(req, res)
    await started.promise
    res.emit('close')
    await responsePromise
    await internallyAborted.promise

    assert.equal(res.payload, undefined)
    assert.equal(res.statusCode, 200)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
  } finally {
    release.resolve()
    db.all = originalAll
    await Promise.allSettled([responsePromise].filter(Boolean))
  }
})
