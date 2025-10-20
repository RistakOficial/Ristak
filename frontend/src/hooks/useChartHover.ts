import { useState, useEffect, useRef, useCallback } from 'react'

interface UseChartHoverProps {
  data?: any[]
  enabled?: boolean
}

interface ChartHoverState {
  mousePos: { x: number; y: number }
  pointPos: { x: number; y: number } | null
  isHovering: boolean
  activeIndex: number
  activeData: any
}

export const useChartHover = (props: UseChartHoverProps = {}) => {
  const { data: maybeData = [], enabled = true } = props
  const data = Array.isArray(maybeData) ? maybeData : []
  const chartRef = useRef<HTMLDivElement>(null)
  const pointPositionsRef = useRef<Array<number | undefined>>([])
  const dataLength = data.length
  const [state, setState] = useState<ChartHoverState>({
    mousePos: { x: 0, y: 0 },
    pointPos: null,
    isHovering: false,
    activeIndex: -1,
    activeData: null
  })

  const updatePointPositions = useCallback(() => {
    if (!chartRef.current) {
      pointPositionsRef.current = []
      return
    }

    const dots = chartRef.current.querySelectorAll<SVGCircleElement>('[data-chart-index]')
    if (dots.length === 0) {
      pointPositionsRef.current = []
      return
    }

    const positions: Array<number | undefined> = new Array(dataLength).fill(undefined)

    dots.forEach(dot => {
      const indexAttr = dot.getAttribute('data-chart-index')
      if (!indexAttr) return

      const index = Number(indexAttr)
      if (Number.isNaN(index) || index < 0 || index >= dataLength) return

      const rect = dot.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2

      if (Number.isNaN(centerX)) return

      const current = positions[index]
      positions[index] = typeof current === 'number' ? Math.min(current, centerX) : centerX
    })

    pointPositionsRef.current = positions
  }, [dataLength])

  const getPointXForIndex = useCallback((index: number, rect: DOMRect) => {
    const storedPositions = pointPositionsRef.current
    const storedValue = storedPositions[index]

    if (typeof storedValue === 'number') {
      return storedValue
    }

    if (dataLength <= 1) {
      return rect.left + rect.width / 2
    }

    const ratio = dataLength > 1 ? index / (dataLength - 1) : 0
    const clampedRatio = Math.max(0, Math.min(1, ratio))

    return rect.left + clampedRatio * rect.width
  }, [dataLength])

  const resolveNearestIndex = useCallback((clientX: number, rect: DOMRect) => {
    const storedPositions = pointPositionsRef.current
    let nearestIndex = -1
    let minDistance = Number.POSITIVE_INFINITY

    for (let idx = 0; idx < dataLength; idx += 1) {
      const pos = storedPositions[idx]
      if (typeof pos !== 'number') continue

      const distance = Math.abs(pos - clientX)
      if (distance < minDistance) {
        minDistance = distance
        nearestIndex = idx
      }
    }

    if (nearestIndex !== -1) {
      return {
        index: nearestIndex,
        pointX: getPointXForIndex(nearestIndex, rect)
      }
    }

    if (rect.width <= 0 || dataLength === 0) {
      return { index: -1, pointX: clientX }
    }

    const relativeX = clientX - rect.left
    const clampedRelativeX = Math.max(0, Math.min(rect.width, relativeX))
    const ratio = rect.width === 0 ? 0 : clampedRelativeX / rect.width
    const fallbackIndex = Math.max(
      0,
      Math.min(dataLength - 1, Math.round(ratio * (dataLength - 1)))
    )

    return {
      index: fallbackIndex,
      pointX: getPointXForIndex(fallbackIndex, rect)
    }
  }, [dataLength, getPointXForIndex])

  useEffect(() => {
    if (!enabled) {
      pointPositionsRef.current = []
      return
    }

    let resizeFrame: number | null = null

    const scheduleUpdate = () => {
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame)
      }
      resizeFrame = requestAnimationFrame(() => {
        updatePointPositions()
        resizeFrame = null
      })
    }

    scheduleUpdate()

    const handleResize = () => scheduleUpdate()
    window.addEventListener('resize', handleResize)

    const currentChart = chartRef.current

    let resizeObserver: ResizeObserver | null = null
    if (currentChart && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleUpdate())
      resizeObserver.observe(currentChart)
    }

    let mutationObserver: MutationObserver | null = null
    if (currentChart && typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(() => scheduleUpdate())
      mutationObserver.observe(currentChart, { childList: true, subtree: true, attributes: true })
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeObserver) resizeObserver.disconnect()
      if (mutationObserver) mutationObserver.disconnect()
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame)
      }
    }
  }, [dataLength, enabled, updatePointPositions])

  useEffect(() => {
    if (!enabled) return

    let animationFrame: number | null = null

    const interactiveSelectors = [
      '.recharts-area-curve',
      '.recharts-area-area',
      '.recharts-line-curve',
      '.recharts-line-dots',
      '.recharts-dot',
      '.recharts-active-dot',
      '[data-chart-interactive="true"]'
    ]

    const isInteractiveElement = (element: Element | null) => {
      if (!element) return false
      return interactiveSelectors.some(selector => element.closest(selector))
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
      }

      animationFrame = requestAnimationFrame(() => {
        animationFrame = null
        const newMousePos = { x: e.clientX, y: e.clientY }

        if (chartRef.current && dataLength > 0) {
          const rect = chartRef.current.getBoundingClientRect()
          const hoveredElement = document.elementFromPoint(e.clientX, e.clientY)
          const isTargetWithinChart =
            hoveredElement !== null && chartRef.current.contains(hoveredElement)
          const isPointerWithinBounds =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          const isOverInteractiveElement =
            hoveredElement instanceof Element && isInteractiveElement(hoveredElement)
          const isInActiveRegion = isPointerWithinBounds && isTargetWithinChart && isOverInteractiveElement

          if (isInActiveRegion) {
            if (!pointPositionsRef.current.length) {
              updatePointPositions()
            }

            const { index: nearestIndex, pointX } = resolveNearestIndex(e.clientX, rect)

            if (nearestIndex >= 0) {
              const pointY = rect.top + rect.height * 0.5

              setState(prev => {
                if (prev.activeIndex !== nearestIndex || !prev.isHovering) {
                  return {
                    mousePos: newMousePos,
                    pointPos: { x: pointX, y: pointY },
                    isHovering: true,
                    activeIndex: nearestIndex,
                    activeData: data[nearestIndex]
                  }
                }

                const hasPointChanged =
                  !prev.pointPos || prev.pointPos.x !== pointX || prev.pointPos.y !== pointY

                if (hasPointChanged) {
                  return {
                    ...prev,
                    mousePos: newMousePos,
                    pointPos: { x: pointX, y: pointY },
                    activeData: data[nearestIndex]
                  }
                }

                if (prev.activeData !== data[nearestIndex]) {
                  return { ...prev, mousePos: newMousePos, activeData: data[nearestIndex] }
                }

                return { ...prev, mousePos: newMousePos }
              })
              return
            }
          }

          setState(prev =>
            prev.isHovering
              ? {
                  mousePos: newMousePos,
                  pointPos: null,
                  isHovering: false,
                  activeIndex: -1,
                  activeData: null
                }
              : { ...prev, mousePos: newMousePos }
          )
        } else {
          setState(prev => ({ ...prev, mousePos: newMousePos }))
        }
      })
    }

    const handleMouseLeave = () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
        animationFrame = null
      }

      setState(prev => ({
        ...prev,
        pointPos: null,
        isHovering: false,
        activeIndex: -1,
        activeData: null
      }))
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleMouseLeave)
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
      }
    }
  }, [data, dataLength, enabled, resolveNearestIndex, updatePointPositions])

  // Función para obtener si un punto específico está activo
  const isPointActive = useCallback((index: number) => {
    return state.isHovering && state.activeIndex === index
  }, [state.isHovering, state.activeIndex])

  return {
    chartRef,
    ...state,
    isPointActive
  }
}
