// Convierte placeholders SQLite (?) a PostgreSQL ($1, $2, etc.) sin tocar los
// signos de interrogación que viven dentro de literales SQL.
export function convertPostgresPlaceholders(sql) {
  let index = 1
  return String(sql).replace(/'(?:[^']|'')*'|\?/g, (match) => (match === '?' ? `$${index++}` : match))
}

export function normalizePostgresSql(sql) {
  return String(sql)
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/AUTOINCREMENT/g, 'GENERATED ALWAYS AS IDENTITY')
    .replace(/DATETIME/g, 'TIMESTAMP')
}

// PostgreSQL no coacciona booleanos hacia las columnas INTEGER que usamos para
// flags; el adaptador conserva la paridad con SQLite normalizando true/false.
export function toPostgresParams(params) {
  return Array.isArray(params)
    ? params.map((value) => (value === true ? 1 : value === false ? 0 : value))
    : params
}

/**
 * Adaptador canónico usado por el runtime PostgreSQL. Se exporta para que las
 * pruebas de concurrencia ejecuten exactamente la misma traducción SQL y no un
 * doble sintético que pueda ocultar diferencias del proveedor real.
 */
export function createPostgresAdapter(client) {
  return {
    run: async (sql, params = []) => {
      sql = normalizePostgresSql(sql)
      sql = convertPostgresPlaceholders(sql)

      const result = await client.query(sql, toPostgresParams(params))
      return {
        lastID: result.rows[0]?.id || null,
        changes: result.rowCount
      }
    },

    get: async (sql, params = []) => {
      sql = String(sql).replace(/DATETIME/g, 'TIMESTAMP')
      sql = convertPostgresPlaceholders(sql)

      const result = await client.query(sql, toPostgresParams(params))
      return result.rows[0] || null
    },

    all: async (sql, params = []) => {
      sql = String(sql).replace(/DATETIME/g, 'TIMESTAMP')
      sql = convertPostgresPlaceholders(sql)

      const result = await client.query(sql, toPostgresParams(params))
      return result.rows
    },

    exec: async (sql) => {
      sql = normalizePostgresSql(sql)
      await client.query(sql)
    }
  }
}
