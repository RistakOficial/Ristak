import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { waitForBackfillJobsToBecomeIdle } from '../src/jobs/backfillJobCoordinator.js'
import { scheduleTrackingVisitorProjectionBackfill } from '../src/services/trackingVisitorProjectionService.js'

test('un fallo antes de entrar al worker libera la bandera y programa reintento', async () => {
  const originalWithAdvisoryLock = db.withAdvisoryLock
  db.withAdvisoryLock = async () => {
    throw Object.assign(new Error('falló la conexión antes del callback'), { code: '08006' })
  }

  try {
    assert.equal(scheduleTrackingVisitorProjectionBackfill().scheduled, true)
    await waitForBackfillJobsToBecomeIdle()

    const retry = scheduleTrackingVisitorProjectionBackfill()
    assert.equal(retry.scheduled, false)
    assert.equal(retry.paused, true)
    assert.ok(retry.retryAfterMs > 0)
  } finally {
    db.withAdvisoryLock = originalWithAdvisoryLock
  }
})
