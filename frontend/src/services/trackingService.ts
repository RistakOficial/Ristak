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

  // Campos extras del JOIN con contacts
  contact_created_at?: string | null
}

export interface TrackingStats {
  total_sessions: number
  total_pageviews: number
  avg_pages_per_session: number
  bounce_rate: number
  top_sources: Array<{
    source: string
    sessions: number
  }>
  top_campaigns: Array<{
    campaign: string
    sessions: number
  }>
}

export interface TrackingConfig {
  trackingDomain: string | null
  isConfigured: boolean
  hasHighLevel: boolean
  showAnalytics: boolean
}

/**
 * Obtiene las sesiones recientes de tracking
 */
export async function getSessions(limit: number = 50): Promise<TrackingSession[]> {
  const response = await apiClient.get<{ sessions: TrackingSession[] }>(`/api/tracking/sessions?limit=${limit}`)
  return response.sessions
}

/**
 * Obtiene una sesión específica
 */
export async function getSessionById(sessionId: string): Promise<TrackingSession> {
  const response = await apiClient.get<{ session: TrackingSession }>(`/api/tracking/sessions/${sessionId}`)
  return response.session
}

/**
 * Genera el snippet de instalación con el dominio del cliente
 */
export function generateSnippet(domain: string): string {
  return `<!-- Pixel de Tracking Ristak -->
<script async src="https://${domain}/snip.js"></script>`
}

/**
 * Obtiene la configuración automática del tracking
 */
export async function getTrackingConfig(): Promise<TrackingConfig> {
  const response = await apiClient.get<TrackingConfig>('/api/tracking/config')
  return response
}

/**
 * Configura automáticamente el tracking en HighLevel
 */
export async function configureTracking(): Promise<{ success: boolean; message: string; snippet?: string; instructions?: string; error?: string }> {
  const response = await apiClient.post<any>('/api/tracking/configure')
  return response
}

export const trackingService = {
  getSessions,
  getSessionById,
  generateSnippet,
  getTrackingConfig,
  configureTracking
}
