import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileIdentityRangePoints,
  compileReturningRangePoints,
  TRACKING_ANALYTICS_FAST_FACETS,
  TRACKING_ANALYTICS_RANGE_ROLLUP_LIMITS
} from '../src/services/trackingAnalyticsRangeRollupService.js'
import { normalizeTrafficSource } from '../src/utils/trafficSourceNormalizer.js'

function countAt(points, entityType, startDate, endDate) {
  return [...points.values()].reduce((total, row) => (
    row.entity_type === entityType &&
    row.start_boundary <= startDate &&
    row.occurrence_date <= endDate
      ? total + Number(row.range_delta || 0)
      : total
  ), 0)
}

test('el ledger 2D reconecta predecessor/successor y resuelve rangos de un día sin aproximar', () => {
  const original = compileIdentityRangePoints(['2026-01-01', '2026-01-03'], 'visitor')
  assert.equal(countAt(original, 'visitor', '2026-01-01', '2026-01-01'), 1)
  assert.equal(countAt(original, 'visitor', '2026-01-02', '2026-01-02'), 0)
  assert.equal(countAt(original, 'visitor', '2027-01-01', '2027-01-02'), 0)

  const withLateEvent = compileIdentityRangePoints(
    ['2026-01-01', '2026-01-02', '2026-01-03'],
    'visitor'
  )
  assert.equal(countAt(withLateEvent, 'visitor', '2026-01-02', '2026-01-02'), 1)
  assert.equal(countAt(withLateEvent, 'visitor', '2026-01-02', '2026-01-03'), 1)

  const afterDelete = compileIdentityRangePoints(['2026-01-01', '2026-01-03'], 'visitor')
  assert.equal(countAt(afterDelete, 'visitor', '2026-01-02', '2026-01-02'), 0)
  assert.deepEqual([...afterDelete.values()], [...original.values()])
  assert.equal(TRACKING_ANALYTICS_RANGE_ROLLUP_LIMITS.exactDistinctCounts, true)
  assert.equal(TRACKING_ANALYTICS_RANGE_ROLLUP_LIMITS.storesPerIdentityMembership, true)
  assert.equal(TRACKING_ANALYTICS_RANGE_ROLLUP_LIMITS.hotIdentityNeighborUpdates, true)
})

test('returning exige dos session_key distintos y soporta empates el mismo día', () => {
  const sameSession = compileReturningRangePoints([
    { business_date: '2026-02-01', session_key: 'session-a' },
    { business_date: '2026-02-02', session_key: 'session-a' }
  ])
  assert.equal(countAt(sameSession, 'returning', '2026-02-01', '2026-02-02'), 0)

  const sameDay = compileReturningRangePoints([
    { business_date: '2026-02-02', session_key: 'session-a' },
    { business_date: '2026-02-02', session_key: 'session-b' },
    { business_date: '2026-02-02', session_key: 'session-c' }
  ])
  assert.equal(countAt(sameDay, 'returning', '2026-02-02', '2026-02-02'), 1)

  const staggered = compileReturningRangePoints([
    { business_date: '2026-02-01', session_key: 'session-a' },
    { business_date: '2026-02-03', session_key: 'session-b' },
    { business_date: '2026-02-05', session_key: 'session-a' }
  ])
  assert.equal(countAt(staggered, 'returning', '2026-02-01', '2026-02-03'), 1)
  assert.equal(countAt(staggered, 'returning', '2026-02-02', '2026-02-03'), 0)
  assert.equal(countAt(staggered, 'returning', '2026-02-02', '2026-02-05'), 1)
  assert.equal(countAt(staggered, 'returning', '2026-02-04', '2026-02-05'), 0)
})

test('el grid persistente queda limitado a facetas de baja cardinalidad', () => {
  assert.deepEqual(Object.keys(TRACKING_ANALYTICS_FAST_FACETS).sort(), [
    'browsers',
    'devices',
    'os',
    'placements',
    'sources'
  ])
  for (const highCardinalityFacet of ['campaigns', 'adsets', 'ads']) {
    assert.equal(TRACKING_ANALYTICS_FAST_FACETS[highCardinalityFacet], undefined)
  }
})

test('la taxonomía de origen cubre el contrato completo y respeta prioridad', () => {
  const cases = [
    [{ referrer_url: 'https://instagram.com/post' }, 'Instagram'],
    [{ referrer_url: 'https://facebook.com/post' }, 'Facebook'],
    [{ referrer_url: 'https://tiktok.com/video' }, 'TikTok'],
    [{ referrer_url: 'https://youtu.be/video' }, 'YouTube'],
    [{ referrer_url: 'https://google.com/search' }, 'Google'],
    [{ referrer_url: 'https://bing.com/search' }, 'Bing'],
    [{ site_source_name: 'linkedin_ads' }, 'LinkedIn'],
    [{ utm_source: 'snapchat' }, 'Snapchat'],
    [{ utm_source: 'pinterest' }, 'Pinterest'],
    [{ utm_source: 'reddit' }, 'Reddit'],
    [{ source_platform: 'x' }, 'Twitter'],
    [{ utm_source: 'whatsapp' }, 'WhatsApp'],
    [{ utm_source: 'telegram' }, 'Telegram'],
    [{ utm_source: 'newsletter' }, 'Email'],
    [{ utm_source: 'yahoo' }, 'Yahoo'],
    [{ utm_source: 'ddg' }, 'DuckDuckGo'],
    [{ utm_source: 'baidu' }, 'Baidu'],
    [{ utm_source: 'yandex' }, 'Yandex'],
    [{ utm_source: 'ask' }, 'Ask'],
    [{ utm_source: 'organic' }, 'Orgánico'],
    [{ utm_source: 'referral' }, 'Referencia'],
    [{}, 'Directo'],
    [{ referrer_url: 'https://youtube.com/watch', utm_source: 'facebook' }, 'YouTube']
  ]
  for (const [input, expected] of cases) assert.equal(normalizeTrafficSource(input), expected)
})
