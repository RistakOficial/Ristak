import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  CAMPAIGN_PERFORMANCE_MATERIALIZED_LIMITS,
  readCampaignPerformanceMaterializedPage,
  readLatestCampaignPerformanceMaterializedPage,
  replaceCampaignPerformanceMaterializedRows
} from '../src/services/campaignPerformanceMaterializationService.js'
import {
  getCachedPaymentListSummary,
  getCachedTransactionQuery,
  PAYMENT_LIST_SUMMARY_CACHE_LIMITS
} from '../src/services/paymentListSummaryCacheService.js'

async function applySqliteMigration(name) {
  const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
  await db.exec(sql)
}

async function campaignRevision() {
  return db.get('SELECT core_revision, visitor_revision FROM campaign_performance_revision WHERE id = 1')
}

test.before(async () => {
  await applySqliteMigration('070_campaign_performance_materialized_cache.sqlite.sql')
  await applySqliteMigration('071_payment_lists_cursor_summary.sqlite.sql')
})

test('las revisiones de campañas cambian sólo por columnas que afectan el resultado', async () => {
  const suffix = randomUUID()
  const adAccountId = `revision_account_${suffix}`
  const contactId = `revision_contact_${suffix}`
  const sessionId = randomUUID()
  const before = await campaignRevision()

  try {
    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, reach, clicks, cpc, cpm
      ) VALUES ('2098-01-01', ?, ?, 'Campaña', ?, 'Conjunto', ?, 'Anuncio', 10, 20, 2, 5, 10)
    `, [adAccountId, `campaign_${suffix}`, `adset_${suffix}`, `ad_${suffix}`])
    let revision = await campaignRevision()
    assert.equal(Number(revision.core_revision), Number(before.core_revision) + 1)

    await db.run('UPDATE meta_ads SET updated_at = CURRENT_TIMESTAMP WHERE ad_account_id = ?', [adAccountId])
    assert.equal(Number((await campaignRevision()).core_revision), Number(revision.core_revision))
    await db.run('UPDATE meta_ads SET spend = spend + 1 WHERE ad_account_id = ?', [adAccountId])
    revision = await campaignRevision()
    assert.equal(Number(revision.core_revision), Number(before.core_revision) + 2)

    await db.run(`
      INSERT INTO contacts (id, full_name, email, phone, attribution_ad_id, created_at, updated_at)
      VALUES (?, 'Contacto', ?, '5550000000', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `${suffix}@example.test`, `ad_${suffix}`])
    revision = await campaignRevision()
    const afterContactInsert = Number(revision.core_revision)
    await db.run("UPDATE contacts SET source = 'unrelated' WHERE id = ?", [contactId])
    assert.equal(Number((await campaignRevision()).core_revision), afterContactInsert)
    await db.run('UPDATE contacts SET email = ? WHERE id = ?', [`changed-${suffix}@example.test`, contactId])
    assert.equal(Number((await campaignRevision()).core_revision), afterContactInsert + 1)

    const beforeSession = await campaignRevision()
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at,
        campaign_id, adset_id, ad_id, page_url
      ) VALUES (?, ?, ?, 'page_view', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, 'https://example.test/a')
    `, [sessionId, `session_${suffix}`, `visitor_${suffix}`, `campaign_${suffix}`, `adset_${suffix}`, `ad_${suffix}`])
    assert.equal(Number((await campaignRevision()).visitor_revision), Number(beforeSession.visitor_revision) + 1)
    await db.run("UPDATE sessions SET page_url = 'https://example.test/b' WHERE id = ?", [sessionId])
    assert.equal(Number((await campaignRevision()).visitor_revision), Number(beforeSession.visitor_revision) + 1)
    await db.run("UPDATE sessions SET campaign_id = campaign_id || '-changed' WHERE id = ?", [sessionId])
    assert.equal(Number((await campaignRevision()).visitor_revision), Number(beforeSession.visitor_revision) + 2)
  } finally {
    await db.run('DELETE FROM sessions WHERE id = ?', [sessionId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [adAccountId]).catch(() => undefined)
  }
})

test('el materializado conserva revisiones anteriores, es atómico, aislado y acotado', async () => {
  const suffix = randomUUID()
  const accountScope = `account:test:${suffix}`
  const otherAccountScope = `account:other:${suffix}`
  const cacheKey = `cache:${suffix}`
  const common = {
    search: '',
    onlyWithResults: false,
    sortBy: 'revenue',
    sortOrder: 'desc',
    pageSize: 20,
    offset: 0
  }

  await replaceCampaignPerformanceMaterializedRows({
    accountScope,
    cacheKey,
    sourceRevision: 'core:1',
    level: 'campaign',
    items: [{ id: 'one', name: 'Uno', revenue: 10, spend: 2 }]
  })
  await replaceCampaignPerformanceMaterializedRows({
    accountScope,
    cacheKey,
    sourceRevision: 'core:2',
    level: 'campaign',
    items: [{ id: 'two', name: 'Dos', revenue: 20, spend: 4 }]
  })

  const revisionOne = await readCampaignPerformanceMaterializedPage({
    accountScope,
    cacheKey,
    sourceRevision: 'core:1',
    ...common
  })
  const revisionTwo = await readCampaignPerformanceMaterializedPage({
    accountScope,
    cacheKey,
    sourceRevision: 'core:2',
    ...common
  })
  assert.equal(revisionOne?.items[0]?.id, 'one')
  assert.equal(revisionTwo?.items[0]?.id, 'two')
  assert.equal((await readLatestCampaignPerformanceMaterializedPage({ accountScope, cacheKey, ...common }))?.sourceRevision, 'core:2')
  assert.equal(await readCampaignPerformanceMaterializedPage({
    accountScope: otherAccountScope,
    cacheKey,
    sourceRevision: 'core:2',
    ...common
  }), null)

  await assert.rejects(replaceCampaignPerformanceMaterializedRows({
    accountScope,
    cacheKey,
    sourceRevision: 'core:2',
    level: 'campaign',
    items: [{ id: 'broken', name: 'No se debe guardar', revenue: 99, nonSerializable: 1n }]
  }))
  assert.equal((await readCampaignPerformanceMaterializedPage({
    accountScope,
    cacheKey,
    sourceRevision: 'core:2',
    ...common
  }))?.items[0]?.id, 'two', 'el reemplazo fallido debe hacer rollback y conservar el snapshot previo')

  for (let index = 0; index < CAMPAIGN_PERFORMANCE_MATERIALIZED_LIMITS.maxEntriesPerAccount + 3; index += 1) {
    await replaceCampaignPerformanceMaterializedRows({
      accountScope,
      cacheKey: `bounded:${suffix}:${index}`,
      sourceRevision: 'core:1',
      level: 'campaign',
      items: []
    })
  }
  const entryCount = await db.get(
    'SELECT COUNT(*) AS total FROM campaign_performance_cache_entries WHERE account_scope = ?',
    [accountScope]
  )
  assert.ok(Number(entryCount.total) <= CAMPAIGN_PERFORMANCE_MATERIALIZED_LIMITS.maxEntriesPerAccount)
})

test('los resúmenes de pagos se reutilizan hasta que una mutación incrementa su revisión', async () => {
  const suffix = randomUUID()
  const subscriptionId = `summary_subscription_${suffix}`
  let builds = 0
  const build = async () => ({ marker: ++builds })

  try {
    const first = await getCachedPaymentListSummary('subscriptions', build)
    const second = await getCachedPaymentListSummary('subscriptions', build)
    assert.deepEqual(second, first)
    assert.equal(builds, 1)

    await db.run(`
      INSERT INTO subscriptions (
        id, name, status, amount, currency, interval_type, interval_count,
        payment_method, payment_provider, payment_mode, created_at, updated_at
      ) VALUES (?, 'Resumen', 'active', 10, 'MXN', 'monthly', 1, 'manual', 'manual', 'live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [subscriptionId])
    const stale = await getCachedPaymentListSummary('subscriptions', build)
    assert.equal(stale.marker, 1)
    assert.equal(stale.cache.stale, true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const afterMutation = await getCachedPaymentListSummary('subscriptions', build)
    assert.equal(afterMutation.marker, 2)
    assert.equal(afterMutation.cache.stale, false)
    assert.equal(builds, 2)
  } finally {
    await db.run('DELETE FROM subscriptions WHERE id = ?', [subscriptionId]).catch(() => undefined)
  }
})

test('cold misses distintos respetan un semáforo global de dos agregados', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  await db.run(`
    INSERT OR IGNORE INTO payment_list_revisions (scope, revision, updated_at)
    VALUES ('transactions', 0, CURRENT_TIMESTAMP)
  `)
  let active = 0
  let maxActive = 0
  let started = 0
  let releaseBuilds
  const release = new Promise(resolve => { releaseBuilds = resolve })

  const requests = Array.from({ length: 8 }, (_, index) => getCachedTransactionQuery(
    `cold_${suffix}_${index}`,
    async () => {
      started += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await release
      active -= 1
      return { index }
    }
  ))
  const settledRequests = Promise.allSettled(requests)

  for (let attempt = 0; attempt < 50 && started < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(started, PAYMENT_LIST_SUMMARY_CACHE_LIMITS.maxConcurrentBuilds)
  assert.equal(maxActive, PAYMENT_LIST_SUMMARY_CACHE_LIMITS.maxConcurrentBuilds)

  releaseBuilds()
  const results = await settledRequests
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  const rejected = results.filter(result => result.status === 'rejected')
  assert.equal(rejected.length, 6)
  assert.ok(rejected.every(result => result.reason?.code === 'payment_summary_busy'))
  assert.equal(maxActive, PAYMENT_LIST_SUMMARY_CACHE_LIMITS.maxConcurrentBuilds)
  assert.equal(PAYMENT_LIST_SUMMARY_CACHE_LIMITS.queuedBuilds, 0)
  assert.equal(PAYMENT_LIST_SUMMARY_CACHE_LIMITS.maxBackgroundBuilds, 1)
  assert.equal(PAYMENT_LIST_SUMMARY_CACHE_LIMITS.buildDeadlineMs, 16_000)
})

test('un mismo hash frío comparte un solo build entre todos sus waiters', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const cacheKey = `coalesce_${suffix}`
  let builds = 0
  let releaseBuild
  const release = new Promise(resolve => { releaseBuild = resolve })

  const first = getCachedTransactionQuery(cacheKey, async () => {
    builds += 1
    await release
    return { marker: 'shared' }
  })

  for (let attempt = 0; attempt < 50 && builds === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(builds, 1)
  const second = getCachedTransactionQuery(cacheKey, async () => {
    builds += 1
    return { marker: 'duplicate' }
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(builds, 1)
  releaseBuild()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.marker, 'shared')
  assert.equal(secondResult.marker, 'shared')
  assert.equal(builds, 1)
})

test('una revalidación stale de pagos siempre deja un carril para una vista fría', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const backgroundKey = `background_${suffix}`
  const coldKey = `foreground_${suffix}`
  await db.run(`
    INSERT OR IGNORE INTO payment_list_revisions (scope, revision, updated_at)
    VALUES ('transactions', 0, CURRENT_TIMESTAMP)
  `)

  await getCachedTransactionQuery(backgroundKey, async () => ({ marker: 'old' }))
  await db.run(`
    UPDATE payment_list_revisions
    SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE scope = 'transactions'
  `)

  let releaseBackground
  const backgroundRelease = new Promise(resolve => { releaseBackground = resolve })
  let backgroundStarted = false
  try {
    const stale = await getCachedTransactionQuery(backgroundKey, async () => {
      backgroundStarted = true
      await backgroundRelease
      return { marker: 'new' }
    })
    for (let attempt = 0; attempt < 50 && !backgroundStarted; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.equal(stale.cache.stale, true)
    assert.equal(backgroundStarted, true)

    const cold = await getCachedTransactionQuery(coldKey, async () => ({ marker: 'foreground' }))
    assert.equal(cold.marker, 'foreground')
    assert.equal(cold.cache.stale, false)
  } finally {
    releaseBackground()
  }

  let fresh = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    fresh = await getCachedTransactionQuery(backgroundKey, async () => ({ marker: 'unexpected-rebuild' }))
    if (!fresh.cache.stale) break
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(fresh?.cache.stale, false)
  assert.equal(fresh?.marker, 'new')
})

test('cancelar el último resumen de pagos aborta el builder y permite un retry limpio', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const cacheKey = `abort_${suffix}`
  const controller = new AbortController()
  let internalSignal = null
  let started = false

  const first = getCachedTransactionQuery(cacheKey, signal => new Promise((resolve, reject) => {
    started = true
    internalSignal = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }), { signal: controller.signal })

  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(started, true)
  controller.abort()
  await assert.rejects(first, error => error?.name === 'AbortError')
  assert.equal(internalSignal?.aborted, true)

  let retried = false
  for (let attempt = 0; attempt < 100 && !retried; attempt += 1) {
    try {
      const result = await getCachedTransactionQuery(cacheKey, async () => ({ retry: true }))
      retried = result.retry === true
    } catch (error) {
      if (error?.code !== 'payment_summary_busy') throw error
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
  assert.equal(retried, true)
})
