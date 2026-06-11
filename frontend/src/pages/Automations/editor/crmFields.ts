import type { CatalogKind } from '@/services/automationCatalogsService'

/**
 * Catálogo de campos reales del CRM para el constructor de condiciones.
 * Cada campo declara su tipo de dato; los operadores disponibles dependen
 * del tipo. Los valores con catálogo (etiquetas, calendarios…) declaran
 * `valueCatalog` para mostrarse como select en lugar de texto libre.
 */

export type CrmFieldType = 'text' | 'number' | 'date' | 'boolean' | 'tags' | 'select' | 'duration'

export interface CrmField {
  id: string
  label: string
  category: string
  type: CrmFieldType
  /** Catálogo para elegir el valor (select) en lugar de texto libre */
  valueCatalog?: CatalogKind
  /** Opciones fijas para campos tipo select */
  options?: Array<{ value: string; label: string }>
  /** Pide subcampo extra (p. ej. cuál campo personalizado) */
  needsCustomKey?: boolean
}

export interface CrmFieldCategory {
  id: string
  label: string
}

export const CRM_FIELD_CATEGORIES: CrmFieldCategory[] = [
  { id: 'contact', label: 'Contacto' },
  { id: 'tags', label: 'Etiquetas' },
  { id: 'conversation', label: 'Conversación' },
  { id: 'appointments', label: 'Citas / agenda' },
  { id: 'payments', label: 'Pagos' },
  { id: 'forms', label: 'Formularios' },
  { id: 'links', label: 'Links / activación' },
  { id: 'ads', label: 'Ads / campañas' },
  { id: 'automations', label: 'Automatizaciones' }
]

const CHANNEL_FIELD_OPTIONS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'instagram', label: 'Instagram Direct' }
]

const APPOINTMENT_STATUS_OPTIONS = [
  { value: 'booked', label: 'Agendada' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'rescheduled', label: 'Reprogramada' },
  { value: 'completed', label: 'Completada' },
  { value: 'no_show', label: 'No asistió' }
]

const PAYMENT_STATUS_OPTIONS = [
  { value: 'paid', label: 'Pagado' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'failed', label: 'Fallido' },
  { value: 'refunded', label: 'Reembolsado' }
]

export const CRM_FIELDS: CrmField[] = [
  // Contacto (el email es dato del CRM, nunca canal de envío)
  { id: 'contact-first-name', label: 'Nombre', category: 'contact', type: 'text' },
  { id: 'contact-last-name', label: 'Apellido', category: 'contact', type: 'text' },
  { id: 'contact-phone', label: 'Teléfono', category: 'contact', type: 'text' },
  { id: 'contact-email', label: 'Email (dato de contacto)', category: 'contact', type: 'text' },
  { id: 'contact-source', label: 'Fuente', category: 'contact', type: 'text' },
  { id: 'contact-created', label: 'Fecha de creación', category: 'contact', type: 'date' },
  { id: 'contact-updated', label: 'Fecha de actualización', category: 'contact', type: 'date' },
  { id: 'contact-assigned-user', label: 'Usuario asignado', category: 'contact', type: 'select', valueCatalog: 'users' },
  { id: 'contact-stage', label: 'Etapa / pipeline', category: 'contact', type: 'text' },
  { id: 'contact-custom-field', label: 'Campo personalizado…', category: 'contact', type: 'text', needsCustomKey: true },
  { id: 'contact-last-activity', label: 'Última actividad', category: 'contact', type: 'date' },
  { id: 'contact-last-channel', label: 'Último canal de contacto', category: 'contact', type: 'select', options: CHANNEL_FIELD_OPTIONS },

  // Etiquetas
  { id: 'tag-has', label: 'Tiene etiqueta', category: 'tags', type: 'tags', valueCatalog: 'tags' },
  { id: 'tag-not-has', label: 'No tiene etiqueta', category: 'tags', type: 'tags', valueCatalog: 'tags' },
  { id: 'tag-received', label: 'Recibió etiqueta', category: 'tags', type: 'tags', valueCatalog: 'tags' },
  { id: 'tag-lost', label: 'Perdió etiqueta', category: 'tags', type: 'tags', valueCatalog: 'tags' },
  { id: 'tag-any-of', label: 'Contiene cualquiera de estas etiquetas', category: 'tags', type: 'tags', valueCatalog: 'tags' },
  { id: 'tag-all-of', label: 'Contiene todas estas etiquetas', category: 'tags', type: 'tags', valueCatalog: 'tags' },

  // Conversación (solo WhatsApp, Messenger e Instagram Direct)
  { id: 'conv-last-received', label: 'Último mensaje recibido', category: 'conversation', type: 'text' },
  { id: 'conv-last-sent', label: 'Último mensaje enviado', category: 'conversation', type: 'text' },
  { id: 'conv-replied', label: 'Respondió', category: 'conversation', type: 'boolean' },
  { id: 'conv-channel', label: 'Canal de conversación', category: 'conversation', type: 'select', options: CHANNEL_FIELD_OPTIONS },
  { id: 'conv-keyword', label: 'Contiene palabra clave', category: 'conversation', type: 'text' },
  { id: 'conv-last-reply-age', label: 'Tiempo desde la última respuesta', category: 'conversation', type: 'duration' },

  // Citas
  { id: 'appt-has', label: 'Tiene cita', category: 'appointments', type: 'boolean' },
  { id: 'appt-status', label: 'Estado de la cita', category: 'appointments', type: 'select', options: APPOINTMENT_STATUS_OPTIONS },
  { id: 'appt-calendar', label: 'Calendario', category: 'appointments', type: 'select', valueCatalog: 'calendars' },
  { id: 'appt-date', label: 'Fecha de la cita', category: 'appointments', type: 'date' },
  { id: 'appt-created', label: 'Fecha de creación de la cita', category: 'appointments', type: 'date' },

  // Pagos
  { id: 'pay-has', label: 'Tiene pago', category: 'payments', type: 'boolean' },
  { id: 'pay-status', label: 'Estado de pago', category: 'payments', type: 'select', options: PAYMENT_STATUS_OPTIONS },
  { id: 'pay-amount', label: 'Monto pagado', category: 'payments', type: 'number' },
  { id: 'pay-product', label: 'Producto comprado', category: 'payments', type: 'select', valueCatalog: 'products' },
  { id: 'pay-currency', label: 'Moneda', category: 'payments', type: 'text' },
  { id: 'pay-date', label: 'Fecha de pago', category: 'payments', type: 'date' },

  // Formularios
  { id: 'form-submitted', label: 'Formulario enviado', category: 'forms', type: 'boolean' },
  { id: 'form-specific', label: 'Formulario específico', category: 'forms', type: 'select', valueCatalog: 'forms' },
  { id: 'form-field-value', label: 'Campo del formulario contiene', category: 'forms', type: 'text', needsCustomKey: true },
  { id: 'form-date', label: 'Fecha de envío', category: 'forms', type: 'date' },

  // Links
  { id: 'link-clicked', label: 'Hizo clic en enlace', category: 'links', type: 'boolean' },
  { id: 'link-specific', label: 'Link específico', category: 'links', type: 'select', valueCatalog: 'links' },
  { id: 'link-date', label: 'Fecha de clic', category: 'links', type: 'date' },

  // Ads
  { id: 'ads-fb-click', label: 'Clic en anuncio de Facebook', category: 'ads', type: 'boolean' },
  { id: 'ads-ctwa', label: 'Click to WhatsApp ads', category: 'ads', type: 'boolean' },
  { id: 'ads-campaign', label: 'Campaña', category: 'ads', type: 'select', valueCatalog: 'campaigns' },
  { id: 'ads-source', label: 'Fuente de campaña', category: 'ads', type: 'text' },

  // Automatizaciones
  { id: 'auto-in', label: 'Está en automatización', category: 'automations', type: 'boolean' },
  { id: 'auto-entered', label: 'Entró a automatización', category: 'automations', type: 'boolean' },
  { id: 'auto-exited', label: 'Salió de automatización', category: 'automations', type: 'boolean' },
  { id: 'auto-goal-met', label: 'Objetivo cumplido', category: 'automations', type: 'boolean' }
]

const fieldsById = new Map(CRM_FIELDS.map((field) => [field.id, field]))

export function getCrmField(id: string): CrmField | undefined {
  return fieldsById.get(id)
}

// ---------------------------------------------------------------------------
// Operadores por tipo de dato
// ---------------------------------------------------------------------------

export interface CrmOperator {
  value: string
  label: string
  /** No requiere capturar valor (está vacío, sí/no…) */
  noValue?: boolean
}

export const OPERATORS_BY_TYPE: Record<CrmFieldType, CrmOperator[]> = {
  text: [
    { value: 'is', label: 'es' },
    { value: 'is_not', label: 'no es' },
    { value: 'contains', label: 'contiene' },
    { value: 'not_contains', label: 'no contiene' },
    { value: 'starts_with', label: 'empieza con' },
    { value: 'ends_with', label: 'termina con' },
    { value: 'empty', label: 'está vacío', noValue: true },
    { value: 'not_empty', label: 'no está vacío', noValue: true }
  ],
  number: [
    { value: 'eq', label: 'igual a' },
    { value: 'neq', label: 'diferente de' },
    { value: 'gt', label: 'mayor que' },
    { value: 'lt', label: 'menor que' },
    { value: 'gte', label: 'mayor o igual que' },
    { value: 'lte', label: 'menor o igual que' },
    { value: 'between', label: 'entre' }
  ],
  date: [
    { value: 'before', label: 'antes de' },
    { value: 'after', label: 'después de' },
    { value: 'on', label: 'en fecha exacta' },
    { value: 'last_days', label: 'en los últimos X días' },
    { value: 'older_days', label: 'hace más de X días' },
    { value: 'between', label: 'entre fechas' },
    { value: 'empty', label: 'está vacío', noValue: true }
  ],
  boolean: [
    { value: 'yes', label: 'sí', noValue: true },
    { value: 'no', label: 'no', noValue: true }
  ],
  tags: [
    { value: 'any', label: 'contiene cualquiera' },
    { value: 'all', label: 'contiene todas' },
    { value: 'none', label: 'no contiene ninguna' }
  ],
  select: [
    { value: 'is', label: 'es' },
    { value: 'is_not', label: 'no es' },
    { value: 'empty', label: 'está vacío', noValue: true },
    { value: 'not_empty', label: 'no está vacío', noValue: true }
  ],
  duration: [
    { value: 'more_than', label: 'hace más de' },
    { value: 'less_than', label: 'hace menos de' }
  ]
}

export function getOperatorsForField(fieldId: string): CrmOperator[] {
  const field = getCrmField(fieldId)
  return field ? OPERATORS_BY_TYPE[field.type] : OPERATORS_BY_TYPE.text
}

export function operatorNeedsValue(fieldId: string, operator: string): boolean {
  const found = getOperatorsForField(fieldId).find((candidate) => candidate.value === operator)
  return found ? !found.noValue : true
}

// ---------------------------------------------------------------------------
// Modelo de condición compartido (Condición, Esperar y Evento objetivo)
// ---------------------------------------------------------------------------

export interface ConditionRule {
  field: string
  /** Subcampo cuando el campo es personalizado (clave del campo) */
  customKey?: string
  operator: string
  value?: string
  /** Segundo valor para operadores "entre" */
  valueTo?: string
  /** Unidad para operadores de duración (more_than/less_than, last_days…) */
  unit?: string
  /** Valor fijo o variable dinámica ({{contact.x}}) */
  valueMode?: 'fixed' | 'variable'
}

export interface ConditionConfig {
  match: 'all' | 'any'
  rules: ConditionRule[]
}

// ---------------------------------------------------------------------------
// Condición avanzada: ramas → grupos (AND/OR, negables) → reglas
// ---------------------------------------------------------------------------

export interface ConditionGroup {
  id: string
  /** Cómo se combinan las reglas dentro del grupo */
  operator: 'AND' | 'OR'
  /** "No se cumple": niega el resultado del grupo completo */
  negate?: boolean
  rules: ConditionRule[]
}

export interface ConditionBranch {
  id: string
  name: string
  /** Cómo se combinan los grupos entre sí */
  groupsOperator: 'AND' | 'OR'
  groups: ConditionGroup[]
}

export interface AdvancedConditionConfig {
  branches: ConditionBranch[]
}

let branchSeq = 0
function nextId(prefix: string): string {
  branchSeq += 1
  return `${prefix}_${Date.now().toString(36)}${branchSeq}`
}

export function emptyConditionGroup(): ConditionGroup {
  return { id: nextId('grp'), operator: 'AND', negate: false, rules: [{ field: '', operator: '', value: '' }] }
}

export function emptyConditionBranch(name = 'Sí'): ConditionBranch {
  return { id: nextId('branch'), name, groupsOperator: 'AND', groups: [emptyConditionGroup()] }
}

export function emptyAdvancedCondition(): AdvancedConditionConfig {
  return { branches: [emptyConditionBranch()] }
}

/** Migra el modelo simple { match, rules } al modelo avanzado con grupos */
export function migrateSimpleCondition(config: Partial<ConditionConfig>): AdvancedConditionConfig {
  const rules = Array.isArray(config.rules) && config.rules.length > 0
    ? config.rules
    : [{ field: '', operator: '', value: '' }]
  return {
    branches: [
      {
        id: nextId('branch'),
        name: 'Sí',
        groupsOperator: 'AND',
        groups: [{ id: nextId('grp'), operator: config.match === 'any' ? 'OR' : 'AND', negate: false, rules }]
      }
    ]
  }
}

/** Valida la condición avanzada; errores claros en español */
export function validateAdvancedCondition(config: unknown): string[] {
  const errors: string[] = []
  const advanced = (config || {}) as Partial<AdvancedConditionConfig>
  const branches = Array.isArray(advanced.branches) ? advanced.branches : []

  if (branches.length === 0) return ['Agrega al menos una rama de condición']

  branches.forEach((branch, branchIndex) => {
    const branchLabel = branches.length > 1 ? `Rama "${branch.name || branchIndex + 1}"` : 'Condición'
    if (branches.length > 1 && !String(branch.name || '').trim()) {
      errors.push(`La rama ${branchIndex + 1} necesita nombre`)
    }
    const groups = Array.isArray(branch.groups) ? branch.groups : []
    if (groups.length === 0) {
      errors.push(`${branchLabel}: agrega al menos un grupo de reglas`)
      return
    }
    groups.forEach((group, groupIndex) => {
      const prefix = groups.length > 1 ? `${branchLabel} · grupo ${groupIndex + 1}` : branchLabel
      const rules = Array.isArray(group.rules) ? group.rules : []
      if (rules.length === 0) {
        errors.push(`${prefix}: agrega al menos una regla`)
        return
      }
      rules.forEach((rule, ruleIndex) => {
        const position = `${prefix} · regla ${ruleIndex + 1}`
        if (!rule.field) {
          errors.push(`${position}: selecciona un campo`)
          return
        }
        const field = getCrmField(rule.field)
        if (!field) {
          errors.push(`${position}: el campo seleccionado ya no existe`)
          return
        }
        if (field.needsCustomKey && !String(rule.customKey || '').trim()) {
          errors.push(`${position}: indica el campo personalizado`)
        }
        if (!rule.operator) {
          errors.push(`${position}: selecciona un operador`)
          return
        }
        if (operatorNeedsValue(rule.field, rule.operator) && !String(rule.value ?? '').trim()) {
          errors.push(`${position}: captura el valor a comparar`)
        }
        if (rule.operator === 'between' && !String(rule.valueTo ?? '').trim()) {
          errors.push(`${position}: captura el segundo valor del rango`)
        }
      })
    })
  })

  return errors
}

/** Resumen corto de la condición avanzada para la tarjeta */
export function summarizeAdvancedCondition(config: unknown): string {
  const advanced = (config || {}) as Partial<AdvancedConditionConfig>
  const branches = Array.isArray(advanced.branches) ? advanced.branches : []
  if (branches.length === 0) return ''

  const firstRule = branches[0]?.groups?.[0]?.rules?.find((rule) => rule.field)
  if (!firstRule) return ''
  const field = getCrmField(firstRule.field)
  const operator = getOperatorsForField(firstRule.field).find((op) => op.value === firstRule.operator)
  const base = [field?.label, operator?.label, operatorNeedsValue(firstRule.field, firstRule.operator) ? firstRule.value : '']
    .filter(Boolean)
    .join(' ')

  const totalRules = branches.reduce(
    (sum, branch) => sum + (branch.groups || []).reduce((groupSum, group) => groupSum + (group.rules || []).filter((rule) => rule.field).length, 0),
    0
  )
  const extras: string[] = []
  if (totalRules > 1) extras.push(`${totalRules - 1} regla${totalRules > 2 ? 's' : ''} más`)
  if (branches.length > 1) extras.push(`${branches.length} ramas`)
  return extras.length > 0 ? `${base} (+${extras.join(', ')})` : base
}

export function emptyConditionConfig(): ConditionConfig {
  return { match: 'all', rules: [{ field: '', operator: '', value: '' }] }
}

/** Valida reglas; devuelve errores en español (vacío si es válida) */
export function validateConditionRules(config: unknown): string[] {
  const errors: string[] = []
  const conditions = (config || {}) as Partial<ConditionConfig>
  const rules = Array.isArray(conditions.rules) ? conditions.rules : []

  if (rules.length === 0) {
    return ['Agrega al menos una regla']
  }

  rules.forEach((rule, index) => {
    const position = `Regla ${index + 1}`
    if (!rule.field) {
      errors.push(`${position}: selecciona un campo`)
      return
    }
    const field = getCrmField(rule.field)
    if (!field) {
      errors.push(`${position}: el campo seleccionado ya no existe`)
      return
    }
    if (field.needsCustomKey && !String(rule.customKey || '').trim()) {
      errors.push(`${position}: indica el campo personalizado`)
    }
    if (!rule.operator) {
      errors.push(`${position}: selecciona un operador`)
      return
    }
    if (operatorNeedsValue(rule.field, rule.operator) && !String(rule.value ?? '').trim()) {
      errors.push(`${position}: captura el valor a comparar`)
    }
    if (rule.operator === 'between' && !String(rule.valueTo ?? '').trim()) {
      errors.push(`${position}: captura el segundo valor del rango`)
    }
  })

  return errors
}

/** Resumen corto de una condición para mostrar en la tarjeta */
export function summarizeCondition(config: unknown): string {
  const conditions = (config || {}) as Partial<ConditionConfig>
  const rules = (Array.isArray(conditions.rules) ? conditions.rules : []).filter((rule) => rule.field)
  if (rules.length === 0) return ''
  const first = rules[0]
  const field = getCrmField(first.field)
  const operator = getOperatorsForField(first.field).find((op) => op.value === first.operator)
  const base = [field?.label, operator?.label, operatorNeedsValue(first.field, first.operator) ? first.value : '']
    .filter(Boolean)
    .join(' ')
  if (rules.length === 1) return base
  const connector = conditions.match === 'any' ? 'o' : 'y'
  return `${base} ${connector} ${rules.length - 1} regla${rules.length > 2 ? 's' : ''} más`
}
