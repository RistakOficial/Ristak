import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REPORTS_TABLE_CONFIG_KEY,
  REPORTS_TABLE_ID,
  filterAvailableReportColumns
} from '../src/utils/reportTableConfig.ts'

const columns = [
  { key: 'date' },
  { key: 'businessExpenses' },
  { key: 'transactions' },
  { key: 'visitors' }
]

test('Reportes usa una sola llave de columnas para todos sus tabs', () => {
  assert.equal(REPORTS_TABLE_ID, 'reports_metrics')
  assert.equal(REPORTS_TABLE_CONFIG_KEY, 'table_reports_metrics')
})

test('conserva costos y transacciones al cambiar de alcance', () => {
  assert.deepEqual(
    filterAvailableReportColumns(columns, { analyticsEnabled: true }),
    columns
  )
})

test('solo retira columnas que dependen de Analíticas web desactivado', () => {
  assert.deepEqual(
    filterAvailableReportColumns(columns, { analyticsEnabled: false }),
    [
      { key: 'date' },
      { key: 'businessExpenses' },
      { key: 'transactions' }
    ]
  )
})
