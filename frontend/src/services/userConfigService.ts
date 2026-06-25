// (MOB-006) Servicio de configuración de notificaciones POR USUARIO.
// Self: GET/POST /api/user-config (cada quien lo suyo). Admin: GET /api/user-config/admin
// y PATCH /api/user-config/admin/:userId (el admin ve/ajusta a todo el equipo).
import apiClient from './apiClient'

// Las 7 claves de notificaciones del celular personalizables por usuario.
export const USER_NOTIFICATION_KEYS = [
  'calendar_push_notifications_enabled',
  'appointment_confirmation_push_notifications_enabled',
  'chat_push_notifications_enabled',
  'payment_push_notifications_enabled',
  'push_notification_sound_enabled',
  'push_notification_vibration_enabled',
  'calendar_push_notification_calendar_ids'
] as const

export type UserNotificationKey = typeof USER_NOTIFICATION_KEYS[number]

// Valor efectivo de una clave para un usuario más el flag de si es override propio.
export interface UserConfigEntry {
  value: unknown
  isOverride: boolean
}

export interface AdminUserConfig {
  userId: string
  username: string
  fullName: string
  email: string
  role: string
  config: Record<string, UserConfigEntry>
}

interface AdminConfigResponse {
  success: boolean
  globals: Record<string, unknown>
  users: AdminUserConfig[]
}

interface PatchAdminResponse {
  success: boolean
  config: Record<string, UserConfigEntry>
}

export const userConfigService = {
  // El admin lee la config por-usuario de todo el equipo (globals + por usuario).
  async getTeamConfig(): Promise<{ globals: Record<string, unknown>; users: AdminUserConfig[] }> {
    const res = await apiClient.get<AdminConfigResponse>('/user-config/admin')
    return { globals: res.globals || {}, users: res.users || [] }
  },

  // El admin ajusta/limpia overrides de un usuario. value=null borra el override
  // (vuelve a heredar el global). Devuelve el estado efectivo resultante de ese usuario.
  async patchUserConfig(
    userId: string,
    config: Record<string, unknown>
  ): Promise<Record<string, UserConfigEntry>> {
    const res = await apiClient.patch<PatchAdminResponse>(`/user-config/admin/${userId}`, { config })
    return res.config || {}
  }
}
