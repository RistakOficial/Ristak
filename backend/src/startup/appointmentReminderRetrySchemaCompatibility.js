const SQLITE_APPOINTMENT_REMINDER_RETRY_COLUMNS = Object.freeze({
  appointment_reminder_sends: Object.freeze([
    Object.freeze(['attempt_count', 'INTEGER NOT NULL DEFAULT 1'])
  ]),
  whatsapp_api_messages: Object.freeze([
    Object.freeze(['hidden_from_chat', 'INTEGER NOT NULL DEFAULT 0'])
  ])
})

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

/**
 * SQLite no admite ADD COLUMN IF NOT EXISTS. Las instalaciones que ya tienen
 * aplicado el bootstrap omiten su replay, así que esta reparación mínima corre
 * antes del fast-path y deja que la migración versionada valide el contrato.
 */
export async function ensureSqliteAppointmentReminderRetrySchema({
  database,
  dialect
} = {}) {
  if (dialect !== 'sqlite') return { addedColumns: [] }
  if (!database || typeof database.all !== 'function' || typeof database.run !== 'function') {
    throw new TypeError('Se requiere una conexión SQLite válida para reparar los reintentos de recordatorios.')
  }

  const applyRepair = async (transaction) => {
    const addedColumns = []

    for (const [table, definitions] of Object.entries(SQLITE_APPOINTMENT_REMINDER_RETRY_COLUMNS)) {
      const tables = await transaction.all(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
        LIMIT 1
      `, [table])
      if (tables.length === 0) continue

      const columnRows = await transaction.all(
        `PRAGMA table_info(${quoteSqliteIdentifier(table)})`
      )
      const columns = new Set(columnRows.map((row) => String(row.name || '')))
      for (const [column, definition] of definitions) {
        if (columns.has(column)) continue
        await transaction.run(
          `ALTER TABLE ${quoteSqliteIdentifier(table)}
           ADD COLUMN ${quoteSqliteIdentifier(column)} ${definition}`
        )
        columns.add(column)
        addedColumns.push(`${table}.${column}`)
      }
    }

    return { addedColumns }
  }

  if (typeof database.transaction === 'function') {
    return database.transaction(applyRepair)
  }
  return applyRepair(database)
}
