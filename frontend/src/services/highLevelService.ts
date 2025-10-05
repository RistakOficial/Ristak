// Servicio de GoHighLevel para manejar configuración

export interface HighLevelConfig {
  configured: boolean
  locationId?: string
  hasToken?: boolean
  apiTokenPreview?: string
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

}

// Exportar instancia única
export const highLevelService = new HighLevelService()