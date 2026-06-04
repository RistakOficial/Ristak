import apiClient from './apiClient'

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

interface TrackingConfig {
  trackingDomain: string | null
  isConfigured: boolean
  hasHighLevel: boolean
  showAnalytics: boolean
  trackingSnippet?: string | null
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
 * Obtiene una sesión específica
 */
async function getSessionById(sessionId: string): Promise<TrackingSession> {
  const response = await apiClient.get<{ session: TrackingSession }>(`/api/tracking/sessions/${sessionId}`)
  return response.session
}

/**
 * Obtiene la configuración automática del tracking
 */
async function getTrackingConfig(): Promise<TrackingConfig> {
  // Enviar el dominio actual del frontend como parámetro
  const currentDomain = window.location.hostname
  const response = await apiClient.get<TrackingConfig>('/api/tracking/config', {
    params: { frontendDomain: currentDomain }
  })
  return response
}

/**
 * Configura automáticamente el tracking en HighLevel
 */
async function configureTracking(): Promise<{ success: boolean; message: string; snippet?: string; instructions?: string; error?: string }> {
  // Enviar el dominio actual del frontend en el body
  const currentDomain = window.location.hostname
  const response = await apiClient.post<any>('/api/tracking/configure', {
    frontendDomain: currentDomain
  })
  return response
}

/**
 * Actualiza una sesión
 */
async function updateSession(id: string, updates: Partial<TrackingSession>): Promise<TrackingSession> {
  const response = await apiClient.put<{ session: TrackingSession }>(`/api/tracking/sessions/${id}`, updates)
  return response.session
}

/**
 * Elimina una o múltiples sesiones
 */
async function deleteSessions(ids: string[]): Promise<{ deletedCount: number }> {
  const response = await apiClient.delete<{ deletedCount: number }>('/api/tracking/sessions', { ids })
  return response
}

export const trackingService = {
  getSessions,
  getSessionsPaginated,
  getSessionById,
  updateSession,
  deleteSessions,
  getTrackingConfig,
  configureTracking
}
