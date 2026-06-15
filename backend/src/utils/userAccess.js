export const USER_ROLES = ['admin', 'employee']

export const ACCESS_LEVELS = ['none', 'read', 'write']

export const ACCESS_MODULES = [
  'dashboard',
  'appointments',
  'payments',
  'contacts',
  'reports',
  'analytics',
  'campaigns',
  'automations',
  'sites',
  'ai_agent',
  'settings_account',
  'settings_mobile',
  'settings_calendars',
  'settings_payments',
  'settings_integrations',
  'settings_whatsapp',
  'settings_email',
  'settings_tracking',
  'settings_domains',
  'settings_costs',
  'settings_media',
  'settings_custom_fields',
  'settings_api_access',
  'settings_users'
]

const ACCESS_MODULE_SET = new Set(ACCESS_MODULES)
const ACCESS_LEVEL_SET = new Set(ACCESS_LEVELS)

export function normalizeUserRole(role) {
  return role === 'admin' ? 'admin' : 'employee'
}

export function parseAccessConfig(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value

  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function normalizeAccessConfig(value, role = 'employee') {
  const normalizedRole = normalizeUserRole(role)
  const source = parseAccessConfig(value)
  const access = {}

  for (const moduleKey of ACCESS_MODULES) {
    if (moduleKey === 'settings_account') {
      access[moduleKey] = 'write'
      continue
    }

    if (moduleKey === 'settings_users') {
      access[moduleKey] = normalizedRole === 'admin' ? 'write' : 'none'
      continue
    }

    const level = String(source[moduleKey] || '').toLowerCase()
    access[moduleKey] = ACCESS_LEVEL_SET.has(level) ? level : 'none'
  }

  return access
}

export function getEffectiveAccessConfig(user = {}) {
  const role = normalizeUserRole(user.role)

  if (role === 'admin') {
    return Object.fromEntries(ACCESS_MODULES.map((moduleKey) => [moduleKey, 'write']))
  }

  return normalizeAccessConfig(user.access_config ?? user.accessConfig, role)
}

export function hasUserAccess(user = {}, moduleKey, requiredLevel = 'read') {
  if (!ACCESS_MODULE_SET.has(moduleKey)) return false

  const role = normalizeUserRole(user.role)
  if (role === 'admin') return true

  if (moduleKey === 'settings_users') return false

  const access = getEffectiveAccessConfig(user)
  const currentLevel = access[moduleKey] || 'none'

  if (requiredLevel === 'write') return currentLevel === 'write'
  return currentLevel === 'read' || currentLevel === 'write'
}

export function serializeAccessConfig(value, role = 'employee') {
  return JSON.stringify(normalizeAccessConfig(value, role))
}
