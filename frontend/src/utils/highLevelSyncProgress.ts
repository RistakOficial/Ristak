interface HighLevelSyncProgressPollingContext {
  hasFeature: boolean
  hasPermission: boolean
  connected: boolean
}

/**
 * El endpoint de progreso pertenece a la administración de HighLevel. Leerlo
 * fuera de estas tres compuertas sólo genera 403 y polling inútil.
 */
export function isHighLevelSyncProgressPollingAllowed({
  hasFeature,
  hasPermission,
  connected
}: HighLevelSyncProgressPollingContext) {
  return hasFeature && hasPermission && connected
}
