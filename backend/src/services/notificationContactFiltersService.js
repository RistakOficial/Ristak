import { DateTime } from 'luxon'
import { logger } from '../utils/logger.js'
import { db, getUserAppConfig } from '../config/database.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { buildAdvancedRuleCondition, buildContactListWhere } from './contactListFilterService.js'
import { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators } from '../../../shared/contactAdvancedFilterCatalog.js'

export const NOTIFICATION_CONTACT_FILTER_KEYS = [
  'contact_push_notification_filter',
  'chat_push_contact_filter',
  'calendar_push_contact_filter',
  'appointment_confirmation_push_contact_filter',
  'payment_push_contact_filter'
]
const fieldMap = new Map(CONTACT_ADVANCED_FIELD_GROUPS.flatMap(group => group.fields.map(field => [field.key, field])))
const noValue = new Set(['empty', 'not_empty', 'yes', 'no'])
const invalid = message => Object.assign(new Error(message), { statusCode: 400 })

// Unlike list drafts, delivery rules must never silently discard an unknown/incomplete condition.
export function validateNotificationContactFilter(raw, timezone = 'UTC') {
  let config = raw
  if (typeof raw === 'string') {
    if (raw.length > 32000) throw invalid('El filtro es demasiado grande.')
    try { config = JSON.parse(raw) } catch { throw invalid('El filtro no tiene un formato válido.') }
  }
  if (!config || config.version !== 1 || !Array.isArray(config.groups) || config.groups.length > 10 || !['all', 'any'].includes(config.groupMode)) {
    throw invalid('El filtro debe tener bloques válidos de condiciones.')
  }
  if (JSON.stringify(config).length > 32000) throw invalid('El filtro es demasiado grande.')
  let count = 0
  const groups = config.groups.map((group, gi) => {
    if (!group || !['all', 'any'].includes(group.mode) || !Array.isArray(group.rules) || !group.rules.length || (group.negate !== undefined && typeof group.negate !== 'boolean')) throw invalid('Completa o elimina los bloques vacíos.')
    const rules = group.rules.map((rule, ri) => {
      if (++count > 50) throw invalid('Puedes guardar hasta 50 condiciones por filtro.')
      const field = fieldMap.get(rule?.field)
      if (!field) throw invalid('Selecciona un campo disponible.')
      const type = field.type === 'custom_field' ? rule.valueType : field.type
      if (!['text', 'number', 'date', 'boolean', 'select', 'tags'].includes(type) || (field.type === 'custom_field' && type === 'tags')) throw invalid('El tipo del campo no es válido.')
      const operators = getContactAdvancedOperators({ ...field, type })
      if (!operators.some(option => option.value === rule.operator)) throw invalid(`La condición de ${field.label} no es válida.`)
      if (field.type === 'custom_field' && (typeof rule.customKey !== 'string' || !rule.customKey.trim() || rule.customKey.length > 180)) throw invalid('Selecciona el campo personalizado.')
      if (!noValue.has(rule.operator)) {
        const values = Array.isArray(rule.value) ? rule.value : [rule.value]
        if (!values.length || values.length > 50 || values.some(v => !['string', 'number', 'boolean'].includes(typeof v) || !String(v).trim() || String(v).length > 500)) throw invalid(`Completa el valor de ${field.label}.`)
        if (type !== 'tags' && Array.isArray(rule.value)) throw invalid('Esta condición requiere un solo valor.')
        if (rule.operator === 'between' && (rule.valueTo === null || rule.valueTo === undefined || !String(rule.valueTo).trim())) throw invalid('Completa los dos extremos del rango.')
        const bounds = rule.operator === 'between' ? [rule.value, rule.valueTo] : values
        if (type === 'number' && bounds.some(v => !Number.isFinite(Number(String(v).replace(/,/g, ''))))) throw invalid('Escribe un número válido.')
        if (type === 'date') {
          if (['last_days', 'older_days'].includes(rule.operator)) {
            if (!Number.isInteger(Number(rule.value)) || Number(rule.value) < 1 || Number(rule.value) > 36500) throw invalid('Escribe una cantidad válida de días.')
          } else if (bounds.some(v => !/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || !DateTime.fromISO(String(v), { zone: timezone }).isValid)) throw invalid('Usa una fecha válida con formato AAAA-MM-DD.')
        }
      }
      const normalized = { id: `rule_${gi}_${ri}`, field: field.key, operator: rule.operator, ...(rule.value !== undefined ? { value: rule.value } : {}), ...(rule.valueTo !== undefined ? { valueTo: rule.valueTo } : {}), ...(field.type === 'custom_field' ? { customKey: rule.customKey, valueType: type } : {}) }
      if (!buildAdvancedRuleCondition(normalized, 'c', timezone)?.condition) throw invalid(`No se pudo interpretar la condición de ${field.label}.`)
      return normalized
    })
    return { id: `group_${gi}`, mode: group.mode, negate: Boolean(group.negate), rules }
  })
  return { version: 1, groupMode: config.groupMode, groups }
}

export function notificationFilterKeyForEvent(enabledKey = '', category = '') {
  const keys = {
    chat_push_notifications_enabled: 'chat_push_contact_filter',
    calendar_push_notifications_enabled: 'calendar_push_contact_filter',
    appointment_confirmation_push_notifications_enabled: 'appointment_confirmation_push_contact_filter',
    payment_push_notifications_enabled: 'payment_push_contact_filter'
  }
  if (keys[enabledKey]) return keys[enabledKey]
  if (['chat', 'conversations', 'agent_priority'].includes(category)) return keys.chat_push_notifications_enabled
  if (category === 'appointment_confirmed') return keys.appointment_confirmation_push_notifications_enabled
  if (category.startsWith('appointment') || category === 'calendar') return keys.calendar_push_notifications_enabled
  if (['payment', 'payments'].includes(category)) return keys.payment_push_notifications_enabled
  return null
}

// One resolver per delivery, shared by web + native devices. No stale cross-event cache.
export function createNotificationContactFilterResolver({ contactIds = [], enabledKey = '', category = '' } = {}) {
  const results = new Map()
  const matches = new Map()
  let timezonePromise
  const eventKey = notificationFilterKeyForEvent(enabledKey, category)
  return userId => {
    if (!eventKey && !contactIds.length) return Promise.resolve(true)
    const id = String(userId || '')
    if (!results.has(id)) results.set(id, (async () => {
      const keys = [NOTIFICATION_CONTACT_FILTER_KEYS[0], ...(eventKey ? [eventKey] : [])]
      const rawFilters = await Promise.all(keys.map(key => getUserAppConfig(id, key)))
      for (const raw of rawFilters) {
        if (raw === null || raw === undefined || raw === '') continue
        timezonePromise ||= getAccountTimezone({ throwOnError: true })
        const timezone = await timezonePromise
        const filter = validateNotificationContactFilter(raw, timezone)
        if (!filter.groups.length) continue
        if (!contactIds.length) return false
        const signature = JSON.stringify(filter)
        if (!matches.has(signature)) matches.set(signature, (async () => {
          const { whereClause, params } = buildContactListWhere({ alias: 'c', advancedFilters: filter, timezone })
          // Every contact included in a combined alert must pass; never leak an excluded contact.
          for (const contactId of contactIds) {
            const row = await db.get(`SELECT c.id FROM contacts c ${whereClause} AND c.id = ?`, [...params, contactId])
            if (!row) return false
          }
          return true
        })())
        if (!(await matches.get(signature))) return false
      }
      return true
    })().catch(error => {
      // A damaged preference must not silence other recipients or leak its contact.
      // Database/availability failures still propagate so durable delivery can retry.
      if (error.statusCode !== 400) throw error
      logger.warn('[Push] Filtro de contacto inválido; se omite solo este destinatario', { userId: id })
      return false
    }))
    return results.get(id)
  }
}
