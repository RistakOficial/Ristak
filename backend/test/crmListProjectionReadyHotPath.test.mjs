import assert from 'node:assert/strict'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

test('el estado ready se resuelve sin anti-joins ni lecturas de tablas fuente', async (context) => {
  if (databaseDialect !== 'sqlite') {
    context.skip('prueba focal SQLite')
    return
  }

  await runVersionedMigrations()
  await db.run(`
    UPDATE crm_list_projection_state
    SET status = 'ready'
    WHERE projection_key IN ('contact_rows', 'contact_payments', 'contact_appointments', 'contact_attendance', 'payment_list')
  `)

  // Query string para obtener un módulo fresco y no heredar el memo en memoria
  // de otro test que haya usado estas proyecciones.
  const projectionService = await import(
    `../src/services/crmListProjectionService.js?ready-hot-path=${Date.now()}-${Math.random()}`
  )
  const originalAll = db.all
  const observedSql = []
  db.all = async function tracedAll(sql, params) {
    observedSql.push(String(sql))
    return originalAll.call(this, sql, params)
  }

  try {
    assert.equal(await projectionService.isContactListProjectionReady({ schedule: false }), true)
    assert.equal(await projectionService.isPaymentListProjectionReady({ schedule: false }), true)
    assert.deepEqual(
      await projectionService.runCrmListProjectionBackfill(),
      { ready: true, processed: 0, cached: true }
    )
  } finally {
    db.all = originalAll
  }

  assert.equal(observedSql.length, 3)
  const normalized = observedSql.join('\n').toLowerCase()
  assert.match(normalized, /from crm_list_projection_state/)
  assert.doesNotMatch(normalized, /left\s+join/)
  assert.doesNotMatch(normalized, /\bfrom\s+(payments|appointments|appointment_attendance_signals)\b/)
  assert.doesNotMatch(normalized, /contact_(payment|appointment|attendance)_activity_items|payment_list_activity/)
})
