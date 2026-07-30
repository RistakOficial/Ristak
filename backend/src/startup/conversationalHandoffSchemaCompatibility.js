const SQLITE_HANDOFF_COLUMNS = Object.freeze([
  Object.freeze(['activation_cycle_id', 'TEXT']),
  Object.freeze(['activation_cycle_started_at', 'DATETIME']),
  Object.freeze(['activation_cycle_started_message_id', 'TEXT'])
])

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

/**
 * SQLite no admite ADD COLUMN IF NOT EXISTS. Las instalaciones que ya tienen
 * el marcador del bootstrap saltan el replay legacy, así que esta reparación
 * mínima corre antes del fast-path. La migración 141 valida y rellena después.
 */
export async function ensureSqliteConversationalHandoffSchema({
  database,
  dialect
} = {}) {
  if (dialect !== 'sqlite') return { addedColumns: [] }
  if (!database || typeof database.all !== 'function' || typeof database.run !== 'function') {
    throw new TypeError('Se requiere una conexión SQLite válida para reparar el handoff conversacional.')
  }

  const applyRepair = async (transaction) => {
    const tables = await transaction.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'conversational_agent_state'
      LIMIT 1
    `)
    if (tables.length === 0) return { addedColumns: [] }

    const columnRows = await transaction.all(
      `PRAGMA table_info(${quoteSqliteIdentifier('conversational_agent_state')})`
    )
    const columns = new Set(columnRows.map((row) => String(row.name || '')))
    const addedColumns = []
    for (const [column, definition] of SQLITE_HANDOFF_COLUMNS) {
      if (columns.has(column)) continue
      await transaction.run(
        `ALTER TABLE ${quoteSqliteIdentifier('conversational_agent_state')}
         ADD COLUMN ${quoteSqliteIdentifier(column)} ${definition}`
      )
      columns.add(column)
      addedColumns.push(`conversational_agent_state.${column}`)
    }
    return { addedColumns }
  }

  if (typeof database.transaction === 'function') {
    return database.transaction(applyRepair)
  }
  return applyRepair(database)
}
