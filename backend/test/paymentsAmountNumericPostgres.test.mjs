import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const postgresUrl = String(process.env.TEST_POSTGRES_URL || '').trim()

test('041 convierte payments.amount de REAL a NUMERIC(20,6) sin perder filas', {
  skip: !postgresUrl
}, async () => {
  const client = new pg.Client({ connectionString: postgresUrl })
  const schema = `ristak_amount_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const shadowSchema = `${schema}_shadow`
  const quotedSchema = `"${schema}"`
  const quotedShadowSchema = `"${shadowSchema}"`
  const migration = await readFile(
    new URL('../migrations/versioned/041_payments_amount_numeric.postgres.sql', import.meta.url),
    'utf8'
  )

  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`)
    await client.query(`CREATE SCHEMA ${quotedShadowSchema}`)
    // El primer esquema existe, pero payments vive en el segundo. La migracion
    // debe seguir la resolucion real del search_path, no current_schema().
    await client.query(`SET search_path TO ${quotedShadowSchema}, ${quotedSchema}`)
    await client.query(`CREATE TABLE ${quotedSchema}.payments (id TEXT PRIMARY KEY, amount REAL)`)

    for (let index = 0; index < 43; index += 1) {
      const amount = index === 0 ? null : (index * 17.1234567) + 0.0000004
      await client.query('INSERT INTO payments (id, amount) VALUES ($1, $2)', [`pay_${index}`, amount])
    }

    const before = await client.query(
      'SELECT id, amount::NUMERIC(20, 6)::TEXT AS expected FROM payments ORDER BY id'
    )
    const initialLockTimeout = (await client.query('SHOW lock_timeout')).rows[0].lock_timeout

    const blocker = new pg.Client({ connectionString: postgresUrl })
    await blocker.connect()
    try {
      await blocker.query(`SET search_path TO ${quotedShadowSchema}, ${quotedSchema}`)
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE payments IN ACCESS SHARE MODE')

      const lockStartedAt = Date.now()
      await assert.rejects(
        client.query(migration),
        (error) => error?.code === '55P03'
      )
      const lockWaitMs = Date.now() - lockStartedAt
      assert.ok(lockWaitMs >= 4_000 && lockWaitMs < 8_000, `lock_timeout inesperado: ${lockWaitMs}ms`)
      assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, initialLockTimeout)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
    }

    assert.equal((await client.query('SELECT COUNT(*)::INTEGER AS total FROM payments')).rows[0].total, 43)
    await client.query(migration)

    const column = await client.query(
      `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'payments' AND column_name = 'amount'`,
      [schema]
    )
    assert.deepEqual(column.rows[0], {
      data_type: 'numeric',
      numeric_precision: 20,
      numeric_scale: 6
    })

    const after = await client.query('SELECT id, amount::TEXT AS amount FROM payments ORDER BY id')
    assert.equal(after.rowCount, 43)
    assert.deepEqual(
      after.rows,
      before.rows.map((row) => ({ id: row.id, amount: row.expected }))
    )

    await client.query(migration)
    assert.equal((await client.query('SELECT COUNT(*)::INTEGER AS total FROM payments')).rows[0].total, 43)

    await client.query("INSERT INTO payments (id, amount) VALUES ('pay_exact', 1234.123456)")
    const exact = await client.query("SELECT amount::TEXT AS amount FROM payments WHERE id = 'pay_exact'")
    assert.equal(exact.rows[0].amount, '1234.123456')
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS ${quotedShadowSchema} CASCADE`).catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined)
    await client.end()
  }
})
