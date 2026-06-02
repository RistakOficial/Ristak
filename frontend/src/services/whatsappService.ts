import apiClient from './apiClient'

export interface WhatsAppConfig {
  configured: boolean
  id?: number
  appId: string
  appSecret: string
  appSecretConfigured: boolean
  embeddedSignupConfigId: string
  graphApiVersion: string
  webhookVerifyToken: string
  webhookVerifyTokenConfigured: boolean
  callbackUrl: string
  businessToken: string
  businessTokenConfigured: boolean
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string
  verifiedName: string
  qualityRating: string
  platformType: string
  isOnBizApp: boolean
  connectionStatus: string
  onboardingEvent: string
  connectedAt: string | null
  lastExchangeAt: string | null
  lastVerifiedAt: string | null
  coexistenceFeatureType: string
  finishEvent: string
}

export interface WhatsAppStorageSummary {
  phoneNumbers: number
  contacts: number
  chats: number
  messages: number
  webhookEvents: number
}

export interface WhatsAppConfigResponse {
  config: WhatsAppConfig
  storage: WhatsAppStorageSummary
}

export interface SaveWhatsAppConfigPayload {
  appId: string
  appSecret?: string
  embeddedSignupConfigId: string
  webhookVerifyToken?: string
  callbackUrl: string
}

export interface CompleteEmbeddedSignupPayload {
  code: string
  sessionPayload: Record<string, unknown>
  responsePayload: Record<string, unknown>
}

export const whatsappService = {
  async getConfig(): Promise<WhatsAppConfigResponse> {
    return await apiClient.get<WhatsAppConfigResponse>('/whatsapp/config')
  },

  async saveConfig(payload: SaveWhatsAppConfigPayload): Promise<WhatsAppConfig> {
    return await apiClient.post<WhatsAppConfig>('/whatsapp/config', payload)
  },

  async completeEmbeddedSignup(payload: CompleteEmbeddedSignupPayload): Promise<WhatsAppConfigResponse> {
    return await apiClient.post<WhatsAppConfigResponse>('/whatsapp/embedded-signup/complete', payload)
  },

  async refreshStatus(): Promise<WhatsAppConfigResponse> {
    return await apiClient.post<WhatsAppConfigResponse>('/whatsapp/status/refresh', {})
  }
}
