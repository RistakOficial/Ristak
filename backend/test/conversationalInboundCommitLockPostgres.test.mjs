import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPostgresAdapter } from '../src/config/databasePostgresAdapter.js'
import {
  CONVERSATIONAL_INBOUND_COMMIT_CHANNELS,
  acquireConversationalInboundCommitLock,
  acquireConversationalInboundCommitLocks,
  buildConversationalInboundCommitLockId,
  normalizeConversationalInboundCommitChannel,
  withConversationalInboundCommitLock
} from '../src/services/conversationalInboundCommitLockService.js'

const postgresUrl = String(process.env.TEST_POSTGRES_URL || '').trim()

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntilAdvisoryLockIsBlocked(observer, applicationName, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE application_name = $1
      ORDER BY backend_start DESC
      LIMIT 1
    `, [applicationName])
    const row = result.rows[0]
    if (row?.wait_event_type === 'Lock' && String(row?.wait_event || '').toLowerCase() === 'advisory') {
      return
    }
    await delay(10)
  }
  assert.fail(`La conexión ${applicationName} nunca quedó bloqueada por el advisory lock`)
}

function postgresTestAdapter(client) {
  const transactionDatabase = createPostgresAdapter(client)
  return {
    ...transactionDatabase,
    transaction: async (callback) => {
      await client.query('BEGIN')
      try {
        const result = await callback(transactionDatabase)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }
  }
}

test('la llave inbound es estable, firmada y comparte aliases canónicos', () => {
  const whatsappLock = buildConversationalInboundCommitLockId({
    contactId: 'contact-lock-test',
    channel: 'whatsapp'
  })
  const aliasLock = buildConversationalInboundCommitLockId({
    contactId: 'contact-lock-test',
    channel: 'ghl_whatsapp'
  })
  const emailLock = buildConversationalInboundCommitLockId({
    contactId: 'contact-lock-test',
    channel: 'email'
  })

  assert.equal(aliasLock, whatsappLock)
  assert.notEqual(emailLock, whatsappLock)
  assert.equal(normalizeConversationalInboundCommitChannel('instagram-dm'), 'instagram')
  assert.match(whatsappLock, /^-?\d+$/)
  assert.ok(BigInt(whatsappLock) >= -(1n << 63n))
  assert.ok(BigInt(whatsappLock) < (1n << 63n))
})

test('el cerco multi-contacto deduplica aliases y adquiere todas las llaves en orden global', async () => {
  const acquiredLockIds = []
  const database = {
    get: async (_sql, [lockId]) => {
      acquiredLockIds.push(lockId)
      return { conversational_inbound_commit_lock: null }
    }
  }

  const aliasLocks = await acquireConversationalInboundCommitLocks({
    contactIds: ['contact-z', 'contact-a', 'contact-z'],
    channels: ['ghl_whatsapp', 'whatsapp_api', 'instagram-dm', 'mail', 'correo'],
    database,
    dialect: 'postgres'
  })

  assert.equal(aliasLocks.length, 6)
  assert.deepEqual(
    [...new Set(aliasLocks.map(lock => lock.channel))].sort(),
    ['email', 'instagram', 'whatsapp']
  )
  assert.deepEqual(
    acquiredLockIds,
    [...acquiredLockIds].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)
  )

  const allChannelLocks = await acquireConversationalInboundCommitLocks({
    contactIds: ['contact-z', 'contact-a'],
    database: { get: async () => ({}) },
    dialect: 'postgres'
  })
  assert.equal(allChannelLocks.length, CONVERSATIONAL_INBOUND_COMMIT_CHANNELS.length * 2)
  assert.deepEqual(
    [...new Set(allChannelLocks.map(lock => lock.channel))].sort(),
    [...CONVERSATIONAL_INBOUND_COMMIT_CHANNELS].sort()
  )
})

test('la prueba PostgreSQL usa la misma traducción SQL que el adaptador productivo', async () => {
  const calls = []
  const adapter = createPostgresAdapter({
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ translated: true }], rowCount: 1 }
    }
  })

  assert.deepEqual(
    await adapter.get("SELECT '?' AS literal, ? AS enabled", [true]),
    { translated: true }
  )
  assert.deepEqual(calls, [{
    sql: "SELECT '?' AS literal, $1 AS enabled",
    params: [1]
  }])
})

test('PostgreSQL serializa el inbound contra la ventana exacta entre fence e INSERT de cita', {
  skip: !postgresUrl
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  const schema = `ristak_inbound_fence_${suffix}`
  const terminalApp = `ristak_terminal_${suffix}`.slice(0, 63)
  const inboundApp = `ristak_inbound_${suffix}`.slice(0, 63)
  const observerApp = `ristak_observer_${suffix}`.slice(0, 63)
  const terminal = new pg.Client({ connectionString: postgresUrl, application_name: terminalApp })
  const inbound = new pg.Client({ connectionString: postgresUrl, application_name: inboundApp })
  const observer = new pg.Client({ connectionString: postgresUrl, application_name: observerApp })
  const terminalDatabase = postgresTestAdapter(terminal)
  const inboundDatabase = postgresTestAdapter(inbound)
  let pendingInbound = null
  let pendingTerminal = null

  await Promise.all([terminal.connect(), inbound.connect(), observer.connect()])
  try {
    await observer.query(`CREATE SCHEMA "${schema}"`)
    await observer.query(`
      CREATE TABLE "${schema}".inbound_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        authority_order INTEGER NOT NULL
      )
    `)
    await observer.query(`
      CREATE TABLE "${schema}".appointments (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL
      )
    `)
    await observer.query(`
      INSERT INTO "${schema}".inbound_messages (id, contact_id, channel, authority_order)
      VALUES ('handled', 'contact-concurrent-fence', 'whatsapp', 1)
    `)

    // Caso 1: la cita ya tomó la llave y pasó su último fence. El inbound
    // intenta persistirse justo en la vieja ventana TOCTOU y debe esperar hasta
    // que el INSERT de la cita haga COMMIT; jamás queda visible entre ambos.
    await terminal.query('BEGIN')
    await acquireConversationalInboundCommitLock({
      contactId: 'contact-concurrent-fence',
      channel: 'whatsapp',
      database: terminalDatabase,
      dialect: 'postgres'
    })
    const beforeInsert = await terminal.query(`
      SELECT id
      FROM "${schema}".inbound_messages
      WHERE contact_id = 'contact-concurrent-fence'
        AND channel = 'whatsapp'
        AND authority_order > 1
    `)
    assert.equal(beforeInsert.rowCount, 0)

    pendingInbound = withConversationalInboundCommitLock({
      contactId: 'contact-concurrent-fence',
      channel: 'ghl_whatsapp',
      database: inboundDatabase,
      dialect: 'postgres'
    }, async (database) => {
      await database.run(`
        INSERT INTO "${schema}".inbound_messages (id, contact_id, channel, authority_order)
        VALUES ('newer', 'contact-concurrent-fence', 'whatsapp', 2)
      `)
    })

    await waitUntilAdvisoryLockIsBlocked(observer, inboundApp)
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`)).rows[0].total, 0)
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".inbound_messages WHERE id = 'newer'`)).rows[0].total, 0)

    await terminal.query(`
      INSERT INTO "${schema}".appointments (id, contact_id)
      VALUES ('appointment-terminal-first', 'contact-concurrent-fence')
    `)
    await terminal.query('COMMIT')
    await pendingInbound
    pendingInbound = null

    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`)).rows[0].total, 1)
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".inbound_messages WHERE id = 'newer'`)).rows[0].total, 1)

    // Caso 2: el inbound tomó primero la misma llave. La cita espera su COMMIT,
    // vuelve a consultar autoridad ya dentro del lock y aborta sin INSERT.
    await observer.query(`DELETE FROM "${schema}".appointments`)
    await observer.query(`DELETE FROM "${schema}".inbound_messages WHERE id = 'newer'`)
    await inbound.query('BEGIN')
    await acquireConversationalInboundCommitLock({
      contactId: 'contact-concurrent-fence',
      channel: 'whatsapp_api',
      database: inboundDatabase,
      dialect: 'postgres'
    })
    await inbound.query(`
      INSERT INTO "${schema}".inbound_messages (id, contact_id, channel, authority_order)
      VALUES ('newer', 'contact-concurrent-fence', 'whatsapp', 2)
    `)

    pendingTerminal = (async () => {
      await terminal.query('BEGIN')
      await acquireConversationalInboundCommitLock({
        contactId: 'contact-concurrent-fence',
        channel: 'whatsapp',
        database: terminalDatabase,
        dialect: 'postgres'
      })
      const newer = await terminal.query(`
        SELECT id
        FROM "${schema}".inbound_messages
        WHERE contact_id = 'contact-concurrent-fence'
          AND channel = 'whatsapp'
          AND authority_order > 1
        LIMIT 1
      `)
      if (newer.rowCount > 0) {
        await terminal.query('ROLLBACK')
        return 'superseded'
      }
      await terminal.query(`
        INSERT INTO "${schema}".appointments (id, contact_id)
        VALUES ('appointment-inbound-first', 'contact-concurrent-fence')
      `)
      await terminal.query('COMMIT')
      return 'created'
    })()

    await waitUntilAdvisoryLockIsBlocked(observer, terminalApp)
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`)).rows[0].total, 0)
    await inbound.query('COMMIT')
    assert.equal(await pendingTerminal, 'superseded')
    pendingTerminal = null
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`)).rows[0].total, 0)

    // Caso 3: wiring real del controller. La transacción puede tomar primero el
    // lock del calendario y hacer una revalidación temprana, pero NO debe tomar
    // aún el lock inbound. Una corrección que entra mientras disponibilidad
    // tarda persiste; sólo entonces el fence terminal adquiere la llave, la ve
    // y aborta el INSERT viejo.
    await observer.query(`DELETE FROM "${schema}".appointments`)
    await observer.query(`DELETE FROM "${schema}".inbound_messages WHERE id = 'newer'`)
    await terminal.query('BEGIN')
    const earlyAuthority = await terminal.query(`
      SELECT id
      FROM "${schema}".inbound_messages
      WHERE contact_id = 'contact-concurrent-fence'
        AND channel = 'whatsapp'
        AND authority_order > 1
    `)
    assert.equal(earlyAuthority.rowCount, 0)

    await withConversationalInboundCommitLock({
      contactId: 'contact-concurrent-fence',
      channel: 'ghl_whatsapp',
      database: inboundDatabase,
      dialect: 'postgres'
    }, async (database) => {
      await database.run(`
        INSERT INTO "${schema}".inbound_messages (id, contact_id, channel, authority_order)
        VALUES ('newer', 'contact-concurrent-fence', 'whatsapp', 2)
      `)
    })

    await acquireConversationalInboundCommitLock({
      contactId: 'contact-concurrent-fence',
      channel: 'whatsapp',
      database: terminalDatabase,
      dialect: 'postgres'
    })
    const finalAuthority = await terminal.query(`
      SELECT id
      FROM "${schema}".inbound_messages
      WHERE contact_id = 'contact-concurrent-fence'
        AND channel = 'whatsapp'
        AND authority_order > 1
      LIMIT 1
    `)
    assert.equal(finalAuthority.rows[0]?.id, 'newer')
    await terminal.query('ROLLBACK')
    assert.equal((await observer.query(`SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`)).rows[0].total, 0)
  } finally {
    await terminal.query('ROLLBACK').catch(() => undefined)
    await inbound.query('ROLLBACK').catch(() => undefined)
    await pendingInbound?.catch(() => undefined)
    await pendingTerminal?.catch(() => undefined)
    await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await Promise.all([
      terminal.end().catch(() => undefined),
      inbound.end().catch(() => undefined),
      observer.end().catch(() => undefined)
    ])
  }
})

test('PostgreSQL serializa un merge B→A contra el fence terminal y su INSERT', {
  skip: !postgresUrl
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  const schema = `ristak_contact_merge_fence_${suffix}`
  const targetContactId = `contact-merge-target-${suffix}`
  const sourceContactId = `contact-merge-source-${suffix}`
  const terminalApp = `ristak_merge_terminal_${suffix}`.slice(0, 63)
  const mergeApp = `ristak_merge_worker_${suffix}`.slice(0, 63)
  const observerApp = `ristak_merge_observer_${suffix}`.slice(0, 63)
  const terminal = new pg.Client({ connectionString: postgresUrl, application_name: terminalApp })
  const merger = new pg.Client({ connectionString: postgresUrl, application_name: mergeApp })
  const observer = new pg.Client({ connectionString: postgresUrl, application_name: observerApp })
  const terminalDatabase = postgresTestAdapter(terminal)
  const mergeDatabase = postgresTestAdapter(merger)
  let pendingMerge = null
  let pendingTerminal = null

  await Promise.all([terminal.connect(), merger.connect(), observer.connect()])
  try {
    await observer.query(`CREATE SCHEMA "${schema}"`)
    await observer.query(`
      CREATE TABLE "${schema}".inbound_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        authority_order INTEGER NOT NULL
      )
    `)
    await observer.query(`
      CREATE TABLE "${schema}".appointments (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL
      )
    `)

    // Si el fence de A ganó primero, el merge debe esperar: la fila de B no
    // puede mudarse a A dentro de la vieja ventana entre SELECT e INSERT.
    await observer.query(`
      INSERT INTO "${schema}".inbound_messages (id, contact_id, channel, authority_order)
      VALUES ('newer-from-source', $1, 'whatsapp', 2)
    `, [sourceContactId])
    await terminal.query('BEGIN')
    await acquireConversationalInboundCommitLock({
      contactId: targetContactId,
      channel: 'whatsapp',
      database: terminalDatabase,
      dialect: 'postgres'
    })
    const beforeInsert = await terminal.query(`
      SELECT id
      FROM "${schema}".inbound_messages
      WHERE contact_id = $1
        AND channel = 'whatsapp'
        AND authority_order > 1
    `, [targetContactId])
    assert.equal(beforeInsert.rowCount, 0)

    pendingMerge = mergeDatabase.transaction(async (database) => {
      await acquireConversationalInboundCommitLocks({
        contactIds: [sourceContactId, targetContactId],
        database,
        dialect: 'postgres'
      })
      await database.run(
        `UPDATE "${schema}".inbound_messages SET contact_id = ? WHERE contact_id = ?`,
        [targetContactId, sourceContactId]
      )
    })

    await waitUntilAdvisoryLockIsBlocked(observer, mergeApp)
    assert.equal((await observer.query(
      `SELECT contact_id FROM "${schema}".inbound_messages WHERE id = 'newer-from-source'`
    )).rows[0]?.contact_id, sourceContactId)

    await terminal.query(
      `INSERT INTO "${schema}".appointments (id, contact_id) VALUES ('terminal-first', $1)`,
      [targetContactId]
    )
    await terminal.query('COMMIT')
    await pendingMerge
    pendingMerge = null

    assert.equal((await observer.query(
      `SELECT contact_id FROM "${schema}".inbound_messages WHERE id = 'newer-from-source'`
    )).rows[0]?.contact_id, targetContactId)
    assert.equal((await observer.query(
      `SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments WHERE id = 'terminal-first'`
    )).rows[0].total, 1)

    // Si el merge gana primero, mueve la fila bajo las llaves de A y B. El
    // fence espera el COMMIT, ve el inbound nuevo ya en A y cancela la cita.
    await observer.query(`DELETE FROM "${schema}".appointments`)
    await observer.query(
      `UPDATE "${schema}".inbound_messages SET contact_id = $1 WHERE id = 'newer-from-source'`,
      [sourceContactId]
    )
    await merger.query('BEGIN')
    await acquireConversationalInboundCommitLocks({
      contactIds: [targetContactId, sourceContactId],
      database: mergeDatabase,
      dialect: 'postgres'
    })
    await merger.query(
      `UPDATE "${schema}".inbound_messages SET contact_id = $1 WHERE contact_id = $2`,
      [targetContactId, sourceContactId]
    )

    pendingTerminal = (async () => {
      await terminal.query('BEGIN')
      await acquireConversationalInboundCommitLock({
        contactId: targetContactId,
        channel: 'ghl_whatsapp',
        database: terminalDatabase,
        dialect: 'postgres'
      })
      const newer = await terminal.query(`
        SELECT id
        FROM "${schema}".inbound_messages
        WHERE contact_id = $1
          AND channel = 'whatsapp'
          AND authority_order > 1
        LIMIT 1
      `, [targetContactId])
      if (newer.rowCount > 0) {
        await terminal.query('ROLLBACK')
        return 'superseded'
      }
      await terminal.query(
        `INSERT INTO "${schema}".appointments (id, contact_id) VALUES ('merge-first', $1)`,
        [targetContactId]
      )
      await terminal.query('COMMIT')
      return 'created'
    })()

    await waitUntilAdvisoryLockIsBlocked(observer, terminalApp)
    assert.equal((await observer.query(
      `SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`
    )).rows[0].total, 0)
    await merger.query('COMMIT')
    assert.equal(await pendingTerminal, 'superseded')
    pendingTerminal = null
    assert.equal((await observer.query(
      `SELECT COUNT(*)::INTEGER AS total FROM "${schema}".appointments`
    )).rows[0].total, 0)
  } finally {
    await terminal.query('ROLLBACK').catch(() => undefined)
    await merger.query('ROLLBACK').catch(() => undefined)
    await pendingMerge?.catch(() => undefined)
    await pendingTerminal?.catch(() => undefined)
    await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await Promise.all([
      terminal.end().catch(() => undefined),
      merger.end().catch(() => undefined),
      observer.end().catch(() => undefined)
    ])
  }
})

test('PostgreSQL: un dedup bajo el lock de B no puede reparentar el inbound de A tras su fence final', {
  skip: !postgresUrl
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  const schema = `ristak_immutable_inbound_owner_${suffix}`
  const contactA = `contact-owner-a-${suffix}`
  const contactB = `contact-owner-b-${suffix}`
  const terminal = new pg.Client({
    connectionString: postgresUrl,
    application_name: `ristak_owner_terminal_${suffix}`.slice(0, 63)
  })
  const upserter = new pg.Client({
    connectionString: postgresUrl,
    application_name: `ristak_owner_upsert_${suffix}`.slice(0, 63)
  })
  const observer = new pg.Client({
    connectionString: postgresUrl,
    application_name: `ristak_owner_observer_${suffix}`.slice(0, 63)
  })
  const terminalDatabase = postgresTestAdapter(terminal)
  const upsertDatabase = postgresTestAdapter(upserter)

  await Promise.all([terminal.connect(), upserter.connect(), observer.connect()])
  try {
    await observer.query(`CREATE SCHEMA "${schema}"`)
    await observer.query(`
      CREATE TABLE "${schema}".inbound_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        body TEXT NOT NULL
      )
    `)
    await observer.query(`
      CREATE TABLE "${schema}".appointments (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL
      )
    `)
    await observer.query(`
      INSERT INTO "${schema}".inbound_messages (id, contact_id, body)
      VALUES ('same-provider-message', $1, 'corrección explícita')
    `, [contactA])

    await terminal.query('BEGIN')
    await acquireConversationalInboundCommitLock({
      contactId: contactA,
      channel: 'email',
      database: terminalDatabase,
      dialect: 'postgres'
    })
    const fencedOwner = await terminal.query(`
      SELECT contact_id
      FROM "${schema}".inbound_messages
      WHERE id = 'same-provider-message'
    `)
    assert.equal(fencedOwner.rows[0]?.contact_id, contactA)

    // El lock de B es deliberadamente distinto y el UPSERT sí corre mientras
    // A mantiene abierta la ventana terminal. El contrato write-once de la fila,
    // no una serialización accidental, es lo que impide sacar el inbound de A.
    await withConversationalInboundCommitLock({
      contactId: contactB,
      channel: 'email',
      database: upsertDatabase,
      dialect: 'postgres'
    }, async database => {
      await database.run(`
        INSERT INTO "${schema}".inbound_messages (id, contact_id, body)
        VALUES ('same-provider-message', ?, 'replay desde B')
        ON CONFLICT(id) DO UPDATE SET
          contact_id = COALESCE(inbound_messages.contact_id, excluded.contact_id),
          body = excluded.body
      `, [contactB])
    })

    assert.equal((await observer.query(`
      SELECT contact_id
      FROM "${schema}".inbound_messages
      WHERE id = 'same-provider-message'
    `)).rows[0]?.contact_id, contactA)

    await terminal.query(`
      INSERT INTO "${schema}".appointments (id, contact_id)
      VALUES ('appointment-after-fence', $1)
    `, [contactA])
    await terminal.query('COMMIT')

    assert.equal((await observer.query(`
      SELECT contact_id
      FROM "${schema}".appointments
      WHERE id = 'appointment-after-fence'
    `)).rows[0]?.contact_id, contactA)

    // Las filas legacy sin dueño sí se pueden completar una vez.
    await observer.query(`
      UPDATE "${schema}".inbound_messages
      SET contact_id = NULL
      WHERE id = 'same-provider-message'
    `)
    await withConversationalInboundCommitLock({
      contactId: contactB,
      channel: 'email',
      database: upsertDatabase,
      dialect: 'postgres'
    }, async database => {
      await database.run(`
        INSERT INTO "${schema}".inbound_messages (id, contact_id, body)
        VALUES ('same-provider-message', ?, 'legacy completado')
        ON CONFLICT(id) DO UPDATE SET
          contact_id = COALESCE(inbound_messages.contact_id, excluded.contact_id),
          body = excluded.body
      `, [contactB])
    })
    assert.equal((await observer.query(`
      SELECT contact_id
      FROM "${schema}".inbound_messages
      WHERE id = 'same-provider-message'
    `)).rows[0]?.contact_id, contactB)
  } finally {
    await terminal.query('ROLLBACK').catch(() => undefined)
    await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await Promise.all([
      terminal.end().catch(() => undefined),
      upserter.end().catch(() => undefined),
      observer.end().catch(() => undefined)
    ])
  }
})
