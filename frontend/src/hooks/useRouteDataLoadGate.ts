import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  addRistakApiRequestActivityListener,
  getActiveRistakApiRequests,
  type RistakApiRequestActivity
} from '@/services/requestActivity'

const ROUTE_LOAD_BOOTSTRAP_MS = 160
const ROUTE_LOAD_IDLE_MS = 260
const ROUTE_LOAD_MIN_VISIBLE_MS = 180
const ROUTE_LOAD_MAX_MS = 12000
const REQUEST_START_GRACE_MS = 40

const BACKGROUND_API_PATHS = new Set([
  '/api/highlevel/sync/progress',
  '/api/settings/notifications'
])

interface RouteDataLoadGateState {
  loading: boolean
  pendingCount: number
}

function shouldTrackForRouteLoad(activity: Pick<RistakApiRequestActivity, 'pathname'>) {
  if (BACKGROUND_API_PATHS.has(activity.pathname)) return false
  if (activity.pathname.startsWith('/api/auth/')) return false
  if (activity.pathname.startsWith('/api/mobile/')) return false
  return true
}

export function useRouteDataLoadGate(routeKey: string): RouteDataLoadGateState {
  const [settledRouteKey, setSettledRouteKey] = useState('')
  const [pendingCount, setPendingCount] = useState(0)
  const [gateOpen, setGateOpen] = useState(true)

  const routeKeyRef = useRef(routeKey)
  const generationRef = useRef(0)
  const collectingRef = useRef(false)
  const routeStartedAtRef = useRef(Date.now())
  const visibleSinceRef = useRef(Date.now())
  const pendingRequestIdsRef = useRef<Set<number>>(new Set())
  const idleTimerRef = useRef<number | null>(null)
  const bootstrapTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const finishTimerRef = useRef<number | null>(null)

  const clearTimer = useCallback((timerRef: MutableRefObject<number | null>) => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const clearRouteTimers = useCallback(() => {
    clearTimer(idleTimerRef)
    clearTimer(bootstrapTimerRef)
    clearTimer(maxTimerRef)
    clearTimer(finishTimerRef)
  }, [clearTimer])

  const syncPendingCount = useCallback(() => {
    setPendingCount(pendingRequestIdsRef.current.size)
  }, [])

  const finishGate = useCallback((generation: number) => {
    if (generation !== generationRef.current) return

    clearTimer(idleTimerRef)
    clearTimer(finishTimerRef)

    const visibleForMs = Date.now() - visibleSinceRef.current
    const delay = Math.max(ROUTE_LOAD_MIN_VISIBLE_MS - visibleForMs, 0)

    finishTimerRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current) return

      collectingRef.current = false
      pendingRequestIdsRef.current.clear()
      setPendingCount(0)
      setSettledRouteKey(routeKeyRef.current)
      setGateOpen(false)
    }, delay)
  }, [clearTimer])

  const scheduleFinishWhenIdle = useCallback((generation: number, delay = ROUTE_LOAD_IDLE_MS) => {
    if (generation !== generationRef.current) return
    if (pendingRequestIdsRef.current.size > 0) return

    clearTimer(idleTimerRef)
    idleTimerRef.current = window.setTimeout(() => {
      finishGate(generation)
    }, delay)
  }, [clearTimer, finishGate])

  const collectActiveRequests = useCallback(() => {
    const routeStartedAt = routeStartedAtRef.current
    const activeRequests = getActiveRistakApiRequests()

    activeRequests.forEach((request) => {
      if (!shouldTrackForRouteLoad(request)) return
      if (request.startedAt + REQUEST_START_GRACE_MS < routeStartedAt) return
      pendingRequestIdsRef.current.add(request.id)
    })

    syncPendingCount()
  }, [syncPendingCount])

  useEffect(() => {
    const handleActivity = (activity: RistakApiRequestActivity) => {
      if (!collectingRef.current) return
      if (!shouldTrackForRouteLoad(activity)) return
      if (activity.startedAt + REQUEST_START_GRACE_MS < routeStartedAtRef.current) return

      const generation = generationRef.current

      if (activity.phase === 'start') {
        pendingRequestIdsRef.current.add(activity.id)
        setGateOpen(true)
        clearTimer(idleTimerRef)
        clearTimer(finishTimerRef)
        syncPendingCount()
        return
      }

      pendingRequestIdsRef.current.delete(activity.id)
      syncPendingCount()

      if (pendingRequestIdsRef.current.size === 0) {
        scheduleFinishWhenIdle(generation)
      }
    }

    return addRistakApiRequestActivityListener(handleActivity)
  }, [clearTimer, scheduleFinishWhenIdle, syncPendingCount])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    routeKeyRef.current = routeKey
    routeStartedAtRef.current = Date.now()
    visibleSinceRef.current = Date.now()
    collectingRef.current = true
    pendingRequestIdsRef.current.clear()
    clearRouteTimers()
    setPendingCount(0)
    setGateOpen(true)

    collectActiveRequests()

    bootstrapTimerRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current) return

      collectActiveRequests()
      if (pendingRequestIdsRef.current.size === 0) {
        scheduleFinishWhenIdle(generation, 0)
      }
    }, ROUTE_LOAD_BOOTSTRAP_MS)

    maxTimerRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current) return
      finishGate(generation)
    }, ROUTE_LOAD_MAX_MS)

    return () => {
      if (generation === generationRef.current) {
        clearRouteTimers()
      }
    }
  }, [clearRouteTimers, collectActiveRequests, finishGate, routeKey, scheduleFinishWhenIdle])

  return {
    loading: gateOpen || settledRouteKey !== routeKey,
    pendingCount
  }
}
