import { db } from '../config/database.js'
import {
  LEGACY_SYSTEM_TAG_ALIASES,
  getSystemTagDefinitions,
  SYSTEM_TAGS,
  normalizeTagName
} from './contactTagsService.js'

const REVIEW_OK = {
  state: 'ok',
  issueCount: 0,
  summary: '',
  issues: []
}

const FORM_FIELD_BLOCK_TYPES = new Set([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])

const STANDARD_CONTACT_FIELDS = new Set([
  'firstName',
  'lastName',
  'phone',
  'email',
  'source',
  'assignedUser',
  'stage',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'lastChannel',
  'name',
  'full_name',
  'first_name',
  'last_name'
])

const TRIGGER_LINK_WAIT_ACTIONS = new Set(['click_link', 'trigger_link_click', 'trigger-link-click'])

const CATALOG_LABELS = {
  tags: { article: 'La', noun: 'etiqueta', replacement: 'otra etiqueta' },
  customFields: { article: 'El', noun: 'campo personalizado', replacement: 'otro campo personalizado' },
  contactFields: { article: 'El', noun: 'campo del contacto', replacement: 'otro campo del contacto' },
  forms: { article: 'El', noun: 'formulario', replacement: 'otro formulario' },
  formFields: { article: 'La', noun: 'pregunta del formulario', replacement: 'otra pregunta' },
  calendars: { article: 'El', noun: 'calendario', replacement: 'otro calendario' },
  users: { article: 'El', noun: 'usuario', replacement: 'otro usuario' },
  links: { article: 'El', noun: 'clic de disparo', replacement: 'otro clic de disparo' },
  whatsappNumbers: { article: 'El', noun: 'numero de WhatsApp', replacement: 'otro numero de WhatsApp' },
  whatsappTemplates: { article: 'La', noun: 'plantilla de WhatsApp', replacement: 'otra plantilla de WhatsApp' }
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function normalizeFieldKey(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

async function tableExists(tableName) {
  try {
    if (process.env.DATABASE_URL) {
      const row = await db.get(
        `SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ?
        ) AS exists`,
        [tableName]
      )
      return Boolean(row?.exists)
    }

    const row = await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    )
    return Boolean(row)
  } catch {
    return false
  }
}

async function safeRows(tableName, sql, params = []) {
  if (!await tableExists(tableName)) return []
  try {
    return await db.all(sql, params)
  } catch {
    return []
  }
}

function importedFormId(siteId, formId) {
  const site = cleanString(siteId)
  const form = cleanString(formId)
  return site && form ? `${site}:imported:${form}` : ''
}

function inlineFormId(siteId, blockId) {
  const site = cleanString(siteId)
  const block = cleanString(blockId)
  return site && block ? `${site}:form_embed:${block}` : ''
}

function mapNativeBlockField(block = {}) {
  const settings = block.settings || {}
  const label = cleanString(
    block.label ||
      settings.customFieldLabel ||
      settings.custom_field_label ||
      settings.internalName ||
      block.id
  )
  const key = normalizeFieldKey(
    settings.customFieldKey ||
      settings.custom_field_key ||
      settings.internalName ||
      settings.internal_name ||
      settings.systemFieldKey ||
      settings.system_field_key ||
      block.id
  )
  return { id: key || cleanString(block.id), label }
}

function mapImportedField(field = {}) {
  const id = cleanString(
    field.sourceName ||
      field.source_name ||
      field.fieldId ||
      field.field_id ||
      field.destinationKey ||
      field.destination_key ||
      field.label
  )
  return { id, label: cleanString(field.label || id) }
}

function addFormField(formFieldsByFormId, formId, field) {
  const cleanFormId = cleanString(formId)
  const cleanFieldId = cleanString(field?.id)
  if (!cleanFormId) return
  if (!formFieldsByFormId.has(cleanFormId)) formFieldsByFormId.set(cleanFormId, new Set())
  if (cleanFieldId) formFieldsByFormId.get(cleanFormId).add(cleanFieldId)
}

async function loadFormReferences() {
  const formIds = new Set()
  const formFieldsByFormId = new Map()

  const sites = await safeRows(
    'public_sites',
    `SELECT id, name, site_type, status
     FROM public_sites
     WHERE COALESCE(status, 'draft') != 'archived'`
  )
  const activeSiteIds = new Set(sites.map((site) => cleanString(site.id)).filter(Boolean))
  const siteById = new Map(sites.map((site) => [cleanString(site.id), site]))

  sites
    .filter((site) => cleanString(site.site_type).includes('form'))
    .forEach((site) => formIds.add(cleanString(site.id)))

  const blockRows = await safeRows(
    'public_site_blocks',
    `SELECT id, site_id, block_type, label, settings_json
     FROM public_site_blocks
     ORDER BY sort_order ASC, created_at ASC`
  )

  for (const row of blockRows) {
    const siteId = cleanString(row.site_id)
    if (!activeSiteIds.has(siteId)) continue

    if (row.block_type === 'form_embed') {
      const settings = parseJson(row.settings_json, {})
      const embeddedSiteId = cleanString(
        settings.embeddedSiteId ||
          settings.embedded_site_id ||
          settings.formSiteId ||
          settings.form_site_id
      )
      const id = embeddedSiteId && siteById.has(embeddedSiteId)
        ? embeddedSiteId
        : inlineFormId(siteId, row.id)
      if (id) formIds.add(id)

      const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks : []
      embeddedBlocks
        .filter((block) => FORM_FIELD_BLOCK_TYPES.has(block?.blockType))
        .forEach((block) => addFormField(formFieldsByFormId, id, mapNativeBlockField(block)))
      continue
    }

    if (FORM_FIELD_BLOCK_TYPES.has(row.block_type)) {
      formIds.add(siteId)
      addFormField(formFieldsByFormId, siteId, mapNativeBlockField({
        id: row.id,
        blockType: row.block_type,
        label: row.label,
        settings: parseJson(row.settings_json, {})
      }))
    }
  }

  const importRows = await safeRows(
    'public_site_imports',
    `SELECT site_id, form_mappings_json
     FROM public_site_imports`
  )

  for (const row of importRows) {
    const siteId = cleanString(row.site_id)
    if (!activeSiteIds.has(siteId)) continue

    const mappings = parseJson(row.form_mappings_json, [])
    if (!Array.isArray(mappings) || mappings.length === 0) {
      formIds.add(siteId)
      continue
    }

    for (const mapping of mappings) {
      const formId = importedFormId(siteId, mapping?.formId || mapping?.form_id) || siteId
      formIds.add(formId)
      asArray(mapping?.fields)
        .map((field) => mapImportedField(field))
        .forEach((field) => addFormField(formFieldsByFormId, formId, field))
    }
  }

  return { formIds, formFieldsByFormId }
}

export async function loadAutomationReferenceCatalogs() {
  const [
    tagRows,
    customFieldRows,
    userRows,
    calendarRows,
    linkRows,
    whatsappNumberRows,
    whatsappTemplateRows,
    formReferences
  ] = await Promise.all([
    safeRows('contact_tags', 'SELECT id, name FROM contact_tags'),
    safeRows(
      'contact_custom_field_definitions',
      `SELECT id, field_key, label
       FROM contact_custom_field_definitions
       WHERE COALESCE(archived, 0) = 0`
    ),
    safeRows(
      'users',
      `SELECT id
       FROM users
       WHERE COALESCE(is_active, 1) = 1`
    ),
    safeRows(
      'calendars',
      `SELECT id, ghl_calendar_id
       FROM calendars
       WHERE COALESCE(is_active, 1) != 0`
    ),
    safeRows(
      'trigger_links',
      `SELECT id, public_id
       FROM trigger_links
       WHERE COALESCE(archived, 0) = 0`
    ),
    safeRows('whatsapp_api_phone_numbers', 'SELECT id FROM whatsapp_api_phone_numbers'),
    safeRows(
      'whatsapp_api_templates',
      `SELECT id, official_template_id
       FROM whatsapp_api_templates
       WHERE UPPER(COALESCE(status, '')) = 'APPROVED'`
    ),
    loadFormReferences()
  ])

  const customSystemTags = await getSystemTagDefinitions()
  const tags = new Set(SYSTEM_TAGS.map((tag) => tag.id))
  const tagNames = new Set(customSystemTags.map((tag) => normalizeTagName(tag.name)))
  Object.keys(LEGACY_SYSTEM_TAG_ALIASES).forEach((alias) => tags.add(alias))
  tagRows.forEach((row) => {
    if (row.id) tags.add(cleanString(row.id))
    if (row.name) tagNames.add(normalizeTagName(row.name))
  })

  const customFields = new Set()
  customFieldRows.forEach((row) => {
    const key = cleanString(row.field_key)
    if (!key) return
    customFields.add(key)
    customFields.add(normalizeFieldKey(key))
    customFields.add(`custom:${key}`)
    customFields.add(`custom:${normalizeFieldKey(key)}`)
  })

  return {
    tags,
    tagNames,
    customFields,
    users: new Set(userRows.map((row) => cleanString(row.id)).filter(Boolean)),
    calendars: new Set(calendarRows.flatMap((row) => [row.id, row.ghl_calendar_id]).map(cleanString).filter(Boolean)),
    links: new Set(linkRows.flatMap((row) => [row.id, row.public_id]).map(cleanString).filter(Boolean)),
    whatsappNumbers: new Set(whatsappNumberRows.map((row) => cleanString(row.id)).filter(Boolean)),
    whatsappTemplates: new Set(whatsappTemplateRows.flatMap((row) => [row.id, row.official_template_id]).map(cleanString).filter(Boolean)),
    forms: formReferences.formIds,
    formFieldsByFormId: formReferences.formFieldsByFormId
  }
}

function hasReference(catalogs, catalog, value) {
  const clean = cleanString(value)
  if (!clean) return true

  if (catalog === 'tags') {
    return catalogs.tags.has(clean) || catalogs.tagNames.has(normalizeTagName(clean))
  }

  if (catalog === 'contactFields') {
    if (STANDARD_CONTACT_FIELDS.has(clean)) return true
    if (clean.startsWith('custom:')) return catalogs.customFields.has(clean)
    return true
  }

  return catalogs[catalog]?.has(clean) ?? true
}

function issueMessage(catalog, label) {
  const item = CATALOG_LABELS[catalog] || { article: 'El', noun: 'recurso', replacement: 'otro recurso' }
  return `${item.article} ${item.noun} "${label}" ya no existe. Selecciona ${item.replacement}.`
}

function createIssue({ issues, seen, nodeId, triggerId = '', catalog, fieldPath, value, label }) {
  const cleanValue = cleanString(value)
  if (!cleanValue) return
  const cleanLabel = cleanString(label) || cleanValue
  const id = [nodeId || 'flow', triggerId, catalog, fieldPath, cleanValue].filter(Boolean).join(':')
  if (seen.has(id)) return
  seen.add(id)
  issues.push({
    id,
    nodeId: nodeId || null,
    triggerId: triggerId || null,
    catalog,
    fieldPath,
    value: cleanValue,
    label: cleanLabel,
    message: issueMessage(catalog, cleanLabel)
  })
}

function addCatalogIssue({ catalogs, issues, seen, nodeId, triggerId, catalog, fieldPath, value, label }) {
  if (!cleanString(value)) return
  if (hasReference(catalogs, catalog, value)) return
  createIssue({ issues, seen, nodeId, triggerId, catalog, fieldPath, value, label })
}

function addFormFieldIssue({ catalogs, issues, seen, nodeId, triggerId, formId, fieldPath, value, label }) {
  const cleanFormId = cleanString(formId)
  const cleanValue = cleanString(value)
  if (!cleanFormId || !cleanValue) return
  const fields = catalogs.formFieldsByFormId.get(cleanFormId)
  if (!fields || fields.has(cleanValue)) return
  createIssue({
    issues,
    seen,
    nodeId,
    triggerId,
    catalog: 'formFields',
    fieldPath,
    value: cleanValue,
    label: label || cleanValue
  })
}

function collectValueList(value) {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean)
  const clean = cleanString(value)
  return clean ? [clean] : []
}

function inspectTriggerFilters({ filters, catalogs, issues, seen, nodeId, triggerId, selectedFormId = '' }) {
  asArray(filters).forEach((filter, index) => {
    if (!isRecord(filter)) return
    const field = cleanString(filter.field)
    const fieldPath = `filters.${index}`

    if (field === 'custom') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'customFields',
        fieldPath: `${fieldPath}.customKey`,
        value: filter.customKey,
        label: filter.customLabel
      })
    }

    if (field === 'form_field') {
      addFormFieldIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        formId: selectedFormId,
        fieldPath: `${fieldPath}.customKey`,
        value: filter.customKey,
        label: filter.customLabel
      })
    }

    if (field === 'form-specific') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'forms',
        fieldPath: `${fieldPath}.value`,
        value: filter.value,
        label: filter.valueLabel
      })
    }

    if (field === 'tag') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'tags',
        fieldPath: `${fieldPath}.value`,
        value: filter.value,
        label: filter.valueLabel
      })
    }

    if (field === 'calendar' || field === 'active_appointment_calendar') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'calendars',
        fieldPath: `${fieldPath}.value`,
        value: filter.value,
        label: filter.valueLabel
      })
    }

    if (field === 'assigned' || field === 'active_appointment_assigned') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'users',
        fieldPath: `${fieldPath}.value`,
        value: filter.value,
        label: filter.valueLabel
      })
    }

    if (field === 'preferred_whatsapp_number') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        triggerId,
        catalog: 'whatsappNumbers',
        fieldPath: `${fieldPath}.value`,
        value: filter.value,
        label: filter.valueLabel
      })
    }
  })
}

function inspectConditionRules({ value, catalogs, issues, seen, nodeId, prefix = 'conditions' }) {
  const visitRule = (rule, fieldPath) => {
    if (!isRecord(rule)) return
    const field = cleanString(rule.field)

    if (field === 'contact-custom-field') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'customFields',
        fieldPath: `${fieldPath}.customKey`,
        value: rule.customKey,
        label: rule.customLabel
      })
    }

    if (field.startsWith('tag-')) {
      collectValueList(rule.value).forEach((tagValue) => addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'tags',
        fieldPath: `${fieldPath}.value`,
        value: tagValue,
        label: rule.valueLabel
      }))
    }

    if (field === 'appt-calendar') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'calendars',
        fieldPath: `${fieldPath}.value`,
        value: rule.value,
        label: rule.valueLabel
      })
    }

    if (field === 'contact-assigned-user' || field === 'active_appointment_assigned') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'users',
        fieldPath: `${fieldPath}.value`,
        value: rule.value,
        label: rule.valueLabel
      })
    }

    if (field === 'form-specific') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'forms',
        fieldPath: `${fieldPath}.value`,
        value: rule.value,
        label: rule.valueLabel
      })
    }

    if (field === 'link-specific') {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId,
        catalog: 'links',
        fieldPath: `${fieldPath}.value`,
        value: rule.value,
        label: rule.valueLabel
      })
    }
  }

  const visit = (item, path) => {
    if (!isRecord(item)) return
    asArray(item.rules).forEach((rule, index) => visitRule(rule, `${path}.rules.${index}`))
    asArray(item.groups).forEach((group, index) => visit(group, `${path}.groups.${index}`))
    asArray(item.branches).forEach((branch, index) => visit(branch, `${path}.branches.${index}`))
  }

  visit(value, prefix)
}

function inspectMessageBlocks({ node, catalogs, issues, seen }) {
  asArray(node.config?.messageBlocks).forEach((block, index) => {
    if (!isRecord(block) || cleanString(block.type) !== 'template') return
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'whatsappTemplates',
      fieldPath: `messageBlocks.${index}.templateId`,
      value: block.templateId,
      label: block.templateName
    })
  })
}

function inspectNodeConfig({ node, catalogs, issues, seen }) {
  const config = isRecord(node.config) ? node.config : {}

  if (cleanString(config.tag)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'tags',
      fieldPath: 'tag',
      value: config.tag,
      label: config.tagName
    })
  }

  collectValueList(config.tags).forEach((tagValue) => addCatalogIssue({
    catalogs,
    issues,
    seen,
    nodeId: node.id,
    catalog: 'tags',
    fieldPath: 'tags',
    value: tagValue
  }))

  if (cleanString(config.field)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'contactFields',
      fieldPath: 'field',
      value: config.field,
      label: config.fieldName
    })
  }

  asArray(config.customFields).forEach((row, index) => {
    if (!isRecord(row)) return
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'customFields',
      fieldPath: `customFields.${index}.key`,
      value: row.key,
      label: row.keyName
    })
  })

  for (const key of ['calendar', 'assignedUser', 'user', 'phoneNumberId', 'senderNumberId']) {
    const catalog = key === 'calendar'
      ? 'calendars'
      : key === 'phoneNumberId' || key === 'senderNumberId'
        ? 'whatsappNumbers'
        : 'users'
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog,
      fieldPath: key,
      value: config[key],
      label: config[`${key}Name`] || config[`${key}Label`]
    })
  }

  if (cleanString(config.form)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'forms',
      fieldPath: 'form',
      value: config.form,
      label: config.formName
    })
  }

  if (cleanString(config.link)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'links',
      fieldPath: 'link',
      value: config.link,
      label: config.linkName
    })
  }

  if (
    cleanString(config.mode) === 'action' &&
    TRIGGER_LINK_WAIT_ACTIONS.has(cleanString(config.expectedAction) || 'click_link')
  ) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'links',
      fieldPath: 'actionResource',
      value: config.actionResource || config.link || config.triggerLinkId,
      label: config.actionResourceName || config.linkName
    })
  }

  if (cleanString(config.templateId)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: node.id,
      catalog: 'whatsappTemplates',
      fieldPath: 'templateId',
      value: config.templateId,
      label: config.templateName
    })
  }

  if (cleanString(config.goalType) === 'advanced') {
    inspectConditionRules({ value: config.advancedCondition, catalogs, issues, seen, nodeId: node.id, prefix: 'advancedCondition' })
  } else {
    inspectConditionRules({ value: config.conditions, catalogs, issues, seen, nodeId: node.id, prefix: 'conditions' })
  }

  inspectMessageBlocks({ node, catalogs, issues, seen })
}

function inspectStartTriggers({ startNode, catalogs, issues, seen }) {
  const triggers = asArray(startNode?.config?.triggers)
  triggers.forEach((trigger, index) => {
    if (!isRecord(trigger)) return
    const config = isRecord(trigger.config) ? trigger.config : {}
    const triggerId = cleanString(trigger.id) || `trigger-${index}`
    const fieldPathPrefix = `triggers.${index}.config`

    if (cleanString(config.tag)) {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId: startNode.id,
        triggerId,
        catalog: 'tags',
        fieldPath: `${fieldPathPrefix}.tag`,
        value: config.tag,
        label: config.tagName
      })
    }

    if (cleanString(config.form)) {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId: startNode.id,
        triggerId,
        catalog: 'forms',
        fieldPath: `${fieldPathPrefix}.form`,
        value: config.form,
        label: config.formName
      })
    }

    if (cleanString(config.calendar)) {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId: startNode.id,
        triggerId,
        catalog: 'calendars',
        fieldPath: `${fieldPathPrefix}.calendar`,
        value: config.calendar,
        label: config.calendarName
      })
    }

    if (cleanString(config.assignedUser)) {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId: startNode.id,
        triggerId,
        catalog: 'users',
        fieldPath: `${fieldPathPrefix}.assignedUser`,
        value: config.assignedUser,
        label: config.assignedUserName
      })
    }

    if (cleanString(config.link || config.triggerLinkId)) {
      addCatalogIssue({
        catalogs,
        issues,
        seen,
        nodeId: startNode.id,
        triggerId,
        catalog: 'links',
        fieldPath: `${fieldPathPrefix}.link`,
        value: config.link || config.triggerLinkId,
        label: config.linkName
      })
    }

    inspectTriggerFilters({
      filters: config.filters,
      catalogs,
      issues,
      seen,
      nodeId: startNode.id,
      triggerId,
      selectedFormId: config.form
    })
  })
}

function buildReviewStatus(issues) {
  if (!issues.length) return REVIEW_OK
  const first = issues[0]?.message || 'Hay referencias que ya no existen.'
  const extra = issues.length > 1 ? ` +${issues.length - 1} mas` : ''
  return {
    state: 'requires_review',
    issueCount: issues.length,
    summary: `${first}${extra}`,
    issues
  }
}

export function getAutomationReviewStatus(flow, catalogs) {
  if (!flow || !catalogs) return REVIEW_OK
  const nodes = asArray(flow.nodes)
  const issues = []
  const seen = new Set()
  const startNode = nodes.find((node) => node?.type === 'start')

  if (startNode) inspectStartTriggers({ startNode, catalogs, issues, seen })
  nodes
    .filter((node) => node && node.type !== 'start')
    .forEach((node) => inspectNodeConfig({ node, catalogs, issues, seen }))

  const settings = isRecord(flow.settings) ? flow.settings : {}
  const defaultSenders = isRecord(settings.defaultSenders) ? settings.defaultSenders : {}
  if (cleanString(defaultSenders.whatsappSenderId)) {
    addCatalogIssue({
      catalogs,
      issues,
      seen,
      nodeId: null,
      catalog: 'whatsappNumbers',
      fieldPath: 'settings.defaultSenders.whatsappSenderId',
      value: defaultSenders.whatsappSenderId
    })
  }

  return buildReviewStatus(issues)
}

function parseFlow(rawFlow) {
  if (!rawFlow) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  if (typeof rawFlow === 'object') return rawFlow
  try {
    return JSON.parse(rawFlow)
  } catch {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  }
}

export async function listAutomationReviewProblems({ limit = 20 } = {}) {
  const rows = await safeRows(
    'automations',
    `SELECT id, name, status, flow, published_flow, published_at, updated_at
     FROM automations
     WHERE status IN ('published', 'paused')
     ORDER BY updated_at DESC, created_at DESC`
  )
  if (!rows.length) return []

  const catalogs = await loadAutomationReferenceCatalogs()
  return rows
    .map((row) => {
      const status = getAutomationReviewStatus(parseFlow(row.published_flow || row.flow), catalogs)
      return { automation: row, reviewStatus: status }
    })
    .filter((item) => item.reviewStatus.state === 'requires_review')
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
}

export const AUTOMATION_REVIEW_OK = REVIEW_OK
