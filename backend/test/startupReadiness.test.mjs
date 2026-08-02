import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
