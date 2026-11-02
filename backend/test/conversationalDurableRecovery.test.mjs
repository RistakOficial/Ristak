import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { databaseReady, db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import { recoverDurableConversationalAgentWork } from '../src/agents/conversational/runner.js'
import { createConversationalAgentRecoveryScheduler } from '../src/jobs/conversationalAgentRecovery.cron.js'

await databaseReady
await runVersionedMigrations()

const nowMs = Date.parse('2026-11-02T16:23:00.000Z')
const leaseUntil = '2026-11-02T16:32:22.000Z'
let nextPhone = 1000

async function fixture(t) {
  const suffix = randomUUID()
  const contactId = `durable_contact_${suffix}`
  const agentId = `durable_agent_${suffix}`
  const firstId = `durable_first_${suffix}`
  const latestId = `durable_latest_${suffix}`
  const stateId = `durable_state_${suffix}`
  const runKey = `whatsapp:${contactId}`
  const phone = `+1555000${nextPhone++}`
  await db.run('INSERT INTO contacts (id, full_name, phone) VALUES (?, ?, ?)', [contactId, 'Isolated recovery test', phone])
  await db.run('INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 1)', [agentId, 'Recovery test agent'])
  await db.run(`INSERT INTO conversational_agent_state (
    id, contact_id, agent_id, channel, status,
    inbound_processing_message_id, inbound_processing_status,
    inbound_processing_claim_token, inbound_processing_lease_until_at
  ) VALUES (?, ?, ?, 'whatsapp', 'active', ?, 'processing', 'isolated-old-claim', ?)`, [stateId, contactId, agentId, firstId, leaseUntil])
  for (const [id, at] of [[firstId, '2026-11-02T16:21:19.000Z'], [latestId, '2026-11-02T16:26:02.000Z']]) {
    await db.run(`INSERT INTO whatsapp_api_messages (
      id, contact_id, phone, direction, message_type, message_text, transport, message_timestamp, created_at
    ) VALUES (?, ?, ?, 'inbound', 'text', 'Isolated question', 'qr', ?, ?)`, [id, contactId, phone, at, at])
  }
  const schedules = []
  const dependencies = {
    featureEnabled: async () => true,
    schedule: value => schedules.push(value),
    recordEvent: async () => {}
  }
  const recover = (options = {}, overrides = {}) => recoverDurableConversationalAgentWork({ nowMs, ...options }, { ...dependencies, ...overrides })
  const pending = async at => db.run(`INSERT INTO ai_agent_pending_reruns
    (run_key, contact_id, channel, scheduled_for, payload, created_at)
    VALUES (?, ?, 'whatsapp', ?, ?, ?)`, [runKey, contactId, at, JSON.stringify({ contactId, messageId: latestId, channel: 'whatsapp' }), at])
  t.after(async () => {
    await db.run('DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_manual_assignments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  })
  return { contactId, agentId, latestId, stateId, runKey, schedules, recover, pending }
}

test('un claim vivo durante boot se recupera tras vencer sin reiniciar y usa el inbound más reciente', async t => {
  const f = await fixture(t)
  assert.equal((await f.recover()).scheduled, 0)
  // El siguiente tick puede ocurrir horas después: la obligación explícita no
  // caduca como el descubrimiento de backlog de una hora del recovery inicial.
  const result = await f.recover({ nowMs: Date.parse('2026-11-02T18:00:00.000Z') })
  assert.equal(result.scheduled, 1)
  assert.equal(f.schedules[0].latestMessage.id, f.latestId)
  assert.equal(f.schedules[0].pendingEntry.messageId, f.latestId)
  assert.equal(f.schedules[0].channel, 'whatsapp')
})

test('una intervención humana posterior impide recuperar el claim abandonado', async t => {
  const f = await fixture(t)
  for (const status of ['paused', 'skipped', 'human', 'completed', 'discarded']) {
    await db.run('UPDATE conversational_agent_state SET status = ? WHERE id = ?', [status, f.stateId])
    await f.pending('2026-11-02T16:20:00.000Z')
    assert.equal((await f.recover({ nowMs: Date.parse(leaseUntil) + 1 })).scheduled, 0, status)
    await db.run('DELETE FROM ai_agent_pending_reruns WHERE contact_id = ?', [f.contactId])
  }
  await db.run("UPDATE conversational_agent_state SET status = 'active' WHERE id = ?", [f.stateId])
  await db.run(`INSERT INTO conversational_agent_manual_assignments (contact_id, agent_id, status)
    VALUES (?, ?, 'skipped')`, [f.contactId, f.agentId])
  assert.equal((await f.recover({ nowMs: Date.parse(leaseUntil) + 1 })).scheduled, 0)
  assert.equal(f.schedules.length, 0)
})

test('el rerun conserva backoff y espera leases activos aunque su scheduled_for ya haya vencido', async t => {
  const f = await fixture(t)
  await f.pending('2026-11-02T16:40:00.000Z')
  assert.equal((await f.recover({ nowMs: Date.parse('2026-11-02T16:35:00.000Z') })).scheduled, 0)
  await db.run('UPDATE ai_agent_pending_reruns SET scheduled_for = ? WHERE contact_id = ?', ['2026-11-02T16:20:00.000Z', f.contactId])
  assert.equal((await f.recover()).scheduled, 0, 'pending due no roba un claim vivo')
  assert.equal((await f.recover({ nowMs: Date.parse(leaseUntil) + 1 })).scheduled, 1)
})

test('no descubre backlog sin obligación ni reintenta fallos sin un retry explícito', async t => {
  const f = await fixture(t)
  for (const status of [null, 'failed', 'completed']) {
    await db.run('UPDATE conversational_agent_state SET inbound_processing_status = ? WHERE id = ?', [status, f.stateId])
    assert.equal((await f.recover({ nowMs: Date.parse(leaseUntil) + 1 })).scanned, 0)
  }
  assert.equal(f.schedules.length, 0)
})

test('scheduled_for SQL sin zona y Date del driver conservan el plazo UTC', async t => {
  const f = await fixture(t)
  await f.pending('2026-11-02 16:40:00')
  assert.equal((await f.recover({ nowMs: Date.parse('2026-11-02T16:35:00.000Z') })).scheduled, 0)
  const sourceRow = {
    work_key: `pending:${f.runKey}`, contact_id: f.contactId, channel: 'whatsapp',
    scheduled_for: new Date('2026-11-02T16:40:00.000Z'), payload: '{}', agent_id: null
  }
  const database = { all: async () => [sourceRow] }
  assert.equal((await f.recover({ nowMs: Date.parse('2026-11-02T16:35:00.000Z') }, { database })).scheduled, 0)
  assert.equal((await f.recover({ nowMs: Date.parse('2026-11-02T16:41:00.000Z') }, { database })).scheduled, 1)
})

test('omite trabajo local, agentes deshabilitados, señales y cuarentena médica', async t => {
  const f = await fixture(t)
  const expired = { nowMs: Date.parse(leaseUntil) + 1 }
  assert.equal((await f.recover(expired, { isLocalWorkActive: key => key === f.runKey })).scheduled, 0)
  assert.equal((await f.recover(expired, { loadPreventive: async () => ({ id: 'medical-review', status: 'active' }) })).scheduled, 0)
  await f.pending('2026-11-02T16:20:00.000Z')
  await db.run('UPDATE conversational_agents SET enabled = 0 WHERE id = ?', [f.agentId])
  assert.equal((await f.recover(expired)).scheduled, 0)
  await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [f.agentId])
  await db.run("UPDATE conversational_agent_state SET signal = 'medical_review' WHERE id = ?", [f.stateId])
  assert.equal((await f.recover(expired)).scheduled, 0)
  assert.equal(f.schedules.length, 0)
})

test('no reproduce una entrega ambigua, sending, terminal o con lease vivo; pending vencido sí es recuperable', async t => {
  const f = await fixture(t)
  const expired = { nowMs: Date.parse(leaseUntil) + 1 }
  for (const plan of [
    { status: 'ambiguous', parts: [{ status: 'ambiguous' }] },
    { status: 'processing', parts: [{ status: 'sending' }] },
    { status: 'completed', parts: [{ status: 'sent' }] },
    { status: 'interrupted', parts: [{ status: 'pending' }] },
    { status: 'processing', leaseUntilAt: '2026-11-02T17:00:00.000Z', parts: [{ status: 'pending' }] }
  ]) {
    assert.equal((await f.recover(expired, { loadPlan: async () => plan })).scheduled, 0, plan.status)
  }
  assert.equal((await f.recover(expired, { loadPlan: async () => ({ status: 'processing', leaseUntilAt: leaseUntil, parts: [{ status: 'pending' }] }) })).scheduled, 1)
})

test('el cursor avanza después de un caso bloqueado sin enterrar otro claim', async t => {
  const first = await fixture(t)
  const second = await fixture(t)
  const options = { nowMs: Date.parse(leaseUntil) + 1, limit: 1 }
  const schedules = []
  const overrides = { schedule: value => schedules.push(value), loadPreventive: async ({ contactId }) => contactId === first.contactId ? { id: 'medical-review' } : null }
  let page = await first.recover(options, overrides)
  assert.equal(page.scanned, 1)
  assert.equal(page.hasMore, true)
  page = await first.recover({ ...options, cursor: page.nextCursor }, overrides)
  assert.equal(page.scanned, 1)
  assert.equal(schedules.length, 1)
  assert.equal(schedules[0].contactId, second.contactId)
})

test('el job periódico usa lock fail-closed, no duplica timers y deja de agendar al detenerse', async () => {
  const intervals = []
  const cleared = []
  const calls = []
  const locks = []
  const scheduler = createConversationalAgentRecoveryScheduler({
    allowed: async () => true,
    shuttingDown: () => false,
    trackWork: (_kind, callback) => callback(),
    withLock: async (name, ttl, work, options) => {
      locks.push({ name, ttl, options })
      return { ran: true, result: await work({ isLeaseValid: () => true }) }
    },
    recover: async (options, dependencies) => {
      calls.push({ options, dependencies })
      return { scanned: 1, scheduled: 1, nextCursor: calls.length === 1 ? 'claim:next' : '' }
    },
    setIntervalFn: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.push(timer); return timer },
    clearIntervalFn: timer => cleared.push(timer),
    now: () => nowMs
  })
  scheduler.start()
  scheduler.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 30_000)
  await scheduler.tick()
  assert.equal(calls[1].options.cursor, 'claim:next')
  assert.equal(locks[0].options.failOpen, false)
  assert.equal(calls[1].dependencies.canContinue(), true)
  scheduler.stop()
  assert.equal(cleared.length, 1)
  assert.equal(calls[1].dependencies.canContinue(), false)
  assert.equal((await scheduler.tick()).skipped, true)
})

test('el job no corre durante shutdown, falta de licencia, lock ajeno o tick concurrente', async () => {
  let recoveries = 0
  const base = {
    recover: async () => { recoveries += 1; return {} },
    trackWork: (_kind, work) => work(),
    allowed: async () => true,
    shuttingDown: () => false,
    withLock: async () => ({ ran: false })
  }
  assert.equal((await createConversationalAgentRecoveryScheduler(base).tick()).reason, 'locked')
  assert.equal((await createConversationalAgentRecoveryScheduler({ ...base, allowed: async () => false }).tick()).reason, 'license_blocked')
  assert.equal((await createConversationalAgentRecoveryScheduler({ ...base, shuttingDown: () => true }).tick()).skipped, true)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const scheduler = createConversationalAgentRecoveryScheduler({ ...base, allowed: async () => gate })
  const first = scheduler.tick()
  assert.equal((await scheduler.tick()).skipped, true)
  release(true)
  await first
  assert.equal(recoveries, 0)
})
