import test from 'node:test'
import assert from 'node:assert/strict'

test('PostgreSQL serializes a persistent block with a local booking write and rechecks after commit', { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const connectionString = process.env.TEST_POSTGRES_URL
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname), 'Only a disposable local PostgreSQL is allowed')
  const pg = await import('pg')
  const schema = `contact_blocks_test_${process.pid}_${Date.now()}`
  const admin = new pg.default.Client({ connectionString, ssl: false })
  const OriginalPool = pg.default.Pool
  let database
  let scopedPool
  let releaseWrite
  let write
  let block
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pg.default.Pool = class ScopedPool extends OriginalPool {
      constructor(options) { super({ ...options, ssl: false, options: `${options?.options || ''} -c search_path=${schema}`.trim() }); scopedPool = this }
    }
    process.env.DATABASE_URL = connectionString
    database = await import('../src/config/database.js')
    await database.databaseReady
    const { ensureContactBlocksSchema } = await import('../src/startup/contactBlocksSchema.js')
    await ensureContactBlocksSchema(database.db)
    const { addContactBlock, assertContactNotBlocked, withContactBlockPolicy } = await import('../src/services/contactBlockService.js')
    const { createLocalAppointment } = await import('../src/services/localCalendarService.js')
    const email = 'blocked@example.test'
    await database.db.run('INSERT INTO contacts (id, email) VALUES (?, ?)', ['blocked_test', email])
    let writeStarted
    const startGate = new Promise(resolve => { writeStarted = resolve })
    const releaseGate = new Promise(resolve => { releaseWrite = resolve })
    write = withContactBlockPolicy([{ contactId: 'blocked_test' }], async () => {
      await assertContactNotBlocked({ contactId: 'blocked_test' })
      writeStarted()
      await releaseGate
    })
    await startGate
    let committed = false
    block = addContactBlock({ identityType: 'email', identityValue: email }).then(value => { committed = true; return value })
    // A bounded event-loop window proves the block cannot commit while the
    // already authorized local writer owns the identity lock.
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(committed, false)
    releaseWrite()
    await write
    await block
    await assert.rejects(() => createLocalAppointment({ contactId: 'blocked_test', startTime: '2099-01-01T15:00:00Z', endTime: '2099-01-01T16:00:00Z' }), error => error.code === 'request_unavailable')
    assert.equal(Number((await database.db.get('SELECT COUNT(*) AS n FROM appointments')).n), 0)
  } finally {
    releaseWrite?.()
    await Promise.allSettled([write, block].filter(Boolean))
    await scopedPool?.end()
    pg.default.Pool = OriginalPool
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
