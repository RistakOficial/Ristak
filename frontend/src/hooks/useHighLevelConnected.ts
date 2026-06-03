import { useState, useEffect } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''

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
  const [connected, setConnected] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/api/integrations/status`)
        if (!response.ok) {
          throw new Error('No se pudo obtener el estado de integraciones')
        }
        const data = await response.json()
        if (cancelled) return
        setConnected(Boolean(data?.highlevel?.connected))
        setConfigured(Boolean(data?.highlevel?.configured))
      } catch {
        if (cancelled) return
        setConnected(false)
        setConfigured(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadStatus()

    return () => {
      cancelled = true
    }
  }, [])

  return { connected, configured, loading }
}
