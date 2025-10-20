import { db } from '../config/database.js'

const isPostgres = Boolean(process.env.DATABASE_URL)

/**
 * Obtiene todos los filtros activos de contactos ocultos
 * @returns {Promise<string[]>} Array de textos de filtro
 */
export async function getHiddenContactFilters() {
  try {
    const filters = await db.all('SELECT filter_text FROM hidden_contact_filters ORDER BY created_at DESC')
    return filters.map(f => f.filter_text)
  } catch (error) {
    // Si hay error, devolver array vacío para no romper queries
    return []
  }
}

/**
 * Construye la condición SQL para excluir contactos ocultos
 * @param {string[]} filters - Array de textos de filtro
 * @param {string} tableAlias - Alias de la tabla de contactos (ej: 'c', 'contacts')
 * @param {boolean} includeAND - Si true, incluye "AND" al inicio de la condición
 * @returns {string} Condición SQL para agregar al WHERE
 */
export function buildHiddenContactsCondition(filters, tableAlias = 'c', includeAND = true) {
  if (!Array.isArray(filters) || filters.length === 0) {
    return ''
  }

  const conditions = filters.map(filter => {
    const escapedFilter = filter.replace(/'/g, "''") // Escape single quotes
    const pattern = isPostgres
      ? `%${escapedFilter}%`
      : `%${escapedFilter}%`

    return `(
      LOWER(${tableAlias}.full_name) LIKE LOWER('${pattern}') OR
      LOWER(${tableAlias}.email) LIKE LOWER('${pattern}') OR
      LOWER(${tableAlias}.phone) LIKE LOWER('${pattern}') OR
      LOWER(${tableAlias}.id) LIKE LOWER('${pattern}')
    )`
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
