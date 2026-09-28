import { DateTime } from 'luxon'
import { logger } from '../utils/logger.js'
import { db, getUserAppConfig, getAppConfig } from '../config/database.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { buildAdvancedRuleCondition } from './contactListFilterService.js'
import { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators } from '../../../shared/contactAdvancedFilterCatalog.js'

export const NOTIFICATION_CONTACT_FILTER_KEYS = [
  'contact_push_notification_filter',
  'chat_push_contact_filter',
  'calendar_push_contact_filter',
  'appointment_confirmation_push_contact_filter',
  'payment_push_contact_filter'
]
const fieldMap = new Map(CONTACT_ADVANCED_FIELD_GROUPS.flatMap(group => group.fields.map(field => [field.key, field])))
export const NOTIFICATION_CALENDAR_FIELD = { key: 'notification_calendar_id', field: 'notification_calendar_id', label: 'Calendario del aviso', type: 'select', catalog: 'calendars' }
fieldMap.set(NOTIFICATION_CALENDAR_FIELD.key, NOTIFICATION_CALENDAR_FIELD)
const noValue = new Set(['empty', 'not_empty', 'yes', 'no'])
const invalid = message => Object.assign(new Error(message), { statusCode: 400 })

// Unlike list drafts, delivery rules must never silently discard an unknown/incomplete condition.
export function validateNotificationContactFilter(raw, timezone = 'UTC') {
  let config = raw
  if (typeof raw === 'string') {
    if (raw.length > 128000) throw invalid('El filtro es demasiado grande.')
    try { config = JSON.parse(raw) } catch { throw invalid('El filtro no tiene un formato válido.') }
  }
  if (config?.version === 2) {
    if (!Array.isArray(config.clauses) || !config.clauses.length || config.clauses.length > 4 || JSON.stringify(config).length > 128000) throw invalid('El filtro de este aviso no es válido.')
    return { version: 2, clauses: config.clauses.map(clause => {
      if (clause?.version !== 1) throw invalid('Las condiciones del aviso no son válidas.')
      return validateNotificationContactFilter(clause, timezone)
    }) }
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
      if (field.key !== NOTIFICATION_CALENDAR_FIELD.key && !buildAdvancedRuleCondition(normalized, 'c', timezone)?.condition) throw invalid(`No se pudo interpretar la condición de ${field.label}.`)
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

const emptyFilter = () => ({ version: 1, groupMode: 'all', groups: [] })
const readFilter = (raw, timezone) => raw === null || raw === undefined || raw === '' ? emptyFilter() : validateNotificationContactFilter(raw, timezone)
const calendarKeys = new Set(['calendar_push_contact_filter', 'appointment_confirmation_push_contact_filter'])

export function validateNotificationFilterPreference(key, raw) {
  const filter = validateNotificationContactFilter(raw)
  if (key === NOTIFICATION_CONTACT_FILTER_KEYS[0] && filter.version !== 1) throw invalid('El filtro compartido requiere el formato anterior.')
  const clauses = filter.version === 2 ? filter.clauses : [filter]
  if (!calendarKeys.has(key) && clauses.some(clause => clause.groups.some(group => group.rules.some(rule => rule.field === NOTIFICATION_CALENDAR_FIELD.key)))) throw invalid('El calendario del aviso solo aplica a citas.')
  return filter
}

// Read-only upgrade preview. The first explicit save replaces this event's legacy
// restrictions without changing any other event or silently widening its scope.
export async function getEditableNotificationEventFilter(userId, key) {
  if (!NOTIFICATION_CONTACT_FILTER_KEYS.slice(1).includes(key)) throw invalid('Elige un tipo de aviso válido.')
  const timezone = await getAccountTimezone({ throwOnError: true })
  const event = readFilter(await getUserAppConfig(userId, key), timezone)
  if (event.version === 2) return event
  const general = readFilter(await getUserAppConfig(userId, NOTIFICATION_CONTACT_FILTER_KEYS[0]), timezone)
  if (general.version !== 1) throw invalid('El filtro compartido anterior no es válido.')
  const clauses = [general, event].filter(filter => filter.groups.length)
  if (calendarKeys.has(key)) {
    const calendarValues = await Promise.all([
      getAppConfig('calendar_push_notification_calendar_ids'),
      getUserAppConfig(userId, 'calendar_push_notification_calendar_ids')
    ])
    for (const raw of calendarValues) {
      let ids
      try { ids = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || [] } catch { throw invalid('La selección anterior de calendarios no es válida.') }
      if (!Array.isArray(ids)) throw invalid('La selección anterior de calendarios no es válida.')
      ids = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))]
      if (ids.length) clauses.push(validateNotificationContactFilter({ ...emptyFilter(), groups: [{ mode: 'any', rules: ids.map(value => ({ field: NOTIFICATION_CALENDAR_FIELD.key, operator: 'is', value })) }] }, timezone))
    }
  }
  const unique = [...new Map(clauses.map(clause => [JSON.stringify(clause), clause])).values()]
  return validateNotificationContactFilter({ version: 2, clauses: unique.length ? unique : [emptyFilter()] }, timezone)
}

export function buildNotificationFilterCondition(filter, timezone, calendarId) {
  const params = []
  const groups = filter.groups.map(group => {
    const rules = group.rules.map(rule => {
      if (rule.field === NOTIFICATION_CALENDAR_FIELD.key) {
        const target = String(calendarId || '')
        const met = rule.operator === 'empty' ? !target : rule.operator === 'not_empty' ? !!target
          : rule.operator === 'is' ? target === String(rule.value) : !!target && target !== String(rule.value)
        return met ? '1 = 1' : '1 = 0'
      }
      const built = buildAdvancedRuleCondition(rule, 'c', timezone)
      params.push(...(built.params || []))
      return built.condition
    })
    const condition = `(${rules.join(group.mode === 'any' ? ' OR ' : ' AND ')})`
    return group.negate ? `(NOT ${condition})` : condition
  })
  return { condition: groups.length ? `(${groups.join(filter.groupMode === 'any' ? ' OR ' : ' AND ')})` : '1 = 1', params }
}

// One resolver per delivery, shared by web + native devices. No stale cross-event cache.
export function createNotificationContactFilterResolver({ contactIds = [], enabledKey = '', category = '', calendarId = '' } = {}) {
  const results = new Map()
  const preferences = new Map()
  const matches = new Map()
  let timezonePromise
  const eventKey = notificationFilterKeyForEvent(enabledKey, category)
  const load = userId => {
    if (!preferences.has(userId)) preferences.set(userId, (async () => {
      timezonePromise ||= getAccountTimezone({ throwOnError: true })
      const timezone = await timezonePromise
      const event = readFilter(eventKey ? await getUserAppConfig(userId, eventKey) : null, timezone)
      if (event.version === 2) return { independent: true, filters: event.clauses, timezone }
      const general = readFilter(await getUserAppConfig(userId, NOTIFICATION_CONTACT_FILTER_KEYS[0]), timezone)
      if (general.version !== 1) throw invalid('El filtro compartido no es válido.')
      return { independent: false, filters: [general, event], timezone }
    })())
    return preferences.get(userId)
  }
  const resolve = userId => {
    if (!eventKey && !contactIds.length) return Promise.resolve(true)
    const id = String(userId || '')
    if (!results.has(id)) results.set(id, (async () => {
      const { filters, timezone } = await load(id)
      for (const filter of filters) {
        if (!filter.groups.length) continue
        const needsContact = filter.groups.some(group => group.rules.some(rule => rule.field !== NOTIFICATION_CALENDAR_FIELD.key))
        if (needsContact && !contactIds.length) return false
        const signature = JSON.stringify(filter)
        if (!matches.has(signature)) matches.set(signature, (async () => {
          const { condition, params } = buildNotificationFilterCondition(filter, timezone, calendarId)
          if (!needsContact) return Boolean(await db.get(`SELECT 1 AS allowed WHERE ${condition}`, params))
          // Every contact included in a combined alert must pass; never leak an excluded contact.
          for (const contactId of contactIds) {
            const row = await db.get(`SELECT c.id FROM contacts c WHERE c.deleted_at IS NULL AND (${condition}) AND c.id = ?`, [...params, contactId])
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
  resolve.isIndependent = async userId => eventKey ? (await load(String(userId || ''))).independent : false
  return resolve
}
