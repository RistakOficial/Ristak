import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { expirePausedConversationStates } from '../src/services/conversationalAgentService.js'

test('dos workers solo reactivan y auditan una pausa una vez', async () => {
  const state = {
    id: 'state-1',
    contact_id: 'contact-1',
    agent_id: 'agent-1',
    status: 'paused',
    paused_until_at: '2026-07-14T00:00:00.000Z'
  }
  let events = 0
  let transactionQueue = Promise.resolve()

  const transaction = {
    async all(sql) {
      if (!sql.includes('FROM conversational_agent_state')) throw new Error('Consulta inesperada')
      return state.status === 'paused' ? [{ ...state }] : []
    },
    async run(sql) {
      if (sql.includes('UPDATE conversational_agent_state')) {
        if (state.status !== 'paused') return { changes: 0 }
        state.status = 'active'
        state.paused_until_at = null
        return { changes: 1 }
      }
      if (sql.includes('INSERT INTO conversational_agent_events')) {
        events += 1
        return { changes: 1 }
      }
      throw new Error('Mutación inesperada')
    }
  }
  const database = {
    transaction(callback) {
      const pending = transactionQueue.then(() => callback(transaction))
      transactionQueue = pending.catch(() => undefined)
      return pending
    }
  }

  const results = await Promise.all([
    expirePausedConversationStates({ database, nowIso: '2026-07-14T01:00:00.000Z' }),
    expirePausedConversationStates({ database, nowIso: '2026-07-14T01:00:00.000Z' })
  ])

  assert.deepEqual(results.sort((left, right) => right - left), [1, 0])
  assert.equal(state.status, 'active')
  assert.equal(events, 1)
})

test('métricas y listados son GET puros; la expiración vive en un job acotado', async () => {
  const [serviceSource, jobSource, serverSource] = await Promise.all([
    readFile(new URL('../src/services/conversationalAgentService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/jobs/conversationalAgentPauseExpiry.cron.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  ])

  const metricsBody = serviceSource.match(
    /export async function getConversationalAgentMetrics\(\) \{([\s\S]*?)\n\}/
  )?.[1] || ''
  const contactListBody = serviceSource.match(
    /export async function listConversationStatesForContact[\s\S]*?\{([\s\S]*?)\n\}/
  )?.[1] || ''
  const globalListBody = serviceSource.match(
    /export async function listConversationStates\([\s\S]*?\{([\s\S]*?)\n\}/
  )?.[1] || ''

  assert.doesNotMatch(metricsBody, /expirePausedConversationStates/)
  assert.doesNotMatch(contactListBody, /expirePausedConversationStates/)
  assert.doesNotMatch(globalListBody, /expirePausedConversationStates/)
  assert.match(serviceSource, /database\.transaction\(async \(transaction\)/)
  assert.match(serviceSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(serviceSource, /paused_until_at <= \?/)
  assert.match(jobSource, /const INTERVAL_MS = 5_000/)
  assert.match(jobSource, /MAX_BATCHES_PER_TICK = 4/)
  assert.match(serverSource, /startConversationalAgentPauseExpiryCron\(\)/)
})
