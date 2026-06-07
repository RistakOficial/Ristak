import type {
  ContactCustomField,
  ContactCustomFieldDefinition,
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

export function getContactCustomFieldDisplayLabel(field?: ContactCustomFieldLike | null, index = 0) {
  return cleanString(field?.label || field?.name || field?.fieldKey || field?.key || field?.id) || `Dato ${index + 1}`
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
