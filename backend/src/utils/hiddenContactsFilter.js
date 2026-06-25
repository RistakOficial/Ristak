import { db } from '../config/database.js'

const isPostgres = Boolean(process.env.DATABASE_URL)

/**
 * ACL-005 / SEC-012: Escapa de forma segura un valor que se interpolará dentro
 * de un literal de cadena SQL ('...').
 *
 * El contrato histórico de buildHiddenContactsCondition es devolver un FRAGMENTO
 * de SQL como string (decenas de callers lo concatenan directo en sus queries),
 * por lo que no podemos pasar a placeholders sin tocar esos callers. La mitigación
 * de cirugía es endurecer el escape para que el valor NO pueda romper el literal:
 *   - coerción a string (un filter.text numérico/null hacía throw en .replace)
 *   - duplicar comillas simples ('' -> escape estándar de literal SQL)
 *   - eliminar NUL (Postgres rechaza \x00 en strings) y otros caracteres de control
 *   - en SQLite/Postgres con standard_conforming_strings (default), el backslash
 *     es literal, así que no necesita escape adicional; aun así normalizamos.
 *
 * @param {*} value
 * @returns {string} valor seguro para interpolar dentro de '...'
 */
function escapeSqlLiteral(value) {
  const CONTROL_CHARS = /[\x00-\x1F\x7F]/g
  return String(value == null ? '' : value)
    .replace(CONTROL_CHARS, '')
    // ACL-005/SEC-012: duplicar comilla simple (escape de literal de cadena)
    .replace(/'/g, "''")
}

/**
 * Obtiene todos los filtros activos de contactos ocultos
 * @returns {Promise<Array<{text: string, type: string}>>} Array de filtros con texto y tipo
 */
export async function getHiddenContactFilters() {
  try {
    const filters = await db.all('SELECT filter_text, match_type FROM hidden_contact_filters ORDER BY created_at DESC')
    return filters.map(f => ({
      text: f.filter_text,
      type: f.match_type || 'contains' // default a 'contains' para compatibilidad
    }))
  } catch (error) {
    // Si hay error, devolver array vacío para no romper queries
    return []
  }
}

/**
 * Construye la condición SQL para excluir contactos ocultos
 * @param {Array<{text: string, type: string}>} filters - Array de filtros con texto y tipo
 * @param {string} tableAlias - Alias de la tabla de contactos (ej: 'c', 'contacts')
 * @param {boolean} includeAND - Si true, incluye "AND" al inicio de la condición
 * @returns {string} Condición SQL para agregar al WHERE
 */
export function buildHiddenContactsCondition(filters, tableAlias = 'c', includeAND = true) {
  if (!Array.isArray(filters) || filters.length === 0) {
    return ''
  }

  // ACL-005/SEC-012: el alias de tabla también se interpola en el SQL. Aunque
  // siempre proviene de callers internos ('c' / 'contacts'), lo validamos como
  // identificador seguro para que no pueda inyectar SQL ni romper la query.
  const safeAlias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableAlias) ? tableAlias : 'c'

  const conditions = filters.map(filter => {
    // ACL-005/SEC-012: escape robusto del literal (antes solo duplicaba comillas
    // y rompía si filter.text no era string)
    const escapedFilter = escapeSqlLiteral(filter.text)

    if (filter.type === 'exact') {
      // Coincidencia exacta (ignorando mayúsculas) - usar COALESCE para manejar NULLs
      return `(
        LOWER(COALESCE(${safeAlias}.full_name, '')) = LOWER('${escapedFilter}') OR
        LOWER(COALESCE(${safeAlias}.email, '')) = LOWER('${escapedFilter}') OR
        LOWER(COALESCE(${safeAlias}.phone, '')) = LOWER('${escapedFilter}') OR
        LOWER(${safeAlias}.id) = LOWER('${escapedFilter}')
      )`
    } else {
      // Coincidencia con "contiene" (default) - usar COALESCE para manejar NULLs
      const pattern = `%${escapedFilter}%`
      return `(
        LOWER(COALESCE(${safeAlias}.full_name, '')) LIKE LOWER('${pattern}') OR
        LOWER(COALESCE(${safeAlias}.email, '')) LIKE LOWER('${pattern}') OR
        LOWER(COALESCE(${safeAlias}.phone, '')) LIKE LOWER('${pattern}') OR
        LOWER(${safeAlias}.id) LIKE LOWER('${pattern}')
      )`
    }
  })

  // NOT (...) para excluir los que coincidan
  const condition = `NOT (${conditions.join(' OR ')})`
  return includeAND ? `AND ${condition}` : condition
}

/**
 * Helper para aplicar filtro de contactos ocultos a una query
 * @param {string} baseQuery - Query base
 * @param {string} tableAlias - Alias de la tabla de contactos
 * @returns {Promise<string>} Query con filtro aplicado
 */
export async function applyHiddenContactsFilter(baseQuery, tableAlias = 'c') {
  const filters = await getHiddenContactFilters()
  const condition = buildHiddenContactsCondition(filters, tableAlias)

  if (!condition) {
    return baseQuery
  }

  // Agregar condición al WHERE existente o crear nuevo WHERE
  if (baseQuery.toUpperCase().includes('WHERE')) {
    return baseQuery.replace(/WHERE/i, `WHERE 1=1 ${condition} AND`)
  } else if (baseQuery.toUpperCase().includes('GROUP BY')) {
    return baseQuery.replace(/GROUP BY/i, `WHERE 1=1 ${condition} GROUP BY`)
  } else if (baseQuery.toUpperCase().includes('ORDER BY')) {
    return baseQuery.replace(/ORDER BY/i, `WHERE 1=1 ${condition} ORDER BY`)
  } else {
    return `${baseQuery} WHERE 1=1 ${condition}`
  }
}
