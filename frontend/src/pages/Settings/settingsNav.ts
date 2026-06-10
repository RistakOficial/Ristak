// Definición única de las secciones de Configuración.
// La consume el Sidebar (grupo expandible) y debe mantenerse en sincronía
// con las rutas declaradas en Settings.tsx.
export interface SettingsNavItem {
  to: string
  label: string
}

export const settingsNavigation: SettingsNavItem[] = [
  { to: '/settings/account', label: 'Cuenta' },
  { to: '/settings/mobile-app', label: 'Aplicación móvil' },
  { to: '/settings/calendars', label: 'Calendarios' },
  { to: '/settings/payments', label: 'Pagos' },
  { to: '/settings/highlevel', label: 'HighLevel' },
  { to: '/settings/meta-ads', label: 'Meta' },
  { to: '/settings/whatsapp', label: 'WhatsApp' },
  { to: '/settings/tracking', label: 'Rastreo Web' },
  { to: '/settings/domains', label: 'Dominios' },
  { to: '/settings/costs', label: 'Costos' },
  { to: '/settings/custom-fields', label: 'Campos personalizados' },
  { to: '/settings/ai-agent', label: 'Agente AI' },
  { to: '/settings/api-access', label: 'Acceso API' }
]
