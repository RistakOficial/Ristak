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

export interface WhatsAppAnalyticsSummary {
  metrics?: {
    inboundMessages?: number
    conversations?: number
    contacts?: number
    attributionRate?: number
  }
  trend?: Array<{ label: string; messages?: number }>
  status?: {
    connected?: boolean
    hasData?: boolean
  }
}

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
 * Obtiene resumen y tendencia de mensajes entrantes de WhatsApp.
 */
export async function getWhatsAppAnalyticsSummary(
  startDate: string,
  endDate: string,
  groupBy: 'day' | 'month' | 'year' = 'day'
): Promise<WhatsAppAnalyticsSummary> {
  const params = new URLSearchParams({ start: startDate, end: endDate, groupBy })
  return apiClient.get<WhatsAppAnalyticsSummary>(`/tracking/whatsapp-summary?${params.toString()}`)
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
