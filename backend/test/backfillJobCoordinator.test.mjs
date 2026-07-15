import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  BACKFILL_JOB_PRIORITY,
  createBackfillJobCoordinator,
  waitForBackfillJobsToBecomeIdle
} from '../src/jobs/backfillJobCoordinator.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const backendDir = join(testDir, '..')
const silentLogger = { warn() {} }

test('ordena por prioridad y nunca rebasa la concurrencia configurada', async () => {
  const coordinator = createBackfillJobCoordinator({
    maxConcurrency: 1,
    yieldMs: 0,
    logger: silentLogger
  })
  const starts = []
  let active = 0
  let peakActive = 0

  const job = (key, priority) => coordinator.schedule({
    key,
    priority,
    run: async () => {
      starts.push(key)
      active += 1
      peakActive = Math.max(peakActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    }
  })

  job('maintenance', BACKFILL_JOB_PRIORITY.MAINTENANCE)
  job('critical', BACKFILL_JOB_PRIORITY.CRITICAL)
  job('normal', BACKFILL_JOB_PRIORITY.NORMAL)
  await coordinator.whenIdle()

  assert.deepEqual(starts, ['critical', 'normal', 'maintenance'])
  assert.equal(peakActive, 1)
  assert.deepEqual(coordinator.snapshot(), {
    maxConcurrency: 1,
    activeCount: 0,
    jobs: []
  })
})

test('deduplica el mismo backfill tanto en cola como durante su ejecucion', async () => {
  const coordinator = createBackfillJobCoordinator({ yieldMs: 0, logger: silentLogger })
  let executions = 0
  let release
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const gate = new Promise(resolve => { release = resolve })

  assert.equal(coordinator.schedule({
    key: 'chat-projection',
    run: async () => {
      executions += 1
      signalStarted()
      await gate
    }
  }).scheduled, true)
  assert.deepEqual(coordinator.schedule({ key: 'chat-projection', run() {} }), {
    scheduled: false,
    key: 'chat-projection',
    state: 'queued'
  })

  await started
  assert.deepEqual(coordinator.schedule({ key: 'chat-projection', run() {} }), {
    scheduled: false,
    key: 'chat-projection',
    state: 'running'
  })

  release()
  await coordinator.whenIdle()
  assert.equal(executions, 1)
})

test('un fallo queda aislado y la cola sigue atendiendo los siguientes trabajos', async () => {
  const warnings = []
  const coordinator = createBackfillJobCoordinator({
    yieldMs: 0,
    logger: { warn(message) { warnings.push(message) } }
  })
  const events = []
  let observedError = null

  coordinator.schedule({
    key: 'broken-projection',
    priority: BACKFILL_JOB_PRIORITY.HIGH,
    run: async () => {
      events.push('broken:start')
      throw new Error('boom')
    },
    onError(error) {
      observedError = error
    }
  })
  coordinator.schedule({
    key: 'healthy-projection',
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    run: async () => {
      events.push('healthy:start')
    }
  })

  await coordinator.whenIdle()
  assert.deepEqual(events, ['broken:start', 'healthy:start'])
  assert.equal(observedError?.message, 'boom')
  assert.equal(warnings.some(message => message.includes('broken-projection') && message.includes('boom')), true)
})

test('el fence distribuido espera si otra instancia usa I/O y no repite un worker ya iniciado', async () => {
  const {
    runWithProjectionBackfillIoLease,
    scheduleProjectionBackfillJob
  } = await import('../src/jobs/projectionBackfillScheduler.js')
  const waits = []
  let lockAttempts = 0
  let executions = 0
  const busyError = () => Object.assign(new Error('busy'), { code: 'DATABASE_ADVISORY_LOCK_BUSY' })
  const database = {
    async withAdvisoryLock(_key, callback, options) {
      lockAttempts += 1
      assert.deepEqual(options, { pinConnection: false })
      if (lockAttempts === 1) throw busyError()
      return callback()
    }
  }

  const result = await runWithProjectionBackfillIoLease(async () => {
    executions += 1
    return 'ready'
  }, {
    database,
    minRetryMs: 3,
    maxRetryMs: 10,
    sleepFn: async ms => { waits.push(ms) }
  })

  assert.equal(result, 'ready')
  assert.equal(lockAttempts, 2)
  assert.equal(executions, 1)
  assert.deepEqual(waits, [3])

  let callbackAttempts = 0
  await assert.rejects(
    runWithProjectionBackfillIoLease(async () => {
      callbackAttempts += 1
      throw busyError()
    }, {
      database: { async withAdvisoryLock(_key, callback) { return callback() } },
      sleepFn: async () => assert.fail('no debe reintentar despues de iniciar el worker')
    }),
    error => error?.code === 'DATABASE_ADVISORY_LOCK_BUSY'
  )
  assert.equal(callbackAttempts, 1)

  let coordinatedExecutions = 0
  assert.equal(scheduleProjectionBackfillJob({
    key: 'real-distributed-fence-smoke',
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    run: async () => { coordinatedExecutions += 1 }
  }).scheduled, true)
  assert.equal(scheduleProjectionBackfillJob({
    key: 'real-distributed-fence-smoke',
    run() { coordinatedExecutions += 1 }
  }).scheduled, false)
  await waitForBackfillJobsToBecomeIdle()
  assert.equal(coordinatedExecutions, 1)
})

test('los schedulers de proyecciones de startup usan el coordinador global despues de readiness', async () => {
  const serverSource = await readFile(join(backendDir, 'src/server.js'), 'utf8')
  const directStartupServices = [
    ['trackingVisitorProjectionService.js', 'scheduleTrackingVisitorProjectionBackfill'],
    ['crmListProjectionService.js', 'scheduleCrmListProjectionBackfill']
  ]

  for (const [fileName, schedulerName] of directStartupServices) {
    assert.match(serverSource, new RegExp(`\\b${schedulerName}\\(\\)`))
    assert.ok(
      serverSource.indexOf('startupState.ready = true') < serverSource.indexOf(`${schedulerName}()`),
      `${schedulerName} debe arrancar despues de publicar readiness`
    )
    const serviceSource = await readFile(join(backendDir, 'src/services', fileName), 'utf8')
    assert.match(serviceSource, /scheduleProjectionBackfillJob\s*\(\s*\{/)
    assert.match(serviceSource, /BACKFILL_JOB_PRIORITY\.[A-Z_]+/)
  }

  assert.match(serverSource, /\bstartReadModelProjectionMaintenanceScheduler\(\)/)
  assert.ok(
    serverSource.indexOf('startupState.ready = true') < serverSource.indexOf('startReadModelProjectionMaintenanceScheduler()'),
    'startReadModelProjectionMaintenanceScheduler debe arrancar despues de publicar readiness'
  )

  const maintenanceSource = await readFile(join(backendDir, 'src/jobs/readModelProjectionMaintenance.cron.js'), 'utf8')
  const maintenanceServices = [
    ['contactPersonIdentityProjectionService.js', 'scheduleContactPersonIdentityProjectionBackfill'],
    ['chatActivityProjectionService.js', 'scheduleChatActivityProjectionBackfill'],
    ['conversationalAgentMetricsProjectionService.js', 'scheduleConversationalAgentMetricsProjectionBackfill'],
    ['messageFirstSeenProjectionService.js', 'scheduleMessageFirstSeenProjectionBackfill'],
    ['trackingVisitorProjectionService.js', 'scheduleTrackingVisitorProjectionBackfill']
  ]

  for (const [fileName, schedulerName] of maintenanceServices) {
    assert.match(maintenanceSource, new RegExp(`\\b${schedulerName}\\b`))
    const serviceSource = await readFile(join(backendDir, 'src/services', fileName), 'utf8')
    assert.match(serviceSource, /scheduleProjectionBackfillJob\s*\(\s*\{/)
    assert.match(serviceSource, /BACKFILL_JOB_PRIORITY\.[A-Z_]+/)
  }
})
