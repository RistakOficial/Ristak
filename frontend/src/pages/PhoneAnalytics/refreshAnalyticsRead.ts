// La red tiene prioridad al entrar. Cada panel conserva el último resultado de
// su consulta y vuelve a intentar mientras esté visible, sin solapar lecturas.
export function refreshAnalyticsRead<T>({
  read, cached, apply, denied
}: {
  read: (signal: AbortSignal) => Promise<T>
  cached: () => T | null
  apply: (value: T, live: boolean) => void
  denied: () => void
}) {
  const controller = new AbortController()
  let pending = false
  let hasValue = false
  let accessDenied = false
  let retryMs = 2_000
  let retryTimer: number | undefined
  let cacheTimer: number | undefined

  function revealCache() {
    if (hasValue || accessDenied || controller.signal.aborted) return
    const saved = cached()
    if (saved === null) return
    hasValue = true
    apply(saved, false)
  }

  async function refresh() {
    if (pending || controller.signal.aborted || document.visibilityState === 'hidden') return
    window.clearTimeout(retryTimer)
    if (!navigator.onLine) {
      revealCache()
      return
    }
    pending = true
    try {
      const value = await read(controller.signal)
      if (controller.signal.aborted) return
      hasValue = true
      accessDenied = false
      retryMs = 2_000
      apply(value, true)
    } catch (error) {
      if (controller.signal.aborted) return
      const status = (error as { status?: number } | null)?.status
      if (status === 401 || status === 403) {
        accessDenied = true
        denied()
        return
      }
      revealCache()
      retryTimer = window.setTimeout(refresh, retryMs)
      retryMs = Math.min(30_000, retryMs * 2)
    } finally {
      pending = false
    }
  }

  cacheTimer = window.setTimeout(revealCache, 350)
  window.addEventListener('online', refresh)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  void refresh()
  return () => {
    controller.abort()
    window.clearTimeout(cacheTimer)
    window.clearTimeout(retryTimer)
    window.removeEventListener('online', refresh)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}
