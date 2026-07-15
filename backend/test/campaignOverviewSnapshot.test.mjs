import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import {
  campaignOverviewCachePolicy,
  getCampaignOverviewSnapshot
} from '../src/services/campaignOverviewService.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

const sqliteRevisionMigrationUrl = new URL('../migrations/versioned/070_campaign_performance_materialized_cache.sqlite.sql', import.meta.url)
const sqliteOverviewMigrationUrl = new URL('../migrations/versioned/101_campaign_overview_snapshot.sqlite.sql', import.meta.url)
const postgresOverviewMigrationUrl = new URL('../migrations/versioned/101a_campaign_overview_snapshot.postgres.sql', import.meta.url)
const sqliteOverviewIndexMigrationUrl = new URL('../migrations/versioned/101b_campaign_overview_ad_date.sqlite.sql', import.meta.url)
const postgresOverviewIndexMigrationUrl = new URL('../migrations/versioned/101b_campaign_overview_ad_date.postgres.sql', import.meta.url)
const postgresOverviewCoverMigrationUrl = new URL('../migrations/versioned/101c_campaign_overview_date_cover.postgres.sql', import.meta.url)
const overviewServiceUrl = new URL('../src/services/campaignOverviewService.js', import.meta.url)
const metaControllerUrl = new URL('../src/controllers/metaController.js', import.meta.url)
const campaignsPageUrl = new URL('../../frontend/src/pages/Campaigns/Campaigns.tsx', import.meta.url)
const campaignsFrontendServiceUrl = new URL('../../frontend/src/services/campaignsService.ts', import.meta.url)

test.before(async () => {
  await db.exec(await readFile(sqliteRevisionMigrationUrl, 'utf8'))
  await db.exec(await readFile(sqliteOverviewMigrationUrl, 'utf8'))
  await db.exec(await readFile(sqliteOverviewIndexMigrationUrl, 'utf8'))
})

test('Publicidad deriva resumen y gráficas de un snapshot durable sin agregados duplicados', async () => {
  const suffix = randomUUID()
  const accountId = `act_overview_${suffix}`
  const campaignId = `campaign_overview_${suffix}`
  const calendarId = `calendar_overview_${suffix}`
  const rows = [
    { date: '2097-05-08', adId: `ad_prev_${suffix}`, spend: 50, clicks: 5, reach: 100 },
    { date: '2097-05-10', adId: `ad_current_a_${suffix}`, spend: 100, clicks: 10, reach: 200 },
    { date: '2097-05-11', adId: `ad_current_b_${suffix}`, spend: 25, clicks: 2, reach: 50 }
  ]

  await db.run('DELETE FROM app_config WHERE config_key IN (?, ?)', ['account_timezone', 'attribution_calendar_ids'])
  await db.run(
    'INSERT INTO app_config (config_key, config_value) VALUES (?, ?), (?, ?)',
    ['account_timezone', 'UTC', 'attribution_calendar_ids', JSON.stringify([calendarId])]
  )
  invalidateTimezoneCache()

  for (const row of rows) {
    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES (?, ?, ?, 'Overview', ?, 'Overview set', ?, 'Overview ad', ?, ?, ?)
    `, [row.date, accountId, campaignId, `adset_${suffix}`, row.adId, row.spend, row.clicks, row.reach])
  }

  const contacts = [
    { id: `contact_prev_${suffix}`, day: '2097-05-08T12:00:00.000Z', adId: rows[0].adId, purchases: 1, paid: 100 },
    { id: `contact_a_${suffix}`, day: '2097-05-10T12:00:00.000Z', adId: rows[1].adId, purchases: 1, paid: 300 },
    { id: `contact_b_${suffix}`, day: '2097-05-11T12:00:00.000Z', adId: rows[2].adId, purchases: 0, paid: 0 }
  ]
  for (const contact of contacts) {
    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, attribution_ad_id, purchases_count, total_paid,
        created_at, updated_at
      ) VALUES (?, ?, 'Overview contact', ?, ?, ?, ?, ?)
    `, [
      contact.id,
      `${contact.id}@example.invalid`,
      contact.adId,
      contact.purchases,
      contact.paid,
      contact.day,
      contact.day
    ])
  }

  await db.run(`
    INSERT INTO appointments (
      id, calendar_id, contact_id, title, status, appointment_status,
      start_time, end_time, date_added, date_updated
    ) VALUES (?, ?, ?, 'Overview appointment', 'confirmed', 'confirmed', ?, ?, ?, ?)
  `, [
    `appointment_${suffix}`,
    calendarId,
    contacts[1].id,
    contacts[1].day,
    '2097-05-10T12:30:00.000Z',
    contacts[1].day,
    contacts[1].day
  ])
  await db.run(`
    INSERT INTO sessions (
      id, session_id, visitor_id, event_name, started_at, created_at,
      campaign_id, ad_id
    ) VALUES (?, ?, ?, 'page_view', ?, ?, ?, ?)
  `, [
    `session_row_${suffix}`,
    `session_${suffix}`,
    `visitor_${suffix}`,
    contacts[1].day,
    contacts[1].day,
    campaignId,
    rows[1].adId
  ])

  const first = await getCampaignOverviewSnapshot({
    startDate: '2097-05-10',
    endDate: '2097-05-11',
    includeVisitors: true,
    waitForFresh: true
  })
  assert.deepEqual(first.summary, {
    spend: 125,
    spendPrev: 50,
    clicks: 12,
    clicksPrev: 5,
    reach: 250,
    reachPrev: 100,
    leads: 2,
    leadsPrev: 1,
    sales: 1,
    salesPrev: 1,
    revenue: 300,
    revenuePrev: 100,
    roas: 2.4,
    roasPrev: 2
  })
  assert.deepEqual(first.spendOverTime, [
    { label: '2097-05-10', value: 300, value2: 100 },
    { label: '2097-05-11', value: 0, value2: 25 }
  ])
  assert.deepEqual(first.funnelMetrics, [
    { label: '2097-05-10', visitors: 1, leads: 1, appointments: 1, sales: 1 },
    { label: '2097-05-11', visitors: 0, leads: 1, appointments: 0, sales: 0 }
  ])
  assert.equal(first.cache.stale, false)

  // Fuerza una revisión vieja: la primera lectura debe pintar SWR y la segunda
  // compartir la única reconstrucción en curso.
  const staleBuiltAt = new Date(Date.now() - 60_000).toISOString()
  await db.run('UPDATE campaign_overview_snapshots SET built_at = ?', [staleBuiltAt])
  await db.run(
    'UPDATE meta_ads SET spend = spend + 5 WHERE ad_account_id = ? AND date = ?',
    [accountId, '2097-05-11']
  )
  const persistedBeforeSWR = await db.get(
    'SELECT source_revision, built_at FROM campaign_overview_snapshots LIMIT 1'
  )
  const revisionBeforeSWR = await db.get(
    'SELECT core_revision, visitor_revision FROM campaign_performance_revision WHERE id = 1'
  )
  assert.equal(new Date(persistedBeforeSWR?.built_at).toISOString(), staleBuiltAt)
  assert.notEqual(
    String(persistedBeforeSWR?.source_revision || ''),
    `core:${Number(revisionBeforeSWR?.core_revision || 0)}|visitor:${Number(revisionBeforeSWR?.visitor_revision || 0)}`
  )
  const stale = await getCampaignOverviewSnapshot({
    startDate: '2097-05-10',
    endDate: '2097-05-11',
    includeVisitors: true
  })
  assert.equal(stale.cache.stale, true)
  assert.equal(stale.summary.spend, 125)

  const fresh = await getCampaignOverviewSnapshot({
    startDate: '2097-05-10',
    endDate: '2097-05-11',
    includeVisitors: true,
    waitForFresh: true
  })
  assert.equal(fresh.cache.stale, false)
  assert.equal(fresh.summary.spend, 130)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => getCampaignOverviewSnapshot({
      startDate: '2097-05-10',
      endDate: '2097-05-11',
      signal: controller.signal
    }),
    error => error?.name === 'AbortError'
  )
})

test('el contrato unificado reemplaza tres endpoints y cancela lecturas abandonadas', async () => {
  const [
    service,
    controller,
    page,
    frontendService,
    sqliteMigration,
    postgresMigration,
    sqliteIndexMigration,
    postgresIndexMigration,
    postgresCoverMigration
  ] = await Promise.all([
    readFile(overviewServiceUrl, 'utf8'),
    readFile(metaControllerUrl, 'utf8'),
    readFile(campaignsPageUrl, 'utf8'),
    readFile(campaignsFrontendServiceUrl, 'utf8'),
    readFile(sqliteOverviewMigrationUrl, 'utf8'),
    readFile(postgresOverviewMigrationUrl, 'utf8'),
    readFile(sqliteOverviewIndexMigrationUrl, 'utf8'),
    readFile(postgresOverviewIndexMigrationUrl, 'utf8'),
    readFile(postgresOverviewCoverMigrationUrl, 'utf8')
  ])

  assert.match(service, /Cuatro scans acotados sustituyen once agregados solapados/)
  assert.match(service, /campaign_overview_snapshots/)
  assert.match(service, /overviewBuilds/)
  assert.match(service, /withOverviewBuildSlot/)
  assert.match(service, /record\.controller\.abort\(\)/)
  assert.match(service, /cached && !waitForFresh/)
  assert.match(service, /WHERE m\.date >= \?/)
  assert.doesNotMatch(service, /metaDateExpression\('m\.date'\)/)
  assert.match(controller, /getCampaignOverviewSnapshot/)
  assert.match(controller, /createClientAbortScope/)
  assert.match(frontendService, /getOverviewSnapshot/)
  assert.match(page, /snapshot\.cache\?\.stale/)
  assert.match(page, /overviewAbortRef\.current\?\.abort\(\)/)
  assert.match(page, /entityAbortRef\.current\?\.abort\(\)/)
  assert.doesNotMatch(page, /reportsService\.getCampaignsReport/)
  assert.doesNotMatch(page, /campaignsService\.getSpendOverTime/)
  assert.doesNotMatch(page, /campaignsService\.getFunnelMetrics/)
  assert.doesNotMatch(page, /return <Loading message="Cargando campañas/)
  assert.match(sqliteMigration, /PRIMARY KEY \(account_scope, cache_key\)/)
  assert.match(postgresMigration, /TIMESTAMPTZ NOT NULL/)
  assert.match(sqliteIndexMigration, /idx_meta_ads_ad_date/)
  assert.match(postgresIndexMigration, /CREATE INDEX CONCURRENTLY/)
  assert.match(postgresCoverMigration, /INCLUDE \(spend, clicks, reach\)/)
  assert.equal(campaignOverviewCachePolicy.maxConcurrentBuilds, 2)
})

test('Publicidad limita builds simultaneos y cancela el build frio sin consumidores', async () => {
  const originalAll = db.all
  let activeQueries = 0
  let maxActiveQueries = 0
  db.all = async (sql, params, options) => {
    const tracked = /FROM meta_ads m|FROM contacts c/.test(String(sql))
    if (!tracked) return originalAll(sql, params, options)
    activeQueries += 1
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
    try {
      await new Promise(resolve => setTimeout(resolve, 35))
      return await originalAll(sql, params, options)
    } finally {
      activeQueries -= 1
    }
  }

  try {
    await Promise.all([
      ['2094-01-01', '2094-01-02'],
      ['2094-02-01', '2094-02-02'],
      ['2094-03-01', '2094-03-02']
    ].map(([startDate, endDate]) => getCampaignOverviewSnapshot({
      startDate,
      endDate,
      includeVisitors: false,
      waitForFresh: true
    })))
  } finally {
    db.all = originalAll
  }

  // Cada build abre tres agregados en paralelo (ads, contactos y citas). Dos
  // slots permiten seis; un tercer build sin limite produciria nueve.
  assert.ok(maxActiveQueries > 3)
  assert.ok(maxActiveQueries <= 6, `se observaron ${maxActiveQueries} queries simultaneas`)

  const cacheRowsBefore = Number((await db.get(
    'SELECT COUNT(*) AS total FROM campaign_overview_snapshots'
  ))?.total || 0)
  let trackedStarted = 0
  let trackedFinished = 0
  let sawInternalAbort = false
  let resolveStarted
  let resolveFinished
  const started = new Promise(resolve => { resolveStarted = resolve })
  const finished = new Promise(resolve => { resolveFinished = resolve })
  db.all = async (sql, params, options) => {
    const tracked = /FROM meta_ads m|FROM contacts c/.test(String(sql))
    if (!tracked) return originalAll(sql, params, options)
    trackedStarted += 1
    resolveStarted()
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (options?.signal?.aborted) sawInternalAbort = true
      return await originalAll(sql, params, options)
    } finally {
      trackedFinished += 1
      if (trackedFinished >= 3) resolveFinished()
    }
  }

  try {
    const controller = new AbortController()
    const pending = getCampaignOverviewSnapshot({
      startDate: '2093-01-01',
      endDate: '2093-01-02',
      includeVisitors: false,
      waitForFresh: true,
      signal: controller.signal
    })
    await started
    controller.abort()
    await assert.rejects(pending, error => error?.name === 'AbortError')
    await finished
  } finally {
    db.all = originalAll
  }

  assert.equal(trackedStarted, 3)
  assert.equal(sawInternalAbort, true)
  assert.equal(Number((await db.get(
    'SELECT COUNT(*) AS total FROM campaign_overview_snapshots'
  ))?.total || 0), cacheRowsBefore)
})
