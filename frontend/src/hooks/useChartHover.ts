import { useState, useEffect, useRef, useCallback } from 'react'

interface UseChartHoverProps {
  data: any[]
  enabled?: boolean
}

interface ChartHoverState {
  mousePos: { x: number; y: number }
  pointPos: { x: number; y: number } | null
  isHovering: boolean
  activeIndex: number
  activeData: any
}

export const useChartHover = ({ data, enabled = true }: UseChartHoverProps) => {
  const chartRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ChartHoverState>({
    mousePos: { x: 0, y: 0 },
    pointPos: null,
    isHovering: false,
    activeIndex: -1,
    activeData: null
  })

  useEffect(() => {
    if (!enabled) return

    let animationFrame: number

    const handleMouseMove = (e: MouseEvent) => {
      animationFrame = requestAnimationFrame(() => {
        const newMousePos = { x: e.clientX, y: e.clientY }

        if (chartRef.current && data.length > 0) {
          const rect = chartRef.current.getBoundingClientRect()
          const hoveredElement = document.elementFromPoint(e.clientX, e.clientY)
          const isTopMostChartElement =
            hoveredElement !== null && chartRef.current.contains(hoveredElement)
          const isPointerWithinBounds =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          const isInChart = isPointerWithinBounds && isTopMostChartElement

          if (isInChart) {
            // Calcular el índice del punto más cercano
            const relativeX = e.clientX - rect.left
            const chartWidth = rect.width
            const dataIndex = Math.round((relativeX / chartWidth) * (data.length - 1))
            const clampedIndex = Math.max(0, Math.min(data.length - 1, dataIndex))

            // Calcular la posición absoluta del punto de datos
            const pointX = rect.left + (clampedIndex / (data.length - 1)) * chartWidth
            const pointY = rect.top + rect.height * 0.5 // Aproximado, se ajustará con el valor real

            setState(prev => {
              if (prev.activeIndex !== clampedIndex || !prev.isHovering) {
                return {
                  mousePos: newMousePos,
                  pointPos: { x: pointX, y: pointY },
                  isHovering: true,
                  activeIndex: clampedIndex,
                  activeData: data[clampedIndex]
                }
              }
              return { ...prev, mousePos: newMousePos, pointPos: { x: pointX, y: pointY } }
            })
          } else {
            setState(prev =>
              prev.isHovering
                ? { mousePos: newMousePos, pointPos: null, isHovering: false, activeIndex: -1, activeData: null }
                : { ...prev, mousePos: newMousePos }
            )
          }
        } else {
          setState(prev => ({ ...prev, mousePos: newMousePos }))
        }
      })
    }

    const handleMouseLeave = () => {
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
      if (animationFrame) {
        cancelAnimationFrame(animationFrame)
      }
    }
  }, [data, enabled])

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
