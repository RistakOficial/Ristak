import { db, getAppConfig } from '../config/database.js'
// (MOB-002 / NOTI-004) Reutilizamos el mismo filtro de contactos ocultos que los listados
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

export const NOTIFICATION_PREFERENCES_CONFIG_KEY = 'notification_preferences_matrix'

const EVENT_ALIASES = {
  chat: 'conversations',
  conversation: 'conversations',
  conversations: 'conversations',
  appointment: 'appointments',
  appointments: 'appointments',
  appointment_booked: 'appointment_booked',
  appointment_scheduled: 'appointment_booked',
  appointment_created: 'appointment_booked',
  appointment_confirmed: 'appointment_confirmed',
  appointment_confirmation: 'appointment_confirmed',
  appointment_reminder: 'appointment_reminders',
  appointment_reminders: 'appointment_reminders',
  calendar: 'appointments',
  payment: 'payments',
  payments: 'payments',
  automation: 'automation_internal',
  automation_internal: 'automation_internal',
  agent_priority: 'agent_priority',
  priority: 'agent_priority',
  system: 'system'
}

const PUSH_CHANNELS = new Set(['push', 'app_push', 'all'])
const EVENT_FALLBACK_KEYS = {
  appointment_booked: ['appointments'],
  appointment_confirmed: ['appointments'],
  appointment_reminders: ['appointments'],
  agent_priority: ['conversations']
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function normalizeEventKey(eventKey = '') {
  return EVENT_ALIASES[String(eventKey || '').trim().toLowerCase()] || ''
}

function normalizeChannel(value = '') {
  return String(value || '').trim().toLowerCase()
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function hasOwnPreference(row = {}, eventKey = '') {
  return Object.prototype.hasOwnProperty.call(row, eventKey)
}

function rowHasPushChannel(row = {}, eventKey = '') {
  if (hasOwnPreference(row, eventKey)) {
    return PUSH_CHANNELS.has(normalizeChannel(row[eventKey]))
  }

  const fallbackKeys = EVENT_FALLBACK_KEYS[eventKey] || []
  return fallbackKeys.some((fallbackKey) => (
    hasOwnPreference(row, fallbackKey) && PUSH_CHANNELS.has(normalizeChannel(row[fallbackKey]))
  ))
}

async function getActiveUserIds(whereClause = '', params = []) {
  const rows = await db.all(
    `SELECT id FROM users WHERE is_active = 1 ${whereClause}`,
    params
  )
  return uniqueValues(rows.map((row) => row.id))
}

async function resolveExplicitUserIds(rowKeys = []) {
  const explicitUserIds = uniqueValues(rowKeys
    .filter((rowKey) => String(rowKey || '').startsWith('user:'))
    .map((rowKey) => String(rowKey).slice('user:'.length)))

  if (explicitUserIds.length === 0) return []

  const placeholders = explicitUserIds.map(() => '?').join(',')
  const rows = await db.all(
    `SELECT id FROM users WHERE is_active = 1 AND id IN (${placeholders})`,
    explicitUserIds
  )
  return uniqueValues(rows.map((row) => row.id))
}

export async function getNotificationPreferencesConfig() {
  const raw = await getAppConfig(NOTIFICATION_PREFERENCES_CONFIG_KEY).catch(() => null)
  const parsed = safeJsonParse(raw, null)
  if (!parsed || typeof parsed !== 'object' || !parsed.rows || typeof parsed.rows !== 'object') {
    return null
  }
  return parsed
}

export async function resolvePushNotificationTargetForEvent(eventKey = '') {
  const normalizedEventKey = normalizeEventKey(eventKey)
  if (!normalizedEventKey) {
    return { configured: false, userIds: null }
  }

  const config = await getNotificationPreferencesConfig()
  if (!config) {
    return { configured: false, userIds: null }
  }

  const enabledRowKeys = Object.entries(config.rows)
    .filter(([, row]) => row && typeof row === 'object' && rowHasPushChannel(row, normalizedEventKey))
    .map(([rowKey]) => String(rowKey || '').trim())
    .filter(Boolean)

  if (enabledRowKeys.length === 0) {
    return { configured: true, userIds: [] }
  }

  if (enabledRowKeys.includes('all')) {
    return { configured: true, userIds: null }
  }

  const [adminUserIds, explicitUserIds] = await Promise.all([
    enabledRowKeys.includes('admins')
      ? getActiveUserIds("AND role = 'admin'")
      : Promise.resolve([]),
    resolveExplicitUserIds(enabledRowKeys)
  ])

  return {
    configured: true,
    userIds: uniqueValues([...adminUserIds, ...explicitUserIds])
  }
}

// (MOB-002 / NOTI-004) Determina si un contacto coincide con algún filtro de "contactos ocultos".
// El push de chat re-exponía nombre + mensaje de contactos ocultos en la pantalla de bloqueo;
// antes de enviar verificamos visibilidad reutilizando la misma condición SQL de los listados.
// Fail-safe: ante error o datos faltantes asumimos OCULTO (no enviar) para no filtrar datos sensibles.
export async function isContactHiddenFromNotifications(contactId = '', { throwOnError = false } = {}) {
  const normalizedContactId = String(contactId || '').trim()
  if (!normalizedContactId) {
    // Sin contacto no podemos verificar visibilidad: tratamos como oculto para no arriesgar fuga.
    return true
  }

  try {
    const filters = await getHiddenContactFilters()
    if (!Array.isArray(filters) || filters.length === 0) {
      return false
    }

    // buildHiddenContactsCondition devuelve "NOT (...)" que deja pasar SOLO los visibles.
    const visibleCondition = buildHiddenContactsCondition(filters, 'c', false)
    if (!visibleCondition) {
      return false
    }

    const row = await db.get(
      `SELECT c.id FROM contacts c WHERE c.id = ? AND ${visibleCondition}`,
      [normalizedContactId]
    )
    // Si la query (que ya excluye ocultos) no devuelve la fila, el contacto está oculto.
    return !row
  } catch (error) {
    // Ante cualquier error de DB preferimos no enviar el push de un contacto potencialmente oculto.
    if (throwOnError) throw error
    return true
  }
}
