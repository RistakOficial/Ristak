import crypto from 'crypto'
import { db } from '../config/database.js'
import {
  createWhatsAppApiTemplate,
  retrieveWhatsAppApiTemplate,
  sendWhatsAppApiTemplateMessage,
  syncWhatsAppApiTemplatesFromYCloud
} from './whatsappApiService.js'

const TEMPLATE_CATEGORIES = new Set(['utility', 'marketing', 'authentication', 'service'])
const TEMPLATE_STATUSES = new Set(['draft', 'active', 'archived'])
const HEADER_TYPES = new Set(['none', 'text', 'image', 'video', 'document', 'location'])
const BUTTON_TYPES = new Set(['quick_reply', 'website', 'phone', 'whatsapp_call'])
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g
const NUMERIC_VARIABLE_PATTERN = /{{\s*(\d+)\s*}}/g
const TEXT_VARIABLE_TARGETS = new Set(['headerText', 'bodyText'])

const BASE_CONTACT_VARIABLES = [
  ['Full Name', 'contact.name', 'Jane Smith'],
  ['First Name', 'contact.first_name', 'Jane'],
  ['Last Name', 'contact.last_name', 'Smith'],
  ['Email', 'contact.email', 'jane@smith.com'],
  ['Phone', 'contact.phone', '(515) 555-2345'],
  ['Phone Raw Format', 'contact.phone_raw', '+15155552345'],
  ['Company Name', 'contact.company_name', 'Smith Plumbing'],
  ['Full Address', 'contact.full_address', '1234 W. Main St, Chicago, IL 60657'],
  ['Address Line 1', 'contact.address1', '1234 W. Main St'],
  ['City', 'contact.city', 'Chicago'],
  ['State/Region', 'contact.state', 'Illinois'],
  ['Postal Code', 'contact.postal_code', '60657'],
  ['Time Zone', 'contact.timezone', 'GMT-06:00 America/Chicago'],
  ['Date Of Birth', 'contact.date_of_birth', 'Jan 3, 1980'],
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

function normalizeVariableBindings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const normalized = {}

  for (const target of TEXT_VARIABLE_TARGETS) {
    const targetSource = source[target] && typeof source[target] === 'object' && !Array.isArray(source[target])
      ? source[target]
      : {}
    const entries = {}

    for (const [index, binding] of Object.entries(targetSource)) {
      const variableIndex = cleanString(index).replace(/\D/g, '')
      if (!variableIndex) continue

      const bindingSource = binding && typeof binding === 'object' && !Array.isArray(binding) ? binding : {}
      entries[variableIndex] = {
        variableKey: clampText(bindingSource.variableKey, 120),
        mergeField: clampText(bindingSource.mergeField, 160),
        label: clampText(bindingSource.label, 120),
        example: clampText(bindingSource.example, 140)
      }
    }

    normalized[target] = entries
  }

  return normalized
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

function extractNumericVariableIndexes(text) {
  const indexes = new Set()
  const content = cleanString(text)
  if (!content) return []

  for (const match of content.matchAll(NUMERIC_VARIABLE_PATTERN)) {
    const index = Number(match[1])
    if (Number.isInteger(index) && index > 0) indexes.add(index)
  }

  return Array.from(indexes).sort((left, right) => left - right)
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
    variableBindings: normalizeVariableBindings(payload.variableBindings),
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
    variableBindings: parseJson(row.variable_bindings_json, { headerText: {}, bodyText: {} }),
    ycloudTemplateId: row.ycloud_template_id || null,
    ycloudStatus: row.ycloud_status || null,
    ycloudReason: row.ycloud_reason || null,
    ycloudStatusUpdateEvent: row.ycloud_status_update_event || null,
    ycloudQualityRating: row.ycloud_quality_rating || null,
    ycloudRawPayload: parseJson(row.ycloud_raw_payload_json, null),
    ycloudSubmittedAt: row.ycloud_submitted_at || null,
    ycloudSyncedAt: row.ycloud_synced_at || null,
    lastError: row.last_error || null,
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

function getTemplateErrorMessage(error, fallback) {
  const ycloudError = error?.ycloud?.error || error?.ycloud
  return cleanString(
    ycloudError?.error_user_msg ||
    ycloudError?.error_data ||
    ycloudError?.message ||
    error?.message
  ) || fallback
}

function normalizeYCloudTemplateStatus(value) {
  const status = cleanString(value).toUpperCase()
  return status || null
}

function normalizeYCloudCategory(category) {
  const normalized = normalizeCategory(category).toUpperCase()
  if (normalized === 'SERVICE') return 'UTILITY'
  return normalized
}

function assertMetaVariableSyntax(text, label) {
  const content = cleanString(text)
  if (!content) return

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const key = cleanString(match[1])
    if (!/^\d+$/.test(key)) {
      throw new Error(`${label} usa ${match[0]}. Para Meta/YCloud las variables deben ser {{1}}, {{2}}, {{3}}.`)
    }
  }
}

function getVariableExamplesForTarget(template, target, label) {
  const indexes = extractNumericVariableIndexes(template[target])
  if (!indexes.length) return []

  indexes.forEach((index, position) => {
    if (index !== position + 1) {
      throw new Error(`${label} debe usar variables consecutivas empezando en {{1}}. Revisa {{${index}}}.`)
    }
  })

  const bindings = template.variableBindings?.[target] || {}
  return indexes.map((index) => {
    const binding = bindings[String(index)] || {}
    if (!cleanString(binding.variableKey) && !cleanString(binding.mergeField)) {
      throw new Error(`Selecciona el dato dinamico para {{${index}}} en ${label}.`)
    }
    if (!cleanString(binding.example)) {
      throw new Error(`Escribe el ejemplo que Meta revisara para {{${index}}} en ${label}.`)
    }
    return cleanString(binding.example)
  })
}

function buildYCloudButtons(buttons = []) {
  return buttons.map((button) => {
    const label = clampText(button.label, 25)
    if (!label) return null

    if (button.type === 'website') {
      const url = clampText(button.value, 2000)
      if (!url) throw new Error(`El boton ${label} necesita URL`)
      return { type: 'URL', text: label, url }
    }

    if (button.type === 'phone') {
      const phoneNumber = clampText(button.value, 20)
      if (!phoneNumber) throw new Error(`El boton ${label} necesita telefono`)
      return { type: 'PHONE_NUMBER', text: label, phone_number: phoneNumber }
    }

    if (button.type === 'whatsapp_call') {
      return { type: 'VOICE_CALL', text: label }
    }

    return { type: 'QUICK_REPLY', text: label }
  }).filter(Boolean)
}

function buildYCloudTemplatePayload(template) {
  assertMetaVariableSyntax(template.headerText, 'El encabezado')
  assertMetaVariableSyntax(template.bodyText, 'El cuerpo')

  const components = []

  if (template.headerEnabled && template.headerType !== 'none') {
    if (template.headerType === 'text') {
      const headerExamples = getVariableExamplesForTarget(template, 'headerText', 'el encabezado')
      if (headerExamples.length > 1) {
        throw new Error('Meta solo permite una variable en el encabezado de texto.')
      }

      const headerComponent = {
        type: 'HEADER',
        format: 'TEXT',
        text: template.headerText
      }
      if (headerExamples.length) {
        headerComponent.example = { header_text: headerExamples }
      }
      components.push(headerComponent)
    } else if (['image', 'video', 'document'].includes(template.headerType)) {
      if (!template.headerMediaUrl) {
        throw new Error('Agrega una URL de ejemplo para el archivo del encabezado.')
      }
      components.push({
        type: 'HEADER',
        format: template.headerType.toUpperCase(),
        example: { header_url: [template.headerMediaUrl] }
      })
    } else if (template.headerType === 'location') {
      components.push({
        type: 'HEADER',
        format: 'LOCATION'
      })
    }
  }

  const bodyExamples = getVariableExamplesForTarget(template, 'bodyText', 'el cuerpo')
  const bodyComponent = {
    type: 'BODY',
    text: template.bodyText
  }
  if (bodyExamples.length) {
    bodyComponent.example = { body_text: [bodyExamples] }
  }
  components.push(bodyComponent)

  if (template.footerText) {
    components.push({
      type: 'FOOTER',
      text: template.footerText
    })
  }

  const buttons = buildYCloudButtons(template.buttons)
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons
    })
  }

  return {
    name: template.name,
    language: template.language,
    category: normalizeYCloudCategory(template.category),
    components
  }
}

function normalizeYCloudTemplateResponse(record = {}) {
  return {
    officialTemplateId: cleanString(record.officialTemplateId || record.id) || null,
    status: normalizeYCloudTemplateStatus(record.status),
    reason: cleanString(record.reason || record.whatsappApiError?.error_user_msg || record.whatsappApiError?.message || record.whatsappApiError?.error_data) || null,
    statusUpdateEvent: normalizeYCloudTemplateStatus(record.statusUpdateEvent),
    qualityRating: normalizeYCloudTemplateStatus(record.qualityRating),
    raw: record
  }
}

async function getMessageTemplateById(id) {
  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  if (!row) {
    const error = new Error('Plantilla no encontrada')
    error.statusCode = 404
    throw error
  }
  return mapTemplate(row)
}

async function applyYCloudTemplateResponse(id, record = {}, { submitted = false } = {}) {
  const normalized = normalizeYCloudTemplateResponse(record)
  await db.run(`
    UPDATE whatsapp_message_templates
    SET
      ycloud_template_id = COALESCE(?, ycloud_template_id),
      ycloud_status = COALESCE(?, ycloud_status),
      ycloud_reason = ?,
      ycloud_status_update_event = ?,
      ycloud_quality_rating = ?,
      ycloud_raw_payload_json = ?,
      ycloud_submitted_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE ycloud_submitted_at END,
      ycloud_synced_at = CURRENT_TIMESTAMP,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    normalized.officialTemplateId,
    normalized.status,
    normalized.reason,
    normalized.statusUpdateEvent,
    normalized.qualityRating,
    jsonString(normalized.raw),
    submitted ? 1 : 0,
    id
  ])

  return getMessageTemplateById(id)
}

async function saveTemplateLastError(id, error) {
  const message = getTemplateErrorMessage(error, 'YCloud rechazo la solicitud')
  await db.run(`
    UPDATE whatsapp_message_templates
    SET last_error = ?, ycloud_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [message, id])
  return message
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
        variable_bindings_json, ycloud_template_id, ycloud_status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
      jsonString(template.variableBindings),
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
        variable_bindings_json = ?,
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
      jsonString(template.variableBindings),
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

export async function submitMessageTemplateToYCloud(id) {
  const template = await getMessageTemplateById(id)
  const ycloudPayload = buildYCloudTemplatePayload(template)

  try {
    const response = await createWhatsAppApiTemplate(ycloudPayload)
    return {
      template: await applyYCloudTemplateResponse(id, response, { submitted: true }),
      ycloud: response,
      message: 'Plantilla enviada a revision de Meta por YCloud.'
    }
  } catch (error) {
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
}

export async function syncMessageTemplateStatus(id) {
  const template = await getMessageTemplateById(id)

  try {
    const response = await retrieveWhatsAppApiTemplate({
      name: template.name,
      language: template.language
    })
    return {
      template: await applyYCloudTemplateResponse(id, response),
      ycloud: response,
      message: 'Estado sincronizado con YCloud.'
    }
  } catch (error) {
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
}

export async function syncAllMessageTemplatesWithYCloud() {
  await syncWhatsAppApiTemplatesFromYCloud()
  return getMessageTemplateBundle()
}

function buildSendComponentsFromTemplate(template) {
  const components = []
  const headerExamples = getVariableExamplesForTarget(template, 'headerText', 'el encabezado')
  if (headerExamples.length) {
    components.push({
      type: 'header',
      parameters: headerExamples.map((example) => ({ type: 'text', text: example }))
    })
  }

  const bodyExamples = getVariableExamplesForTarget(template, 'bodyText', 'el cuerpo')
  if (bodyExamples.length) {
    components.push({
      type: 'body',
      parameters: bodyExamples.map((example) => ({ type: 'text', text: example }))
    })
  }

  return components
}

export async function sendMessageTemplateTest(id, payload = {}) {
  const template = await getMessageTemplateById(id)
  if (normalizeYCloudTemplateStatus(template.ycloudStatus) !== 'APPROVED') {
    throw new Error('Meta/YCloud todavia no aprobaron esta plantilla. Solo se pueden enviar plantillas APPROVED.')
  }

  const to = cleanString(payload.to)
  if (!to) throw new Error('Escribe el numero destino para enviar la prueba')

  try {
    const response = await sendWhatsAppApiTemplateMessage({
      to,
      from: payload.from,
      templateName: template.name,
      language: template.language,
      components: buildSendComponentsFromTemplate(template),
      externalId: payload.externalId
    })
    return {
      sent: true,
      response,
      message: 'Plantilla enviada por WhatsApp Business.'
    }
  } catch (error) {
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
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
