import apiClient from './apiClient'

export interface TriggerLink {
  id: string
  publicId: string
  name: string
  destinationUrl: string
  description: string
  active: boolean
  archived: boolean
  clickCount: number
  lastClickedAt: string | null
  publicUrl: string
  createdByUserId: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface TriggerLinkEvent {
  id: string
  triggerLinkId: string
  publicId: string
  contactId: string
  visitorId: string
  ipAddress: string
  userAgent: string
  referrer: string
  query: Record<string, unknown>
  createdAt: string | null
}

export interface SaveTriggerLinkInput {
  name: string
  destinationUrl: string
  description?: string
  active?: boolean
}

export const triggerLinksService = {
  list(params: { includeArchived?: boolean } = {}) {
    return apiClient.get<TriggerLink[]>('/settings/trigger-links', {
      params: params.includeArchived ? { includeArchived: 'true' } : undefined
    })
  },

  create(input: SaveTriggerLinkInput) {
    return apiClient.post<TriggerLink>('/settings/trigger-links', input)
  },

  update(triggerLinkId: string, input: Partial<SaveTriggerLinkInput>) {
    return apiClient.put<TriggerLink>(`/settings/trigger-links/${triggerLinkId}`, input)
  },

  delete(triggerLinkId: string) {
    return apiClient.delete<TriggerLink>(`/settings/trigger-links/${triggerLinkId}`)
  },

  events(triggerLinkId: string, limit = 50) {
    return apiClient.get<TriggerLinkEvent[]>(`/settings/trigger-links/${triggerLinkId}/events`, {
      params: { limit: String(limit) }
    })
  }
}
