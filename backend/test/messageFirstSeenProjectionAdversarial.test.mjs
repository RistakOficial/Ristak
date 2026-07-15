import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  getMessageAnalyticsSummary,
  getWhatsAppApiAnalyticsSummary
} from '../src/services/originDistributionService.js'
import {
  getProjectedMessageFirstSeenCount,
  isMessageFirstSeenProjectionReady,
  runMessageFirstSeenProjectionBackfill
} from '../src/services/messageFirstSeenProjectionService.js'

const migrationNames = [
  '099_message_first_seen_whatsapp_version.sqlite.sql',
  '099a_message_first_seen_meta_version.sqlite.sql',
  '099b_message_first_seen_email_version.sqlite.sql',
  '099c_message_first_seen_projection.sqlite.sql'
]

let migrationPromise = null

async function ensureProjectionMigration() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const tables = [
        ['whatsapp_api_messages', migrationNames[0]],
        ['meta_social_messages', migrationNames[1]],
        ['email_messages', migrationNames[2]]
      ]
      for (const [table, migrationName] of tables) {
        const columns = await db.all(`PRAGMA table_info('${table}')`)
        if (!columns.some(column => column.name === 'first_seen_projection_version')) {
          await db.exec(await readFile(
            new URL(`../migrations/versioned/${migrationName}`, import.meta.url),
            'utf8'
          ))
        }
      }

      const projection = await db.get(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'message_first_seen_ledger'
      `)
      if (!projection) {
        await db.exec(await readFile(
          new URL(`../migrations/versioned/${migrationNames[3]}`, import.meta.url),
          'utf8'
        ))
      }
      await runMessageFirstSeenProjectionBackfill()
    })()
  }
  return migrationPromise
}

function fixturePrefix(label) {
  return `first_seen_${label}_${randomUUID().replaceAll('-', '')}`
}

async function insertRow(table, values) {
  const columns = Object.keys(values)
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(column => values[column])
  )
}

async function cleanup(prefix) {
  await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM email_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

async function captureGetQueries(task) {
  const originalGet = db.get
  const queries = []
  db.get = async (sql, params = []) => {
    queries.push(String(sql || ''))
    return originalGet.call(db, sql, params)
  }
  try {
    return { value: await task(), queries }
  } finally {
    db.get = originalGet
  }
}

const rangeFor = day => ({
  startUtc: `${day}T00:00:00.000Z`,
  endUtc: `${day}T23:59:59.999Z`,
  appliedTimezone: 'UTC'
})

test('ledger conserva anonimos y los mismos defaults de direccion por fuente', async () => {
  await ensureProjectionMigration()
  const prefix = fixturePrefix('anonymous')
  const sharedId = `${prefix}_shared`
  const timestamp = '2200-01-01T10:00:00.123456Z'
  const range = rangeFor('2200-01-01')

  try {
    await insertRow('whatsapp_api_messages', {
      id: sharedId,
      direction: null,
      message_timestamp: timestamp,
      created_at: timestamp
    })
    await insertRow('meta_social_messages', {
      id: sharedId,
      platform: 'messenger',
      direction: null,
      message_timestamp: timestamp,
      created_at: timestamp
    })
    await insertRow('email_messages', {
      id: sharedId,
      direction: null,
      message_timestamp: timestamp,
      created_at: timestamp
    })

    const ledger = await db.all(`
      SELECT source_kind, identity_key, included
      FROM message_first_seen_ledger
      WHERE source_message_id = ?
      ORDER BY source_kind
    `, [sharedId])
    assert.deepEqual(ledger.map(row => [row.source_kind, row.identity_key, Number(row.included)]), [
      ['email', `message:${sharedId}`, 0],
      ['meta', `message:${sharedId}`, 1],
      ['whatsapp', `message:${sharedId}`, 1]
    ])

    assert.equal(await getProjectedMessageFirstSeenCount(range), 1, 'global conserva la colision message:id legacy')
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'whatsapp' }), 1)
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'meta' }), 1)
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'email' }), 0)

    await db.run("UPDATE email_messages SET direction = 'inbound' WHERE id = ?", [sharedId])
    assert.equal(await getProjectedMessageFirstSeenCount(range), 1)
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'email' }), 1)
  } finally {
    await cleanup(prefix)
  }
})

test('ties, delete, cambio de identidad y direccion reemplazan solo el minimo exacto', async () => {
  await ensureProjectionMigration()
  const prefix = fixturePrefix('mutations')
  const contactA = `${prefix}_contact_a`
  const contactB = `${prefix}_contact_b`
  const timestamp = '2200-01-02T10:00:00.654321Z'
  const range = rangeFor('2200-01-02')
  const firstId = `${prefix}_a_message`
  const tiedId = `${prefix}_b_message`
  const metaId = `${prefix}_meta`

  try {
    for (const [id, name] of [[contactA, 'A'], [contactB, 'B']]) {
      await insertRow('contacts', {
        id,
        full_name: `First Seen ${name}`,
        email: `${id}@local.invalid`,
        created_at: timestamp,
        updated_at: timestamp
      })
    }
    for (const id of [firstId, tiedId]) {
      await insertRow('whatsapp_api_messages', {
        id,
        contact_id: contactA,
        direction: 'inbound',
        message_timestamp: timestamp,
        created_at: timestamp
      })
    }
    await insertRow('meta_social_messages', {
      id: metaId,
      platform: 'instagram',
      contact_id: contactA,
      direction: 'inbound',
      message_timestamp: '2200-01-02T11:00:00.000000Z',
      created_at: '2200-01-02T11:00:00.000000Z'
    })

    let sourceSummary = await db.get(`
      SELECT source_message_id
      FROM message_identity_first_seen_source
      WHERE source_kind = 'whatsapp' AND identity_key = ?
    `, [`contact:${contactA}`])
    assert.equal(sourceSummary.source_message_id, firstId, 'id desempata el mismo microsegundo')
    assert.equal(await getProjectedMessageFirstSeenCount(range), 1, 'Meta y WhatsApp comparten contact:id global')

    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [firstId])
    sourceSummary = await db.get(`
      SELECT source_message_id
      FROM message_identity_first_seen_source
      WHERE source_kind = 'whatsapp' AND identity_key = ?
    `, [`contact:${contactA}`])
    assert.equal(sourceSummary.source_message_id, tiedId)

    await db.run('UPDATE whatsapp_api_messages SET contact_id = ? WHERE id = ?', [contactB, tiedId])
    assert.equal(await getProjectedMessageFirstSeenCount(range), 2)
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'whatsapp' }), 1)

    await db.run("UPDATE whatsapp_api_messages SET direction = 'outbound' WHERE id = ?", [tiedId])
    assert.equal(await getProjectedMessageFirstSeenCount(range), 1)
    assert.equal(await getProjectedMessageFirstSeenCount(range, { sourceKind: 'whatsapp' }), 0)

    await db.run('DELETE FROM meta_social_messages WHERE id = ?', [metaId])
    assert.equal(await getProjectedMessageFirstSeenCount(range), 0)
  } finally {
    await cleanup(prefix)
  }
})

test('ocultos se evaluan con datos actuales sin reproyectar el historial', async () => {
  await ensureProjectionMigration()
  const prefix = fixturePrefix('hidden')
  const contactId = `${prefix}_contact`
  const contactName = `Oculto ${prefix}`
  const timestamp = '2200-01-03T10:00:00.000000Z'
  const range = rangeFor('2200-01-03')

  try {
    await insertRow('contacts', {
      id: contactId,
      full_name: contactName,
      email: `${contactId}@local.invalid`,
      created_at: timestamp,
      updated_at: timestamp
    })
    await insertRow('whatsapp_api_messages', {
      id: `${prefix}_contact_message`,
      contact_id: contactId,
      direction: 'inbound',
      message_timestamp: timestamp,
      created_at: timestamp
    })
    await insertRow('whatsapp_api_messages', {
      id: `${prefix}_anonymous_message`,
      direction: 'inbound',
      message_timestamp: timestamp,
      created_at: timestamp
    })

    const hiddenFilters = [{ text: contactName, type: 'exact' }]
    const unfiltered = await captureGetQueries(() => getProjectedMessageFirstSeenCount(range))
    const unfilteredSql = unfiltered.queries.find(sql => sql.includes('message_identity_first_seen_global')) || ''
    assert.equal(unfiltered.value, 2)
    assert.doesNotMatch(unfilteredSql, /JOIN\s+contacts/i, 'sin filtros el hot path no debe tocar contacts')

    const filtered = await captureGetQueries(() => (
      getProjectedMessageFirstSeenCount(range, { hiddenFilters })
    ))
    const filteredSql = filtered.queries.find(sql => sql.includes('message_identity_first_seen_global')) || ''
    assert.equal(filtered.value, 1)
    assert.match(filteredSql, /LEFT JOIN\s+contacts/i)

    await db.run('UPDATE contacts SET full_name = ? WHERE id = ?', [`Visible ${prefix}`, contactId])
    assert.equal(
      await getProjectedMessageFirstSeenCount(range, { hiddenFilters }),
      2,
      'el join live debe reflejar cambios de ocultos sin tocar millones de mensajes'
    )
  } finally {
    await cleanup(prefix)
  }
})

test('readiness sirve snapshot warming acotado y queda exacto despues de reparar', async () => {
  await ensureProjectionMigration()
  const prefix = fixturePrefix('readiness')
  const messageId = `${prefix}_message`
  const phone = `${prefix}_phone`
  const timestamp = '2200-01-04T10:00:00.000000Z'
  const range = rangeFor('2200-01-04')

  try {
    await insertRow('whatsapp_api_messages', {
      id: messageId,
      phone,
      direction: 'inbound',
      message_timestamp: timestamp,
      created_at: timestamp
    })
    await db.run(`
      DELETE FROM message_first_seen_ledger
      WHERE source_kind = 'whatsapp' AND source_message_id = ?
    `, [messageId])
    await db.run(`
      UPDATE whatsapp_api_messages
      SET first_seen_projection_version = 0
      WHERE id = ?
    `, [messageId])
    await db.run(`
      UPDATE message_first_seen_projection_state
      SET status = 'backfilling'
      WHERE singleton_id = 1
    `)

    assert.equal(await isMessageFirstSeenProjectionReady(), false)
    const warmingRead = await captureGetQueries(() => (
      getProjectedMessageFirstSeenCount(range, { withStatus: true })
    ))
    assert.deepEqual(warmingRead.value, {
      count: 0,
      projectionReady: false,
      projectionStatus: 'warming'
    })
    assert.ok(warmingRead.queries.some(sql => /message_identity_first_seen_global/i.test(sql)))
    assert.equal(
      warmingRead.queries.some(sql => /GROUP BY\s+identity/i.test(sql)),
      false,
      warmingRead.queries.join('\n---\n')
    )
    const multi = await getMessageAnalyticsSummary(range, { groupBy: 'day' })
    const whatsapp = await getWhatsAppApiAnalyticsSummary(range, { groupBy: 'day' })
    assert.equal(multi.metrics.contacts, 0)
    assert.equal(whatsapp.metrics.contacts, 0)
    assert.equal(multi.status.firstSeenProjection, 'warming')
    assert.equal(multi.status.firstSeenProjectionComplete, false)
    assert.equal(whatsapp.status.firstSeenProjection, 'warming')

    await runMessageFirstSeenProjectionBackfill()
    assert.equal(await isMessageFirstSeenProjectionReady(), true)
    assert.equal(await getProjectedMessageFirstSeenCount(range), 1)
    const ledger = await db.get(`
      SELECT identity_key, included
      FROM message_first_seen_ledger
      WHERE source_kind = 'whatsapp' AND source_message_id = ?
    `, [messageId])
    assert.equal(ledger.identity_key, `phone:${phone}`)
    assert.equal(Number(ledger.included), 1)
  } finally {
    await cleanup(prefix)
    await runMessageFirstSeenProjectionBackfill().catch(() => undefined)
  }
})

test('los helpers first-seen no contienen fallback historico ni agendan trabajo desde GET', async () => {
  const [originSource, projectionSource] = await Promise.all([
    readFile(new URL('../src/services/originDistributionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/messageFirstSeenProjectionService.js', import.meta.url), 'utf8')
  ])
  const firstSeenHelpers = originSource.slice(
    originSource.indexOf('async function getMessageFirstSeenCount'),
    originSource.indexOf('async function getMessageAnalyticsAggregateRows')
  )
  const projectedRead = projectionSource.slice(
    projectionSource.indexOf('export async function getProjectedMessageFirstSeenCount'),
    projectionSource.indexOf('async function backfillSourceBatch')
  )

  assert.doesNotMatch(firstSeenHelpers, /GROUP BY\s+identity|FROM\s+whatsapp_api_messages/i)
  assert.doesNotMatch(projectedRead, /scheduleMessageFirstSeenProjectionBackfill/)
  assert.match(projectedRead, /message_identity_first_seen_(?:global|source)/)
  assert.match(projectedRead, /withStatus/)
})
