import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HIGHLEVEL_CONVERSATIONS_LOCK_TTL_MS,
  HIGHLEVEL_SYNC_LOCK_TTL_MS
} from '../src/jobs/highlevelSync.cron.js'

test('HighLevel crash leases expire before the next scheduled tick', () => {
  const fullSyncIntervalMs = 60 * 60 * 1000
  const conversationsIntervalMs = 10 * 60 * 1000

  assert.equal(HIGHLEVEL_SYNC_LOCK_TTL_MS, 55 * 60 * 1000)
  assert.ok(HIGHLEVEL_SYNC_LOCK_TTL_MS < fullSyncIntervalMs)
  assert.equal(HIGHLEVEL_CONVERSATIONS_LOCK_TTL_MS, 9 * 60 * 1000)
  assert.ok(HIGHLEVEL_CONVERSATIONS_LOCK_TTL_MS < conversationsIntervalMs)
})
