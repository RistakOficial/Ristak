import type {
  ContactCustomField,
  ContactCustomFieldValue
} from '@/types'

type ContactCustomFieldLike = Record<string, any>

const cleanString = (value: unknown) => String(value || '').trim()

const uniqueStrings = (values: unknown[]) => {
  const seen = new Set<string>()
  const result: string[] = []

  values.forEach((value) => {
    const next = cleanString(value)
    if (!next || seen.has(next)) return
    seen.add(next)
    result.push(next)
  })

  return result
}

export function getContactCustomFieldStableKeys(field?: ContactCustomFieldLike | null) {
  if (!field) return []

  return uniqueStrings([
    field.definitionId,
    field.definition_id,
    field.id,
    field.customFieldId,
    field.fieldId,
    field.key,
    field.fieldKey,
    field.field_key
  ])
}

export function getContactCustomFieldFallbackKeys(field?: ContactCustomFieldLike | null) {
  if (!field) return []

  return uniqueStrings([field.label, field.name])
    .map((value) => `label:${value.toLocaleLowerCase('es-MX')}`)
}

export function getContactCustomFieldKeys(field?: ContactCustomFieldLike | null) {
  const stableKeys = getContactCustomFieldStableKeys(field)
  return stableKeys.length > 0 ? stableKeys : getContactCustomFieldFallbackKeys(field)
}

const normalizeMatchKey = (value: unknown) => cleanString(value).toLocaleLowerCase('es-MX')

export function findMatchingContactCustomField<T extends ContactCustomFieldLike>(
  fields: T[] = [],
  definition?: ContactCustomFieldLike | null
) {
  if (!definition) return null

  const definitionStableKeys = new Set(
    getContactCustomFieldStableKeys(definition).map(normalizeMatchKey)
  )

  if (definitionStableKeys.size > 0) {
    const stableMatch = fields.find((field) =>
      getContactCustomFieldStableKeys(field)
        .map(normalizeMatchKey)
        .some((key) => definitionStableKeys.has(key))
    )
    if (stableMatch) return stableMatch
  }

  const definitionFallbackKeys = new Set(getContactCustomFieldFallbackKeys(definition))
  if (definitionFallbackKeys.size === 0) return null

  const fallbackMatches = fields.filter((field) => {
    // Si ambos lados ya tienen identidad estable y no coincidieron arriba, el
    // texto visible no puede decidir que sean el mismo campo. Dos preguntas
    // distintas pueden compartir exactamente la misma etiqueta.
    if (definitionStableKeys.size > 0 && getContactCustomFieldStableKeys(field).length > 0) {
      return false
    }

    return getContactCustomFieldFallbackKeys(field)
      .some((key) => definitionFallbackKeys.has(key))
  })

  return fallbackMatches.length === 1 ? fallbackMatches[0] : null
}

const getContactCustomFieldSourceIdentity = (field?: ContactCustomFieldLike | null) => {
  if (!field) return ''

  const sourceFieldId = cleanString(field.sourceFieldId || field.source_field_id)
  if (!sourceFieldId) return ''

  const sourceScope = cleanString(
    field.sourceFormId ||
    field.source_form_id ||
    field.sourceSiteId ||
    field.source_site_id
  )
  if (!sourceScope) return ''

  return `source:${normalizeMatchKey(sourceScope)}:field:${normalizeMatchKey(sourceFieldId)}`
}

const hasMeaningfulContactCustomFieldValue = (field?: ContactCustomFieldLike | null) => {
  if (!field || field.value === null || field.value === undefined) return false
  if (typeof field.value === 'string') return field.value.trim().length > 0
  if (Array.isArray(field.value)) return field.value.length > 0
  if (typeof field.value === 'object') return Object.keys(field.value).length > 0
  return true
}

const definitionTimestamp = (definition: ContactCustomFieldLike) => {
  const raw = cleanString(
    definition.updatedAt ||
    definition.updated_at ||
    definition.createdAt ||
    definition.created_at
  )
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const isUncuratedRecoveryDefinition = (
  definition: ContactCustomFieldLike,
  matchingField: ContactCustomFieldLike | null
) => {
  if (normalizeMatchKey(definition.sourceType || definition.source_type) !== 'submission_recovery') {
    return false
  }
  if (hasMeaningfulContactCustomFieldValue(matchingField)) return false

  const folderId = cleanString(definition.folderId || definition.folder_id)
  const fieldGroup = normalizeMatchKey(definition.fieldGroup || definition.field_group)
  return !folderId && (!fieldGroup || fieldGroup === 'general')
}

interface ContactDefinitionCandidate<T extends ContactCustomFieldLike> {
  definition: T
  index: number
  match: ContactCustomFieldLike | null
  sourceIdentity: string
}

const newestDefinitionCandidate = <T extends ContactCustomFieldLike>(
  candidates: ContactDefinitionCandidate<T>[]
) => candidates.reduce((current, candidate) => {
  if (!current) return candidate
  return definitionTimestamp(candidate.definition) > definitionTimestamp(current.definition)
    ? candidate
    : current
}, null as ContactDefinitionCandidate<T> | null)

export function selectContactCustomFieldDefinitionsForContact<T extends ContactCustomFieldLike>(
  definitions: T[] = [],
  fields: ContactCustomFieldLike[] = []
) {
  const candidates = definitions
    .map<ContactDefinitionCandidate<T>>((definition, index) => {
      const match = findMatchingContactCustomField(fields, definition)
      return {
        definition,
        index,
        match,
        sourceIdentity: getContactCustomFieldSourceIdentity(definition)
      }
    })
    .filter(candidate => !isUncuratedRecoveryDefinition(candidate.definition, candidate.match))

  const groupsBySource = new Map<string, ContactDefinitionCandidate<T>[]>()
  const visibleIndexes = new Set<number>()

  candidates.forEach((candidate) => {
    if (!candidate.sourceIdentity) {
      visibleIndexes.add(candidate.index)
      return
    }

    const group = groupsBySource.get(candidate.sourceIdentity) || []
    group.push(candidate)
    groupsBySource.set(candidate.sourceIdentity, group)
  })

  groupsBySource.forEach((group) => {
    if (group.length === 1) {
      visibleIndexes.add(group[0].index)
      return
    }

    const populated = group.filter(candidate => hasMeaningfulContactCustomFieldValue(candidate.match))
    if (populated.length > 0) {
      populated.forEach(candidate => visibleIndexes.add(candidate.index))
      return
    }

    const preferred = newestDefinitionCandidate(group)
    if (preferred) visibleIndexes.add(preferred.index)
  })

  return candidates
    .filter(candidate => visibleIndexes.has(candidate.index))
    .map(candidate => candidate.definition)
}

export function getContactCustomFieldIdentity(field?: ContactCustomFieldLike | null) {
  return getContactCustomFieldKeys(field)[0] || ''
}

export function mergeContactCustomFields(baseFields: ContactCustomField[] = [], nextFields: ContactCustomField[] = []) {
  const byIdentity = new Map<string, ContactCustomField>()

  baseFields.forEach((field) => {
    const identity = getContactCustomFieldIdentity(field)
    if (identity) byIdentity.set(identity, field)
  })

  nextFields.forEach((field) => {
    const identity = getContactCustomFieldIdentity(field)
    if (!identity) return
    byIdentity.set(identity, {
      ...(byIdentity.get(identity) || {}),
      ...field
    })
  })

  return [...byIdentity.values()]
}

export function getContactCustomFieldDisplayLabel(field?: ContactCustomFieldLike | null, index = 0) {
  return cleanString(field?.label || field?.name || field?.fieldKey || field?.key || field?.id) || `Dato ${index + 1}`
}

export function resolveContactCustomFieldGroup(
  label: unknown,
  folderId: unknown,
  unfiledLabel = 'Campos personalizados'
) {
  const normalizedLabel = cleanString(label)
  const normalizedFolderId = cleanString(folderId)
  const isDefaultGroup = !normalizedLabel || normalizedLabel.toLocaleLowerCase('es-MX') === 'general'

  if (isDefaultGroup) {
    return {
      id: 'unfiled',
      label: unfiledLabel
    }
  }

  return {
    id: normalizedFolderId || `group:${normalizedLabel}`,
    label: normalizedLabel
  }
}

const WHATSAPP_RESERVED_CUSTOM_FIELD_KEYS = new Set([
  'whatsapp_api_provider',
  'whatsapp_api_first_message',
  'whatsapp_api_source_id',
  'whatsapp_api_ctwa_clid',
  'whatsapp_api_source_url'
])

const ACCOUNT_RESERVED_CUSTOM_FIELD_KEYS = new Set([
  'business_name',
  'nombre_del_negocio',
  'nombre_de_negocio'
])

const normalizeCustomFieldToken = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

export function isReservedContactCustomField(field?: ContactCustomFieldLike | null) {
  if (!field) return false

  const tokens = [
    field.id,
    field.key,
    field.fieldKey,
    field.label,
    field.name
  ].map(normalizeCustomFieldToken).filter(Boolean)

  return tokens.some(token =>
    ACCOUNT_RESERVED_CUSTOM_FIELD_KEYS.has(token) ||
    WHATSAPP_RESERVED_CUSTOM_FIELD_KEYS.has(token) ||
    token.startsWith('whatsapp_api_') ||
    token.includes('_ctwa_') ||
    token === 'ctwa' ||
    token === 'ctwa_clid'
  )
}

export function formatContactCustomFieldDisplayValue(value: ContactCustomFieldValue | undefined) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const option = item as Record<string, unknown>
          return cleanString(option.label || option.name || option.value)
        }
        return cleanString(item)
      })
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
