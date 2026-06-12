import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Catálogo de etiquetas de contactos.
 *
 * Cada etiqueta tiene un ID estable (lo que se guarda en contacts.tags y en
 * las automatizaciones) y un nombre editable: renombrar una etiqueta no rompe
 * nada porque las referencias son por ID.
 *
 * Hay 3 etiquetas internas del sistema (Cliente, Cita agendada, Prospecto) que
 * no viven en contacts.tags: se calculan según la actividad del contacto y no
 * se pueden editar ni borrar, pero sí se pueden usar en filtros.
 */

export const SYSTEM_TAGS = [
  { id: 'tag_sys_customer', name: 'Cliente' },
  { id: 'tag_sys_appointment', name: 'Cita agendada' },
  { id: 'tag_sys_lead', name: 'Prospecto' }
]

const SYSTEM_TAG_IDS = new Set(SYSTEM_TAGS.map((tag) => tag.id))

export function isSystemTagId(id) {
  return SYSTEM_TAG_IDS.has(String(id || ''))
}

export function normalizeTagName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    folderId: row.folder_id || null,
    isSystem: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapFolderRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Lista completa: etiquetas del sistema primero, luego las del usuario. */
export async function listContactTags() {
  const rows = await db.all('SELECT * FROM contact_tags ORDER BY name COLLATE NOCASE ASC')
    .catch(async () => db.all('SELECT * FROM contact_tags ORDER BY LOWER(name) ASC'))
  return [
    ...SYSTEM_TAGS.map((tag) => ({ ...tag, isSystem: true })),
    ...rows.map(mapRow)
  ]
}

async function findCustomTagByName(name) {
  const normalized = normalizeTagName(name)
  if (!normalized) return null
  const rows = await db.all('SELECT * FROM contact_tags')
  return rows.find((row) => normalizeTagName(row.name) === normalized) || null
}

export async function getContactTag(id) {
  if (isSystemTagId(id)) {
    const system = SYSTEM_TAGS.find((tag) => tag.id === id)
    return { ...system, isSystem: true }
  }
  const row = await db.get('SELECT * FROM contact_tags WHERE id = ?', [id])
  return row ? mapRow(row) : null
}

async function resolveFolderId(folderId) {
  const clean = String(folderId || '').trim()
  if (!clean) return null
  const folder = await db.get('SELECT id FROM contact_tag_folders WHERE id = ?', [clean])
  if (!folder) {
    throw Object.assign(new Error('Esa carpeta no existe'), { statusCode: 400 })
  }
  return clean
}

/**
 * Crea una etiqueta. Si ya existe una con el mismo nombre (normalizado),
 * devuelve la existente en vez de duplicar.
 */
export async function createContactTag(name, { folderId = null } = {}) {
  const clean = String(name || '').trim().slice(0, 60)
  if (!clean) {
    throw Object.assign(new Error('El nombre de la etiqueta no puede estar vacío'), { statusCode: 400 })
  }
  const existing = await findCustomTagByName(clean)
  if (existing) return mapRow(existing)

  const id = `tag_${crypto.randomUUID()}`
  const cleanFolderId = await resolveFolderId(folderId)
  await db.run('INSERT INTO contact_tags (id, name, folder_id) VALUES (?, ?, ?)', [id, clean, cleanFolderId])
  logger.info(`Etiqueta de contacto creada: ${clean} (${id})`)
  return getContactTag(id)
}

/**
 * Actualiza nombre y/o carpeta sin tocar el ID (las referencias siguen vivas).
 */
export async function updateContactTag(id, { name, folderId } = {}) {
  if (isSystemTagId(id)) {
    throw Object.assign(new Error('Las etiquetas internas no se pueden editar'), { statusCode: 400 })
  }
  const current = await db.get('SELECT * FROM contact_tags WHERE id = ?', [id])
  if (!current) {
    throw Object.assign(new Error('Etiqueta no encontrada'), { statusCode: 404 })
  }

  const updates = []
  const params = []

  if (name !== undefined) {
    const clean = String(name || '').trim().slice(0, 60)
    if (!clean) {
      throw Object.assign(new Error('El nombre de la etiqueta no puede estar vacío'), { statusCode: 400 })
    }
    const duplicate = await findCustomTagByName(clean)
    if (duplicate && duplicate.id !== id) {
      throw Object.assign(new Error('Ya existe una etiqueta con ese nombre'), { statusCode: 409 })
    }
    updates.push('name = ?')
    params.push(clean)
  }

  if (folderId !== undefined) {
    updates.push('folder_id = ?')
    params.push(await resolveFolderId(folderId))
  }

  if (updates.length > 0) {
    params.push(id)
    await db.run(`UPDATE contact_tags SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params)
  }
  return getContactTag(id)
}

/** Alias retrocompatible (renombrar era la única edición antes de carpetas). */
export async function renameContactTag(id, name) {
  return updateContactTag(id, { name })
}

// ---------------------------------------------------------------------------
// Carpetas de etiquetas (mismo patrón que carpetas de campos personalizados)
// ---------------------------------------------------------------------------

export async function listContactTagFolders() {
  const rows = await db.all('SELECT * FROM contact_tag_folders ORDER BY name COLLATE NOCASE ASC')
    .catch(async () => db.all('SELECT * FROM contact_tag_folders ORDER BY LOWER(name) ASC'))
  return rows.map(mapFolderRow)
}

export async function createContactTagFolder({ name, description = '' } = {}) {
  const clean = String(name || '').trim().slice(0, 80)
  if (!clean) {
    throw Object.assign(new Error('El nombre de la carpeta no puede estar vacío'), { statusCode: 400 })
  }
  const rows = await db.all('SELECT id, name FROM contact_tag_folders')
  if (rows.some((row) => normalizeTagName(row.name) === normalizeTagName(clean))) {
    throw Object.assign(new Error('Ya existe una carpeta con ese nombre'), { statusCode: 409 })
  }
  const id = `tagfolder_${crypto.randomUUID()}`
  await db.run('INSERT INTO contact_tag_folders (id, name, description) VALUES (?, ?, ?)', [
    id,
    clean,
    String(description || '').trim().slice(0, 300) || null
  ])
  const row = await db.get('SELECT * FROM contact_tag_folders WHERE id = ?', [id])
  return mapFolderRow(row)
}

/** Borra la carpeta; las etiquetas dentro quedan sin carpeta (no se borran). */
export async function deleteContactTagFolder(id) {
  const current = await db.get('SELECT * FROM contact_tag_folders WHERE id = ?', [id])
  if (!current) return false
  await db.run('UPDATE contact_tags SET folder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?', [id])
  await db.run('DELETE FROM contact_tag_folders WHERE id = ?', [id])
  logger.info(`Carpeta de etiquetas eliminada: ${current.name} (${id})`)
  return true
}

/** Elimina la etiqueta del catálogo y la quita de todos los contactos. */
export async function deleteContactTag(id) {
  if (isSystemTagId(id)) {
    throw Object.assign(new Error('Las etiquetas internas no se pueden eliminar'), { statusCode: 400 })
  }
  const current = await db.get('SELECT * FROM contact_tags WHERE id = ?', [id])
  if (!current) return false

  await db.run('DELETE FROM contact_tags WHERE id = ?', [id])

  // Quitarla de los contactos que la tenían asignada
  const rows = await db.all(
    `SELECT id, tags FROM contacts WHERE tags IS NOT NULL AND tags LIKE ?`,
    [`%${id}%`]
  )
  for (const row of rows) {
    const tags = parseJsonArray(row.tags)
    const next = tags.filter((value) => value !== id)
    if (next.length !== tags.length) {
      await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        JSON.stringify(next),
        row.id
      ])
    }
  }
  logger.info(`Etiqueta de contacto eliminada: ${current.name} (${id}) — quitada de ${rows.length} contactos`)
  return true
}

/** Cuántos contactos tienen cada etiqueta (para la página de configuración). */
export async function getContactTagUsage() {
  const rows = await db.all(`SELECT tags FROM contacts WHERE tags IS NOT NULL AND tags != '[]'`)
  const usage = {}
  for (const row of rows) {
    for (const value of parseJsonArray(row.tags)) {
      usage[value] = (usage[value] || 0) + 1
    }
  }
  return usage
}

/**
 * Convierte una lista mixta (IDs nuevos o nombres viejos) a IDs de etiqueta.
 * Con createMissing, los nombres desconocidos crean la etiqueta al vuelo
 * (lo usan las automatizaciones con configuraciones anteriores al catálogo).
 */
export async function resolveTagIds(values, { createMissing = false } = {}) {
  const list = (Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim()).filter(Boolean)
  if (!list.length) return []

  const rows = await db.all('SELECT id, name FROM contact_tags')
  const byId = new Map(rows.map((row) => [row.id, row]))
  const byName = new Map(rows.map((row) => [normalizeTagName(row.name), row]))

  const resolved = []
  for (const value of list) {
    if (isSystemTagId(value)) continue // las internas no se guardan en contacts.tags
    if (byId.has(value)) {
      resolved.push(value)
      continue
    }
    const byNameMatch = byName.get(normalizeTagName(value))
    if (byNameMatch) {
      resolved.push(byNameMatch.id)
      continue
    }
    if (createMissing) {
      const created = await createContactTag(value)
      byId.set(created.id, created)
      byName.set(normalizeTagName(created.name), created)
      resolved.push(created.id)
    }
  }
  return [...new Set(resolved)]
}

/** Nombres legibles para una lista de IDs (los IDs desconocidos se omiten). */
export async function tagNamesForIds(ids) {
  const list = Array.isArray(ids) ? ids : []
  if (!list.length) return []
  const all = await listContactTags()
  const byId = new Map(all.map((tag) => [tag.id, tag.name]))
  return list.map((id) => byId.get(id)).filter(Boolean)
}

/**
 * Etiquetas internas que aplican a un contacto según su actividad:
 * Cliente (tiene compras), Cita agendada (tiene citas activas) o Prospecto.
 */
export async function computeSystemTagIds(contactId) {
  if (!contactId) return ['tag_sys_lead']
  const purchase = await db.get(
    `SELECT 1 AS found FROM payments
     WHERE contact_id = ? AND amount > 0
       AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
     LIMIT 1`,
    [contactId]
  ).catch(() => null)
  if (purchase) return ['tag_sys_customer']

  const appointment = await db.get(
    `SELECT 1 AS found FROM appointments
     WHERE contact_id = ? AND deleted_at IS NULL
       AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'invalid', 'deleted')
     LIMIT 1`,
    [contactId]
  ).catch(() => null)
  if (appointment) return ['tag_sys_appointment']

  return ['tag_sys_lead']
}

/**
 * Conjunto de claves de coincidencia para reglas/filtros: IDs guardados,
 * nombres normalizados (compatibilidad con reglas viejas que guardaban el
 * nombre) y etiquetas internas calculadas.
 */
export async function buildTagMatchKeys(contactId, storedTags = null) {
  let stored = storedTags
  if (stored === null) {
    const row = contactId
      ? await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId]).catch(() => null)
      : null
    stored = parseJsonArray(row?.tags)
  }
  const list = parseJsonArray(stored)

  const keys = new Set()
  const all = await listContactTags()
  const byId = new Map(all.map((tag) => [tag.id, tag]))

  for (const value of list) {
    const raw = String(value || '').trim()
    if (!raw) continue
    keys.add(raw)
    keys.add(normalizeTagName(raw))
    const tag = byId.get(raw)
    if (tag) keys.add(normalizeTagName(tag.name))
  }

  for (const systemId of await computeSystemTagIds(contactId)) {
    keys.add(systemId)
    const system = SYSTEM_TAGS.find((tag) => tag.id === systemId)
    if (system) keys.add(normalizeTagName(system.name))
  }

  return keys
}

/**
 * Migración única: contacts.tags guardaba nombres sueltos; ahora guarda IDs.
 * Crea las etiquetas que falten en el catálogo y reescribe los arrays.
 * Es idempotente: en corridas posteriores todo ya son IDs y no toca nada.
 */
export async function migrateLegacyContactTags() {
  const rows = await db.all(
    `SELECT id, tags FROM contacts WHERE tags IS NOT NULL AND tags != '[]' AND tags != ''`
  ).catch(() => [])
  if (!rows.length) return

  let migrated = 0
  for (const row of rows) {
    const tags = parseJsonArray(row.tags)
    if (!tags.length) continue
    const needsMigration = tags.some((value) => !String(value).startsWith('tag_'))
    if (!needsMigration) continue

    const ids = await resolveTagIds(tags, { createMissing: true })
    await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify(ids), row.id])
    migrated += 1
  }
  if (migrated > 0) {
    logger.info(`Etiquetas de contactos migradas a IDs de catálogo en ${migrated} contactos`)
  }
}
