const PUBLIC_SITES_TABLE = 'public_sites'
const PUBLIC_DOMAIN_COLUMN = 'public_domain'
const PUBLIC_DOMAIN_INDEX = 'idx_public_sites_public_domain_lower'

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

/**
 * SQLite no admite ADD COLUMN IF NOT EXISTS. Las instalaciones que ya tienen
 * aplicado el bootstrap omiten su replay, así que esta reparación mínima corre
 * antes de ese fast-path. PostgreSQL converge mediante la migración versionada
 * 146_sites_publication_domain.postgres.sql.
 */
export async function ensureSqliteSitesPublicationDomainSchema({
  database,
  dialect
} = {}) {
  if (dialect !== 'sqlite') return { addedColumns: [], createdIndexes: [] }
  if (!database || typeof database.all !== 'function' || typeof database.run !== 'function') {
    throw new TypeError('Se requiere una conexión SQLite válida para reparar el dominio de publicación de Sites.')
  }

  const applyRepair = async (transaction) => {
    const tables = await transaction.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `, [PUBLIC_SITES_TABLE])
    if (tables.length === 0) return { addedColumns: [], createdIndexes: [] }

    const columnRows = await transaction.all(
      `PRAGMA table_info(${quoteSqliteIdentifier(PUBLIC_SITES_TABLE)})`
    )
    const columns = new Set(columnRows.map(row => String(row.name || '')))
    const addedColumns = []
    if (!columns.has(PUBLIC_DOMAIN_COLUMN)) {
      await transaction.run(
        `ALTER TABLE ${quoteSqliteIdentifier(PUBLIC_SITES_TABLE)}
         ADD COLUMN ${quoteSqliteIdentifier(PUBLIC_DOMAIN_COLUMN)} TEXT`
      )
      addedColumns.push(`${PUBLIC_SITES_TABLE}.${PUBLIC_DOMAIN_COLUMN}`)
    }

    const existingIndexes = await transaction.all(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'index'
        AND name = ?
      LIMIT 1
    `, [PUBLIC_DOMAIN_INDEX])
    const createdIndexes = []
    if (existingIndexes.length === 0) {
      await transaction.run(`
        CREATE INDEX ${quoteSqliteIdentifier(PUBLIC_DOMAIN_INDEX)}
        ON ${quoteSqliteIdentifier(PUBLIC_SITES_TABLE)}(LOWER(${quoteSqliteIdentifier(PUBLIC_DOMAIN_COLUMN)}))
        WHERE ${quoteSqliteIdentifier(PUBLIC_DOMAIN_COLUMN)} IS NOT NULL
          AND ${quoteSqliteIdentifier(PUBLIC_DOMAIN_COLUMN)} != ''
      `)
      createdIndexes.push(PUBLIC_DOMAIN_INDEX)
    }

    return { addedColumns, createdIndexes }
  }

  if (typeof database.transaction === 'function') {
    return database.transaction(applyRepair)
  }
  return applyRepair(database)
}
