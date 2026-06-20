import apiClient from './apiClient'
import type { ContactListItem } from './reportsService'
import type { TrackingSession } from './trackingService'

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
  filters: { channels?: string[]; sources?: string[] } = {}
): Promise<MessageAnalyticsSummary> {
  const params = new URLSearchParams({ start: startDate, end: endDate, groupBy })
  if (filters.channels?.length) params.set('channels', filters.channels.join(','))
  if (filters.sources?.length) params.set('sources', filters.sources.join(','))
  return apiClient.get<MessageAnalyticsSummary>(`/tracking/messages-summary?${params.toString()}`)
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
  type: ContactConversionListType
): Promise<{ contacts: ContactListItem[]; range: { start: string; end: string } }> {
  const params = new URLSearchParams({ start: startDate, end: endDate, type })
  return apiClient.get<{ contacts: ContactListItem[]; range: { start: string; end: string } }>(
    `/tracking/contact-conversions-list?${params.toString()}`
  )
}
