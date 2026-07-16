import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { DateTime } from 'luxon'

import { databaseDialect, db } from '../src/config/database.js'
import {
  canUseTrackingAnalyticsProjection,
  queryTrackingAnalyticsProjectionFacet,
  queryTrackingAnalyticsProjectionSessionMetrics
} from '../src/services/trackingAnalyticsProjectionQueryService.js'
import {
  getTrackingAnalyticsProjectionStatus,
  runTrackingAnalyticsProjectionBackfill
} from '../src/services/trackingAnalyticsProjectionService.js'
import { getAccountTimezone, resolveTimezone } from '../src/utils/dateUtils.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

function uniquePrefix() {
  return `analytics_projection_query_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

test('el read model conserva únicos, recurrentes, series, filtros y distribuciones', async () => {
  await runVersionedMigrations()
  const prefix = uniquePrefix()
  const timezone = resolveTimezone(await getAccountTimezone())
  const startDate = '2094-04-10'
  const endDate = '2094-04-11'
  const emptyContactDate = '2094-04-12'
  const emptySessionDate = '2094-04-13'
  const at = (date, hour, minute = 0) => DateTime
    .fromISO(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`, { zone: timezone })
    .toUTC()
    .toISO()

  const rows = [
    {
      id: randomUUID(), sessionId: `${prefix}_session_1`, visitorId: `${prefix}_visitor_1`,
      contactId: null, event: 'page_view', startedAt: at(startDate, 9),
      pageUrl: 'https://example.test/inicio?uno=1', source: 'newsletter', device: 'desktop', browser: 'Chrome'
    },
    {
      id: randomUUID(), sessionId: `${prefix}_session_1`, visitorId: `${prefix}_visitor_1`,
      contactId: null, event: 'page_view', startedAt: at(startDate, 9, 5),
      pageUrl: 'https://example.test/precios?dos=2', source: 'newsletter', device: 'desktop', browser: 'Chrome'
    },
    {
      id: randomUUID(), sessionId: `${prefix}_session_2`, visitorId: `${prefix}_visitor_1`,
      contactId: null, event: 'page_view', startedAt: at(endDate, 10),
      pageUrl: 'https://example.test/inicio?tres=3', source: 'google', device: 'mobile', browser: 'Safari'
    },
    {
      id: randomUUID(), sessionId: `${prefix}_session_3`, visitorId: `${prefix}_visitor_2`,
      contactId: `${prefix}_contact_2`, event: 'page_view', startedAt: at(endDate, 11),
      pageUrl: 'https://example.test/contacto', source: 'google', device: 'mobile', browser: 'Safari'
    },
    {
      id: randomUUID(), sessionId: `${prefix}_session_3`, visitorId: `${prefix}_visitor_2`,
      contactId: `${prefix}_contact_2`, event: 'native_site_conversion', startedAt: at(endDate, 11, 5),
      pageUrl: 'https://example.test/contacto', source: 'google', device: 'mobile', browser: 'Safari'
    },
    {
      id: randomUUID(), sessionId: `${prefix}_session_4`, visitorId: `${prefix}_visitor_3`,
      contactId: '', event: 'page_view', startedAt: at(emptyContactDate, 12),
      pageUrl: 'https://example.test/vacio', source: 'fb', device: 'desktop', browser: 'Firefox'
    },
    {
      id: randomUUID(), sessionId: '', visitorId: `${prefix}_visitor_4`,
      contactId: null, event: 'page_view', startedAt: at(emptySessionDate, 13),
      pageUrl: 'https://example.test/sesion-vacia', source: 'direct-test', device: 'desktop', browser: 'Firefox'
    }
  ]

  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, visitor_id, source, created_at, updated_at)
      VALUES (?, 'Contacto de prueba', ?, 'tracking', ?, ?)
    `, [
      `${prefix}_contact_2`,
      `${prefix}_visitor_2`,
      at(endDate, 11),
      at(endDate, 11)
    ])
    // Algunas instalaciones legacy sí conservan el string vacío como FK. El
    // contrato histórico lo cuenta una vez, distinto de NULL.
    await db.run(`
      INSERT INTO contacts (id, full_name, visitor_id, source, created_at, updated_at)
      VALUES ('', 'Contacto vacío legacy', ?, 'tracking', ?, ?)
    `, [
      `${prefix}_visitor_3`,
      at(emptyContactDate, 12),
      at(emptyContactDate, 12)
    ])
    for (const row of rows) {
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, event_name, started_at,
          page_url, utm_source, device_type, browser, placement
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        row.id,
        row.sessionId,
        row.visitorId,
        row.contactId,
        row.event,
        row.startedAt,
        row.pageUrl,
        row.source,
        row.device,
        row.browser,
        row.device === 'mobile' ? 'feed' : 'search'
      ])
    }

    await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 100,
      maxQueueBatches: 100,
      yieldMs: 0
    })
    const status = await getTrackingAnalyticsProjectionStatus()
    assert.equal(status.available, true)
    assert.equal(status.pending, false)

    const range = { startDate, endDate, timezone }
    const result = await queryTrackingAnalyticsProjectionSessionMetrics(
      range,
      {},
      'day',
      { includeSeries: true }
    )
    assert.equal(result.readPath, 'tracking_analytics_range_delta_v2')

    assert.deepEqual(result.metrics, {
      pageViews: 4,
      uniqueVisitors: 2,
      uniqueSessions: 3,
      identifiedContacts: 1,
      returningUsers: 1
    })
    assert.deepEqual(result.series, [
      {
        period: startDate,
        pageViews: 2,
        uniqueVisitors: 1,
        uniqueSessions: 1,
        identifiedContacts: 0,
        returningUsers: 0
      },
      {
        period: endDate,
        pageViews: 2,
        uniqueVisitors: 2,
        uniqueSessions: 2,
        identifiedContacts: 1,
        returningUsers: 0
      }
    ])
    const filtered = await queryTrackingAnalyticsProjectionSessionMetrics(
      range,
      { page_url: ['https://example.test/inicio'] },
      'day',
      { includeSeries: false }
    )
    assert.equal(filtered.readPath, 'tracking_analytics_presence_filtered')
    assert.equal(filtered.metrics.pageViews, 2)
    assert.equal(filtered.metrics.uniqueVisitors, 1)
    assert.equal(filtered.metrics.identifiedContacts, 0, 'contact_id NULL no cuenta como identificado')

    const combinedFilter = await queryTrackingAnalyticsProjectionSessionMetrics(
      range,
      { utm_source: ['newsletter'], device_type: ['desktop'] },
      'day',
      { includeSeries: false }
    )
    assert.equal(combinedFilter.readPath, 'tracking_analytics_presence_filtered')
    assert.equal(combinedFilter.metrics.pageViews, 2)
    assert.equal(combinedFilter.metrics.uniqueVisitors, 1)

    const newsletterAlias = await queryTrackingAnalyticsProjectionSessionMetrics(
      range,
      { utm_source: ['newsletter'] },
      'day',
      { includeSeries: false }
    )
    assert.equal(newsletterAlias.metrics.pageViews, 2)
    assert.equal(newsletterAlias.metrics.identifiedContacts, 0)

    const emptyContactAlias = await queryTrackingAnalyticsProjectionSessionMetrics(
      { startDate: emptyContactDate, endDate: emptyContactDate, timezone },
      { utm_source: ['fb'] },
      'day',
      { includeSeries: true }
    )
    assert.equal(emptyContactAlias.metrics.pageViews, 1)
    assert.equal(emptyContactAlias.metrics.identifiedContacts, 1, "contact_id='' conserva el bucket legacy")
    assert.equal(emptyContactAlias.series[0]?.identifiedContacts, 1)

    const emptySession = await queryTrackingAnalyticsProjectionSessionMetrics(
      { startDate: emptySessionDate, endDate: emptySessionDate, timezone },
      { page_url: ['https://example.test/sesion-vacia'] },
      'day',
      { includeSeries: true }
    )
    assert.equal(emptySession.metrics.uniqueSessions, 1, "session_id='' cuenta una vez como en legacy")
    assert.equal(emptySession.metrics.identifiedContacts, 0)
    assert.equal(emptySession.series[0]?.uniqueSessions, 1)

    const emptyRange = await queryTrackingAnalyticsProjectionSessionMetrics(
      { startDate: '2094-05-01', endDate: '2094-05-31', timezone },
      {},
      'day',
      { includeSeries: true }
    )
    assert.deepEqual(emptyRange.series, [], 'la API conserva la serie legacy dispersa')

    const devices = await queryTrackingAnalyticsProjectionFacet(range, {}, 'devices')
    assert.deepEqual(devices.map(item => [item.value, item.count]), [
      ['mobile', 2],
      ['desktop', 1]
    ])
    const sources = await queryTrackingAnalyticsProjectionFacet(range, {}, 'sources')
    assert.deepEqual(sources.map(item => [item.value, item.count]), [
      ['Google', 2],
      ['Email', 1]
    ])
    const topVisitors = await queryTrackingAnalyticsProjectionFacet(range, {}, 'topVisitors')
    assert.equal(topVisitors[0].count, 3)
    const nativeConversions = await queryTrackingAnalyticsProjectionFacet(range, {}, 'nativeConversions')
    assert.equal(nativeConversions.reduce((total, item) => total + item.count, 0), 1)
    const adsHierarchy = await queryTrackingAnalyticsProjectionFacet(range, {}, 'adsHierarchy')
    assert.deepEqual(
      adsHierarchy.map(platform => [platform.platform_id, platform.count]),
      [['Google', 2], ['Email', 1]]
    )
  } finally {
    await db.run(
      `DELETE FROM sessions WHERE id IN (${rows.map(() => databaseDialect === 'postgres' ? '?::uuid' : '?').join(', ')})`,
      rows.map(row => row.id)
    )
    await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 100,
      maxQueueBatches: 100,
      yieldMs: 0
    })
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [`${prefix}_contact_2`, ''])
  }
})

test('el cutover rechaza filtros cuya semántica no vive en la proyección', () => {
  assert.equal(canUseTrackingAnalyticsProjection({ device_type: ['mobile'] }), true)
  assert.equal(canUseTrackingAnalyticsProjection({ message_source: ['whatsapp'] }), true)
  assert.equal(
    canUseTrackingAnalyticsProjection({ conversion_stage: ['customer'] }),
    true,
    'conversion_stage cruza los facts 113+116 sin volver a sessions/contacts crudos'
  )
  assert.equal(canUseTrackingAnalyticsProjection({}, { facetDimension: 'nativeConversions' }), true)
  assert.equal(canUseTrackingAnalyticsProjection({}, { facetDimension: 'adsHierarchy' }), true)
})

test('conversion_stage usa el camino contact-first y sus índices de cobertura', async () => {
  const [querySource, postgresPresenceIndex, postgresStageIndex] = await Promise.all([
    readFile(new URL('../src/services/trackingAnalyticsProjectionQueryService.js', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/113b_tracking_analytics_presence_contact_date.postgres.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/116b_tracking_conversion_stage_contact.postgres.sql', import.meta.url), 'utf8')
  ])

  assert.match(querySource, /useContactDrivenStagePath/)
  assert.match(querySource, /CROSS JOIN LATERAL/)
  assert.match(querySource, /contact_presence\.contact_key = conversion_fact\.contact_id/)
  assert.match(querySource, /contact_presence\.business_date >= \?/)
  assert.match(querySource, /OFFSET 0/)
  assert.match(postgresPresenceIndex, /\(contact_key, business_date\)/i)
  assert.match(postgresPresenceIndex, /INCLUDE \(visitor_key, session_key, dimension_key, event_count, view_count\)/i)
  assert.match(postgresStageIndex, /\(stage, contact_id\)/i)
})

test('la serie máxima conserva sus 400 puntos solicitados sin exceder 900 binds', {
  concurrency: false
}, async () => {
  await runVersionedMigrations()
  const originalAll = db.all
  const rangeDeltaBindCounts = []
  db.all = async function observedRangeDeltaBatch(...args) {
    if (/WITH requested_periods/i.test(String(args[0] || ''))) {
      rangeDeltaBindCounts.push(args[1]?.length || 0)
    }
    return originalAll.apply(this, args)
  }

  try {
    const startDate = '2090-01-01'
    const endDate = DateTime.fromISO(startDate, { zone: 'UTC' })
      .plus({ days: 399 })
      .toISODate()
    const result = await queryTrackingAnalyticsProjectionSessionMetrics(
      { startDate, endDate, timezone: 'UTC' },
      {},
      'day',
      { includeSeries: true }
    )

    assert.equal(result.readPath, 'tracking_analytics_range_delta_v2')
    assert.deepEqual(rangeDeltaBindCounts, [900, 303])
    assert.equal(
      rangeDeltaBindCounts.reduce((total, count) => total + count, 0),
      (400 + 1) * 3,
      'los 400 periodos y __metric__ deben llegar al reader'
    )
    assert.equal(Math.max(...rangeDeltaBindCounts) <= 900, true)
  } finally {
    db.all = originalAll
  }
})

test('el reader global tiene índices por rango portables y PostgreSQL concurrente aislado', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await runVersionedMigrations()
  const [sqliteMigration, postgresMigration] = await Promise.all([
    readFile(new URL('../migrations/versioned/120b_tracking_analytics_range_query.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/120b_tracking_analytics_range_query.postgres.sql', import.meta.url), 'utf8')
  ])

  assert.match(
    sqliteMigration,
    /tracking_analytics_range_delta\s*\(start_boundary, occurrence_date, entity_type, range_delta\)/i
  )
  assert.match(postgresMigration, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_analytics_range_query/i)
  assert.match(
    postgresMigration,
    /tracking_analytics_range_delta\s*\(start_boundary, occurrence_date, entity_type\)\s*INCLUDE \(range_delta\)/i
  )
  assert.equal(
    postgresMigration.split(';').filter(statement => statement.trim()).length,
    1,
    'CREATE INDEX CONCURRENTLY debe vivir solo en su archivo'
  )
  assert.doesNotMatch(postgresMigration, /\bBEGIN\b|\bCOMMIT\b/i)

  const plan = await db.all(`
    EXPLAIN QUERY PLAN
    WITH requested_periods(period, start_date, end_date) AS (
      VALUES ('2090-01-01', '2090-01-01', '2090-01-01')
    )
    SELECT requested.period, SUM(delta.range_delta)
    FROM requested_periods requested
    LEFT JOIN tracking_analytics_range_delta delta
      ON delta.start_boundary <= requested.start_date
     AND delta.occurrence_date <= requested.end_date
    GROUP BY requested.period
  `)
  assert.match(
    plan.map(row => String(row.detail || '')).join('\n'),
    /idx_tracking_analytics_range_query/i,
    'SQLite debe resolver el join por el índice de rango, no por scan total'
  )
})

test('la generación de state deja v3 sin autoridad y permite un único reset de v4', {
  skip: databaseDialect !== 'sqlite',
  concurrency: false
}, async () => {
  await runVersionedMigrations()
  const objects = await db.all(`
    SELECT name, type
    FROM sqlite_master
    WHERE name IN ('tracking_analytics_projection_state', 'tracking_analytics_projection_state_v4')
    ORDER BY name
  `)
  assert.deepEqual(objects, [
    { name: 'tracking_analytics_projection_state', type: 'view' },
    { name: 'tracking_analytics_projection_state_v4', type: 'table' }
  ])
  assert.equal(
    Number((await db.get('SELECT COUNT(*) AS count FROM tracking_analytics_projection_state'))?.count),
    0,
    'el binario v3 debe leer una vista vacía'
  )

  const sentinel = `rolling_fence_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const stableSentinel = `${sentinel}_stable`
  try {
    await db.run(
      'INSERT INTO tracking_analytics_dimensions(dimension_key) VALUES (?)',
      [sentinel]
    )
    const legacyAttempt = await db.transaction(async transaction => {
      const legacyState = await transaction.get(`
        SELECT projection_version
        FROM tracking_analytics_projection_state
        WHERE singleton_id = 1
      `)
      if (!legacyState) return { unavailable: true, deleted: false }
      await transaction.run('DELETE FROM tracking_analytics_dimensions')
      return { unavailable: false, deleted: true }
    })
    assert.deepEqual(legacyAttempt, { unavailable: true, deleted: false })
    assert.ok(
      await db.get('SELECT dimension_key FROM tracking_analytics_dimensions WHERE dimension_key = ?', [sentinel]),
      'v3 debe salir antes de su primer DELETE'
    )

    const timezone = resolveTimezone(await getAccountTimezone())
    await db.run(`
      UPDATE tracking_analytics_projection_state_v4
      SET projection_version = 3,
          account_timezone = ?,
          status = 'backfilling',
          backfill_cursor = NULL,
          backfill_complete = 0,
          range_status = 'pending',
          range_compile_cursor = NULL,
          range_backfill_complete = 0
      WHERE singleton_id = 1
    `, [timezone])

    let upgraded = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      upgraded = await runTrackingAnalyticsProjectionBackfill({
        batchSize: 100,
        queueBatchSize: 100,
        maxBatches: 100,
        maxQueueBatches: 100,
        maxRangeBatches: 100,
        maxReturningRepairBatches: 100,
        yieldMs: 0
      })
      if (upgraded.ready) break
    }
    assert.equal(upgraded?.ready, true)
    assert.equal(
      Number((await db.get(`
        SELECT projection_version
        FROM tracking_analytics_projection_state_v4
        WHERE singleton_id = 1
      `))?.projection_version),
      4
    )
    assert.equal(
      await db.get('SELECT dimension_key FROM tracking_analytics_dimensions WHERE dimension_key = ?', [sentinel]),
      null,
      'v4 sí ejecuta el reset limpio una vez que posee su state generacional'
    )

    await db.run(
      'INSERT INTO tracking_analytics_dimensions(dimension_key) VALUES (?)',
      [stableSentinel]
    )
    const steady = await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 1,
      maxQueueBatches: 1,
      maxRangeBatches: 1,
      maxReturningRepairBatches: 1,
      yieldMs: 0
    })
    assert.equal(steady.ready, true)
    assert.ok(
      await db.get('SELECT dimension_key FROM tracking_analytics_dimensions WHERE dimension_key = ?', [stableSentinel]),
      'una corrida v4 estable no repite el reset destructivo'
    )
  } finally {
    await db.run(
      'DELETE FROM tracking_analytics_dimensions WHERE dimension_key IN (?, ?)',
      [sentinel, stableSentinel]
    )
  }
})

test('v4 separa source/filtro y publica un fence generacional para rolling deploy', async () => {
  const [projectionSource, rangeSource, sqliteMigration, postgresMigration] = await Promise.all([
    readFile(new URL('../src/services/trackingAnalyticsProjectionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/trackingAnalyticsRangeRollupService.js', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/120_tracking_analytics_identity_source_parity.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/120a_tracking_analytics_identity_source_parity.postgres.sql', import.meta.url), 'utf8')
  ])

  assert.match(projectionSource, /TRACKING_ANALYTICS_PROJECTION_VERSION = 4/)
  assert.match(projectionSource, /source_filter_value: sourceFilterValue\(row\)/)
  assert.match(projectionSource, /projectedContactKey\(row\.contact_id\)/)
  assert.match(projectionSource, /projectedSessionKey\(row\.session_id\)/)
  assert.match(projectionSource, /tracking_analytics_projection_state_v4/)
  assert.match(rangeSource, /tracking_analytics_projection_state_v4/)
  assert.match(rangeSource, /WHERE view_count > 0 AND contact_key != ''/)
  for (const migration of [sqliteMigration, postgresMigration]) {
    assert.match(migration, /ADD COLUMN(?: IF NOT EXISTS)? source_filter_value/i)
    assert.match(migration, /RENAME TO tracking_analytics_projection_state_v4/i)
    assert.match(migration, /CREATE VIEW tracking_analytics_projection_state AS/i)
    assert.match(migration, /UPDATE tracking_analytics_projection_state_v4/i)
    assert.match(migration, /SET projection_version = 4/i)
    assert.doesNotMatch(migration, /DELETE\s+FROM/i, 'la migración no ejecuta el rebuild dentro del deploy')
  }
  assert.match(sqliteMigration, /WHERE 0/i)
  assert.match(postgresMigration, /WHERE FALSE/i)
  assert.match(postgresMigration, /pg_advisory_xact_lock\(-6793680755275321734\)/)
  assert.ok(
    postgresMigration.indexOf('pg_advisory_xact_lock') < postgresMigration.indexOf('RENAME TO'),
    'PostgreSQL debe drenar v3 antes de publicar el state generacional'
  )
})
