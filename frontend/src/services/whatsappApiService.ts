import apiClient from './apiClient'

export interface WhatsAppApiPhoneNumber {
  id: string
  waba_id?: string | null
  phone_number?: string | null
  display_phone_number?: string | null
  verified_name?: string | null
  quality_rating?: string | null
  messaging_limit?: string | null
  status?: string | null
  updated_at?: string | null
}

export interface WhatsAppApiStatus {
  provider: 'ycloud' | string
  source: 'WhatsApp_API' | string
  connected: boolean
  configured: boolean
  requiresPhoneSelection: boolean
  status: 'connected' | 'needs_phone' | 'disabled' | 'disconnected' | string
  credentials: {
    apiKeyMasked?: string
    hasApiKey: boolean
  }
  sender: {
    phone?: string | null
    phoneNumberId?: string | null
    wabaId?: string | null
  }
  webhook: {
    id?: string | null
    url?: string | null
    status?: string | null
    enabledEvents?: string[]
  }
  phoneNumbers: WhatsAppApiPhoneNumber[]
  stats: {
    phoneNumbers: number
    contacts: number
    messages: number
    inboundMessages: number
    outboundMessages: number
    attributedMessages: number
    webhookEvents: number
  }
  timestamps: {
    connectedAt?: string | null
    disconnectedAt?: string | null
    lastSyncedAt?: string | null
  }
  lastError?: string | null
}

export interface WhatsAppApiConnectPayload {
  apiKey?: string
  senderPhone?: string
  phoneNumberId?: string
  wabaId?: string
}

export const whatsappApiService = {
  getStatus: () => apiClient.get<WhatsAppApiStatus>('/whatsapp-api/status'),
  connect: (payload: WhatsAppApiConnectPayload) => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/connect', payload),
  refresh: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/refresh'),
  disconnect: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/disconnect'),
  reset: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/reset')
}
