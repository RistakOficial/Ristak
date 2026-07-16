import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db, setAppConfig } from '../src/config/database.js'
import {
  CHAT_DELIVERY_COMPLETED_RETENTION_MS,
  CHAT_DELIVERY_ENRICHMENT_MAX_ATTEMPTS,
  CHAT_DELIVERY_FAILED_RETENTION_MS,
  CHAT_DELIVERY_MAX_ATTEMPTS,
  CHAT_DELIVERY_JOB_KIND,
  claimNextChatDeliveryJob,
  cleanupCompletedChatDeliveryJobs,
  completeChatDeliveryJob,
  enqueueChatDeliveryJob,
  getChatDeliveryJob,
  retryChatDeliveryJob
} from '../src/services/chatDeliveryOutboxService.js'
import { isMetaDirectWhatsAppConnected } from '../src/services/integrationConnectionStateService.js'
import {
  drainMetaDirectChatDeliveryJobs,
  resetMetaDirectChatDeliveryHandlersForTest,
  setMetaDirectChatDeliveryHandlersForTest
} from '../src/jobs/metaDirectChatDelivery.cron.js'

test('migraciones SQLite/PostgreSQL y bootstrap comparten el contrato del outbox', async () => {
  const [sqliteSql, postgresSql, serviceSource] = await Promise.all([
    readFile(new URL('../migrations/versioned/122_chat_delivery_outbox.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/122a_chat_delivery_outbox.postgres.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/chatDeliveryOutboxService.js', import.meta.url), 'utf8')
  ])
  const expectedColumns = [
    'id', 'job_kind', 'message_id', 'contact_id', 'provider', 'payload_json',
    'status', 'attempt_count', 'available_at', 'lease_owner', 'lease_expires_at',
    'last_error', 'created_at', 'updated_at', 'completed_at', 'failed_at'
  ]
  for (const sql of [sqliteSql, postgresSql]) {
    assert.match(sql, /UNIQUE \(job_kind, message_id\)/)
    assert.match(sql, /idx_chat_delivery_outbox_ready/)
    assert.match(sql, /idx_chat_delivery_outbox_completed/)
    assert.match(sql, /idx_chat_delivery_outbox_failed/)
    assert.match(sql, /'failed'/)
    for (const column of expectedColumns) assert.match(sql, new RegExp(`\\b${column}\\b`))
  }

  const bootstrapColumns = process.env.DATABASE_URL
    ? await db.all(`
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'chat_delivery_outbox'
        ORDER BY ordinal_position
      `)
    : await db.all('PRAGMA table_info(chat_delivery_outbox)')
  assert.deepEqual(bootstrapColumns.map(row => row.name), expectedColumns)
  const bootstrapIndexRows = process.env.DATABASE_URL
    ? await db.all(`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'chat_delivery_outbox'
      `)
    : await db.all('PRAGMA index_list(chat_delivery_outbox)')
  const bootstrapIndexes = new Set(bootstrapIndexRows.map(row => row.name))
  assert.ok(bootstrapIndexes.has('idx_chat_delivery_outbox_ready'))
  assert.ok(bootstrapIndexes.has('idx_chat_delivery_outbox_lease'))
  assert.ok(bootstrapIndexes.has('idx_chat_delivery_outbox_completed'))
  assert.ok(bootstrapIndexes.has('idx_chat_delivery_outbox_failed'))
  assert.equal(CHAT_DELIVERY_MAX_ATTEMPTS, 20)
  assert.equal(CHAT_DELIVERY_ENRICHMENT_MAX_ATTEMPTS, 2_016)
  assert.match(serviceSource, /databaseDialect === 'postgres' \? 'FOR UPDATE SKIP LOCKED' : ''/)
})

test('outbox deduplica por mensaje y recupera un push transitorio sin duplicar fila', async () => {
  const messageId = `outbox-push-${randomUUID()}`
  const contactId = `outbox-contact-${randomUUID()}`
  let pushCalls = 0
  try {
    await Promise.all([
      enqueueChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
        messageId,
        contactId,
        provider: 'meta_direct',
        payload: { messageId, contactId, text: 'Hola' }
      }),
      enqueueChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
        messageId,
        contactId,
        provider: 'meta_direct',
        payload: { messageId, contactId, text: 'Hola duplicado' }
      })
    ])
    assert.equal(
      Number((await db.get(`
        SELECT COUNT(*) AS total
        FROM chat_delivery_outbox
        WHERE job_kind = 'push' AND message_id = ?
      `, [messageId])).total),
      1
    )

    setMetaDirectChatDeliveryHandlersForTest({
      pushSender: async payload => {
        pushCalls += 1
        assert.equal(payload.messageId, messageId)
        assert.equal(payload.durableDelivery, true)
        if (pushCalls === 2) {
          assert.deepEqual(payload.deliveryTargets, {
            webSubscriptionIds: ['web-retry-only'],
            mobileDeviceIds: ['mobile-retry-only']
          })
        }
        return pushCalls === 1
          ? {
              sent: 0,
              attempted: 2,
              retryableFailures: 2,
              permanentFailures: 0,
              retryTargets: {
                webSubscriptionIds: ['web-retry-only'],
                mobileDeviceIds: ['mobile-retry-only']
              }
            }
          : { sent: 1, attempted: 1, retryableFailures: 0, permanentFailures: 0 }
      }
    })

    const firstDrain = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH],
      retryDelayMs: 0,
      maxJobs: 1
    })
    assert.equal(firstDrain.failed, 1)
    const pendingJob = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId })
    assert.equal(pendingJob.status, 'pending')
    assert.deepEqual(pendingJob.payload.deliveryTargets, {
      webSubscriptionIds: ['web-retry-only'],
      mobileDeviceIds: ['mobile-retry-only']
    })

    const recoveryDrain = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH],
      retryDelayMs: 0
    })
    assert.equal(recoveryDrain.completed, 1)
    assert.equal(pushCalls, 2)
    const completedJob = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId })
    assert.equal(completedJob.status, 'completed')
    assert.deepEqual(completedJob.payload, {}, 'un job terminal debe borrar PII del payload inmediatamente')
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id = ?', [messageId]).catch(() => undefined)
  }
})

test('push y enriquecimiento usan leases independientes', async () => {
  const suffix = randomUUID()
  const pushMessageId = `outbox-lane-push-${suffix}`
  const enrichmentMessageId = `outbox-lane-enrichment-${suffix}`
  let releaseEnrichment
  let reportEnrichmentStarted
  const enrichmentGate = new Promise(resolve => { releaseEnrichment = resolve })
  const enrichmentStarted = new Promise(resolve => { reportEnrichmentStarted = resolve })
  let pushCompleted = false

  try {
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
      messageId: enrichmentMessageId,
      provider: 'meta_direct',
      payload: { hasMedia: true }
    })
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
      messageId: pushMessageId,
      provider: 'meta_direct',
      payload: { messageId: pushMessageId }
    })
    setMetaDirectChatDeliveryHandlersForTest({
      enrichmentProcessor: async () => {
        reportEnrichmentStarted()
        await enrichmentGate
      },
      pushSender: async () => {
        pushCompleted = true
        return { sent: 1, attempted: 1, retryableFailures: 0 }
      }
    })

    const slowLane = drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT]
    })
    await enrichmentStarted
    const pushLane = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
    })
    assert.equal(pushLane.completed, 1)
    assert.equal(pushCompleted, true, 'un upload lento no debe tapar la push nueva')

    releaseEnrichment()
    assert.equal((await slowLane).completed, 1)
  } finally {
    releaseEnrichment?.()
    resetMetaDirectChatDeliveryHandlersForTest()
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id IN (?, ?)', [pushMessageId, enrichmentMessageId]).catch(() => undefined)
  }
})

test('PostgreSQL entrega jobs distintos a dos claimers y recupera un lease vencido', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const suffix = randomUUID()
  const messageIds = [
    `outbox-pg-claim-a-${suffix}`,
    `outbox-pg-claim-b-${suffix}`
  ]
  try {
    await Promise.all(messageIds.map(messageId => enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
      messageId,
      payload: { messageId }
    })))

    const claimed = await Promise.all([
      claimNextChatDeliveryJob({
        ownerId: `pg-claimer-a-${suffix}`,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
      }),
      claimNextChatDeliveryJob({
        ownerId: `pg-claimer-b-${suffix}`,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
      })
    ])
    assert.equal(claimed.every(Boolean), true)
    assert.equal(new Set(claimed.map(job => job.id)).size, 2)
    assert.deepEqual(new Set(claimed.map(job => job.message_id)), new Set(messageIds))
    assert.equal(claimed.every(job => job.attemptCount === 1), true)

    const expiredAt = new Date(Date.now() - 60_000).toISOString()
    await db.run(
      'UPDATE chat_delivery_outbox SET lease_expires_at = ? WHERE id = ?',
      [expiredAt, claimed[0].id]
    )
    const reclaimed = await claimNextChatDeliveryJob({
      ownerId: `pg-claimer-recovery-${suffix}`,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
    })
    assert.equal(reclaimed?.id, claimed[0].id)
    assert.equal(reclaimed?.attemptCount, 2)
    assert.equal(reclaimed?.lease_owner, `pg-claimer-recovery-${suffix}`)
  } finally {
    await db.run(
      'DELETE FROM chat_delivery_outbox WHERE message_id IN (?, ?)',
      messageIds
    ).catch(() => undefined)
  }
})

test('cleanup conserva jobs recientes y elimina completados fuera de retención', async () => {
  const oldMessageId = `outbox-old-${randomUUID()}`
  const recentMessageId = `outbox-recent-${randomUUID()}`
  try {
    for (const messageId of [oldMessageId, recentMessageId]) {
      await enqueueChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
        messageId,
        payload: { messageId }
      })
      const ownerId = `cleanup-owner-${messageId}`
      const claimed = await claimNextChatDeliveryJob({
        ownerId,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
      })
      assert.equal(claimed?.message_id, messageId)
      assert.equal(await completeChatDeliveryJob({ jobId: claimed.id, ownerId }), true)
    }

    const oldCompletedAt = new Date(Date.now() - CHAT_DELIVERY_COMPLETED_RETENTION_MS - 60_000).toISOString()
    await db.run(
      'UPDATE chat_delivery_outbox SET completed_at = ?, updated_at = ? WHERE message_id = ?',
      [oldCompletedAt, oldCompletedAt, oldMessageId]
    )
    await db.run(
      'UPDATE chat_delivery_outbox SET payload_json = ? WHERE message_id = ?',
      [JSON.stringify({ text: 'payload legacy sensible' }), recentMessageId]
    )
    const cleanup = await cleanupCompletedChatDeliveryJobs()
    assert.equal(cleanup.deleted, 1)
    assert.equal(cleanup.scrubbed, 1)
    assert.equal(await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId: oldMessageId }), null)
    const recent = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId: recentMessageId })
    assert.equal(recent?.status, 'completed')
    assert.deepEqual(recent?.payload, {})
  } finally {
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id IN (?, ?)', [oldMessageId, recentMessageId]).catch(() => undefined)
  }
})

test('agotamiento de intentos crea dead-letter durable, no se reclama otra vez y borra PII', async () => {
  const messageId = `outbox-dead-letter-${randomUUID()}`
  let calls = 0
  try {
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
      messageId,
      payload: { messageId, contactName: 'Dato sensible', text: 'No debe quedar' }
    })
    setMetaDirectChatDeliveryHandlersForTest({
      pushSender: async () => {
        calls += 1
        return {
          sent: 0,
          attempted: 1,
          retryableFailures: 1,
          retryTargets: { webSubscriptionIds: [], mobileDeviceIds: ['dead-device'] }
        }
      }
    })

    const first = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH],
      retryDelayMs: 0,
      maxAttempts: 2,
      maxJobs: 1
    })
    assert.equal(first.failed, 1)
    assert.equal(first.deadLettered, 0)

    const second = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH],
      retryDelayMs: 0,
      maxAttempts: 2,
      maxJobs: 1
    })
    assert.equal(second.failed, 1)
    assert.equal(second.deadLettered, 1)

    const failedJob = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId })
    assert.equal(failedJob.status, 'failed')
    assert.equal(failedJob.attemptCount, 2)
    assert.ok(failedJob.failed_at)
    assert.match(failedJob.last_error, /fallo\(s\) transitorio/)
    assert.deepEqual(failedJob.payload, {})

    const third = await drainMetaDirectChatDeliveryJobs({
      requireConnected: false,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH],
      retryDelayMs: 0,
      maxAttempts: 2
    })
    assert.equal(third.processed, 0)
    assert.equal(calls, 2)

    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
      messageId,
      payload: { text: 'Un replay no debe duplicar una push agotada' }
    })
    const stillFailed = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId })
    assert.equal(stillFailed.status, 'failed')
    assert.deepEqual(stillFailed.payload, {})
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id = ?', [messageId]).catch(() => undefined)
  }
})

test('un replay revive enrichment fallido sin revivir una push terminal', async () => {
  const messageId = `outbox-enrichment-replay-${randomUUID()}`
  const ownerId = `outbox-enrichment-owner-${randomUUID()}`
  try {
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
      messageId,
      payload: { mediaId: 'media-original' }
    })
    const claimed = await claimNextChatDeliveryJob({
      ownerId,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT]
    })
    assert.equal(claimed?.message_id, messageId)
    const failed = await retryChatDeliveryJob({
      jobId: claimed.id,
      ownerId,
      error: new Error('Graph agotado'),
      attemptCount: 1,
      maxAttempts: 1,
      payload: claimed.payload
    })
    assert.equal(failed.deadLettered, true)
    assert.deepEqual(
      (await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT, messageId })).payload,
      {}
    )

    const revived = await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
      messageId,
      payload: { mediaId: 'media-replayed' }
    })
    assert.equal(revived.status, 'pending')
    assert.equal(revived.attemptCount, 0)
    assert.equal(revived.failed_at, null)
    assert.deepEqual(revived.payload, { mediaId: 'media-replayed' })
  } finally {
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id = ?', [messageId]).catch(() => undefined)
  }
})

test('cleanup conserva dead-letters recientes y elimina los que vencen su retención', async () => {
  const oldMessageId = `outbox-failed-old-${randomUUID()}`
  const recentMessageId = `outbox-failed-recent-${randomUUID()}`
  try {
    for (const messageId of [oldMessageId, recentMessageId]) {
      await enqueueChatDeliveryJob({
        jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
        messageId,
        payload: { text: 'PII temporal' }
      })
      const ownerId = `failed-retention-${messageId}`
      const claimed = await claimNextChatDeliveryJob({
        ownerId,
        jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH]
      })
      const failed = await retryChatDeliveryJob({
        jobId: claimed.id,
        ownerId,
        error: new Error('agotado'),
        attemptCount: 1,
        maxAttempts: 1,
        payload: { text: 'PII que debe borrarse' }
      })
      assert.equal(failed.deadLettered, true)
    }

    const oldFailedAt = new Date(Date.now() - CHAT_DELIVERY_FAILED_RETENTION_MS - 60_000).toISOString()
    await db.run(
      'UPDATE chat_delivery_outbox SET failed_at = ?, updated_at = ? WHERE message_id = ?',
      [oldFailedAt, oldFailedAt, oldMessageId]
    )
    const cleanup = await cleanupCompletedChatDeliveryJobs()
    assert.equal(cleanup.failedDeleted, 1)
    assert.equal(await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId: oldMessageId }), null)
    const recent = await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId: recentMessageId })
    assert.equal(recent.status, 'failed')
    assert.deepEqual(recent.payload, {})
  } finally {
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id IN (?, ?)', [oldMessageId, recentMessageId]).catch(() => undefined)
  }
})

test('push durable se recupera con Meta desconectado y enrichment permanece pendiente', async () => {
  const suffix = randomUUID()
  const pushMessageId = `outbox-system-push-${suffix}`
  const enrichmentMessageId = `outbox-gated-enrichment-${suffix}`
  let pushCalls = 0
  let enrichmentCalls = 0
  try {
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.PUSH,
      messageId: pushMessageId,
      payload: { messageId: pushMessageId }
    })
    await enqueueChatDeliveryJob({
      jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT,
      messageId: enrichmentMessageId,
      payload: { hasMedia: true }
    })
    setMetaDirectChatDeliveryHandlersForTest({
      connectionChecker: async () => false,
      pushSender: async () => {
        pushCalls += 1
        return { sent: 1, attempted: 1, retryableFailures: 0 }
      },
      enrichmentProcessor: async () => {
        enrichmentCalls += 1
      }
    })

    const drained = await drainMetaDirectChatDeliveryJobs({
      requireConnected: true,
      jobKinds: [CHAT_DELIVERY_JOB_KIND.PUSH, CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT]
    })
    assert.equal(drained.completed, 1)
    assert.equal(drained.enrichmentSkipped, true)
    assert.equal(pushCalls, 1)
    assert.equal(enrichmentCalls, 0)
    assert.equal(
      (await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.PUSH, messageId: pushMessageId })).status,
      'completed'
    )
    assert.equal(
      (await getChatDeliveryJob({ jobKind: CHAT_DELIVERY_JOB_KIND.META_ENRICHMENT, messageId: enrichmentMessageId })).status,
      'pending'
    )
  } finally {
    resetMetaDirectChatDeliveryHandlersForTest()
    await db.run('DELETE FROM chat_delivery_outbox WHERE message_id IN (?, ?)', [pushMessageId, enrichmentMessageId]).catch(() => undefined)
  }
})

test('Meta conectado sigue habilitando recuperación aunque YCloud sea el provider activo', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta-detector-phone-${suffix}`
  const wabaId = `meta-detector-waba-${suffix}`
  const keys = [
    'whatsapp_api_enabled',
    'whatsapp_api_provider',
    'whatsapp_meta_direct_status',
    'whatsapp_meta_direct_system_user_token_encrypted',
    'whatsapp_meta_direct_waba_id',
    'whatsapp_meta_direct_phone_number_id'
  ]
  const previous = await db.all(`
    SELECT config_key, config_value
    FROM app_config
    WHERE config_key IN (${keys.map(() => '?').join(', ')})
  `, keys)

  try {
    await Promise.all([
      setAppConfig('whatsapp_api_enabled', '1'),
      setAppConfig('whatsapp_api_provider', 'ycloud'),
      setAppConfig('whatsapp_meta_direct_status', 'connected'),
      setAppConfig('whatsapp_meta_direct_system_user_token_encrypted', 'encrypted-token-placeholder'),
      setAppConfig('whatsapp_meta_direct_waba_id', wabaId),
      setAppConfig('whatsapp_meta_direct_phone_number_id', phoneNumberId)
    ])
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, status, api_send_enabled, created_at, updated_at
      ) VALUES (?, 'meta_direct', ?, 'CONNECTED', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [phoneNumberId, wabaId])

    assert.equal(await isMetaDirectWhatsAppConnected(), true)
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run(`DELETE FROM app_config WHERE config_key IN (${keys.map(() => '?').join(', ')})`, keys)
    for (const row of previous) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
})
