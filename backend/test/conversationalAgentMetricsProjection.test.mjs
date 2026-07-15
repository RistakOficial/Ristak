import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { db } from '../src/config/database.js'
import {
  buildConversationalAgentMetrics,
  expirePausedConversationStates,
  getConversationalAgentMetrics
} from '../src/services/conversationalAgentService.js'
import {
  isConversationalAgentMetricsProjectionReady,
  loadConversationalAgentMetricAggregates,
  runConversationalAgentMetricsProjectionBackfill
} from '../src/services/conversationalAgentMetricsProjectionService.js'

const execFileAsync = promisify(execFile)
const migrationNames = [
  '098a_conversational_state_metrics_version.sqlite.sql',
  '098b_conversational_event_metrics_version.sqlite.sql',
  '098c_conversational_agent_metrics_projection.sqlite.sql'
]
const migrationUrls = migrationNames.map(name => (
  new URL(`../migrations/versioned/${name}`, import.meta.url)
))
const postgresMigrationNames = [
  '098d_conversational_agent_metrics_projection.postgres.sql',
  '098e_conversational_state_metrics_pending.postgres.sql',
  '098f_conversational_event_metrics_pending.postgres.sql',
  '098g_conversational_state_paused_expiry.postgres.sql'
]

let migrationPromise = null

async function ensureProjectionMigration() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const stateColumns = await db.all("PRAGMA table_info('conversational_agent_state')")
      if (!stateColumns.some(column => column.name === 'agent_metrics_projection_version')) {
        await db.exec(await readFile(migrationUrls[0], 'utf8'))
      }
      const eventColumns = await db.all("PRAGMA table_info('conversational_agent_events')")
      if (!eventColumns.some(column => column.name === 'agent_metrics_projection_version')) {
        await db.exec(await readFile(migrationUrls[1], 'utf8'))
      }
      const projectionTable = await db.get(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'conversational_agent_state_metric_rows'
      `)
      if (!projectionTable) await db.exec(await readFile(migrationUrls[2], 'utf8'))
    })()
  }
  return migrationPromise
}

async function insertRow(table, values) {
  const columns = Object.keys(values)
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(column => values[column])
  )
}

async function cleanupPrefix(prefix) {
  await db.run('DELETE FROM conversational_agent_events WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

function fixtureAgents(agentIds) {
  return agentIds.map((id, index) => ({
    id,
    name: `Agente ${index + 1}`,
    enabled: index === 0,
    aiProvider: 'openai',
    model: 'gpt-5.4-mini'
  }))
}

test('la arquitectura 098 conserva sentinels, summaries shardeados e indices PG unitarios', async () => {
  const sqliteSql = (
    await Promise.all(migrationUrls.map(url => readFile(url, 'utf8')))
  ).join('\n')
  const postgresSql = await Promise.all(postgresMigrationNames.map(name => (
    readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
  )))

  assert.match(sqliteSql, /CREATE TABLE IF NOT EXISTS conversational_agent_state_metric_rows/i)
  assert.match(sqliteSql, /CREATE TABLE IF NOT EXISTS conversational_agent_state_metric_summary/i)
  assert.match(sqliteSql, /CREATE TABLE IF NOT EXISTS conversational_agent_event_metric_rows/i)
  assert.match(sqliteSql, /CREATE TABLE IF NOT EXISTS conversational_agent_event_metric_summary/i)
  assert.match(sqliteSql, /CREATE TABLE IF NOT EXISTS conversational_agent_metrics_projection_state/i)
  assert.match(sqliteSql, /included INTEGER NOT NULL DEFAULT 0/i)
  assert.match(sqliteSql, /summary_shard.*BETWEEN 0 AND 63/is)
  assert.match(sqliteSql, /agent_metrics_projection_version/i)

  assert.doesNotMatch(postgresSql[0], /CREATE INDEX CONCURRENTLY/i)
  for (const sql of postgresSql.slice(1)) {
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/gi) || []).length, 1)
  }
})

test('sin migracion instalada falla cerrado con snapshot vacio y nunca escanea fuentes', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'ristak-agent-metrics-missing-'))
  const sqlitePath = join(tempDirectory, 'missing.sqlite')
  const serviceUrl = new URL('../src/services/conversationalAgentMetricsProjectionService.js', import.meta.url)

  try {
    const script = `
      const service = await import(${JSON.stringify(serviceUrl.href)});
      const ready = await service.isConversationalAgentMetricsProjectionReady();
      const data = await service.loadConversationalAgentMetricAggregates();
      process.stdout.write(JSON.stringify({
        ready,
        projectionStatus: data.projectionStatus,
        stateRows: data.stateSummaryRows.length,
        totalEvents: Number(data.eventSummary.total_events || 0)
      }) + '\\n');
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: '',
        NODE_ENV: 'test',
        RISTAK_SQLITE_PATH: sqlitePath
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024
    })
    const line = stdout.trim().split('\n').at(-1)
    assert.deepEqual(JSON.parse(line), {
      ready: false,
      projectionStatus: 'unavailable',
      stateRows: 0,
      totalEvents: 0
    })
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test('insert, update, reasignacion y delete mantienen exactamente estados y eventos', async () => {
  await ensureProjectionMigration()
  const prefix = `cam_exact_${randomUUID().replaceAll('-', '')}_`
  const agentA = `${prefix}agent_a`
  const agentB = `${prefix}agent_b`
  const whitespaceAgent = '   '
  const stateIds = {
    assigned: `${prefix}state_assigned`,
    completed: `${prefix}state_completed`,
    discarded: `${prefix}state_discarded`,
    whitespace: `${prefix}state_whitespace`,
    sentinel: `${prefix}state_sentinel`
  }
  const eventTypes = [
    'signal_set',
    'agent_assigned',
    'reply_sent',
    'appointment_booked',
    'payment_link_created',
    'goal_url_completed',
    'follow_up_sent',
    'follow_up_suppressed',
    'human_handoff',
    'custom_tool_failed_runtime',
    'calendar_sync_error',
    'appointment_slot_preview_offer_created'
  ]

  await cleanupPrefix(prefix)
  try {
    for (let index = 0; index < 5; index += 1) {
      await insertRow('contacts', {
        id: `${prefix}contact_${index}`,
        full_name: `Metricas ${index}`
      })
    }
    await insertRow('conversational_agent_state', {
      id: stateIds.assigned,
      contact_id: `${prefix}contact_0`,
      agent_id: agentA,
      status: 'active',
      signal: null,
      last_reply_at: '2100-01-01T10:00:00.000Z',
      updated_at: '2100-01-01T10:01:00.000Z'
    })
    await insertRow('conversational_agent_state', {
      id: stateIds.completed,
      contact_id: `${prefix}contact_1`,
      agent_id: agentA,
      status: 'completed',
      signal: 'ready_to_buy',
      updated_at: '2100-01-01T10:05:00.000Z'
    })
    await insertRow('conversational_agent_state', {
      id: stateIds.discarded,
      contact_id: `${prefix}contact_2`,
      agent_id: agentB,
      status: 'human',
      signal: 'discarded',
      updated_at: '2100-01-01T10:03:00.000Z'
    })
    await insertRow('conversational_agent_state', {
      id: stateIds.whitespace,
      contact_id: `${prefix}contact_3`,
      agent_id: whitespaceAgent,
      status: 'skipped',
      updated_at: '2100-01-01T10:02:00.000Z'
    })
    await insertRow('conversational_agent_state', {
      id: stateIds.sentinel,
      contact_id: `${prefix}contact_4`,
      agent_id: null,
      status: 'active',
      updated_at: '2100-01-01T10:04:00.000Z'
    })

    for (const [index, eventType] of eventTypes.entries()) {
      await insertRow('conversational_agent_events', {
        id: `${prefix}event_${String(index).padStart(2, '0')}`,
        contact_id: `${prefix}contact_0`,
        agent_id: agentA,
        event_type: eventType
      })
    }

    const stateSentinel = await db.get(
      'SELECT included FROM conversational_agent_state_metric_rows WHERE state_id = ?',
      [stateIds.sentinel]
    )
    const previewSentinel = await db.get(
      'SELECT included FROM conversational_agent_event_metric_rows WHERE event_id = ?',
      [`${prefix}event_11`]
    )
    assert.equal(stateSentinel?.included, 0)
    assert.equal(previewSentinel?.included, 0)

    const aggregates = await loadConversationalAgentMetricAggregates()
    const metrics = buildConversationalAgentMetrics({
      agents: fixtureAgents([agentA, agentB]),
      stateSummaryRows: aggregates.stateSummaryRows,
      eventSummary: aggregates.eventSummary
    })
    assert.equal(metrics.totalTrackedConversations, 4)
    assert.equal(metrics.assignedConversations, 1)
    assert.equal(metrics.completedConversations, 1)
    assert.equal(metrics.humanTakeovers, 1)
    assert.equal(metrics.skippedConversations, 1)
    assert.equal(metrics.discardedConversations, 1)
    assert.equal(metrics.responseRate, 25)
    assert.equal(metrics.totalEvents, 11)
    assert.equal(metrics.errorEvents, 2)
    assert.equal(metrics.toolFailureEvents, 2)
    assert.equal(metrics.successRate, 25)
    assert.equal(metrics.byAgent.find(row => row.agentId === whitespaceAgent)?.skippedConversations, 1)
    assert.equal(metrics.byAgent.find(row => row.agentId === agentA)?.lastActivityAt, '2100-01-01T10:05:00.000Z')

    await db.run(`
      UPDATE conversational_agent_state
      SET agent_id = ?, status = 'active', signal = NULL,
          last_reply_at = NULL, updated_at = '2100-01-01T10:06:00.000Z'
      WHERE id = ?
    `, [agentB, stateIds.completed])
    await db.run(
      "UPDATE conversational_agent_events SET event_type = 'appointment_slot_preview_offer_created' WHERE id = ?",
      [`${prefix}event_09`]
    )

    let next = await loadConversationalAgentMetricAggregates()
    let nextMetrics = buildConversationalAgentMetrics({
      agents: fixtureAgents([agentA, agentB]),
      stateSummaryRows: next.stateSummaryRows,
      eventSummary: next.eventSummary
    })
    assert.equal(nextMetrics.completedConversations, 0)
    assert.equal(nextMetrics.assignedConversations, 2)
    assert.equal(nextMetrics.totalEvents, 10)
    assert.equal(nextMetrics.errorEvents, 1)
    assert.equal(nextMetrics.toolFailureEvents, 1)
    assert.equal(nextMetrics.byAgent.find(row => row.agentId === agentA)?.lastActivityAt, '2100-01-01T10:01:00.000Z')
    assert.equal(nextMetrics.byAgent.find(row => row.agentId === agentB)?.lastActivityAt, '2100-01-01T10:06:00.000Z')

    await db.run('DELETE FROM conversational_agent_state WHERE id = ?', [stateIds.completed])
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [`${prefix}event_10`])
    next = await loadConversationalAgentMetricAggregates()
    nextMetrics = buildConversationalAgentMetrics({
      agents: fixtureAgents([agentA, agentB]),
      stateSummaryRows: next.stateSummaryRows,
      eventSummary: next.eventSummary
    })
    assert.equal(nextMetrics.assignedConversations, 1)
    assert.equal(nextMetrics.totalEvents, 9)
    assert.equal(nextMetrics.errorEvents, 0)
    assert.equal(nextMetrics.byAgent.find(row => row.agentId === agentB)?.lastActivityAt, '2100-01-01T10:03:00.000Z')
  } finally {
    await cleanupPrefix(prefix)
  }
})

test('la expiracion paused -> active se refleja en la misma lectura de metricas', async () => {
  await ensureProjectionMigration()
  const prefix = `cam_pause_${randomUUID().replaceAll('-', '')}_`
  const contactId = `${prefix}contact`
  const stateId = `${prefix}state`
  const agentId = `${prefix}agent`

  await cleanupPrefix(prefix)
  try {
    await insertRow('contacts', { id: contactId, full_name: 'Pausa expirada' })
    await insertRow('conversational_agent_state', {
      id: stateId,
      contact_id: contactId,
      agent_id: agentId,
      status: 'paused',
      paused_until_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z'
    })

    await expirePausedConversationStates()
    const metrics = await getConversationalAgentMetrics()
    const metric = metrics.byAgent.find(row => row.agentId === agentId)
    assert.equal(metric?.pausedConversations, 0)
    assert.equal(metric?.assignedConversations, 1)
    const state = await db.get('SELECT status FROM conversational_agent_state WHERE id = ?', [stateId])
    assert.equal(state?.status, 'active')
  } finally {
    await cleanupPrefix(prefix)
  }
})

test('backfill multibatch converge con writes nuevos y el fast path no toca el historial', async () => {
  await ensureProjectionMigration()
  const prefix = `cam_backfill_${randomUUID().replaceAll('-', '')}_`
  const agentId = `${prefix}agent`
  const rowCount = 410

  await cleanupPrefix(prefix)
  try {
    await db.transaction(async tx => {
      for (let index = 0; index < rowCount; index += 1) {
        const suffix = String(index).padStart(4, '0')
        await tx.run(
          'INSERT INTO contacts (id, full_name) VALUES (?, ?)',
          [`${prefix}contact_${suffix}`, `Backfill ${suffix}`]
        )
        await tx.run(`
          INSERT INTO conversational_agent_state (
            id, contact_id, agent_id, status, signal, last_reply_at, updated_at
          ) VALUES (?, ?, ?, 'active', NULL, ?, ?)
        `, [
          `${prefix}state_${suffix}`,
          `${prefix}contact_${suffix}`,
          agentId,
          index % 2 === 0 ? `2100-02-01T10:${String(index % 60).padStart(2, '0')}:00.000Z` : null,
          `2100-02-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`
        ])
        await tx.run(`
          INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type)
          VALUES (?, ?, ?, ?)
        `, [
          `${prefix}event_${suffix}`,
          `${prefix}contact_${suffix}`,
          agentId,
          index % 3 === 0 ? 'reply_sent' : 'agent_assigned'
        ])
      }
    })

    // Simula filas historicas instaladas antes de 098: no tienen version ni
    // ledger. El delete del ledger revierte sus summaries de forma exacta.
    await db.run(`
      UPDATE conversational_agent_state
      SET agent_metrics_projection_version = 0
      WHERE id LIKE ?
    `, [`${prefix}state_%`])
    await db.run(`
      UPDATE conversational_agent_events
      SET agent_metrics_projection_version = 0
      WHERE id LIKE ?
    `, [`${prefix}event_%`])
    await db.run(
      'DELETE FROM conversational_agent_state_metric_rows WHERE state_id LIKE ?',
      [`${prefix}state_%`]
    )
    await db.run(
      'DELETE FROM conversational_agent_event_metric_rows WHERE event_id LIKE ?',
      [`${prefix}event_%`]
    )
    await db.run(`
      UPDATE conversational_agent_metrics_projection_state
      SET status = 'backfilling', last_error = NULL
      WHERE singleton_id = 1
    `)

    const originalAllWhileWarming = db.all
    const originalGetWhileWarming = db.get
    const warmingQueries = []
    db.all = async (sql, params = []) => {
      warmingQueries.push(String(sql || ''))
      return originalAllWhileWarming.call(db, sql, params)
    }
    db.get = async (sql, params = []) => {
      warmingQueries.push(String(sql || ''))
      return originalGetWhileWarming.call(db, sql, params)
    }
    let warming
    try {
      warming = await loadConversationalAgentMetricAggregates()
    } finally {
      db.all = originalAllWhileWarming
      db.get = originalGetWhileWarming
    }
    assert.equal(warming.projectionStatus, 'warming')
    assert.equal(warming.projectionReady, false)
    assert.doesNotMatch(
      warmingQueries.join('\n'),
      /FROM\s+conversational_agent_(?:state|events)[\s\S]{0,500}GROUP BY/i,
      'warming solo puede leer singleton/summaries, nunca reagrupar el remanente raw'
    )

    const backfillPromise = runConversationalAgentMetricsProjectionBackfill()
    await insertRow('contacts', {
      id: `${prefix}contact_race`,
      full_name: 'Write durante backfill'
    })
    await insertRow('conversational_agent_state', {
      id: `${prefix}state_race`,
      contact_id: `${prefix}contact_race`,
      agent_id: agentId,
      status: 'completed',
      updated_at: '2100-02-03T00:00:00.000Z'
    })
    await insertRow('conversational_agent_events', {
      id: `${prefix}event_race`,
      contact_id: `${prefix}contact_race`,
      agent_id: agentId,
      event_type: 'signal_set'
    })

    const result = await backfillPromise
    assert.equal(result.ready, true)
    assert.ok(result.passes >= 3, JSON.stringify(result))
    assert.equal(await isConversationalAgentMetricsProjectionReady(), true)

    const coverage = await db.get(`
      SELECT
        (SELECT COUNT(*) FROM conversational_agent_state WHERE id LIKE ?) AS source_states,
        (SELECT COUNT(*) FROM conversational_agent_state_metric_rows WHERE state_id LIKE ?) AS ledger_states,
        (SELECT COUNT(*) FROM conversational_agent_events WHERE id LIKE ?) AS source_events,
        (SELECT COUNT(*) FROM conversational_agent_event_metric_rows WHERE event_id LIKE ?) AS ledger_events
    `, [`${prefix}%`, `${prefix}%`, `${prefix}%`, `${prefix}%`])
    assert.equal(coverage.source_states, rowCount + 1)
    assert.equal(coverage.ledger_states, rowCount + 1)
    assert.equal(coverage.source_events, rowCount + 1)
    assert.equal(coverage.ledger_events, rowCount + 1)

    const originalAll = db.all
    const originalGet = db.get
    const queries = []
    db.all = async (sql, params = []) => {
      queries.push(String(sql || ''))
      return originalAll.call(db, sql, params)
    }
    db.get = async (sql, params = []) => {
      queries.push(String(sql || ''))
      return originalGet.call(db, sql, params)
    }
    let metrics
    try {
      metrics = await getConversationalAgentMetrics()
    } finally {
      db.all = originalAll
      db.get = originalGet
    }

    assert.equal(metrics.byAgent.find(row => row.agentId === agentId)?.totalConversations, rowCount + 1)
    assert.ok(queries.some(sql => /FROM conversational_agent_state_metric_summary/i.test(sql)))
    assert.ok(queries.some(sql => /FROM conversational_agent_event_metric_summary/i.test(sql)))
    assert.equal(queries.some(sql => /GROUP BY agent_id/i.test(sql)), false, queries.join('\n---\n'))
    assert.equal(
      queries.some(sql => /FROM conversational_agent_events\s+WHERE event_type !=/i.test(sql)),
      false,
      queries.join('\n---\n')
    )
    const sourceStateQueries = queries.filter(sql => /FROM conversational_agent_state\b/i.test(sql))
    assert.ok(sourceStateQueries.every(sql => /LIMIT\s+(?:1|500)/i.test(sql)), sourceStateQueries.join('\n---\n'))
  } finally {
    await cleanupPrefix(prefix)
  }
})
