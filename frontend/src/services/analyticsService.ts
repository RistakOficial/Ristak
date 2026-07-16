import apiClient from './apiClient'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import {
  registerRistakApiReadCacheInvalidator,
  type ApiReadCacheInvalidationContext
} from './authFetch'
import type { ContactListItem } from './reportsService'
import type { CursorPagePagination, TrackingSession, TrackingVisitorsCoverage } from './trackingService'
import {
  abortAndClearSharedRequests,
  getOrCreateSharedRequest
} from './sharedRequest'
import { withRequestTimeout } from './requestTimeout'

export type AnalyticsVisitorsCoverage = TrackingVisitorsCoverage

export type TrackingAnalyticsGroupBy = 'day' | 'month' | 'year'

export interface TrackingAnalyticsSummaryInput {
  start: string
  end: string
  groupBy: TrackingAnalyticsGroupBy
  filters?: Record<string, string[]>
  includeFacets?: boolean
}

export type TrackingAnalyticsFacetDimension =
  | 'sources'
  | 'devices'
  | 'browsers'
  | 'os'
  | 'placements'
  | 'trafficChannels'
  | 'trackingSources'
  | 'pages'
  | 'siteTypes'
  | 'nativeSites'
  | 'nativeForms'
  | 'nativeConversions'
  | 'topVisitors'
  | 'adsHierarchy'

export const TRACKING_ANALYTICS_VIEWPORT_DISTRIBUTION_DIMENSIONS: readonly TrackingAnalyticsFacetDimension[] = Object.freeze([
  'sources',
  'placements',
  'devices',
  'os',
  'browsers'
])

export interface TrackingAnalyticsFacetInput {
  start: string
  end: string
  filters?: Record<string, string[]>
  dimension: TrackingAnalyticsFacetDimension
}

export interface TrackingAnalyticsMetricSet {
  pageViews: number
  uniqueVisitors: number
  uniqueSessions: number
  identifiedContacts: number
  returningUsers: number
  registrations: number
  prospects: number
  appointments: number
  attendances: number
  customers: number
  purchases: number
  conversionRate: number
  avgPagePerSession: number
}

export interface TrackingAnalyticsFacetItem {
  value: string
  label: string
  count: number
}

export interface TrackingAnalyticsTrafficPoint {
  period: string
  pageViews: number
  uniqueVisitors: number
  uniqueSessions: number
  identifiedContacts: number
  returningUsers: number
}

export interface TrackingAnalyticsConversionPoint {
  period: string
  registrations: number
  prospects: number
  appointments: number
  attendances: number
  customers: number
  purchases: number
}

export interface TrackingAnalyticsSummary {
  snapshot?: {
    stale: boolean
    consistency: 'exact' | 'moving-window'
    exactAtBuiltAt: boolean
    builtAt: string
    builtRevision: number
    revision: number
    revalidateAfter: string
    maxStaleAgeMs: number
  }
  range: {
    start: string
    end: string
    previousStart: string
    previousEnd: string
    timezone: string
    requestedGroupBy: TrackingAnalyticsGroupBy
    groupBy: TrackingAnalyticsGroupBy
  }
  metrics: {
    current: TrackingAnalyticsMetricSet
    previous: TrackingAnalyticsMetricSet
    trends: TrackingAnalyticsMetricSet
  }
  trafficSeries: TrackingAnalyticsTrafficPoint[]
  conversionSeries: TrackingAnalyticsConversionPoint[]
  distributions: Record<string, TrackingAnalyticsFacetItem[]>
  facets: Record<string, TrackingAnalyticsFacetItem[]>
}

export interface TrackingAnalyticsFacetResponse {
  range: {
    start: string
    end: string
    timezone: string
  }
  facet: {
    dimension: TrackingAnalyticsFacetDimension
    items: unknown[]
  }
  snapshot?: {
    stale: boolean
    consistency?: 'exact' | 'moving-window'
    exactAtBuiltAt?: boolean
    builtAt?: string
    builtRevision?: number
    revision: number
    revalidateAfter?: string
    maxStaleAgeMs?: number
  }
}

export const TRACKING_ANALYTICS_STALE_REVALIDATION_MIN_DELAY_MS = 30_000

export function getTrackingAnalyticsStaleRevalidationDelayMs(
  snapshot: TrackingAnalyticsSummary['snapshot'],
  now = Date.now()
) {
  if (!snapshot?.stale) return null
  const revalidateAt = Date.parse(snapshot.revalidateAfter || '')
  return Number.isFinite(revalidateAt)
    ? Math.max(TRACKING_ANALYTICS_STALE_REVALIDATION_MIN_DELAY_MS, revalidateAt - now)
    : TRACKING_ANALYTICS_STALE_REVALIDATION_MIN_DELAY_MS
}

export function scheduleTrackingAnalyticsStaleRevalidation(
  snapshot: TrackingAnalyticsSummary['snapshot'],
  revalidate: () => void,
  options: {
    now?: number
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>
  } = {}
) {
  const delayMs = getTrackingAnalyticsStaleRevalidationDelayMs(snapshot, options.now)
  if (delayMs === null) return null
  return (options.setTimer || globalThis.setTimeout)(revalidate, delayMs)
}

const TRACKING_ANALYTICS_CACHE_TTL_MS = 30_000
const TRACKING_ANALYTICS_CACHE_MAX_ENTRIES = 24
const ANALYTICS_REQUEST_TIMEOUT_MS = 20_000
const trackingAnalyticsCache = new Map<string, { data: TrackingAnalyticsSummary; fetchedAt: number }>()
const trackingAnalyticsInflight = new Map<string, Promise<TrackingAnalyticsSummary>>()
const TRACKING_ANALYTICS_FACET_CACHE_MAX_ENTRIES = 64
const trackingAnalyticsFacetCache = new Map<string, { data: TrackingAnalyticsFacetResponse; fetchedAt: number }>()
const trackingAnalyticsFacetInflight = new Map<string, Promise<TrackingAnalyticsFacetResponse>>()
let trackingAnalyticsCacheRevision = 0

export function invalidateTrackingAnalyticsSummaryCache(
  { abortInflight = true }: Partial<ApiReadCacheInvalidationContext> = {}
) {
  // Chat y pagos pueden producir decenas de eventos por minuto. El snapshot
  // analítico ya tiene TTL de 30 s y revisión durable en backend; una
  // invalidación suave conserva esa ventana acotada para que un stream vivo no
  // impida que ninguna lectura llegue a cache. Las mutaciones explícitas siguen
  // invalidando y cancelando de inmediato.
  if (!abortInflight) return
  trackingAnalyticsCacheRevision += 1
  trackingAnalyticsCache.clear()
  trackingAnalyticsFacetCache.clear()
  abortAndClearSharedRequests(trackingAnalyticsInflight)
  abortAndClearSharedRequests(trackingAnalyticsFacetInflight)
}

registerAuthScopedCacheInvalidator(invalidateTrackingAnalyticsSummaryCache)
registerRistakApiReadCacheInvalidator(invalidateTrackingAnalyticsSummaryCache, {
  pathPrefixes: ['/api/tracking/analytics']
})

function trackingAnalyticsCacheKey(input: TrackingAnalyticsSummaryInput) {
  const filters = Object.fromEntries(
    Object.entries(input.filters || {})
      .filter(([, values]) => values.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, values]) => [field, [...values].sort()])
  )

  return JSON.stringify({
    start: input.start,
    end: input.end,
    groupBy: input.groupBy,
    includeFacets: input.includeFacets !== false,
    filters
  })
}

function trackingAnalyticsFacetCacheKey(input: TrackingAnalyticsFacetInput) {
  const filters = Object.fromEntries(
    Object.entries(input.filters || {})
      .filter(([, values]) => values.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, values]) => [field, [...values].sort()])
  )

  return JSON.stringify({
    start: input.start,
    end: input.end,
    dimension: input.dimension,
    filters
  })
}

export function peekTrackingAnalyticsSummary(input: TrackingAnalyticsSummaryInput) {
  syncAuthScopedCachePrincipal()
  const key = trackingAnalyticsCacheKey(input)
  const cached = trackingAnalyticsCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.fetchedAt >= TRACKING_ANALYTICS_CACHE_TTL_MS) {
    trackingAnalyticsCache.delete(key)
    return null
  }
  trackingAnalyticsCache.delete(key)
  trackingAnalyticsCache.set(key, cached)
  return cached.data
}

/**
 * Resumen agregado de Analíticas. Nunca descarga eventos crudos; la caché corta
 * permite volver a la vista sin repetir la consulta, mientras AbortSignal evita
 * que un rango anterior pise la selección más reciente.
 */
export async function getTrackingAnalyticsSummary(
  input: TrackingAnalyticsSummaryInput,
  options: { signal?: AbortSignal; forceRefresh?: boolean; waitForFresh?: boolean } = {}
): Promise<TrackingAnalyticsSummary> {
  syncAuthScopedCachePrincipal()
  const requestPrincipalRevision = getAuthScopedCacheRevision()
  const key = trackingAnalyticsCacheKey(input)
  if (!options.forceRefresh && !options.waitForFresh) {
    const cached = peekTrackingAnalyticsSummary(input)
    if (cached) return cached
  }

  const requestCacheRevision = trackingAnalyticsCacheRevision
  const requestKey = `${key}\nwaitForFresh:${options.waitForFresh === true}`
  return getOrCreateSharedRequest({
    inflight: trackingAnalyticsInflight,
    key: requestKey,
    signal: options.signal,
    abortWhenUnused: true,
    createRequest: async sharedSignal => {
      const data = await withRequestTimeout({
        timeoutMs: ANALYTICS_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'El resumen de Analíticas tardó demasiado. Reintenta la carga.',
        signal: sharedSignal,
        request: signal => apiClient.post<TrackingAnalyticsSummary>(
          '/tracking/analytics/summary',
          options.waitForFresh ? { ...input, waitForFresh: true } : input,
          { signal }
        )
      })

      if (
        requestPrincipalRevision === getAuthScopedCacheRevision()
        && requestCacheRevision === trackingAnalyticsCacheRevision
      ) {
        while (trackingAnalyticsCache.size >= TRACKING_ANALYTICS_CACHE_MAX_ENTRIES) {
          const oldestKey = trackingAnalyticsCache.keys().next().value
          if (!oldestKey) break
          trackingAnalyticsCache.delete(oldestKey)
        }
        trackingAnalyticsCache.set(key, { data, fetchedAt: Date.now() })
      }
      return data
    }
  })
}

/**
 * Carga una sola faceta bajo demanda. Mantener el contrato singular evita que
 * una vista vuelva a reconstruir las 16 dimensiones antes de pintar el core.
 */
export async function getTrackingAnalyticsFacet(
  input: TrackingAnalyticsFacetInput,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {}
): Promise<TrackingAnalyticsFacetResponse> {
  syncAuthScopedCachePrincipal()
  const requestPrincipalRevision = getAuthScopedCacheRevision()
  const key = trackingAnalyticsFacetCacheKey(input)
  if (!options.forceRefresh) {
    const cached = trackingAnalyticsFacetCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < TRACKING_ANALYTICS_CACHE_TTL_MS) {
      trackingAnalyticsFacetCache.delete(key)
      trackingAnalyticsFacetCache.set(key, cached)
      return cached.data
    }
    if (cached) trackingAnalyticsFacetCache.delete(key)
  }

  const requestCacheRevision = trackingAnalyticsCacheRevision
  return getOrCreateSharedRequest({
    inflight: trackingAnalyticsFacetInflight,
    key,
    signal: options.signal,
    abortWhenUnused: true,
    createRequest: async sharedSignal => {
      const data = await withRequestTimeout({
        timeoutMs: ANALYTICS_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'El filtro de Analíticas tardó demasiado. Reintenta la carga.',
        signal: sharedSignal,
        request: signal => apiClient.post<TrackingAnalyticsFacetResponse>(
          '/tracking/analytics/facets',
          input,
          { signal }
        )
      })

      if (
        requestPrincipalRevision === getAuthScopedCacheRevision()
        && requestCacheRevision === trackingAnalyticsCacheRevision
      ) {
        while (trackingAnalyticsFacetCache.size >= TRACKING_ANALYTICS_FACET_CACHE_MAX_ENTRIES) {
          const oldestKey = trackingAnalyticsFacetCache.keys().next().value
          if (!oldestKey) break
          trackingAnalyticsFacetCache.delete(oldestKey)
        }
        trackingAnalyticsFacetCache.set(key, { data, fetchedAt: Date.now() })
      }
      return data
    }
  })
}

/**
 * Obtiene sesiones filtradas por rango de fechas
 */
export async function getSessionsByDateRange(
  startDate: string,
  endDate: string,
  options: { payload?: 'analytics' } = {}
): Promise<TrackingSession[]> {
  const params = new URLSearchParams({ start: startDate, end: endDate })
  if (options.payload) params.set('payload', options.payload)
  return apiClient.get<TrackingSession[]>(`/tracking/sessions?${params.toString()}`)
}

export interface SessionRangeMetrics {
  pageViews: number
  uniqueVisitors: number
  uniqueSessions: number
  returningUsers: number
}

export async function getSessionMetricsByDateRange(startDate: string, endDate: string): Promise<SessionRangeMetrics> {
  const params = new URLSearchParams({ start: startDate, end: endDate, summary: '1' })
  return apiClient.get<SessionRangeMetrics>(`/tracking/sessions?${params.toString()}`)
}

export interface ContactsByDate {
  date: string
  count: number
}

export interface ContactConversionsByDate {
  date: string
  registrations: number
  prospects: number
  appointments: number
  attendances: number
  customers: number
}

export type ContactConversionListType = 'registrations' | 'prospects' | 'appointments' | 'attendances' | 'customers'

export interface ContactConversionContactsPage {
  contacts: ContactListItem[]
  range: { start: string; end: string }
  pagination: CursorPagePagination
}

export interface MessageAnalyticsFilterOption {
  name: string
  value: string
  count: number
}

export interface MessageAnalyticsSummary {
  metrics?: {
    inboundMessages?: number
    conversations?: number
    contacts?: number
    attributionRate?: number
  }
  trend?: Array<{ label: string; messages?: number }>
  filters?: {
    channels?: MessageAnalyticsFilterOption[]
    sources?: MessageAnalyticsFilterOption[]
  }
  status?: {
    connected?: boolean
    hasData?: boolean
    channels?: Record<string, boolean>
    firstSeenProjection?: 'ready' | 'warming' | 'unavailable' | 'filtered'
    firstSeenProjectionComplete?: boolean
  }
}

export type WhatsAppAnalyticsSummary = MessageAnalyticsSummary

/**
 * Obtiene conteo de contactos con visitor_id por fecha de creación
 */
export async function getContactsByDate(startDate: string, endDate: string): Promise<ContactsByDate[]> {
  // apiClient ya extrae automáticamente el campo 'data' de { success: true, data: [...] }
  return apiClient.get<ContactsByDate[]>(
    `/tracking/contacts-by-date?start=${startDate}&end=${endDate}`
  )
}

/**
 * Obtiene conversiones por fecha de creación del contacto.
 */
export async function getContactConversionsByDate(
  startDate: string,
  endDate: string,
  signal?: AbortSignal
): Promise<ContactConversionsByDate[]> {
  return withRequestTimeout({
    timeoutMs: ANALYTICS_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'Las conversiones tardaron demasiado. Reintenta la carga.',
    signal,
    request: requestSignal => apiClient.get<ContactConversionsByDate[]>(
      `/tracking/contact-conversions-by-date?start=${startDate}&end=${endDate}`,
      { signal: requestSignal }
    )
  })
}

/**
 * Obtiene resumen y tendencia de mensajes entrantes por canal.
 */
export async function getMessageAnalyticsSummary(
  startDate: string,
  endDate: string,
  groupBy: 'day' | 'month' | 'year' = 'day',
  filters: { channels?: string[]; sources?: string[] } = {},
  signal?: AbortSignal
): Promise<MessageAnalyticsSummary> {
  const params = new URLSearchParams({ start: startDate, end: endDate, groupBy })
  if (filters.channels?.length) params.set('channels', filters.channels.join(','))
  if (filters.sources?.length) params.set('sources', filters.sources.join(','))
  return withRequestTimeout({
    timeoutMs: ANALYTICS_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'El resumen de mensajes tardó demasiado. Reintenta la carga.',
    signal,
    request: requestSignal => apiClient.get<MessageAnalyticsSummary>(
      `/tracking/messages-summary?${params.toString()}`,
      { signal: requestSignal }
    )
  })
}

/**
 * Alias legacy para superficies que sigan pidiendo WhatsApp explícitamente.
 */
export async function getWhatsAppAnalyticsSummary(
  startDate: string,
  endDate: string,
  groupBy: 'day' | 'month' | 'year' = 'day'
): Promise<WhatsAppAnalyticsSummary> {
  return getMessageAnalyticsSummary(startDate, endDate, groupBy, { channels: ['whatsapp'] })
}

/**
 * Obtiene los contactos que componen un punto del gráfico de conversiones.
 */
export async function getContactConversionContacts(
  startDate: string,
  endDate: string,
  type: ContactConversionListType,
  options: { cursor?: string | null; search?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<ContactConversionContactsPage> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)))
  const params = new URLSearchParams({ start: startDate, end: endDate, type, limit: String(limit) })
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.search?.trim()) params.set('search', options.search.trim())
  const response = await withRequestTimeout({
    timeoutMs: ANALYTICS_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'La lista de conversiones tardó demasiado. Ajusta el rango o reintenta.',
    signal: options.signal,
    request: requestSignal => apiClient.get<Partial<ContactConversionContactsPage>>(
      `/tracking/contact-conversions-list?${params.toString()}`,
      { signal: requestSignal }
    )
  })
  const hasNext = Boolean(response.pagination?.hasNext ?? response.pagination?.hasMore)

  return {
    contacts: Array.isArray(response.contacts) ? response.contacts : [],
    range: response.range || { start: startDate, end: endDate },
    pagination: {
      limit: Number(response.pagination?.limit) || limit,
      hasNext,
      hasMore: hasNext,
      nextCursor: response.pagination?.nextCursor || null
    }
  }
}
