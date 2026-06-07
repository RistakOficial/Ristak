// Servicio de GoHighLevel para manejar configuración

interface HighLevelConfig {
  configured: boolean
  locationId?: string
  hasToken?: boolean
  apiTokenPreview?: string
  ghlInvoiceMode?: 'live' | 'test'
  ghlInvoiceLiveMode?: boolean
}

export type HighLevelChatChannel = 'whatsapp_api' | 'sms_qr' | 'messenger' | 'instagram'

export interface HighLevelConversationMessagePayload {
  contactId: string
  channel: HighLevelChatChannel
  message: string
  attachments?: string[]
  audioDataUrl?: string
  audioUrl?: string
  durationMs?: number
  fromNumber?: string
  toNumber?: string
  conversationProviderId?: string
  externalId?: string
}

export interface HighLevelConversationMessageResponse {
  success?: boolean
  data?: {
    messageId?: string
    conversationId?: string
    channel?: HighLevelChatChannel
    requestedChannel?: HighLevelChatChannel
    channelLabel?: string
    requestedChannelLabel?: string
    type?: string
    transport?: string
    status?: string
    contactId?: string
    highLevelContactId?: string
    localMessageId?: string
    fallbackApplied?: boolean
    fallbackReason?: string | null
    replyWindowOpen?: boolean | null
    replyWindowSource?: string | null
    lastInboundAt?: string | null
    audio?: {
      link?: string
      url?: string
      mimeType?: string
      durationMs?: number
      voice?: boolean
    }
    localMedia?: {
      publicUrl?: string
      publicPath?: string
      mimeType?: string
      filename?: string
    } | null
  }
  messageId?: string
  conversationId?: string
  channel?: HighLevelChatChannel
  requestedChannel?: HighLevelChatChannel
  channelLabel?: string
  requestedChannelLabel?: string
  type?: string
  transport?: string
  status?: string
  contactId?: string
  highLevelContactId?: string
  localMessageId?: string
  fallbackApplied?: boolean
  fallbackReason?: string | null
  replyWindowOpen?: boolean | null
  replyWindowSource?: string | null
  lastInboundAt?: string | null
  audio?: {
    link?: string
    url?: string
    mimeType?: string
    durationMs?: number
    voice?: boolean
  }
  localMedia?: {
    publicUrl?: string
    publicPath?: string
    mimeType?: string
    filename?: string
  } | null
}

class HighLevelService {
  // Obtener configuración actual
  async getConfig(): Promise<HighLevelConfig> {
    try {
      const response = await fetch('/api/highlevel/config')
      const data = await response.json()
      return data
    } catch (error) {
      // TODO: Implement proper logging service
      return { configured: false }
    }
  }

  // Guardar configuración
  async saveConfig(config: {
    locationId: string
    apiToken: string
  }): Promise<any> {
    try {
      // Limpiar los datos antes de enviar
      const cleanConfig = {
        locationId: config.locationId.trim(),
        apiToken: config.apiToken.trim().replace(/[\r\n\t]/g, '')
      }

      const response = await fetch('/api/highlevel/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cleanConfig)
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Probar conexión con HighLevel
  async testConnection(config?: { locationId: string; apiToken: string }): Promise<any> {
    try {
      // Si no se pasa config, intentar obtener la configuración guardada
      let configToTest = config

      if (!configToTest) {
        const savedConfig = await this.getConfig()
        if (savedConfig.configured && savedConfig.locationId) {
          // Necesitamos obtener el token real
          const token = await this.revealToken()
          if (!token) {
            return {
              success: false,
              error: 'No se pudo obtener el token guardado'
            }
          }
          configToTest = {
            locationId: savedConfig.locationId,
            apiToken: token
          }
        }
      }

      if (!configToTest || !configToTest.locationId || !configToTest.apiToken) {
        return {
          success: false,
          error: 'Se requieren locationId y apiToken'
        }
      }

      // Limpiar los datos antes de enviar
      const cleanConfig = {
        locationId: configToTest.locationId.trim(),
        apiToken: configToTest.apiToken.trim().replace(/[\r\n\t]/g, '')
      }

      const response = await fetch('/api/highlevel/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cleanConfig)
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Obtener valor real de API token
  async revealToken(): Promise<string> {
    try {
      const response = await fetch('/api/highlevel/config/reveal/api_token')
      const data = await response.json()

      if (data.success) {
        return data.value
      }
      return ''
    } catch (error) {
      // TODO: Implement proper logging service
      return ''
    }
  }

  // Desconectar cuenta (limpiar configuración)
  async disconnect(): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/config', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Sincronizar custom values con webhooks
  async syncCustomValues(subaccountId: string): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/sync-custom-values', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ subaccountId })
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Sincronizar contactos de GHL a DB
  async syncContacts(): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/sync-contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Refrescar datos del location desde HighLevel
  async refreshLocationData(): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/refresh-location', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Sincronizar datos completos desde HighLevel (contactos, pagos, citas)
  async syncAllData(): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Obtener progreso de sincronización
  async getSyncProgress(): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/sync/progress')
      return await response.json()
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  }

  // Enviar invoice por email, SMS/WhatsApp, o ambos
  async sendInvoice(invoiceId: string, sendMethod: 'email' | 'sms' | 'both' | 'none' = 'email'): Promise<any> {
    try {
      const response = await fetch(`/api/highlevel/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sendMethod })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Error al enviar invoice')
      }

      return await response.json()
    } catch (error) {
      throw error
    }
  }

  // Enviar link de pago rápido por SMS/WhatsApp (Text2Pay)
  async text2Pay(contactId: string, amount: number, currency: string, message?: string): Promise<any> {
    try {
      const response = await fetch('/api/highlevel/text2pay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contactId,
          amount,
          currency,
          message
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Error al enviar link de pago')
      }

      return await response.json()
    } catch (error) {
      throw error
    }
  }

  async sendConversationMessage(payload: HighLevelConversationMessagePayload): Promise<HighLevelConversationMessageResponse> {
    const response = await fetch('/api/highlevel/conversations/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data.error || 'No se pudo enviar el mensaje por HighLevel')
    }

    return data
  }

}

// Exportar instancia única
export const highLevelService = new HighLevelService()
