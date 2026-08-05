import { db } from '../config/database.js'
import {
  getContactCustomFieldIdentityAliases,
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'

const normalizeIdentity = value => String(value || '').trim().toLowerCase()
const sqliteContactMutationTails = new Map()

async function withSqliteContactMutationLock(contactId, callback) {
  const previousTail = sqliteContactMutationTails.get(contactId) || Promise.resolve()
  const ready = previousTail.catch(() => undefined)
  let release
  const ticket = new Promise(resolve => { release = resolve })
  const currentTail = ready.then(() => ticket)
  sqliteContactMutationTails.set(contactId, currentTail)

  await ready
  try {
    return await callback()
  } finally {
    release()
    if (sqliteContactMutationTails.get(contactId) === currentTail) {
      sqliteContactMutationTails.delete(contactId)
    }
  }
}

function identitySet(fields = []) {
  return new Set(fields.flatMap(field => getContactCustomFieldIdentityAliases(field)))
}

function hasMatchingIdentity(field, identities) {
  return getContactCustomFieldIdentityAliases(field).some(alias => identities.has(alias))
}

/**
 * Modifica campos personalizados con lock de fila y vuelve a calcular la
 * mezcla después de adquirirlo. También puede rellenar sólo campos ausentes o
 * quitar identidades concretas sin reemplazar el resto del arreglo.
 */
export async function mutateAndPersistContactCustomFields({
  contactId,
  updates,
  onlyIfMissing = false,
  removeIdentities = [],
  normalizeExisting = false,
  database = db,
  dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite'
} = {}) {
  const normalizedContactId = String(contactId || '').trim()
  const normalizedUpdates = parseContactCustomFields(updates)
  const normalizedRemovals = new Set(
    (Array.isArray(removeIdentities) ? removeIdentities : [removeIdentities])
      .map(normalizeIdentity)
      .filter(Boolean)
  )
  if (!normalizedContactId) return null
  if (!normalizeExisting && normalizedUpdates.length === 0 && normalizedRemovals.size === 0) return null

  const persist = () => database.transaction(async transaction => {
    const lockSuffix = dialect === 'postgres' ? ' FOR UPDATE' : ''
    const current = await transaction.get(
      `SELECT custom_fields FROM contacts WHERE id = ?${lockSuffix}`,
      [normalizedContactId]
    )
    if (!current) return null

    const currentFields = parseContactCustomFields(current.custom_fields)
    const currentIdentities = identitySet(currentFields)
    const applicableUpdates = onlyIfMissing
      ? normalizedUpdates.filter(field => !hasMatchingIdentity(field, currentIdentities))
      : normalizedUpdates
    let merged = mergeContactCustomFields(currentFields, applicableUpdates)

    if (normalizedRemovals.size > 0) {
      merged = merged.filter(field => !hasMatchingIdentity(field, normalizedRemovals))
    }

    const currentSerialized = serializeContactCustomFieldsForDb(currentFields)
    const mergedSerialized = serializeContactCustomFieldsForDb(merged)
    if (currentSerialized === mergedSerialized) {
      return {
        fields: merged,
        changed: false,
        appliedUpdates: 0,
        removedFields: 0
      }
    }

    const removedFields = Math.max(0, currentFields.length + applicableUpdates.length - merged.length)
    await transaction.run(
      `UPDATE contacts SET
         custom_fields = ${dialect === 'postgres' ? '?::jsonb' : '?'},
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [mergedSerialized, normalizedContactId]
    )

    return {
      fields: merged,
      changed: true,
      appliedUpdates: applicableUpdates.length,
      removedFields
    }
  })

  return dialect === 'sqlite'
    ? withSqliteContactMutationLock(normalizedContactId, persist)
    : persist()
}

/**
 * Mezcla campos personalizados sobre la versión más reciente del contacto.
 *
 * Los formularios de Ristak y los proveedores externos comparten la columna
 * contacts.custom_fields. Una sincronización externa nunca debe reemplazar el
 * arreglo completo porque eliminaría respuestas locales que el proveedor no
 * conoce. El lock conserva ambas fuentes incluso cuando llegan casi al mismo
 * tiempo.
 */
export async function mergeAndPersistContactCustomFields({
  contactId,
  updates,
  database = db,
  dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite'
} = {}) {
  const result = await mutateAndPersistContactCustomFields({
    contactId,
    updates,
    database,
    dialect
  })
  return result?.fields || null
}
