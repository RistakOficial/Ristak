import type { PermissionKey } from '@/utils/accessControl'

// Definición única de las secciones de Configuración.
// La consume el Sidebar (grupo expandible) y debe mantenerse en sincronía
// con las rutas declaradas en Settings.tsx.
export interface SettingsNavChildItem {
  to: string
  label: string
  permissionKey?: PermissionKey
  /** true => activo solo con coincidencia exacta de ruta */
  end?: boolean
}

export interface SettingsNavItem {
  to: string
  label: string
  permissionKey?: PermissionKey
  children?: SettingsNavChildItem[]
}

export const settingsNavigation: SettingsNavItem[] = [
  { to: '/settings/account', label: 'Cuenta', permissionKey: 'settings_account' },
  { to: '/settings/users-access', label: 'Usuarios y accesos', permissionKey: 'settings_users' },
  { to: '/settings/mobile-app', label: 'Aplicación móvil', permissionKey: 'settings_mobile' },
  { to: '/settings/calendars', label: 'Calendarios', permissionKey: 'settings_calendars' },
  { to: '/settings/payments', label: 'Pagos', permissionKey: 'settings_payments' },
  { to: '/settings/highlevel', label: 'HighLevel', permissionKey: 'settings_integrations' },
  { to: '/settings/meta-ads', label: 'Meta', permissionKey: 'campaigns' },
  { to: '/settings/whatsapp', label: 'WhatsApp', permissionKey: 'settings_whatsapp' },
  { to: '/settings/email', label: 'Correos', permissionKey: 'settings_email' },
  { to: '/settings/tracking', label: 'Rastreo Web', permissionKey: 'settings_tracking' },
  { to: '/settings/domains', label: 'Dominios', permissionKey: 'settings_domains' },
  { to: '/settings/costs', label: 'Costos', permissionKey: 'settings_costs' },
  { to: '/settings/custom-fields', label: 'Campos personalizados', permissionKey: 'settings_custom_fields' },
  { to: '/settings/variable-fields', label: 'Campos variables', permissionKey: 'settings_custom_fields' },
  { to: '/settings/trigger-links', label: 'Enlaces de disparo', permissionKey: 'settings_custom_fields' },
  { to: '/settings/tags', label: 'Etiquetas', permissionKey: 'settings_custom_fields' },
  { to: '/settings/api-access', label: 'Acceso API', permissionKey: 'settings_api_access' }
]
