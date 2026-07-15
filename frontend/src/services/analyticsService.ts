import apiClient from './apiClient'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import { registerRistakApiReadCacheInvalidator } from './authFetch'
import type { ContactListItem } from './reportsService'
import type { CursorPagePagination, TrackingSession, TrackingVisitorsCoverage } from './trackingService'

export type AnalyticsVisitorsCoverage = TrackingVisitorsCoverage

export type TrackingAnalyticsGroupBy = 'day' | 'month' | 'year'

export interface TrackingAnalyticsSummaryInput {
  start: string
  end: string
  groupBy: TrackingAnalyticsGroupBy
  filters?: Record<string, string[]>
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
    revision: number
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

const TRACKING_ANALYTICS_CACHE_TTL_MS = 30_000
const TRACKING_ANALYTICS_CACHE_MAX_ENTRIES = 24
const trackingAnalyticsCache = new Map<string, { data: TrackingAnalyticsSummary; fetchedAt: number }>()

export function invalidateTrackingAnalyticsSummaryCache() {
  trackingAnalyticsCache.clear()
}

registerAuthScopedCacheInvalidator(invalidateTrackingAnalyticsSummaryCache)
registerRistakApiReadCacheInvalidator(invalidateTrackingAnalyticsSummaryCache)

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
  if (!options.forceRefresh) {
    const cached = peekTrackingAnalyticsSummary(input)
    if (cached) return cached
  }

  const data = await apiClient.post<TrackingAnalyticsSummary>(
    '/tracking/analytics/summary',
    options.waitForFresh ? { ...input, waitForFresh: true } : input,
    { signal: options.signal }
  )
  if (requestPrincipalRevision === getAuthScopedCacheRevision()) {
    while (trackingAnalyticsCache.size >= TRACKING_ANALYTICS_CACHE_MAX_ENTRIES) {
      const oldestKey = trackingAnalyticsCache.keys().next().value
      if (!oldestKey) break
      trackingAnalyticsCache.delete(oldestKey)
    }
    trackingAnalyticsCache.set(key, { data, fetchedAt: Date.now() })
  }
  return data
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
export async function getContactConversionsByDate(startDate: string, endDate: string): Promise<ContactConversionsByDate[]> {
  return apiClient.get<ContactConversionsByDate[]>(
    `/tracking/contact-conversions-by-date?start=${startDate}&end=${endDate}`
  )
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
  return apiClient.get<MessageAnalyticsSummary>(`/tracking/messages-summary?${params.toString()}`, { signal })
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
  const response = await apiClient.get<Partial<ContactConversionContactsPage>>(
    `/tracking/contact-conversions-list?${params.toString()}`,
    { signal: options.signal }
  )
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
