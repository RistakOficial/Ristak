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

// Umbral para distinguir un swipe de un tap sin robar el scroll vertical.
const NAV_SWIPE_START_THRESHOLD = 9
// Si el gesto es claramente horizontal, engancha antes (menos "arranque muerto").
const NAV_SWIPE_EARLY_LOCK = 6
// Ventana de respaldo para tragarse el click sintético tras un arrastre.
const NAV_SWIPE_CLICK_SUPPRESS_MS = 120

interface NavSwipeGesture {
  pointerId: number
  startX: number
  startY: number
  horizontal: boolean
  // Centros (X en coordenadas de viewport) de cada pestaña, medidos una sola vez
  // al enganchar el arrastre. La barra es fija, así que no cambian durante el gesto.
  centers: number[]
}

// Mide el centro real de cada pestaña (los <a> hijos directos del dock). Usar la
// geometría REAL evita cualquier suposición de padding/borde/box-model: donde esté
// el dedo cae exactamente sobre la pestaña que el usuario ve. Cero desfase.
const measureTabCenters = (dock: HTMLElement): number[] =>
  Array.from(dock.querySelectorAll<HTMLElement>(':scope > a')).map((tab) => {
    const rect = tab.getBoundingClientRect()
    return rect.left + (rect.width / 2)
  })

// Dada la X del dedo y los centros de pestaña, devuelve:
// - hoverIndex: la pestaña bajo el dedo (el centro más cercano = la celda que lo contiene).
// - position: px para trasladar la píldora de modo que su centro quede bajo el dedo,
//   recortado para que no se salga del riel (mismo origen que el reposo translateX(i*100%)).
const resolveFromCenters = (centers: number[], clientX: number) => {
  if (centers.length < 2) return null

  const first = centers[0]
  const last = centers[centers.length - 1]
  const clampedX = Math.max(first, Math.min(clientX, last))
  const position = Math.round(clampedX - first)

  let hoverIndex = 0
  let bestDistance = Infinity
  for (let i = 0; i < centers.length; i += 1) {
    const distance = Math.abs(clientX - centers[i])
    if (distance < bestDistance) {
      bestDistance = distance
      hoverIndex = i
    }
  }

  return { hoverIndex: clampPhoneNavIndex(hoverIndex), position }
}

interface PhoneEcosystemNavProps {
  active: PhoneSection
  badges?: Partial<Record<PhoneSection, number>>
  placement?: 'bottom' | 'top' | 'rail'
  className?: string
  onSelect?: (section: PhoneSection) => void
  style?: React.CSSProperties
}

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active, badges = {}, placement = 'bottom', className, onSelect, style }) => {
  const navigate = useNavigate()
  const activeIndex = getPhoneSectionIndex(active)
  const [indicatorIndex, setIndicatorIndex] = useState(() => readStoredPhoneNavIndex(activeIndex))
  const [indicatorDragPosition, setIndicatorDragPosition] = useState<number | null>(null)
  const [dragHoverIndex, setDragHoverIndex] = useState<number | null>(null)
  const [swiping, setSwiping] = useState(false)
  const swipeGestureRef = useRef<NavSwipeGesture | null>(null)
  const dragHoverIndexRef = useRef<number | null>(null)
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
      setDragHoverIndex(null)
      dragHoverIndexRef.current = null
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
    // Respaldo: si por algún motivo no llega el click sintético, no dejamos el
    // flag armado (mataría el siguiente tap real). El consumo one-shot en onClick
    // es la vía normal.
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
    dragHoverIndexRef.current = null
    setIndicatorDragPosition(null)
    setDragHoverIndex(null)
    setSwiping(false)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!swipeEnabled || event.pointerType === 'mouse' && event.button !== 0) return
    // Un solo dedo manda: si ya hay un gesto en curso, ignoramos cualquier
    // pointerdown extra (un segundo toque congelaría la píldora del primero).
    if (swipeGestureRef.current) return

    swipeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      horizontal: false,
      centers: []
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
      const clearlyHorizontal = distanceX >= NAV_SWIPE_EARLY_LOCK && distanceX > distanceY * 1.4
      if (!clearlyHorizontal) {
        if (distanceX < NAV_SWIPE_START_THRESHOLD && distanceY < NAV_SWIPE_START_THRESHOLD) return
        if (distanceY > distanceX) {
          clearSwipeGesture()
          return
        }
      }
      gesture.horizontal = true
      gesture.centers = measureTabCenters(event.currentTarget)
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setSwiping(true)
    }

    const resolved = resolveFromCenters(gesture.centers, event.clientX)
    if (resolved) {
      if (resolved.hoverIndex !== dragHoverIndexRef.current && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        // Tic hático suave al "aterrizar" en otra pestaña (Android; iOS lo ignora).
        navigator.vibrate(8)
      }
      setIndicatorDragPosition(resolved.position)
      setDragHoverIndex(resolved.hoverIndex)
      dragHoverIndexRef.current = resolved.hoverIndex
    }
    event.preventDefault()
  }, [clearSwipeGesture])

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = swipeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const wasHorizontal = gesture.horizontal
    const resolved = wasHorizontal ? resolveFromCenters(gesture.centers, event.clientX) : null
    const targetIndex = resolved ? resolved.hoverIndex : dragHoverIndexRef.current

    // Suelta la captura de puntero defensivamente (por si navegamos y desmontamos).
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!wasHorizontal) {
      clearSwipeGesture()
      return
    }

    event.preventDefault()
    suppressNextClick()
    clearSwipeGesture()
    if (targetIndex !== null) navigateToIndex(targetIndex)
  }, [clearSwipeGesture, navigateToIndex, suppressNextClick])

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (swipeGestureRef.current?.pointerId === event.pointerId) clearSwipeGesture()
  }, [clearSwipeGesture])

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
      onPointerCancel={handlePointerCancel}
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
      {PHONE_NAV_ITEMS.map(({ key, label, to, Icon }, index) => {
        const badgeCount = Math.max(0, Number(badges[key] || 0))
        // Mientras se arrastra manda la pestaña bajo el dedo; en reposo, el índice
        // del indicador (que sigue a la ruta activa). Píldora y resaltado siempre
        // coinciden, sin parpadeo al soltar.
        const visuallyActive = dragHoverIndex !== null ? index === dragHoverIndex : index === indicatorIndex

        return (
          <Link
            key={key}
            to={to}
            className={visuallyActive ? styles.active : undefined}
            draggable={false}
            aria-label={label}
            aria-current={active === key ? 'page' : undefined}
            onClick={(event) => {
              if (suppressClickRef.current) {
                // One-shot: nos comemos SOLO el click sintético del arrastre y
                // liberamos de inmediato, para no matar un tap real posterior.
                suppressClickRef.current = false
                if (suppressClickTimerRef.current !== null) {
                  window.clearTimeout(suppressClickTimerRef.current)
                  suppressClickTimerRef.current = null
                }
                event.preventDefault()
                return
              }
              if (onSelect) {
                event.preventDefault()
                const nextIndex = getPhoneSectionIndex(key)
                storePhoneNavIntent(active, key)
                window.sessionStorage.setItem(PHONE_NAV_ACTIVE_INDEX_KEY, String(nextIndex))
                setIndicatorIndex(nextIndex)
                setIndicatorDragPosition(null)
                setDragHoverIndex(null)
                dragHoverIndexRef.current = null
                onSelect(key)
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
