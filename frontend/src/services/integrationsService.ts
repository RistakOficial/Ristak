import { apiUrl } from './apiBaseUrl'

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
  pageId: string | null
  instagramAccountId: string | null
}

export interface WhatsappStatus {
  configured: boolean
  connected: boolean
}

export interface OpenAiStatus {
  configured: boolean
  connected: boolean
  credentialStatus?: string
}

export interface GoogleCalendarStatus {
  configured: boolean
  connected: boolean
}

export interface StripeStatus {
  configured: boolean
  connected: boolean
  connectionType?: 'manual'
  mode?: 'test' | 'live'
  publishableKey?: string | null
  accountLabel?: string | null
}

export interface MercadoPagoStatus {
  configured: boolean
  connected: boolean
  mode?: 'test' | 'live'
  publicKey?: string | null
  accountLabel?: string | null
}

export interface ConektaStatus {
  configured: boolean
  connected: boolean
  mode?: 'test' | 'live'
  publicKey?: string | null
  accountLabel?: string | null
}

export interface ClipStatus {
  configured: boolean
  connected: boolean
  mode?: 'test' | 'live'
  accountLabel?: string | null
  hasApiKey?: boolean
}

export interface IntegrationsStatus {
  highlevel: HighLevelStatus
  meta: MetaStatus
  whatsapp: WhatsappStatus
  openai: OpenAiStatus
  googleCalendar: GoogleCalendarStatus
  stripe?: StripeStatus
  mercadopago?: MercadoPagoStatus
  conekta?: ConektaStatus
  clip?: ClipStatus
}

// El estado de integraciones se consulta desde muchos componentes al montar
// (AuthContext, useHighLevelConnected, modales...). Cada llamada al backend
// verifica el token contra la API de HighLevel, así que se comparte una sola
// petición con TTL corto.
const STATUS_TTL_MS = 60_000
const STATUS_SNAPSHOT_KEY = 'ristak_integrations_status_snapshot_v1'
const STATUS_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
let statusCache: { promise: Promise<IntegrationsStatus>; fetchedAt: number } | null = null
let statusSnapshot: { data: IntegrationsStatus; savedAt: number } | null = null

function getStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStoredStatusSnapshot() {
  const storage = getStorage()
  if (!storage) return null

  const raw = storage.getItem(STATUS_SNAPSHOT_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<{ data: IntegrationsStatus; savedAt: number }>
    if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.savedAt !== 'number') {
      storage.removeItem(STATUS_SNAPSHOT_KEY)
      return null
    }
    if (Date.now() - parsed.savedAt > STATUS_SNAPSHOT_MAX_AGE_MS) {
      storage.removeItem(STATUS_SNAPSHOT_KEY)
      return null
    }

    return {
      data: parsed.data,
      savedAt: parsed.savedAt
    }
  } catch {
    storage.removeItem(STATUS_SNAPSHOT_KEY)
    return null
  }
}

function writeStatusSnapshot(data: IntegrationsStatus) {
  const snapshot = {
    data,
    savedAt: Date.now()
  }
  statusSnapshot = snapshot

  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(STATUS_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // El estado en memoria sigue disponible para este runtime aunque storage falle.
  }
}

export function readCachedIntegrationsStatus(): IntegrationsStatus | null {
  if (statusSnapshot && Date.now() - statusSnapshot.savedAt <= STATUS_SNAPSHOT_MAX_AGE_MS) {
    return statusSnapshot.data
  }

  statusSnapshot = readStoredStatusSnapshot()
  return statusSnapshot?.data || null
}

export function getIntegrationsStatus(options: { forceRefresh?: boolean } = {}): Promise<IntegrationsStatus> {
  const now = Date.now()
  if (!options.forceRefresh && statusCache && now - statusCache.fetchedAt < STATUS_TTL_MS) {
    return statusCache.promise
  }

  const promise = fetch(apiUrl('/api/integrations/status'))
    .then(async response => {
      if (!response.ok) {
        throw new Error('No se pudo obtener el estado de integraciones')
      }
      const data = await response.json() as IntegrationsStatus
      writeStatusSnapshot(data)
      return data
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
  statusSnapshot = null
  getStorage()?.removeItem(STATUS_SNAPSHOT_KEY)
}
