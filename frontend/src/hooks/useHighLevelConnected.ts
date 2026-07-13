import { useIntegrationsStatus } from './useIntegrationsStatus'

interface HighLevelConnection {
  connected: boolean
  configured: boolean
  loading: boolean
}

/**
 * Detecta si HighLevel está conectado (token válido contra su API).
 *
 * Sirve para mostrar/ocultar features que dependen de una integración de
 * terceros y que Ristak por sí solo no puede ofrecer: origen de calendarios,
 * planes de pago recurrentes, etc. Cuando no hay integración, Ristak solo
 * opera de forma local.
 *
 * @returns `connected` (token válido), `configured` (hay credenciales guardadas)
 *          y `loading` (verificación en curso).
 */
export function useHighLevelConnected(): HighLevelConnection {
  const { status, loading } = useIntegrationsStatus()
  return {
    connected: Boolean(status?.highlevel?.connected),
    configured: Boolean(status?.highlevel?.configured),
    loading
  }
}
