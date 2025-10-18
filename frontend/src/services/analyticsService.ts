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
