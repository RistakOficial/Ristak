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

function safeSqlIdentifier(value, fallback = '') {
  const normalized = String(value || '')
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : fallback
}

function normalizedFilters(filters) {
  return Array.isArray(filters)
    ? filters.filter(filter => filter && String(filter.text ?? '').trim())
    : []
}

function buildFilterMatchCondition(filters, expressions = []) {
  const safeExpressions = expressions.filter(Boolean)
  const activeFilters = normalizedFilters(filters)
  if (!activeFilters.length || !safeExpressions.length) return ''

  return activeFilters.map(filter => {
    const escapedFilter = escapeSqlLiteral(filter.text)
    const operator = filter.type === 'exact' ? '=' : 'LIKE'
    const comparedValue = filter.type === 'exact'
      ? `'${escapedFilter}'`
      : `'%${escapedFilter}%'`
    return `(${safeExpressions
      // CAST conserva el contrato en SQLite y PostgreSQL, incluso cuando una
      // tabla externa expone identidad dentro de una columna JSON/JSONB.
      .map(expression => `LOWER(COALESCE(CAST(${expression} AS TEXT), '')) ${operator} LOWER(${comparedValue})`)
      .join(' OR ')})`
  }).join(' OR ')
}

/**
 * Obtiene todos los filtros activos de contactos ocultos
 * @returns {Promise<Array<{text: string, type: string}>>} Array de filtros con texto y tipo
 */
export async function getHiddenContactFilters(options = {}) {
  try {
    const filters = await db.all(
      'SELECT filter_text, match_type FROM hidden_contact_filters ORDER BY created_at DESC',
      [],
      options?.signal ? { signal: options.signal } : undefined
    )
    return filters.map(f => ({
      text: f.filter_text,
      type: f.match_type || 'contains' // default a 'contains' para compatibilidad
    }))
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
    // Si hay error, devolver array vacío para no romper queries
    return []
  }
}

/**
 * Devuelve la coincidencia positiva de un contacto con las reglas ocultas.
 * La función histórica buildHiddenContactsCondition devuelve la inversa
 * (contactos visibles); separar ambas evita dobles NOT cuando otra entidad
 * referencia al contacto mediante contact_id, visitor_id o session_id.
 */
export function buildHiddenContactMatchCondition(filters, tableAlias = 'c') {
  const safeAlias = safeSqlIdentifier(tableAlias, 'c')
  return buildFilterMatchCondition(filters, [
    `${safeAlias}.full_name`,
    `${safeAlias}.email`,
    `${safeAlias}.phone`,
    `${safeAlias}.id`
  ])
}

/**
 * Construye la condición SQL para excluir contactos ocultos
 * @param {Array<{text: string, type: string}>} filters - Array de filtros con texto y tipo
 * @param {string} tableAlias - Alias de la tabla de contactos (ej: 'c', 'contacts')
 * @param {boolean} includeAND - Si true, incluye "AND" al inicio de la condición
 * @returns {string} Condición SQL para agregar al WHERE
 */
export function buildHiddenContactsCondition(filters, tableAlias = 'c', includeAND = true) {
  const hiddenMatch = buildHiddenContactMatchCondition(filters, tableAlias)
  if (!hiddenMatch) return ''

  const condition = `NOT (${hiddenMatch})`
  return includeAND ? `AND ${condition}` : condition
}

/**
 * Construye una condición de visibilidad para cualquier fila que pueda estar
 * vinculada a un contacto. Además de contact_id, reconoce identidad de tracking
 * y campos desnormalizados para que una fila no reaparezca si el contacto fue
 * borrado, todavía no fue enlazado o el dato vive en una tabla hija.
 *
 * No se aplica por magia a todas las queries: los límites de lectura públicos
 * (tracking, MCP y API externa) deben agregar explícitamente esta condición.
 */
export function buildHiddenContactDataCondition(filters, {
  tableAlias = 'row_data',
  tableName = '',
  columns = []
} = {}) {
  const activeFilters = normalizedFilters(filters)
  if (!activeFilters.length) return ''

  const safeAlias = safeSqlIdentifier(tableAlias, 'row_data')
  const safeTableName = safeSqlIdentifier(tableName)
  const availableColumns = new Set(
    (Array.isArray(columns) ? columns : [])
      .map(column => safeSqlIdentifier(column))
      .filter(Boolean)
  )
  const column = name => availableColumns.has(name) ? `${safeAlias}.${name}` : null

  if (safeTableName === 'contacts') {
    const hiddenMatch = buildHiddenContactMatchCondition(activeFilters, safeAlias)
    return hiddenMatch ? `NOT (${hiddenMatch})` : ''
  }

  const directExpressions = [
    column('contact_id'),
    column('contact_key'),
    column('full_name'),
    column('contact_name'),
    column('customer_name'),
    column('email'),
    column('contact_email'),
    column('customer_email'),
    column('phone'),
    column('contact_phone'),
    column('customer_phone'),
    column('response_json'),
    column('raw_fields_json'),
    column('mapped_fields_json'),
    column('derived_fields_json'),
    column('meta_json'),
    column('metadata_json'),
    column('payload_json'),
    column('data_json')
  ].filter(Boolean)
  const hiddenMatches = []
  const directMatch = buildFilterMatchCondition(activeFilters, directExpressions)
  if (directMatch) hiddenMatches.push(`(${directMatch})`)

  const hiddenContactMatch = buildHiddenContactMatchCondition(activeFilters, '__hidden_contact')
  const contactIdentityConditions = []
  if (column('contact_id')) {
    contactIdentityConditions.push(`__hidden_contact.id = ${column('contact_id')}`)
  }
  if (column('contact_key')) {
    contactIdentityConditions.push(`__hidden_contact.id = ${column('contact_key')}`)
  }
  if (column('visitor_id')) {
    contactIdentityConditions.push(`(
      COALESCE(__hidden_contact.visitor_id, '') != ''
      AND __hidden_contact.visitor_id = ${column('visitor_id')}
    )`)
  }
  if (contactIdentityConditions.length) {
    hiddenMatches.push(`EXISTS (
      SELECT 1
      FROM contacts __hidden_contact
      WHERE (${contactIdentityConditions.join(' OR ')})
        AND (${hiddenContactMatch})
    )`)
  }

  const trackingIdentityConditions = []
  if (column('visitor_id')) {
    trackingIdentityConditions.push(`(
      COALESCE(__hidden_session.visitor_id, '') != ''
      AND __hidden_session.visitor_id = ${column('visitor_id')}
    )`)
  }
  if (column('session_id')) {
    trackingIdentityConditions.push(`(
      COALESCE(__hidden_session.session_id, '') != ''
      AND __hidden_session.session_id = ${column('session_id')}
    )`)
  }
  if (trackingIdentityConditions.length) {
    hiddenMatches.push(`EXISTS (
      SELECT 1
      FROM sessions __hidden_session
      INNER JOIN contacts __hidden_contact
        ON __hidden_contact.id = __hidden_session.contact_id
      WHERE (${trackingIdentityConditions.join(' OR ')})
        AND (${hiddenContactMatch})
    )`)
  }

  if (safeTableName === 'public_site_submissions' && column('id')) {
    hiddenMatches.push(`EXISTS (
      SELECT 1
      FROM sessions __hidden_session
      LEFT JOIN contacts __hidden_contact
        ON __hidden_contact.id = __hidden_session.contact_id
      WHERE __hidden_session.submission_id = ${column('id')}
        AND (
          (${hiddenContactMatch})
          OR (${buildFilterMatchCondition(activeFilters, [
            '__hidden_session.contact_id',
            '__hidden_session.full_name',
            '__hidden_session.email'
          ])})
        )
    )`)
  }

  if (column('playback_id') && safeTableName !== 'video_playback_sessions') {
    hiddenMatches.push(`EXISTS (
      SELECT 1
      FROM video_playback_sessions __hidden_playback
      LEFT JOIN contacts __hidden_contact
        ON __hidden_contact.id = __hidden_playback.contact_id
      WHERE __hidden_playback.playback_id = ${column('playback_id')}
        AND (
          (${hiddenContactMatch})
          OR (${buildFilterMatchCondition(activeFilters, [
            '__hidden_playback.contact_id',
            '__hidden_playback.full_name',
            '__hidden_playback.email'
          ])})
        )
    )`)
  }

  return hiddenMatches.length ? `NOT (${hiddenMatches.join(' OR ')})` : ''
}

export function buildHiddenTrackingSessionCondition(filters, tableAlias = 's') {
  return buildHiddenContactDataCondition(filters, {
    tableAlias,
    tableName: 'sessions',
    columns: ['contact_id', 'visitor_id', 'session_id', 'full_name', 'email']
  })
}

export function isHiddenContactRecord(filters, contact = {}) {
  const values = [
    contact.id,
    contact.full_name,
    contact.fullName,
    contact.name,
    [
      contact.first_name ?? contact.firstName,
      contact.last_name ?? contact.lastName
    ].filter(Boolean).join(' '),
    contact.email,
    contact.phone
  ].map(value => String(value ?? '').trim().toLocaleLowerCase('es-MX'))

  return normalizedFilters(filters).some(filter => {
    const needle = String(filter.text ?? '').trim().toLocaleLowerCase('es-MX')
    if (!needle) return false
    return filter.type === 'exact'
      ? values.some(value => value === needle)
      : values.some(value => value.includes(needle))
  })
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
