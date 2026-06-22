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
  placement?: 'bottom' | 'top' | 'rail'
  className?: string
  style?: React.CSSProperties
}

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active, badges = {}, placement = 'bottom', className, style }) => {
  const navigate = useNavigate()
  const activeIndex = getPhoneSectionIndex(active)
  const [indicatorIndex, setIndicatorIndex] = useState(() => readStoredPhoneNavIndex(activeIndex))
  const [indicatorDragPosition, setIndicatorDragPosition] = useState<number | null>(null)
  const [swiping, setSwiping] = useState(false)
  const swipeGestureRef = useRef<NavSwipeGesture | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)
  const swipeEnabled = placement === 'bottom'
  const dockClassName = [
    styles.dock,
    placement === 'top' ? styles.dockTop : '',
    placement === 'rail' ? styles.dockRail : '',
    className
  ].filter(Boolean).join(' ')

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIndicatorIndex(activeIndex)
      return undefined
    }

    const frame = window.requestAnimationFrame(() => {
      setIndicatorIndex(activeIndex)
      setIndicatorDragPosition(null)
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

  const navigateToIndex = useCallback((nextIndex: number) => {
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
    setIndicatorDragPosition(null)
    setSwiping(false)
  }, [])

  const getDockItemWidth = useCallback((dock: HTMLElement) => {
    const indicator = dock.querySelector<HTMLElement>('[data-phone-nav-indicator="true"]')
    const itemWidth = indicator?.getBoundingClientRect().width || 0
    return itemWidth > 0 ? itemWidth : dock.getBoundingClientRect().width / PHONE_NAV_ITEMS.length
  }, [])

  const getIndicatorDragPosition = useCallback((dock: HTMLElement, deltaX: number) => {
    const itemWidth = getDockItemWidth(dock)
    if (!itemWidth) return null

    const maxPosition = itemWidth * (PHONE_NAV_ITEMS.length - 1)
    const rawPosition = (activeIndex * itemWidth) + deltaX

    if (rawPosition < 0) return Math.round(rawPosition * NAV_SWIPE_EDGE_RESISTANCE)
    if (rawPosition > maxPosition) return Math.round(maxPosition + ((rawPosition - maxPosition) * NAV_SWIPE_EDGE_RESISTANCE))

    return Math.round(rawPosition)
  }, [activeIndex, getDockItemWidth])

  const getSwipeTargetIndex = useCallback((dock: HTMLElement, deltaX: number) => {
    const itemWidth = getDockItemWidth(dock)
    if (!itemWidth) return activeIndex

    return clampPhoneNavIndex(Math.round(activeIndex + (deltaX / itemWidth)))
  }, [activeIndex, getDockItemWidth])

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

    setIndicatorDragPosition(getIndicatorDragPosition(event.currentTarget, deltaX))
    event.preventDefault()
  }, [clearSwipeGesture, getIndicatorDragPosition])

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = swipeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const deltaX = event.clientX - gesture.startX
    const distanceX = Math.abs(deltaX)
    const wasHorizontal = gesture.horizontal
    const targetIndex = getSwipeTargetIndex(event.currentTarget, deltaX)
    clearSwipeGesture()

    if (!wasHorizontal || distanceX < NAV_SWIPE_CHANGE_THRESHOLD) return

    event.preventDefault()
    suppressNextClick()
    navigateToIndex(targetIndex)
  }, [clearSwipeGesture, getSwipeTargetIndex, navigateToIndex, suppressNextClick])

  const indicatorTranslate = indicatorDragPosition !== null
    ? `${indicatorDragPosition}px`
    : `${indicatorIndex * 100}%`
  const indicatorTransform = placement === 'rail'
    ? `translate3d(0, ${indicatorTranslate}, 0)`
    : `translate3d(${indicatorTranslate}, 0, 0)`

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
        data-phone-nav-indicator="true"
        style={{ transform: indicatorTransform }}
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
