import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationalAgentService, type ConversationalAgentMetrics } from '@/services/conversationalAgentService'

export function useConversationalAgentMetrics(inDirectory: boolean) {
  const [snapshot, setSnapshot] = useState<ConversationalAgentMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const active = useRef(false)
  const request = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!active.current) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const next = await conversationalAgentService.getMetrics(controller.signal)
      if (controller.signal.aborted) return
      if (!Array.isArray(next?.byAgent) || !next.projection) throw new Error('Respuesta de métricas incompleta')
      setSnapshot(next)
      setError(false)
    } catch {
      if (controller.signal.aborted) return
      setSnapshot(null)
      setError(true)
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!inDirectory) return
    active.current = true
    setSnapshot(null)
    setError(false)
    void refresh()
    const refreshIfVisible = () => {
      if (!document.hidden && !request.current) void refresh()
    }
    const timer = window.setInterval(refreshIfVisible, 60_000)
    document.addEventListener('visibilitychange', refreshIfVisible)
    window.addEventListener('focus', refreshIfVisible)
    return () => {
      active.current = false
      request.current?.abort()
      request.current = null
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.removeEventListener('focus', refreshIfVisible)
    }
  }, [inDirectory, refresh])

  const metrics = snapshot?.projection?.complete && snapshot.projection.status === 'ready' ? snapshot : null
  const notice = error || snapshot?.projection?.status === 'unavailable'
    ? 'Las métricas del chatbot no están disponibles en este momento.'
    : snapshot && !metrics ? 'Estamos preparando el historial de los agentes.' : ''
  return { snapshot, metrics, loading, notice, refresh }
}
