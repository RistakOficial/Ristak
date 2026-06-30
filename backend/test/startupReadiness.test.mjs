import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuntimeReadyForTraffic,
  runtimeHealthStatusCode
} from '../src/utils/startupReadiness.js'

test('runtime readiness only allows traffic after startup is ready', () => {
  assert.equal(isRuntimeReadyForTraffic(), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: false }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true, error: new Error('boot failed') }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true, shuttingDown: true }), false)
  assert.equal(isRuntimeReadyForTraffic({ ready: true }), true)
})

test('runtime health status blocks Render promotion while startup is running', () => {
  assert.equal(runtimeHealthStatusCode({ ready: false }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true, error: new Error('boot failed') }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true, shuttingDown: true }), 503)
  assert.equal(runtimeHealthStatusCode({ ready: true }), 200)
})
