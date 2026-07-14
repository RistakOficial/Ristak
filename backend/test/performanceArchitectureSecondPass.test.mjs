import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { db, setAppConfig } from '../src/config/database.js'
import { createSession, getSessionsByDateRange } from '../src/services/trackingService.js'
import {
  buildTrackingSearchDocumentExpression,
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsSummary
} from '../src/services/trackingAnalyticsService.js'
import {
  getTrackingAnalyticsCacheRevision,
  invalidateTrackingAnalyticsCache
} from '../src/services/trackingAnalyticsCache.js'
import { getMessageAnalyticsSummary } from '../src/services/originDistributionService.js'
import { updateSessionHandler, deleteSessionsHandler } from '../src/controllers/trackingController.js'
import { migrationRunsForDialect } from '../src/startup/runMigrations.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

function marker(label) {
  return `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
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

test('resumen multicanal conserva contrato con miles de mensajes y respuesta acotada', async () => {
  const prefix = marker('message_sql_scale')
  const range = {
    startUtc: '2096-04-01T00:00:00.000Z',
    endUtc: '2096-04-30T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  try {
    await db.transaction(async tx => {
      for (let index = 0; index < 3_000; index += 1) {
        const timestamp = `2096-04-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`
        await tx.run(`
          INSERT INTO whatsapp_api_messages (
            id, provider, origin, ycloud_message_id, phone, direction,
            message_type, message_text, detected_source_id,
            message_timestamp, created_at, updated_at
          ) VALUES (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, 'inbound',
            'text', 'Hola', ?, ?, ?, ?)
        `, [
          `${prefix}_${String(index).padStart(5, '0')}`,
          `${prefix}_provider_${index}`,
          `+52155${String(index % 75).padStart(8, '0')}`,
          index % 2 === 0 ? `${prefix}_ad` : null,
          timestamp,
          timestamp,
          timestamp
        ])
      }
    })

    const summary = await getMessageAnalyticsSummary(range, { groupBy: 'day' })

    assert.deepEqual(Object.keys(summary), ['metrics', 'trend', 'filters', 'status'])
    assert.deepEqual(Object.keys(summary.metrics), [
      'inboundMessages',
      'conversations',
      'contacts',
      'attributionRate'
    ])
    assert.equal(summary.metrics.inboundMessages, 3_000)
    assert.equal(summary.metrics.conversations, 75)
    assert.ok(summary.trend.length <= 31)
    assert.ok(summary.filters.channels.length <= 4)
    assert.ok(summary.filters.sources.length <= 50)
    assert.ok(JSON.stringify(summary).length < 30_000)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('resumen de mensajes no invoca el cargador legacy de filas crudas', async () => {
  const source = await readFile(
    new URL('../src/services/originDistributionService.js', import.meta.url),
    'utf8'
  )
  const summaryBody = source
    .split('export async function getMessageAnalyticsSummary')[1]
    .split('export async function getWhatsAppApiAnalyticsSummary')[0]

  assert.match(summaryBody, /getMessageAnalyticsAggregateRows/)
  assert.doesNotMatch(summaryBody, /getMessageAnalyticsRows/)
  assert.match(source, /ROW_NUMBER\(\) OVER \(ORDER BY identity_count DESC, label ASC\)/)

  const whatsappLegacySummaryBody = source
    .split('export async function getWhatsAppApiAnalyticsSummary')[1]
    .split('/**\n * Distribución de tráfico')[0]
  assert.doesNotMatch(whatsappLegacySummaryBody, /getWhatsAppApiOriginMessages|new Set\(|messages\.length/)
  assert.match(whatsappLegacySummaryBody, /COUNT\(DISTINCT/)
  assert.match(whatsappLegacySummaryBody, /COUNT\(\*\) AS inbound_messages/)
})

test('tendencia de mensajes agrupa por la zona del negocio y no por UTC', async () => {
  const prefix = marker('message_business_timezone')
  const timestamp = '2096-06-02T05:30:00.000Z'

  try {
    await db.run(`
      INSERT INTO email_messages (
        id, direction, status, from_email, to_email, subject,
        message_timestamp, created_at, updated_at
      ) VALUES (?, 'inbound', 'received', ?, 'owner@example.test', 'Zona', ?, ?, ?)
    `, [`${prefix}_email`, `${prefix}@example.test`, timestamp, timestamp, timestamp])

    const summary = await getMessageAnalyticsSummary({
      startUtc: '2096-06-01T06:00:00.000Z',
      endUtc: '2096-06-02T05:59:59.999Z',
      appliedTimezone: 'America/Ciudad_Juarez'
    }, { groupBy: 'day' })

    assert.deepEqual(summary.trend, [{ label: '2096-06-01', messages: 1 }])
  } finally {
    await db.run('DELETE FROM email_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('invalidación real refresca create, update y delete sin esperar el TTL', async () => {
  const prefix = marker('tracking_cache_invalidation')
  const date = '2097-05-17'
  const timestamp = `${date}T12:00:00.000Z`

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()
  clearTrackingAnalyticsSummaryCache()

  try {
    const empty = await getTrackingAnalyticsSummary({ start: date, end: date })
    assert.equal(empty.metrics.current.pageViews, 0)

    await createSession({
      session_id: `${prefix}_session`,
      visitor_id: `${prefix}_visitor`,
      contact_id: null,
      full_name: null,
      event_name: 'page_view',
      ts: timestamp,
      data: { url: `https://example.test/${prefix}`, device_type: 'desktop' },
      ip: '127.0.0.1',
      user_agent: 'Ristak performance contract test'
    })

    const created = await getTrackingAnalyticsSummary({ start: date, end: date })
    assert.equal(created.metrics.current.pageViews, 1)
    assert.equal(created.metrics.current.uniqueSessions, 1)

    const row = await db.get('SELECT id FROM sessions WHERE session_id = ? LIMIT 1', [`${prefix}_session`])
    assert.ok(row?.id)

    const updateResponse = responseRecorder()
    await updateSessionHandler(
      { params: { id: row.id }, body: { device_type: 'mobile' } },
      updateResponse
    )
    assert.equal(updateResponse.statusCode, 200)

    const updated = await getTrackingAnalyticsSummary({ start: date, end: date })
    assert.equal(updated.metrics.current.pageViews, 1)
    assert.equal(updated.metrics.current.uniqueSessions, 1)
    assert.equal(updated.facets.devices[0]?.value, 'mobile')

    const deleteResponse = responseRecorder()
    await deleteSessionsHandler({ body: { ids: [row.id] } }, deleteResponse)
    assert.equal(deleteResponse.statusCode, 200)

    const deleted = await getTrackingAnalyticsSummary({ start: date, end: date })
    assert.equal(deleted.metrics.current.uniqueSessions, 0)
  } finally {
    clearTrackingAnalyticsSummaryCache()
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('señal de invalidación queda exportable para otros flujos de escritura', () => {
  const before = getTrackingAnalyticsCacheRevision()
  const next = invalidateTrackingAnalyticsCache()
  assert.equal(next, (before + 1) % Number.MAX_SAFE_INTEGER)
  assert.equal(getTrackingAnalyticsCacheRevision(), next)
})

test('el endpoint legacy por rango respeta limit y offset en lugar de materializar todo', async () => {
  const prefix = marker('tracking_range_page')
  const date = '2097-06-18'
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    for (let index = 0; index < 65; index += 1) {
      await createSession({
        session_id: `${prefix}_${String(index).padStart(3, '0')}`,
        visitor_id: `${prefix}_visitor_${index}`,
        event_name: 'page_view',
        ts: `${date}T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        data: { url: `https://example.test/${prefix}/${index}` },
        ip: '127.0.0.1',
        user_agent: 'Ristak bounded range test'
      })
    }

    const firstPage = await getSessionsByDateRange(date, date, { limit: 20, offset: 0 })
    const secondPage = await getSessionsByDateRange(date, date, { limit: 20, offset: 20 })
    assert.equal(firstPage.length, 20)
    assert.equal(secondPage.length, 20)
    assert.equal(firstPage.some(row => secondPage.some(next => next.id === row.id)), false)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('migraciones de rendimiento son aditivas, idempotentes y compatibles con SQLite', async () => {
  const migrations = await Promise.all([
    '../migrations/versioned/050_tracking_performance_indexes.sqlite.sql',
    '../migrations/versioned/051_message_analytics_indexes.sqlite.sql'
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))

  for (const migration of migrations) {
    await db.exec(migration)
    await db.exec(migration)
  }

  const indexes = await db.all(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND name IN (
        'idx_whatsapp_messages_inbound_effective_time',
        'idx_meta_messages_inbound_effective_time',
        'idx_email_messages_inbound_effective_time',
        'idx_whatsapp_attribution_message',
        'idx_sessions_started_at_id',
        'idx_sessions_created_at_id',
        'idx_sessions_contact_started_at_id',
        'idx_sessions_event_started_at_id'
      )
  `)
  assert.equal(indexes.length, 8)
})

test('Postgres usa la misma expresión que el índice pg_trgm y SQLite conserva fallback', async () => {
  const extensionMigration = await readFile(
    new URL('../migrations/versioned/052_tracking_search_pg_trgm.postgres.sql', import.meta.url),
    'utf8'
  )
  const indexMigration = await readFile(
    new URL('../migrations/versioned/053_tracking_search_document_trgm.postgres.sql', import.meta.url),
    'utf8'
  )
  const serviceSource = await readFile(
    new URL('../src/services/trackingAnalyticsService.js', import.meta.url),
    'utf8'
  )
  const concurrentPerformanceMigrations = [
    '050a_sessions_started_at_id.postgres.sql',
    '050b_sessions_created_at_id.postgres.sql',
    '050c_sessions_contact_started_at_id.postgres.sql',
    '050d_sessions_event_started_at_id.postgres.sql',
    '051a_whatsapp_messages_inbound_effective_time.postgres.sql',
    '051b_meta_messages_inbound_effective_time.postgres.sql',
    '051c_email_messages_inbound_effective_time.postgres.sql',
    '051d_whatsapp_attribution_message.postgres.sql'
  ]
  const compactSql = value => value.replace(/\s+/g, '')

  assert.match(extensionMigration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/)
  assert.match(indexMigration, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_search_document_trgm/)
  assert.match(indexMigration, /USING GIN/)
  assert.ok(
    compactSql(indexMigration).includes(compactSql(buildTrackingSearchDocumentExpression())),
    'la expresión consultada debe coincidir literalmente con la expresión indexada'
  )
  assert.match(serviceSource, /column === 'all' && databaseDialect === 'postgres'/)
  assert.match(serviceSource, /LOWER\(COALESCE\(CAST\(\$\{expression\} AS TEXT\), ''\)\) LIKE \?/)
  assert.match(serviceSource, /const STAGE_SEARCH_CHUNK_SIZE = 500/)
  assert.match(serviceSource, /const STAGE_SEARCH_MAX_SCAN = 10_000/)
  assert.match(serviceSource, /tracking-stage-candidate-chunk/)
  assert.doesNotMatch(serviceSource, /candidate_sessions AS/)
  assert.equal(migrationRunsForDialect('052_tracking_search_pg_trgm.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('052_tracking_search_pg_trgm.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('053_tracking_search_document_trgm.postgres.sql', 'sqlite'), false)

  for (const file of concurrentPerformanceMigrations) {
    const sql = await readFile(new URL(`../migrations/versioned/${file}`, import.meta.url), 'utf8')
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1, `${file} debe construir un solo índice concurrente`)
    assert.equal((sql.match(/;/g) || []).length, 1, `${file} debe contener un solo statement`)
    assert.equal(migrationRunsForDialect(file, 'postgres'), true)
    assert.equal(migrationRunsForDialect(file, 'sqlite'), false)
  }
})

test('adsHierarchy se agrega y poda dentro de SQL antes de construir el árbol', async () => {
  const serviceSource = await readFile(
    new URL('../src/services/trackingAnalyticsService.js', import.meta.url),
    'utf8'
  )
  const hierarchyQuery = serviceSource
    .split('async function queryAdsHierarchy')[1]
    .split('async function queryFlatSessionFacets')[0]

  assert.match(serviceSource, /const ADS_HIERARCHY_PLATFORM_LIMIT = 8/)
  assert.match(serviceSource, /const ADS_HIERARCHY_CAMPAIGN_LIMIT = 8/)
  assert.match(serviceSource, /const ADS_HIERARCHY_ADSET_LIMIT = 5/)
  assert.match(serviceSource, /const ADS_HIERARCHY_AD_LIMIT = 5/)
  assert.match(serviceSource, /const ADS_HIERARCHY_GLOBAL_LIMIT = 750/)
  assert.match(hierarchyQuery, /COUNT\(DISTINCT visitor_identity\)/)
  assert.match(hierarchyQuery, /COUNT\(DISTINCT hb\.visitor_identity\)/)
  assert.match(hierarchyQuery, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY cc\.platform_id/)
  assert.match(hierarchyQuery, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY ac\.platform_id, ac\.campaign_id/)
  assert.match(hierarchyQuery, /LIMIT \$\{ADS_HIERARCHY_GLOBAL_LIMIT\}/)
  assert.doesNotMatch(hierarchyQuery, /SELECT\s+fs\.\*/)
})
