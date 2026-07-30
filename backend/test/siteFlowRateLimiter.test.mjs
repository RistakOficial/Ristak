import test from 'node:test'
import assert from 'node:assert/strict'

import { createSiteFlowRateLimiter } from '../src/services/siteFlowRateLimiter.js'

test('form progress limiter is event-aware, request-aware, windowed, and LRU bounded', () => {
  let currentTime = 1_000
  const limiter = createSiteFlowRateLimiter({
    windowMs: 1_000,
    maxBuckets: 2,
    maxRequests: 2,
    maxEvents: 3,
    now: () => currentTime
  })

  limiter.consume({ ip: 'ip-a', siteKey: 'site', eventCount: 1 })
  limiter.consume({ ip: 'ip-b', siteKey: 'site', eventCount: 2 })
  limiter.consume({ ip: 'ip-a', siteKey: 'site', eventCount: 1 })
  limiter.consume({ ip: 'ip-c', siteKey: 'site', eventCount: 1 })
  assert.equal(limiter.size, 2)

  const recreatedEvictedBucket = limiter.consume({
    ip: 'ip-b',
    siteKey: 'site',
    eventCount: 2
  })
  assert.deepEqual(
    {
      requests: recreatedEvictedBucket.requests,
      events: recreatedEvictedBucket.events
    },
    { requests: 1, events: 2 }
  )
  assert.equal(limiter.size, 2)

  assert.throws(
    () => limiter.consume({ ip: 'ip-b', siteKey: 'site', eventCount: 2 }),
    error => error?.status === 429 && error?.code === 'rate_limited'
  )

  currentTime += 1_001
  const reset = limiter.consume({ ip: 'ip-b', siteKey: 'site', eventCount: 3 })
  assert.deepEqual(
    { requests: reset.requests, events: reset.events },
    { requests: 1, events: 3 }
  )
  assert.throws(
    () => limiter.consume({ ip: 'ip-b', siteKey: 'site', eventCount: 1 }),
    error => error?.status === 429 && error?.code === 'rate_limited'
  )
})
