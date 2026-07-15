import apiClient from './apiClient'
import { refreshIntegrationsStatusAfter } from './integrationsService'

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
  provider?: 'ycloud' | 'meta_direct' | string
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

export const WHATSAPP_API_APPROVED_TEMPLATE_STATUS = 'APPROVED'

export function isApprovedWhatsAppApiTemplate(template?: Pick<WhatsAppApiTemplate, 'status'> | null) {
  return String(template?.status || '').trim().toUpperCase() === WHATSAPP_API_APPROVED_TEMPLATE_STATUS
}

export function filterApprovedWhatsAppApiTemplates(templates?: WhatsAppApiTemplate[] | null) {
  return Array.isArray(templates) ? templates.filter(isApprovedWhatsAppApiTemplate) : []
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
  activeProvider?: 'ycloud' | 'meta_direct' | string
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
    drip?: WhatsAppQrDripSettings
  }
  metaDirect?: WhatsAppMetaDirectStatus
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

export type WhatsAppQrDripDelayUnit = 'seconds' | 'minutes'

export interface WhatsAppQrDripSettings {
  enabled: boolean
  delaySeconds: number
  delayUnit?: WhatsAppQrDripDelayUnit
  minDelaySeconds?: number
  maxDelaySeconds?: number
}

export type WhatsAppQrDripSettingsPayload = Partial<Pick<WhatsAppQrDripSettings, 'enabled' | 'delaySeconds' | 'delayUnit'>>

export interface WhatsAppMetaDirectStatus {
  provider: 'meta_direct' | string
  connected: boolean
  configured: boolean
  status: 'connected' | 'disconnected' | string
  appId?: string | null
  businessId?: string | null
  wabaId?: string | null
  phoneNumberId?: string | null
  displayPhoneNumber?: string | null
  coexistenceEnabled?: boolean
  webhookMode?: string | null
  installerWebhookUrl?: string | null
  installerOAuthCallbackUrl?: string | null
  connectedAt?: string | null
  disconnectedAt?: string | null
  lastWebhookReceivedAt?: string | null
  lastRelayReceivedAt?: string | null
  lastError?: string | null
  datasetId?: string | null
  adAccountId?: string | null
  hasSystemUserToken?: boolean
}

export function isWhatsAppPhoneApiAvailable(
  phone?: WhatsAppApiPhoneNumber | null,
  status?: WhatsAppApiStatus | null
) {
  if (!phone?.id || Number(phone.api_send_enabled ?? 1) === 0) return false

  if (typeof phone.availability?.apiAvailable === 'boolean') {
    return phone.availability.apiAvailable
  }

  const provider = String(phone.provider || '').trim().toLowerCase()
  if (provider === 'meta_direct') {
    if (!status?.metaDirect?.connected) return false
    const configuredPhoneNumberId = String(status.metaDirect.phoneNumberId || '').trim()
    return !configuredPhoneNumberId || configuredPhoneNumberId === phone.id
  }

  if (provider === 'qr') return false
  return Boolean(status?.connected)
}

export function hasWhatsAppPhoneApiAvailable(status?: WhatsAppApiStatus | null) {
  return Boolean(status?.phoneNumbers?.some((phone) => isWhatsAppPhoneApiAvailable(phone, status)))
}

export interface WhatsAppMetaDirectConnectUrlResponse {
  url: string
  expiresAt?: string
}

export interface WhatsAppMetaEmbeddedSignupSession {
  state: string
  connectUrl: string
  expiresAt?: string
  status: string
  appId: string
  configId: string
  graphVersion: string
  configVersion: 'v2' | 'v4'
  featureType: string
  sessionInfoVersion: string
  loginExtras: Record<string, unknown>
}

export interface WhatsAppMetaEmbeddedSignupData {
  wabaId?: string
  phoneNumberId?: string
  businessId?: string
}

export interface WhatsAppMetaBusinessAccountResponse {
  whatsappBusinessAccountId?: string | null
}

export interface WhatsAppMetaDirectTestResponse {
  ok?: boolean
  phone?: Record<string, unknown>
  synced?: boolean
  status?: string
  message?: string
}

export interface WhatsAppContactProfilePictureBackfillContact {
  id: string
  phone: string
  name?: string | null
  profilePictureUrl?: string | null
}

export interface WhatsAppContactProfilePictureBackfillResult {
  ok: boolean
  startedAt?: string
  finishedAt?: string
  limit: number
  force: boolean
  onlyMissing: boolean
  scope?: 'all_crm' | 'whatsapp_only' | string
  scanned: number
  apiAttempted: number
  qrAttempted: number
  apiUpdated: number
  qrUpdated: number
  updated: number
  contacts: WhatsAppContactProfilePictureBackfillContact[]
}

export interface WhatsAppContactProfilePictureBackfillPayload {
  limit?: number
  force?: boolean
  onlyMissing?: boolean
  contactIds?: string[]
  scope?: 'all_crm' | 'whatsapp_only'
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
  pageInfo?: {
    limit: number
    hasMore: boolean
    nextCursor?: string | null
  }
}

export interface WhatsAppApiPhoneNumbersPreviewResponse {
  total: number
  phoneNumbers: WhatsAppApiPhoneNumber[]
}

export interface WhatsAppApiTemplateSendPayload {
  to: string
  from?: string
  contactId?: string
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
  contactId?: string
  text: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  replyToMessageId?: string
  replyToProviderMessageId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiReactionSendPayload {
  to: string
  from?: string
  contactId?: string
  emoji: string
  targetMessageId?: string
  targetProviderMessageId?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiLocationSendPayload {
  to: string
  from?: string
  contactId?: string
  latitude: number
  longitude: number
  name?: string
  address?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiInteractiveSendPayload {
  to: string
  from?: string
  contactId?: string
  body: string
  buttons?: Array<{ id?: string; title?: string; label?: string; payload?: string }>
  urlButton?: { title?: string; label?: string; url: string }
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
  messageType?: 'text' | 'template' | string
  text: string
  templateId?: string
  templateName?: string
  templateLanguage?: string
  templateComponents?: Array<Record<string, any>> | null
  templateVariables?: unknown
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
  routingReason?: string
}

export interface ScheduleChatMessagePayload {
  id?: string
  contactId: string
  provider: 'highlevel' | 'whatsapp_api'
  channel?: string
  transport?: 'api' | 'qr'
  messageType?: 'text' | 'template'
  text: string
  templateId?: string
  templateName?: string
  templateLanguage?: string
  templateComponents?: Array<Record<string, any>>
  templateVariables?: unknown
  toPhone?: string
  fromPhone?: string
  businessPhoneNumberId?: string
  scheduledAt: string
  externalId?: string
}

export interface WhatsAppApiImageSendPayload {
  to: string
  from?: string
  contactId?: string
  imageDataUrl?: string
  imageUrl?: string
  caption?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiDocumentSendPayload {
  to: string
  from?: string
  contactId?: string
  documentDataUrl?: string
  documentUrl?: string
  filename?: string
  mimeType?: string
  caption?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiVideoSendPayload {
  to: string
  from?: string
  contactId?: string
  videoDataUrl?: string
  videoUrl?: string
  caption?: string
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiAudioSendPayload {
  to: string
  from?: string
  contactId?: string
  audioDataUrl?: string
  audioUrl?: string
  durationMs?: number
  voice?: boolean
  externalId?: string
  transport?: 'api' | 'qr'
  phoneNumberId?: string
  messageOrigin?: 'manual_chat' | string
}

export interface WhatsAppApiSendResponse {
  id?: string
  wamid?: string
  localMessageId?: string
  status?: string
  transport?: 'api' | 'qr' | string
  channel?: string
  data?: {
    localMessageId?: string
    status?: string
    transport?: string
    channel?: string
  }
  fallback?: boolean
  fallbackFrom?: string
  fallbackReason?: string
  routingReason?: string
  location?: {
    latitude?: number
    longitude?: number
    name?: string
    address?: string
    url?: string
  }
  audio?: {
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    durationMs?: number
    ptt?: boolean
    voice?: boolean
  }
  attachment?: {
    type?: 'image' | 'video' | 'audio' | 'file' | string
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    filename?: string
    fileName?: string
    durationMs?: number
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
  video?: {
    link?: string
    url?: string
    mimeType?: string
    mimetype?: string
    filename?: string
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

function normalizeSendResponse(
  response: WhatsAppApiSendResponse | null | undefined,
  fallback: Pick<WhatsAppApiSendResponse, 'status' | 'transport'> = {}
): WhatsAppApiSendResponse {
  if (response && typeof response === 'object') return response

  return {
    status: fallback.status || 'sent',
    transport: fallback.transport || 'api'
  }
}

async function postSendResponse(endpoint: string, payload: any): Promise<WhatsAppApiSendResponse> {
  const response = await apiClient.post<WhatsAppApiSendResponse | null>(endpoint, payload)
  return normalizeSendResponse(response, {
    transport: payload?.transport
  })
}

export interface MetaSocialTextSendPayload {
  contactId: string
  platform: 'messenger' | 'instagram'
  message: string
  externalId?: string
  replyToMessageId?: string
  replyToProviderMessageId?: string
}

export interface MetaSocialAudioSendPayload {
  contactId: string
  platform: 'messenger' | 'instagram'
  audioDataUrl?: string
  audioUrl?: string
  audioMimeType?: string
  filename?: string
  durationMs?: number
  voice?: boolean
  externalId?: string
  replyToMessageId?: string
  replyToProviderMessageId?: string
}

export interface MetaSocialAttachmentSendPayload {
  contactId: string
  platform: 'messenger' | 'instagram'
  attachmentType: 'image' | 'video' | 'file'
  attachmentDataUrl?: string
  attachmentUrl?: string
  mimeType?: string
  filename?: string
  externalId?: string
  replyToMessageId?: string
  replyToProviderMessageId?: string
}

export interface MetaSocialReactionSendPayload {
  contactId: string
  platform: 'messenger' | 'instagram'
  emoji: string
  targetMessageId?: string
  targetProviderMessageId?: string
  externalId?: string
}

export interface MetaSocialCommentReplyPayload {
  contactId: string
  platform: 'messenger' | 'instagram'
  message: string
  // 'public' = responder en la publicación; 'private' = DM a quien comentó.
  replyType: 'public' | 'private'
  commentId?: string
  postId?: string
  externalId?: string
}

// Publicación de FB/IG para el selector de disparadores, condiciones y acciones.
export interface MetaSocialPost {
  id: string
  platform: 'facebook' | 'instagram'
  type: string
  message: string
  imageUrl: string
  permalink: string
  postedAt: string
}

export interface MetaSocialPostsResponse {
  success: boolean
  posts: MetaSocialPost[]
  total: number
  hasMore: boolean
  error?: string
}

export interface MetaSocialPostsQuery {
  platform: string
  search?: string
  limit?: number
  offset?: number
  refresh?: boolean
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

export interface WhatsAppQrPhoneNumberPayload {
  phoneNumberId?: string
  phoneNumber?: string
  label?: string
}

export const whatsappApiService = {
  getStatus: (options: { signal?: AbortSignal } = {}) => apiClient.get<WhatsAppApiStatus>('/whatsapp-api/status', options),
  getMetaBusinessAccount: () => apiClient.get<WhatsAppMetaBusinessAccountResponse>('/whatsapp-api/meta/business-account'),
  getMetaConnectUrl: () => apiClient.get<WhatsAppMetaDirectConnectUrlResponse>('/whatsapp-api/meta/connect-url'),
  prepareMetaSignup: () => apiClient.get<WhatsAppMetaEmbeddedSignupSession>('/whatsapp-api/meta/signup-session'),
  completeMetaSignup: (payload: { state: string; code?: string; signupData?: WhatsAppMetaEmbeddedSignupData }) => (
    refreshIntegrationsStatusAfter(apiClient.post<{ completed: boolean; wabaId?: string; phoneNumberId?: string }>('/whatsapp-api/meta/signup-complete', payload))
  ),
  setProvider: (provider: 'ycloud' | 'meta_direct') => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppApiStatus>('/whatsapp-api/meta/provider', { provider })),
  testMetaDirect: () => apiClient.post<WhatsAppMetaDirectTestResponse>('/whatsapp-api/meta/test'),
  sendMetaDirectTestMessage: (payload: { to: string; text?: string }) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/messages/test', payload),
  sendMetaSocialText: (payload: MetaSocialTextSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/social/messages/text', payload),
  sendMetaSocialAudio: (payload: MetaSocialAudioSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/social/messages/audio', payload),
  sendMetaSocialAttachment: (payload: MetaSocialAttachmentSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/social/messages/attachment', payload),
  sendMetaSocialReaction: (payload: MetaSocialReactionSendPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/social/messages/reaction', payload),
  sendMetaSocialCommentReply: (payload: MetaSocialCommentReplyPayload) => apiClient.post<WhatsAppApiSendResponse>('/whatsapp-api/meta/social/comments/reply', payload),
  listMetaSocialPosts: (params: MetaSocialPostsQuery) => {
    const qs = new URLSearchParams({ platform: params.platform })
    if (params.search) qs.set('search', params.search)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    if (params.refresh) qs.set('refresh', '1')
    return apiClient.get<MetaSocialPostsResponse>(`/whatsapp-api/meta/social/posts?${qs.toString()}`)
  },
  syncMetaDirectHistory: () => apiClient.post<WhatsAppMetaDirectTestResponse>('/whatsapp-api/meta/sync-history'),
  disconnectMetaDirect: () => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppApiStatus>('/whatsapp-api/meta/disconnect')),
  connect: (payload: WhatsAppApiConnectPayload) => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppApiStatus>('/whatsapp-api/connect', payload)),
  previewPhoneNumbers: (apiKey?: string) => apiClient.post<WhatsAppApiPhoneNumbersPreviewResponse>('/whatsapp-api/phone-numbers/preview', { apiKey }),
  setDefaultPhoneNumber: (phoneNumberId: string) => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/phone-numbers/default', { phoneNumberId }),
  disconnectPhoneNumber: (phoneNumberId: string, connection: 'api' | 'qr') => (
    refreshIntegrationsStatusAfter(apiClient.post<WhatsAppApiStatus>(`/whatsapp-api/phone-numbers/${encodeURIComponent(phoneNumberId)}/disconnect`, { connection }))
  ),
  rerouteContacts: (phoneNumberId: string, targetPhoneNumberId: string, reason?: string) => (
    apiClient.post<{ moved: number; from: string; to: string }>(`/whatsapp-api/phone-numbers/${encodeURIComponent(phoneNumberId)}/reroute`, { targetPhoneNumberId, reason })
  ),
  restoreContacts: (phoneNumberId: string) => (
    apiClient.post<{ restored: number; phoneNumberId: string }>(`/whatsapp-api/phone-numbers/${encodeURIComponent(phoneNumberId)}/restore`)
  ),
  refresh: () => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppApiStatus>('/whatsapp-api/refresh')),
  backfillContactProfilePictures: (payload: WhatsAppContactProfilePictureBackfillPayload = {}) => (
    apiClient.post<WhatsAppContactProfilePictureBackfillResult>('/whatsapp-api/contacts/profile-pictures/backfill', payload)
  ),
  disconnect: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/disconnect'),
  reset: () => apiClient.post<WhatsAppApiStatus>('/whatsapp-api/reset'),
  getQr: (phoneNumberId?: string) => apiClient.get<WhatsAppQrSession | WhatsAppQrSession[]>('/whatsapp-api/qr', {
    params: phoneNumberId ? { phoneNumberId } : undefined
  }),
  getQrDripSettings: () => apiClient.get<WhatsAppQrDripSettings>('/whatsapp-api/qr/drip-settings'),
  updateQrDripSettings: (payload: WhatsAppQrDripSettingsPayload) => apiClient.put<WhatsAppQrDripSettings>('/whatsapp-api/qr/drip-settings', payload),
  createQrPhoneNumber: (payload: WhatsAppQrPhoneNumberPayload) => apiClient.post<WhatsAppApiPhoneNumber>('/whatsapp-api/qr/phone-numbers', payload),
  connectQr: (payload: WhatsAppQrConnectPayload) => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppQrSession>('/whatsapp-api/qr/connect', payload)),
  disconnectQr: (phoneNumberId: string) => refreshIntegrationsStatusAfter(apiClient.post<WhatsAppQrSession>('/whatsapp-api/qr/disconnect', { phoneNumberId })),
  getTemplates: (status: string | null = WHATSAPP_API_APPROVED_TEMPLATE_STATUS, options: { signal?: AbortSignal } = {}) => apiClient.get<WhatsAppApiTemplatesResponse>('/whatsapp-api/templates', {
    ...options,
    params: status ? { status } : undefined
  }),
  getScheduledMessages: (contactId: string) => apiClient.get<ScheduledChatMessage[]>('/whatsapp-api/messages/scheduled', {
    params: { contactId }
  }),
  scheduleMessage: (payload: ScheduleChatMessagePayload) => apiClient.post<ScheduledChatMessage>('/whatsapp-api/messages/scheduled', payload),
  cancelScheduledMessage: (id: string, contactId?: string) => (
    apiClient.delete<ScheduledChatMessage>(`/whatsapp-api/messages/scheduled/${encodeURIComponent(id)}`, contactId ? { contactId } : undefined)
  ),
  sendText: (payload: WhatsAppApiTextSendPayload) => postSendResponse('/whatsapp-api/messages/text', payload),
  sendReaction: (payload: WhatsAppApiReactionSendPayload) => postSendResponse('/whatsapp-api/messages/reaction', payload),
  sendLocation: (payload: WhatsAppApiLocationSendPayload) => postSendResponse('/whatsapp-api/messages/location', payload),
  sendInteractive: (payload: WhatsAppApiInteractiveSendPayload) => postSendResponse('/whatsapp-api/messages/interactive', payload),
  sendImage: (payload: WhatsAppApiImageSendPayload) => postSendResponse('/whatsapp-api/messages/image', payload),
  sendDocument: (payload: WhatsAppApiDocumentSendPayload) => postSendResponse('/whatsapp-api/messages/document', payload),
  sendVideo: (payload: WhatsAppApiVideoSendPayload) => postSendResponse('/whatsapp-api/messages/video', payload),
  sendAudio: (payload: WhatsAppApiAudioSendPayload) => postSendResponse('/whatsapp-api/messages/audio', payload),
  sendTemplate: (payload: WhatsAppApiTemplateSendPayload) => postSendResponse('/whatsapp-api/templates/send', payload)
}
