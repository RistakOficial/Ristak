import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sqlite3 from 'sqlite3'

import { ensureNotificationPersistenceSchema } from '../src/startup/notificationSchemaCompatibility.js'

function sqliteMemoryDatabase() {
  const connection = new sqlite3.Database(':memory:')
  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function (error) {
          if (error) reject(error)
          else resolve({ changes: this.changes, lastID: this.lastID })
        })
      })
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        connection.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

test('repara el almacenamiento de notificaciones aunque el bootstrap principal ya exista', async () => {
  const statements = []
  const database = {
    async run(sql) {
      statements.push(String(sql).replace(/\s+/g, ' ').trim())
      return { changes: 0 }
    }
  }

  const result = await ensureNotificationPersistenceSchema({ database })

  assert.deepEqual(result.addedColumns, ['internal_notifications.dedupe_key'])
  assert.deepEqual(result.ensuredTables, ['internal_notifications', 'notification_read_states'])
  assert.ok(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS notification_read_states')))
  assert.ok(statements.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notifications_dedupe')))

  const databaseSource = await readFile(new URL('../src/config/database.js', import.meta.url), 'utf8')
  const repairCall = databaseSource.indexOf('await ensureNotificationPersistenceSchema({ database: db })')
  const bootstrapFastPath = databaseSource.indexOf("if (schemaBootstrap?.config_value === CORE_SCHEMA_BOOTSTRAP_VERSION)")
  assert.ok(repairCall >= 0 && repairCall < bootstrapFastPath)
})

test('la reparación es idempotente cuando dedupe_key ya existe', async () => {
  const database = {
    async run(sql) {
      if (String(sql).includes('ALTER TABLE internal_notifications ADD COLUMN dedupe_key')) {
        const error = new Error('column "dedupe_key" already exists')
        error.code = '42701'
        throw error
      }
      return { changes: 0 }
    }
  }

  const result = await ensureNotificationPersistenceSchema({ database })
  assert.deepEqual(result.addedColumns, [])
  assert.equal(result.ensuredIndexes.includes('idx_notification_read_states_read_at'), true)
})

test('la reparación neutraliza llaves heredadas duplicadas antes de crear el índice único', async () => {
  const statements = []
  let dedupeIndexAttempts = 0
  const database = {
    async run(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (normalized.includes('ALTER TABLE internal_notifications ADD COLUMN dedupe_key')) {
        const error = new Error('column "dedupe_key" already exists')
        error.code = '42701'
        throw error
      }
      if (normalized.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notifications_dedupe')) {
        dedupeIndexAttempts += 1
        if (dedupeIndexAttempts === 1) {
          const error = new Error('UNIQUE constraint failed: internal_notifications.dedupe_key')
          error.code = 'SQLITE_CONSTRAINT'
          throw error
        }
      }
      return { changes: 0 }
    }
  }

  const result = await ensureNotificationPersistenceSchema({ database })

  assert.equal(dedupeIndexAttempts, 2)
  assert.ok(statements.some((sql) => sql.includes('ROW_NUMBER() OVER')))
  assert.ok(statements.some((sql) => sql.includes('SET dedupe_key = NULL')))
  assert.equal(result.ensuredIndexes.includes('idx_internal_notifications_dedupe'), true)
})

test('repara el esquema incompleto de una instalación SQLite existente', async (t) => {
  const database = sqliteMemoryDatabase()
  t.after(() => database.close())

  await database.run(`
    CREATE TABLE internal_notifications (
      id TEXT PRIMARY KEY,
      recipient_user_id TEXT,
      source TEXT DEFAULT 'Ristak',
      severity TEXT DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT,
      action_url TEXT,
      action_label TEXT,
      category TEXT DEFAULT 'internal',
      contact_id TEXT,
      automation_id TEXT,
      automation_node_id TEXT,
      enrollment_id TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const result = await ensureNotificationPersistenceSchema({ database })
  const columns = await database.all('PRAGMA table_info(internal_notifications)')
  const readStateTable = await database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_read_states'")
  const indexes = await database.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('internal_notifications', 'notification_read_states')")

  assert.deepEqual(result.addedColumns, ['internal_notifications.dedupe_key'])
  assert.ok(columns.some((column) => column.name === 'dedupe_key'))
  assert.equal(readStateTable.length, 1)
  assert.ok(indexes.some((index) => index.name === 'idx_internal_notifications_dedupe'))
  assert.ok(indexes.some((index) => index.name === 'idx_notification_read_states_read_at'))
})
