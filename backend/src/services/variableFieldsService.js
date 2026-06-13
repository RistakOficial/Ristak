import crypto from 'crypto'
import { db } from '../config/database.js'

function cleanString(value, max = 1000) {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned.slice(0, max) : ''
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
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
    parameter: buildVariableFieldParameter(fieldKey),
    archived: Boolean(Number(row.archived ?? 0)),
    createdByUserId: row.created_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

async function getVariableFieldById(id) {
  const cleanId = cleanString(id, 180)
  if (!cleanId) return null
  return mapVariableField(await db.get('SELECT * FROM variable_fields WHERE id = ?', [cleanId]))
}

async function assertUniqueKey(fieldKey, { excludeId = '' } = {}) {
  const params = [fieldKey]
  const excludeClause = excludeId ? 'AND id != ?' : ''
  if (excludeId) params.push(excludeId)
  const existing = await db.get(`
    SELECT id
    FROM variable_fields
    WHERE LOWER(field_key) = LOWER(?)
      AND archived = 0
      ${excludeClause}
    LIMIT 1
  `, params)

  if (existing) {
    throw badRequest('Ese parámetro ya existe. Usa otro nombre interno.')
  }
}

export async function listVariableFields({ includeArchived = false } = {}) {
  const rows = await db.all(`
    SELECT *
    FROM variable_fields
    ${includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY archived ASC, updated_at DESC, created_at DESC
  `)
  return rows.map(mapVariableField).filter(Boolean)
}

export async function createVariableField(input = {}, { userId = null } = {}) {
  const label = cleanString(input.label || input.name, 160)
  const fieldKey = normalizeVariableFieldKey(input.fieldKey || input.key || input.field_key || label)
  const value = cleanString(input.value ?? input.valueText ?? input.value_text, 5000)

  if (!label) throw badRequest('Ponle nombre al campo variable.')
  if (!fieldKey) throw badRequest('Usa un parámetro válido.')

  await assertUniqueKey(fieldKey)

  const id = `variable_field_${crypto.randomUUID()}`
  await db.run(`
    INSERT INTO variable_fields (
      id, field_key, label, value_text, description, archived,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    fieldKey,
    label,
    value,
    cleanString(input.description, 800) || null,
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
    await assertUniqueKey(fieldKey, { excludeId: existing.id })
  }

  await db.run(`
    UPDATE variable_fields SET
      field_key = ?,
      label = ?,
      value_text = ?,
      description = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    fieldKey,
    label,
    input.value === undefined && input.valueText === undefined && input.value_text === undefined
      ? existing.value
      : cleanString(input.value ?? input.valueText ?? input.value_text, 5000),
    input.description === undefined ? existing.description || null : cleanString(input.description, 800) || null,
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
