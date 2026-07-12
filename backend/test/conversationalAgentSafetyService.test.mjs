import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { databaseReady, db } from '../src/config/database.js'
import {
  applyConversationalAgentPreventiveMeasure,
  dispatchConversationalAgentPreventiveNotification,
  getActiveConversationalAgentPreventiveMeasure,
  normalizePreventiveMeasurePolicy,
  resolveConversationalAgentPreventiveMeasure,
  resolveConversationalAgentPreventiveMeasuresForContact,
  retryConversationalAgentPreventiveNotifications,
  withConversationalAgentSafetyLock
} from '../src/services/conversationalAgentSafetyService.js'

await databaseReady

function identity(label) {
  const suffix = randomUUID()
  return {
    agentId: `agent_${label}_${suffix}`,
    contactId: `contact_${label}_${suffix}`,
    channel: 'whatsapp',
    sourceMessageId: `message_${label}_${suffix}`
  }
}

function temporaryPolicy({ minutes = 15, notify = true } = {}) {
  return {
    id: 'ristak-default-prevention',
    version: '1',
    quarantine: { mode: 'temporary', durationMinutes: minutes },
    notification: { enabled: notify, audience: 'account_admins' }
  }
}

function indefinitePolicy({ notify = true } = {}) {
  return {
    id: 'ristak-critical-prevention',
    version: '1',
    quarantine: { mode: 'indefinite' },
    notification: { enabled: notify, audience: 'human_review' }
  }
}

async function cleanupContact(contactId) {
  await db.run(
    `DELETE FROM conversational_agent_safety_audit
     WHERE case_id IN (
       SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?
     )`,
    [contactId]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM conversational_agent_safety_events
     WHERE contact_id = ?`,
    [contactId]
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM conversational_agent_safety_cases WHERE contact_id = ?',
    [contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('la política sólo admite cuarentena reversible construida por el servidor', () => {
  assert.throws(
    () => normalizePreventiveMeasurePolicy(null),
    (error) => error?.code === 'preventive_measure_policy_required'
  )
  assert.throws(
    () => normalizePreventiveMeasurePolicy({
      id: 'unsafe',
      quarantine: { mode: 'delete_contact' },
      notification: { enabled: true }
    }),
    (error) => error?.code === 'invalid_preventive_measure_policy'
  )
  assert.deepEqual(normalizePreventiveMeasurePolicy(temporaryPolicy({ minutes: 10 })), {
    id: 'ristak-default-prevention',
    version: '1',
    quarantine: { mode: 'temporary', durationMinutes: 10 },
    notification: { enabled: true, audience: 'account_admins' }
  })
  assert.deepEqual(normalizePreventiveMeasurePolicy({
    ...temporaryPolicy(),
    notification: { enabled: true, audience: 'specific_user', userId: '42' }
  }).notification, {
    enabled: true,
    audience: 'specific_user',
    userId: '42'
  })
  assert.throws(
    () => normalizePreventiveMeasurePolicy({
      ...temporaryPolicy(),
      notification: { enabled: true, audience: 'specific_user' }
    }),
    (error) => error?.code === 'invalid_preventive_measure_policy'
  )
})

test('el fence preventivo permite que la operación protegida use sus propios advisory locks', async () => {
  const lockIdentity = identity('nested_domain_lock')
  const result = await withConversationalAgentSafetyLock(lockIdentity, async () => (
    db.withAdvisoryLock(`inner-domain-lock:${lockIdentity.contactId}`, async () => 'ok')
  ))
  assert.equal(result, 'ok')
})

test('el fence nunca repite un efecto si un candado interno reporta busy', async () => {
  const lockIdentity = identity('inner_busy_no_replay')
  let calls = 0
  await assert.rejects(
    () => withConversationalAgentSafetyLock(lockIdentity, async () => {
      calls += 1
      throw Object.assign(new Error('candado interno ocupado'), { code: 'DATABASE_ADVISORY_LOCK_BUSY' })
    }),
    (error) => error?.code === 'DATABASE_ADVISORY_LOCK_BUSY'
  )
  assert.equal(calls, 1)
})

test('aplicar una medida es idempotente, global por contacto+canal y no modifica el contacto', async () => {
  const firstIdentity = identity('global_case')
  const secondIdentity = {
    ...identity('global_case_second'),
    contactId: firstIdentity.contactId,
    channel: firstIdentity.channel
  }
  const now = Date.parse('2026-07-11T18:00:00.000Z')

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, source, created_at, updated_at)
       VALUES (?, 'Contacto intacto', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [firstIdentity.contactId, `+52656${String(Math.floor(Math.random() * 1_000_000)).padStart(7, '0')}`]
    )
    const before = await db.get(
      'SELECT id, full_name, phone, source, assigned_user_id, deleted_at FROM contacts WHERE id = ?',
      [firstIdentity.contactId]
    )

    const first = await applyConversationalAgentPreventiveMeasure({
      ...firstIdentity,
      category: 'phishing',
      severity: 'high',
      reason: 'Solicitó credenciales mediante un enlace falso.',
      evidence: { messageExcerpt: 'entra aquí', apiKey: 'no-debe-quedar' },
      serverPolicy: temporaryPolicy({ minutes: 30 }),
      now
    })
    const replay = await applyConversationalAgentPreventiveMeasure({
      ...firstIdentity,
      category: 'phishing',
      severity: 'high',
      reason: 'Solicitó credenciales mediante un enlace falso.',
      evidence: { messageExcerpt: 'entra aquí', apiKey: 'no-debe-quedar' },
      serverPolicy: temporaryPolicy({ minutes: 30 }),
      now
    })

    assert.equal(first.applied, true)
    assert.equal(replay.applied, false)
    assert.equal(replay.idempotent, true)
    assert.equal(first.event.id, replay.event.id)
    assert.equal(first.event.evidence.apiKey, '[redactado]')
    assert.equal(first.case.eventCount, 1)

    await assert.rejects(
      () => applyConversationalAgentPreventiveMeasure({
        ...firstIdentity,
        category: 'spam',
        severity: 'high',
        reason: 'Datos diferentes para la misma identidad.',
        serverPolicy: temporaryPolicy({ minutes: 30 }),
        now
      }),
      (error) => error?.code === 'preventive_measure_idempotency_conflict' && error?.statusCode === 409
    )

    const reinforced = await applyConversationalAgentPreventiveMeasure({
      ...secondIdentity,
      category: 'threat',
      severity: 'critical',
      reason: 'Amenaza explícita que requiere revisión humana.',
      serverPolicy: indefinitePolicy(),
      now: now + 1000
    })
    assert.equal(reinforced.case.id, first.case.id)
    assert.equal(reinforced.case.eventCount, 2)
    assert.equal(reinforced.case.severity, 'critical')
    assert.equal(reinforced.case.blockMode, 'indefinite')
    assert.equal(reinforced.case.blockedUntil, null)

    const after = await db.get(
      'SELECT id, full_name, phone, source, assigned_user_id, deleted_at FROM contacts WHERE id = ?',
      [firstIdentity.contactId]
    )
    assert.deepEqual(after, before)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_safety_cases WHERE contact_id = ? AND channel = ?',
      [firstIdentity.contactId, firstIdentity.channel]
    )).total), 1)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_safety_events WHERE contact_id = ? AND channel = ?',
      [firstIdentity.contactId, firstIdentity.channel]
    )).total), 2)
  } finally {
    await cleanupContact(firstIdentity.contactId)
  }
})

test('la cuarentena temporal expira de forma durable y la indefinida se resuelve manualmente', async () => {
  const temporaryIdentity = identity('temporary_expiry')
  const indefiniteIdentity = identity('manual_resolution')
  const now = Date.parse('2026-07-11T19:00:00.000Z')

  try {
    await applyConversationalAgentPreventiveMeasure({
      ...temporaryIdentity,
      category: 'spam',
      severity: 'high',
      reason: 'Ráfaga automática de mensajes repetidos.',
      serverPolicy: temporaryPolicy({ minutes: 1, notify: false }),
      now
    })
    assert.ok(await getActiveConversationalAgentPreventiveMeasure({
      contactId: temporaryIdentity.contactId,
      channel: temporaryIdentity.channel,
      now: now + 30_000
    }))
    assert.equal(await getActiveConversationalAgentPreventiveMeasure({
      contactId: temporaryIdentity.contactId,
      channel: temporaryIdentity.channel,
      now: now + 61_000
    }), null)
    const expired = await db.get(
      'SELECT status, resolved_by FROM conversational_agent_safety_cases WHERE contact_id = ? AND channel = ?',
      [temporaryIdentity.contactId, temporaryIdentity.channel]
    )
    assert.equal(expired.status, 'resolved')
    assert.equal(expired.resolved_by, 'system:auto_expiry')

    const indefinite = await applyConversationalAgentPreventiveMeasure({
      ...indefiniteIdentity,
      category: 'sexual_harassment',
      severity: 'critical',
      reason: 'Acoso sexual explícito.',
      serverPolicy: indefinitePolicy({ notify: false }),
      now
    })
    const resolved = await resolveConversationalAgentPreventiveMeasure({
      caseId: indefinite.case.id,
      resolvedBy: 'user_admin_1',
      reason: 'Un administrador revisó la conversación.',
      now: now + 10_000
    })
    const replay = await resolveConversationalAgentPreventiveMeasure({
      caseId: indefinite.case.id,
      resolvedBy: 'user_admin_1',
      reason: 'Un administrador revisó la conversación.',
      now: now + 11_000
    })
    assert.equal(resolved.resolved, true)
    assert.equal(replay.resolved, false)
    assert.equal(replay.idempotent, true)
    assert.equal(await getActiveConversationalAgentPreventiveMeasure({
      contactId: indefiniteIdentity.contactId,
      channel: indefiniteIdentity.channel,
      now: now + 12_000
    }), null)
  } finally {
    await cleanupContact(temporaryIdentity.contactId)
    await cleanupContact(indefiniteIdentity.contactId)
  }
})

test('reactivar manualmente un contacto libera todos sus canales y deja auditoría humana', async () => {
  const baseIdentity = identity('manual_contact_reactivation')
  const secondIdentity = {
    ...identity('manual_contact_reactivation_instagram'),
    contactId: baseIdentity.contactId,
    channel: 'instagram'
  }

  try {
    await applyConversationalAgentPreventiveMeasure({
      ...baseIdentity,
      category: 'spam',
      severity: 'high',
      reason: 'Spam persistente en WhatsApp.',
      serverPolicy: temporaryPolicy({ notify: false })
    })
    await applyConversationalAgentPreventiveMeasure({
      ...secondIdentity,
      category: 'threat',
      severity: 'critical',
      reason: 'Amenaza explícita en Instagram.',
      serverPolicy: indefinitePolicy({ notify: false })
    })

    const released = await resolveConversationalAgentPreventiveMeasuresForContact({
      contactId: baseIdentity.contactId,
      resolvedBy: 'user_manual_reactivation',
      reason: 'Revisión humana completada; reactivar atención.'
    })
    assert.equal(released.resolvedCount, 2)
    assert.equal(await getActiveConversationalAgentPreventiveMeasure({
      contactId: baseIdentity.contactId,
      channel: 'whatsapp'
    }), null)
    assert.equal(await getActiveConversationalAgentPreventiveMeasure({
      contactId: baseIdentity.contactId,
      channel: 'instagram'
    }), null)
    const audits = await db.all(
      `SELECT actor_id, action
       FROM conversational_agent_safety_audit
       WHERE case_id IN (
         SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?
       ) AND action = 'quarantine_resolved'`,
      [baseIdentity.contactId]
    )
    assert.equal(audits.length, 2)
    assert.ok(audits.every((audit) => audit.actor_id === 'user_manual_reactivation'))
  } finally {
    await cleanupContact(baseIdentity.contactId)
  }
})

test('la notificación se reclama una vez, conserva el fallo y se reintenta con deduplicación', async () => {
  const eventIdentity = identity('notification_retry')
  const now = Date.parse('2026-07-11T20:00:00.000Z')
  let attempts = 0

  try {
    const applied = await applyConversationalAgentPreventiveMeasure({
      ...eventIdentity,
      category: 'malicious_link',
      severity: 'high',
      reason: 'El enlace intenta redirigir a un dominio malicioso.',
      serverPolicy: temporaryPolicy({ minutes: 20, notify: true }),
      now
    })
    const failed = await dispatchConversationalAgentPreventiveNotification({
      eventId: applied.event.id,
      now,
      retryAfterMs: 1000,
      notify: async ({ dedupeKey }) => {
        attempts += 1
        assert.equal(dedupeKey, applied.event.id)
        throw new Error('notificador temporalmente caído')
      }
    })
    assert.equal(failed.sent, false)
    assert.equal(failed.event.notificationStatus, 'failed')
    assert.match(failed.event.notificationLastError, /temporalmente caído/)

    const retried = await retryConversationalAgentPreventiveNotifications({
      now: now + 2000,
      notify: async ({ dedupeKey }) => {
        attempts += 1
        return { notificationId: `notification:${dedupeKey}` }
      }
    })
    assert.equal(retried.attempted, 1)
    assert.equal(retried.sent, 1)
    assert.equal(attempts, 2)
    assert.equal(retried.results[0].event.notificationStatus, 'sent')

    const noDuplicate = await dispatchConversationalAgentPreventiveNotification({
      eventId: applied.event.id,
      now: now + 3000,
      notify: async () => {
        attempts += 1
      }
    })
    assert.equal(noDuplicate.dispatched, false)
    assert.equal(noDuplicate.sent, false)
    assert.equal(attempts, 2)

    const auditActions = (await db.all(
      'SELECT action FROM conversational_agent_safety_audit WHERE event_id = ? ORDER BY created_at ASC, id ASC',
      [applied.event.id]
    )).map((row) => row.action)
    assert.ok(auditActions.includes('notification_failed'))
    assert.ok(auditActions.includes('notification_sent'))
  } finally {
    await cleanupContact(eventIdentity.contactId)
  }
})
