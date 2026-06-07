import { useCallback, useEffect, useState } from 'react'
import { aiAgentService, type AIAgentConfigStatus } from '@/services/aiAgentService'

const AI_AGENT_CONFIG_CHANGED_EVENT = 'ai-agent-config-changed'

interface AIAgentAvailability {
  configured: boolean
  loading: boolean
  needsReconnect: boolean
}

function readAvailability(status?: AIAgentConfigStatus | null): Omit<AIAgentAvailability, 'loading'> {
  return {
    configured: Boolean(status?.configured),
    needsReconnect: Boolean(status?.needsReconnect)
  }
}

export function useAIAgentAvailability(): AIAgentAvailability {
  // Regla de producto: toda entrada nueva de IA debe ocultarse hasta que OpenAI este conectado.
  // La unica excepcion es el boton flotante Chat AI, porque ese panel permite pegar el token.
  const [availability, setAvailability] = useState<AIAgentAvailability>({
    configured: false,
    loading: true,
    needsReconnect: false
  })

  const applyStatus = useCallback((status?: AIAgentConfigStatus | null) => {
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
        if (!cancelled) applyStatus(null)
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
