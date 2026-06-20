import { db, getAppConfig } from '../config/database.js'

export const NOTIFICATION_PREFERENCES_CONFIG_KEY = 'notification_preferences_matrix'

const EVENT_ALIASES = {
  chat: 'conversations',
  conversation: 'conversations',
  conversations: 'conversations',
  appointment: 'appointments',
  appointments: 'appointments',
  calendar: 'appointments',
  payment: 'payments',
  payments: 'payments',
  automation: 'automation_internal',
  automation_internal: 'automation_internal',
  system: 'system'
}

const PUSH_CHANNELS = new Set(['push', 'app_push', 'all'])

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

function rowHasPushChannel(row = {}, eventKey = '') {
  return PUSH_CHANNELS.has(normalizeChannel(row[eventKey]))
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
