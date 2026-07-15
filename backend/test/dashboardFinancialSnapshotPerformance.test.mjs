import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { db, setAppConfig } from '../src/config/database.js'
import { getMetrics } from '../src/controllers/dashboardController.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

test('Dashboard calcula ingresos, refunds y ticket promedio con una sola pasada de pagos', async () => {
  const prefix = `dashboard_financial_${Date.now()}_${Math.random().toString(16).slice(2)}`
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    const rows = [
      [`${prefix}_current_1`, 100, 'succeeded', 'live', '2098-01-10T12:00:00.000Z'],
      [`${prefix}_current_2`, 300, 'succeeded', 'live', '2098-01-10T13:00:00.000Z'],
      [`${prefix}_refund`, 50, 'refunded', 'live', '2098-01-10T14:00:00.000Z'],
      [`${prefix}_test`, 999, 'succeeded', 'test', '2098-01-10T15:00:00.000Z'],
      [`${prefix}_previous`, 50, 'succeeded', 'live', '2098-01-09T12:00:00.000Z']
    ]

    for (const [id, amount, status, paymentMode, date] of rows) {
      await db.run(`
        INSERT INTO payments (
          id, amount, status, payment_mode, payment_provider, date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
      `, [id, amount, status, paymentMode, date, date, date])
    }

    const response = responseRecorder()
    await getMetrics({
      query: { startDate: '2098-01-10', endDate: '2098-01-10' }
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.ingresosNetos.value, 400)
    assert.equal(response.payload.reembolsos.value, 50)
    assert.equal(response.payload.ltvPromedio.value, 200)
    assert.equal(response.payload.ingresosNetos.variation, 700)
  } finally {
    await db.run('DELETE FROM payments WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('el contrato del Dashboard no vuelve a separar tres recorridos sobre payments', async () => {
  const source = await readFile(
    new URL('../src/controllers/dashboardController.js', import.meta.url),
    'utf8'
  )
  const snapshot = source
    .split('const computeFinancialSnapshot = async')[1]
    .split('export const getOperationalSnapshot')[0]

  assert.match(snapshot, /paymentAggregateQuery/)
  assert.match(snapshot, /SUM\(CASE WHEN[\s\S]*AVG\(CASE WHEN/)
  assert.equal((snapshot.match(/FROM payments p/g) || []).length, 1)
  assert.match(snapshot, /Promise\.all\(\[/)
})

