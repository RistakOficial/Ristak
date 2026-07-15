import apiClient from './apiClient'
import { invalidateTrackingAnalyticsSummaryCache } from './analyticsService'
import { apiUrl } from './apiBaseUrl'
import {
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import { withRequestTimeout } from './requestTimeout'

export interface TrackingSession {
  // IDs principales
  id: string
  session_id: string
  visitor_id: string
  contact_id: string | null
  full_name: string | null
  email: string | null

  // Evento y timestamps
  event_name: string
  started_at: string
  created_at: string

  // URLs
  page_url: string | null
  referrer_url: string | null

  // UTMs
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null

  // Click IDs
  gclid: string | null
  fbclid: string | null
  fbc: string | null
  fbp: string | null
  wbraid: string | null
  gbraid: string | null
  msclkid: string | null
  ttclid: string | null

  // Canal y plataforma
  channel: string | null
  source_platform: string | null

  // IDs de campaña (Facebook/Google)
  campaign_id: string | null
  adset_id: string | null
  ad_group_id: string | null
  ad_id: string | null

  // Nombres de campaña
  campaign_name: string | null
  adset_name: string | null
  ad_group_name: string | null
  ad_name: string | null

  // Información de anuncio
  placement: string | null
  site_source_name: string | null
  network: string | null
  match_type: string | null
  keyword: string | null
  search_query: string | null
  creative_id: string | null
  ad_position: string | null

  // Información técnica
  ip: string | null
  user_agent: string | null
  device_type: string | null
  os: string | null
  browser: string | null
  browser_version: string | null
  language: string | null
  timezone: string | null

  // Geolocalización
  geo_country: string | null
  geo_region: string | null
  geo_city: string | null

  // Tracking nativo de Sites
  tracking_source?: string | null
  site_id?: string | null
  site_slug?: string | null
  site_name?: string | null
  site_type?: string | null
  form_site_id?: string | null
  form_site_name?: string | null
  public_page_id?: string | null
  public_page_title?: string | null
  conversion_type?: string | null
  submission_id?: string | null

  // Campos extras del JOIN con contacts
  contact_created_at?: string | null
  contact_purchases_count?: number | string | null
  contact_total_paid?: number | string | null
  contact_appointment_date?: string | null
  contact_has_appointment?: boolean | number | string | null
  contact_has_attended_appointment?: boolean | number | string | null
}

export interface TrackingConfig {
  trackingDomain: string | null
  trackingDomainVerified: boolean
  trackingDomainCheckedAt: string | null
  trackingDomainError: string | null
  serviceDomain?: string | null
  serviceBaseUrl?: string | null
  isConfigured: boolean
  hasHighLevel: boolean
  showAnalytics: boolean
  hasPublicSites?: boolean
  trackingSnippet?: string | null
}

export interface TrackingDomainVerification {
  verified: boolean
  error: string | null
  method?: string
  url?: string
  identityField?: string | null
  details?: Record<string, unknown>
}

export interface TrackingDomainCandidate {
  trackingDomain: string
  trackingDomainVerified: boolean
  trackingDomainCheckedAt: string | null
  trackingDomainError: string | null
}

export interface TrackingDomainVerificationResponse extends TrackingDomainCandidate {
  candidate: TrackingDomainCandidate
  verification: TrackingDomainVerification
}

/**
 * Respuesta de sesiones con paginación
 */
export interface SessionsResponse {
  sessions: TrackingSession[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export type TrackingSessionsFilters = Record<string, string[]>

export interface TrackingSessionsSearchInput {
  start: string
  end: string
  filters?: TrackingSessionsFilters
  q?: string
  column?: string
  cursor?: string | null
  limit?: number
}

export interface TrackingSessionsSearchResponse {
  items: TrackingSession[]
  limit: number
  hasMore: boolean
  nextCursor: string | null
  searchMinLength?: number
}

export interface CursorPagePagination {
  limit: number
  hasNext: boolean
  hasMore: boolean
  nextCursor: string | null
}

export interface TrackingVisitorsCoverage {
  source: 'tracking_visitor_latest'
  projectionVersion: number | null
  available: boolean
  status: 'ready' | 'warming' | 'unavailable'
  sourceStatus: string | null
  updatedAt: string | null
  exact: boolean
  complete: boolean
  partial: boolean
  reason: string | null
  reasons: string[]
  rangeQuarterAligned: boolean
  search: {
    mode: 'none' | 'bounded_latest_projection'
    historicalSessionsIncluded?: boolean
    candidatesScanned?: number
    candidateLimit?: number
    exhausted?: boolean
  }
}

const TRACKING_SEARCH_TIMEOUT_MS = 15_000

export function trackingVisitorsCoverageNotice(coverage?: TrackingVisitorsCoverage): string | null {
  if (coverage?.status === 'warming') {
    return 'Preparando el índice completo de visitantes. Reintenta en unos segundos.'
  }
  if (coverage?.status === 'unavailable') {
    return 'El índice de visitantes todavía no está disponible. Reintenta en unos segundos.'
  }
  if (coverage?.partial) {
    if (coverage.reasons?.includes('bounded_latest_session_search')) {
      const scanned = coverage.search?.candidatesScanned || coverage.search?.candidateLimit || 500
      return `La búsqueda revisó los ${scanned} visitantes más recientes. Acota el rango para buscar más atrás.`
    }
    return 'El resultado está acotado a períodos completos del índice. Ajusta el rango para obtener cobertura exacta.'
  }
  return null
}

export interface CursorPage<T> {
  items: T[]
  pagination: CursorPagePagination
  coverage?: TrackingVisitorsCoverage
}

export interface TrackingVisitorsPageInput {
  startDate: string
  endDate: string
  scope?: 'all' | 'attribution' | 'campaigns' | 'attributed'
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  cursor?: string | null
  search?: string
  limit?: number
}

/**
 * Obtiene las sesiones recientes de tracking (legacy - sin paginación)
 */
async function getSessions(limit: number = 50): Promise<TrackingSession[]> {
  const response = await apiClient.get<{ sessions: TrackingSession[] }>(`/api/tracking/sessions?limit=${limit}`)
  return response.sessions
}

/**
 * Obtiene sesiones con paginación infinita
 */
async function getSessionsPaginated(offset: number = 0, limit: number = 50): Promise<SessionsResponse> {
  const response = await apiClient.get<SessionsResponse>(`/api/tracking/sessions?offset=${offset}&limit=${limit}`)
  return response
}

/**
 * Busca sesiones con cursor estable y una respuesta acotada. Este contrato no
 * solicita COUNT: la tabla puede recorrer millones de filas sin pagar un
 * conteo global en cada búsqueda.
 */
async function searchSessions(
  input: TrackingSessionsSearchInput,
  options: { signal?: AbortSignal } = {}
): Promise<TrackingSessionsSearchResponse> {
  const limit = Math.min(100, Math.max(20, Math.trunc(input.limit ?? 50)))
  const query = input.q?.trim() ?? ''
  if (query && query.length < 3) {
    return {
      items: [],
      limit,
      hasMore: false,
      nextCursor: null,
      searchMinLength: 3
    }
  }

  return withRequestTimeout({
    timeoutMs: TRACKING_SEARCH_TIMEOUT_MS,
    timeoutMessage: 'La consulta de eventos tardó demasiado. Ajusta el rango o reintenta.',
    signal: options.signal,
    request: signal => apiClient.post<TrackingSessionsSearchResponse>(
      '/api/tracking/sessions/search',
      {
        start: input.start,
        end: input.end,
        filters: input.filters ?? {},
        q: query,
        column: input.column || 'all',
        cursor: input.cursor ?? null,
        limit
      },
      { signal }
    )
  })
}

/**
 * Drill-down acotado de visitantes. Se usa fetch crudo porque el contrato legacy
 * conserva `data` como arreglo y publica la metadata de cursor al mismo nivel.
 */
async function getVisitorsPage<T = Record<string, unknown>>(
  input: TrackingVisitorsPageInput,
  options: { signal?: AbortSignal } = {}
): Promise<CursorPage<T>> {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)))
  const params = new URLSearchParams({
    startDate: input.startDate,
    endDate: input.endDate,
    limit: String(limit)
  })
  if (input.scope) params.set('scope', input.scope)
  if (input.campaign_id) params.set('campaign_id', input.campaign_id)
  if (input.adset_id) params.set('adset_id', input.adset_id)
  if (input.ad_id) params.set('ad_id', input.ad_id)
  if (input.cursor) params.set('cursor', input.cursor)
  if (input.search?.trim()) params.set('search', input.search.trim())

  const { response, payload } = await withRequestTimeout({
    timeoutMs: TRACKING_SEARCH_TIMEOUT_MS,
    timeoutMessage: 'La consulta de visitantes tardó demasiado. Ajusta el rango o reintenta.',
    signal: options.signal,
    request: async signal => {
      const response = await fetch(apiUrl(`/api/tracking/visitors?${params.toString()}`), { signal })
      const payload = await response.json().catch(() => null) as {
        error?: string
        code?: string
        retryable?: boolean
        data?: T[] | { items?: T[]; pagination?: Partial<CursorPagePagination> }
        pagination?: Partial<CursorPagePagination>
        coverage?: TrackingVisitorsCoverage
      } | null
      return { response, payload }
    }
  })
  if (!response.ok) {
    throw Object.assign(
      new Error(payload?.error || 'No se pudieron cargar los visitantes'),
      {
        status: response.status,
        code: payload?.code,
        retryable: payload?.retryable === true,
        coverage: payload?.coverage
      }
    )
  }

  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.data?.items)
      ? payload.data.items
      : []
  const pagination = payload?.pagination || (!Array.isArray(payload?.data) ? payload?.data?.pagination : null) || {}
  const hasNext = Boolean(pagination.hasNext ?? pagination.hasMore)

  return {
    items,
    ...(payload?.coverage ? { coverage: payload.coverage } : {}),
    pagination: {
      limit: Number(pagination.limit) || limit,
      hasNext,
      hasMore: hasNext,
      nextCursor: typeof pagination.nextCursor === 'string' && pagination.nextCursor
        ? pagination.nextCursor
        : null
    }
  }
}

/**
 * Obtiene una sesión específica
 */
async function getSessionById(sessionId: string): Promise<TrackingSession> {
  const response = await apiClient.get<{ session: TrackingSession }>(`/api/tracking/sessions/${sessionId}`)
  return response.session
}

// La config de tracking se consulta desde varios componentes a la vez (AppShell,
// Dashboard, OriginDistributionCard...). Se comparte una sola petición con TTL
// corto para no repetir la llamada en cada montaje.
const TRACKING_CONFIG_TTL_MS = 60_000
let trackingConfigCache: { promise: Promise<TrackingConfig>; fetchedAt: number } | null = null

function invalidateTrackingConfigCache() {
  trackingConfigCache = null
}

registerAuthScopedCacheInvalidator(invalidateTrackingConfigCache)

/**
 * Obtiene la configuración automática del tracking
 */
function getTrackingConfig(options: { forceRefresh?: boolean } = {}): Promise<TrackingConfig> {
  syncAuthScopedCachePrincipal()
  const now = Date.now()
  if (!options.forceRefresh && trackingConfigCache && now - trackingConfigCache.fetchedAt < TRACKING_CONFIG_TTL_MS) {
    return trackingConfigCache.promise
  }

  const promise: Promise<TrackingConfig> = withRequestTimeout({
    timeoutMs: TRACKING_SEARCH_TIMEOUT_MS,
    timeoutMessage: 'La configuración de tracking tardó demasiado. Reintenta la carga.',
    request: signal => apiClient.get<TrackingConfig>('/api/tracking/config', { signal })
  }).catch(error => {
    // No cachear errores para permitir reintentos
    if (trackingConfigCache?.promise === promise) trackingConfigCache = null
    throw error
  })

  trackingConfigCache = { promise, fetchedAt: now }
  return promise
}

/**
 * Comprueba que el dominio responde con el health de esta instalación y, sólo
 * entonces, lo guarda como fuente del pixel.
 */
async function verifyTrackingDomain(domain: string): Promise<TrackingDomainVerificationResponse> {
  const response = await apiClient.post<TrackingDomainVerificationResponse>('/api/tracking/domain/verify', { domain })
  trackingConfigCache = null
  return response
}

/**
 * Configura automáticamente el tracking en HighLevel
 */
async function configureTracking(): Promise<{ success: boolean; message: string; snippet?: string; instructions?: string; error?: string }> {
  const response = await apiClient.post<any>('/api/tracking/configure')
  // La config cambió en el backend: invalidar el caché compartido
  trackingConfigCache = null
  return response
}

/**
 * Actualiza una sesión
 */
async function updateSession(id: string, updates: Partial<TrackingSession>): Promise<TrackingSession> {
  const response = await apiClient.put<{ session: TrackingSession }>(`/api/tracking/sessions/${id}`, updates)
  invalidateTrackingAnalyticsSummaryCache()
  return response.session
}

/**
 * Elimina una o múltiples sesiones
 */
async function deleteSessions(ids: string[]): Promise<{ deletedCount: number }> {
  const response = await apiClient.delete<{ deletedCount: number }>('/api/tracking/sessions', { ids })
  invalidateTrackingAnalyticsSummaryCache()
  return response
}

export const trackingService = {
  getSessions,
  getSessionsPaginated,
  searchSessions,
  getVisitorsPage,
  getSessionById,
  updateSession,
  deleteSessions,
  getTrackingConfig,
  verifyTrackingDomain,
  configureTracking
}
