import { db } from '../config/database.js'

// ============================================================================
// Fuente de verdad UNICA del estado de conexion a HighLevel (GHL).
//
// La app Ristak debe funcionar de forma autonoma SIN HighLevel. La logica
// acoplada a GHL solo debe activarse cuando exista una conexion REAL, no por la
// mera presencia de una fila en highlevel_config (updateCustomLabels puede
// insertar una fila parcial con location_id/api_token NULL solo para guardar
// labels). Por eso "activo" = hay credenciales reales (location_id Y api_token
// no vacios), no "existe la fila".
//
// Todos los gates de "GHL esta conectado?" deberian usar estos helpers para no
// volver a divergir en criterios (SELECT 1 vs columnas vs probe live).
// ============================================================================

function clean(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : String(value).trim()
}

// true si una config ya leida trae credenciales reales (sin tocar la BD).
export function hasHighLevelCredentials(config) {
  return Boolean(clean(config?.location_id) && clean(config?.api_token))
}

// Lee la fila de configuracion de HighLevel (o null). Fail-safe ante errores de BD.
export async function getHighLevelConfigRow() {
  try {
    return await db.get('SELECT location_id, api_token, location_data FROM highlevel_config LIMIT 1')
  } catch {
    return null
  }
}

// true si HighLevel esta ACTIVO (hay credenciales reales persistidas).
export async function isHighLevelActive() {
  return hasHighLevelCredentials(await getHighLevelConfigRow())
}

// Devuelve { locationId, accessToken } SOLO si GHL esta activo; null en otro caso.
export async function getActiveHighLevelContext() {
  const config = await getHighLevelConfigRow()
  if (!hasHighLevelCredentials(config)) return null
  return { locationId: clean(config.location_id), accessToken: clean(config.api_token) }
}
