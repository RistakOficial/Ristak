import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  PHONE_NAV_ACTIVE_INDEX_KEY,
  PHONE_NAV_ITEMS,
  clampPhoneNavIndex,
  getPhoneSectionIndex,
  readStoredPhoneNavIndex,
  storePhoneNavIntent,
  type PhoneSection
} from './phoneNavigation'
import styles from './PhoneEcosystemNav.module.css'

const NAV_SWIPE_START_THRESHOLD = 9
const NAV_SWIPE_CHANGE_THRESHOLD = 46
const NAV_SWIPE_CLICK_SUPPRESS_MS = 240
const NAV_SWIPE_EDGE_RESISTANCE = 0.35

interface NavSwipeGesture {
  pointerId: number
  startX: number
  startY: number
  horizontal: boolean
}

interface PhoneEcosystemNavProps {
  active: PhoneSection
  badges?: Partial<Record<PhoneSection, number>>
  placement?: 'bottom' | 'top'
  className?: string
  style?: React.CSSProperties
}

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active, badges = {}, placement = 'bottom', className, style }) => {
  const navigate = useNavigate()
  const activeIndex = getPhoneSectionIndex(active)
  const [indicatorIndex, setIndicatorIndex] = useState(() => readStoredPhoneNavIndex(activeIndex))
  const [indicatorDragOffset, setIndicatorDragOffset] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const swipeGestureRef = useRef<NavSwipeGesture | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)
  const swipeEnabled = placement === 'bottom'
  const dockClassName = [placement === 'top' ? `${styles.dock} ${styles.dockTop}` : styles.dock, className].filter(Boolean).join(' ')

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIndicatorIndex(activeIndex)
      return undefined
    }

    const frame = window.requestAnimationFrame(() => {
      setIndicatorIndex(activeIndex)
      setIndicatorDragOffset(0)
      window.sessionStorage.setItem(PHONE_NAV_ACTIVE_INDEX_KEY, String(activeIndex))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex])

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current)
      }
    }
  }, [])

  const suppressNextClick = useCallback(() => {
    if (typeof window === 'undefined') return
    suppressClickRef.current = true
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current)
    }
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false
      suppressClickTimerRef.current = null
    }, NAV_SWIPE_CLICK_SUPPRESS_MS)
  }, [])

  const navigateBySwipe = useCallback((delta: -1 | 1) => {
    const nextIndex = clampPhoneNavIndex(activeIndex + delta)
    if (nextIndex === activeIndex) return false

    const nextItem = PHONE_NAV_ITEMS[nextIndex]
    storePhoneNavIntent(active, nextItem.key)
    window.sessionStorage.setItem(PHONE_NAV_ACTIVE_INDEX_KEY, String(nextIndex))
    setIndicatorIndex(nextIndex)
    navigate(nextItem.to)
    return true
  }, [active, activeIndex, navigate])

  const clearSwipeGesture = useCallback(() => {
    swipeGestureRef.current = null
    setIndicatorDragOffset(0)
    setSwiping(false)
  }, [])

  const getIndicatorDragOffset = useCallback((dock: HTMLElement, deltaX: number) => {
    const dockWidth = dock.getBoundingClientRect().width
    const itemWidth = dockWidth > 0 ? dockWidth / PHONE_NAV_ITEMS.length : 0
    if (!itemWidth) return 0

    const swipeDelta = deltaX > 0 ? 1 : -1
    const targetIndex = clampPhoneNavIndex(activeIndex + swipeDelta)
    const maxOffset = itemWidth * (targetIndex === activeIndex ? NAV_SWIPE_EDGE_RESISTANCE : 1)
    const nextOffset = Math.max(-maxOffset, Math.min(maxOffset, deltaX))
    return Math.round(nextOffset)
  }, [activeIndex])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!swipeEnabled || event.pointerType === 'mouse' && event.button !== 0) return

    swipeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      horizontal: false
    }
  }, [swipeEnabled])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = swipeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY
    const distanceX = Math.abs(deltaX)
    const distanceY = Math.abs(deltaY)

    if (!gesture.horizontal) {
      if (distanceX < NAV_SWIPE_START_THRESHOLD && distanceY < NAV_SWIPE_START_THRESHOLD) return
      if (distanceY > distanceX) {
        clearSwipeGesture()
        return
      }
      gesture.horizontal = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setSwiping(true)
    }

    setIndicatorDragOffset(getIndicatorDragOffset(event.currentTarget, deltaX))
    event.preventDefault()
  }, [clearSwipeGesture, getIndicatorDragOffset])

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = swipeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const distanceX = Math.abs(deltaX)
    const wasHorizontal = gesture.horizontal
    clearSwipeGesture()

    if (!wasHorizontal || distanceX < NAV_SWIPE_CHANGE_THRESHOLD) return

    event.preventDefault()
    suppressNextClick()
    navigateBySwipe(deltaX > 0 ? 1 : -1)
  }, [clearSwipeGesture, navigateBySwipe, suppressNextClick])

  const indicatorTranslate = indicatorDragOffset
    ? `calc(${indicatorIndex * 100}% ${indicatorDragOffset > 0 ? '+' : '-'} ${Math.abs(indicatorDragOffset)}px)`
    : `${indicatorIndex * 100}%`

  return (
    <nav
      className={dockClassName}
      style={style}
      aria-label="Secciones de Ristak"
      data-swipe-ready={swipeEnabled ? 'true' : undefined}
      data-swipe-dragging={swiping ? 'true' : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onPointerCancel={clearSwipeGesture}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
    >
      <span
        className={styles.activeIndicator}
        style={{ transform: `translate3d(${indicatorTranslate}, 0, 0)` }}
        aria-hidden="true"
      />
      {PHONE_NAV_ITEMS.map(({ key, label, to, Icon }) => {
        const badgeCount = Math.max(0, Number(badges[key] || 0))

        return (
          <Link
            key={key}
            to={to}
            className={active === key ? styles.active : undefined}
            draggable={false}
            aria-label={label}
            aria-current={active === key ? 'page' : undefined}
            onClick={(event) => {
              if (suppressClickRef.current) {
                event.preventDefault()
                return
              }
              storePhoneNavIntent(active, key)
            }}
          >
            <span className={styles.iconWrap}>
              <Icon size={key === 'chat' ? 25 : 24} aria-hidden="true" focusable="false" />
              {badgeCount > 0 && (
                <i aria-label={`${badgeCount} mensajes no leídos`}>
                  {badgeCount > 99 ? '99+' : badgeCount}
                </i>
              )}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
