const DEFAULT_WINDOW_MS = 60 * 1000
const DEFAULT_MAX_BUCKETS = 5_000
const DEFAULT_MAX_REQUESTS = 180
const DEFAULT_MAX_EVENTS = 1_000

function boundedPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function rateLimitError() {
  return Object.assign(
    new Error('Demasiados eventos de formulario, intenta de nuevo en un momento'),
    {
      status: 429,
      code: 'rate_limited'
    }
  )
}

/**
 * Contador local de memoria constante por IP+Site. El Map conserva orden LRU;
 * una cardinalidad hostil nunca puede dejar más de maxBuckets residentes.
 */
export function createSiteFlowRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  maxBuckets = DEFAULT_MAX_BUCKETS,
  maxRequests = DEFAULT_MAX_REQUESTS,
  maxEvents = DEFAULT_MAX_EVENTS,
  now = () => Date.now()
} = {}) {
  const effectiveWindowMs = boundedPositiveInteger(windowMs, DEFAULT_WINDOW_MS)
  const effectiveMaxBuckets = boundedPositiveInteger(maxBuckets, DEFAULT_MAX_BUCKETS, 100_000)
  const effectiveMaxRequests = boundedPositiveInteger(maxRequests, DEFAULT_MAX_REQUESTS)
  const effectiveMaxEvents = boundedPositiveInteger(maxEvents, DEFAULT_MAX_EVENTS)
  const buckets = new Map()
  let lastSweepAt = 0

  function sweepExpired(currentTime) {
    if (currentTime - lastSweepAt < effectiveWindowMs) return
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.windowStartedAt >= effectiveWindowMs) {
        buckets.delete(key)
      }
    }
    lastSweepAt = currentTime
  }

  function evictOldestUntilBounded() {
    while (buckets.size >= effectiveMaxBuckets) {
      const oldestKey = buckets.keys().next().value
      if (oldestKey === undefined) return
      buckets.delete(oldestKey)
    }
  }

  function consume({
    ip,
    siteKey,
    eventCount = 1
  } = {}) {
    const currentTime = Number(now())
    const safeNow = Number.isFinite(currentTime) ? currentTime : Date.now()
    const safeEventCount = boundedPositiveInteger(eventCount, 1, effectiveMaxEvents + 1)
    const key = `${String(ip || 'unknown')}::${String(siteKey || 'unknown')}`
    sweepExpired(safeNow)

    let bucket = buckets.get(key)
    if (!bucket || safeNow - bucket.windowStartedAt >= effectiveWindowMs) {
      if (!bucket) evictOldestUntilBounded()
      bucket = {
        windowStartedAt: safeNow,
        requests: 0,
        events: 0
      }
    } else {
      // Refresca el orden de inserción: la siguiente expulsión quita el bucket
      // realmente menos usado, no simplemente el que se creó primero.
      buckets.delete(key)
    }

    const nextRequests = bucket.requests + 1
    const nextEvents = bucket.events + safeEventCount
    bucket.requests = Math.min(nextRequests, effectiveMaxRequests + 1)
    bucket.events = Math.min(nextEvents, effectiveMaxEvents + 1)
    buckets.set(key, bucket)

    if (nextRequests > effectiveMaxRequests || nextEvents > effectiveMaxEvents) {
      throw rateLimitError()
    }

    return {
      requests: nextRequests,
      events: nextEvents,
      remainingRequests: Math.max(0, effectiveMaxRequests - nextRequests),
      remainingEvents: Math.max(0, effectiveMaxEvents - nextEvents)
    }
  }

  return {
    consume,
    get size() {
      return buckets.size
    }
  }
}
