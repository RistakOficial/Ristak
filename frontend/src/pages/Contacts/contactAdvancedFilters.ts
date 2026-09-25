import { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators } from '../../../../shared/contactAdvancedFilterCatalog.js'
import type { ContactAdvancedField, ContactAdvancedFieldType, ContactAdvancedFilterConfig, ContactAdvancedGroup, ContactAdvancedOperator, ContactAdvancedOption, ContactAdvancedRule, ContactAdvancedSort } from '../../../../shared/contactAdvancedFilterTypes'
export * from '../../../../shared/contactAdvancedFilterTypes'
export { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators }

export const CONTACT_ADVANCED_FILTERS_URL_PARAM = 'conditions'

const idSuffix = () => Math.random().toString(36).slice(2, 9)

export const CONTACT_ADVANCED_SORT_OPTIONS: Array<ContactAdvancedOption & { sort?: ContactAdvancedSort | null }> = [
  { value: '', label: 'Sin orden especial', sort: null },
  { value: 'priority_desc', label: 'Prioridad alta a menor', sort: { by: 'priority', order: 'DESC' } },
  { value: 'priority_asc', label: 'Prioridad menor a alta', sort: { by: 'priority', order: 'ASC' } },
  { value: 'created_at_desc', label: 'Más recientes primero', sort: { by: 'created_at', order: 'DESC' } },
  { value: 'created_at_asc', label: 'Más antiguos primero', sort: { by: 'created_at', order: 'ASC' } },
  { value: 'total_paid_desc', label: 'Mayor total pagado', sort: { by: 'total_paid', order: 'DESC' } },
  { value: 'purchases_count_desc', label: 'Más pagos exitosos', sort: { by: 'purchases_count', order: 'DESC' } },
  { value: 'payments_count_desc', label: 'Más pagos registrados', sort: { by: 'payments_count', order: 'DESC' } },
  { value: 'failed_payments_count_desc', label: 'Más pagos fallidos', sort: { by: 'failed_payments_count', order: 'DESC' } },
  { value: 'last_purchase_date_desc', label: 'Último pago más reciente', sort: { by: 'last_purchase_date', order: 'DESC' } },
  { value: 'appointments_count_desc', label: 'Más citas', sort: { by: 'appointments_count', order: 'DESC' } },
  { value: 'next_appointment_date_asc', label: 'Próxima cita primero', sort: { by: 'next_appointment_date', order: 'ASC' } },
  { value: 'last_appointment_date_desc', label: 'Última cita más reciente', sort: { by: 'last_appointment_date', order: 'DESC' } }
]

const fieldMap = new Map(CONTACT_ADVANCED_FIELD_GROUPS.flatMap(group => group.fields.map(field => [field.key, field])))
const allOperatorValues = new Set((['text', 'number', 'date', 'boolean', 'select', 'tags'] as ContactAdvancedFieldType[]).flatMap(type => getContactAdvancedOperators({ key: '', label: '', type })).map(option => option.value))

export const getContactAdvancedField = (fieldKey: string) => fieldMap.get(fieldKey)

export const getDefaultOperatorForContactAdvancedField = (field?: ContactAdvancedField): ContactAdvancedOperator => {
  const operator = getContactAdvancedOperators(field)[0]?.value
  return (operator || 'contains') as ContactAdvancedOperator
}

export const operatorNeedsContactAdvancedValue = (operator: ContactAdvancedOperator) =>
  !['empty', 'not_empty', 'yes', 'no'].includes(operator)

export const operatorUsesContactAdvancedRange = (operator: ContactAdvancedOperator) => operator === 'between'

export const createContactAdvancedRule = (fieldKey = 'tags'): ContactAdvancedRule => {
  const field = getContactAdvancedField(fieldKey) || CONTACT_ADVANCED_FIELD_GROUPS[0].fields[0]
  return {
    id: `rule_${Date.now()}_${idSuffix()}`,
    field: field.key,
    operator: getDefaultOperatorForContactAdvancedField(field),
    value: '',
    valueTo: ''
  }
}

export const createContactAdvancedGroup = (fieldKey = 'tags'): ContactAdvancedGroup => ({
  id: `group_${Date.now()}_${idSuffix()}`,
  mode: 'all',
  negate: false,
  rules: [createContactAdvancedRule(fieldKey)]
})

export const createDefaultContactAdvancedConfig = (): ContactAdvancedFilterConfig => ({
  version: 1,
  groupMode: 'all',
  groups: [],
  sort: null
})

export const normalizeContactAdvancedConfig = (value: unknown): ContactAdvancedFilterConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createDefaultContactAdvancedConfig()
  const raw = value as Partial<ContactAdvancedFilterConfig>
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((group, groupIndex) => {
        const rawGroup = group as Partial<ContactAdvancedGroup>
        const rules = Array.isArray(rawGroup.rules)
          ? rawGroup.rules.map((rule, ruleIndex) => {
              const rawRule = rule as Partial<ContactAdvancedRule>
              const field = getContactAdvancedField(String(rawRule.field || '')) || CONTACT_ADVANCED_FIELD_GROUPS[0].fields[0]
              const operatorValues = field.type === 'custom_field'
                ? allOperatorValues
                : new Set(getContactAdvancedOperators(field).map(option => option.value))
              const operator = operatorValues.has(String(rawRule.operator || '') as ContactAdvancedOperator)
                ? rawRule.operator as ContactAdvancedOperator
                : getDefaultOperatorForContactAdvancedField(field)
              return {
                id: String(rawRule.id || `rule_${groupIndex}_${ruleIndex}`),
                field: field.key,
                operator,
                value: rawRule.value ?? '',
                valueTo: rawRule.valueTo ?? '',
                customKey: rawRule.customKey ? String(rawRule.customKey) : '',
                valueType: rawRule.valueType ? rawRule.valueType as ContactAdvancedFieldType : undefined
              }
            })
          : []

        return {
          id: String(rawGroup.id || `group_${groupIndex}`),
          mode: (rawGroup.mode === 'any' ? 'any' : 'all') as ContactAdvancedGroup['mode'],
          negate: Boolean(rawGroup.negate),
          rules
        }
      })
    : []

  const sort = raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort)
    ? {
        by: String(raw.sort.by || ''),
        order: raw.sort.order === 'ASC' ? 'ASC' : 'DESC'
      } as ContactAdvancedSort
    : null

  return {
    version: 1,
    groupMode: raw.groupMode === 'any' ? 'any' : 'all',
    groups,
    sort: sort?.by ? sort : null
  }
}

export const countContactAdvancedRules = (config: ContactAdvancedFilterConfig) =>
  normalizeContactAdvancedConfig(config).groups.reduce((count, group) => count + group.rules.length, 0)

export const hasActiveContactAdvancedConfig = (config: ContactAdvancedFilterConfig) => {
  const normalized = normalizeContactAdvancedConfig(config)
  return countContactAdvancedRules(normalized) > 0 || Boolean(normalized.sort?.by)
}

export const contactAdvancedSortValue = (sort?: ContactAdvancedSort | null) => {
  if (!sort?.by) return ''
  const match = CONTACT_ADVANCED_SORT_OPTIONS.find(option => option.sort?.by === sort.by && option.sort.order === sort.order)
  return match?.value || ''
}

export const serializeContactAdvancedConfig = (config: ContactAdvancedFilterConfig) => {
  const normalized = normalizeContactAdvancedConfig(config)
  if (!hasActiveContactAdvancedConfig(normalized)) return ''
  return JSON.stringify(normalized)
}

export const parseContactAdvancedConfig = (raw: string | null | undefined): ContactAdvancedFilterConfig => {
  if (!raw) return createDefaultContactAdvancedConfig()
  try {
    return normalizeContactAdvancedConfig(JSON.parse(raw))
  } catch {
    return createDefaultContactAdvancedConfig()
  }
}
