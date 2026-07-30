import { useCallback, useEffect, useState } from 'react'
import {
  AI_RUNTIME_CONFIG_CHANGED_EVENT,
  aiRuntimeService,
  type AIRuntimeConfigStatus
} from '@/services/aiRuntimeService'
import {
  AUTH_PRINCIPAL_CHANGED_EVENT,
  getAuthScopedCachePrincipalFingerprint
} from '@/services/authPrincipalCache'

const AVAILABILITY_CACHE_KEY = 'ristak_ai_runtime_availability_snapshot_v1'
const AVAILABILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface AIAvailability {
  configured: boolean
  loading: boolean
  needsReconnect: boolean
  businessProfile?: AIRuntimeConfigStatus['businessProfile']
}

function getStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readAvailability(status?: AIRuntimeConfigStatus | null): Omit<AIAvailability, 'loading'> {
  return {
    configured: Boolean(status?.configured),
    needsReconnect: Boolean(status?.needsReconnect),
    businessProfile: status?.businessProfile
  }
}

function readCachedStatus(): AIRuntimeConfigStatus | null {
  const storage = getStorage()
  if (!storage) return null
  const raw = storage.getItem(AVAILABILITY_CACHE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<{
      principalFingerprint: string
      status: AIRuntimeConfigStatus
      savedAt: number
    }>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.principalFingerprint !== getAuthScopedCachePrincipalFingerprint() ||
      !parsed.status ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > AVAILABILITY_MAX_AGE_MS
    ) {
      storage.removeItem(AVAILABILITY_CACHE_KEY)
      return null
    }
    return parsed.status
  } catch {
    storage.removeItem(AVAILABILITY_CACHE_KEY)
    return null
  }
}

function writeCachedStatus(status: AIRuntimeConfigStatus) {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(AVAILABILITY_CACHE_KEY, JSON.stringify({
      principalFingerprint: getAuthScopedCachePrincipalFingerprint(),
      status,
      savedAt: Date.now()
    }))
  } catch {
    // La red sigue siendo la fuente de verdad.
  }
}

export function useAIAvailability(): AIAvailability {
  const [availability, setAvailability] = useState<AIAvailability>(() => {
    const cachedStatus = readCachedStatus()
    return {
      ...readAvailability(cachedStatus),
      loading: !cachedStatus
    }
  })

  const applyStatus = useCallback((status?: AIRuntimeConfigStatus | null, persist = true) => {
    if (status && persist) writeCachedStatus(status)
    setAvailability({
      ...readAvailability(status),
      loading: false
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let requestVersion = 0
    const controller = new AbortController()

    const loadStatus = async () => {
      const currentRequestVersion = ++requestVersion
      try {
        const status = await aiRuntimeService.getConfig({ signal: controller.signal })
        if (!cancelled && currentRequestVersion === requestVersion) applyStatus(status)
      } catch {
        if (!cancelled && currentRequestVersion === requestVersion) {
          applyStatus(readCachedStatus(), false)
        }
      }
    }

    void loadStatus()

    const handleConfigChange = () => {
      void loadStatus()
    }

    const handleAuthPrincipalChange = (event: Event) => {
      const authenticated = Boolean((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated)
      requestVersion += 1
      setAvailability({
        ...readAvailability(null),
        loading: authenticated
      })
      if (authenticated) void loadStatus()
    }

    window.addEventListener(AI_RUNTIME_CONFIG_CHANGED_EVENT, handleConfigChange)
    window.addEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChange)
    return () => {
      cancelled = true
      requestVersion += 1
      controller.abort()
      window.removeEventListener(AI_RUNTIME_CONFIG_CHANGED_EVENT, handleConfigChange)
      window.removeEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChange)
    }
  }, [applyStatus])

  return availability
}
