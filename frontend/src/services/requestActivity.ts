export const RISTAK_API_REQUEST_ACTIVITY_EVENT = 'ristak:api-request-activity'

export type RistakApiRequestActivityPhase = 'start' | 'end'

export interface RistakApiRequestActivity {
  id: number
  phase: RistakApiRequestActivityPhase
  url: string
  pathname: string
  method: string
  startedAt: number
  endedAt?: number
}

export type ActiveRistakApiRequest = Omit<RistakApiRequestActivity, 'phase' | 'endedAt'>

let requestIdSequence = 0
const activeRequests = new Map<number, ActiveRistakApiRequest>()

function dispatchActivity(detail: RistakApiRequestActivity) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<RistakApiRequestActivity>(RISTAK_API_REQUEST_ACTIVITY_EVENT, { detail }))
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  const initMethod = init?.method
  if (initMethod) return initMethod.toUpperCase()
  if (input instanceof Request && input.method) return input.method.toUpperCase()
  return 'GET'
}

export function startRistakApiRequest(url: URL, input: RequestInfo | URL, init?: RequestInit) {
  const id = ++requestIdSequence
  const startedAt = Date.now()
  const request: ActiveRistakApiRequest = {
    id,
    url: url.href,
    pathname: url.pathname,
    method: resolveRequestMethod(input, init),
    startedAt
  }

  activeRequests.set(id, request)
  dispatchActivity({ ...request, phase: 'start' })
  return id
}

export function finishRistakApiRequest(id: number | null | undefined) {
  if (!id) return

  const request = activeRequests.get(id)
  if (!request) return

  activeRequests.delete(id)
  dispatchActivity({
    ...request,
    phase: 'end',
    endedAt: Date.now()
  })
}

export function getActiveRistakApiRequests() {
  return Array.from(activeRequests.values())
}

export function addRistakApiRequestActivityListener(
  listener: (activity: RistakApiRequestActivity) => void
) {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<RistakApiRequestActivity>).detail)
  }

  window.addEventListener(RISTAK_API_REQUEST_ACTIVITY_EVENT, handleEvent)
  return () => window.removeEventListener(RISTAK_API_REQUEST_ACTIVITY_EVENT, handleEvent)
}
