// Señal compartida y sin dependencias para invalidar snapshots de Analíticas.
// Vive aparte de trackingAnalyticsService para no crear el ciclo
// trackingService -> trackingAnalyticsService -> trackingService.
let revision = 0

export function getTrackingAnalyticsCacheRevision() {
  return revision
}

export function invalidateTrackingAnalyticsCache() {
  revision = (revision + 1) % Number.MAX_SAFE_INTEGER
  return revision
}
