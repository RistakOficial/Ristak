import { db } from '../config/database.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'

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
  const normalizedContactId = String(contactId || '').trim()
  const normalizedUpdates = parseContactCustomFields(updates)
  if (!normalizedContactId || normalizedUpdates.length === 0) return null

  // En PostgreSQL el row lock serializa merges concurrentes. SQLite ya
  // serializa las escrituras al abrir la transacción.
  return database.transaction(async transaction => {
    const lockSuffix = dialect === 'postgres' ? ' FOR UPDATE' : ''
    const current = await transaction.get(
      `SELECT custom_fields FROM contacts WHERE id = ?${lockSuffix}`,
      [normalizedContactId]
    )
    if (!current) return null

    const merged = mergeContactCustomFields(
      parseContactCustomFields(current.custom_fields),
      normalizedUpdates
    )

    await transaction.run(
      `UPDATE contacts SET
         custom_fields = ${dialect === 'postgres' ? '?::jsonb' : '?'},
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [serializeContactCustomFieldsForDb(merged), normalizedContactId]
    )

    return merged
  })
}
