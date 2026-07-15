import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import GHLClient from '../src/services/ghlClient.js'
import { withConversationalAgentTestMutationLock } from '../src/services/conversationalAgentTestMutationLockService.js'
import { cleanupConversationalTestAppointment } from '../src/services/conversationalAppointmentTestCleanupService.js'

await runVersionedMigrations()

function abortablePendingFetch(onCall = () => {}) {
  return async (_url, options = {}) => {
    onCall(options)
    return new Promise((resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('fetch abortado por deadline')
        error.name = 'AbortError'
        error.code = 'ABORT_ERR'
        reject(error)
      }
      if (options.signal?.aborted) rejectAbort()
      else options.signal?.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

function timeoutIsStructured(error) {
  assert.equal(error?.name, 'GHLRequestTimeoutError')
  assert.equal(error?.code, 'GHL_REQUEST_TIMEOUT')
  assert.equal(error?.status, 504)
  assert.equal(error?.statusCode, 504)
  assert.equal(error?.retryable, true)
  return true
}

test('GHLClient aborta un GET colgado al vencer el presupuesto global', async () => {
  let calls = 0
  const client = new GHLClient('test-token', 'test-location', {
    requestTimeoutMs: 25,
    fetchImpl: abortablePendingFetch(({ signal }) => {
      calls += 1
      assert.ok(signal, 'node-fetch debe recibir el AbortSignal del deadline')
    })
  })

  await assert.rejects(
    client.request('/contacts/search', { method: 'GET' }),
    (error) => {
      timeoutIsStructured(error)
      assert.equal(error.safeToRetry, true)
      assert.equal(error.remoteOutcomeAmbiguous, false)
      assert.equal(error.reconciliationRequired, false)
      assert.equal(error.timeoutPhase, 'request')
      return true
    }
  )
  assert.equal(calls, 1, 'el deadline global no debe iniciar otro fetch')
})

test('GHLClient no reintenta un POST cuyo resultado quedó ambiguo por timeout', async () => {
  let calls = 0
  const client = new GHLClient('test-token', 'test-location', {
    requestTimeoutMs: 25,
    fetchImpl: abortablePendingFetch(() => { calls += 1 })
  })

  await assert.rejects(
    client.request('/contacts/', { method: 'POST', body: { name: 'Prueba' } }),
    (error) => {
      timeoutIsStructured(error)
      assert.equal(error.safeToRetry, false)
      assert.equal(error.remoteOutcomeAmbiguous, true)
      assert.equal(error.reconciliationRequired, true)
      assert.equal(error.requestMethod, 'POST')
      return true
    }
  )
  assert.equal(calls, 1, 'un POST sin respuesta exige reconciliar; jamás se repite a ciegas')
})

test('la espera Retry-After de un 429 también respeta el deadline global', async () => {
  let calls = 0
  const client = new GHLClient('test-token', 'test-location', {
    requestTimeoutMs: 25,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: false,
        status: 429,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'retry-after' ? '60' : null
          }
        },
        text: async () => 'Too Many Requests'
      }
    }
  })

  await assert.rejects(
    client.request('/contacts/search', { method: 'GET' }),
    (error) => {
      timeoutIsStructured(error)
      assert.equal(error.timeoutPhase, 'rate_limit_wait')
      assert.equal(error.lastStatus, 429)
      assert.equal(error.safeToRetry, true)
      assert.equal(error.remoteOutcomeAmbiguous, false)
      return true
    }
  )
  assert.equal(calls, 1, 'no debe dormir 60s ni disparar otro request fuera del presupuesto')
})

test('un timeout libera el lock del tester y permite limpiar la cita temporal', async () => {
  const suffix = randomUUID()
  const agentId = `agent_ghl_timeout_${suffix}`
  const contactId = `contact_ghl_timeout_${suffix}`
  const runId = `run_ghl_timeout_${suffix}`
  const effectId = `catfx_ghl_timeout_${suffix}`
  const appointmentId = `appointment_ghl_timeout_${suffix}`
  const username = `ghl_timeout_${suffix}`
  let userId = null

  try {
    await db.run(
      `INSERT INTO users (username, password_hash, is_active)
       VALUES (?, 'test-only-hash', 1)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto timeout HighLevel', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente timeout HighLevel', 1, 'tool_calling_v2', '{}')`,
      [agentId]
    )
    await db.run(
      `INSERT INTO conversational_agent_test_runs (
         id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
       ) VALUES (?, ?, ?, ?, '{}', 'active', ?)`,
      [runId, agentId, userId, contactId, new Date(Date.now() + 60_000).toISOString()]
    )
    await db.run(
      `INSERT INTO conversational_agent_test_effects (
         id, run_id, message_id, effect_type, request_hash, status, entity_id,
         payload_json, cleanup_status, created_at, updated_at
       ) VALUES (?, ?, ?, 'appointment', 'timeout-hash', 'recorded', ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        effectId,
        runId,
        `message_ghl_timeout_${suffix}`,
        appointmentId,
        JSON.stringify({
          appointmentCreated: true,
          appointmentId,
          cleanupDueAt: new Date(Date.now() - 1_000).toISOString()
        })
      ]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, is_test, test_run_id, test_effect_id,
         test_expires_at, date_added, date_updated
       ) VALUES (?, ?, ?, 'Cita temporal timeout', 'confirmed', 'confirmed',
         ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        `calendar_ghl_timeout_${suffix}`,
        contactId,
        '2099-08-20T16:00:00.000Z',
        '2099-08-20T16:30:00.000Z',
        runId,
        effectId,
        new Date(Date.now() - 1_000).toISOString()
      ]
    )

    const client = new GHLClient('test-token', 'test-location', {
      requestTimeoutMs: 25,
      fetchImpl: abortablePendingFetch()
    })
    await assert.rejects(
      withConversationalAgentTestMutationLock({
        agentId,
        purpose: `timeout_test:${effectId}`
      }, () => client.searchContacts({ query: 'contacto', limit: 1 })),
      (error) => error?.code === 'GHL_REQUEST_TIMEOUT'
    )

    const cleanup = await cleanupConversationalTestAppointment({
      appointmentId,
      testEffectId: effectId
    })
    assert.equal(cleanup.status, 'cleaned')
    assert.equal(await db.get('SELECT id FROM appointments WHERE id = ?', [appointmentId]), null)
    assert.equal(
      (await db.get('SELECT cleanup_status FROM conversational_agent_test_effects WHERE id = ?', [effectId]))?.cleanup_status,
      'cleaned'
    )
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [effectId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
})
