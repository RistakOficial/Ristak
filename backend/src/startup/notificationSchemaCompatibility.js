function isExistingColumnError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  return code === '42701' || message.includes('duplicate column') || message.includes('already exists')
}

function isDuplicateDedupeError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  return code === '23505' || code.startsWith('SQLITE_CONSTRAINT') || message.includes('unique constraint')
}

async function ensureDedupeIndex(database) {
  const sql = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notifications_dedupe
    ON internal_notifications(COALESCE(recipient_user_id, ''), dedupe_key)
  `

  try {
    await database.run(sql)
  } catch (error) {
    if (!isDuplicateDedupeError(error)) throw error

    // Conserva la notificación más reciente y vuelve anónimas únicamente las
    // llaves duplicadas heredadas para poder restaurar la garantía idempotente.
    await database.run(`
      UPDATE internal_notifications
      SET dedupe_key = NULL
      WHERE id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(recipient_user_id, ''), dedupe_key
              ORDER BY updated_at DESC, created_at DESC, id DESC
            ) AS duplicate_position
          FROM internal_notifications
          WHERE dedupe_key IS NOT NULL
        ) ranked_notifications
        WHERE duplicate_position > 1
      )
    `)
    await database.run(sql)
  }
}

export async function ensureNotificationPersistenceSchema({ database } = {}) {
  if (!database || typeof database.run !== 'function') {
    throw new TypeError('Se necesita una conexión de base de datos para reparar notificaciones.')
  }

  const result = {
    addedColumns: [],
    ensuredTables: [],
    ensuredIndexes: []
  }

  await database.run(`
    CREATE TABLE IF NOT EXISTS internal_notifications (
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
      dedupe_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  result.ensuredTables.push('internal_notifications')

  try {
    await database.run('ALTER TABLE internal_notifications ADD COLUMN dedupe_key TEXT')
    result.addedColumns.push('internal_notifications.dedupe_key')
  } catch (error) {
    if (!isExistingColumnError(error)) throw error
  }

  await database.run(`
    CREATE TABLE IF NOT EXISTS notification_read_states (
      user_id TEXT NOT NULL,
      notification_key TEXT NOT NULL,
      notification_version TEXT NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, notification_key)
    )
  `)
  result.ensuredTables.push('notification_read_states')

  const indexes = [
    ['idx_internal_notifications_recipient', 'CREATE INDEX IF NOT EXISTS idx_internal_notifications_recipient ON internal_notifications(recipient_user_id, updated_at)'],
    ['idx_internal_notifications_contact', 'CREATE INDEX IF NOT EXISTS idx_internal_notifications_contact ON internal_notifications(contact_id, updated_at)'],
    ['idx_internal_notifications_automation', 'CREATE INDEX IF NOT EXISTS idx_internal_notifications_automation ON internal_notifications(automation_id, updated_at)'],
    ['idx_notification_read_states_read_at', 'CREATE INDEX IF NOT EXISTS idx_notification_read_states_read_at ON notification_read_states(user_id, read_at)']
  ]

  for (const [name, sql] of indexes) {
    await database.run(sql)
    result.ensuredIndexes.push(name)
  }

  await ensureDedupeIndex(database)
  result.ensuredIndexes.push('idx_internal_notifications_dedupe')

  return result
}
