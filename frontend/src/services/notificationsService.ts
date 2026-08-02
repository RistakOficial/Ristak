import apiClient from './apiClient'

export type SystemNotificationSeverity = 'critical' | 'warning' | 'info' | string

export interface SystemNotification {
  id: string
  readKey: string
  version: string
  source: string
  severity: SystemNotificationSeverity
  title: string
  message?: string
  createdAt: string
  updatedAt: string
  actionUrl?: string
  actionLabel?: string
  isRead: boolean
  readAt?: string | null
}

export interface SystemNotificationsResponse {
  summary: {
    total: number
    critical: number
    warning: number
    info: number
    unread: number
    highestSeverity?: string
  }
  items: SystemNotification[]
  generatedAt: string
}

export const notificationsService = {
  getNotifications: (options?: { liveMetaCheck?: boolean; limit?: number }) => apiClient.get<SystemNotificationsResponse>('/settings/notifications', {
    params: {
      liveMetaCheck: options?.liveMetaCheck === false ? '0' : '1',
      limit: String(options?.limit || 30)
    }
  }),
  markRead: (notifications: SystemNotification[]) => apiClient.post<{ marked: number }>('/settings/notifications/read', {
    notifications: notifications.map(({ readKey, version }) => ({ readKey, version }))
  }),
  markAllRead: (notifications: SystemNotification[]) => apiClient.post<{ marked: number }>('/settings/notifications/read-all', {
    notifications: notifications.map(({ readKey, version }) => ({ readKey, version }))
  })
}
