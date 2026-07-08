import {
  getFirstAllowedAppPath,
  hasModuleAccess,
  type AccessControlledUser,
  type PermissionKey
} from '@/utils/accessControl'

// Definición única de las secciones de Configuración.
// La consume la página de Configuración y debe mantenerse en sincronía con las
// rutas declaradas en Settings.tsx.
export type SettingsNavGroup =
  | 'Cuenta'
  | 'Agenda'
  | 'Cobros'
  | 'Plataformas conectadas'
  | 'Datos y rastreo'
  | 'Personalización'
  | 'Avanzado'

export interface SettingsNavItem {
  to: string
  label: string
  group: SettingsNavGroup
  permissionKey?: PermissionKey
}

export const settingsNavigation: SettingsNavItem[] = [
  { to: '/settings/account', label: 'Cuenta', group: 'Cuenta', permissionKey: 'settings_account' },
  { to: '/settings/users-access', label: 'Usuarios', group: 'Cuenta', permissionKey: 'settings_users' },
  { to: '/settings/notifications', label: 'Notificaciones', group: 'Cuenta', permissionKey: 'settings_account' },
  { to: '/settings/privacy', label: 'Privacidad', group: 'Cuenta', permissionKey: 'settings_account' },
  { to: '/settings/mobile-app', label: 'Aplicación móvil', group: 'Cuenta', permissionKey: 'settings_mobile' },
  { to: '/settings/calendars', label: 'Calendarios', group: 'Agenda', permissionKey: 'settings_calendars' },
  { to: '/settings/payments', label: 'Pagos', group: 'Cobros', permissionKey: 'settings_payments' },
  { to: '/settings/highlevel', label: 'HighLevel', group: 'Plataformas conectadas', permissionKey: 'settings_integrations' },
  { to: '/settings/meta-ads', label: 'Meta Ads', group: 'Plataformas conectadas', permissionKey: 'campaigns' },
  { to: '/settings/whatsapp', label: 'WhatsApp', group: 'Plataformas conectadas', permissionKey: 'settings_whatsapp' },
  { to: '/settings/email', label: 'Correos', group: 'Plataformas conectadas', permissionKey: 'settings_email' },
  { to: '/settings/tracking', label: 'Rastreo Web', group: 'Datos y rastreo', permissionKey: 'settings_tracking' },
  { to: '/settings/domains', label: 'Dominios', group: 'Datos y rastreo', permissionKey: 'settings_domains' },
  { to: '/settings/costs', label: 'Costos', group: 'Datos y rastreo', permissionKey: 'settings_costs' },
  { to: '/settings/media', label: 'Media', group: 'Datos y rastreo', permissionKey: 'settings_media' },
  { to: '/settings/custom-fields', label: 'Campos personalizados', group: 'Personalización', permissionKey: 'settings_custom_fields' },
  { to: '/settings/variable-fields', label: 'Campos variables', group: 'Personalización', permissionKey: 'settings_custom_fields' },
  { to: '/settings/trigger-links', label: 'Enlaces de disparo', group: 'Personalización', permissionKey: 'settings_custom_fields' },
  { to: '/settings/tags', label: 'Etiquetas', group: 'Personalización', permissionKey: 'settings_custom_fields' },
  { to: '/settings/developers', label: 'Developers', group: 'Avanzado', permissionKey: 'settings_api_access' }
]

export const settingsGroupOrder: SettingsNavGroup[] = [
  'Cuenta',
  'Agenda',
  'Cobros',
  'Plataformas conectadas',
  'Datos y rastreo',
  'Personalización',
  'Avanzado'
]

export const getVisibleSettingsNavigation = (user?: AccessControlledUser | null) =>
  settingsNavigation.filter((item) => !item.permissionKey || hasModuleAccess(user, item.permissionKey, 'read'))

export const getFirstAllowedSettingsPath = (user?: AccessControlledUser | null) =>
  getVisibleSettingsNavigation(user)[0]?.to || getFirstAllowedAppPath(user)
