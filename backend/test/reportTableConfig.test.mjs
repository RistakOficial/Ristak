import assert from 'node:assert/strict'
import test from 'node:test'
import sqlite3 from 'sqlite3'

import {
  DEFAULT_REPORT_TABLE_CONFIG_VALUE,
  REPORTS_TABLE_CONFIG_KEY,
  ensureSharedReportTableConfig,
  selectReportTableConfigMigration
} from '../src/utils/reportTableConfig.js'

const config = (visible) => JSON.stringify([
  { id: 'date', visible: true, order: 0 },
  { id: 'businessExpenses', visible, order: 1 }
])

test('migra la configuración legacy modificada más recientemente', () => {
  const selected = selectReportTableConfigMigration([
    {
      config_key: 'table_reports_metrics_cashflow_month',
      config_value: config(false),
      updated_at: '2026-08-01T12:00:00.000Z'
    },
    {
      config_key: 'table_reports_metrics_campaigns_month',
      config_value: config(true),
      updated_at: '2026-07-31T12:00:00.000Z'
    }
  ])

  assert.equal(selected.sourceKey, 'table_reports_metrics_cashflow_month')
  assert.equal(selected.configValue, config(false))
})

test('prioriza la vista principal cuando dos configuraciones tienen la misma fecha', () => {
  const selected = selectReportTableConfigMigration([
    {
      config_key: 'table_reports_metrics_campaigns_month',
      config_value: config(true),
      updated_at: '2026-08-01T12:00:00.000Z'
    },
    {
      config_key: 'table_reports_metrics_cashflow_month',
      config_value: config(false),
      updated_at: '2026-08-01T12:00:00.000Z'
    }
  ])

  assert.equal(selected.sourceKey, 'table_reports_metrics_cashflow_month')
  assert.equal(selected.configValue, config(false))
})

test('usa el catálogo default cuando las configuraciones legacy son inválidas', () => {
  const selected = selectReportTableConfigMigration([
    {
      config_key: 'table_reports_metrics_cashflow_month',
      config_value: '{configuración rota',
      updated_at: '2026-08-01T12:00:00.000Z'
    }
  ])

  assert.equal(selected.sourceKey, null)
  assert.equal(selected.configValue, DEFAULT_REPORT_TABLE_CONFIG_VALUE)
})

test('crea una sola configuración compartida desde la preferencia legacy', async () => {
  const writes = []
  const database = {
    get: async () => null,
    all: async () => [{
      config_key: 'table_reports_metrics_cashflow_month',
      config_value: config(false),
      updated_at: '2026-08-01T12:00:00.000Z'
    }],
    run: async (sql, params) => writes.push({ sql, params })
  }

  const result = await ensureSharedReportTableConfig(database)

  assert.deepEqual(result, {
    created: true,
    sourceKey: 'table_reports_metrics_cashflow_month'
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].params[0], REPORTS_TABLE_CONFIG_KEY)
  assert.equal(writes[0].params[1], config(false))
})

test('no reescribe una configuración compartida válida', async () => {
  let queriedLegacy = false
  let wrote = false
  const database = {
    get: async () => ({ config_value: config(false) }),
    all: async () => {
      queriedLegacy = true
      return []
    },
    run: async () => {
      wrote = true
    }
  }

  const result = await ensureSharedReportTableConfig(database)

  assert.deepEqual(result, { created: false, sourceKey: REPORTS_TABLE_CONFIG_KEY })
  assert.equal(queriedLegacy, false)
  assert.equal(wrote, false)
})

test('ejecuta la migración contra SQLite real', async (t) => {
  const connection = new sqlite3.Database(':memory:')
  t.after(() => new Promise((resolve, reject) => {
    connection.close(error => error ? reject(error) : resolve())
  }))

  const database = {
    run: (sql, params = []) => new Promise((resolve, reject) => {
      connection.run(sql, params, function (error) {
        if (error) reject(error)
        else resolve({ lastID: this.lastID, changes: this.changes })
      })
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => {
      connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null))
    }),
    all: (sql, params = []) => new Promise((resolve, reject) => {
      connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))
    })
  }

  await database.run(`
    CREATE TABLE app_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await database.run(
    'INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, ?)',
    ['table_reports_metrics_cashflow_month', config(false), '2026-08-01T12:00:00.000Z']
  )

  await ensureSharedReportTableConfig(database)

  const shared = await database.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [REPORTS_TABLE_CONFIG_KEY]
  )
  assert.equal(shared.config_value, config(false))
})
