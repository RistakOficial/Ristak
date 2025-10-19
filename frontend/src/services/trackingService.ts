import apiClient from './apiClient'

export interface TrackingSession {
  session_id: string
  visitor_id: string
  contact_id: string | null
  contact_created_at?: string | null
  landing_url: string
  referrer_url: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
  gclid: string | null
  fbclid: string | null
  msclkid: string | null
  ttclid: string | null
  device_type: string
  pageviews_count: number
  events_count: number
  is_bounce: number
  started_at: string
  last_event_at: string
  // Campos de plataforma
  source_platform?: string | null
  site_source_name?: string | null
  channel?: string | null
  // Campos de anuncios
  campaign_id?: string | null
  adset_id?: string | null
  ad_id?: string | null
  campaign_name?: string | null
  adset_name?: string | null
  ad_name?: string | null
  placement?: string | null
  // Campos de navegador/OS
  browser?: string | null
  browser_version?: string | null
  os?: string | null
  language?: string | null
  timezone?: string | null
  // Campos de geolocalización
  geo_country?: string | null
  geo_region?: string | null
  geo_city?: string | null
  ip?: string | null
  user_agent?: string | null
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
