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

/**
 * PostgreSQL conserva resultados booleanos nativos; SQLite representa los flags
 * como 1/0. Mantener el tipo estable evita que una migración posterior intente
 * cambiar el contrato de una vista ya creada durante el bootstrap.
 */
export function booleanProjectionExpression(conditionSql, dialect) {
  const condition = String(conditionSql || '').trim()
  if (!condition) throw new TypeError('La proyección booleana necesita una condición SQL.')

  const normalizedDialect = String(dialect || '').toLowerCase()
  if (normalizedDialect === 'postgres') return condition
  if (normalizedDialect === 'sqlite') return `CASE WHEN ${condition} THEN 1 ELSE 0 END`
  throw new TypeError(`Dialecto no soportado para proyectar booleanos: ${String(dialect || '')}`)
}
