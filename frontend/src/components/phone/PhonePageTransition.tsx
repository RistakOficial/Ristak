import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  PHONE_NAV_ROUTE_INDEX_KEY,
  PHONE_NAV_ROUTE_SECTION_KEY,
  PHONE_NAV_TRANSITION_DIRECTION_KEY,
  PHONE_NAV_TRANSITION_TARGET_KEY,
  PHONE_NAV_TRANSITION_TARGET_SECTION_KEY,
  getPhoneRouteDirectionBySection,
  getPhoneSectionIndex,
  isPhoneSection,
  type PhoneRouteDirection,
  type PhoneSection
} from './phoneNavigation'
import styles from './PhonePageTransition.module.css'

const PAGE_TRANSITION_SETTLE_MS = 360

interface PhonePageTransitionProps extends React.HTMLAttributes<HTMLDivElement> {
  active: PhoneSection
  children: React.ReactNode
}

function resetPhoneDocumentHorizontalScroll() {
  if (typeof window === 'undefined') return

  const rootScrollLeft = document.documentElement.scrollLeft || 0
  const bodyScrollLeft = document.body.scrollLeft || 0
  const windowScrollX = window.scrollX || 0
  if (rootScrollLeft === 0 && bodyScrollLeft === 0 && windowScrollX === 0) return

  const scrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
  document.documentElement.scrollLeft = 0
  document.body.scrollLeft = 0
  window.scrollTo(0, scrollY)
}

function readInitialDirection(active: PhoneSection): PhoneRouteDirection {
  if (typeof window === 'undefined') return 'none'

  const storedDirection = window.sessionStorage.getItem(PHONE_NAV_TRANSITION_DIRECTION_KEY) as PhoneRouteDirection | null
  const targetSection = window.sessionStorage.getItem(PHONE_NAV_TRANSITION_TARGET_SECTION_KEY)
  const hasMatchingIntent = targetSection === active && (storedDirection === 'forward' || storedDirection === 'back')
  const previousSection = window.sessionStorage.getItem(PHONE_NAV_ROUTE_SECTION_KEY)

  window.sessionStorage.removeItem(PHONE_NAV_TRANSITION_DIRECTION_KEY)
  window.sessionStorage.removeItem(PHONE_NAV_TRANSITION_TARGET_KEY)
  window.sessionStorage.removeItem(PHONE_NAV_TRANSITION_TARGET_SECTION_KEY)

  if (hasMatchingIntent) return storedDirection

  if (!isPhoneSection(previousSection)) return 'none'
  return getPhoneRouteDirectionBySection(previousSection, active)
}

export const PhonePageTransition: React.FC<PhonePageTransitionProps> = ({ active, className, children, onAnimationEnd, ...rest }) => {
  const activeIndex = getPhoneSectionIndex(active)
  const [direction, setDirection] = useState(() => readInitialDirection(active))
  const directionClass = direction === 'forward'
    ? styles.forward
    : direction === 'back'
      ? styles.back
      : styles.none

  useLayoutEffect(() => {
    resetPhoneDocumentHorizontalScroll()
  }, [active])

  useEffect(() => {
    if (typeof window === 'undefined') return
    resetPhoneDocumentHorizontalScroll()
    window.sessionStorage.setItem(PHONE_NAV_ROUTE_INDEX_KEY, String(activeIndex))
    window.sessionStorage.setItem(PHONE_NAV_ROUTE_SECTION_KEY, active)
    if (direction === 'none') return

    const frame = window.requestAnimationFrame(resetPhoneDocumentHorizontalScroll)
    const settleTimer = window.setTimeout(() => {
      resetPhoneDocumentHorizontalScroll()
      setDirection('none')
    }, PAGE_TRANSITION_SETTLE_MS)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settleTimer)
    }
  }, [active, activeIndex, direction])

  const handleAnimationEnd = useCallback((event: React.AnimationEvent<HTMLDivElement>) => {
    onAnimationEnd?.(event)
    if (event.currentTarget !== event.target) return
    resetPhoneDocumentHorizontalScroll()
    setDirection('none')
  }, [onAnimationEnd])

  return (
    <div
      {...rest}
      className={`${className || ''} ${styles.transitionFrame} ${directionClass}`}
      data-phone-page-transition={direction}
      onAnimationEnd={handleAnimationEnd}
    >
      {children}
    </div>
  )
}
