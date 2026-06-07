import apiClient from './apiClient'

export interface OutgoingWebhookEventOption {
  id: string
  label: string
  description: string
}

export interface OutgoingWebhookDestination {
  id: string
  name: string
  url: string
  isActive: boolean
  scopeType: 'clinic' | 'user'
  scopeId: string
  events: string[]
  hasSecret: boolean
  maxRetries: number
  timeoutMs: number
  createdAt: string | null
  updatedAt: string | null
}

export interface OutgoingWebhookDelivery {
  id: string
  destinationId: string | null
  destinationName: string
  eventType: string
  eventCategory: string
  entityId: string | null
  entityTable: string | null
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'retrying'
  attemptCount: number
  maxRetries: number
  nextRetryAt: string | null
  lastAttemptAt: string | null
  httpStatus: number | null
  responseBody: string | null
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface OutgoingWebhookScopes {
  clinic: {
    id: string
    label: string
  }
  users: Array<{
    id: string
    label: string
    email: string
  }>
}

export interface OutgoingWebhookOverview {
  destinations: OutgoingWebhookDestination[]
  deliveries: OutgoingWebhookDelivery[]
  eventOptions: OutgoingWebhookEventOption[]
  scopes: OutgoingWebhookScopes
}

export interface SaveOutgoingWebhookDestinationPayload {
  name: string
  url: string
  scopeType: 'clinic' | 'user'
  scopeId?: string
  events: string[]
  secret?: string
  isActive: boolean
  maxRetries: number
  timeoutMs: number
}

export const outgoingWebhooksService = {
  getOverview() {
    return apiClient.get<OutgoingWebhookOverview>('/outgoing-webhooks')
  },

  createDestination(payload: SaveOutgoingWebhookDestinationPayload) {
    return apiClient.post<OutgoingWebhookDestination>('/outgoing-webhooks', payload)
  },

  updateDestination(id: string, payload: SaveOutgoingWebhookDestinationPayload) {
    return apiClient.put<OutgoingWebhookDestination>(`/outgoing-webhooks/${id}`, payload)
  },

  deleteDestination(id: string) {
    return apiClient.delete<OutgoingWebhookDestination>(`/outgoing-webhooks/${id}`)
  },

  sendTest(id: string) {
    return apiClient.post<OutgoingWebhookDelivery>(`/outgoing-webhooks/${id}/test`, {})
  },

  listDeliveries(limit = 50) {
    return apiClient.get<OutgoingWebhookDelivery[]>('/outgoing-webhooks/deliveries/history', {
      params: { limit: String(limit) }
    })
  },

  retryDelivery(id: string) {
    return apiClient.post<OutgoingWebhookDelivery>(`/outgoing-webhooks/deliveries/${id}/retry`, {})
  }
}
