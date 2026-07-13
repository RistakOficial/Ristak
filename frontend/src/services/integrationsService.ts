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

export interface RebillStatus {
  configured: boolean
  connected: boolean
  mode?: 'test' | 'live'
  publicKey?: string | null
  accountLabel?: string | null
  webhookConfigured?: boolean
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
  rebill?: RebillStatus
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
let statusSnapshotInitialized = false
let statusRequestVersion = 0
const statusListeners = new Set<() => void>()

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
  statusSnapshotInitialized = true

  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(STATUS_SNAPSHOT_KEY, JSON.stringify(snapshot))
    } catch {
      // El estado en memoria sigue disponible para este runtime aunque storage falle.
    }
  }

  statusListeners.forEach(listener => listener())
}

function ensureStatusSnapshotInitialized() {
  if (statusSnapshotInitialized) return
  statusSnapshot = readStoredStatusSnapshot()
  statusSnapshotInitialized = true
}

export function readCachedIntegrationsStatus(): IntegrationsStatus | null {
  ensureStatusSnapshotInitialized()

  if (statusSnapshot && Date.now() - statusSnapshot.savedAt <= STATUS_SNAPSHOT_MAX_AGE_MS) {
    return statusSnapshot.data
  }

  statusSnapshot = readStoredStatusSnapshot()
  return statusSnapshot?.data || null
}

export function getIntegrationsStatusSnapshot(): IntegrationsStatus | null {
  return readCachedIntegrationsStatus()
}

export function subscribeIntegrationsStatus(listener: () => void): () => void {
  ensureStatusSnapshotInitialized()
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

export function getIntegrationsStatus(options: { forceRefresh?: boolean } = {}): Promise<IntegrationsStatus> {
  const now = Date.now()
  if (!options.forceRefresh && statusCache && now - statusCache.fetchedAt < STATUS_TTL_MS) {
    return statusCache.promise
  }

  const requestVersion = ++statusRequestVersion
  const promise = fetch(apiUrl('/api/integrations/status'))
    .then(async response => {
      if (!response.ok) {
        throw new Error('No se pudo obtener el estado de integraciones')
      }
      const data = await response.json() as IntegrationsStatus
      if (requestVersion === statusRequestVersion) {
        writeStatusSnapshot(data)
      }
      return data
    })
    .catch(error => {
      // No cachear errores para permitir reintentos
      if (requestVersion === statusRequestVersion) statusCache = null
      throw error
    })

  statusCache = { promise, fetchedAt: now }
  return promise
}

export async function refreshIntegrationsStatus(): Promise<IntegrationsStatus> {
  statusCache = null
  return getIntegrationsStatus({ forceRefresh: true })
}

export function invalidateIntegrationsStatus() {
  statusCache = null
  if (typeof window !== 'undefined') {
    void refreshIntegrationsStatus().catch(() => undefined)
  }
}

export async function refreshIntegrationsStatusAfter<T>(mutation: Promise<T>): Promise<T> {
  const result = await mutation
  try {
    await refreshIntegrationsStatus()
  } catch {
    // La mutación ya fue confirmada por el backend. Un fallo temporal al
    // revalidar no debe convertir una conexión/desconexión exitosa en error.
  }
  return result
}

export function clearIntegrationsStatus() {
  statusRequestVersion += 1
  statusCache = null
  statusSnapshot = null
  statusSnapshotInitialized = true
  getStorage()?.removeItem(STATUS_SNAPSHOT_KEY)
  statusListeners.forEach(listener => listener())
}
