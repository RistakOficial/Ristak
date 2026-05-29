import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import styles from './HelpTooltip.module.css'

type TooltipPosition = {
  left: number
  top: number
  placement: 'top' | 'bottom'
}

interface HelpTooltipProps {
  content?: React.ReactNode
  children: React.ReactElement
  className?: string
  delayMs?: number
  disabled?: boolean
}

const GAP = 10
const VIEWPORT_MARGIN = 12
const FALLBACK_WIDTH = 260
const FALLBACK_HEIGHT = 48

export const HelpTooltip: React.FC<HelpTooltipProps> = ({
  content,
  children,
  className,
  delayMs = 850,
  disabled = false
}) => {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const hasContent = Boolean(content) && !disabled

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const tooltipWidth = tooltipRef.current?.offsetWidth || FALLBACK_WIDTH
    const tooltipHeight = tooltipRef.current?.offsetHeight || FALLBACK_HEIGHT
    const centeredLeft = rect.left + rect.width / 2
    const minLeft = tooltipWidth / 2 + VIEWPORT_MARGIN
    const maxLeft = window.innerWidth - tooltipWidth / 2 - VIEWPORT_MARGIN
    const left = Math.min(Math.max(centeredLeft, minLeft), Math.max(minLeft, maxLeft))
    const topPlacementFits = rect.top - tooltipHeight - GAP >= VIEWPORT_MARGIN
    const placement = topPlacementFits ? 'top' : 'bottom'
    const top = placement === 'top' ? rect.top - GAP : rect.bottom + GAP

    setPosition({ left, top, placement })
  }, [])

  const show = useCallback(() => {
    if (!hasContent) return

    if (visible || timerRef.current !== null) {
      updatePosition()
      return
    }

    clearTimer()
    updatePosition()
    timerRef.current = window.setTimeout(() => {
      updatePosition()
      setVisible(true)
    }, delayMs)
  }, [clearTimer, delayMs, hasContent, updatePosition, visible])

  const hide = useCallback(() => {
    clearTimer()
    setVisible(false)
  }, [clearTimer])

  useLayoutEffect(() => {
    if (visible) {
      updatePosition()
    }
  }, [updatePosition, visible, content])

  useEffect(() => {
    if (!visible) return

    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [updatePosition, visible])

  useEffect(() => clearTimer, [clearTimer])

  const describedChild = hasContent
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      'aria-describedby': visible ? id : undefined
    })
    : children

  const tooltip = visible && position
    ? createPortal(
      <div
        id={id}
        ref={tooltipRef}
        role="tooltip"
        className={styles.tooltip}
        data-placement={position.placement}
        style={{
          left: position.left,
          top: position.top
        }}
      >
        {content}
      </div>,
      document.body
    )
    : null

  return (
    <span
      ref={triggerRef}
      className={cn(styles.wrapper, className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onMouseEnter={show}
      onMouseMove={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          hide()
        }
      }}
    >
      {describedChild}
      {tooltip}
    </span>
  )
}
