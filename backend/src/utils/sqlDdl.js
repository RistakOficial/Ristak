const IDEMPOTENT_CREATE_VIEW_BY_DIALECT = Object.freeze({
  postgres: 'CREATE OR REPLACE VIEW',
  sqlite: 'CREATE VIEW IF NOT EXISTS'
})

/**
 * Devuelve la forma idempotente de crear una vista que soporta cada motor.
 * PostgreSQL no acepta `CREATE VIEW IF NOT EXISTS`; SQLite no acepta
 * `CREATE OR REPLACE VIEW`.
 */
export function idempotentCreateViewClause(dialect) {
  const clause = IDEMPOTENT_CREATE_VIEW_BY_DIALECT[String(dialect || '').toLowerCase()]
  if (!clause) {
    throw new TypeError(`Dialecto no soportado para crear vistas: ${String(dialect || '')}`)
  }
  return clause
}
