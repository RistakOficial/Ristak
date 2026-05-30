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

export interface ContactConversionsByDate {
  date: string
  registrations: number
  prospects: number
  appointments: number
  attendances: number
  customers: number
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
