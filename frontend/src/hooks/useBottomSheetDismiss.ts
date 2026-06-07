import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

interface BottomSheetDismissOptions {
  isOpen: boolean
  onClose: () => void
  closeDurationMs?: number
  dismissThreshold?: number
  backdropTravelPx?: number
}

interface BottomSheetDragState {
  active: boolean
  captured: boolean
  pointerId: number | null
  startY: number
  lastY: number
  startTime: number
}

type BottomSheetAfterClose = () => void

const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [data-bottom-sheet-no-drag="true"]'
const SCROLLABLE_SELECTOR = '[data-phone-scrollable="true"], [data-phone-chat-scrollable="true"], [data-bottom-sheet-scrollable="true"]'
const DEFAULT_BACKDROP_TRAVEL_PX = 360

type BottomSheetBackdropStyle = CSSProperties & {
  '--bottom-sheet-progress'?: string
}

function clampProgress(value: number) {
  return Math.min(1, Math.max(0, value))
}

function getScrollableParent(target: EventTarget | null, boundary: Element) {
  if (!(target instanceof Element)) return null
  const scrollable = target.closest(SCROLLABLE_SELECTOR)
  if (!scrollable || !boundary.contains(scrollable)) return null
  return scrollable as HTMLElement
}

export function useBottomSheetDismiss({
  isOpen,
  onClose,
  closeDurationMs = 260,
  dismissThreshold = 92,
  backdropTravelPx = DEFAULT_BACKDROP_TRAVEL_PX
}: BottomSheetDismissOptions) {
  const [dragOffset, setDragOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const afterCloseRef = useRef<BottomSheetAfterClose | null>(null)
  const dragRef = useRef<BottomSheetDragState>({
    active: false,
    captured: false,
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

  const runAfterClose = useCallback(() => {
    const afterClose = afterCloseRef.current
    afterCloseRef.current = null
    afterClose?.()
  }, [])

  const requestClose = useCallback((afterClose?: BottomSheetAfterClose | unknown) => {
    if (closing) return
    afterCloseRef.current = typeof afterClose === 'function' ? afterClose as BottomSheetAfterClose : null
    if (!isOpen) {
      onClose()
      runAfterClose()
      return
    }

    clearCloseTimer()
    dragRef.current.active = false
    dragRef.current.captured = false
    setDragging(false)
    setDragOffset(0)
    setClosing(true)

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      onClose()
      setClosing(false)
      setDragOffset(0)
      runAfterClose()
    }, closeDurationMs)
  }, [clearCloseTimer, closeDurationMs, closing, isOpen, onClose, runAfterClose])

  const resetDrag = useCallback(() => {
    dragRef.current.active = false
    dragRef.current.captured = false
    dragRef.current.pointerId = null
    setDragging(false)
    setDragOffset(0)
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isOpen || closing) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return
    const scrollableParent = getScrollableParent(event.target, event.currentTarget)
    if (scrollableParent && scrollableParent.scrollTop > 2) return

    dragRef.current = {
      active: true,
      captured: false,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      startTime: performance.now()
    }
    setClosing(false)
    setDragging(false)
    setDragOffset(0)
  }, [closing, isOpen])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return

    drag.lastY = event.clientY
    const rawOffset = event.clientY - drag.startY
    if (!drag.captured) {
      if (rawOffset < -4) {
        resetDrag()
        return
      }
      if (rawOffset <= 4) return

      drag.captured = true
      setDragging(true)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }

    const nextOffset = Math.max(0, rawOffset)
    setDragOffset(nextOffset)

    if (nextOffset > 3) {
      event.preventDefault()
    }
  }, [resetDrag])

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return

    const offset = Math.max(0, drag.lastY - drag.startY)
    const elapsed = Math.max(1, performance.now() - drag.startTime)
    const velocity = offset / elapsed
    const wasCaptured = drag.captured
    dragRef.current.active = false
    dragRef.current.captured = false
    dragRef.current.pointerId = null
    setDragging(false)
    if (wasCaptured) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }

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
    afterCloseRef.current = null
    resetDrag()
    setClosing(false)
  }, [clearCloseTimer, isOpen, resetDrag])

  useEffect(() => () => {
    afterCloseRef.current = null
    clearCloseTimer()
  }, [clearCloseTimer])

  const backdropProgress = closing
    ? 0
    : clampProgress(1 - dragOffset / Math.max(1, backdropTravelPx))

  const sheetStyle: CSSProperties | undefined = dragging || closing || dragOffset > 0
    ? {
        transform: `translate3d(0, ${closing ? '104%' : `${dragOffset}px`}, 0)`,
        transition: dragging ? 'none' : `transform ${closeDurationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        willChange: 'transform'
      }
    : undefined

  const backdropStyle: BottomSheetBackdropStyle | undefined = dragging || closing || dragOffset > 0
    ? {
        pointerEvents: closing ? 'none' : undefined,
        '--bottom-sheet-progress': String(backdropProgress)
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
    sheetDragProps: dragHandleProps,
    requestClose,
    dragging,
    closing,
    dragOffset,
    backdropProgress
  }
}
