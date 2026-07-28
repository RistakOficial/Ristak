const SQLITE_COLUMN_DEFINITIONS = Object.freeze({
  sessions: Object.freeze([
    ['event_id', 'TEXT'],
    ['client_started_at', 'TIMESTAMP'],
    ['timestamp_adjusted', 'INTEGER DEFAULT 0']
  ]),
  video_playback_events: Object.freeze([
    ['event_sequence', 'INTEGER'],
    ['ingestion_version', 'INTEGER DEFAULT 1'],
    ['payload_hash', 'TEXT'],
    ['tracking_source', "TEXT DEFAULT 'native_site_video'"],
    ['context_verified', 'INTEGER DEFAULT 0'],
    ['event_time_quality', "TEXT DEFAULT 'legacy'"],
    ['watch_from_seconds', 'REAL'],
    ['watch_to_seconds', 'REAL'],
    ['client_event_at', 'TIMESTAMP']
  ])
})

const SQLITE_INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({
    table: 'sessions',
    name: 'idx_sessions_event_id_unique',
    unique: true,
    columns: Object.freeze(['event_id']),
    predicate: "event_id IS NOT NULL AND event_id != ''",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_event_id_unique
      ON sessions(event_id)
      WHERE event_id IS NOT NULL AND event_id != ''`
  }),
  Object.freeze({
    table: 'sessions',
    name: 'idx_sessions_site_tracking_started',
    unique: false,
    columns: Object.freeze(['site_id', 'tracking_source', 'event_name', 'started_at']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_sessions_site_tracking_started
      ON sessions(site_id, tracking_source, event_name, started_at)`
  }),
  Object.freeze({
    table: 'sessions',
    name: 'idx_sessions_form_tracking_started',
    unique: false,
    columns: Object.freeze(['form_site_id', 'tracking_source', 'event_name', 'started_at']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_sessions_form_tracking_started
      ON sessions(form_site_id, tracking_source, event_name, started_at)`
  }),
  Object.freeze({
    table: 'sessions',
    name: 'idx_sessions_submission_tracking_event',
    unique: false,
    columns: Object.freeze(['submission_id', 'tracking_source', 'event_name', 'started_at']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_sessions_submission_tracking_event
      ON sessions(submission_id, tracking_source, event_name, started_at)`
  }),
  Object.freeze({
    table: 'video_playback_events',
    name: 'idx_video_events_playback_sequence',
    unique: true,
    columns: Object.freeze(['playback_id', 'event_sequence']),
    predicate: 'event_sequence IS NOT NULL',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_video_events_playback_sequence
      ON video_playback_events(playback_id, event_sequence)
      WHERE event_sequence IS NOT NULL`
  }),
  Object.freeze({
    table: 'video_playback_events',
    name: 'idx_video_events_asset_time_type',
    unique: false,
    columns: Object.freeze(['media_asset_id', 'event_at', 'event_name', 'playback_id']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_video_events_asset_time_type
      ON video_playback_events(media_asset_id, event_at, event_name, playback_id)`
  }),
  Object.freeze({
    table: 'video_playback_events',
    name: 'idx_video_events_site_time_type',
    unique: false,
    columns: Object.freeze(['site_id', 'event_at', 'event_name', 'media_asset_id', 'playback_id']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_video_events_site_time_type
      ON video_playback_events(site_id, event_at, event_name, media_asset_id, playback_id)`
  }),
  Object.freeze({
    table: 'video_playback_events',
    name: 'idx_video_events_playback_type_time',
    unique: false,
    columns: Object.freeze(['playback_id', 'event_name', 'event_at', 'id']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_video_events_playback_type_time
      ON video_playback_events(playback_id, event_name, event_at, id)`
  }),
  Object.freeze({
    table: 'video_playback_events',
    name: 'idx_video_events_visitor_time',
    unique: false,
    columns: Object.freeze(['visitor_id', 'event_at', 'playback_id']),
    predicate: null,
    sql: `CREATE INDEX IF NOT EXISTS idx_video_events_visitor_time
      ON video_playback_events(visitor_id, event_at, playback_id)`
  })
])

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

async function sqliteTableNames(database) {
  const rows = await database.all(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('sessions', 'video_playback_events')
  `)
  return new Set(rows.map(row => String(row.name || '')))
}

async function sqliteColumnNames(database, table) {
  const rows = await database.all(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`)
  return new Set(rows.map(row => String(row.name || '')))
}

function normalizedSqlitePredicate(value) {
  if (value === null || value === undefined) return null
  return String(value)
    .toLowerCase()
    .replaceAll('<>', '!=')
    .replace(/[\s()"`\[\]]+/g, '')
}

function sqlitePredicateFromDefinition(sql) {
  const match = String(sql || '').match(/\bWHERE\b([\s\S]+)$/i)
  return match ? normalizedSqlitePredicate(match[1]) : null
}

function indexContractError(index, detail) {
  return Object.assign(
    new Error(`El índice ${index.name} no cumple el contrato de Sites Analytics: ${detail}.`),
    {
      code: 'SITES_ANALYTICS_INDEX_CONTRACT_MISMATCH',
      indexName: index.name
    }
  )
}

async function assertSqliteIndexContract(database, index) {
  const masterRows = await database.all(`
    SELECT tbl_name, sql
    FROM sqlite_master
    WHERE type = 'index'
      AND name = ?
    LIMIT 1
  `, [index.name])
  const master = masterRows[0]
  if (!master) throw indexContractError(index, 'no existe')
  if (String(master.tbl_name || '') !== index.table) {
    throw indexContractError(index, `apunta a ${master.tbl_name || 'una tabla desconocida'}`)
  }

  const listRows = await database.all(`PRAGMA index_list(${quoteSqliteIdentifier(index.table)})`)
  const listed = listRows.find(row => String(row.name || '') === index.name)
  if (!listed) throw indexContractError(index, 'SQLite no lo reconoce en la tabla esperada')
  if (Number(listed.unique || 0) !== Number(index.unique)) {
    throw indexContractError(index, index.unique ? 'no es UNIQUE' : 'es UNIQUE sin corresponder')
  }
  if (Number(listed.partial || 0) !== Number(Boolean(index.predicate))) {
    throw indexContractError(index, 'su predicado parcial no coincide')
  }

  const infoRows = await database.all(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`)
  const columns = infoRows
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map(row => String(row.name || ''))
  if (JSON.stringify(columns) !== JSON.stringify(index.columns)) {
    throw indexContractError(index, `usa columnas [${columns.join(', ')}]`)
  }

  const actualPredicate = sqlitePredicateFromDefinition(master.sql)
  const expectedPredicate = normalizedSqlitePredicate(index.predicate)
  if (actualPredicate !== expectedPredicate) {
    throw indexContractError(index, 'la condición WHERE no coincide')
  }
}

/**
 * SQLite no admite ADD COLUMN IF NOT EXISTS. initTables crea estas columnas en
 * instalaciones nuevas, pero una instalación que ya tenga el marcador del
 * bootstrap salta el replay legacy. Esta reparación mínima corre antes de ese
 * marcador; la migración versionada 136 valida después el contrato completo.
 */
export async function ensureSqliteSitesAnalyticsTrackingSchema({
  database,
  dialect
} = {}) {
  if (dialect !== 'sqlite') {
    return { addedColumns: [], createdIndexes: [] }
  }
  if (!database || typeof database.all !== 'function' || typeof database.run !== 'function') {
    throw new TypeError('Se requiere una conexión SQLite válida para reparar Sites Analytics.')
  }

  const applyRepair = async (transaction) => {
    const tables = await sqliteTableNames(transaction)
    const addedColumns = []

    for (const [table, definitions] of Object.entries(SQLITE_COLUMN_DEFINITIONS)) {
      if (!tables.has(table)) continue
      const columns = await sqliteColumnNames(transaction, table)
      for (const [column, definition] of definitions) {
        if (columns.has(column)) continue
        await transaction.run(
          `ALTER TABLE ${quoteSqliteIdentifier(table)} ADD COLUMN ${quoteSqliteIdentifier(column)} ${definition}`
        )
        columns.add(column)
        addedColumns.push(`${table}.${column}`)
      }
    }

    const createdIndexes = []
    for (const index of SQLITE_INDEX_DEFINITIONS) {
      if (!tables.has(index.table)) continue
      const existing = await transaction.all(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'index'
          AND name = ?
        LIMIT 1
      `, [index.name])
      if (existing.length === 0) {
        await transaction.run(index.sql)
        createdIndexes.push(index.name)
      }
      await assertSqliteIndexContract(transaction, index)
    }

    return { addedColumns, createdIndexes }
  }

  if (typeof database.transaction === 'function') {
    return database.transaction(applyRepair)
  }
  return applyRepair(database)
}
