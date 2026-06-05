import crypto from 'crypto'
import { db } from '../config/database.js'

const TEMPLATE_CATEGORIES = new Set(['utility', 'marketing', 'authentication', 'service'])
const TEMPLATE_STATUSES = new Set(['draft', 'active', 'archived'])
const HEADER_TYPES = new Set(['none', 'text', 'image', 'video', 'document', 'location'])
const BUTTON_TYPES = new Set(['quick_reply', 'website', 'phone', 'whatsapp_call'])
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g

const BASE_CONTACT_VARIABLES = [
  ['Full name', 'contact.name', 'Jane Smith'],
  ['First name', 'contact.first_name', 'Jane'],
  ['Last name', 'contact.last_name', 'Smith'],
  ['Email', 'contact.email', 'jane@smith.com'],
  ['Phone', 'contact.phone', '(515) 555-2345'],
  ['Phone raw format', 'contact.phone_raw', '+15155552345'],
  ['Company name', 'contact.company_name', 'Smith Plumbing'],
  ['Full address', 'contact.full_address', '1234 W. Main St, Chicago, IL 60657'],
  ['Address line 1', 'contact.address1', '1234 W. Main St'],
  ['City', 'contact.city', 'Chicago'],
  ['State/Region', 'contact.state', 'Illinois'],
  ['Postal code', 'contact.postal_code', '60657'],
  ['Time zone', 'contact.timezone', 'GMT-06:00 America/Chicago'],
  ['Date of birth', 'contact.date_of_birth', 'Jan 3, 1980'],
  ['Source', 'contact.source', 'Referral'],
  ['Website', 'contact.website', 'www.example.com'],
  ['Contact ID', 'contact.id', 'FZDn5mYlkZuCCQe5Bep8']
].map(([label, key, example]) => ({
  key,
  label,
  mergeField: `{{${key}}}`,
  example,
  group: 'Contacto',
  source: 'system'
}))

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeOptionalString(value) {
  const cleaned = cleanString(value)
  return cleaned || null
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(null)
  }
}

function normalizeKey(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

function normalizeTemplateName(value) {
  const normalized = normalizeKey(value)
  if (!normalized) {
    throw new Error('El nombre de la plantilla es obligatorio')
  }
  return normalized.slice(0, 80)
}

function normalizeFieldKey(value) {
  const normalized = normalizeKey(value)
  if (!normalized) {
    throw new Error('La llave del campo personalizado es obligatoria')
  }
  return normalized.slice(0, 80)
}

function normalizeCategory(value) {
  const category = normalizeKey(value)
  return TEMPLATE_CATEGORIES.has(category) ? category : 'utility'
}

function normalizeStatus(value) {
  const status = normalizeKey(value)
  return TEMPLATE_STATUSES.has(status) ? status : 'draft'
}

function normalizeHeaderType(value, enabled) {
  if (!enabled) return 'none'
  const headerType = normalizeKey(value)
  return HEADER_TYPES.has(headerType) ? headerType : 'text'
}

function normalizeLanguage(value) {
  const language = cleanString(value).replace('-', '_')
  return language || 'es_MX'
}

function clampText(value, maxLength) {
  const cleaned = cleanString(value)
  return cleaned.slice(0, maxLength)
}

function normalizeLocation(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    latitude: clampText(source.latitude, 40),
    longitude: clampText(source.longitude, 40),
    name: clampText(source.name, 80),
    address: clampText(source.address, 160)
  }
}

function normalizeButtons(value = []) {
  if (!Array.isArray(value)) return []

  return value
    .slice(0, 10)
    .map((button) => {
      const type = BUTTON_TYPES.has(cleanString(button?.type)) ? cleanString(button.type) : 'quick_reply'
      return {
        id: cleanString(button?.id) || makeId('tmpl_btn'),
        type,
        label: clampText(button?.label, 25),
        value: clampText(button?.value, type === 'website' ? 2048 : 80)
      }
    })
    .filter((button) => button.label)
}

function normalizeVariableExamples(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, example]) => [cleanString(key), clampText(example, 140)])
      .filter(([key, example]) => key && example)
  )
}

function extractVariablesFromText(text, targetSet) {
  const content = cleanString(text)
  if (!content) return

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const key = cleanString(match[1])
    if (key) targetSet.add(`{{${key}}}`)
  }
}

function extractVariablesFromTemplate(template) {
  const variables = new Set()
  extractVariablesFromText(template.headerText, variables)
  extractVariablesFromText(template.bodyText, variables)
  extractVariablesFromText(template.footerText, variables)

  for (const button of template.buttons || []) {
    extractVariablesFromText(button.label, variables)
    extractVariablesFromText(button.value, variables)
  }

  return Array.from(variables).sort((a, b) => a.localeCompare(b))
}

function normalizeTemplatePayload(payload = {}) {
  const headerEnabled = Boolean(payload.headerEnabled)
  const headerType = normalizeHeaderType(payload.headerType, headerEnabled)
  const headerText = headerType === 'text' ? clampText(payload.headerText, 60) : ''
  const headerMediaUrl = ['image', 'video', 'document'].includes(headerType)
    ? clampText(payload.headerMediaUrl, 2048)
    : ''
  const headerLocation = headerType === 'location' ? normalizeLocation(payload.headerLocation) : normalizeLocation()
  const buttons = normalizeButtons(payload.buttons)

  const template = {
    folderId: normalizeOptionalString(payload.folderId),
    name: normalizeTemplateName(payload.name),
    description: clampText(payload.description, 240),
    category: normalizeCategory(payload.category),
    language: normalizeLanguage(payload.language),
    status: normalizeStatus(payload.status),
    headerEnabled: headerType !== 'none',
    headerType,
    headerText,
    headerMediaUrl,
    headerLocation,
    bodyText: clampText(payload.bodyText, 1024),
    footerText: clampText(payload.footerText, 60),
    buttons,
    variableExamples: normalizeVariableExamples(payload.variableExamples),
    ycloudTemplateId: normalizeOptionalString(payload.ycloudTemplateId),
    ycloudStatus: normalizeOptionalString(payload.ycloudStatus)
  }

  if (!template.bodyText) {
    throw new Error('El cuerpo de la plantilla es obligatorio')
  }

  template.variables = extractVariablesFromTemplate(template)
  return template
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapCustomField(row) {
  return {
    id: row.id,
    name: row.name,
    fieldKey: row.field_key,
    mergeField: row.merge_field,
    example: row.example || '',
    dataType: row.data_type || 'text',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapTemplate(row) {
  return {
    id: row.id,
    folderId: row.folder_id || null,
    name: row.name,
    description: row.description || '',
    category: row.category || 'utility',
    language: row.language || 'es_MX',
    status: row.status || 'draft',
    headerEnabled: Boolean(row.header_enabled),
    headerType: row.header_type || 'none',
    headerText: row.header_text || '',
    headerMediaUrl: row.header_media_url || '',
    headerLocation: parseJson(row.header_location_json, normalizeLocation()),
    bodyText: row.body_text || '',
    footerText: row.footer_text || '',
    buttons: parseJson(row.buttons_json, []),
    variables: parseJson(row.variables_json, []),
    variableExamples: parseJson(row.variable_examples_json, {}),
    ycloudTemplateId: row.ycloud_template_id || null,
    ycloudStatus: row.ycloud_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function customFieldVariables(customFields = []) {
  return customFields.map((field) => ({
    key: `contact.custom.${field.fieldKey}`,
    label: field.name,
    mergeField: field.mergeField,
    example: field.example || field.name,
    group: 'Campos personalizados',
    source: 'custom',
    fieldKey: field.fieldKey
  }))
}

function buildCatalog(customFields = []) {
  return [...BASE_CONTACT_VARIABLES, ...customFieldVariables(customFields)]
}

function getVariableLookup(catalog = []) {
  return new Map(catalog.map((variable) => [variable.mergeField, variable]))
}

function resolveText(text, variableExamples = {}, catalog = []) {
  const lookup = getVariableLookup(catalog)
  return cleanString(text).replace(VARIABLE_PATTERN, (fullMatch, key) => {
    const mergeField = `{{${key}}}`
    return variableExamples[mergeField] ||
      variableExamples[key] ||
      lookup.get(mergeField)?.example ||
      fullMatch
  })
}

async function assertFolderExists(folderId) {
  if (!folderId) return
  const folder = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [folderId])
  if (!folder) throw new Error('La carpeta seleccionada no existe')
}

export async function getMessageTemplateBundle() {
  const [folderRows, templateRows, customFieldRows] = await Promise.all([
    db.all('SELECT * FROM whatsapp_template_folders ORDER BY sort_order ASC, name ASC'),
    db.all('SELECT * FROM whatsapp_message_templates ORDER BY updated_at DESC, name ASC'),
    db.all('SELECT * FROM whatsapp_template_custom_fields ORDER BY name ASC')
  ])

  const folders = folderRows.map(mapFolder)
  const templates = templateRows.map(mapTemplate)
  const customFields = customFieldRows.map(mapCustomField)
  const variables = buildCatalog(customFields)

  return { folders, templates, customFields, variables }
}

export async function getVariableCatalog() {
  const rows = await db.all('SELECT * FROM whatsapp_template_custom_fields ORDER BY name ASC')
  return buildCatalog(rows.map(mapCustomField))
}

export async function previewMessageTemplate(payload = {}) {
  const normalized = normalizeTemplatePayload({
    ...payload,
    name: payload.name || 'preview_template',
    bodyText: payload.bodyText || 'Mensaje de ejemplo'
  })
  const variables = await getVariableCatalog()

  return {
    header: resolveText(normalized.headerText, normalized.variableExamples, variables),
    body: resolveText(normalized.bodyText, normalized.variableExamples, variables),
    footer: resolveText(normalized.footerText, normalized.variableExamples, variables),
    buttons: normalized.buttons.map((button) => ({
      ...button,
      label: resolveText(button.label, normalized.variableExamples, variables),
      value: resolveText(button.value, normalized.variableExamples, variables)
    })),
    variablesUsed: normalized.variables
  }
}

export async function createMessageTemplate(payload = {}) {
  const template = normalizeTemplatePayload(payload)
  await assertFolderExists(template.folderId)
  const id = makeId('tmpl')

  try {
    await db.run(`
      INSERT INTO whatsapp_message_templates (
        id, folder_id, name, description, category, language, status,
        header_enabled, header_type, header_text, header_media_url, header_location_json,
        body_text, footer_text, buttons_json, variables_json, variable_examples_json,
        ycloud_template_id, ycloud_status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      template.folderId,
      template.name,
      template.description,
      template.category,
      template.language,
      template.status,
      template.headerEnabled ? 1 : 0,
      template.headerType,
      template.headerText,
      template.headerMediaUrl,
      jsonString(template.headerLocation),
      template.bodyText,
      template.footerText,
      jsonString(template.buttons),
      jsonString(template.variables),
      jsonString(template.variableExamples),
      template.ycloudTemplateId,
      template.ycloudStatus
    ])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe una plantilla con ese nombre')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  return mapTemplate(row)
}

export async function updateMessageTemplate(id, payload = {}) {
  const existing = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  if (!existing) {
    const error = new Error('Plantilla no encontrada')
    error.statusCode = 404
    throw error
  }

  const template = normalizeTemplatePayload(payload)
  await assertFolderExists(template.folderId)

  try {
    await db.run(`
      UPDATE whatsapp_message_templates SET
        folder_id = ?,
        name = ?,
        description = ?,
        category = ?,
        language = ?,
        status = ?,
        header_enabled = ?,
        header_type = ?,
        header_text = ?,
        header_media_url = ?,
        header_location_json = ?,
        body_text = ?,
        footer_text = ?,
        buttons_json = ?,
        variables_json = ?,
        variable_examples_json = ?,
        ycloud_template_id = ?,
        ycloud_status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      template.folderId,
      template.name,
      template.description,
      template.category,
      template.language,
      template.status,
      template.headerEnabled ? 1 : 0,
      template.headerType,
      template.headerText,
      template.headerMediaUrl,
      jsonString(template.headerLocation),
      template.bodyText,
      template.footerText,
      jsonString(template.buttons),
      jsonString(template.variables),
      jsonString(template.variableExamples),
      template.ycloudTemplateId,
      template.ycloudStatus,
      id
    ])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe una plantilla con ese nombre')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  return mapTemplate(row)
}

export async function deleteMessageTemplate(id) {
  const result = await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [id])
  return { deleted: result.changes > 0 }
}

export async function createTemplateFolder(payload = {}) {
  const name = clampText(payload.name, 80)
  if (!name) {
    throw new Error('El nombre de la carpeta es obligatorio')
  }

  const parentId = normalizeOptionalString(payload.parentId)
  if (parentId) {
    const parent = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [parentId])
    if (!parent) throw new Error('La carpeta padre no existe')
  }

  const id = makeId('tmpl_folder')
  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0

  await db.run(`
    INSERT INTO whatsapp_template_folders (id, name, parent_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [id, name, parentId, sortOrder])

  const row = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  return mapFolder(row)
}

function collectDescendantFolderIds(folders, rootId) {
  const ids = new Set([rootId])
  let changed = true

  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parent_id && ids.has(folder.parent_id) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }

  return Array.from(ids)
}

export async function updateTemplateFolder(id, payload = {}) {
  const existing = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  if (!existing) {
    const error = new Error('Carpeta no encontrada')
    error.statusCode = 404
    throw error
  }

  const name = clampText(payload.name, 80)
  if (!name) throw new Error('El nombre de la carpeta es obligatorio')

  const parentId = normalizeOptionalString(payload.parentId)
  if (parentId === id) throw new Error('Una carpeta no puede estar dentro de sí misma')

  if (parentId) {
    const folders = await db.all('SELECT id, parent_id FROM whatsapp_template_folders')
    const descendants = collectDescendantFolderIds(folders, id)
    if (descendants.includes(parentId)) {
      throw new Error('No puedes mover una carpeta dentro de una subcarpeta propia')
    }
    const parent = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [parentId])
    if (!parent) throw new Error('La carpeta padre no existe')
  }

  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : Number(existing.sort_order || 0)

  await db.run(`
    UPDATE whatsapp_template_folders
    SET name = ?, parent_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [name, parentId, sortOrder, id])

  const row = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  return mapFolder(row)
}

export async function deleteTemplateFolder(id) {
  const existing = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [id])
  if (!existing) return { deleted: false, releasedTemplates: 0 }

  const folders = await db.all('SELECT id, parent_id FROM whatsapp_template_folders')
  const ids = collectDescendantFolderIds(folders, id)
  if (!ids.length) return { deleted: false, releasedTemplates: 0 }

  let releasedTemplates = 0
  for (const folderId of ids) {
    const result = await db.run(
      'UPDATE whatsapp_message_templates SET folder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?',
      [folderId]
    )
    releasedTemplates += Number(result.changes || 0)
  }

  for (const folderId of ids.reverse()) {
    await db.run('DELETE FROM whatsapp_template_folders WHERE id = ?', [folderId])
  }

  return { deleted: true, releasedTemplates }
}

export async function createTemplateCustomField(payload = {}) {
  const name = clampText(payload.name, 80)
  if (!name) throw new Error('El nombre del campo personalizado es obligatorio')

  const fieldKey = normalizeFieldKey(payload.fieldKey || name)
  const id = makeId('tmpl_field')
  const mergeField = `{{contact.custom.${fieldKey}}}`
  const example = clampText(payload.example, 140)
  const dataType = normalizeKey(payload.dataType) || 'text'

  try {
    await db.run(`
      INSERT INTO whatsapp_template_custom_fields (
        id, name, field_key, merge_field, example, data_type, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [id, name, fieldKey, mergeField, example, dataType])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe un campo personalizado con esa llave')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_template_custom_fields WHERE id = ?', [id])
  return mapCustomField(row)
}

export async function deleteTemplateCustomField(id) {
  const result = await db.run('DELETE FROM whatsapp_template_custom_fields WHERE id = ?', [id])
  return { deleted: result.changes > 0 }
}
