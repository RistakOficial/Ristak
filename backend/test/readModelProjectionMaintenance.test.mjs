import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createReadModelProjectionMaintenanceScheduler } from '../src/jobs/readModelProjectionMaintenance.cron.js'

test('el scheduler agenda solo proyecciones pendientes y no trabaja al apagar', async () => {
  const calls = []
  const projection = (key, state) => ({
    key,
    version: 1,
    readState: async () => state,
    schedule: () => {
      calls.push(key)
      return { scheduled: true }
    }
  })
  const scheduler = createReadModelProjectionMaintenanceScheduler({
    projections: [
      projection('ready', { projection_version: 1, status: 'ready' }),
      projection('warming', { projection_version: 1, status: 'backfilling' }),
      projection('failed', { projection_version: 1, status: 'failed' }),
      projection('old-version', { projection_version: 0, status: 'ready' }),
      projection('unavailable', null)
    ],
    shuttingDown: () => false
  })

  const result = await scheduler.tick()
  assert.deepEqual(calls, ['warming', 'failed', 'old-version'])
  assert.deepEqual(result.scheduled.map(item => item.key), calls)

  const stopped = createReadModelProjectionMaintenanceScheduler({
    projections: [projection('never', { projection_version: 0, status: 'failed' })],
    shuttingDown: () => true
  })
  assert.deepEqual(await stopped.tick(), { scheduled: [], skipped: true })
  assert.equal(calls.includes('never'), false)
})

test('el scheduler no encola ready y usa un intervalo conservador', async () => {
  let stateReads = 0
  let schedules = 0
  let observedIntervalMs = 0
  let cleared = false
  const intervalId = { unref() {} }
  const scheduler = createReadModelProjectionMaintenanceScheduler({
    projections: [{
      key: 'already-ready',
      version: 7,
      async readState() {
        stateReads += 1
        return { projection_version: 7, status: 'ready' }
      },
      schedule() {
        schedules += 1
        return { scheduled: true }
      }
    }],
    shuttingDown: () => false,
    setIntervalFn(_callback, intervalMs) {
      observedIntervalMs = intervalMs
      return intervalId
    },
    clearIntervalFn(receivedId) {
      assert.equal(receivedId, intervalId)
      cleared = true
    }
  })

  await scheduler.tick()
  await scheduler.tick()
  // Se vuelve a leer para detectar si un trigger cambió ready -> dirty entre
  // ticks, pero sólo cada 30 s y sin encolar trabajo cuando sigue listo.
  assert.equal(stateReads, 2)
  assert.equal(schedules, 0)

  assert.equal(scheduler.start(), true)
  assert.ok(observedIntervalMs >= 30_000)
  assert.equal(scheduler.stop(), true)
  assert.equal(cleared, true)
})

test('una proyección incremental continuous se revisa aunque su último estado sea ready', async () => {
  let schedules = 0
  const scheduler = createReadModelProjectionMaintenanceScheduler({
    projections: [{
      key: 'tracking-analytics',
      version: 1,
      continuous: true,
      async readState() {
        return { projection_version: 1, status: 'ready' }
      },
      schedule() {
        schedules += 1
        return { scheduled: true }
      }
    }],
    shuttingDown: () => false
  })

  const result = await scheduler.tick()
  assert.equal(schedules, 1)
  assert.deepEqual(result.scheduled, [{ key: 'tracking-analytics', queued: true }])
})

test('los tres read paths no convierten GET en comando de backfill', async () => {
  const [contacts, metrics, firstSeen, origin, server] = await Promise.all([
    readFile(new URL('../src/controllers/contactsController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/conversationalAgentMetricsProjectionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/messageFirstSeenProjectionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/originDistributionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  ])
  const chatGet = contacts.slice(
    contacts.indexOf('export const getChatContacts'),
    contacts.indexOf('export const markChatContactRead')
  )
  const metricsGet = metrics.slice(
    metrics.indexOf('export async function loadConversationalAgentMetricAggregates'),
    metrics.indexOf('async function backfillSourceBatch')
  )
  const firstSeenGet = firstSeen.slice(
    firstSeen.indexOf('export async function getProjectedMessageFirstSeenCount'),
    firstSeen.indexOf('async function backfillSourceBatch')
  )
  const originFirstSeen = origin.slice(
    origin.indexOf('async function getMessageFirstSeenCount'),
    origin.indexOf('async function getMessageAnalyticsAggregateRows')
  )

  assert.doesNotMatch(chatGet, /scheduleChatActivityProjectionBackfill|legacyMessageStatsRowsSql/)
  assert.doesNotMatch(metricsGet, /scheduleConversationalAgentMetricsProjectionBackfill|GROUP BY\s+agent_id/i)
  assert.doesNotMatch(firstSeenGet, /scheduleMessageFirstSeenProjectionBackfill/)
  assert.doesNotMatch(originFirstSeen, /GROUP BY\s+identity|FROM\s+whatsapp_api_messages/i)
  assert.match(server, /startReadModelProjectionMaintenanceScheduler\(\)/)
})
