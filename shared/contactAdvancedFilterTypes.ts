export type ContactAdvancedFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'tags' | 'custom_field'

export type ContactAdvancedFieldCatalog =
  | 'campaigns'
  | 'adsets'
  | 'ads'
  | 'automations'
  | 'calendars'
  | 'users'
  | 'payments'
  | 'payment_plans'

export type ContactAdvancedOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'empty'
  | 'not_empty'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'on'
  | 'last_days'
  | 'older_days'
  | 'yes'
  | 'no'
  | 'any'
  | 'all'
  | 'none'

export interface ContactAdvancedOption {
  value: string
  label: string
}

export interface ContactAdvancedField {
  key: string
  label: string
  type: ContactAdvancedFieldType
  options?: ContactAdvancedOption[]
  catalog?: ContactAdvancedFieldCatalog
  placeholder?: string
}

export interface ContactAdvancedFieldGroup {
  label: string
  fields: ContactAdvancedField[]
}

export interface ContactAdvancedRule {
  id: string
  field: string
  operator: ContactAdvancedOperator
  value?: string | string[] | number | boolean | null
  valueTo?: string | number | null
  customKey?: string
  valueType?: ContactAdvancedFieldType
}

export interface ContactAdvancedGroup {
  id: string
  mode: 'all' | 'any'
  negate?: boolean
  rules: ContactAdvancedRule[]
}

export interface ContactAdvancedSort {
  by: string
  order: 'ASC' | 'DESC'
}

export interface ContactAdvancedFilterConfig {
  version: 1
  groupMode?: 'all' | 'any'
  groups: ContactAdvancedGroup[]
  sort?: ContactAdvancedSort | null
}
