import type { ContactAdvancedField, ContactAdvancedFilterConfig, ContactAdvancedOption, ContactAdvancedRule } from './contactAdvancedFilterTypes'
export const NOTIFICATION_FILTER_TARGETS = [
  { key: 'chat_push_contact_filter', label: 'Mensajes del chat' },
  { key: 'calendar_push_contact_filter', label: 'Citas agendadas' },
  { key: 'appointment_confirmation_push_contact_filter', label: 'Citas confirmadas' },
  { key: 'payment_push_contact_filter', label: 'Pagos' },
]
export interface NotificationFilterField extends ContactAdvancedField {
  field: string
  customKey?: string
  operators: ContactAdvancedOption[]
}
export interface NotificationFilterCatalog { groups: { label: string; fields: NotificationFilterField[] }[] }
// Clauses are ANDed. Legacy shared/calendar restrictions become visible, editable
// clauses on first save; new event filters have a single clause.
export interface NotificationEventFilter { version: 2; clauses: ContactAdvancedFilterConfig[] }
export function emptyNotificationEventFilter(): NotificationEventFilter { return { version: 2, clauses: [emptyNotificationFilter()] } }
export function notificationConditionCount(value: unknown): number {
  try {
    const filter = typeof value === 'string' ? JSON.parse(value) : value
    const clauses = filter?.version === 2 ? filter.clauses : [filter]
    return clauses.reduce((count: number, clause: ContactAdvancedFilterConfig | undefined) => count + (clause?.groups || []).reduce((sum, group) => sum + group.rules.length, 0), 0)
  } catch { return 0 }
}
export function notificationFilterCatalogForTarget(catalog: NotificationFilterCatalog, key: string): NotificationFilterCatalog {
  const calendar = ['calendar_push_contact_filter', 'appointment_confirmation_push_contact_filter'].includes(key)
  return { groups: catalog.groups.map(group => ({ ...group, fields: group.fields.filter(field => calendar || field.field !== 'notification_calendar_id') })).filter(group => group.fields.length) }
}
export function removeNotificationRule(draft: ContactAdvancedFilterConfig, groupIndex: number, ruleIndex: number): ContactAdvancedFilterConfig {
  return { ...draft, groups: draft.groups.map((group, i) => i === groupIndex ? { ...group, rules: group.rules.filter((_, j) => j !== ruleIndex) } : group).filter(group => group.rules.length) }
}
export function emptyNotificationFilter(): ContactAdvancedFilterConfig { return { version: 1, groupMode: 'all', groups: [] } }
export function notificationRule(field: NotificationFilterField): ContactAdvancedRule {
  return { id: Math.random().toString(36).slice(2), field: field.field, operator: field.operators[0].value as ContactAdvancedRule['operator'], value: '', ...(field.customKey ? { customKey: field.customKey, valueType: field.type } : {}) }
}
export function notificationRuleField(rule: ContactAdvancedRule, catalog: NotificationFilterCatalog) {
  return catalog.groups.flatMap(g => g.fields).find(f => f.field === rule.field && (f.customKey || '') === (rule.customKey || ''))
}
