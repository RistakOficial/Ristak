import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

interface BottomSheetDismissOptions {
  isOpen: boolean
  onClose: () => void
  closeDurationMs?: number
  dismissThreshold?: number
}

interface BottomSheetDragState {
  active: boolean
  pointerId: number | null
  startY: number
  lastY: number
  startTime: number
}

const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [data-bottom-sheet-no-drag="true"]'

export function useBottomSheetDismiss({
  isOpen,
  onClose,
  closeDurationMs = 260,
  dismissThreshold = 92
}: BottomSheetDismissOptions) {
  const [dragOffset, setDragOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const dragRef = useRef<BottomSheetDragState>({
    active: false,
    pointerId: null,
    startY: 0,
    lastY: 0,
    startTime: 0
  })

  const clearCloseTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const requestClose = useCallback(() => {
    if (closing) return
    if (!isOpen) {
      onClose()
      return
    }

    clearCloseTimer()
    dragRef.current.active = false
    setDragging(false)
    setDragOffset(0)
    setClosing(true)

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      onClose()
      setClosing(false)
      setDragOffset(0)
    }, closeDurationMs)
  }, [clearCloseTimer, closeDurationMs, closing, isOpen, onClose])

  const resetDrag = useCallback(() => {
    dragRef.current.active = false
    dragRef.current.pointerId = null
    setDragging(false)
    setDragOffset(0)
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isOpen || closing) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      startTime: performance.now()
    }
    setClosing(false)
    setDragging(true)
    setDragOffset(0)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [closing, isOpen])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return

    drag.lastY = event.clientY
    const nextOffset = Math.max(0, event.clientY - drag.startY)
    setDragOffset(nextOffset)

    if (nextOffset > 3) {
      event.preventDefault()
    }
  }, [])

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return

    const offset = Math.max(0, drag.lastY - drag.startY)
    const elapsed = Math.max(1, performance.now() - drag.startTime)
    const velocity = offset / elapsed
    dragRef.current.active = false
    dragRef.current.pointerId = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)

    if (offset >= dismissThreshold || (offset > 34 && velocity > 0.72)) {
      requestClose()
      return
    }

    setDragOffset(0)
  }, [dismissThreshold, requestClose])

  useEffect(() => {
    if (isOpen) {
      setClosing(false)
      setDragging(false)
      setDragOffset(0)
      return
    }

    clearCloseTimer()
    resetDrag()
    setClosing(false)
  }, [clearCloseTimer, isOpen, resetDrag])

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

  const sheetStyle: CSSProperties | undefined = dragging || closing || dragOffset > 0
    ? {
        transform: `translate3d(0, ${closing ? '104%' : `${dragOffset}px`}, 0)`,
        transition: dragging ? 'none' : `transform ${closeDurationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`
      }
    : undefined

  const backdropStyle: CSSProperties | undefined = dragging || closing || dragOffset > 0
    ? {
        opacity: closing ? 0 : Math.max(0.28, 1 - dragOffset / 360),
        transition: dragging ? 'none' : `opacity ${closeDurationMs}ms ease`
      }
    : undefined

  const dragHandleProps = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd
  }

  return {
    backdropStyle,
    sheetStyle,
    dragHandleProps,
    requestClose,
    dragging,
    closing
  }
}
