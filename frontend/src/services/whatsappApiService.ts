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
  label?: string | null
  is_default_sender?: boolean
  api_send_enabled?: boolean
  qr_send_enabled?: boolean
  qr_status?: string | null
  qr_connected_phone?: string | null
  qr_consent_accepted_at?: string | null
  qr_last_connected_at?: string | null
  qr_last_disconnected_at?: string | null
  qr_last_error?: string | null
  updated_at?: string | null
  availability?: WhatsAppApiPhoneNumberAvailability
}

export interface WhatsAppApiPhoneNumberAvailability {
  apiAvailable: boolean
  apiReason?: string
  qrReady: boolean
  available: boolean
}

export interface WhatsAppApiPendingRestore {
  phoneNumberId: string
  phone: string
  verifiedName?: string
  contactCount: number
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
  needsDefaultSelection?: boolean
  pendingRestores?: WhatsAppApiPendingRestore[]
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
  qr?: {
    consentText: string
    sessions: WhatsAppQrSession[]
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

export interface WhatsAppApiPhoneNumbersPreviewResponse {
  total: number
  phoneNumbers: WhatsAppApiPhoneNumber[]
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
  phoneNumberId?: string
}

export interface WhatsAppApiTextSendPayload {
  to: string
  from?: string
  text: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
}

export interface ScheduledChatMessage {
  id: string
  contactId: string
  provider: 'highlevel' | 'whatsapp_api' | string
  channel?: string
  transport?: string
  text: string
  toPhone?: string
  fromPhone?: string
  businessPhoneNumberId?: string
  scheduledAt: string
  status: 'scheduled' | 'sending' | 'error' | 'sent' | string
  externalId?: string
  sentMessageId?: string
  attempts?: number
  errorMessage?: string
  createdAt?: string
  updatedAt?: string
  sentAt?: string
}

export interface ScheduleChatMessagePayload {
  id?: string
  contactId: string
  provider: 'highlevel' | 'whatsapp_api'
  channel?: string
  transport?: 'api' | 'qr'
  text: string
  toPhone?: string
  fromPhone?: string
  businessPhoneNumberId?: string
  scheduledAt: string
  externalId?: string
}

export interface WhatsAppApiImageSendPayload {
  to: string
  from?: string
  imageDataUrl?: string
  imageUrl?: string
  caption?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
}

export interface WhatsAppApiDocumentSendPayload {
  to: string
  from?: string
  documentDataUrl?: string
  documentUrl?: string
  filename?: string
  mimeType?: string
  caption?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
}

export interface WhatsAppApiAudioSendPayload {
  to: string
  from?: string
  audioDataUrl?: string
  audioUrl?: string
  durationMs?: number
  voice?: boolean
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
}

export interface WhatsAppApiSendResponse {
  id?: string
  wamid?: string
  status?: string
  transport?: 'api' | 'qr' | string
  fallback?: boolean
  fallbackFrom?: string
  fallbackReason?: string
  audio?: {
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    durationMs?: number
    ptt?: boolean
    voice?: boolean
  }
  localMedia?: {
    publicUrl?: string
    publicPath?: string
    mimeType?: string
    filename?: string
  } | null
  image?: {
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    caption?: string
  }
  document?: {
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    filename?: string
    fileName?: string
    caption?: string
  }
}

export interface WhatsAppQrSession {
  id: string
  phoneNumberId: string
  expectedPhone: string
  connectedPhone?: string | null
  status: string
  qrCode?: string
  qrCodeDataUrl?: string
  consentAccepted?: boolean
  consentText?: string
  consentAcceptedAt?: string | null
  consentAcceptedBy?: string | null
  lastError?: string
  lastConnectedAt?: string | null
  lastDisconnectedAt?: string | null
  updatedAt?: string | null
}

export interface WhatsAppQrConnectPayload {
  phoneNumberId: string
  acceptedRisk: boolean
}

export const whatsappApiService = {
  getStatus: () => apiClient.get<WhatsAppApiStatus>('/whatsapp-api/status'),
  connect: (payload: WhatsAppApiConnectPayload) => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/connect', payload),
  previewPhoneNumbers: (apiKey?: string) => apiClient.post<WhatsAppApiPhoneNumbersPreviewResponse>('/whatsapp-api/phone-numbers/preview', { apiKey }),
  setDefaultPhoneNumber: (phoneNumberId: string) => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/phone-numbers/default', { phoneNumberId }),
  rerouteContacts: (phoneNumberId: string, targetPhoneNumberId: string, reason?: string) => (
    apiClient.post<{ moved: number; from: string; to: string }>(`/whatsapp-api/phone-numbers/${encodeURIComponent(phoneNumberId)}/reroute`, { targetPhoneNumberId, reason })
  ),
  restoreContacts: (phoneNumberId: string) => (
    apiClient.post<{ restored: number; phoneNumberId: string }>(`/whatsapp-api/phone-numbers/${encodeURIComponent(phoneNumberId)}/restore`)
  ),
  refresh: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/refresh'),
  disconnect: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/disconnect'),
  reset: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/reset'),
  getQr: (phoneNumberId?: string) => apiClient.get<WhatsAppQrSession | WhatsAppQrSession[]>('/whatsapp-api/qr', {
    params: phoneNumberId ? { phoneNumberId } : undefined
  }),
  connectQr: (payload: WhatsAppQrConnectPayload) => apiClient.post<WhatsAppQrSession>('/whatsapp-api/qr/connect', payload),
  disconnectQr: (phoneNumberId: string) => apiClient.post<WhatsAppQrSession>('/whatsapp-api/qr/disconnect', { phoneNumberId }),
  getTemplates: (status?: string) => apiClient.get<WhatsAppApiTemplatesResponse>('/whatsapp-api/templates', {
    params: status ? { status } : undefined
  }),
  getScheduledMessages: (contactId: string) => apiClient.get<ScheduledChatMessage[]>('/whatsapp-api/messages/scheduled', {
    params: { contactId }
  }),
  scheduleMessage: (payload: ScheduleChatMessagePayload) => apiClient.post<ScheduledChatMessage>('/whatsapp-api/messages/scheduled', payload),
  cancelScheduledMessage: (id: string, contactId?: string) => (
    apiClient.delete<ScheduledChatMessage>(`/whatsapp-api/messages/scheduled/${encodeURIComponent(id)}`, contactId ? { contactId } : undefined)
  ),
  sendText: (payload: WhatsAppApiTextSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/messages/text', payload),
  sendImage: (payload: WhatsAppApiImageSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/messages/image', payload),
  sendDocument: (payload: WhatsAppApiDocumentSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/messages/document', payload),
  sendAudio: (payload: WhatsAppApiAudioSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/messages/audio', payload),
  sendTemplate: (payload: WhatsAppApiTemplateSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/templates/send', payload)
}
