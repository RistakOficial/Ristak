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

  console.log(`Bootstrap PostgreSQL limpio verificado en schema efímero (${Number(migrations.total)} migraciones registradas).`)
} finally {
  pg.default.Pool = OriginalPool
  await Promise.allSettled(trackedPools.map(pool => pool.end()))
  if (schemaCreated) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  }
  await admin.end().catch(() => undefined)
}
