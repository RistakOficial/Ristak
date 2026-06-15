import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeYCloudApiKeyInput } from '../src/utils/ycloudApiKey.js'

test('normalizeYCloudApiKeyInput accepts plain API keys', () => {
  assert.equal(normalizeYCloudApiKeyInput('  ycloud_test_key  '), 'ycloud_test_key')
})

test('normalizeYCloudApiKeyInput strips common pasted header wrappers', () => {
  assert.equal(normalizeYCloudApiKeyInput('Bearer ycloud_test_key'), 'ycloud_test_key')
  assert.equal(normalizeYCloudApiKeyInput('Authorization: Bearer ycloud_test_key'), 'ycloud_test_key')
  assert.equal(normalizeYCloudApiKeyInput('X-API-Key: ycloud_test_key'), 'ycloud_test_key')
  assert.equal(normalizeYCloudApiKeyInput('-H "X-API-Key: ycloud_test_key"'), 'ycloud_test_key')
})

test('normalizeYCloudApiKeyInput extracts API keys from structured snippets', () => {
  assert.equal(normalizeYCloudApiKeyInput('{"apiKey":"ycloud_test_key"}'), 'ycloud_test_key')
  assert.equal(normalizeYCloudApiKeyInput("'ycloud_test_key'"), 'ycloud_test_key')
})
