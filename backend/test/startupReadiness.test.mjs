import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDatabaseStorageRecoveryWatchdog,
  isDatabaseStorageOutageOffer,
  isRuntimeReadyForTraffic,
  runtimeHealthStatusCode
} from '../src/utils/startupReadiness.js'

test('database storage recovery only accepts a confirmed full or suspended offer', () => {
  assert.equal(isDatabaseStorageOutageOffer({ storage_full: true }), true)
  assert.equal(isDatabaseStorageOutageOffer({ postgres_status: 'SUSPENDED' }), true)
  assert.equal(isDatabaseStorageOutageOffer({ usage_percent: 99 }), true)
  assert.equal(isDatabaseStorageOutageOffer({ usage_percent: 98.9, postgres_status: 'available' }), false)
  assert.equal(isDatabaseStorageOutageOffer(), false)
})

test('runtime readiness only allows traffic after startup is ready', () => {
  assert.equal(isRuntimeReadyForTraffic(), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: false }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true, error: new Error('boot failed') }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true, shuttingDown: true }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true }), true)
})

test('runtime readiness keeps Render online only for confirmed database storage recovery', () => {
  const startupError = new Error('database unavailable')

  assert.equal(isRuntimeReadyForTraffic({
    ready: false,
    error: startupError,
    recoveryMode: 'database_storage'
  }), true)
  assert.equal(isRuntimeReadyForTraffic({
    ready: false,
    error: startupError,
    recoveryMode: 'database_storage',
    shuttingDown: true
  }), false)
  assert.equal(isRuntimeReadyForTraffic({
    ready: false,
    error: startupError,
    recoveryMode: 'unknown'
  }), false)
})

test('runtime health status blocks Render promotion while startup is running', () => {
  assert.equal(runtimeHealthStatusCode({ ready: false }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true, error: new Error('boot failed') }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true, shuttingDown: true }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true }), 200)
  assert.equal(runtimeHealthStatusCode({
    ready: false,
    error: new Error('database unavailable'),
    recoveryMode: 'database_storage'
  }), 200)
})

test('storage recovery watchdog requests one restart after consecutive healthy confirmations', async () => {
  let restartRequests = 0
  const confirmations = []
  const watchdog = createDatabaseStorageRecoveryWatchdog({
    isRecoveryActive: () => true,
    probeDatabase: async () => true,
    fetchStorageOffer: async () => ({ postgres_status: 'available', usage_percent: 18 }),
    isStorageOutageOffer: isDatabaseStorageOutageOffer,
    onHealthyCheck: ({ consecutiveHealthyChecks }) => confirmations.push(consecutiveHealthyChecks),
    onRecoveryStable: async () => { restartRequests += 1 }
  })

  assert.equal((await watchdog.check()).state, 'confirming')
  assert.equal((await watchdog.check()).state, 'restart_requested')
  assert.equal((await watchdog.check()).state, 'restart_requested')
  assert.deepEqual(confirmations, [1, 2])
  assert.equal(restartRequests, 1)
  assert.equal(watchdog.getState().restartRequested, true)
})

test('storage recovery watchdog resets confirmations while database or storage remain unhealthy', async () => {
  let databaseReachable = true
  let offer = { postgres_status: 'available', usage_percent: 20 }
  let restartRequests = 0
  const watchdog = createDatabaseStorageRecoveryWatchdog({
    isRecoveryActive: () => true,
    probeDatabase: async () => databaseReachable,
    fetchStorageOffer: async () => offer,
    isStorageOutageOffer: isDatabaseStorageOutageOffer,
    onRecoveryStable: async () => { restartRequests += 1 }
  })

  assert.equal((await watchdog.check()).state, 'confirming')
  databaseReachable = false
  assert.equal((await watchdog.check()).state, 'database_unavailable')
  databaseReachable = true
  assert.equal((await watchdog.check()).state, 'confirming')
  offer = { postgres_status: 'suspended', storage_full: true }
  assert.equal((await watchdog.check()).state, 'storage_outage')
  offer = { postgres_status: 'available', usage_percent: 20 }
  assert.equal((await watchdog.check()).state, 'confirming')
  assert.equal((await watchdog.check()).state, 'restart_requested')
  assert.equal(restartRequests, 1)
})

test('storage recovery watchdog retries after transient checks fail and stays inactive outside recovery', async () => {
  let recoveryActive = false
  let shouldFail = true
  const errors = []
  let restartRequests = 0
  const watchdog = createDatabaseStorageRecoveryWatchdog({
    isRecoveryActive: () => recoveryActive,
    probeDatabase: async () => {
      if (shouldFail) throw new Error('connection refused')
      return true
    },
    fetchStorageOffer: async () => ({ postgres_status: 'available', usage_percent: 20 }),
    isStorageOutageOffer: isDatabaseStorageOutageOffer,
    onCheckError: (error) => errors.push(error.message),
    onRecoveryStable: async () => { restartRequests += 1 }
  })

  assert.equal((await watchdog.check()).state, 'inactive')
  recoveryActive = true
  assert.equal((await watchdog.check()).state, 'check_failed')
  assert.deepEqual(errors, ['connection refused'])
  shouldFail = false
  assert.equal((await watchdog.check()).state, 'confirming')
  assert.equal((await watchdog.check()).state, 'restart_requested')
  assert.equal(restartRequests, 1)
})

test('storage recovery watchdog does not overlap slow checks', async () => {
  let releaseProbe
  const probeBlocked = new Promise((resolve) => { releaseProbe = resolve })
  const watchdog = createDatabaseStorageRecoveryWatchdog({
    isRecoveryActive: () => true,
    probeDatabase: async () => {
      await probeBlocked
      return true
    },
    fetchStorageOffer: async () => ({ postgres_status: 'available', usage_percent: 20 }),
    isStorageOutageOffer: isDatabaseStorageOutageOffer,
    onRecoveryStable: async () => {}
  })

  const firstCheck = watchdog.check()
  assert.equal((await watchdog.check()).state, 'busy')
  releaseProbe()
  assert.equal((await firstCheck).state, 'confirming')
})
