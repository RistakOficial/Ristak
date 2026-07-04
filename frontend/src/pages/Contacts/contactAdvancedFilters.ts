export type ContactAdvancedFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'tags' | 'custom_field'

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
  groups: ContactAdvancedGroup[]
  sort?: ContactAdvancedSort | null
}

export const CONTACT_ADVANCED_FILTERS_URL_PARAM = 'conditions'

const idSuffix = () => Math.random().toString(36).slice(2, 9)

const textOperators: ContactAdvancedOption[] = [
  { value: 'contains', label: 'contiene' },
  { value: 'not_contains', label: 'no contiene' },
  { value: 'is', label: 'es igual a' },
  { value: 'is_not', label: 'no es igual a' },
  { value: 'starts_with', label: 'empieza con' },
  { value: 'ends_with', label: 'termina con' },
  { value: 'empty', label: 'esta vacio' },
  { value: 'not_empty', label: 'no esta vacio' }
]

const numberOperators: ContactAdvancedOption[] = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'no es igual a' },
  { value: 'gt', label: 'mayor que' },
  { value: 'gte', label: 'mayor o igual que' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor o igual que' },
  { value: 'between', label: 'esta entre' },
  { value: 'empty', label: 'esta en cero' },
  { value: 'not_empty', label: 'no esta en cero' }
]

const dateOperators: ContactAdvancedOption[] = [
  { value: 'after', label: 'despues de' },
  { value: 'before', label: 'antes de' },
  { value: 'on', label: 'en la fecha' },
  { value: 'between', label: 'entre fechas' },
  { value: 'last_days', label: 'en los ultimos dias' },
  { value: 'older_days', label: 'hace mas de dias' },
  { value: 'empty', label: 'esta vacio' },
  { value: 'not_empty', label: 'no esta vacio' }
]

const booleanOperators: ContactAdvancedOption[] = [
  { value: 'yes', label: 'si' },
  { value: 'no', label: 'no' }
]

const tagOperators: ContactAdvancedOption[] = [
  { value: 'any', label: 'tiene cualquiera de' },
  { value: 'all', label: 'tiene todas' },
  { value: 'none', label: 'no tiene' },
  { value: 'empty', label: 'sin etiquetas' },
  { value: 'not_empty', label: 'con etiquetas' }
]

const selectOperators: ContactAdvancedOption[] = [
  { value: 'is', label: 'es igual a' },
  { value: 'is_not', label: 'no es igual a' },
  { value: 'empty', label: 'esta vacio' },
  { value: 'not_empty', label: 'no esta vacio' }
]

const statusOptions: ContactAdvancedOption[] = [
  { value: 'lead', label: 'Interesado / lead' },
  { value: 'appointment', label: 'Citado' },
  { value: 'customer', label: 'Cliente' }
]

const priorityOptions: ContactAdvancedOption[] = [
  { value: 'high', label: 'Alta: clientes' },
  { value: 'medium', label: 'Media: citados o asistencias' },
  { value: 'low', label: 'Baja: interesados' }
]

const paymentStatusOptions: ContactAdvancedOption[] = [
  { value: 'succeeded', label: 'Exitoso' },
  { value: 'paid', label: 'Pagado' },
  { value: 'completed', label: 'Completado' },
  { value: 'failed', label: 'Fallido' },
  { value: 'declined', label: 'Declinado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'expired', label: 'Expirado' },
  { value: 'refunded', label: 'Reembolsado' }
]

const paymentModeOptions: ContactAdvancedOption[] = [
  { value: 'live', label: 'Real' },
  { value: 'test', label: 'Prueba' }
]

export const CONTACT_ADVANCED_FIELD_GROUPS: ContactAdvancedFieldGroup[] = [
  {
    label: 'Contacto',
    fields: [
      { key: 'full_name', label: 'Nombre', type: 'text' },
      { key: 'first_name', label: 'Nombre propio', type: 'text' },
      { key: 'last_name', label: 'Apellido', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Telefono', type: 'text' },
      { key: 'source', label: 'Fuente del contacto', type: 'text' },
      { key: 'status', label: 'Condicion comercial', type: 'select', options: statusOptions },
      { key: 'priority', label: 'Prioridad', type: 'select', options: priorityOptions },
      { key: 'created_at', label: 'Fecha de creacion', type: 'date' },
      { key: 'updated_at', label: 'Fecha de ultima actualizacion', type: 'date' },
      { key: 'visitor_id', label: 'Visitor ID', type: 'text' },
      { key: 'preferred_whatsapp_phone_number_id', label: 'Numero WhatsApp asignado', type: 'text' }
    ]
  },
  {
    label: 'Etiquetas y campos',
    fields: [
      { key: 'tags', label: 'Etiquetas', type: 'tags' },
      { key: 'custom_field', label: 'Campo personalizado', type: 'custom_field' }
    ]
  },
  {
    label: 'Citas y asistencia',
    fields: [
      { key: 'has_active_appointment', label: 'Tiene cita activa', type: 'boolean' },
      { key: 'has_future_appointment', label: 'Tiene cita futura', type: 'boolean' },
      { key: 'has_past_appointment', label: 'Tiene cita vencida', type: 'boolean' },
      { key: 'has_attended_appointment', label: 'Tiene asistencia', type: 'boolean' },
      { key: 'has_confirmation_badge', label: 'Tiene confirmacion vigente', type: 'boolean' },
      { key: 'appointments_count', label: 'Cantidad de citas', type: 'number' },
      { key: 'active_appointments_count', label: 'Cantidad de citas activas', type: 'number' },
      { key: 'attended_appointments_count', label: 'Cantidad de asistencias', type: 'number' },
      { key: 'appointment_date', label: 'Fecha de cita', type: 'date' },
      { key: 'appointment_status', label: 'Estado de cita', type: 'text' },
      { key: 'appointment_calendar', label: 'Calendario de cita', type: 'text' },
      { key: 'appointment_assigned_user', label: 'Usuario asignado a cita', type: 'text' },
      { key: 'appointment_title', label: 'Titulo de cita', type: 'text' }
    ]
  },
  {
    label: 'Pagos',
    fields: [
      { key: 'has_payments', label: 'Tiene pagos', type: 'boolean' },
      { key: 'has_successful_payment', label: 'Tiene pagos exitosos', type: 'boolean' },
      { key: 'has_failed_payment', label: 'Tiene pagos fallidos', type: 'boolean' },
      { key: 'payments_count', label: 'Cantidad de pagos', type: 'number' },
      { key: 'successful_payments_count', label: 'Cantidad de pagos exitosos', type: 'number' },
      { key: 'failed_payments_count', label: 'Cantidad de pagos fallidos', type: 'number' },
      { key: 'total_paid', label: 'Total pagado', type: 'number' },
      { key: 'last_payment_date', label: 'Ultimo pago exitoso', type: 'date' },
      { key: 'payment_date', label: 'Fecha de pago', type: 'date' },
      { key: 'payment_amount', label: 'Importe de pago', type: 'number' },
      { key: 'payment_status', label: 'Estado de pago', type: 'select', options: paymentStatusOptions },
      { key: 'payment_provider', label: 'Proveedor de pago', type: 'text' },
      { key: 'payment_mode', label: 'Modo de pago', type: 'select', options: paymentModeOptions },
      { key: 'payment_method', label: 'Metodo de pago', type: 'text' }
    ]
  },
  {
    label: 'Tracking y origen',
    fields: [
      { key: 'landing_page', label: 'Pagina de entrada', type: 'text' },
      { key: 'referrer_url', label: 'URL referida', type: 'text' },
      { key: 'utm_source', label: 'Fuente UTM', type: 'text' },
      { key: 'utm_medium', label: 'Medio / conjunto', type: 'text' },
      { key: 'utm_campaign', label: 'Campana', type: 'text' },
      { key: 'utm_content', label: 'Contenido / anuncio', type: 'text' },
      { key: 'utm_term', label: 'Termino UTM', type: 'text' },
      { key: 'source_platform', label: 'Plataforma', type: 'text' },
      { key: 'site_source_name', label: 'Fuente del sitio', type: 'text' },
      { key: 'campaign_name', label: 'Nombre de campana', type: 'text' },
      { key: 'adset_name', label: 'Nombre de conjunto', type: 'text' },
      { key: 'ad_name', label: 'Nombre de anuncio', type: 'text' },
      { key: 'ad_id', label: 'ID de anuncio', type: 'text' },
      { key: 'device_type', label: 'Dispositivo', type: 'text' },
      { key: 'browser', label: 'Navegador', type: 'text' },
      { key: 'os', label: 'Sistema operativo', type: 'text' },
      { key: 'placement', label: 'Ubicacion del anuncio', type: 'text' },
      { key: 'geo_city', label: 'Ciudad', type: 'text' },
      { key: 'geo_region', label: 'Region', type: 'text' },
      { key: 'geo_country', label: 'Pais', type: 'text' }
    ]
  },
  {
    label: 'Automatizaciones',
    fields: [
      { key: 'active_automation', label: 'Esta en automatizacion activa', type: 'boolean' },
      { key: 'automation_status', label: 'Estado en automatizacion', type: 'text' }
    ]
  }
]

export const CONTACT_ADVANCED_SORT_OPTIONS: Array<ContactAdvancedOption & { sort?: ContactAdvancedSort | null }> = [
  { value: '', label: 'Sin orden especial', sort: null },
  { value: 'priority_desc', label: 'Prioridad alta a menor', sort: { by: 'priority', order: 'DESC' } },
  { value: 'priority_asc', label: 'Prioridad menor a alta', sort: { by: 'priority', order: 'ASC' } },
  { value: 'created_at_desc', label: 'Mas recientes primero', sort: { by: 'created_at', order: 'DESC' } },
  { value: 'created_at_asc', label: 'Mas antiguos primero', sort: { by: 'created_at', order: 'ASC' } },
  { value: 'total_paid_desc', label: 'Mayor total pagado', sort: { by: 'total_paid', order: 'DESC' } },
  { value: 'purchases_count_desc', label: 'Mas pagos exitosos', sort: { by: 'purchases_count', order: 'DESC' } },
  { value: 'payments_count_desc', label: 'Mas pagos registrados', sort: { by: 'payments_count', order: 'DESC' } },
  { value: 'failed_payments_count_desc', label: 'Mas pagos fallidos', sort: { by: 'failed_payments_count', order: 'DESC' } },
  { value: 'last_purchase_date_desc', label: 'Ultimo pago mas reciente', sort: { by: 'last_purchase_date', order: 'DESC' } },
  { value: 'appointments_count_desc', label: 'Mas citas', sort: { by: 'appointments_count', order: 'DESC' } }
]

const fieldMap = new Map(CONTACT_ADVANCED_FIELD_GROUPS.flatMap(group => group.fields.map(field => [field.key, field])))

export const getContactAdvancedField = (fieldKey: string) => fieldMap.get(fieldKey)

export const getContactAdvancedOperators = (field?: ContactAdvancedField): ContactAdvancedOption[] => {
  if (!field) return textOperators
  if (field.type === 'number') return numberOperators
  if (field.type === 'date') return dateOperators
  if (field.type === 'boolean') return booleanOperators
  if (field.type === 'tags') return tagOperators
  if (field.type === 'select') return selectOperators
  if (field.type === 'custom_field') return textOperators
  return textOperators
}

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

export const createContactAdvancedGroup = (): ContactAdvancedGroup => ({
  id: `group_${Date.now()}_${idSuffix()}`,
  mode: 'all',
  negate: false,
  rules: [createContactAdvancedRule()]
})

export const createDefaultContactAdvancedConfig = (): ContactAdvancedFilterConfig => ({
  version: 1,
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
              const operators = getContactAdvancedOperators(field).map(option => option.value)
              const operator = operators.includes(String(rawRule.operator || ''))
                ? rawRule.operator as ContactAdvancedOperator
                : getDefaultOperatorForContactAdvancedField(field)
              return {
                id: String(rawRule.id || `rule_${groupIndex}_${ruleIndex}`),
                field: field.key,
                operator,
                value: rawRule.value ?? '',
                valueTo: rawRule.valueTo ?? '',
                customKey: rawRule.customKey ? String(rawRule.customKey) : ''
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

  return { version: 1, groups, sort: sort?.by ? sort : null }
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
