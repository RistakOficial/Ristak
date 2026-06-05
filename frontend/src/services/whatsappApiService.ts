import apiClient from './apiClient'

export interface WhatsAppApiPhoneNumber {
  id: string
  waba_id?: string | null
  phone_number?: string | null
  display_phone_number?: string | null
  verified_name?: string | null
  profile_picture_url?: string | null
  business_profile_json?: string | null
  quality_rating?: string | null
  messaging_limit?: string | null
  status?: string | null
  updated_at?: string | null
}

export interface WhatsAppApiBalance {
  amount: number
  currency?: string | null
  updated_at?: string | null
}

export interface WhatsAppApiTemplate {
  id: string
  official_template_id?: string | null
  waba_id?: string | null
  name: string
  language: string
  category?: string | null
  sub_category?: string | null
  previous_category?: string | null
  message_send_ttl_seconds?: number | null
  status?: string | null
  quality_rating?: string | null
  reason?: string | null
  status_update_event?: string | null
  disable_date?: string | null
  components?: Array<Record<string, any>>
  ycloud_create_time?: string | null
  ycloud_update_time?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface WhatsAppApiAlert {
  id: string
  severity: 'critical' | 'warning' | 'info' | string
  alert_type: string
  title: string
  message?: string | null
  source_event_id?: string | null
  entity_type?: string | null
  entity_id?: string | null
  status?: string | null
  created_at?: string | null
  resolved_at?: string | null
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
  selectedPhone?: WhatsAppApiPhoneNumber | null
  balance?: WhatsAppApiBalance | null
  templates?: {
    total: number
    approved: number
    blocked: number
    items: WhatsAppApiTemplate[]
  }
  alerts?: {
    total: number
    critical: number
    highestSeverity?: string
    items: WhatsAppApiAlert[]
  }
  stats: {
    phoneNumbers: number
    contacts: number
    messages: number
    inboundMessages: number
    outboundMessages: number
    attributedMessages: number
    webhookEvents: number
    templates?: number
    approvedTemplates?: number
    activeAlerts?: number
    criticalAlerts?: number
    templateSends?: number
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

export interface WhatsAppApiTemplatesResponse {
  total: number
  approved: number
  blocked: number
  items: WhatsAppApiTemplate[]
}

export interface WhatsAppApiTemplateSendPayload {
  to: string
  from?: string
  templateId?: string
  templateName?: string
  language?: string
  variables?: unknown
  components?: Array<Record<string, any>>
  externalId?: string
}

export const whatsappApiService = {
  getStatus: () => apiClient.get<WhatsAppApiStatus>('/whatsapp-api/status'),
  connect: (payload: WhatsAppApiConnectPayload) => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/connect', payload),
  refresh: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/refresh'),
  disconnect: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/disconnect'),
  reset: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/reset'),
  getTemplates: (status?: string) => apiClient.get<WhatsAppApiTemplatesResponse>('/whatsapp-api/templates', {
    params: status ? { status } : undefined
  }),
  sendTemplate: (payload: WhatsAppApiTemplateSendPayload) => apiClient.post('/whatsapp-api/templates/send', payload)
}
