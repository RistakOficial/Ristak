import { db } from '../config/database.js'
import { createRistakId } from '../utils/idGenerator.js'

export const VARIABLE_FIELD_VALUE_MAX_LENGTH = 100000

function cleanString(value, max = 1000) {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned.slice(0, max) : ''
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function cleanVariableFieldValue(value) {
  const cleaned = String(value ?? '').trim()
  if (cleaned.length > VARIABLE_FIELD_VALUE_MAX_LENGTH) {
    throw badRequest(`El valor del campo variable no puede superar ${VARIABLE_FIELD_VALUE_MAX_LENGTH.toLocaleString('es-MX')} caracteres.`)
  }
  return cleaned
}

function notFound(message) {
  const error = new Error(message)
  error.status = 404
  return error
}

export function normalizeVariableFieldKey(value) {
  return cleanString(value, 160)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'campo_variable'
}

export function buildVariableFieldParameter(fieldKey) {
  const key = normalizeVariableFieldKey(fieldKey)
  return key ? `{{variable.${key}}}` : ''
}

function mapVariableField(row) {
  if (!row) return null
  const fieldKey = row.field_key || ''
  return {
    id: row.id,
    fieldKey,
    key: fieldKey,
    label: row.label || fieldKey || 'Campo variable',
    name: row.label || fieldKey || 'Campo variable',
    value: row.value_text || '',
    description: row.description || '',
    folderId: row.folder_id || '',
    folderName: row.folder_name || '',
    parameter: buildVariableFieldParameter(fieldKey),
    archived: Boolean(Number(row.archived ?? 0)),
    createdByUserId: row.created_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function mapVariableFieldFolder(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || 'Carpeta',
    description: row.description || '',
    sortOrder: Number(row.sort_order || 0),
    archived: Boolean(Number(row.archived ?? 0)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function normalizeFolderId(value) {
  return cleanString(value, 180)
}

export async function getVariableFieldFolderById(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null
  return mapVariableFieldFolder(await db.get('SELECT * FROM variable_field_folders WHERE id = ?', [id]))
}

async function assertVariableFieldFolderExists(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const folder = await getVariableFieldFolderById(id)
  if (!folder || folder.archived) {
    throw badRequest('La carpeta seleccionada no existe o está archivada.')
  }
  return folder
}

export async function getVariableFieldById(id) {
  const cleanId = cleanString(id, 180)
  if (!cleanId) return null
  return mapVariableField(await db.get(`
    SELECT v.*, f.name AS folder_name
    FROM variable_fields v
    LEFT JOIN variable_field_folders f ON f.id = v.folder_id
    WHERE v.id = ?
  `, [cleanId]))
}

function parseSiteTheme(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function headerTrackingValues(theme = {}) {
  const pages = Array.isArray(theme.pages) ? theme.pages : []
  return [
    theme.headerTrackingCode,
    theme.header_tracking_code,
    ...pages.flatMap(page => [page?.headerTrackingCode, page?.header_tracking_code])
  ].filter(value => typeof value === 'string' && value.includes('{{'))
}

function headerValueReferencesField(value, fieldKey) {
  const expectedKey = normalizeVariableFieldKey(fieldKey)
  if (!expectedKey) return false
  for (const match of String(value || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const token = String(match[1] || '').trim().toLowerCase()
    if (token === expectedKey || token === `variable.${expectedKey}`) return true
  }
  return false
}

export async function isVariableFieldUsedInSiteHeader(variableFieldId) {
  const field = await getVariableFieldById(variableFieldId)
  if (!field) return false

  const rows = await db.all('SELECT theme_json FROM public_sites')
  return rows.some(row => headerTrackingValues(parseSiteTheme(row.theme_json))
    .some(value => headerValueReferencesField(value, field.fieldKey)))
}

async function assertUniqueKey(fieldKey, { excludeId = '' } = {}) {
  const params = [fieldKey]
  const excludeClause = excludeId ? 'AND id != ?' : ''
  if (excludeId) params.push(excludeId)
  const existing = await db.get(`
    SELECT id
    FROM variable_fields
    WHERE LOWER(field_key) = LOWER(?)
      ${excludeClause}
    LIMIT 1
  `, params)

  if (existing) {
    throw badRequest('Ese parámetro ya existe o fue archivado. Usa otro nombre interno para no cambiar el significado de referencias anteriores.')
  }
}

export async function listVariableFields({ includeArchived = false } = {}) {
  const rows = await db.all(`
    SELECT v.*, f.name AS folder_name
    FROM variable_fields v
    LEFT JOIN variable_field_folders f ON f.id = v.folder_id
    ${includeArchived ? '' : 'WHERE v.archived = 0'}
    ORDER BY v.archived ASC, COALESCE(f.sort_order, 999999) ASC, COALESCE(f.name, '') ASC, v.updated_at DESC, v.created_at DESC
  `)
  return rows.map(mapVariableField).filter(Boolean)
}

export async function listVariableFieldFolders({ includeArchived = false } = {}) {
  const rows = await db.all(`
    SELECT *
    FROM variable_field_folders
    ${includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY sort_order ASC, name ASC
  `)
  return rows.map(mapVariableFieldFolder).filter(Boolean)
}

export async function createVariableFieldFolder(input = {}) {
  const name = cleanString(input.name, 120)
  if (!name) throw badRequest('Ponle nombre a la carpeta.')

  const maxSort = await db.get(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_sort
    FROM variable_field_folders
    WHERE archived = 0
  `)
  const id = createRistakId('variable_field_folder')

  await db.run(`
    INSERT INTO variable_field_folders (
      id, name, description, sort_order, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    name,
    cleanString(input.description, 400) || null,
    Number(maxSort?.max_sort || 0) + 1
  ])

  return getVariableFieldFolderById(id)
}

export async function updateVariableFieldFolder(folderId, input = {}) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const existing = await getVariableFieldFolderById(id)
  if (!existing) return null

  const name = input.name === undefined ? existing.name : cleanString(input.name, 120)
  if (!name) throw badRequest('Ponle nombre a la carpeta.')

  await db.run(`
    UPDATE variable_field_folders SET
      name = ?,
      description = ?,
      sort_order = ?,
      archived = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name,
    input.description === undefined ? existing.description || null : cleanString(input.description, 400) || null,
    Number.isFinite(Number(input.sortOrder ?? input.sort_order)) ? Number(input.sortOrder ?? input.sort_order) : existing.sortOrder,
    input.archived === undefined ? (existing.archived ? 1 : 0) : (input.archived ? 1 : 0),
    id
  ])

  return getVariableFieldFolderById(id)
}

export async function archiveVariableFieldFolder(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const folder = await updateVariableFieldFolder(id, { archived: true })
  if (!folder) return null

  await db.run(`
    UPDATE variable_fields SET
      folder_id = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE folder_id = ?
  `, [id])

  return folder
}

export async function createVariableField(input = {}, { userId = null } = {}) {
  const label = cleanString(input.label || input.name, 160)
  const fieldKey = normalizeVariableFieldKey(input.fieldKey || input.key || input.field_key || label)
  const value = cleanVariableFieldValue(input.value ?? input.valueText ?? input.value_text)
  const folderId = normalizeFolderId(input.folderId ?? input.folder_id)

  if (!label) throw badRequest('Ponle nombre al campo variable.')
  if (!fieldKey) throw badRequest('Usa un parámetro válido.')

  await assertUniqueKey(fieldKey)
  await assertVariableFieldFolderExists(folderId)

  const id = createRistakId('variable_field')
  await db.run(`
    INSERT INTO variable_fields (
      id, field_key, label, value_text, description, folder_id, archived,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    fieldKey,
    label,
    value,
    cleanString(input.description, 800) || null,
    folderId || null,
    userId ? String(userId) : null
  ])

  return getVariableFieldById(id)
}

export async function updateVariableField(variableFieldId, input = {}) {
  const existing = await getVariableFieldById(variableFieldId)
  if (!existing || existing.archived) throw notFound('Campo variable no encontrado.')

  const label = input.label === undefined && input.name === undefined
    ? existing.label
    : cleanString(input.label || input.name, 160)
  if (!label) throw badRequest('Ponle nombre al campo variable.')

  const hasKeyInput = input.fieldKey !== undefined || input.key !== undefined || input.field_key !== undefined
  const fieldKey = hasKeyInput
    ? normalizeVariableFieldKey(input.fieldKey || input.key || input.field_key)
    : existing.fieldKey
  if (!fieldKey) throw badRequest('Usa un parámetro válido.')

  if (fieldKey !== existing.fieldKey) {
    throw badRequest('El parámetro interno no se puede cambiar porque rompería los lugares donde ya se usa. Crea otro campo si necesitas una llave distinta.')
  }

  const hasFolderInput = input.folderId !== undefined || input.folder_id !== undefined
  const folderId = hasFolderInput
    ? normalizeFolderId(input.folderId ?? input.folder_id)
    : existing.folderId
  await assertVariableFieldFolderExists(folderId)

  await db.run(`
    UPDATE variable_fields SET
      field_key = ?,
      label = ?,
      value_text = ?,
      description = ?,
      folder_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    fieldKey,
    label,
    input.value === undefined && input.valueText === undefined && input.value_text === undefined
      ? existing.value
      : cleanVariableFieldValue(input.value ?? input.valueText ?? input.value_text),
    input.description === undefined ? existing.description || null : cleanString(input.description, 800) || null,
    folderId || null,
    existing.id
  ])

  return getVariableFieldById(existing.id)
}

export async function archiveVariableField(variableFieldId) {
  const existing = await getVariableFieldById(variableFieldId)
  if (!existing || existing.archived) throw notFound('Campo variable no encontrado.')

  await db.run(`
    UPDATE variable_fields SET
      archived = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [existing.id])

  return getVariableFieldById(existing.id)
}

export async function getVariableFieldValueMap() {
  const fields = await listVariableFields()
  return fields.reduce((map, field) => {
    if (field.fieldKey) map[field.fieldKey] = field.value ?? ''
    return map
  }, {})
}
