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

export function getContactCustomFieldKeys(field?: ContactCustomFieldLike | null) {
  if (!field) return []

  return uniqueStrings([
    field.definitionId,
    field.definition_id,
    field.id,
    field.customFieldId,
    field.fieldId,
    field.key,
    field.fieldKey,
    field.field_key,
    field.label,
    field.name
  ])
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
