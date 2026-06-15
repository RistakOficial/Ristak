import { useEffect, useRef } from 'react'

const DEFAULT_SCROLLABLE_SELECTOR = [
  '[data-phone-elastic-scroll="true"]',
  '[data-phone-chat-scrollable="true"]',
  '[data-phone-scrollable="true"]',
  '[data-bottom-sheet-scrollable="true"]'
].join(', ')
const ELASTIC_TARGET_SELECTOR = '[data-phone-elastic-target="true"]'
const MAX_PULL_PX = 74
const EDGE_EPSILON_PX = 1
const AXIS_LOCK_THRESHOLD_PX = 7
const RELEASE_MS = 420

type ElasticEdge = 'top' | 'bottom'
type GestureAxis = 'x' | 'y' | null

interface CachedInlineStyles {
  transform: string
  transition: string
  willChange: string
}

interface ElasticGestureState {
  axis: GestureAxis
  currentOffset: number
  edge: ElasticEdge | null
  edgeStartY: number
  pullTarget: HTMLElement | null
  scrollable: HTMLElement | null
  startX: number
  startY: number
}

interface UsePhoneElasticScrollOptions {
  enabled?: boolean
  onPullRelease?: (payload: { edge: ElasticEdge; offset: number; scrollable: HTMLElement }) => void
  pullReleaseThreshold?: number
  selector?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getDampedPull(rawOffset: number) {
  const direction = rawOffset < 0 ? -1 : 1
  const distance = Math.abs(rawOffset)
  const damped = Math.pow(distance, 0.82) * 0.82
  return direction * clamp(damped, 0, MAX_PULL_PX)
}

function isExplicitElasticScroll(element: HTMLElement) {
  return element.getAttribute('data-phone-elastic-scroll') === 'true'
}

function allowsVerticalScroll(element: HTMLElement) {
  const overflowY = window.getComputedStyle(element).overflowY
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
}

function canScrollVertically(element: HTMLElement) {
  return allowsVerticalScroll(element) && element.scrollHeight > element.clientHeight + EDGE_EPSILON_PX
}

function findScrollableElement(target: EventTarget | null, selector: string) {
  if (!(target instanceof Element)) return null

  let candidate = target.closest(selector)
  while (candidate) {
    if (candidate instanceof HTMLElement && (isExplicitElasticScroll(candidate) || canScrollVertically(candidate))) {
      return candidate
    }

    const parent = candidate.parentElement
    candidate = parent?.closest(selector) || null
  }

  return null
}

function getPullTarget(scrollable: HTMLElement) {
  const explicitTarget = scrollable.querySelector<HTMLElement>(ELASTIC_TARGET_SELECTOR)
  return explicitTarget || scrollable
}

export function usePhoneElasticScroll(options: UsePhoneElasticScrollOptions = {}) {
  const {
    enabled = true,
    onPullRelease,
    pullReleaseThreshold = 58,
    selector = DEFAULT_SCROLLABLE_SELECTOR
  } = options
  const gestureRef = useRef<ElasticGestureState>({
    axis: null,
    currentOffset: 0,
    edge: null,
    edgeStartY: 0,
    pullTarget: null,
    scrollable: null,
    startX: 0,
    startY: 0
  })
  const styleCacheRef = useRef(new WeakMap<HTMLElement, CachedInlineStyles>())
  const releaseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined

    const cacheInlineStyles = (target: HTMLElement) => {
      if (styleCacheRef.current.has(target)) return
      styleCacheRef.current.set(target, {
        transform: target.style.transform,
        transition: target.style.transition,
        willChange: target.style.willChange
      })
    }

    const clearReleaseTimer = () => {
      if (releaseTimerRef.current === null) return
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }

    const restoreTarget = (target: HTMLElement) => {
      const cachedStyles = styleCacheRef.current.get(target)
      if (!cachedStyles) return

      target.style.transform = cachedStyles.transform
      target.style.transition = cachedStyles.transition
      target.style.willChange = cachedStyles.willChange
      target.removeAttribute('data-phone-elastic-state')
      styleCacheRef.current.delete(target)
    }

    const setPull = (target: HTMLElement, offset: number) => {
      clearReleaseTimer()
      cacheInlineStyles(target)
      target.setAttribute('data-phone-elastic-state', 'pulling')
      target.style.transition = 'transform 0ms linear'
      target.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`
      target.style.willChange = 'transform'
    }

    const releasePull = (immediate = false) => {
      const target = gestureRef.current.pullTarget
      if (!target) return

      clearReleaseTimer()
      if (immediate) {
        restoreTarget(target)
      } else {
        cacheInlineStyles(target)
        target.setAttribute('data-phone-elastic-state', 'settling')
        target.style.transition = `transform ${RELEASE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
        target.style.transform = 'translate3d(0, 0, 0)'
        target.style.willChange = 'transform'
        releaseTimerRef.current = window.setTimeout(() => {
          restoreTarget(target)
          if (gestureRef.current.pullTarget === target) {
            gestureRef.current.pullTarget = null
          }
          releaseTimerRef.current = null
        }, RELEASE_MS)
      }

      gestureRef.current.edge = null
      if (immediate) {
        gestureRef.current.pullTarget = null
      }
    }

    const handleTouchStart = (event: TouchEvent) => {
      releasePull(true)

      const firstTouch = event.touches[0]
      gestureRef.current = {
        axis: null,
        currentOffset: 0,
        edge: null,
        edgeStartY: firstTouch?.clientY || 0,
        pullTarget: null,
        scrollable: findScrollableElement(event.target, selector),
        startX: firstTouch?.clientX || 0,
        startY: firstTouch?.clientY || 0
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      const firstTouch = event.touches[0]
      if (!firstTouch) return

      const gesture = gestureRef.current
      const scrollable = gesture.scrollable || findScrollableElement(event.target, selector)
      if (!scrollable) return

      gesture.scrollable = scrollable

      const currentX = firstTouch.clientX
      const currentY = firstTouch.clientY
      const deltaX = currentX - gesture.startX
      const deltaY = currentY - gesture.startY

      if (!gesture.axis && Math.abs(deltaX) + Math.abs(deltaY) >= AXIS_LOCK_THRESHOLD_PX) {
        gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'
      }

      if (gesture.axis === 'x') {
        releasePull(true)
        return
      }

      const hasVerticalScroll = canScrollVertically(scrollable)
      const atTop = scrollable.scrollTop <= EDGE_EPSILON_PX
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - EDGE_EPSILON_PX
      const nextEdge: ElasticEdge | null = !hasVerticalScroll
        ? deltaY >= 0 ? 'top' : 'bottom'
        : atTop && deltaY > 0
          ? 'top'
          : atBottom && deltaY < 0
            ? 'bottom'
            : null

      if (!nextEdge) {
        releasePull(true)
        return
      }

      if (event.cancelable) {
        event.preventDefault()
      }

      if (gesture.edge !== nextEdge || !gesture.pullTarget) {
        gesture.edge = nextEdge
        gesture.edgeStartY = currentY
        gesture.pullTarget = getPullTarget(scrollable)
      }

      const rawOffset = currentY - gesture.edgeStartY
      if ((nextEdge === 'top' && rawOffset < 0) || (nextEdge === 'bottom' && rawOffset > 0)) {
        gesture.currentOffset = 0
        releasePull(true)
        return
      }

      const dampedOffset = getDampedPull(rawOffset)
      gesture.currentOffset = dampedOffset
      setPull(gesture.pullTarget, dampedOffset)
    }

    const handleTouchEnd = () => {
      const gesture = gestureRef.current
      if (
        gesture.edge &&
        gesture.scrollable &&
        Math.abs(gesture.currentOffset) >= pullReleaseThreshold
      ) {
        onPullRelease?.({
          edge: gesture.edge,
          offset: gesture.currentOffset,
          scrollable: gesture.scrollable
        })
      }

      releasePull()
      gestureRef.current.axis = null
      gestureRef.current.currentOffset = 0
      gestureRef.current.scrollable = null
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    window.addEventListener('touchcancel', handleTouchEnd)

    return () => {
      releasePull(true)
      clearReleaseTimer()
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
      window.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [enabled, onPullRelease, pullReleaseThreshold, selector])
}
