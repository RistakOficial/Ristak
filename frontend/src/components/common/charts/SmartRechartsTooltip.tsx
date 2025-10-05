import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip as RechartsTooltip } from 'recharts'

type Quadrant = 'tr' | 'tl' | 'br' | 'bl'

type Offset = number | { x: number; y: number }

interface SmartRechartsTooltipProps {
  // Keep the same API for content as Recharts Tooltip
  content: React.ReactElement | ((props: any) => React.ReactNode)
  // Preferred placement around cursor
  prefer?: Quadrant
  // Force tooltip to stay above the pointer (never below)
  aboveOnly?: boolean
  // Render tooltip content into document.body to bypass parent overflow
  portalToBody?: boolean
  // Distance from cursor to tooltip box
  offset?: Offset
  // Pass-through styles for the wrapper
  wrapperStyle?: React.CSSProperties
  // Any other Recharts Tooltip props should pass-through
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

const getOffset = (offset?: Offset) => {
  if (typeof offset === 'number') return { x: offset, y: offset }
  return { x: 0, y: 60, ...(offset || {}) } // Large Y offset for clear separation from data point
}

function computePosition(
  coordinate: { x: number; y: number },
  viewBox: { x: number; y: number; width: number; height: number },
  size: { w: number; h: number },
  prefer: Quadrant,
  offset: { x: number; y: number },
  locked: Quadrant | null,
  allowed?: Quadrant[],
  clampToViewBox = true,
  hysteresis = 8
) {
  let candidatesOrder: Quadrant[] = (() => {
    switch (prefer) {
      case 'tr':
        return ['tr', 'tl', 'br', 'bl']
      case 'tl':
        return ['tl', 'tr', 'bl', 'br']
      case 'br':
        return ['br', 'bl', 'tr', 'tl']
      case 'bl':
        return ['bl', 'br', 'tl', 'tr']
    }
  })()

  if (allowed && allowed.length) {
    candidatesOrder = candidatesOrder.filter((q) => allowed.includes(q))
  }

  const boxRight = viewBox.x + viewBox.width
  const boxBottom = viewBox.y + viewBox.height

  const posFor = (q: Quadrant) => {
    // Always center horizontally for cleaner appearance
    const x = coordinate.x - (size.w / 2)
    let y: number
    
    // Vertical positioning with generous offset to avoid obstruction
    switch (q) {
      case 'tr':
      case 'tl':
        // Above the point with good separation
        y = coordinate.y - size.h - offset.y
        break
      case 'br':
      case 'bl':
        // Below the point with good separation
        y = coordinate.y + offset.y
        break
      default:
        // Default to above
        y = coordinate.y - size.h - offset.y
    }
    
    return { x, y }
  }

  const fits = (pos: { x: number; y: number }, margin = 0) =>
    pos.x >= viewBox.x + margin &&
    pos.y >= viewBox.y + margin &&
    pos.x + size.w <= boxRight - margin &&
    pos.y + size.h <= boxBottom - margin

  if (locked && (!allowed || allowed.includes(locked))) {
    const p = posFor(locked)
    if (fits(p, hysteresis)) {
      return { position: p, lock: locked }
    }
  }

  // Pick the first quadrant that fully fits; else fallback to clamped position of the preferred
  for (const q of candidatesOrder) {
    const p = posFor(q)
    if (fits(p, 0)) return { position: p, lock: q }
  }

  // If none fully fits
  const preferred = posFor(prefer)
  if (!clampToViewBox) {
    // Allow escaping the container (e.g., above the top edge)
    // If only top quadrants are allowed, choose the one that keeps us inside horizontally the most
    if (allowed && allowed.length && allowed.every((q) => q === 'tr' || q === 'tl')) {
      const other: Quadrant = prefer === 'tr' ? 'tl' : 'tr'
      const pPref = preferred
      const pOther = posFor(other)
      const overflowX = (p: { x: number }) => {
        const leftOverflow = Math.max(0, viewBox.x - p.x)
        const rightOverflow = Math.max(0, p.x + size.w - boxRight)
        return leftOverflow + rightOverflow
      }
      const pick = overflowX(pOther) < overflowX(pPref) ? { pos: pOther, q: other } : { pos: pPref, q: prefer }
      return { position: pick.pos, lock: locked || pick.q }
    }
    return { position: preferred, lock: locked || prefer }
  }
  // Clamp inside viewBox as a fallback
  const clamped = {
    x: Math.min(Math.max(preferred.x, viewBox.x), boxRight - size.w),
    y: Math.min(Math.max(preferred.y, viewBox.y), boxBottom - size.h),
  }
  return { position: clamped, lock: locked || prefer }
}

export function SmartRechartsTooltip({
  content,
  prefer = 'tr',
  aboveOnly = false,
  portalToBody = false,
  offset,
  wrapperStyle,
  ...rest
}: SmartRechartsTooltipProps) {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 180, h: 60 })
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>(undefined)
  const [locked, setLocked] = useState<Quadrant | null>(null)
  const [screenPos, setScreenPos] = useState<{ x: number; y: number } | undefined>(undefined)
  const portalRef = useRef<HTMLDivElement>(null)
  const lastPropsRef = useRef<any>(null)

  const off = useMemo(() => getOffset(offset), [offset])

  // Inner content component to measure size and update position
  function Content(props: any) {
    const ref = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
      // Store props without causing re-renders
      lastPropsRef.current = props
      
      // Measure size inline when not using portal
      if (!portalToBody) {
        const measureEl = ref.current
        if (measureEl) {
          const rect = measureEl.getBoundingClientRect()
          if (rect.width && rect.height) {
            const newSize = { w: Math.round(rect.width), h: Math.round(rect.height) }
            if (newSize.w !== size.w || newSize.h !== size.h) setSize(newSize)
          }
        }
      }

      // Determine container size as a robust fallback when viewBox is not provided reliably by Recharts
      const containerEl = (ref.current?.closest('.recharts-wrapper') || portalRef.current?.closest('.recharts-wrapper')) as HTMLElement | null
      const containerRect = containerEl?.getBoundingClientRect()

      const vb = props.viewBox || (containerRect
        ? { x: 0, y: 0, width: Math.round(containerRect.width), height: Math.round(containerRect.height) }
        : undefined)

      // Track both mouse position and data point position
      let mouseCoordinate = props.coordinate
      let dataPointCoordinate = props.coordinate
      
      // For line/area/bar charts, find the actual data point position
      if (props.activePayload && props.activePayload.length > 0) {
        // Check for active dot in DOM (most reliable for line/area charts)
        const activeDot = containerEl?.querySelector('.recharts-active-dot circle') as SVGElement
        if (activeDot) {
          const cx = activeDot.getAttribute('cx')
          const cy = activeDot.getAttribute('cy')
          if (cx && cy) {
            dataPointCoordinate = { x: parseFloat(cx), y: parseFloat(cy) }
          }
        }
        
        // For bar charts, check for active bar
        if (!activeDot) {
          const activeBar = containerEl?.querySelector('.recharts-active-bar') as SVGElement
          if (activeBar && containerEl) {
            const rect = activeBar.getBoundingClientRect()
            const containerRect = containerEl.getBoundingClientRect()
            if (rect && containerRect) {
              // Position above the bar
              dataPointCoordinate = {
                x: (rect.left - containerRect.left) + rect.width / 2,
                y: rect.top - containerRect.top
              }
            }
          }
        }
      }

      if (props.active && dataPointCoordinate && vb) {
        // Robust positioning logic to prevent tooltip from obstructing the data point
        const mouseY = mouseCoordinate?.y || dataPointCoordinate.y
        const dataY = dataPointCoordinate.y
        
        // Decision logic: Where is the mouse coming from?
        // This determines optimal tooltip placement
        const mouseApproachingFromAbove = mouseY < dataY
        
        // Calculate available space above and below the point
        const spaceAbove = dataY - vb.y
        const spaceBelow = (vb.y + vb.height) - dataY
        const tooltipHeightWithOffset = size.h + off.y + 40 // Increased padding for more separation
        
        // Always show tooltip above the data point
        let preferredQuadrant: Quadrant = 'tr'
        let allowedQuadrants: Quadrant[] = ['tr', 'tl']
        
        // Force tooltip to always appear above, regardless of mouse position
        preferredQuadrant = 'tr'
        allowedQuadrants = ['tr', 'tl']
        const { position: pos, lock } = computePosition(
          dataPointCoordinate,  // Always position relative to data point, not mouse
          vb,
          size,
          preferredQuadrant,
          off,
          locked,
          allowedQuadrants,
          // Do not clamp if we explicitly allow escaping the viewBox on Y
          !(aboveOnly || props.allowEscapeViewBox?.y || portalToBody)
        )
        // Avoid unnecessary state churn
        setPosition((prev) => (prev && prev.x === pos.x && prev.y === pos.y ? prev : pos))
        setLocked((prev) => (prev === lock ? prev : lock))

        // Screen position for portal rendering
        if (containerRect) {
          const sp = { x: Math.round(containerRect.left + pos.x), y: Math.round(containerRect.top + pos.y) }
          setScreenPos((prev) => (prev && prev.x === sp.x && prev.y === sp.y ? prev : sp))
        }

        if (!portalToBody) {
          // As a hard guarantee for certain Recharts chart types, directly set wrapper coordinates
          const el = ref.current
          const wrapper = el?.closest('.recharts-tooltip-wrapper') as HTMLElement | null
          if (wrapper) {
            // Force absolute coordinates to avoid default placement below the cursor
            wrapper.style.left = `${pos.x}px`
            wrapper.style.top = `${pos.y}px`
            wrapper.style.transform = 'translate(0px, 0px)'
            wrapper.style.zIndex = '30'
            wrapper.style.pointerEvents = 'none'
            wrapper.style.visibility = 'visible'
          }
        }
      } else {
        // Hide tooltip when not active
        if (!portalToBody) {
          const el = ref.current
          const wrapper = el?.closest('.recharts-tooltip-wrapper') as HTMLElement | null
          if (wrapper) {
            wrapper.style.visibility = 'hidden'
          }
        }
        // Clear position when not active
        setPosition(undefined)
        setScreenPos(undefined)
      }
    }, [props.active, props.coordinate?.x, props.coordinate?.y, props.viewBox?.x, props.viewBox?.y, props.viewBox?.width, props.viewBox?.height, size.w, size.h, prefer, off.x, off.y, portalToBody])

    if (portalToBody) {
      // Do not render inline content when using portal; return a small, hidden probe for measurement fallback
      return <div ref={ref} style={{ width: 0, height: 0, overflow: 'hidden' }} />
    }

    const child = typeof content === 'function' ? (content as any)(props) : React.cloneElement(content as any, props)
    return <div ref={ref} style={{ pointerEvents: 'none' }}>{child}</div>
  }

  const portalChild = lastPropsRef.current
    ? typeof content === 'function'
      ? (content as any)(lastPropsRef.current)
      : React.cloneElement(content as any, lastPropsRef.current)
    : null

  // Measure portal content size to refine positioning on next frame
  useLayoutEffect(() => {
    if (!portalToBody) return
    const el = portalRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.width && rect.height) {
        const newSize = { w: Math.round(rect.width), h: Math.round(rect.height) }
        if (newSize.w !== size.w || newSize.h !== size.h) setSize(newSize)
      }
    }
  }, [portalToBody, lastPropsRef.current?.active, screenPos?.x, screenPos?.y])

  return (
    <>
      <RechartsTooltip
        content={<Content />}
        position={position}
        // Ensure tooltip does not block hover
        wrapperStyle={{ pointerEvents: 'none', ...(portalToBody ? { display: 'none' } : {}), ...(wrapperStyle || {}) }}
        // Keep offset bigger than default when fallback logic in Recharts kicks in
        offset={Math.max(off.x, off.y)}
        isAnimationActive={false}
        // Force position to follow data point, not cursor
        cursor={false}
        {...rest}
      />

      {portalToBody && lastPropsRef.current?.active && screenPos && portalChild
        ? createPortal(
            <div
              ref={portalRef}
              style={{
                position: 'fixed',
                left: `${screenPos.x}px`,
                top: `${screenPos.y}px`,
                pointerEvents: 'none',
                zIndex: 9999,
              }}
            >
              {portalChild}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

export default SmartRechartsTooltip
