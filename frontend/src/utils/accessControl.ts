export const ACCESS_LEVELS = ['none', 'read', 'write'] as const
export type AccessLevel = typeof ACCESS_LEVELS[number]

export const USER_ROLES = ['admin', 'employee'] as const
export type UserRole = typeof USER_ROLES[number]

export type PermissionGroup = 'CRM' | 'Operación' | 'Configuración'
export type LicenseFeatures = Record<string, boolean | undefined>

export const CALENDAR_PAYMENT_FEATURE_KEYS = [
  'calendar_payments',
  'calendar_payment',
  'calendar_booking_payments'
] as const

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
    key: 'chat',
    label: 'Chat',
    description: 'Bandeja de conversaciones y mensajes de WhatsApp.',
    group: 'CRM',
    path: '/chat'
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
    label: 'Chatbot',
    description: 'Configuración de Ristak AI y chatbots conversacionales.',
    group: 'Operación',
    path: '/ai-agent'
  },
  {
    key: 'settings_account',
    label: 'Perfil y negocio',
    description: 'Perfil propio, acceso y configuración del negocio.',
    group: 'Configuración',
    path: '/settings/profile'
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
    description: 'Integraciones, conexión CRM y configuración base.',
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
    description: 'Campos personalizados, variables y etiquetas.',
    group: 'Configuración',
    path: '/settings/custom-fields'
  },
  {
    key: 'settings_api_access',
    label: 'Developers',
    description: 'Webhooks, documentación, logs y credenciales API.',
    group: 'Configuración',
    path: '/settings/developers'
  },
  {
    key: 'settings_users',
    label: 'Usuarios',
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
  licenseEnforced?: boolean
  licensePlan?: string | null
  licenseFeaturesSourceValid?: boolean
  licenseFeatures?: LicenseFeatures | null
  licenseExternalModules?: Record<string, { sidebarPosition?: number | null }>
}

const MODULE_KEYS = new Set<PermissionKey>(ACCESS_MODULES.map((module) => module.key))
const hasOwn = Object.prototype.hasOwnProperty

export const AI_AGENT_NAV_ITEMS = [
  {
    to: '/ai-agent/conversational',
    label: 'Chatbot',
    exact: false,
    featureKeys: ['conversational_ai', 'ai']
  },
  {
    to: '/ai-agent/general',
    label: 'Configuracion',
    exact: true,
    featureKeys: ['app_assistant_ai', 'ai']
  }
] as const
export type AIAgentNavItem = typeof AI_AGENT_NAV_ITEMS[number]

type LicenseFeatureRule = {
  primary: string
  legacy?: readonly string[]
}

const LICENSE_FEATURES_BY_MODULE: Partial<Record<PermissionKey, LicenseFeatureRule>> = {
  dashboard: { primary: 'dashboard' },
  contacts: { primary: 'contacts' },
  chat: { primary: 'chat', legacy: ['whatsapp'] },
  appointments: { primary: 'appointments', legacy: ['google_calendar'] },
  payments: { primary: 'payments' },
  reports: { primary: 'reports', legacy: ['advanced_reports'] },
  analytics: { primary: 'analytics' },
  campaigns: { primary: 'campaigns', legacy: ['meta_ads'] },
  automations: { primary: 'automations' },
  sites: { primary: 'sites' },
  ai_agent: { primary: 'ai_agent', legacy: ['app_assistant_ai', 'conversational_ai', 'ai'] },
  settings_account: { primary: 'dashboard' },
  settings_mobile: { primary: 'mobile_app', legacy: ['settings_mobile'] },
  settings_calendars: { primary: 'appointments', legacy: ['google_calendar', 'settings_calendars'] },
  settings_payments: { primary: 'payments', legacy: ['settings_payments'] },
  settings_integrations: { primary: 'integrations', legacy: ['settings_integrations'] },
  settings_whatsapp: { primary: 'whatsapp', legacy: ['settings_whatsapp'] },
  settings_email: { primary: 'email', legacy: ['settings_email'] },
  settings_tracking: { primary: 'sites', legacy: ['settings_tracking'] },
  settings_domains: { primary: 'sites', legacy: ['settings_domains'] },
  settings_costs: { primary: 'reports', legacy: ['advanced_reports', 'settings_costs'] },
  settings_media: { primary: 'sites', legacy: ['settings_media'] },
  settings_api_access: { primary: 'developers', legacy: ['settings_api_access'] },
  settings_users: { primary: 'team_access', legacy: ['settings_users'] }
}

const LICENSE_FEATURE_LABELS: Record<string, string> = {
  dashboard_metrics: 'métricas del dashboard',
  contact_tags: 'etiquetas de contactos',
  contact_custom_data: 'datos personalizados de contactos',
  contact_import_export: 'importación y exportación de contactos',
  chat_inbox: 'bandeja de chat',
  message_templates: 'plantillas de mensajes',
  google_calendar: 'Google Calendar',
  calendar_payments: 'cobros en calendarios',
  calendar_payment: 'cobros en calendarios',
  calendar_booking_payments: 'cobros en calendarios',
  appointment_reminders: 'recordatorios de citas',
  calendar_blocks: 'bloqueos de calendario',
  payment_checkout: 'checkout de pagos',
  payment_receipts: 'comprobantes de pago',
  payment_automations: 'automatizaciones de pagos',
  payment_gateways: 'pasarelas de pago',
  highlevel_payments: 'pagos de HighLevel',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  payment_links: 'links de pago',
  saved_payment_methods: 'métodos de pago guardados',
  payment_plans: 'planes de pago',
  subscriptions: 'suscripciones',
  payment_taxes: 'impuestos de pago',
  payment_webhooks: 'webhooks de pago',
  advanced_reports: 'reportes avanzados',
  web_analytics: 'analíticas web',
  conversion_analytics: 'conversiones web',
  meta_ads: 'Meta',
  meta_pixel: 'Meta Pixel',
  meta_catalog: 'catálogo de Meta',
  site_builder: 'editor de sitios',
  site_publishing: 'publicación de sitios',
  site_forms: 'formularios de sitios',
  app_assistant_ai: 'Ristak AI',
  conversational_ai: 'Chatbot',
  automation_builder: 'constructor de automatizaciones',
  automation_runs: 'ejecuciones de automatizaciones',
  whatsapp_api: 'WhatsApp API',
  whatsapp_templates: 'plantillas de WhatsApp',
  email_smtp: 'envío de correos',
  email_templates: 'plantillas de correo',
  highlevel_integration: 'integración con HighLevel',
  api_keys: 'API Keys',
  webhooks: 'webhooks'
}

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
  // Compatibilidad: el Chat antes heredaba el permiso de Contactos. Si una config
  // guardada no trae la clave 'chat', conserva el acceso que tenía vía contactos.
  if (!accessConfig || accessConfig.chat === undefined) {
    normalized.chat = normalized.contacts
  }
  return normalized
}

export function getEffectiveAccessConfig(user?: AccessControlledUser | null): AccessConfig {
  const role = normalizeRole(user?.role)
  return normalizeAccessConfig(user?.accessConfig, role)
}

export function hasLicenseFeature(
  user: AccessControlledUser | null | undefined,
  featureKeys: readonly string[]
) {
  if (!user?.licenseEnforced) return true
  const features = user.licenseFeatures || {}
  return featureKeys.some((featureKey) => features[featureKey] === true)
}

export function hasProfessionalPlan(plan?: string | null) {
  const normalized = String(plan || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

  if (!normalized) return false
  if (normalized === 'pro' || normalized === 'professional' || normalized === 'profesional' || normalized === 'premium') {
    return true
  }

  return normalized.endsWith('_pro') ||
    normalized.endsWith('_professional') ||
    normalized.endsWith('_profesional') ||
    normalized.endsWith('_premium')
}

export function hasProfessionalFeatureAccess(
  user: AccessControlledUser | null | undefined,
  featureKeys: readonly string[]
) {
  if (!user?.licenseEnforced) return true
  if (user.licenseFeaturesSourceValid === false) return false

  return hasProfessionalPlan(user.licensePlan) && hasLicenseFeature(user, featureKeys)
}

export function hasWebAnalyticsAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['web_analytics'])
}

export function hasPaymentGatewaysAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_gateways'])
}

export function hasPaymentLinksAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_links'])
}

export function hasPaymentPlansAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_plans'])
}

export function hasSavedPaymentMethodsAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['saved_payment_methods'])
}

export function hasSubscriptionsAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['subscriptions'])
}

export function hasPaymentCheckoutAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_checkout'])
}

export function hasPaymentAutomationsAccess(user: AccessControlledUser | null | undefined) {
  return hasProfessionalFeatureAccess(user, ['payment_automations'])
}

export function hasCalendarPaymentsAccess(user: AccessControlledUser | null | undefined) {
  if (!user?.licenseEnforced) return true
  const features = user.licenseFeatures || {}
  const hasExplicitCalendarPaymentFeature = CALENDAR_PAYMENT_FEATURE_KEYS.some((featureKey) => hasOwn.call(features, featureKey))
  if (hasExplicitCalendarPaymentFeature) {
    return CALENDAR_PAYMENT_FEATURE_KEYS.some((featureKey) => features[featureKey] === true)
  }
  if (user.licenseFeaturesSourceValid === false) return false

  return features.google_calendar === true || hasProfessionalPlan(user.licensePlan)
}

export function hasLicenseFeatureAccess(
  user: AccessControlledUser | null | undefined,
  moduleKey: PermissionKey
) {
  if (!user?.licenseEnforced) return true

  const rule = LICENSE_FEATURES_BY_MODULE[moduleKey]
  if (!rule) return true

  const features = user.licenseFeatures || {}
  if (hasOwn.call(features, moduleKey)) {
    return features[moduleKey] === true
  }

  if (hasOwn.call(features, rule.primary)) {
    return features[rule.primary] === true
  }

  if (rule.legacy?.length) {
    return rule.legacy.some((featureKey) => features[featureKey] === true)
  }

  return false
}

export function getLicenseFeatureLabel(feature: unknown) {
  const key = String(feature || '').trim()
  if (!key) return null

  const module = ACCESS_MODULES.find((item) => item.key === key)
  if (module) return module.label

  return LICENSE_FEATURE_LABELS[key] || key.replace(/_/g, ' ')
}

export function hasModuleAccess(
  user: AccessControlledUser | null | undefined,
  moduleKey: PermissionKey,
  requiredLevel: 'read' | 'write' = 'read'
) {
  if (!hasLicenseFeatureAccess(user, moduleKey)) return false
  if (normalizeRole(user?.role) === 'admin') return true
  if (moduleKey === 'settings_users') return false

  const access = getEffectiveAccessConfig(user)
  const level = access[moduleKey] || 'none'
  return requiredLevel === 'write' ? level === 'write' : level === 'read' || level === 'write'
}

export const ROUTE_ACCESS: Array<{ prefix: string; moduleKey: PermissionKey }> = [
  { prefix: '/settings/users-access', moduleKey: 'settings_users' },
  { prefix: '/settings/hidden-contacts', moduleKey: 'contacts' },
  { prefix: '/settings/profile', moduleKey: 'settings_account' },
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
  { prefix: '/settings/developers', moduleKey: 'settings_api_access' },
  { prefix: '/settings/api-access', moduleKey: 'settings_api_access' },
  { prefix: '/api-docs', moduleKey: 'settings_api_access' },
  { prefix: '/dashboard', moduleKey: 'dashboard' },
  { prefix: '/chat', moduleKey: 'chat' },
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

export function getFirstAllowedAIAgentPath(user?: AccessControlledUser | null) {
  const firstSection = AI_AGENT_NAV_ITEMS.find((item) => hasLicenseFeature(user, item.featureKeys))
  return firstSection?.to || getFirstAllowedAppPath(user)
}
