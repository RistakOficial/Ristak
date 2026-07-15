import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import {
  MESSAGE_ANALYTICS_PROJECTION_VERSION,
  queryMessageAnalyticsProjectionAggregateRows,
  readMessageAnalyticsProjectionState,
  runMessageAnalyticsProjectionBackfill
} from '../src/services/messageAnalyticsProjectionService.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

const migrationUrl = new URL('../migrations/versioned/114a_message_analytics_projection.postgres.sql', import.meta.url)
const cursorIndexMigrationUrl = new URL(
  '../migrations/versioned/114b_message_analytics_whatsapp_contact_cursor.postgres.sql',
  import.meta.url
)
const rangeMigrationUrl = new URL('../migrations/versioned/115a_message_analytics_range_rollup.postgres.sql', import.meta.url)
const phoneMigrationUrl = new URL('../migrations/versioned/118a_message_analytics_phone_projection.postgres.sql', import.meta.url)

async function ensureSchema() {
  await db.exec(await readFile(migrationUrl, 'utf8'))
  await db.exec(await readFile(cursorIndexMigrationUrl, 'utf8'))
  await db.exec(await readFile(rangeMigrationUrl, 'utf8'))
  await db.exec(await readFile(phoneMigrationUrl, 'utf8'))
}

async function setTimezone(timezone) {
  await db.run(`
    INSERT INTO app_config(config_key, config_value, created_at, updated_at)
    VALUES ('account_timezone', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [timezone])
  invalidateTimezoneCache()
}

async function resetProjection() {
  await db.run('DELETE FROM message_analytics_change_queue')
  await db.run('DELETE FROM message_analytics_contact_queue')
  await db.run('DELETE FROM message_analytics_generation_gc')
  await db.run('DELETE FROM message_analytics_range_delta')
  await db.run('DELETE FROM message_analytics_phone_range_delta')
  await db.run('DELETE FROM message_analytics_daily_rollup')
  await db.run('DELETE FROM message_analytics_range_generation')
  await db.run('DELETE FROM message_analytics_daily_identity')
  await db.run('DELETE FROM message_analytics_daily_phone_metadata')
  await db.run('DELETE FROM message_analytics_daily_phone_identity')
  await db.run('DELETE FROM message_analytics_phone_fact')
  await db.run('DELETE FROM message_analytics_fact')
  await db.run(`
    UPDATE message_analytics_projection_state
    SET projection_version = ?, status = 'backfilling',
        active_generation = NULL, active_version = NULL, active_timezone = NULL,
        building_generation = NULL, building_version = NULL, building_timezone = NULL,
        whatsapp_cursor = '', meta_cursor = '', email_cursor = '',
        whatsapp_complete = FALSE, meta_complete = FALSE, email_complete = FALSE,
        last_applied_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `, [MESSAGE_ANALYTICS_PROJECTION_VERSION])
}

async function runUntilReady() {
  let result
  for (let attempt = 0; attempt < 100; attempt += 1) {
    result = await runMessageAnalyticsProjectionBackfill({
      batchSize: 2,
      maxBackfillBatches: 1,
      maxQueueBatches: 1
    })
    if (result.ready) return result
  }
  assert.fail(`PostgreSQL no convergió: ${JSON.stringify(result)}`)
}

async function withDeadline(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} excedió ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(label)
}

test('worker PostgreSQL ejecuta backfill, replay, doble generación y query exacta', {
  skip: databaseDialect !== 'postgres',
  concurrency: false,
  timeout: 60_000
}, async () => {
  await ensureSchema()
  await setTimezone('UTC')
  await resetProjection()
  const prefix = `message_pg_${randomUUID().replaceAll('-', '')}`
  const contactId = `${prefix}_contact`
  const waId = `${prefix}_wa`
  const metaId = `${prefix}_meta`
  const emailId = `${prefix}_email`
  const liveId = `${prefix}_live`
  const timestamp = '2201-02-03T05:30:00.000Z'
  const utcRange = {
    startUtc: '2201-02-03T00:00:00.000Z',
    endUtc: '2201-02-03T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  try {
    await db.run(`
      INSERT INTO contacts(id, full_name, email, source, created_at, updated_at)
      VALUES (?, 'Postgres Projection', ?, NULL, ?, ?)
    `, [contactId, `${prefix}@test.invalid`, timestamp, timestamp])
    await db.run(`
      INSERT INTO whatsapp_api_messages(
        id, contact_id, direction, message_type, message_timestamp, created_at, updated_at
      ) VALUES (?, ?, 'inbound', 'text', ?, ?, ?)
    `, [waId, contactId, timestamp, timestamp, timestamp])
    await db.run(`
      INSERT INTO whatsapp_api_attribution(
        id, whatsapp_api_message_id, contact_id, detected_source_url,
        detected_source_id, created_at
      ) VALUES (?, ?, ?, 'https://google.com/ad', ?, CURRENT_TIMESTAMP),
               (?, ?, ?, 'https://instagram.com/ad', ?, CURRENT_TIMESTAMP)
    `, [
      `${prefix}_attr_a`, waId, contactId, `${prefix}_google`,
      `${prefix}_attr_b`, waId, contactId, `${prefix}_instagram`
    ])
    await db.run(`
      INSERT INTO meta_social_messages(
        id, platform, contact_id, sender_id, direction, message_type,
        message_timestamp, created_at, updated_at
      ) VALUES (?, 'instagram', ?, ?, 'inbound', 'text', ?, ?, ?)
    `, [metaId, contactId, `${prefix}_sender`, timestamp, timestamp, timestamp])
    await db.run(`
      INSERT INTO email_messages(
        id, contact_id, direction, from_email, message_timestamp, created_at, updated_at
      ) VALUES (?, ?, 'inbound', ?, ?, ?, ?)
    `, [emailId, contactId, `${prefix}@test.invalid`, timestamp, timestamp, timestamp])

    await runUntilReady()
    let state = await readMessageAnalyticsProjectionState()
    const generation = Number(state.active_generation)
    assert.ok(generation > 0)
    const aggregate = await queryMessageAnalyticsProjectionAggregateRows(utcRange)
    const metrics = aggregate.rows.find(row => row.row_type === 'metrics')
    assert.equal(Number(metrics.count_value), 3)
    assert.equal(Number(metrics.secondary_value), 1)
    assert.equal(Number((await db.get(`
      SELECT SUM(message_count) AS total
      FROM message_analytics_daily_identity
      WHERE generation = ? AND channel = 'whatsapp'
    `, [generation])).total), 1, 'dos attribution siguen siendo un mensaje en PostgreSQL')

    let releaseSnapshot
    let snapshotReached
    const snapshotRelease = new Promise(resolve => { releaseSnapshot = resolve })
    const afterMetrics = new Promise(resolve => { snapshotReached = resolve })
    const snapshotQuery = queryMessageAnalyticsProjectionAggregateRows(utcRange, {
      onAfterMetrics: async () => {
        snapshotReached()
        await snapshotRelease
      }
    })
    await withDeadline(afterMetrics, 3_000, 'summary no llegó después de métricas')
    await withDeadline(
      db.run("UPDATE email_messages SET direction = 'outbound' WHERE id = ?", [emailId]),
      1_000,
      'trigger quedó bloqueado por el snapshot de analytics'
    )
    const snapshotWorker = runMessageAnalyticsProjectionBackfill({
      maxBackfillBatches: 1,
      maxQueueBatches: 1
    })
    try {
      await waitFor(async () => !await db.get(`
        SELECT source_message_id
        FROM message_analytics_change_queue
        WHERE source_kind = 'email' AND source_message_id = ?
      `, [emailId]), 3_000, 'worker no confirmó el CAS antes de liberar el snapshot')
    } finally {
      releaseSnapshot()
    }
    const stableSnapshot = await withDeadline(snapshotQuery, 5_000, 'summary no liberó snapshot')
    const snapshotMetrics = stableSnapshot.rows.find(row => row.row_type === 'metrics')
    const snapshotTrend = stableSnapshot.rows
      .filter(row => row.row_type === 'trend')
      .reduce((sum, row) => sum + Number(row.count_value || 0), 0)
    assert.equal(Number(snapshotMetrics.count_value), 3)
    assert.equal(snapshotTrend, 3, 'metrics y trend pertenecen al mismo snapshot')
    assert.equal(Number(snapshotMetrics.all_messages_value), 3, 'facetas conservan el mismo snapshot')
    await withDeadline(snapshotWorker, 5_000, 'worker no terminó después del snapshot')

    await db.run("UPDATE email_messages SET direction = 'outbound' WHERE id = ?", [emailId])
    await db.run('DELETE FROM meta_social_messages WHERE id = ?', [metaId])
    await runUntilReady()
    const afterMutation = await queryMessageAnalyticsProjectionAggregateRows(utcRange)
    assert.equal(Number(afterMutation.rows.find(row => row.row_type === 'metrics').count_value), 1)

    // El worker puede tardar agregando, pero no debe conservar FOR UPDATE sobre
    // la cola: un replay del mismo mensaje tiene que encolar su nueva revision
    // sin esperar a que termine el batch anterior.
    await db.run('UPDATE email_messages SET from_email = ? WHERE id = ?', [
      `${prefix}+first@test.invalid`, emailId
    ])
    let releaseWorker
    let reachedHook
    const workerReleased = new Promise(resolve => { releaseWorker = resolve })
    const hookReached = new Promise(resolve => { reachedHook = resolve })
    let pausedOnce = false
    const pausedWorker = runMessageAnalyticsProjectionBackfill({
      maxBackfillBatches: 1,
      maxQueueBatches: 1,
      onBeforeQueueCasDelete: async rows => {
        if (pausedOnce || !rows.some(row => row.source_message_id === emailId)) return
        pausedOnce = true
        reachedHook()
        await workerReleased
      }
    })
    await withDeadline(hookReached, 3_000, 'worker no llegó al CAS de cola')
    await withDeadline(db.run('UPDATE email_messages SET from_email = ? WHERE id = ?', [
      `${prefix}+second@test.invalid`, emailId
    ]), 1_000, 'replay quedó bloqueado por el worker')
    releaseWorker()
    await withDeadline(pausedWorker, 5_000, 'worker no liberó el batch')
    const pendingRevision = await db.get(`
      SELECT revision
      FROM message_analytics_change_queue
      WHERE source_kind = 'email' AND source_message_id = ?
    `, [emailId])
    assert.ok(Number(pendingRevision?.revision || 0) >= 2, 'el CAS conserva la revisión concurrente')
    await runUntilReady()

    await setTimezone('America/Ciudad_Juarez')
    await runMessageAnalyticsProjectionBackfill({
      batchSize: 1,
      maxBackfillBatches: 1,
      maxQueueBatches: 1
    })
    state = await readMessageAnalyticsProjectionState()
    const buildingGeneration = Number(state.building_generation)
    assert.equal(Number(state.active_generation), generation)
    assert.ok(buildingGeneration > generation)

    await db.run(`
      INSERT INTO email_messages(
        id, contact_id, direction, from_email, message_timestamp, created_at, updated_at
      ) VALUES (?, ?, 'inbound', ?, ?, ?, ?)
    `, [liveId, contactId, `${prefix}@test.invalid`, timestamp, timestamp, timestamp])
    await runMessageAnalyticsProjectionBackfill({
      batchSize: 1,
      maxBackfillBatches: 1,
      maxQueueBatches: 1
    })
    const dual = await db.all(`
      SELECT generation, COUNT(*) AS total
      FROM message_analytics_fact
      WHERE source_kind = 'email' AND source_message_id = ?
      GROUP BY generation ORDER BY generation
    `, [liveId])
    assert.deepEqual(dual.map(row => [Number(row.generation), Number(row.total)]), [
      [generation, 1],
      [buildingGeneration, 1]
    ])

    await runUntilReady()
    state = await readMessageAnalyticsProjectionState()
    assert.equal(Number(state.active_generation), buildingGeneration)
    assert.equal(state.building_generation, null)
    assert.equal(Number((await db.get(`
      SELECT COUNT(*) AS total
      FROM message_analytics_fact
      WHERE generation = ? AND source_kind = 'email' AND source_message_id = ?
    `, [buildingGeneration, liveId])).total), 1)
  } finally {
    await db.run('DELETE FROM whatsapp_api_attribution WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM email_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await setTimezone('UTC').catch(() => undefined)
  }
})
