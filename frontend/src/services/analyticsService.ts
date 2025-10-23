import apiClient from './apiClient'
import type { TrackingConfig, TrackingSession } from './trackingService'

/**
 * Obtiene sesiones filtradas por rango de fechas
 */
export async function getSessionsByDateRange(startDate: string, endDate: string): Promise<TrackingSession[]> {
  return apiClient.get<TrackingSession[]>(`/tracking/sessions?start=${startDate}&end=${endDate}`)
}

/**
 * Verifica si el tracking está configurado en HighLevel
 */
export async function checkTrackingStatus(): Promise<TrackingConfig> {
  return apiClient.get<TrackingConfig>('/tracking/config')
}

export interface ContactsByDate {
  date: string
  count: number
}

/**
 * Obtiene conteo de contactos con visitor_id por fecha de creación
 */
export async function getContactsByDate(startDate: string, endDate: string): Promise<ContactsByDate[]> {
  const response = await apiClient.get<{ success: boolean; data: ContactsByDate[] }>(
    `/tracking/contacts-by-date?start=${startDate}&end=${endDate}`
  )
  return response.data
}
