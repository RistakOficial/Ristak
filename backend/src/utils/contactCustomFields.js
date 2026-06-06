const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (object, key) =>
  Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)

const cleanString = (value) => String(value || '').trim()

const pickValue = (raw = {}) => {
  if (hasOwn(raw, 'field_value')) return raw.field_value
  if (hasOwn(raw, 'fieldValue')) return raw.fieldValue
  if (hasOwn(raw, 'value')) return raw.value
  if (hasOwn(raw, 'val')) return raw.val
  return null
}

export function parseJsonSafe(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function hasContactCustomFieldsPayload(contact = {}) {
  return hasOwn(contact, 'customFields') ||
    hasOwn(contact, 'customField') ||
    hasOwn(contact, 'custom_fields')
}

export function normalizeCustomFieldDefinition(field = {}) {
  const id = cleanString(field.id || field._id || field.fieldId || field.customFieldId)
  const fieldKey = cleanString(field.fieldKey || field.key || field.field_key)
  const name = cleanString(field.name || field.label || field.title || field.placeholder || fieldKey || id)

  return {
    id,
    definitionId: cleanString(field.definitionId || field.definition_id),
    key: fieldKey || id,
    fieldKey: fieldKey || null,
    label: name || 'Campo personalizado',
    name: name || 'Campo personalizado',
    dataType: cleanString(field.dataType || field.type || field.inputType),
    placeholder: cleanString(field.placeholder),
    options: Array.isArray(field.picklistOptions)
      ? field.picklistOptions
      : Array.isArray(field.options)
        ? field.options
        : [],
    isAllowedCustomOption: Boolean(field.isAllowedCustomOption),
    model: field.model || 'contact',
    syncTarget: cleanString(field.syncTarget || field.sync_target),
    sourceType: cleanString(field.sourceType || field.source_type),
    sourceId: cleanString(field.sourceId || field.source_id),
    sourceSiteId: cleanString(field.sourceSiteId || field.source_site_id),
    sourcePageId: cleanString(field.sourcePageId || field.source_page_id),
    sourceFormId: cleanString(field.sourceFormId || field.source_form_id),
    sourceFormName: cleanString(field.sourceFormName || field.source_form_name),
    sourceFieldId: cleanString(field.sourceFieldId || field.source_field_id),
    sourceFieldName: cleanString(field.sourceFieldName || field.source_field_name),
    sourceLabel: cleanString(field.sourceLabel || field.source_label),
    sourceContext: field.sourceContext || field.source_context || null
  }
}

export function getContactCustomFieldValues(contact = {}) {
  const rawCustomFields = contact.customFields ?? contact.customField ?? contact.custom_fields

  if (Array.isArray(rawCustomFields)) {
    return rawCustomFields.map((field) => ({
      id: cleanString(field?.id || field?.fieldId || field?.customFieldId),
      definitionId: cleanString(field?.definitionId || field?.definition_id),
      key: cleanString(field?.key || field?.fieldKey || field?.field_key),
      fieldKey: cleanString(field?.fieldKey || field?.field_key || field?.key),
      label: cleanString(field?.label || field?.name || field?.title),
      name: cleanString(field?.name || field?.label || field?.title),
      dataType: cleanString(field?.dataType || field?.type || field?.inputType),
      options: Array.isArray(field?.options)
        ? field.options
        : Array.isArray(field?.picklistOptions)
          ? field.picklistOptions
          : [],
      value: pickValue(field || {}),
      syncTarget: cleanString(field?.syncTarget || field?.sync_target),
      sourceType: cleanString(field?.sourceType || field?.source_type),
      sourceId: cleanString(field?.sourceId || field?.source_id),
      sourceSiteId: cleanString(field?.sourceSiteId || field?.source_site_id),
      sourcePageId: cleanString(field?.sourcePageId || field?.source_page_id),
      sourceFormId: cleanString(field?.sourceFormId || field?.source_form_id),
      sourceFormName: cleanString(field?.sourceFormName || field?.source_form_name),
      sourceFieldId: cleanString(field?.sourceFieldId || field?.source_field_id),
      sourceFieldName: cleanString(field?.sourceFieldName || field?.source_field_name),
      sourceLabel: cleanString(field?.sourceLabel || field?.source_label),
      sourceContext: field?.sourceContext || field?.source_context || null
    }))
  }

  if (isPlainObject(rawCustomFields)) {
    return Object.entries(rawCustomFields).map(([key, value]) => {
      const field = isPlainObject(value) ? value : { value }
      return {
        id: cleanString(field.id || field.fieldId || field.customFieldId || key),
        definitionId: cleanString(field.definitionId || field.definition_id),
        key: cleanString(field.key || field.fieldKey || field.field_key || key),
        fieldKey: cleanString(field.fieldKey || field.field_key || field.key || key),
        label: cleanString(field.label || field.name || field.title || key),
        name: cleanString(field.name || field.label || field.title || key),
        dataType: cleanString(field.dataType || field.type || field.inputType),
        options: Array.isArray(field.options)
          ? field.options
          : Array.isArray(field.picklistOptions)
            ? field.picklistOptions
            : [],
        value: pickValue(field),
        syncTarget: cleanString(field.syncTarget || field.sync_target),
        sourceType: cleanString(field.sourceType || field.source_type),
        sourceId: cleanString(field.sourceId || field.source_id),
        sourceSiteId: cleanString(field.sourceSiteId || field.source_site_id),
        sourcePageId: cleanString(field.sourcePageId || field.source_page_id),
        sourceFormId: cleanString(field.sourceFormId || field.source_form_id),
        sourceFormName: cleanString(field.sourceFormName || field.source_form_name),
        sourceFieldId: cleanString(field.sourceFieldId || field.source_field_id),
        sourceFieldName: cleanString(field.sourceFieldName || field.source_field_name),
        sourceLabel: cleanString(field.sourceLabel || field.source_label),
        sourceContext: field.sourceContext || field.source_context || null
      }
    })
  }

  return []
}

function buildDefinitionLookup(definitions = []) {
  const lookup = new Map()

  for (const rawDefinition of definitions) {
    const definition = normalizeCustomFieldDefinition(rawDefinition)
    for (const key of [definition.id, definition.definitionId, definition.key, definition.fieldKey]) {
      if (key) lookup.set(key, definition)
    }
  }

  return lookup
}

export function normalizeContactCustomFields(contact = {}, definitions = []) {
  const values = getContactCustomFieldValues(contact)
  const definitionLookup = buildDefinitionLookup(definitions)

  return values
    .map((field, index) => {
      const definition = definitionLookup.get(field.id) ||
        definitionLookup.get(field.definitionId) ||
        definitionLookup.get(field.key) ||
        definitionLookup.get(field.fieldKey) ||
        null

      const id = field.id || definition?.id || ''
      const definitionId = field.definitionId || definition?.definitionId || ''
      const key = field.key || field.fieldKey || definition?.fieldKey || definition?.key || ''
      const label = definition?.label ||
        field.label ||
        field.name ||
        key ||
        id ||
        `Campo personalizado ${index + 1}`

      return {
        id,
        definitionId,
        key,
        fieldKey: definition?.fieldKey || field.fieldKey || key || null,
        label,
        name: definition?.name || field.name || label,
        dataType: definition?.dataType || field.dataType || null,
        value: field.value ?? null,
        options: definition?.options?.length ? definition.options : field.options || [],
        model: definition?.model || field.model || 'contact',
        syncTarget: field.syncTarget || definition?.syncTarget || null,
        sourceType: field.sourceType || definition?.sourceType || null,
        sourceId: field.sourceId || definition?.sourceId || null,
        sourceSiteId: field.sourceSiteId || definition?.sourceSiteId || null,
        sourcePageId: field.sourcePageId || definition?.sourcePageId || null,
        sourceFormId: field.sourceFormId || definition?.sourceFormId || null,
        sourceFormName: field.sourceFormName || definition?.sourceFormName || null,
        sourceFieldId: field.sourceFieldId || definition?.sourceFieldId || null,
        sourceFieldName: field.sourceFieldName || definition?.sourceFieldName || null,
        sourceLabel: field.sourceLabel || definition?.sourceLabel || null,
        sourceContext: field.sourceContext || definition?.sourceContext || null
      }
    })
    .filter((field) => field.id || field.key || field.label)
}

export function parseContactCustomFields(value) {
  const parsed = parseJsonSafe(value, [])

  if (Array.isArray(parsed)) {
    return normalizeContactCustomFields({ customFields: parsed })
  }

  if (isPlainObject(parsed)) {
    return normalizeContactCustomFields({ customFields: parsed })
  }

  return []
}

export function serializeContactCustomFieldsForDb(customFields = []) {
  return JSON.stringify(normalizeContactCustomFields({ customFields }))
}

function getCustomFieldIdentity(field = {}) {
  return cleanString(field.id || field.key || field.fieldKey || field.label || field.name)
}

export function mergeContactCustomFields(existingFields = [], updates = [], definitions = []) {
  const existing = normalizeContactCustomFields({ customFields: existingFields }, definitions)
  const normalizedUpdates = normalizeContactCustomFields({ customFields: updates }, definitions)
  const byIdentity = new Map()

  for (const field of existing) {
    const identity = getCustomFieldIdentity(field)
    if (identity) byIdentity.set(identity, field)
  }

  for (const update of normalizedUpdates) {
    const identity = getCustomFieldIdentity(update)
    if (!identity) continue

    const current = byIdentity.get(identity) || {}
    const hasHumanUpdateLabel = update.label &&
      update.label !== update.key &&
      update.label !== update.fieldKey &&
      update.label !== update.id

    byIdentity.set(identity, {
      ...current,
      ...update,
      label: hasHumanUpdateLabel ? update.label : current.label || update.label || update.key || update.id,
      name: hasHumanUpdateLabel ? update.name || update.label : current.name || current.label || update.name || update.label,
      dataType: update.dataType || current.dataType || null,
      options: update.options?.length ? update.options : current.options || [],
      value: update.value ?? null
    })
  }

  return Array.from(byIdentity.values())
}

export function buildHighLevelCustomFieldsPayload(customFields = []) {
  return normalizeContactCustomFields({ customFields })
    .map((field) => {
      const syncTarget = cleanString(field.syncTarget).toLowerCase()
      if (['local', 'internal', 'none', 'ristak'].includes(syncTarget)) return null

      const payload = {}
      if (field.id) payload.id = field.id
      if (field.key || field.fieldKey) payload.key = field.fieldKey || field.key
      payload.field_value = field.value ?? null
      return payload
    })
    .filter(Boolean)
    .filter((field) => field.id || field.key)
}
