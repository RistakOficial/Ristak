import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  getHighLevelPaymentPlanMirrorCronState,
  runHighLevelPaymentPlanMirrorTick,
  startHighLevelPaymentPlanMirrorCron,
  stopHighLevelPaymentPlanMirrorCron
} from '../src/jobs/highlevelPaymentPlansMirror.cron.js'
import { registerIntegrationCrons } from '../src/jobs/integrationCronRegistry.js'
import {
  getIntegrationCronState,
  registerIntegrationCron,
  syncIntegrationCron
} from '../src/jobs/integrationCronRuntime.js'
import { isHighLevelConnected } from '../src/services/integrationConnectionStateService.js'
import { syncHighLevelPaymentPlanMirrors } from '../src/services/highlevelPaymentPlanMirrorService.js'

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeSchedule(id, overrides = {}) {
  return {
    _id: id,
    name: `Plan ${id}`,
    status: 'active',
    currency: 'USD',
    total: 125,
    contactDetails: { name: `Contacto ${id}` },
    schedule: {
      rrule: {
        intervalType: 'monthly',
        interval: 1,
        startDate: '2026-08-01'
      }
    },
    items: [{ name: 'Mensualidad', amount: 125, qty: 1 }],
    ...overrides
  }
}

async function restoreRows(table, rows) {
  await db.run(`DELETE FROM ${table}`)
  for (const row of rows) {
    const columns = Object.keys(row)
    const quoted = columns.map(column => `"${column}"`).join(', ')
    await db.run(
      `INSERT INTO ${table} (${quoted}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => row[column])
    )
  }
}

test('materializador GHL avanza por checkpoint acotado y reintenta sin duplicar planes', async () => {
  const ids = [uniqueId('ghl_plan_a'), uniqueId('ghl_plan_b'), uniqueId('ghl_plan_c')]
  let firstStatus = 'active'
  const calls = []
  const client = {
    locationId: uniqueId('ghl_location'),
    async listInvoiceSchedules({ limit, offset }) {
      calls.push({ limit, offset })
      const schedules = offset === 0
        ? [makeSchedule(ids[0], { status: firstStatus }), makeSchedule(ids[1])]
        : offset === 2
          ? [makeSchedule(ids[2], { currency: undefined })]
          : []
      return { schedules, totalCount: 3 }
    }
  }
  const checkpointStore = {
    value: null,
    async read() { return this.value },
    async write(value) { this.value = value }
  }

  try {
    const first = await syncHighLevelPaymentPlanMirrors({
      client,
      accountCurrency: 'CAD',
      pageSize: 2,
      maxPages: 1,
      checkpointStore
    })
    assert.deepEqual(calls.map(call => call.offset), [0])
    assert.equal(first.pages, 1)
    assert.equal(first.fetched, 2)
    assert.equal(first.nextOffset, 2)
    assert.equal(first.cycleCompleted, false)

    const second = await syncHighLevelPaymentPlanMirrors({
      client,
      accountCurrency: 'CAD',
      pageSize: 2,
      maxPages: 1,
      checkpointStore
    })
    assert.deepEqual(calls.map(call => call.offset), [0, 2])
    assert.equal(second.fetched, 1)
    assert.equal(second.nextOffset, 0)
    assert.equal(second.cycleCompleted, true)

    firstStatus = 'completed'
    await syncHighLevelPaymentPlanMirrors({
      client,
      accountCurrency: 'CAD',
      pageSize: 2,
      maxPages: 1,
      checkpointStore
    })
    assert.deepEqual(calls.map(call => call.offset), [0, 2, 0])

    const rows = await db.all(
      `SELECT id, status, source, currency
       FROM payment_plans
       WHERE id IN (${ids.map(() => '?').join(', ')})
       ORDER BY id`,
      ids
    )
    assert.equal(rows.length, 3)
    assert.equal(rows.find(row => row.id === ids[0])?.status, 'completed')
    assert.equal(rows.every(row => row.source === 'ghl'), true)
    assert.equal(rows.find(row => row.id === ids[0])?.currency, 'USD')
    assert.equal(rows.find(row => row.id === ids[2])?.currency, 'CAD')
  } finally {
    await db.run(`DELETE FROM payment_plans WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
  }
})

test('materializador GHL limita cada tick y corta si el proveedor ignora el offset', async () => {
  const ids = [uniqueId('ghl_bound_a'), uniqueId('ghl_bound_b'), uniqueId('ghl_bound_c')]
  const calls = []
  const checkpointStore = {
    value: null,
    async read() { return this.value },
    async write(value) { this.value = value }
  }
  const client = {
    locationId: uniqueId('ghl_bound_location'),
    async listInvoiceSchedules({ offset }) {
      calls.push(offset)
      return {
        schedules: [makeSchedule(ids[Math.min(offset, ids.length - 1)])],
        hasMore: true
      }
    }
  }

  try {
    const bounded = await syncHighLevelPaymentPlanMirrors({
      client,
      accountCurrency: 'USD',
      pageSize: 1,
      maxPages: 99,
      checkpointStore
    })
    assert.deepEqual(calls, [0, 1, 2])
    assert.equal(bounded.pages, 3)
    assert.equal(bounded.nextOffset, 3)

    const stalled = await syncHighLevelPaymentPlanMirrors({
      client,
      accountCurrency: 'USD',
      pageSize: 1,
      maxPages: 1,
      checkpointStore
    })
    assert.deepEqual(calls, [0, 1, 2, 3])
    assert.equal(stalled.paginationStalled, true)
    assert.equal(stalled.nextOffset, 0)
  } finally {
    await db.run(`DELETE FROM payment_plans WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
  }
})

test('cron del espejo GHL no duplica timers y deja de ejecutar al apagarse', async () => {
  stopHighLevelPaymentPlanMirrorCron()
  let scheduleCalls = 0
  let scheduledCallback = null
  let stops = 0
  let destroys = 0
  let runs = 0

  const schedule = (expression, callback) => {
    scheduleCalls += 1
    scheduledCallback = callback
    assert.match(expression, /\*/)
    return {
      stop() { stops += 1 },
      destroy() { destroys += 1 }
    }
  }
  const run = async () => { runs += 1 }

  try {
    assert.equal(startHighLevelPaymentPlanMirrorCron({ schedule, run, runOnStart: false }), true)
    assert.equal(startHighLevelPaymentPlanMirrorCron({ schedule, run, runOnStart: false }), true)
    assert.equal(scheduleCalls, 1)
    assert.equal(getHighLevelPaymentPlanMirrorCronState().active, true)

    await scheduledCallback()
    assert.equal(runs, 1)

    stopHighLevelPaymentPlanMirrorCron()
    assert.equal(getHighLevelPaymentPlanMirrorCronState().active, false)
    assert.equal(stops, 1)
    assert.equal(destroys, 1)

    await scheduledCallback()
    assert.equal(runs, 1)
  } finally {
    stopHighLevelPaymentPlanMirrorCron()
  }
})

test('tick GHL usa lease distribuido fail-closed antes de consultar schedules', async () => {
  stopHighLevelPaymentPlanMirrorCron()
  const schedule = () => ({ stop() {}, destroy() {} })
  let lockName = ''
  let lockTtl = 0
  let lockOptions = null
  let syncs = 0

  try {
    startHighLevelPaymentPlanMirrorCron({ schedule, runOnStart: false })
    const execution = await runHighLevelPaymentPlanMirrorTick({
      canRun: async () => true,
      withLock: async (name, ttl, callback, options) => {
        lockName = name
        lockTtl = ttl
        lockOptions = options
        return { ran: true, result: await callback({ isLeaseValid: () => true }) }
      },
      sync: async ({ shouldContinue }) => {
        syncs += 1
        assert.equal(shouldContinue(), true)
        return { saved: 1, fetched: 1, pages: 1, nextOffset: 0 }
      }
    })

    assert.equal(execution.ran, true)
    assert.equal(lockName, 'highlevel-payment-plan-mirror')
    assert.equal(lockTtl > 10 * 60 * 1000, true)
    assert.deepEqual(lockOptions, { failOpen: false })
    assert.equal(syncs, 1)
  } finally {
    stopHighLevelPaymentPlanMirrorCron()
  }
})

test('registro del espejo GHL queda gateado por conexión local y se apaga al desconectar', async () => {
  const snapshot = await db.all('SELECT * FROM highlevel_config')
  const name = uniqueId('highlevel_payment_plan_gate')
  let starts = 0
  let stops = 0

  registerIntegrationCrons()
  assert.equal(
    getIntegrationCronState().some(entry => (
      entry.name === 'highlevel-payment-plan-mirror' && entry.provider === 'highlevel'
    )),
    true
  )

  registerIntegrationCron({
    name,
    label: 'HighLevel planes focal',
    provider: 'highlevel',
    isEnabled: isHighLevelConnected,
    start: async () => { starts += 1 },
    stop: async () => { stops += 1 }
  })

  try {
    await db.run('DELETE FROM highlevel_config')
    assert.equal((await syncIntegrationCron(name, { reason: 'disconnected' })).active, false)
    assert.equal(starts, 0)

    await db.run(
      `INSERT INTO highlevel_config (location_id, api_token, location_data)
       VALUES (?, ?, '{}')`,
      [uniqueId('loc'), uniqueId('token')]
    )
    assert.equal((await syncIntegrationCron(name, { reason: 'connected' })).active, true)
    assert.equal((await syncIntegrationCron(name, { reason: 'connected-again' })).active, true)
    assert.equal(starts, 1)

    await db.run('DELETE FROM highlevel_config')
    assert.equal((await syncIntegrationCron(name, { reason: 'disconnected-again' })).active, false)
    assert.equal(stops, 1)
  } finally {
    await db.run('DELETE FROM highlevel_config')
    await restoreRows('highlevel_config', snapshot)
  }
})
