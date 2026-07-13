import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  getIntegrationsStatus,
  getIntegrationsStatusSnapshot,
  refreshIntegrationsStatus,
  subscribeIntegrationsStatus,
  type IntegrationsStatus
} from '@/services/integrationsService'

interface UseIntegrationsStatusOptions {
  enabled?: boolean
}

interface IntegrationsStatusState {
  status: IntegrationsStatus | null
  loading: boolean
  refresh: () => Promise<IntegrationsStatus>
}

const getServerSnapshot = () => null

/** Fuente reactiva compartida para todas las conexiones de la cuenta. */
export function useIntegrationsStatus(
  options: UseIntegrationsStatusOptions = {}
): IntegrationsStatusState {
  const enabled = options.enabled !== false
  const status = useSyncExternalStore(
    subscribeIntegrationsStatus,
    getIntegrationsStatusSnapshot,
    getServerSnapshot
  )
  const [loading, setLoading] = useState(enabled && !status)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    let cancelled = false
    if (!status) setLoading(true)

    void getIntegrationsStatus()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, status])

  const refresh = useCallback(async () => {
    if (!getIntegrationsStatusSnapshot()) setLoading(true)
    try {
      return await refreshIntegrationsStatus()
    } finally {
      setLoading(false)
    }
  }, [])

  return { status, loading, refresh }
}
