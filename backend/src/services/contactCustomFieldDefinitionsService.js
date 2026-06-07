import crypto from 'crypto'
import { db } from '../config/database.js'
import {
  normalizeContactCustomFields,
  parseJsonSafe
} from '../utils/contactCustomFields.js'

const STANDARD_CONTACT_FIELD_KEYS = new Set([
  'full_name',
  'first_name',
  'last_name',
  'phone',
  'email',
  'message'
])

const SYSTEM_CONTACT_FIELD_CONFIG = {
  whatsapp_api_provider: {
    label: 'WhatsApp API · Proveedor',
    description: 'Dato tecnico usado por Ristak para identificar el proveedor de WhatsApp.',
    fieldGroup: 'Sistema'
  },
  whatsapp_api_first_message: {
    label: 'WhatsApp API · Primer mensaje',
    description: 'Primer mensaje recibido por WhatsApp API para contexto del contacto.',
    fieldGroup: 'Sistema'
  },
  whatsapp_api_source_id: {
    label: 'WhatsApp API · ID de origen',
    description: 'Identificador de origen o anuncio detectado en mensajes de WhatsApp.',
    fieldGroup: 'Sistema'
  },
  whatsapp_api_ctwa_clid: {
    label: 'WhatsApp API · CTWA CLID',
    description: 'Identificador Click-to-WhatsApp usado para atribucion de Meta.',
    fieldGroup: 'Sistema'
  },
  whatsapp_api_source_url: {
    label: 'WhatsApp API · URL de origen',
    description: 'URL de origen detectada en mensajes de WhatsApp API.',
    fieldGroup: 'Sistema'
  }
}

const DATA_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'currency',
  'dropdown',
  'radio',
  'checkboxes',
  'date',
  'datetime',
  'time',
  'email',
  'phone',
  'select',
  'multiselect',
  'checkbox',
  'boolean',
  'url',
  'file',
  'json'
])

const SYNC_TARGETS = new Set(['local', 'highlevel', 'none'])

const cleanString = (value) => String(value || '').trim()

const limitString = (value, max = 500) => cleanString(value).slice(0, max)

function jsonString(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(null)
  }
}

export function normalizeContactCustomFieldKey(value, fallback = 'custom_field') {
  const normalized = cleanString(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || fallback
}

export function isStandardContactFieldKey(value) {
  return STANDARD_CONTACT_FIELD_KEYS.has(normalizeContactCustomFieldKey(value, ''))
}

export function isSystemContactCustomFieldKey(value) {
  return Boolean(SYSTEM_CONTACT_FIELD_CONFIG[normalizeContactCustomFieldKey(value, '')])
}

function getSystemContactCustomFieldConfig(value) {
  return SYSTEM_CONTACT_FIELD_CONFIG[normalizeContactCustomFieldKey(value, '')] || null
}

function getRawFieldDefinitionKey(rawField = {}) {
  const rawKey = rawField.fieldKey ||
    rawField.field_key ||
    rawField.key ||
    rawField.internalName ||
    rawField.internal_name ||
    rawField.name ||
    rawField.label ||
    rawField.title ||
    rawField.placeholder ||
    rawField.sourceFieldName ||
    rawField.source_field_name

  return normalizeContactCustomFieldKey(rawKey)
}

function canWriteSystemContactCustomField(rawField = {}, context = {}) {
  const requestedSourceType = normalizeContactCustomFieldKey(
    context.sourceType ||
    context.source_type,
    ''
  )

  return Boolean(
    context.allowSystemContactCustomFields ||
    context.allow_system_contact_custom_fields ||
    requestedSourceType === 'system'
  )
}

function normalizeDataType(value) {
  const raw = normalizeContactCustomFieldKey(value, 'text')
  const aliases = {
    string: 'text',
    short_text: 'text',
    plain_text: 'text',
    long_text: 'textarea',
    paragraph: 'textarea',
    select: 'dropdown',
    multiselect: 'checkboxes',
    multiple: 'multiselect'
  }
  const dataType = aliases[raw] || raw
  return DATA_TYPES.has(dataType) ? dataType : 'text'
}

function normalizeSyncTarget(value, fallback = 'local') {
  const syncTarget = normalizeContactCustomFieldKey(value, fallback)
  return SYNC_TARGETS.has(syncTarget) ? syncTarget : fallback
}

function normalizeOwnerUserId(value) {
  const userId = Number(value)
  return Number.isInteger(userId) && userId > 0 ? userId : null
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return []

  return value
    .map(option => {
      if (option && typeof option === 'object') {
        return {
          label: limitString(option.label || option.name || option.value, 180),
          value: limitString(option.value || option.label || option.name, 180)
        }
      }
      const label = limitString(option, 180)
      return { label, value: label }
    })
    .filter(option => option.label || option.value)
}

function normalizeFolderId(value) {
  const folderId = limitString(value, 180)
  return folderId || null
}

function mapFolder(row) {
  if (!row) return null

  return {
    id: row.id,
    name: row.name || 'Carpeta',
    description: row.description || '',
    sortOrder: Number(row.sort_order || 0),
    archived: Boolean(Number(row.archived || 0)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function mapDefinition(row) {
  if (!row) return null
  const systemConfig = getSystemContactCustomFieldConfig(row.field_key)
  const systemManaged = Boolean(systemConfig) || row.source_type === 'system'

  return {
    definitionId: row.id,
    key: row.field_key,
    fieldKey: row.field_key,
    label: systemConfig?.label || row.label || row.field_key,
    name: systemConfig?.label || row.label || row.field_key,
    description: systemConfig?.description || row.description || '',
    dataType: row.data_type || 'text',
    options: parseJsonSafe(row.options_json, []),
    folderId: row.folder_id || '',
    folderName: row.folder_name || '',
    fieldGroup: systemConfig?.fieldGroup || row.field_group || 'general',
    syncTarget: systemManaged ? 'none' : (row.sync_target || 'local'),
    sourceType: systemManaged ? 'system' : (row.source_type || 'manual'),
    sourceId: row.source_id || '',
    sourceSiteId: row.source_site_id || '',
    sourcePageId: row.source_page_id || '',
    sourceFormId: row.source_form_id || '',
    sourceFormName: row.source_form_name || '',
    sourceFieldId: row.source_field_id || '',
    sourceFieldName: row.source_field_name || '',
    sourceLabel: row.source_label || '',
    sourceContext: parseJsonSafe(row.source_context_json, null),
    ownerUserId: row.owner_user_id || null,
    archived: Boolean(Number(row.archived || 0)),
    system: systemManaged,
    systemManaged,
    locked: systemManaged,
    editable: !systemManaged,
    deletable: !systemManaged,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function mapDefinitionSource(row) {
  if (!row) return null

  return {
    id: row.id,
    definitionId: row.definition_id,
    sourceType: row.source_type || 'manual',
    sourceId: row.source_id || '',
    sourceSiteId: row.source_site_id || '',
    sourcePageId: row.source_page_id || '',
    sourceFormId: row.source_form_id || '',
    sourceFormName: row.source_form_name || '',
    sourceFieldId: row.source_field_id || '',
    sourceFieldName: row.source_field_name || '',
    sourceLabel: row.source_label || '',
    sourceContext: parseJsonSafe(row.source_context_json, null),
    occurrenceCount: Number(row.occurrence_count || 0),
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null
  }
}

async function getDefinitionSources(definitionIds = []) {
  const ids = [...new Set(definitionIds.filter(Boolean))]
  if (!ids.length) return new Map()

  const rows = await db.all(`
    SELECT *
    FROM contact_custom_field_definition_sources
    WHERE definition_id IN (${ids.map(() => '?').join(', ')})
    ORDER BY last_seen_at DESC, first_seen_at DESC
  `, ids)
  const sourcesByDefinition = new Map()

  for (const row of rows) {
    const source = mapDefinitionSource(row)
    if (!source) continue
    const current = sourcesByDefinition.get(source.definitionId) || []
    current.push(source)
    sourcesByDefinition.set(source.definitionId, current)
  }

  return sourcesByDefinition
}

async function getDefinitionById(definitionId) {
  const row = await db.get(`
    SELECT d.*, f.name AS folder_name
    FROM contact_custom_field_definitions d
    LEFT JOIN contact_custom_field_folders f ON f.id = d.folder_id
    WHERE d.id = ?
  `, [definitionId])
  const definition = mapDefinition(row)
  if (!definition) return null

  const sourcesByDefinition = await getDefinitionSources([definition.definitionId])
  return {
    ...definition,
    sources: sourcesByDefinition.get(definition.definitionId) || []
  }
}

function getFieldDefinitionInput(rawField = {}, context = {}) {
  const fieldKey = getRawFieldDefinitionKey(rawField)
  const systemConfig = getSystemContactCustomFieldConfig(fieldKey)
  const sourceType = systemConfig
    ? 'system'
    : limitString(rawField.sourceType || rawField.source_type || context.sourceType || context.source_type || 'manual', 80)
  const inferredSyncTarget = rawField.id || rawField.fieldId || rawField.customFieldId ? 'highlevel' : 'local'
  const syncTarget = systemConfig
    ? 'none'
    : normalizeSyncTarget(rawField.syncTarget || rawField.sync_target || context.syncTarget || context.sync_target, inferredSyncTarget)
  const sourceContext = rawField.sourceContext ||
    rawField.source_context ||
    context.sourceContext ||
    context.source_context ||
    null

  return {
    definitionId: limitString(rawField.definitionId || rawField.definition_id || rawField.id, 180),
    fieldKey,
    label: limitString(systemConfig?.label || rawField.label || rawField.name || rawField.title || rawField.placeholder || fieldKey, 180),
    description: limitString(systemConfig?.description || rawField.description || context.description, 600),
    dataType: normalizeDataType(rawField.dataType || rawField.type || rawField.inputType || rawField.input_type),
    folderId: normalizeFolderId(rawField.folderId || rawField.folder_id || context.folderId || context.folder_id),
    fieldGroup: limitString(systemConfig?.fieldGroup || rawField.fieldGroup || rawField.field_group || context.fieldGroup || context.field_group || 'general', 120),
    options: normalizeOptions(rawField.options || rawField.picklistOptions),
    syncTarget,
    sourceType,
    sourceId: limitString(rawField.sourceId || rawField.source_id || context.sourceId || context.source_id, 180),
    sourceSiteId: limitString(rawField.sourceSiteId || rawField.source_site_id || context.sourceSiteId || context.source_site_id, 180),
    sourcePageId: limitString(rawField.sourcePageId || rawField.source_page_id || context.sourcePageId || context.source_page_id, 180),
    sourceFormId: limitString(rawField.sourceFormId || rawField.source_form_id || context.sourceFormId || context.source_form_id, 180),
    sourceFormName: limitString(rawField.sourceFormName || rawField.source_form_name || context.sourceFormName || context.source_form_name, 180),
    sourceFieldId: limitString(rawField.sourceFieldId || rawField.source_field_id || context.sourceFieldId || context.source_field_id, 180),
    sourceFieldName: limitString(rawField.sourceFieldName || rawField.source_field_name || context.sourceFieldName || context.source_field_name || rawField.name, 180),
    sourceLabel: limitString(systemConfig?.label || rawField.sourceLabel || rawField.source_label || rawField.label || rawField.placeholder, 180),
    sourceContext,
    ownerUserId: normalizeOwnerUserId(rawField.ownerUserId || rawField.owner_user_id || context.ownerUserId || context.owner_user_id || context.userId || context.user_id)
  }
}

async function getFolderById(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  return mapFolder(await db.get('SELECT * FROM contact_custom_field_folders WHERE id = ?', [id]))
}

async function assertFolderExists(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const folder = await getFolderById(id)
  if (!folder || folder.archived) {
    const error = new Error('La carpeta seleccionada no existe o esta archivada')
    error.status = 400
    throw error
  }

  return folder
}

async function recordDefinitionSource(definitionId, input = {}) {
  if (!definitionId) return

  const sourceContextJson = input.sourceContext ? jsonString(input.sourceContext) : null
  const lookupParams = [
    definitionId,
    input.sourceType || 'manual',
    input.sourceId || '',
    input.sourceSiteId || '',
    input.sourcePageId || '',
    input.sourceFormId || '',
    input.sourceFieldId || '',
    (input.sourceFieldName || '').toLowerCase()
  ]
  const existing = await db.get(`
    SELECT id
    FROM contact_custom_field_definition_sources
    WHERE definition_id = ?
      AND source_type = ?
      AND COALESCE(source_id, '') = ?
      AND COALESCE(source_site_id, '') = ?
      AND COALESCE(source_page_id, '') = ?
      AND COALESCE(source_form_id, '') = ?
      AND COALESCE(source_field_id, '') = ?
      AND LOWER(COALESCE(source_field_name, '')) = ?
    LIMIT 1
  `, lookupParams)

  if (existing) {
    await db.run(`
      UPDATE contact_custom_field_definition_sources SET
        source_form_name = COALESCE(NULLIF(?, ''), source_form_name),
        source_label = COALESCE(NULLIF(?, ''), source_label),
        source_context_json = COALESCE(source_context_json, ?),
        occurrence_count = COALESCE(occurrence_count, 0) + 1,
        last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      input.sourceFormName || '',
      input.sourceLabel || '',
      sourceContextJson,
      existing.id
    ])
    return
  }

  await db.run(`
    INSERT INTO contact_custom_field_definition_sources (
      id, definition_id, source_type, source_id, source_site_id, source_page_id,
      source_form_id, source_form_name, source_field_id, source_field_name,
      source_label, source_context_json, occurrence_count, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    `contact_field_source_${crypto.randomUUID()}`,
    definitionId,
    input.sourceType || 'manual',
    input.sourceId || null,
    input.sourceSiteId || null,
    input.sourcePageId || null,
    input.sourceFormId || null,
    input.sourceFormName || null,
    input.sourceFieldId || null,
    input.sourceFieldName || null,
    input.sourceLabel || null,
    sourceContextJson
  ])
}

async function findDefinitionByKey(fieldKey, ownerUserId = null) {
  const key = normalizeContactCustomFieldKey(fieldKey, '')
  if (!key) return null

  const row = await db.get(`
    SELECT *
    FROM contact_custom_field_definitions
    WHERE LOWER(field_key) = LOWER(?)
      AND COALESCE(owner_user_id, 0) = ?
      AND archived = 0
    LIMIT 1
  `, [key, ownerUserId || 0])

  return mapDefinition(row)
}

async function findDefinitionByInput(input = {}) {
  const definitionId = limitString(input.definitionId, 180)
  if (definitionId) {
    const byId = mapDefinition(await db.get('SELECT * FROM contact_custom_field_definitions WHERE id = ? AND archived = 0', [definitionId]))
    if (byId) return byId
  }

  return findDefinitionByKey(input.fieldKey, input.ownerUserId)
}

export async function listContactCustomFieldDefinitions({ includeArchived = false, userId = null } = {}) {
  const ownerUserId = normalizeOwnerUserId(userId)
  const params = []
  const conditions = []

  if (!includeArchived) {
    conditions.push('d.archived = 0')
  }

  if (ownerUserId) {
    conditions.push('(d.owner_user_id IS NULL OR d.owner_user_id = ?)')
    params.push(ownerUserId)
  } else {
    conditions.push('d.owner_user_id IS NULL')
  }

  const rows = await db.all(`
    SELECT d.*, f.name AS folder_name
    FROM contact_custom_field_definitions d
    LEFT JOIN contact_custom_field_folders f ON f.id = d.folder_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY COALESCE(f.sort_order, 999999) ASC, COALESCE(f.name, d.field_group, 'general') ASC, d.label ASC, d.field_key ASC
  `, params)

  const definitions = rows.map(mapDefinition)
  const sourcesByDefinition = await getDefinitionSources(definitions.map(definition => definition.definitionId))

  return definitions.map(definition => ({
    ...definition,
    sources: sourcesByDefinition.get(definition.definitionId) || []
  }))
}

export async function listContactCustomFieldFolders({ includeArchived = false } = {}) {
  const rows = await db.all(`
    SELECT *
    FROM contact_custom_field_folders
    ${includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY sort_order ASC, name ASC
  `)

  return rows.map(mapFolder).filter(Boolean)
}

export async function createContactCustomFieldFolder(input = {}) {
  const name = limitString(input.name, 120)
  if (!name) {
    const error = new Error('Ponle nombre a la carpeta')
    error.status = 400
    throw error
  }

  const maxSort = await db.get(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_sort
    FROM contact_custom_field_folders
    WHERE archived = 0
  `)
  const id = `contact_field_folder_${crypto.randomUUID()}`

  await db.run(`
    INSERT INTO contact_custom_field_folders (
      id, name, description, sort_order, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    name,
    limitString(input.description, 400) || null,
    Number(maxSort?.max_sort || 0) + 1
  ])

  return getFolderById(id)
}

export async function updateContactCustomFieldFolder(folderId, input = {}) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const existing = await getFolderById(id)
  if (!existing) return null

  const name = limitString(input.name || existing.name, 120)
  if (!name) {
    const error = new Error('Ponle nombre a la carpeta')
    error.status = 400
    throw error
  }

  await db.run(`
    UPDATE contact_custom_field_folders SET
      name = ?,
      description = ?,
      sort_order = ?,
      archived = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name,
    input.description === undefined ? existing.description || null : limitString(input.description, 400) || null,
    Number.isFinite(Number(input.sortOrder ?? input.sort_order)) ? Number(input.sortOrder ?? input.sort_order) : existing.sortOrder,
    input.archived === undefined ? (existing.archived ? 1 : 0) : (input.archived ? 1 : 0),
    id
  ])

  return getFolderById(id)
}

export async function archiveContactCustomFieldFolder(folderId) {
  const id = normalizeFolderId(folderId)
  if (!id) return null

  const folder = await updateContactCustomFieldFolder(id, { archived: true })
  if (!folder) return null

  await db.run(`
    UPDATE contact_custom_field_definitions SET
      folder_id = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE folder_id = ?
  `, [id])

  return folder
}

export async function upsertContactCustomFieldDefinition(rawField = {}, context = {}) {
  const input = getFieldDefinitionInput(rawField, context)

  if (!input.fieldKey || isStandardContactFieldKey(input.fieldKey)) {
    return null
  }

  if (isSystemContactCustomFieldKey(input.fieldKey) && !canWriteSystemContactCustomField(rawField, context)) {
    const error = new Error('Ese ID lo usa Ristak para datos internos de sistema y no se puede usar manualmente.')
    error.status = rawField.createOnly ? 400 : 403
    throw error
  }

  const folder = await assertFolderExists(input.folderId)
  const existing = await findDefinitionByInput(input)
  const optionsJson = jsonString(input.options)
  const sourceContextJson = input.sourceContext ? jsonString(input.sourceContext) : null
  const fieldGroup = folder?.name || input.fieldGroup
  const updateFieldGroup = input.folderId ? fieldGroup : ''

  if (existing) {
    if (rawField.createOnly) {
      const error = new Error('Ese ID ya existe. Elimina el campo anterior antes de volver a usarlo.')
      error.status = 409
      throw error
    }

    await db.run(`
      UPDATE contact_custom_field_definitions SET
        folder_id = COALESCE(?, folder_id),
        field_group = COALESCE(NULLIF(?, ''), field_group),
        sync_target = COALESCE(NULLIF(?, ''), sync_target),
        source_type = COALESCE(NULLIF(source_type, ''), ?),
        source_id = COALESCE(NULLIF(source_id, ''), ?),
        source_site_id = COALESCE(NULLIF(source_site_id, ''), ?),
        source_page_id = COALESCE(NULLIF(source_page_id, ''), ?),
        source_form_id = COALESCE(NULLIF(source_form_id, ''), ?),
        source_form_name = COALESCE(NULLIF(source_form_name, ''), ?),
        source_field_id = COALESCE(NULLIF(source_field_id, ''), ?),
        source_field_name = COALESCE(NULLIF(source_field_name, ''), ?),
        source_label = COALESCE(NULLIF(source_label, ''), ?),
        source_context_json = COALESCE(source_context_json, ?),
        archived = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      input.folderId,
      updateFieldGroup,
      input.syncTarget,
      input.sourceType,
      input.sourceId,
      input.sourceSiteId,
      input.sourcePageId,
      input.sourceFormId,
      input.sourceFormName,
      input.sourceFieldId,
      input.sourceFieldName,
      input.sourceLabel,
      sourceContextJson,
      existing.definitionId
    ])

    await recordDefinitionSource(existing.definitionId, input)
    return getDefinitionById(existing.definitionId)
  }

  const id = `contact_field_${crypto.randomUUID()}`
  await db.run(`
    INSERT INTO contact_custom_field_definitions (
      id, owner_user_id, field_key, label, description, data_type, folder_id, field_group,
      options_json, sync_target, source_type, source_id, source_site_id, source_page_id,
      source_form_id, source_form_name, source_field_id, source_field_name, source_label,
      source_context_json, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    input.ownerUserId,
    input.fieldKey,
    input.label,
    input.description || null,
    input.dataType,
    input.folderId,
    fieldGroup,
    optionsJson,
    input.syncTarget,
    input.sourceType,
    input.sourceId || null,
    input.sourceSiteId || null,
    input.sourcePageId || null,
    input.sourceFormId || null,
    input.sourceFormName || null,
    input.sourceFieldId || null,
    input.sourceFieldName || null,
    input.sourceLabel || null,
    sourceContextJson
  ])

  await recordDefinitionSource(id, input)
  return getDefinitionById(id)
}

export async function ensureContactCustomFieldDefinitions(fields = [], context = {}) {
  const definitions = []

  for (const field of Array.isArray(fields) ? fields : []) {
    const definition = await upsertContactCustomFieldDefinition(field, context)
    if (definition) definitions.push(definition)
  }

  return definitions
}

export async function prepareContactCustomFieldsForStorage(fields = [], context = {}) {
  const safeFields = (Array.isArray(fields) ? fields : []).filter(field => {
    const fieldKey = getRawFieldDefinitionKey(field)
    return !isSystemContactCustomFieldKey(fieldKey) || canWriteSystemContactCustomField(field, context)
  })
  const definitions = await ensureContactCustomFieldDefinitions(safeFields, context)
  const byKey = new Map(definitions.map(definition => [definition.fieldKey || definition.key, definition]))

  const enrichedFields = safeFields.map(field => {
    const key = normalizeContactCustomFieldKey(field.fieldKey || field.field_key || field.key || field.name || field.label)
    const definition = byKey.get(key)

    if (!definition) return field

    return {
      ...field,
      definitionId: field.definitionId || field.definition_id || definition.definitionId,
      key: field.key || definition.key,
      fieldKey: field.fieldKey || field.field_key || definition.fieldKey,
      label: field.label || definition.label,
      name: field.name || definition.name || definition.label,
      dataType: field.dataType || field.type || definition.dataType,
      options: Array.isArray(field.options) && field.options.length ? field.options : definition.options,
      folderId: field.folderId || field.folder_id || definition.folderId,
      folderName: field.folderName || field.folder_name || definition.folderName,
      fieldGroup: field.fieldGroup || field.field_group || definition.fieldGroup,
      syncTarget: field.syncTarget || field.sync_target || definition.syncTarget,
      sourceType: field.sourceType || field.source_type || definition.sourceType,
      sourceId: field.sourceId || field.source_id || definition.sourceId,
      sourceSiteId: field.sourceSiteId || field.source_site_id || definition.sourceSiteId,
      sourcePageId: field.sourcePageId || field.source_page_id || definition.sourcePageId,
      sourceFormId: field.sourceFormId || field.source_form_id || definition.sourceFormId,
      sourceFormName: field.sourceFormName || field.source_form_name || definition.sourceFormName,
      sourceFieldId: field.sourceFieldId || field.source_field_id || definition.sourceFieldId,
      sourceFieldName: field.sourceFieldName || field.source_field_name || definition.sourceFieldName,
      sourceLabel: field.sourceLabel || field.source_label || definition.sourceLabel,
      sourceContext: field.sourceContext || field.source_context || definition.sourceContext
    }
  })

  return normalizeContactCustomFields({ customFields: enrichedFields })
}

function normalizeOptionsForComparison(options = []) {
  return normalizeOptions(options).map(option => ({
    label: option.label || '',
    value: option.value || ''
  }))
}

function assertImmutableFieldIdentity(current, input = {}) {
  const hasKeyInput = input.key !== undefined || input.fieldKey !== undefined || input.field_key !== undefined
  const hasTypeInput = input.dataType !== undefined || input.type !== undefined || input.data_type !== undefined
  const hasOptionsInput = input.options !== undefined

  if (hasKeyInput) {
    const nextKey = normalizeContactCustomFieldKey(input.key || input.fieldKey || input.field_key)
    if (nextKey !== current.fieldKey) {
      const error = new Error('El ID del campo no se puede cambiar. Elimina el campo y crea uno nuevo si necesitas otro ID.')
      error.status = 400
      throw error
    }
  }

  if (hasTypeInput) {
    const nextDataType = normalizeDataType(input.dataType || input.type || input.data_type)
    if (nextDataType !== current.dataType) {
      const error = new Error('El tipo del campo no se puede cambiar despues de crearlo.')
      error.status = 400
      throw error
    }
  }

  if (hasOptionsInput) {
    const nextOptionsJson = jsonString(normalizeOptionsForComparison(input.options))
    const currentOptionsJson = jsonString(normalizeOptionsForComparison(current.options))
    if (nextOptionsJson !== currentOptionsJson) {
      const error = new Error('Las opciones del campo no se pueden cambiar despues de crearlo.')
      error.status = 400
      throw error
    }
  }
}

function assertEditableSystemField(current) {
  if (!current?.systemManaged && !isSystemContactCustomFieldKey(current?.fieldKey)) return

  const error = new Error('Este campo lo crea Ristak para datos internos del sistema. No se puede editar, mover ni eliminar.')
  error.status = 403
  throw error
}

export async function updateContactCustomFieldDefinition(definitionId, input = {}) {
  const id = cleanString(definitionId)
  if (!id) return null

  const existing = await db.get('SELECT * FROM contact_custom_field_definitions WHERE id = ?', [id])
  if (!existing) return null

  const current = mapDefinition(existing)
  assertEditableSystemField(current)
  assertImmutableFieldIdentity(current, input)

  if (!current.fieldKey || isStandardContactFieldKey(current.fieldKey)) {
    const error = new Error('Ese nombre interno esta reservado para campos principales del contacto')
    error.status = 400
    throw error
  }

  const nextFolderId = input.folderId !== undefined || input.folder_id !== undefined
    ? normalizeFolderId(input.folderId || input.folder_id)
    : current.folderId || null
  const folder = await assertFolderExists(nextFolderId)
  const nextFieldGroup = folder?.name || limitString(input.fieldGroup || input.field_group || current.fieldGroup || 'general', 120)

  await db.run(`
    UPDATE contact_custom_field_definitions SET
      label = ?,
      folder_id = ?,
      field_group = ?,
      archived = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    limitString(input.label || input.name || current.label, 180),
    nextFolderId,
    nextFieldGroup,
    input.archived === undefined ? (current.archived ? 1 : 0) : (input.archived ? 1 : 0),
    id
  ])

  const row = await db.get(`
    SELECT d.*, f.name AS folder_name
    FROM contact_custom_field_definitions d
    LEFT JOIN contact_custom_field_folders f ON f.id = d.folder_id
    WHERE d.id = ?
  `, [id])
  return mapDefinition(row)
}

export async function deleteContactCustomFieldDefinition(definitionId) {
  const id = cleanString(definitionId)
  if (!id) return null

  const row = await db.get(`
    SELECT d.*, f.name AS folder_name
    FROM contact_custom_field_definitions d
    LEFT JOIN contact_custom_field_folders f ON f.id = d.folder_id
    WHERE d.id = ?
  `, [id])
  const definition = mapDefinition(row)
  if (!definition) return null
  assertEditableSystemField(definition)

  await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [id])
  await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [id])
  return definition
}
