import apiClient from './apiClient'

export interface WhatsAppConfig {
  configured: boolean
  id?: number
  appId: string
  appSecret: string
  appSecretConfigured: boolean
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
  appId?: string
  appSecret?: string
  businessToken?: string
  wabaId?: string
  phoneNumberId?: string
  webhookVerifyToken?: string
  callbackUrl?: string
}

export const whatsappService = {
  async getConfig(): Promise<WhatsAppConfigResponse> {
    return await apiClient.get<WhatsAppConfigResponse>('/whatsapp/config')
  },

  async saveConfig(payload: SaveWhatsAppConfigPayload): Promise<WhatsAppConfig> {
    return await apiClient.post<WhatsAppConfig>('/whatsapp/config', payload)
  },

  async connectCloudApi(payload?: SaveWhatsAppConfigPayload): Promise<WhatsAppConfigResponse> {
    return await apiClient.post<WhatsAppConfigResponse>('/whatsapp/cloud-api/connect', payload || {})
  },

  async disconnectCloudApi(): Promise<WhatsAppConfigResponse> {
    return await apiClient.post<WhatsAppConfigResponse>('/whatsapp/cloud-api/disconnect', {})
  },

  async refreshStatus(): Promise<WhatsAppConfigResponse> {
    return await apiClient.post<WhatsAppConfigResponse>('/whatsapp/status/refresh', {})
  }
}
