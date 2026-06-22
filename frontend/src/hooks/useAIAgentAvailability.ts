import { useCallback, useEffect, useState } from 'react'
import { aiAgentService, type AIAgentConfigStatus } from '@/services/aiAgentService'

const AI_AGENT_CONFIG_CHANGED_EVENT = 'ai-agent-config-changed'
const AI_AGENT_AVAILABILITY_CACHE_KEY = 'ristak_ai_agent_availability_snapshot_v1'
const AI_AGENT_AVAILABILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface AIAgentAvailability {
  configured: boolean
  loading: boolean
  needsReconnect: boolean
  businessProfile?: AIAgentConfigStatus['businessProfile']
}

function getStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readAvailability(status?: AIAgentConfigStatus | null): Omit<AIAgentAvailability, 'loading'> {
  return {
    configured: Boolean(status?.configured),
    needsReconnect: Boolean(status?.needsReconnect),
    businessProfile: status?.businessProfile
  }
}

function readCachedAvailabilityStatus(): AIAgentConfigStatus | null {
  const storage = getStorage()
  if (!storage) return null

  const raw = storage.getItem(AI_AGENT_AVAILABILITY_CACHE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<{ status: AIAgentConfigStatus; savedAt: number }>
    if (!parsed || typeof parsed !== 'object' || !parsed.status || typeof parsed.savedAt !== 'number') {
      storage.removeItem(AI_AGENT_AVAILABILITY_CACHE_KEY)
      return null
    }
    if (Date.now() - parsed.savedAt > AI_AGENT_AVAILABILITY_MAX_AGE_MS) {
      storage.removeItem(AI_AGENT_AVAILABILITY_CACHE_KEY)
      return null
    }
    return parsed.status
  } catch {
    storage.removeItem(AI_AGENT_AVAILABILITY_CACHE_KEY)
    return null
  }
}

function writeCachedAvailabilityStatus(status: AIAgentConfigStatus) {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(AI_AGENT_AVAILABILITY_CACHE_KEY, JSON.stringify({
      status,
      savedAt: Date.now()
    }))
  } catch {
    // La red sigue siendo la fuente de verdad; el cache solo evita parpadeos.
  }
}

export function useAIAgentAvailability(): AIAgentAvailability {
  // Regla de producto: toda entrada de IA se bloquea hasta que OpenAI este conectado.
  const [availability, setAvailability] = useState<AIAgentAvailability>(() => {
    const cachedStatus = readCachedAvailabilityStatus()
    return {
      ...readAvailability(cachedStatus),
      loading: !cachedStatus
    }
  })

  const applyStatus = useCallback((status?: AIAgentConfigStatus | null, options: { persist?: boolean } = {}) => {
    if (status && options.persist !== false) {
      writeCachedAvailabilityStatus(status)
    }

    setAvailability({
      ...readAvailability(status),
      loading: false
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const status = await aiAgentService.getConfig()
        if (!cancelled) applyStatus(status)
      } catch {
        if (!cancelled) {
          const cachedStatus = readCachedAvailabilityStatus()
          applyStatus(cachedStatus, { persist: false })
        }
      }
    }

    loadStatus()

    const handleConfigChange = (event: Event) => {
      const detail = (event as CustomEvent<AIAgentConfigStatus>).detail
      if (detail) {
        applyStatus(detail)
        return
      }
      loadStatus()
    }

    window.addEventListener(AI_AGENT_CONFIG_CHANGED_EVENT, handleConfigChange)

    return () => {
      cancelled = true
      window.removeEventListener(AI_AGENT_CONFIG_CHANGED_EVENT, handleConfigChange)
    }
  }, [applyStatus])

  return availability
}
