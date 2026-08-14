import assert from 'node:assert/strict'

const testPostgresUrl = String(process.env.TEST_POSTGRES_URL || '').trim()

if (!testPostgresUrl) {
  throw new Error('TEST_POSTGRES_URL es requerido para validar una base PostgreSQL nueva.')
}

const parsedUrl = new URL(testPostgresUrl)
const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
if (!localHosts.has(parsedUrl.hostname) && process.env.ALLOW_REMOTE_POSTGRES_BOOTSTRAP_TEST !== '1') {
  throw new Error('La validación de bootstrap sólo puede borrar un schema en PostgreSQL local o efímero.')
}

process.env.DATABASE_URL = testPostgresUrl
process.env.NODE_ENV = 'test'

const pg = await import('pg')
const schema = `fresh_bootstrap_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  .replace(/[^a-z0-9_]/gi, '_')
  .toLowerCase()
const ssl = localHosts.has(parsedUrl.hostname) ? false : { rejectUnauthorized: false }
const admin = new pg.default.Client({ connectionString: testPostgresUrl, ssl })
const OriginalPool = pg.default.Pool
const trackedPools = []
let schemaCreated = false

try {
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true

  pg.default.Pool = class FreshBootstrapPool extends OriginalPool {
    constructor(options) {
      super({
        ...options,
        ...(localHosts.has(parsedUrl.hostname) ? { ssl: false } : {}),
        options: `${options?.options || ''} -c search_path=${schema}`.trim()
      })
      trackedPools.push(this)
    }
  }

  const database = await import('../src/config/database.js')
  const { runVersionedMigrations } = await import('../src/startup/runMigrations.js')

  assert.equal(database.databaseDialect, 'postgres')
  await database.databaseReady

  const view = await database.db.get(`
    SELECT table_name
    FROM information_schema.views
    WHERE table_schema = ? AND table_name = 'contact_effective_ad_attribution'
  `, [schema])
  assert.equal(view?.table_name, 'contact_effective_ad_attribution')

  const repeatedBootstrap = await database.runCoreSchemaBootstrap()
  assert.equal(repeatedBootstrap?.skipped, true)

  await runVersionedMigrations()
  const repeatedMigrations = await runVersionedMigrations()
  assert.equal(repeatedMigrations?.applied, 0)

  const migrations = await database.db.get('SELECT COUNT(*) AS total FROM schema_migrations')
  assert.ok(Number(migrations?.total || 0) > 0)

  // La limpieza histórica descuenta el ledger de métricas por shard dentro de
  // la misma transacción. Esta prueba PostgreSQL real evita publicar una
  // optimización que deje el resumen desfasado o dependa sólo de SQLite.
  const cleanupSuffix = `${process.pid}_${Date.now()}`
  const cleanupContactId = `postgres_cleanup_contact_${cleanupSuffix}`
  const cleanupMessageId = `postgres_cleanup_message_${cleanupSuffix}`
  const cleanupRunKey = `whatsapp:${cleanupContactId}`
  await database.db.run(`
    INSERT INTO ai_agent_pending_reruns (
      run_key, contact_id, channel, scheduled_for, payload, created_at
    ) VALUES (?, ?, 'whatsapp', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
  `, [
    cleanupRunKey,
    cleanupContactId,
    JSON.stringify({
      contactId: cleanupContactId,
      messageId: cleanupMessageId,
      channel: 'whatsapp'
    })
  ])
  for (let index = 0; index < 5; index += 1) {
    await database.db.run(`
      INSERT INTO conversational_agent_events (
        id, contact_id, event_type, detail_json, created_at
      ) VALUES (?, ?, 'agent_not_matched', ?, CURRENT_TIMESTAMP + (? * INTERVAL '1 millisecond'))
    `, [
      `postgres_cleanup_event_${index}_${cleanupSuffix}`,
      cleanupContactId,
      JSON.stringify({ messageId: cleanupMessageId, channel: 'whatsapp' }),
      index
    ])
  }
  for (let index = 0; index < 2; index += 1) {
    const createdOffsetMs = 1_000 + index
    await database.db.run(`
      INSERT INTO conversational_agent_events (
        id, contact_id, event_type, detail_json, created_at
      ) VALUES (?, ?, 'mandatory_handoff_gate_retry_queued', ?,
        CURRENT_TIMESTAMP + (? * INTERVAL '1 millisecond'))
    `, [
      `postgres_cleanup_retry_${index}_${cleanupSuffix}`,
      cleanupContactId,
      JSON.stringify({
        messageId: cleanupMessageId,
        channel: 'whatsapp',
        stage: 'adjudication',
        errorCode: 'handoff_rule_adjudication_failed',
        attemptCount: 1,
        maxAttempts: 3
      }),
      createdOffsetMs
    ])
    await database.db.run(`
      INSERT INTO conversational_agent_events (
        id, contact_id, event_type, detail_json, created_at
      ) VALUES (?, ?, 'error', ?, CURRENT_TIMESTAMP + (? * INTERVAL '1 millisecond'))
    `, [
      `postgres_cleanup_error_${index}_${cleanupSuffix}`,
      cleanupContactId,
      JSON.stringify({
        channel: 'whatsapp',
        message: 'fallo repetido de adjudicación',
        retryQueued: true,
        retryStage: 'adjudication',
        retryAttemptCount: 1
      }),
      createdOffsetMs
    ])
  }

  const summaryBeforeCleanup = await database.db.get(`
    SELECT COALESCE(SUM(total_events), 0) AS total
    FROM conversational_agent_event_metric_summary
  `)
  const cleanupService = await import('../src/services/conversationalAgentRerunGarbageCleanupService.js')
  const cleanupPlan = await cleanupService.buildConversationalRerunGarbageCleanupPlan()
  const cleanupResult = await cleanupService.runConversationalRerunGarbageCleanup(cleanupPlan)
  assert.equal(cleanupResult.cleanup.deleted, 6)

  const cleanupEvidence = await database.db.get(`
    SELECT
      (SELECT COUNT(*) FROM conversational_agent_events WHERE contact_id = ?) AS events,
      (SELECT COUNT(*) FROM conversational_agent_event_metric_rows
       WHERE event_id LIKE ?) AS metric_rows,
      (SELECT COALESCE(SUM(total_events), 0)
       FROM conversational_agent_event_metric_summary) AS summary_total
  `, [cleanupContactId, `postgres_cleanup_%_${cleanupSuffix}`])
  assert.equal(Number(cleanupEvidence.events), 3)
  assert.equal(Number(cleanupEvidence.metric_rows), 3)
  assert.equal(
    Number(cleanupEvidence.summary_total),
    Number(summaryBeforeCleanup.total) - 6
  )

  console.log(`Bootstrap PostgreSQL limpio verificado en schema efímero (${Number(migrations.total)} migraciones registradas).`)
} finally {
  pg.default.Pool = OriginalPool
  await Promise.allSettled(trackedPools.map(pool => pool.end()))
  if (schemaCreated) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  }
  await admin.end().catch(() => undefined)
}
