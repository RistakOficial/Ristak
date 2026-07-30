import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sqlite3Module from 'sqlite3'
import {
  databaseReady,
  db,
  getSiteFlowInstantSqlType
} from '../src/config/database.js'
import {
  ingestSiteFlowEventBatch,
  recordSiteFlowTerminalEvent,
  SITE_FLOW_SERVER_TERMINAL_SEQUENCE
} from '../src/services/siteFlowEventsService.js'

await databaseReady

const sqlite3 = sqlite3Module.verbose()

function sqliteMemoryDatabase() {
  const connection = new sqlite3.Database(':memory:')
  return {
    exec(sql) {
      return new Promise((resolve, reject) => {
        connection.exec(sql, error => error ? reject(error) : resolve())
      })
    },
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function(error) {
          if (error) reject(error)
          else resolve({ changes: this.changes, lastID: this.lastID })
        })
      })
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => {
          if (error) reject(error)
          else resolve(rows)
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        connection.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

function flowContext(suffix, overrides = {}) {
  return {
    siteId: `site_${suffix}`,
    formSiteId: `form_${suffix}`,
    publicPageId: `page_${suffix}`,
    flowRevision: `revision_${suffix}`,
    validStepIds: ['intro', 'question', 'done'],
    validFieldIds: ['email', 'phone'],
    visitorId: `visitor_${suffix}`,
    sessionId: `session_${suffix}`,
    ...overrides
  }
}

function clientEvent(eventId, eventSequence, eventName, extra = {}) {
  return {
    eventId,
    eventSequence,
    eventName,
    clientEventAt: new Date().toISOString(),
    ...extra
  }
}

async function removeAttempt(attemptId) {
  await db.run(
    'DELETE FROM site_flow_events WHERE attempt_id = ?',
    [attemptId]
  ).catch(() => undefined)
}

test('the local bootstrap keeps SQLite timestamps compatible and installs the canonical indexes', async () => {
  const columns = await db.all('PRAGMA table_info(site_flow_events)')
  for (const columnName of ['client_event_at', 'event_at', 'created_at']) {
    assert.equal(
      columns.find(column => column.name === columnName)?.type,
      'TIMESTAMP'
    )
  }

  const formCohortColumns = await db.all(
    'PRAGMA index_info(idx_site_flow_events_form_revision_time)'
  )
  assert.deepEqual(
    formCohortColumns.map(column => column.name),
    ['form_site_id', 'flow_revision', 'event_name', 'event_at', 'attempt_id']
  )

  const retentionColumns = await db.all(
    'PRAGMA index_info(idx_site_flow_events_created_at)'
  )
  assert.deepEqual(
    retentionColumns.map(column => column.name),
    ['created_at', 'event_at', 'id']
  )
})

test('SQLite migration 139 creates the complete ledger, constraints, and query indexes', async () => {
  const database = sqliteMemoryDatabase()
  const migrationSql = await readFile(
    new URL('../migrations/versioned/139_sites_flow_events.sqlite.sql', import.meta.url),
    'utf8'
  )

  try {
    await database.exec(migrationSql)
    await database.exec(migrationSql)

    const columns = await database.all('PRAGMA table_info(site_flow_events)')
    assert.deepEqual(columns.map(column => column.name), [
      'id',
      'event_id',
      'payload_hash',
      'attempt_id',
      'event_sequence',
      'event_name',
      'visitor_id',
      'session_id',
      'contact_id',
      'site_id',
      'form_site_id',
      'public_page_id',
      'flow_revision',
      'step_id',
      'target_step_id',
      'field_id',
      'step_index',
      'step_total',
      'step_kind',
      'outcome',
      'submission_id',
      'client_event_at',
      'event_at',
      'timestamp_adjusted',
      'created_at'
    ])
    assert.equal(columns.find(column => column.name === 'id')?.pk, 1)
    for (const requiredColumn of [
      'event_id',
      'payload_hash',
      'attempt_id',
      'event_sequence',
      'event_name',
      'visitor_id',
      'session_id',
      'site_id',
      'form_site_id',
      'flow_revision'
    ]) {
      assert.equal(
        columns.find(column => column.name === requiredColumn)?.notnull,
        1,
        `${requiredColumn} must be NOT NULL`
      )
    }

    const indexes = await database.all('PRAGMA index_list(site_flow_events)')
    const indexNames = new Set(indexes.map(index => index.name))
    for (const indexName of [
      'idx_site_flow_events_form_revision_time',
      'idx_site_flow_events_site_time',
      'idx_site_flow_events_attempt_order',
      'idx_site_flow_events_visitor_time',
      'idx_site_flow_events_created_at'
    ]) {
      assert.equal(indexNames.has(indexName), true, `${indexName} must exist`)
    }
    const formCohortColumns = await database.all(
      'PRAGMA index_info(idx_site_flow_events_form_revision_time)'
    )
    assert.deepEqual(
      formCohortColumns.map(column => column.name),
      ['form_site_id', 'flow_revision', 'event_name', 'event_at', 'attempt_id']
    )
    const attemptOrderColumns = await database.all(
      'PRAGMA index_info(idx_site_flow_events_attempt_order)'
    )
    assert.deepEqual(
      attemptOrderColumns.map(column => column.name),
      ['attempt_id', 'event_sequence', 'event_at', 'id']
    )
    const retentionColumns = await database.all(
      'PRAGMA index_info(idx_site_flow_events_created_at)'
    )
    assert.deepEqual(
      retentionColumns.map(column => column.name),
      ['created_at', 'event_at', 'id']
    )

    const postgresSql = await readFile(
      new URL('../migrations/versioned/139a_sites_flow_events.postgres.sql', import.meta.url),
      'utf8'
    )
    assert.match(postgresSql, /CREATE TABLE IF NOT EXISTS site_flow_events/)
    assert.match(postgresSql, /UNIQUE \(attempt_id, event_sequence\)/)
    assert.match(postgresSql, /client_event_at TIMESTAMPTZ/)
    assert.match(postgresSql, /event_at TIMESTAMPTZ NOT NULL/)
    assert.match(postgresSql, /created_at TIMESTAMPTZ NOT NULL/)
    assert.doesNotMatch(postgresSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i)
    assert.doesNotMatch(postgresSql, /\b(?:PRAGMA|AUTOINCREMENT|randomblob)\b/i)
    assert.equal(getSiteFlowInstantSqlType('postgres'), 'TIMESTAMPTZ')
    assert.equal(getSiteFlowInstantSqlType('sqlite'), 'TIMESTAMP')
    assert.throws(
      () => getSiteFlowInstantSqlType('mysql'),
      /Dialecto no soportado/
    )

    const insertSql = `
      INSERT INTO site_flow_events (
        id, event_id, payload_hash, attempt_id, event_sequence, event_name,
        visitor_id, session_id, site_id, form_site_id, flow_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    await database.run(insertSql, [
      'row_1',
      'event_1',
      'hash_1',
      'attempt_1',
      1,
      'attempt_start',
      'visitor_1',
      'session_1',
      'site_1',
      'form_1',
      'revision_1'
    ])

    const cohortPlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT attempt_id
      FROM site_flow_events
      WHERE form_site_id = 'form_1'
        AND flow_revision = 'revision_1'
        AND event_name = 'attempt_start'
        AND event_at >= '2026-01-01T00:00:00.000Z'
        AND event_at <= '2026-12-31T23:59:59.999Z'
    `)
    assert.match(
      JSON.stringify(cohortPlan),
      /idx_site_flow_events_form_revision_time/
    )

    const retentionPlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM site_flow_events
      WHERE created_at < '2026-01-01T00:00:00.000Z'
      ORDER BY created_at, event_at, id
      LIMIT 100
    `)
    assert.match(
      JSON.stringify(retentionPlan),
      /idx_site_flow_events_created_at/
    )
    await assert.rejects(
      database.run(insertSql, [
        'row_2',
        'event_2',
        'hash_2',
        'attempt_1',
        1,
        'step_view',
        'visitor_1',
        'session_1',
        'site_1',
        'form_1',
        'revision_1'
      ]),
      error => error?.code === 'SQLITE_CONSTRAINT'
    )
    await assert.rejects(
      database.run(insertSql, [
        'row_3',
        'event_3',
        'hash_3',
        'attempt_3',
        1,
        'answer_value',
        'visitor_3',
        'session_3',
        'site_3',
        'form_3',
        'revision_3'
      ]),
      error => error?.code === 'SQLITE_CONSTRAINT'
    )
  } finally {
    await database.close()
  }
})

test('batch ingestion persists metadata once and never accepts answer values', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_batch_${suffix}`
  const context = flowContext(suffix)
  const body = {
    attemptId,
    events: [
      clientEvent(`event_start_${suffix}`, 1, 'attempt_start'),
      clientEvent(`event_intro_${suffix}`, 2, 'step_view', {
        stepId: 'intro',
        stepIndex: 1,
        stepTotal: 3,
        stepKind: 'form_page'
      }),
      clientEvent(`event_intro_complete_${suffix}`, 3, 'step_complete', {
        stepId: 'intro',
        targetStepId: 'question'
      }),
      clientEvent(`event_question_${suffix}`, 4, 'step_view', {
        stepId: 'question'
      }),
      clientEvent(`event_email_${suffix}`, 5, 'field_answered', {
        stepId: 'question',
        fieldId: 'email'
      }),
      clientEvent(`event_question_complete_${suffix}`, 6, 'step_complete', {
        stepId: 'question',
        targetStepId: 'done',
        outcome: 'advanced'
      })
    ]
  }

  try {
    const first = await ingestSiteFlowEventBatch({ body, context })
    const retry = await ingestSiteFlowEventBatch({ body, context })
    assert.deepEqual(
      {
        inserted: first.inserted,
        deduplicated: first.deduplicated,
        retryInserted: retry.inserted,
        retryDeduplicated: retry.deduplicated
      },
      {
        inserted: 6,
        deduplicated: 0,
        retryInserted: 0,
        retryDeduplicated: 6
      }
    )

    const rows = await db.all(`
      SELECT *
      FROM site_flow_events
      WHERE attempt_id = ?
      ORDER BY event_sequence
    `, [attemptId])
    assert.equal(rows.length, 6)
    assert.equal(rows[1].step_kind, 'form_page')
    assert.equal(rows[3].step_id, 'question')
    assert.equal(Number(rows[3].step_index), 2)
    assert.equal(Number(rows[3].step_total), 3)
    assert.equal(rows[4].field_id, 'email')
    assert.equal(Object.hasOwn(rows[4], 'answer'), false)
    assert.equal(Object.hasOwn(rows[4], 'answer_value'), false)
    assert.equal(Object.hasOwn(rows[4], 'value'), false)

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId: `attempt_answer_${suffix}`,
          events: [{
            ...clientEvent(`event_answer_${suffix}`, 1, 'field_answered', {
              stepId: 'question',
              fieldId: 'email'
            }),
            value: 'esto-jamás-debe-guardarse'
          }]
        },
        context
      }),
      error => error?.status === 400 && error?.code === 'SITE_FLOW_EVENT_INVALID'
    )

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId: `attempt_missing_identity_${suffix}`,
          events: [
            clientEvent(`event_missing_identity_${suffix}`, 1, 'attempt_start')
          ]
        },
        context: { ...context, sessionId: '' }
      }),
      error => error?.status === 400 &&
        error?.code === 'SITE_FLOW_EVENT_INVALID' &&
        error?.message === 'context.sessionId is required'
    )
  } finally {
    await removeAttempt(attemptId)
    await removeAttempt(`attempt_answer_${suffix}`)
    await removeAttempt(`attempt_missing_identity_${suffix}`)
  }
})

test('event id and attempt sequence conflicts roll the whole batch back', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_conflict_${suffix}`
  const context = flowContext(suffix)
  const existingEventId = `event_existing_${suffix}`

  try {
    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(existingEventId, 1, 'attempt_start'),
          clientEvent(`event_intro_${suffix}`, 2, 'step_view', {
            stepId: 'intro'
          })
        ]
      },
      context
    })

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [
            clientEvent(`event_should_rollback_${suffix}`, 3, 'step_complete', {
              stepId: 'intro',
              targetStepId: 'question'
            }),
            clientEvent(existingEventId, 4, 'step_complete', {
              stepId: 'question',
              targetStepId: 'done'
            })
          ]
        },
        context
      }),
      error => error?.status === 409 && error?.code === 'SITE_FLOW_EVENT_CONFLICT'
    )

    const rowsAfterSequenceConflict = await db.all(`
      SELECT event_id, event_sequence
      FROM site_flow_events
      WHERE attempt_id = ?
      ORDER BY event_sequence
    `, [attemptId])
    assert.deepEqual(rowsAfterSequenceConflict, [{
      event_id: existingEventId,
      event_sequence: 1
    }, {
      event_id: `event_intro_${suffix}`,
      event_sequence: 2
    }])

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [
            clientEvent(existingEventId, 4, 'step_view', {
              stepId: 'done'
            })
          ]
        },
        context
      }),
      error => error?.status === 409 && error?.code === 'SITE_FLOW_EVENT_CONFLICT'
    )
  } finally {
    await removeAttempt(attemptId)
  }
})

test('attempt state requires a unique start, prior views, monotonic sequences, and no writes after terminal', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_state_${suffix}`
  const context = flowContext(suffix)
  const start = clientEvent(`event_state_start_${suffix}`, 1, 'attempt_start')

  try {
    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [clientEvent(`event_state_no_start_${suffix}`, 1, 'step_view', {
            stepId: 'intro'
          })]
        },
        context
      }),
      error => error?.status === 409 && error?.message.includes('attempt_start')
    )

    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [start]
      },
      context
    })

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [clientEvent(`event_state_gap_${suffix}`, 3, 'step_view', {
            stepId: 'intro'
          })]
        },
        context
      }),
      error => error?.status === 409 && error?.message.includes('global attempt sequence')
    )

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [clientEvent(`event_state_unseen_${suffix}`, 2, 'field_answered', {
            stepId: 'intro',
            fieldId: 'email'
          })]
        },
        context
      }),
      error => error?.status === 409 && error?.message.includes('prior step_view')
    )

    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_state_intro_${suffix}`, 2, 'step_view', {
            stepId: 'intro'
          }),
          clientEvent(`event_state_question_${suffix}`, 3, 'step_view', {
            stepId: 'question'
          }),
          clientEvent(`event_state_intro_revisit_${suffix}`, 4, 'step_view', {
            stepId: 'intro'
          })
        ]
      },
      context
    })
    await recordSiteFlowTerminalEvent({
      attemptId,
      submissionId: `submission_state_${suffix}`,
      outcome: 'qualified',
      context,
      stepId: 'intro'
    })

    const retry = await ingestSiteFlowEventBatch({
      body: { attemptId, events: [start] },
      context
    })
    assert.equal(retry.deduplicated, 1)

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [clientEvent(`event_state_after_terminal_${suffix}`, 5, 'step_view', {
            stepId: 'done'
          })]
        },
        context
      }),
      error => error?.status === 409 && error?.message.includes('already terminal')
    )
  } finally {
    await removeAttempt(attemptId)
  }
})

test('public flow identifiers reject contact data and control characters', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const base = {
    attemptId: `attempt_ids_${suffix}`,
    events: [clientEvent(`event_ids_${suffix}`, 1, 'attempt_start')]
  }

  for (const [field, value, override] of [
    ['attempt', 'person@example.test', { body: { ...base, attemptId: 'person@example.test' } }],
    ['visitor', '+52 656 123 4567', { context: { visitorId: '+52 656 123 4567' } }],
    ['session', `session_${suffix}\nspoof`, { context: { sessionId: `session_${suffix}\nspoof` } }]
  ]) {
    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: override.body || {
          ...base,
          attemptId: `${base.attemptId}_${field}`,
          events: [clientEvent(`${base.events[0].eventId}_${field}`, 1, 'attempt_start')]
        },
        context: flowContext(`${suffix}_${field}`, override.context)
      }),
      error => error?.status === 400 && (
        error?.message.includes('opaque identifier') ||
        error?.message.includes('control characters')
      ),
      field
    )
  }
})

test('legacy printable page and field ids remain measurable', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_legacy_ids_${suffix}`
  const legacyStepId = 'Página / uno'
  const legacyFieldId = 'campo nombre'
  const context = flowContext(suffix, {
    validStepIds: [legacyStepId, 'pregunta dos'],
    validFieldIds: [legacyFieldId]
  })

  try {
    const result = await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_legacy_start_${suffix}`, 1, 'attempt_start'),
          clientEvent(`event_legacy_view_${suffix}`, 2, 'step_view', {
            stepId: legacyStepId
          }),
          clientEvent(`event_legacy_answer_${suffix}`, 3, 'field_answered', {
            stepId: legacyStepId,
            fieldId: legacyFieldId
          })
        ]
      },
      context
    })
    assert.equal(result.inserted, 3)
  } finally {
    await removeAttempt(attemptId)
  }
})

test('one form attempt can continue across server-signed public pages', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_page_transition_${suffix}`
  const firstPageContext = flowContext(suffix, {
    publicPageId: `page_intro_${suffix}`
  })
  const secondPageContext = {
    ...firstPageContext,
    publicPageId: `page_question_${suffix}`
  }

  try {
    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_page_start_${suffix}`, 1, 'attempt_start'),
          clientEvent(`event_page_intro_view_${suffix}`, 2, 'step_view', {
            stepId: 'intro'
          }),
          clientEvent(`event_page_intro_complete_${suffix}`, 3, 'step_complete', {
            stepId: 'intro',
            targetStepId: 'question'
          })
        ]
      },
      context: firstPageContext
    })
    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_page_question_view_${suffix}`, 4, 'step_view', {
            stepId: 'question'
          })
        ]
      },
      context: secondPageContext
    })

    const rows = await db.all(`
      SELECT event_sequence, public_page_id
      FROM site_flow_events
      WHERE attempt_id = ?
      ORDER BY event_sequence ASC
    `, [attemptId])
    assert.deepEqual(
      rows.map(row => [Number(row.event_sequence), row.public_page_id]),
      [
        [1, firstPageContext.publicPageId],
        [2, firstPageContext.publicPageId],
        [3, firstPageContext.publicPageId],
        [4, secondPageContext.publicPageId]
      ]
    )
  } finally {
    await removeAttempt(attemptId)
  }
})

test('attempt ingestion waits briefly for a concurrent attempt lock', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_lock_retry_${suffix}`
  const context = flowContext(suffix)
  const digest = crypto.createHash('sha256').update(attemptId).digest('hex')
  const lockName = `site-flow-attempt:${digest}`
  let releaseLock = null
  let announceLock = null
  const locked = new Promise(resolve => {
    announceLock = resolve
  })
  const release = new Promise(resolve => {
    releaseLock = resolve
  })
  const holder = db.withAdvisoryLock(lockName, async () => {
    announceLock()
    await release
  })
  await locked
  const releaseTimer = setTimeout(() => releaseLock(), 30)

  try {
    const result = await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_lock_retry_${suffix}`, 1, 'attempt_start')
        ]
      },
      context
    })
    assert.equal(result.inserted, 1)
  } finally {
    clearTimeout(releaseTimer)
    releaseLock()
    await holder
    await removeAttempt(attemptId)
  }
})

test('an attempt cannot be extended after its 24 hour server lifetime', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_ttl_${suffix}`
  const receivedAt = '2026-07-01T00:00:00.000Z'
  const clientStartedAt = '2026-07-01T00:04:00.000Z'
  const expiredAt = '2026-07-02T00:00:00.001Z'
  const context = flowContext(suffix, { receivedAt })

  try {
    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [{
          ...clientEvent(`event_ttl_start_${suffix}`, 1, 'attempt_start'),
          clientEventAt: clientStartedAt
        }]
      },
      context
    })

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [{
            ...clientEvent(`event_ttl_late_${suffix}`, 2, 'step_view', { stepId: 'intro' }),
            clientEventAt: expiredAt
          }]
        },
        context: {
          ...context,
          receivedAt: expiredAt
        }
      }),
      error => error?.status === 410 && error?.code === 'SITE_FLOW_ATTEMPT_EXPIRED'
    )
  } finally {
    await removeAttempt(attemptId)
  }
})

test('an attempt is bounded to 999 client events while reserving one server terminal', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_bound_${suffix}`
  const context = flowContext(suffix)
  const now = new Date().toISOString()

  try {
    await db.transaction(async tx => {
      for (let sequence = 1; sequence <= 999; sequence += 1) {
        await tx.run(`
          INSERT INTO site_flow_events (
            id,
            event_id,
            payload_hash,
            attempt_id,
            event_sequence,
            event_name,
            visitor_id,
            session_id,
            site_id,
            form_site_id,
            public_page_id,
            flow_revision,
            step_id,
            step_index,
            step_total,
            event_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          `row_bound_${suffix}_${sequence}`,
          `event_bound_${suffix}_${sequence}`,
          `hash_bound_${sequence}`,
          attemptId,
          sequence,
          sequence === 1 ? 'attempt_start' : 'step_view',
          context.visitorId,
          context.sessionId,
          context.siteId,
          context.formSiteId,
          context.publicPageId,
          context.flowRevision,
          sequence === 1 ? null : 'intro',
          sequence === 1 ? null : 1,
          sequence === 1 ? null : 3,
          now
        ])
      }
    })

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId,
          events: [clientEvent(`event_bound_overflow_${suffix}`, 1_000, 'step_view', {
            stepId: 'intro'
          })]
        },
        context
      }),
      error => error?.status === 409 && error?.message.includes('999 client events')
    )

    await recordSiteFlowTerminalEvent({
      attemptId,
      submissionId: `submission_bound_${suffix}`,
      outcome: 'qualified',
      context,
      stepId: 'intro'
    })
    const count = await db.get(
      'SELECT COUNT(*) AS total FROM site_flow_events WHERE attempt_id = ?',
      [attemptId]
    )
    assert.equal(Number(count?.total || 0), 1_000)
  } finally {
    await removeAttempt(attemptId)
  }
})

test('client timestamps are accepted within five minutes and clamped outside it', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_clock_${suffix}`
  const receivedAt = '2026-07-30T06:00:00.000Z'
  const context = flowContext(suffix, { receivedAt })

  try {
    const result = await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          {
            eventId: `event_stale_${suffix}`,
            eventSequence: 1,
            eventName: 'attempt_start',
            clientEventAt: '2020-01-01T00:00:00.000Z'
          },
          {
            eventId: `event_current_${suffix}`,
            eventSequence: 2,
            eventName: 'step_view',
            stepId: 'intro',
            clientEventAt: '2026-07-30T05:58:00.000Z'
          }
        ]
      },
      context
    })

    assert.deepEqual(
      result.events.map(event => ({
        eventAt: event.eventAt,
        timestampAdjusted: event.timestampAdjusted
      })),
      [
        { eventAt: receivedAt, timestampAdjusted: 1 },
        { eventAt: '2026-07-30T05:58:00.000Z', timestampAdjusted: 0 }
      ]
    )

    const rows = await db.all(`
      SELECT client_event_at, event_at, timestamp_adjusted
      FROM site_flow_events
      WHERE attempt_id = ?
      ORDER BY event_sequence
    `, [attemptId])
    assert.equal(new Date(rows[0].client_event_at).toISOString(), '2020-01-01T00:00:00.000Z')
    assert.equal(new Date(rows[0].event_at).toISOString(), receivedAt)
    assert.equal(Number(rows[0].timestamp_adjusted), 1)
    assert.equal(new Date(rows[1].event_at).toISOString(), '2026-07-30T05:58:00.000Z')
    assert.equal(Number(rows[1].timestamp_adjusted), 0)
  } finally {
    await removeAttempt(attemptId)
  }
})

test('terminal events are server-only and idempotent per attempt and submission', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const attemptId = `attempt_terminal_${suffix}`
  const context = flowContext(suffix)
  const submissionId = `submission_${suffix}`

  try {
    await ingestSiteFlowEventBatch({
      body: {
        attemptId,
        events: [
          clientEvent(`event_start_${suffix}`, 1, 'attempt_start')
        ]
      },
      context
    })

    await assert.rejects(
      ingestSiteFlowEventBatch({
        body: {
          attemptId: `attempt_spoof_${suffix}`,
          events: [
            clientEvent(`event_spoof_${suffix}`, 1, 'attempt_completed')
          ]
        },
        context
      }),
      error => error?.status === 400 &&
        error?.message.includes('server-authoritative')
    )

    const first = await recordSiteFlowTerminalEvent({
      attemptId,
      eventName: 'attempt_completed',
      submissionId,
      outcome: 'qualified',
      context,
      stepId: 'done',
      stepKind: 'thank_you'
    })
    const retry = await recordSiteFlowTerminalEvent({
      attemptId,
      eventName: 'attempt_completed',
      submissionId,
      outcome: 'qualified'
    })

    assert.equal(first.inserted, true)
    assert.equal(first.deduplicated, false)
    assert.equal(retry.inserted, false)
    assert.equal(retry.deduplicated, true)
    assert.equal(retry.eventId, first.eventId)
    assert.equal(retry.eventSequence, SITE_FLOW_SERVER_TERMINAL_SEQUENCE)

    await assert.rejects(
      recordSiteFlowTerminalEvent({
        attemptId,
        eventName: 'attempt_completed',
        submissionId,
        outcome: 'disqualified'
      }),
      error => error?.status === 409 && error?.code === 'SITE_FLOW_EVENT_CONFLICT'
    )

    await assert.rejects(
      recordSiteFlowTerminalEvent({
        attemptId,
        eventName: 'attempt_completed',
        submissionId: `other_${submissionId}`,
        outcome: 'qualified',
        context
      }),
      error => error?.status === 409 && error?.code === 'SITE_FLOW_EVENT_CONFLICT'
    )

    const terminal = await db.get(`
      SELECT *
      FROM site_flow_events
      WHERE attempt_id = ? AND event_name = 'attempt_completed'
    `, [attemptId])
    assert.equal(terminal.submission_id, submissionId)
    assert.equal(Number(terminal.event_sequence), SITE_FLOW_SERVER_TERMINAL_SEQUENCE)
    assert.equal(terminal.client_event_at, null)
    assert.equal(Number(terminal.timestamp_adjusted), 0)
  } finally {
    await removeAttempt(attemptId)
    await removeAttempt(`attempt_spoof_${suffix}`)
  }
})
