import type { CatalogKind } from '@/services/automationCatalogsService'
import { contactTagsService } from '@/services/contactTagsService'

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
  { id: 'comment', label: 'Comentario' },
  { id: 'appointments', label: 'Citas' },
  { id: 'payments', label: 'Pagos' },
  { id: 'forms', label: 'Formularios' },
  { id: 'links', label: 'Clics de disparo' },
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
  { value: 'succeeded', label: 'Exitoso' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'partial', label: 'Parcial / incompleto' },
  { value: 'failed', label: 'Fallido' },
  { value: 'overdue', label: 'Vencido' },
  { value: 'void', label: 'Anulado' },
  { value: 'refunded', label: 'Reembolsado' },
  { value: 'draft', label: 'Borrador' },
  { value: 'sent', label: 'Enviado' }
]

const PAYMENT_PROVIDER_OPTIONS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'conekta', label: 'Conekta' },
  { value: 'mercadopago', label: 'Mercado Pago' },
  { value: 'highlevel', label: 'HighLevel' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Otro' }
]

const PAYMENT_MODE_OPTIONS = [
  { value: 'live', label: 'En vivo' },
  { value: 'test', label: 'Prueba' }
]

const tagValueLabel = (value: unknown, savedLabel?: string): string =>
  savedLabel || contactTagsService.getDisplayName(typeof value === 'string' ? value : '')

const conditionDisplayValue = (field: CrmField | undefined, rule: Pick<ConditionRule, 'value' | 'valueLabel'>): string =>
  field?.valueCatalog === 'tags' ? tagValueLabel(rule.value, rule.valueLabel) : rule.valueLabel || rule.value || ''

const triggerFilterDisplayValue = (field: TriggerFilterField | undefined, filter: Pick<TriggerFilter, 'value' | 'valueLabel'>): string =>
  field?.catalog === 'tags' ? tagValueLabel(filter.value, filter.valueLabel) : filter.valueLabel || filter.value || ''

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

  // Conversación (WhatsApp, Messenger, Instagram Direct y disparos de correo)
  { id: 'conv-last-received', label: 'Último mensaje recibido', category: 'conversation', type: 'text' },
  { id: 'conv-last-sent', label: 'Último mensaje enviado', category: 'conversation', type: 'text' },
  { id: 'conv-replied', label: 'Respondió', category: 'conversation', type: 'boolean' },
  { id: 'conv-channel', label: 'Canal de conversación', category: 'conversation', type: 'select', options: CHANNEL_FIELD_OPTIONS },
  { id: 'conv-keyword', label: 'Contiene palabra clave', category: 'conversation', type: 'text' },
  { id: 'conv-last-reply-age', label: 'Tiempo desde la última respuesta', category: 'conversation', type: 'duration' },

  // Comentarios FB/IG (disponibles cuando el flujo lo disparó un comentario)
  { id: 'comment-text', label: 'Texto del comentario', category: 'comment', type: 'text' },
  { id: 'comment-platform', label: 'Red social del comentario', category: 'comment', type: 'select', options: [{ value: 'facebook', label: 'Facebook' }, { value: 'instagram', label: 'Instagram' }] },
  { id: 'comment-post-fb', label: 'Publicación de Facebook', category: 'comment', type: 'text' },
  { id: 'comment-post-ig', label: 'Publicación de Instagram', category: 'comment', type: 'text' },

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

  // Clics de disparo
  { id: 'link-clicked', label: 'Recibió clic de disparo', category: 'links', type: 'boolean' },
  { id: 'link-specific', label: 'Clic de disparo específico', category: 'links', type: 'select', valueCatalog: 'links' },
  { id: 'link-date', label: 'Fecha del clic de disparo', category: 'links', type: 'date' },

  // Ads
  { id: 'ads-fb-click', label: 'Clic en anuncio de Facebook', category: 'ads', type: 'boolean' },
  { id: 'ads-ctwa', label: 'Mensaje desde anuncio de WhatsApp', category: 'ads', type: 'boolean' },
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
    { value: 'is', label: 'es igual a' },
    { value: 'is_not', label: 'no es igual a' },
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
    { value: 'is', label: 'es igual a' },
    { value: 'is_not', label: 'no es igual a' },
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
// Campos dinámicos del flujo usados como lado izquierdo de una condición
// ---------------------------------------------------------------------------

export const CONDITION_VARIABLE_FIELD_PREFIX = 'var:'

export function conditionVariableFieldId(fieldId: string): string {
  return `${CONDITION_VARIABLE_FIELD_PREFIX}${fieldId}`
}

export function isConditionVariableField(fieldId: string): boolean {
  return fieldId.startsWith(CONDITION_VARIABLE_FIELD_PREFIX)
}

export function conditionVariableTokenFromField(fieldId: string): string {
  return isConditionVariableField(fieldId)
    ? fieldId.slice(CONDITION_VARIABLE_FIELD_PREFIX.length)
    : fieldId
}

function normalizeConditionFieldType(type: unknown): CrmFieldType {
  return ['text', 'number', 'date', 'boolean', 'tags', 'select', 'duration'].includes(String(type))
    ? (type as CrmFieldType)
    : 'text'
}

// ---------------------------------------------------------------------------
// Modelo de condición compartido (Condición, Esperar y Evento objetivo)
// ---------------------------------------------------------------------------

export interface ConditionRule {
  field: string
  /** Subcampo cuando el campo es personalizado (clave del campo) */
  customKey?: string
  customLabel?: string
  operator: string
  value?: string
  /** Segundo valor para operadores "entre" */
  valueTo?: string
  /** Unidad para operadores de duración (more_than/less_than, last_days…) */
  unit?: string
  /** Valor fijo o variable dinámica ({{contact.x}}) */
  valueMode?: 'fixed' | 'variable'
  /** Nombre legible del valor cuando viene de un catálogo (etiqueta, calendario…) */
  valueLabel?: string
  /** Nombre legible cuando el campo viene de un paso anterior del flujo */
  fieldLabel?: string
  /** Tipo inferido cuando el campo viene de un paso anterior del flujo */
  fieldType?: CrmFieldType
  /** Nodo o disparador que produjo el dato dinámico */
  fieldSourceId?: string
  /** Ruta interna dentro de la salida del paso anterior */
  fieldPath?: string
}

export function getConditionField(rule: Pick<ConditionRule, 'field' | 'fieldLabel' | 'fieldType'>): CrmField | undefined {
  if (isConditionVariableField(rule.field)) {
    const token = conditionVariableTokenFromField(rule.field)
    return {
      id: rule.field,
      label: rule.fieldLabel || token,
      category: 'flow',
      type: normalizeConditionFieldType(rule.fieldType)
    }
  }
  return getCrmField(rule.field)
}

export function getOperatorsForConditionRule(rule: Pick<ConditionRule, 'field' | 'fieldLabel' | 'fieldType'>): CrmOperator[] {
  const field = getConditionField(rule)
  return field ? OPERATORS_BY_TYPE[field.type] : OPERATORS_BY_TYPE.text
}

export function operatorNeedsValueForRule(
  rule: Pick<ConditionRule, 'field' | 'fieldLabel' | 'fieldType'>,
  operator: string
): boolean {
  const found = getOperatorsForConditionRule(rule).find((candidate) => candidate.value === operator)
  return found ? !found.noValue : true
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
        const field = getConditionField(rule)
        if (!field) {
          errors.push(`${position}: el campo seleccionado ya no existe`)
          return
        }
        if (field.needsCustomKey && !String(rule.customKey || '').trim()) {
          errors.push(`${position}: indica el campo personalizado`)
        }
        if (!rule.operator) {
          errors.push(`${position}: selecciona qué debe pasar`)
          return
        }
        if (operatorNeedsValueForRule(rule, rule.operator) && !String(rule.value ?? '').trim()) {
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
  const field = getConditionField(firstRule)
  const operator = getOperatorsForConditionRule(firstRule).find((op) => op.value === firstRule.operator)
  const fieldLabel = field?.needsCustomKey && firstRule.customLabel
    ? firstRule.customLabel.toLowerCase()
    : field?.label.toLowerCase()
  const base = `Si ${[fieldLabel, operator?.label, operatorNeedsValueForRule(firstRule, firstRule.operator) ? `"${conditionDisplayValue(field, firstRule)}"` : '']
    .filter(Boolean)
    .join(' ')}`

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
    const field = getConditionField(rule)
    if (!field) {
      errors.push(`${position}: el campo seleccionado ya no existe`)
      return
    }
    if (field.needsCustomKey && !String(rule.customKey || '').trim()) {
      errors.push(`${position}: indica el campo personalizado`)
    }
    if (!rule.operator) {
      errors.push(`${position}: selecciona qué debe pasar`)
      return
    }
    if (operatorNeedsValueForRule(rule, rule.operator) && !String(rule.value ?? '').trim()) {
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
  const field = getConditionField(first)
  const operator = getOperatorsForConditionRule(first).find((op) => op.value === first.operator)
  const fieldLabel = field?.needsCustomKey && first.customLabel ? first.customLabel : field?.label
  const base = [fieldLabel, operator?.label, operatorNeedsValueForRule(first, first.operator) ? conditionDisplayValue(field, first) : '']
    .filter(Boolean)
    .join(' ')
  if (rules.length === 1) return base
  const connector = conditions.match === 'any' ? 'o' : 'y'
  return `${base} ${connector} ${rules.length - 1} regla${rules.length > 2 ? 's' : ''} más`
}


// ---------------------------------------------------------------------------
// Filtros avanzados de los disparadores ("+ Añadir filtro")
// ---------------------------------------------------------------------------

export type TriggerFilterMatch =
  | 'is'
  | 'not'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'empty'
  | 'not_empty'
  | 'yes'
  | 'no'
  | 'is_disqualified'
  | 'not_disqualified'

export interface TriggerFilter {
  field: string
  /** Llave del subcampo elegido cuando el filtro lo necesita */
  customKey?: string
  customLabel?: string
  match: TriggerFilterMatch | ''
  value: string
  /** Nombre legible del valor cuando viene de un catálogo (etiqueta, calendario…) */
  valueLabel?: string
  /** Cómo se une con el filtro anterior: Y (default) u O */
  connector?: 'and' | 'or'
}

export const TRIGGER_FILTER_OPERATORS: Array<{
  value: TriggerFilterMatch
  label: string
  /** No requiere capturar valor (está vacío / no está vacío) */
  noValue?: boolean
}> = [
  { value: 'is', label: 'es igual a' },
  { value: 'not', label: 'no es igual a' },
  { value: 'eq', label: 'igual a' },
  { value: 'neq', label: 'diferente de' },
  { value: 'gt', label: 'mayor que' },
  { value: 'gte', label: 'mayor o igual que' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor o igual que' },
  { value: 'contains', label: 'contiene' },
  { value: 'not_contains', label: 'no contiene' },
  { value: 'starts_with', label: 'empieza con' },
  { value: 'ends_with', label: 'termina con' },
  { value: 'empty', label: 'está vacío', noValue: true },
  { value: 'not_empty', label: 'no está vacío', noValue: true },
  { value: 'yes', label: 'sí', noValue: true },
  { value: 'no', label: 'no', noValue: true },
  { value: 'is_disqualified', label: 'es descalificado', noValue: true },
  { value: 'not_disqualified', label: 'no es descalificado', noValue: true }
]

/** ¿El operador del filtro necesita capturar un valor? */
export function triggerOperatorNeedsValue(match: unknown): boolean {
  if (!match) return false
  const operator = TRIGGER_FILTER_OPERATORS.find((candidate) => candidate.value === match)
  return operator ? !operator.noValue : true
}

export interface TriggerFilterField {
  id: string
  label: string
  type?: 'text' | 'number' | 'boolean'
  /** Frase con artículo para la oración ("la fuente", "el país"…) */
  phrase: string
  catalog?: CatalogKind
  /** Opciones fijas (el valor se elige de una lista, no texto libre) */
  options?: Array<{ value: string; label: string }>
  /** Operadores permitidos solo para este campo */
  operators?: TriggerFilterMatch[]
  /** Categoría del drill-down (Contacto, Mensaje, Citas…) */
  category: string
  /** Contextos donde aplica; sin lista = siempre (datos del contacto) */
  appliesTo?: string[]
  /** Pide elegir una llave/subcampo antes de elegir el operador */
  needsCustomKey?: boolean
}

export const TRIGGER_FILTER_FIELDS: TriggerFilterField[] = [
  // Del evento (solo aparecen cuando el disparador los produce)
  {
    id: 'changed_detail',
    label: 'Detalle que cambió',
    phrase: 'el detalle que cambió',
    catalog: 'contactChangeFields',
    category: 'Cambio',
    appliesTo: ['contact_change'],
    operators: ['is', 'not', 'contains', 'not_contains']
  },
  {
    id: 'change_source',
    label: 'Origen del cambio',
    phrase: 'el origen del cambio',
    options: [
      { value: 'manual', label: 'Manual' },
      { value: 'automation', label: 'Automatización' },
      { value: 'webhook', label: 'Webhook / integración' },
      { value: 'tag', label: 'Etiqueta' },
      { value: 'payment', label: 'Pago' },
      { value: 'appointment', label: 'Cita' }
    ],
    category: 'Cambio',
    appliesTo: ['contact_change']
  },
  { id: 'message', label: 'Mensaje', phrase: 'el mensaje', category: 'Mensaje', appliesTo: ['message'] },
  { id: 'channel', label: 'Canal del mensaje', phrase: 'el canal', options: CHANNEL_FIELD_OPTIONS, category: 'Mensaje', appliesTo: ['message'] },
  { id: 'calendar', label: 'Calendario', phrase: 'el calendario', catalog: 'calendars', category: 'Cita', appliesTo: ['appointment'] },
  { id: 'appointment_type', label: 'Tipo de cita', phrase: 'el tipo de cita', category: 'Cita', appliesTo: ['appointment'] },
  { id: 'payment_status', label: 'Status del pago', phrase: 'el status del pago', options: PAYMENT_STATUS_OPTIONS, category: 'Pago', appliesTo: ['payment'] },
  { id: 'amount', label: 'Monto', phrase: 'el monto', category: 'Pago', appliesTo: ['payment'] },
  { id: 'currency', label: 'Moneda', phrase: 'la moneda', category: 'Pago', appliesTo: ['payment'] },
  { id: 'provider', label: 'Pasarela de pago', phrase: 'la pasarela de pago', options: PAYMENT_PROVIDER_OPTIONS, category: 'Pago', appliesTo: ['payment'] },
  { id: 'payment_mode', label: 'Modo de pago', phrase: 'el modo de pago', options: PAYMENT_MODE_OPTIONS, category: 'Pago', appliesTo: ['payment'] },
  { id: 'payment_method', label: 'Método de pago', phrase: 'el método de pago', category: 'Pago', appliesTo: ['payment'] },
  { id: 'payment_id', label: 'ID del pago', phrase: 'el ID del pago', category: 'Pago', appliesTo: ['payment'] },
  { id: 'event_id', label: 'ID del evento / webhook', phrase: 'el ID del evento', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'reference', label: 'Referencia', phrase: 'la referencia', category: 'Pago', appliesTo: ['payment'] },
  { id: 'title', label: 'Concepto / título', phrase: 'el concepto', category: 'Pago', appliesTo: ['payment'] },
  { id: 'description', label: 'Descripción', phrase: 'la descripción', category: 'Pago', appliesTo: ['payment'] },
  { id: 'receipt', label: 'Recibo / factura', phrase: 'el recibo', category: 'Pago', appliesTo: ['payment'] },
  { id: 'receipt_url', label: 'URL del comprobante', phrase: 'la URL del comprobante', category: 'Pago', appliesTo: ['payment'] },
  { id: 'public_payment_id', label: 'ID público del pago', phrase: 'el ID público del pago', category: 'Pago', appliesTo: ['payment'] },
  { id: 'payment_url', label: 'URL del pago', phrase: 'la URL del pago', category: 'Pago', appliesTo: ['payment'] },
  { id: 'invoice_id', label: 'ID de factura', phrase: 'el ID de factura', category: 'Pago', appliesTo: ['payment'] },
  { id: 'invoice_number', label: 'Número de factura', phrase: 'el número de factura', category: 'Pago', appliesTo: ['payment'] },
  { id: 'product', label: 'Producto', phrase: 'el producto', catalog: 'products', category: 'Productos', appliesTo: ['payment'] },
  { id: 'product_name', label: 'Nombre del producto', phrase: 'el nombre del producto', category: 'Productos', appliesTo: ['payment'] },
  { id: 'product_id', label: 'ID del producto', phrase: 'el ID del producto', category: 'Productos', appliesTo: ['payment'] },
  { id: 'local_product_id', label: 'ID local del producto', phrase: 'el ID local del producto', category: 'Productos', appliesTo: ['payment'] },
  { id: 'ghl_product_id', label: 'ID de producto en HighLevel', phrase: 'el ID de producto en HighLevel', category: 'Productos', appliesTo: ['payment'] },
  { id: 'product_sku', label: 'SKU del producto', phrase: 'el SKU del producto', category: 'Productos', appliesTo: ['payment'] },
  { id: 'price_name', label: 'Nombre del precio / variante', phrase: 'el nombre del precio', category: 'Productos', appliesTo: ['payment'] },
  { id: 'price_id', label: 'ID del precio / variante', phrase: 'el ID del precio', category: 'Productos', appliesTo: ['payment'] },
  { id: 'local_price_id', label: 'ID local del precio', phrase: 'el ID local del precio', category: 'Productos', appliesTo: ['payment'] },
  { id: 'ghl_price_id', label: 'ID de precio en HighLevel', phrase: 'el ID del precio en HighLevel', category: 'Productos', appliesTo: ['payment'] },
  { id: 'stripe_payment_intent_id', label: 'Stripe PaymentIntent ID', phrase: 'el PaymentIntent de Stripe', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'stripe_charge_id', label: 'Stripe Charge ID', phrase: 'el charge de Stripe', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'mercadopago_payment_id', label: 'Mercado Pago payment ID', phrase: 'el payment ID de Mercado Pago', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'mercadopago_preference_id', label: 'Mercado Pago preference ID', phrase: 'el preference ID de Mercado Pago', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'conekta_order_id', label: 'Conekta order ID', phrase: 'el order ID de Conekta', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'conekta_charge_id', label: 'Conekta charge ID', phrase: 'el charge ID de Conekta', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'conekta_payment_source_id', label: 'Conekta payment source ID', phrase: 'el payment source de Conekta', category: 'Pasarela de pago', appliesTo: ['payment'] },
  { id: 'paid_at', label: 'Fecha de pago', phrase: 'la fecha de pago', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'payment_date', label: 'Fecha del evento', phrase: 'la fecha del evento', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'due_date', label: 'Fecha de vencimiento', phrase: 'la fecha de vencimiento', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'sent_at', label: 'Fecha de envío', phrase: 'la fecha de envío', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'payment_created_at', label: 'Fecha de creación del pago', phrase: 'la fecha de creación del pago', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'payment_updated_at', label: 'Fecha de actualización del pago', phrase: 'la fecha de actualización del pago', category: 'Fechas del pago', appliesTo: ['payment'] },
  { id: 'campaign', label: 'Campaña', phrase: 'la campaña', catalog: 'campaigns', category: 'Anuncio', appliesTo: ['ads'] },
  {
    id: 'form_disqualified',
    label: 'Resultado del formulario',
    phrase: 'el formulario',
    operators: ['is_disqualified', 'not_disqualified'],
    category: 'Formulario',
    appliesTo: ['form']
  },
  {
    id: 'form_field',
    label: 'Pregunta del formulario',
    phrase: 'la respuesta',
    category: 'Formulario',
    appliesTo: ['form'],
    needsCustomKey: true
  },
  // Atribución de anuncios (vive en el contacto: disponible siempre)
  { id: 'ad', label: 'Anuncio de origen', phrase: 'el anuncio de origen', catalog: 'ads', category: 'Anuncio' },
  { id: 'ad_id', label: 'ID del anuncio', phrase: 'el ID del anuncio', catalog: 'adIds', category: 'Anuncio' },
  { id: 'attribution_url', label: 'URL de origen', phrase: 'la URL de origen', category: 'Anuncio' },
  { id: 'medium', label: 'Medio de atribución', phrase: 'el medio', category: 'Anuncio' },
  // Del contacto (siempre disponibles)
  { id: 'first_name', label: 'Nombre', phrase: 'el nombre', category: 'Contacto' },
  { id: 'last_name', label: 'Apellido', phrase: 'el apellido', category: 'Contacto' },
  { id: 'source', label: 'Fuente', phrase: 'la fuente', category: 'Contacto' },
  { id: 'tag', label: 'Etiqueta', phrase: 'la etiqueta', catalog: 'tags', category: 'Contacto' },
  { id: 'stage', label: 'Pipeline / etapa', phrase: 'la etapa', category: 'Contacto' },
  { id: 'country', label: 'País', phrase: 'el país', category: 'Contacto' },
  { id: 'email', label: 'Email (dato de contacto)', phrase: 'el email', category: 'Contacto' },
  { id: 'phone', label: 'Teléfono', phrase: 'el teléfono', category: 'Contacto' },
  { id: 'assigned', label: 'Usuario asignado', phrase: 'el usuario asignado', catalog: 'users', category: 'Contacto' },
  { id: 'preferred_whatsapp_number', label: 'Número de WhatsApp asignado', phrase: 'el número de WhatsApp asignado', catalog: 'whatsappNumbers', category: 'Contacto' },
  { id: 'custom', label: 'Campo personalizado…', phrase: 'el campo', category: 'Contacto', needsCustomKey: true },
  { id: 'created_at', label: 'Fecha de creación', phrase: 'la fecha de creación', category: 'Sistema' },
  { id: 'updated_at', label: 'Fecha de actualización', phrase: 'la fecha de actualización', category: 'Sistema' },
  { id: 'visitor_id', label: 'Visitor ID', phrase: 'el visitor ID', category: 'Sistema' },
  { id: 'total_paid', label: 'Total pagado', phrase: 'el total pagado', type: 'number', category: 'Pagos del contacto', appliesTo: ['contact_change'] },
  { id: 'payments_count', label: 'Cantidad de pagos', phrase: 'la cantidad de pagos', type: 'number', category: 'Pagos del contacto', appliesTo: ['contact_change'] },
  { id: 'successful_payments_count', label: 'Cantidad de pagos exitosos', phrase: 'la cantidad de pagos exitosos', type: 'number', category: 'Pagos del contacto', appliesTo: ['contact_change'] },
  { id: 'last_purchase_date', label: 'Último pago', phrase: 'la fecha del último pago', category: 'Pagos del contacto', appliesTo: ['contact_change'] },
  { id: 'appointments_count', label: 'Cantidad de citas', phrase: 'la cantidad de citas', type: 'number', category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'active_appointments_count', label: 'Cantidad de citas activas', phrase: 'la cantidad de citas activas', type: 'number', category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'has_active_appointment', label: 'Tiene cita activa', phrase: 'tiene cita activa', type: 'boolean', category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'active_appointment_status', label: 'Estado de cita activa', phrase: 'el estado de la cita activa', options: APPOINTMENT_STATUS_OPTIONS, category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'active_appointment_calendar', label: 'Calendario de cita activa', phrase: 'el calendario de la cita activa', catalog: 'calendars', category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'active_appointment_assigned', label: 'Usuario de cita activa', phrase: 'el usuario de la cita activa', catalog: 'users', category: 'Citas del contacto', appliesTo: ['contact_change'] },
  { id: 'active_appointment_date', label: 'Fecha de cita activa', phrase: 'la fecha de la cita activa', category: 'Citas del contacto', appliesTo: ['contact_change'] }
]

/** Contextos de evento que produce cada disparador / tipo de objetivo */
const TRIGGER_FILTER_CONTEXTS: Record<string, string[]> = {
  'trigger-whatsapp-message': ['message'],
  'trigger-instagram-message': ['message'],
  'trigger-messenger-message': ['message'],
  'trigger-email-message': ['message'],
  'trigger-customer-replied': ['message'],
  'trigger-contact-updated': ['contact_change'],
  'trigger-appointment-booked': ['appointment'],
  'trigger-appointment-status': ['appointment'],
  'trigger-payment-received': ['payment'],
  'trigger-refund': ['payment'],
  'trigger-form-submitted': ['form'],
  'trigger-facebook-ad-click': ['ads'],
  'trigger-click-to-whatsapp': ['ads', 'message'],
  'trigger-facebook-comment': ['message'],
  'trigger-instagram-comment': ['message'],
  // Tipos de objetivo (reutilizan el mismo sistema de filtros)
  'goal-payment': ['payment'],
  'goal-appointment': ['appointment'],
  'goal-form': ['form'],
  'goal-conversation': ['message'],
  'goal-ads': ['ads']
}

const TRIGGER_FILTER_CONTEXT_EXCLUSIONS: Record<string, string[]> = {
  'trigger-contact-tag': ['tag'],
  'trigger-customer-replied': ['channel'],
  'trigger-payment-received': ['payment_status'],
  'trigger-refund': ['payment_status', 'amount'],
  'trigger-facebook-comment': ['channel'],
  'trigger-instagram-comment': ['channel'],
  'trigger-click-to-whatsapp': ['channel'],
  'goal-tag': ['tag'],
  'goal-payment': ['payment_status', 'amount'],
  'goal-conversation': ['channel']
}

/** Campos de filtro congruentes con el disparador: los del evento + contacto */
export function filterFieldsFor(contextKey?: string, excludedFieldIds: string[] = []): TriggerFilterField[] {
  const contexts = (contextKey && TRIGGER_FILTER_CONTEXTS[contextKey]) || []
  const excluded = new Set([
    ...((contextKey && TRIGGER_FILTER_CONTEXT_EXCLUSIONS[contextKey]) || []),
    ...excludedFieldIds
  ])
  return TRIGGER_FILTER_FIELDS.filter(
    (field) =>
      !excluded.has(field.id) &&
      (!field.appliesTo || field.appliesTo.some((context) => contexts.includes(context)))
  )
}

export function triggerOperatorsForField(field?: TriggerFilterField): typeof TRIGGER_FILTER_OPERATORS {
  if (!field?.operators?.length) {
    if (field?.type === 'number') {
      return TRIGGER_FILTER_OPERATORS.filter((operator) =>
        ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'].includes(operator.value)
      )
    }
    if (field?.type === 'boolean') {
      return TRIGGER_FILTER_OPERATORS.filter((operator) => ['yes', 'no'].includes(operator.value))
    }
    return TRIGGER_FILTER_OPERATORS.filter((operator) =>
      !['is_disqualified', 'not_disqualified', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'yes', 'no'].includes(operator.value)
    )
  }
  return TRIGGER_FILTER_OPERATORS.filter((operator) => field.operators?.includes(operator.value))
}

export function asTriggerFilters(value: unknown): TriggerFilter[] {
  return Array.isArray(value) ? (value as TriggerFilter[]) : []
}

export function validateTriggerFilters(value: unknown): string[] {
  const errors: string[] = []
  asTriggerFilters(value).forEach((filter, index) => {
    const field = filter.field ? TRIGGER_FILTER_FIELDS.find((candidate) => candidate.id === filter.field) : undefined
    const operators = triggerOperatorsForField(field)
    if (!filter.field) errors.push(`Filtro ${index + 1}: elige el campo`)
    else if (!field) errors.push(`Filtro ${index + 1}: el campo seleccionado ya no existe`)
    else if (field.needsCustomKey && !filter.customKey) {
      errors.push(`Filtro ${index + 1}: ${filter.field === 'form_field' ? 'elige la pregunta del formulario' : 'elige el campo personalizado'}`)
    }
    else if (!filter.match) errors.push(`Filtro ${index + 1}: elige qué debe pasar`)
    else if (!operators.some((operator) => operator.value === filter.match)) errors.push(`Filtro ${index + 1}: elige una condición válida`)
    if (filter.match && triggerOperatorNeedsValue(filter.match) && !String(filter.value || '').trim()) {
      errors.push(`Filtro ${index + 1}: captura el valor`)
    }
  })
  return errors
}

/** ' y la fuente es igual a "Facebook" y el país NO es igual a "México"' */
export function triggerFiltersSentence(value: unknown): string {
  return asTriggerFilters(value)
    .filter(
      (filter) =>
        filter.field &&
        filter.match &&
        (!triggerOperatorNeedsValue(filter.match) || String(filter.value || '').trim()) &&
        (!TRIGGER_FILTER_FIELDS.find((candidate) => candidate.id === filter.field)?.needsCustomKey || Boolean(filter.customKey))
    )
    .map((filter) => {
      const field = TRIGGER_FILTER_FIELDS.find((candidate) => candidate.id === filter.field)
      const phrase = field?.needsCustomKey && (filter.customLabel || filter.customKey)
        ? `${filter.field === 'form_field' ? 'la respuesta de' : 'el campo'} "${filter.customLabel || filter.customKey}"`
        : field?.phrase || 'el campo'
      if (filter.field === 'form_disqualified') {
        const joiner = filter.connector === 'or' ? ' o ' : ' y '
        return `${joiner}${phrase} ${filter.match === 'not_disqualified' ? 'no es descalificado' : 'es descalificado'}`
      }
      const verbs: Record<string, string> = {
        is: 'es igual a',
        not: 'NO es igual a',
        eq: 'es igual a',
        neq: 'NO es igual a',
        gt: 'es mayor que',
        gte: 'es mayor o igual que',
        lt: 'es menor que',
        lte: 'es menor o igual que',
        contains: 'contenga',
        not_contains: 'NO contenga',
        starts_with: 'empiece con',
        ends_with: 'termine con',
        empty: 'esté vacío',
        not_empty: 'no esté vacío',
        yes: 'sea sí',
        no: 'sea no',
        is_disqualified: 'es descalificado',
        not_disqualified: 'no es descalificado'
      }
      const joiner = filter.connector === 'or' ? ' o ' : ' y '
      const valuePart = triggerOperatorNeedsValue(filter.match)
        ? ` "${triggerFilterDisplayValue(field, filter)}"`
        : ''
      return `${joiner}${phrase} ${verbs[filter.match as TriggerFilterMatch] || 'es igual a'}${valuePart}`
    })
    .join('')
}
