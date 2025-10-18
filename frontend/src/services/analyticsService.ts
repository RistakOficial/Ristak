import apiClient from './apiClient'

/**
 * Obtiene sesiones filtradas por rango de fechas
 */
export async function getSessionsByDateRange(startDate: string, endDate: string) {
  const response = await apiClient.get(`/tracking/sessions?start=${startDate}&end=${endDate}`)
  return response.data
}

/**
 * Verifica si el tracking está configurado en HighLevel
 */
export async function checkTrackingStatus() {
  const response = await apiClient.get('/tracking/config')
  return response.data
}
