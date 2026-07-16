import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchPushProviderJsonForTest,
  resetPushProviderTransportForTest,
  setPushProviderTransportForTest
} from '../src/services/pushNotificationsService.js'

test('el deadline push cubre también un response body que nunca termina', async () => {
  let aborted = false
  setPushProviderTransportForTest({
    timeoutMs: 20,
    fetchImpl: async (url, options = {}) => {
      options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      return {
        ok: true,
        status: 200,
        json: () => new Promise(() => {})
      }
    }
  })

  const startedAt = Date.now()
  try {
    await assert.rejects(
      fetchPushProviderJsonForTest('https://push-provider.invalid/hanging-body'),
      error => error?.code === 'push_provider_timeout'
    )
    assert.equal(aborted, true)
    assert.ok(Date.now() - startedAt < 500, 'el body colgado debe respetar el deadline corto')
  } finally {
    resetPushProviderTransportForTest()
  }
})

test('FCM 2xx con body JSON inválido falla como reintentable en vez de fingir éxito', async () => {
  setPushProviderTransportForTest({
    timeoutMs: 100,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      }
    })
  })

  try {
    await assert.rejects(
      fetchPushProviderJsonForTest('https://fcm.googleapis.com/v1/projects/test/messages:send'),
      error => error?.code === 'push_provider_invalid_response' && error?.retryable === true
    )
  } finally {
    resetPushProviderTransportForTest()
  }
})
