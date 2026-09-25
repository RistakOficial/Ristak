import type { ContactAdvancedField, ContactAdvancedFilterConfig, ContactAdvancedOption, ContactAdvancedRule } from './contactAdvancedFilterTypes'
export const NOTIFICATION_FILTER_TARGETS = [
  { key: 'contact_push_notification_filter', label: 'Todos los avisos de contactos' },
  { key: 'chat_push_contact_filter', label: 'Mensajes del chat' },
  { key: 'calendar_push_contact_filter', label: 'Citas y recordatorios' },
  { key: 'appointment_confirmation_push_contact_filter', label: 'Citas confirmadas' },
  { key: 'payment_push_contact_filter', label: 'Pagos' },
]
export interface NotificationFilterField extends ContactAdvancedField {
  field: string
  customKey?: string
  operators: ContactAdvancedOption[]
}
export interface NotificationFilterCatalog { groups: { label: string; fields: NotificationFilterField[] }[] }
export function emptyNotificationFilter(): ContactAdvancedFilterConfig { return { version: 1, groupMode: 'all', groups: [] } }
export function notificationRule(field: NotificationFilterField): ContactAdvancedRule {
  return { id: Math.random().toString(36).slice(2), field: field.field, operator: field.operators[0].value as ContactAdvancedRule['operator'], value: '', ...(field.customKey ? { customKey: field.customKey, valueType: field.type } : {}) }
}
export function notificationRuleField(rule: ContactAdvancedRule, catalog: NotificationFilterCatalog) {
  return catalog.groups.flatMap(g => g.fields).find(f => f.field === rule.field && (f.customKey || '') === (rule.customKey || ''))
}
