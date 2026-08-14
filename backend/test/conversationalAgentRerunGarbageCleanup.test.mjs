import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, databaseReady } from '../src/config/database.js'
import {
  CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
  buildConversationalRerunGarbageCleanupPlan,
  runConversationalRerunGarbageCleanup
} from '../src/services/conversationalAgentRerunGarbageCleanupService.js'

await databaseReady
await db.run(`
  CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
    run_key TEXT PRIMARY KEY,
    contact_id TEXT,
    channel TEXT,
    scheduled_for TEXT,
    payload TEXT,
    created_at TEXT
  )
`)

const CLEANUP_CONFIG_KEYS = [
  'conversational_rerun_garbage_cleanup',
  'conversational_rerun_garbage_compaction'
]

async function insertEvent({ id, contactId, eventType, detail, createdAt }) {
  await db.run(`
    INSERT INTO conversational_agent_events (
      id, contact_id, event_type, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `, [id, contactId, eventType, JSON.stringify(detail), createdAt])
}

test('limpia sólo repeticiones de mensajes capturados y conserva evidencia única', async () => {
  const suffix = randomUUID()
  const contactId = `contact-cleanup-${suffix}`
  const messageId = `message-cleanup-${suffix}`
  const unrelatedMessageId = `message-unrelated-${suffix}`
  const runKey = `whatsapp:${contactId}`
  const insertedIds = []
  let sequence = 0
  const add = async (eventType, detail, targetMessageId = messageId) => {
    sequence += 1
    const id = `cleanup-${String(sequence).padStart(2, '0')}-${suffix}`
    insertedIds.push(id)
    const createdAt = `2026-08-14 00:00:${String(sequence).padStart(2, '0')}`
    await insertEvent({
      id,
      contactId,
      eventType,
      detail: { messageId: targetMessageId, channel: 'whatsapp', ...detail },
      createdAt
    })
    return createdAt
  }
  const addLegacyError = async (detail, createdAt) => {
    sequence += 1
    const id = `cleanup-${String(sequence).padStart(2, '0')}-${suffix}`
    insertedIds.push(id)
    await insertEvent({
      id,
      contactId,
      eventType: 'error',
      detail: { channel: 'whatsapp', ...detail },
      createdAt
    })
  }

  try {
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${CLEANUP_CONFIG_KEYS.map(() => '?').join(', ')})`,
      CLEANUP_CONFIG_KEYS
    )
    await db.run(`
      INSERT INTO ai_agent_pending_reruns (
        run_key, contact_id, channel, scheduled_for, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      runKey,
      contactId,
      'whatsapp',
      '2026-08-14T00:10:00.000Z',
      JSON.stringify({ contactId, messageId, channel: 'whatsapp' }),
      '2026-08-14T00:00:00.000Z'
    ])

    for (let index = 0; index < 4; index += 1) {
      await add('agent_not_matched', {})
    }
    await add('run_suppressed_highlevel_phone_channel', {
      phase: 'after_debounce',
      reason: 'non_winning_phone_channel'
    })
    await add('run_suppressed_highlevel_phone_channel', {
      phase: 'after_debounce',
      reason: 'non_winning_phone_channel'
    })
    await add('run_suppressed_highlevel_phone_channel', {
      phase: 'after_response_wait',
      reason: 'non_winning_phone_channel'
    })
    for (let attemptCount = 1; attemptCount <= 5; attemptCount += 1) {
      const retryCreatedAt = await add('mandatory_handoff_gate_retry_queued', {
        stage: 'adjudication',
        errorCode: 'handoff_rule_adjudication_failed',
        attemptCount,
        maxAttempts: 3
      })
      await addLegacyError({
        message: 'fallo repetido de adjudicación',
        retryQueued: true,
        retryStage: 'adjudication',
        retryAttemptCount: attemptCount
      }, retryCreatedAt)
    }
    await addLegacyError({
      message: 'error legítimo fuera del loop',
      retryQueued: false
    }, '2026-08-14 00:10:00')
    await add('agent_not_matched', {}, unrelatedMessageId)
    await add('agent_not_matched', {}, unrelatedMessageId)

    const plan = await buildConversationalRerunGarbageCleanupPlan()
    assert.equal(plan.cleanupApplied, false)
    assert.deepEqual(plan.seeds, [{ contactId, messageId, channel: 'whatsapp' }])

    const result = await runConversationalRerunGarbageCleanup(plan)
    assert.equal(result.version, CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION)
    assert.equal(result.cleanup.deleted, 6)
    assert.equal(result.cleanup.retained, 11)

    const retained = await db.all(`
      SELECT event_type, detail_json
      FROM conversational_agent_events
      WHERE contact_id = ?
      ORDER BY created_at ASC, id ASC
    `, [contactId])
    assert.equal(retained.length, 14)
    assert.equal(
      retained.filter(row => row.event_type === 'agent_not_matched' &&
        JSON.parse(row.detail_json).messageId === messageId).length,
      1
    )
    assert.equal(
      retained.filter(row => JSON.parse(row.detail_json).messageId === unrelatedMessageId).length,
      2
    )
    assert.equal(
      retained.filter(row => row.event_type === 'error' &&
        JSON.parse(row.detail_json).message === 'fallo repetido de adjudicación').length,
      4
    )
    assert.equal(
      retained.filter(row => row.event_type === 'error' &&
        JSON.parse(row.detail_json).message === 'error legítimo fuera del loop').length,
      1
    )

    const repeatedPlan = await buildConversationalRerunGarbageCleanupPlan()
    assert.equal(repeatedPlan.cleanupApplied, true)
    assert.equal(repeatedPlan.compactionApplied, true)
    assert.deepEqual(repeatedPlan.seeds, [])
  } finally {
    if (insertedIds.length) {
      await db.run(
        `DELETE FROM conversational_agent_events WHERE id IN (${insertedIds.map(() => '?').join(', ')})`,
        insertedIds
      ).catch(() => {})
    }
    await db.run('DELETE FROM ai_agent_pending_reruns WHERE run_key = ?', [runKey]).catch(() => {})
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${CLEANUP_CONFIG_KEYS.map(() => '?').join(', ')})`,
      CLEANUP_CONFIG_KEYS
    ).catch(() => {})
  }
})
