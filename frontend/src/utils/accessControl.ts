export const ACCESS_LEVELS = ['none', 'read', 'write'] as const
export type AccessLevel = typeof ACCESS_LEVELS[number]

export const USER_ROLES = ['admin', 'employee'] as const
export type UserRole = typeof USER_ROLES[number]

export type PermissionGroup = 'CRM' | 'Operación' | 'Configuración'

export const ACCESS_MODULES = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    description: 'Resumen general del negocio.',
    group: 'CRM',
    path: '/dashboard'
  },
  {
    key: 'appointments',
    label: 'Citas',
    description: 'Calendario, citas y bloqueos.',
    group: 'CRM',
    path: '/appointments'
  },
  {
    key: 'payments',
    label: 'Pagos',
    description: 'Ventas, cobros y transacciones.',
    group: 'CRM',
    path: '/transactions'
  },
  {
    key: 'contacts',
    label: 'Contactos',
    description: 'Lista de contactos, etiquetas y seguimiento.',
    group: 'CRM',
    path: '/contacts'
  },
  {
    key: 'reports',
    label: 'Reportes',
    description: 'Tablas, métricas y gastos manuales.',
    group: 'Operación',
    path: '/reports/table/month/cashflow'
  },
  {
    key: 'analytics',
    label: 'Analíticas',
    description: 'Sesiones, visitantes y conversiones web.',
    group: 'Operación',
    path: '/analytics'
  },
  {
    key: 'campaigns',
    label: 'Publicidad / Meta',
    description: 'Campañas, métricas y conexión Meta.',
    group: 'Operación',
    path: '/campaigns/classic'
  },
  {
    key: 'automations',
    label: 'Automatizaciones',
    description: 'Flujos, carpetas y ejecuciones.',
    group: 'Operación',
    path: '/automations'
  },
  {
    key: 'sites',
    label: 'Sitios',
    description: 'Páginas, dominios y formularios públicos.',
    group: 'Operación',
    path: '/sites'
  },
  {
    key: 'ai_agent',
    label: 'Agente AI',
    description: 'Configuración y uso de agentes internos.',
    group: 'Operación',
    path: '/ai-agent/general'
  },
  {
    key: 'settings_account',
    label: 'Cuenta',
    description: 'Perfil propio, contraseña y ajustes personales.',
    group: 'Configuración',
    path: '/settings/account'
  },
  {
    key: 'settings_mobile',
    label: 'Aplicación móvil',
    description: 'Guía y acceso móvil.',
    group: 'Configuración',
    path: '/settings/mobile-app'
  },
  {
    key: 'settings_calendars',
    label: 'Configuración de calendarios',
    description: 'Calendarios, Google Calendar y sincronización.',
    group: 'Configuración',
    path: '/settings/calendars'
  },
  {
    key: 'settings_payments',
    label: 'Configuración de pagos',
    description: 'Pasarelas, productos y ajustes de cobro.',
    group: 'Configuración',
    path: '/settings/payments'
  },
  {
    key: 'settings_integrations',
    label: 'Integraciones',
    description: 'HighLevel, conexión CRM y configuración base.',
    group: 'Configuración',
    path: '/settings/highlevel'
  },
  {
    key: 'settings_whatsapp',
    label: 'WhatsApp',
    description: 'WhatsApp API, plantillas y números.',
    group: 'Configuración',
    path: '/settings/whatsapp'
  },
  {
    key: 'settings_email',
    label: 'Correos',
    description: 'Cuenta de envío y pruebas de correo.',
    group: 'Configuración',
    path: '/settings/email'
  },
  {
    key: 'settings_tracking',
    label: 'Rastreo Web',
    description: 'Pixel, tracking y sesiones web.',
    group: 'Configuración',
    path: '/settings/tracking'
  },
  {
    key: 'settings_domains',
    label: 'Dominios',
    description: 'Dominios públicos y verificación.',
    group: 'Configuración',
    path: '/settings/domains'
  },
  {
    key: 'settings_costs',
    label: 'Costos',
    description: 'Costos fijos y variables del negocio.',
    group: 'Configuración',
    path: '/settings/costs'
  },
  {
    key: 'settings_media',
    label: 'Media',
    description: 'Explorador de archivos multimedia guardados en storage.',
    group: 'Configuración',
    path: '/settings/media'
  },
  {
    key: 'settings_custom_fields',
    label: 'Campos y etiquetas',
    description: 'Campos personalizados, variables, enlaces y etiquetas.',
    group: 'Configuración',
    path: '/settings/custom-fields'
  },
  {
    key: 'settings_api_access',
    label: 'Acceso API',
    description: 'Tokens y documentación de API.',
    group: 'Configuración',
    path: '/settings/api-access'
  },
  {
    key: 'settings_users',
    label: 'Usuarios y accesos',
    description: 'Personas, roles y permisos del CRM.',
    group: 'Configuración',
    path: '/settings/users-access'
  }
] as const

export type PermissionKey = typeof ACCESS_MODULES[number]['key']
export type AccessConfig = Record<PermissionKey, AccessLevel>

export interface AccessControlledUser {
  role?: UserRole | 'manager' | 'viewer' | string
  accessConfig?: Partial<Record<PermissionKey, AccessLevel>>
}

const MODULE_KEYS = new Set<PermissionKey>(ACCESS_MODULES.map((module) => module.key))

export const DEFAULT_EMPLOYEE_ACCESS: AccessConfig = Object.fromEntries(
  ACCESS_MODULES.map((module) => [module.key, module.key === 'settings_account' ? 'write' : 'none'])
) as AccessConfig

export const ADMIN_ACCESS: AccessConfig = Object.fromEntries(
  ACCESS_MODULES.map((module) => [module.key, 'write'])
) as AccessConfig

export function normalizeRole(role?: string): UserRole {
  return role === 'admin' ? 'admin' : 'employee'
}

export function normalizeAccessConfig(accessConfig?: Partial<Record<PermissionKey, AccessLevel>>, role: UserRole = 'employee'): AccessConfig {
  if (role === 'admin') return { ...ADMIN_ACCESS }

  const normalized = { ...DEFAULT_EMPLOYEE_ACCESS }
  Object.entries(accessConfig || {}).forEach(([rawKey, rawLevel]) => {
    const key = rawKey as PermissionKey
    if (!MODULE_KEYS.has(key)) return
    if (!ACCESS_LEVELS.includes(rawLevel as AccessLevel)) return
    if (key === 'settings_users') return
    normalized[key] = rawLevel as AccessLevel
  })
  normalized.settings_account = 'write'
  normalized.settings_users = 'none'
  return normalized
}

export function getEffectiveAccessConfig(user?: AccessControlledUser | null): AccessConfig {
  const role = normalizeRole(user?.role)
  return normalizeAccessConfig(user?.accessConfig, role)
}

export function hasModuleAccess(
  user: AccessControlledUser | null | undefined,
  moduleKey: PermissionKey,
  requiredLevel: 'read' | 'write' = 'read'
) {
  if (normalizeRole(user?.role) === 'admin') return true
  if (moduleKey === 'settings_users') return false

  const access = getEffectiveAccessConfig(user)
  const level = access[moduleKey] || 'none'
  return requiredLevel === 'write' ? level === 'write' : level === 'read' || level === 'write'
}

export const ROUTE_ACCESS: Array<{ prefix: string; moduleKey: PermissionKey }> = [
  { prefix: '/settings/users-access', moduleKey: 'settings_users' },
  { prefix: '/settings/account', moduleKey: 'settings_account' },
  { prefix: '/settings/mobile-app', moduleKey: 'settings_mobile' },
  { prefix: '/settings/calendars', moduleKey: 'settings_calendars' },
  { prefix: '/settings/payments', moduleKey: 'settings_payments' },
  { prefix: '/settings/highlevel', moduleKey: 'settings_integrations' },
  { prefix: '/settings/meta-ads', moduleKey: 'campaigns' },
  { prefix: '/settings/whatsapp', moduleKey: 'settings_whatsapp' },
  { prefix: '/settings/email', moduleKey: 'settings_email' },
  { prefix: '/settings/tracking', moduleKey: 'settings_tracking' },
  { prefix: '/settings/domains', moduleKey: 'settings_domains' },
  { prefix: '/settings/costs', moduleKey: 'settings_costs' },
  { prefix: '/settings/media', moduleKey: 'settings_media' },
  { prefix: '/settings/custom-fields', moduleKey: 'settings_custom_fields' },
  { prefix: '/settings/variable-fields', moduleKey: 'settings_custom_fields' },
  { prefix: '/settings/trigger-links', moduleKey: 'settings_custom_fields' },
  { prefix: '/settings/tags', moduleKey: 'settings_custom_fields' },
  { prefix: '/settings/api-access', moduleKey: 'settings_api_access' },
  { prefix: '/api-docs', moduleKey: 'settings_api_access' },
  { prefix: '/dashboard', moduleKey: 'dashboard' },
  { prefix: '/appointments', moduleKey: 'appointments' },
  { prefix: '/transactions', moduleKey: 'payments' },
  { prefix: '/contacts', moduleKey: 'contacts' },
  { prefix: '/reports', moduleKey: 'reports' },
  { prefix: '/analytics', moduleKey: 'analytics' },
  { prefix: '/campaigns', moduleKey: 'campaigns' },
  { prefix: '/automations', moduleKey: 'automations' },
  { prefix: '/sites', moduleKey: 'sites' },
  { prefix: '/ai-agent', moduleKey: 'ai_agent' }
]

export function getRouteAccess(pathname: string): PermissionKey | null {
  const match = ROUTE_ACCESS
    .filter((item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]

  return match?.moduleKey || null
}

export function getFirstAllowedAppPath(user?: AccessControlledUser | null) {
  const firstModule = ACCESS_MODULES.find((module) => hasModuleAccess(user, module.key, 'read'))
  return firstModule?.path || '/settings/account'
}
