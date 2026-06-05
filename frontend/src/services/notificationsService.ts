import apiClient from './apiClient'

export type SystemNotificationSeverity = 'critical' | 'warning' | 'info' | string

export interface SystemNotification {
  id: string
  source: string
  severity: SystemNotificationSeverity
  title: string
  message?: string
  createdAt: string
  updatedAt: string
  actionUrl?: string
  actionLabel?: string
}

export interface SystemNotificationsResponse {
  summary: {
    total: number
    critical: number
    warning: number
    info: number
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
  })
}
