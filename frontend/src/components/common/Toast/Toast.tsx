import React, { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { X, CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'
import styles from './Toast.module.css'

type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastProps {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
  onClose: (id: string) => void
}

const icons = {
  success: <CheckCircle2 size={20} strokeWidth={2} />,
  error: <XCircle size={20} strokeWidth={2} />,
  info: <Info size={20} strokeWidth={2} />,
  warning: <AlertTriangle size={20} strokeWidth={2} />
}

const EXIT_ANIMATION_MS = 260
const SWIPE_DISMISS_THRESHOLD = 42
const SWIPE_CLOSE_OFFSET = -120
const SWIPE_RESET_MS = 180

interface ToastSwipeState {
  active: boolean
  pointerId: number | null
  startY: number
  lastY: number
  startTime: number
}

export const Toast: React.FC<ToastProps> = ({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose
}) => {
  const [isClosing, setIsClosing] = useState(false)
  const [isSwipeClosing, setIsSwipeClosing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [hasSwipeInteraction, setHasSwipeInteraction] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const swipeRef = useRef<ToastSwipeState>({
    active: false,
    pointerId: null,
    startY: 0,
    lastY: 0,
    startTime: 0
  })

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) return
    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
  }, [])

  useEffect(() => {
    if (duration > 0 && !isClosing && !isSwipeClosing) {
      const timer = setTimeout(() => {
        setIsClosing(true)
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [duration, isClosing, isSwipeClosing])

  useEffect(() => {
    if (!isClosing) return

    const timer = setTimeout(() => {
      onClose(id)
    }, EXIT_ANIMATION_MS)

    return () => clearTimeout(timer)
  }, [id, isClosing, onClose])

  useEffect(() => {
    if (!isSwipeClosing) return

    const timer = setTimeout(() => {
      onClose(id)
    }, EXIT_ANIMATION_MS)

    return () => clearTimeout(timer)
  }, [id, isSwipeClosing, onClose])

  useEffect(() => () => clearResetTimer(), [clearResetTimer])

  const handleClose = () => {
    setIsClosing(true)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isClosing || isSwipeClosing) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return

    clearResetTimer()
    swipeRef.current = {
      active: true,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      startTime: performance.now()
    }
    setIsDragging(true)
    setIsResetting(false)
    setHasSwipeInteraction(true)
    setDragOffset(0)
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // El gesto sigue funcionando aunque el navegador no permita capturar el puntero.
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current
    if (!swipe.active || swipe.pointerId !== event.pointerId) return

    swipe.lastY = event.clientY
    const deltaY = event.clientY - swipe.startY
    const nextOffset = Math.min(16, Math.max(-140, deltaY))
    setDragOffset(nextOffset)

    if (Math.abs(nextOffset) > 3) {
      event.preventDefault()
    }
  }

  const resetSwipe = () => {
    swipeRef.current.active = false
    swipeRef.current.pointerId = null
    setIsDragging(false)
    setIsResetting(true)
    setDragOffset(0)
    clearResetTimer()
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      setIsResetting(false)
    }, SWIPE_RESET_MS)
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current
    if (!swipe.active || swipe.pointerId !== event.pointerId) return

    const offset = Math.min(0, swipe.lastY - swipe.startY)
    const elapsed = Math.max(1, performance.now() - swipe.startTime)
    const velocity = offset / elapsed

    swipeRef.current.active = false
    swipeRef.current.pointerId = null
    setIsDragging(false)
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // Algunos WebViews liberan la captura antes de avisar que el gesto terminó.
    }

    if (offset <= -SWIPE_DISMISS_THRESHOLD || (offset < -22 && velocity < -0.42)) {
      clearResetTimer()
      setDragOffset(SWIPE_CLOSE_OFFSET)
      setIsSwipeClosing(true)
      return
    }

    resetSwipe()
  }

  const shouldControlSwipe = !isClosing && (isDragging || isSwipeClosing || isResetting || dragOffset !== 0)
  const toastStyle: CSSProperties | undefined = shouldControlSwipe
    ? {
        animation: 'none',
        opacity: isSwipeClosing ? 0 : Math.max(0.18, Math.min(1, 1 + dragOffset / 90)),
        transform: `translate3d(0, ${isSwipeClosing ? SWIPE_CLOSE_OFFSET : dragOffset}px, 0)`,
        transition: isDragging ? 'none' : `transform ${isSwipeClosing ? EXIT_ANIMATION_MS : SWIPE_RESET_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${isSwipeClosing ? EXIT_ANIMATION_MS : SWIPE_RESET_MS}ms ease`
      }
    : hasSwipeInteraction && !isClosing
      ? { animation: 'none' }
    : undefined

  return (
    <div
      className={`${styles.toast} ${styles[type]} ${isClosing ? styles.closing : ''} ${isDragging ? styles.dragging : ''}`}
      style={toastStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div className={styles.icon}>{icons[type]}</div>
      <div className={styles.content}>
        <div className={styles.title}>{title}</div>
        {message && <div className={styles.message}>{message}</div>}
      </div>
      <button
        className={styles.closeButton}
        onClick={handleClose}
        aria-label="Cerrar notificación"
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
