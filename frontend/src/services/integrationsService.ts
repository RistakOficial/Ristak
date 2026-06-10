const API_URL = import.meta.env.VITE_API_URL || ''

export interface HighLevelStatus {
  configured: boolean
  connected: boolean
  locationId: string | null
  locationData: { id?: string; name?: string; timezone?: string } | null
  accessToken: string | null
}

export interface MetaStatus {
  configured: boolean
  connected: boolean
  adAccountId: string | null
  pixelId: string | null
}

export interface IntegrationsStatus {
  highlevel: HighLevelStatus
  meta: MetaStatus
}

// El estado de integraciones se consulta desde muchos componentes al montar
// (AuthContext, useHighLevelConnected, modales...). Cada llamada al backend
// verifica el token contra la API de HighLevel, así que se comparte una sola
// petición con TTL corto.
const STATUS_TTL_MS = 60_000
let statusCache: { promise: Promise<IntegrationsStatus>; fetchedAt: number } | null = null

export function getIntegrationsStatus(options: { forceRefresh?: boolean } = {}): Promise<IntegrationsStatus> {
  const now = Date.now()
  if (!options.forceRefresh && statusCache && now - statusCache.fetchedAt < STATUS_TTL_MS) {
    return statusCache.promise
  }

  const promise = fetch(`${API_URL}/api/integrations/status`)
    .then(async response => {
      if (!response.ok) {
        throw new Error('No se pudo obtener el estado de integraciones')
      }
      return await response.json() as IntegrationsStatus
    })
    .catch(error => {
      // No cachear errores para permitir reintentos
      statusCache = null
      throw error
    })

  statusCache = { promise, fetchedAt: now }
  return promise
}

export function invalidateIntegrationsStatus() {
  statusCache = null
}
