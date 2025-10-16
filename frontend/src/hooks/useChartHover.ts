import { useState, useEffect, useRef, useCallback } from 'react'

interface UseChartHoverProps {
  data: any[]
  enabled?: boolean
}

interface ChartHoverState {
  mousePos: { x: number; y: number }
  isHovering: boolean
  activeIndex: number
  activeData: any
}

export const useChartHover = ({ data, enabled = true }: UseChartHoverProps) => {
  const chartRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ChartHoverState>({
    mousePos: { x: 0, y: 0 },
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
          const isInChart =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom

          if (isInChart) {
            // Calcular el índice del punto más cercano
            const relativeX = e.clientX - rect.left
            const chartWidth = rect.width
            const dataIndex = Math.round((relativeX / chartWidth) * (data.length - 1))
            const clampedIndex = Math.max(0, Math.min(data.length - 1, dataIndex))

            setState(prev => {
              if (prev.activeIndex !== clampedIndex || !prev.isHovering) {
                return {
                  mousePos: newMousePos,
                  isHovering: true,
                  activeIndex: clampedIndex,
                  activeData: data[clampedIndex]
                }
              }
              return { ...prev, mousePos: newMousePos }
            })
          } else {
            setState(prev =>
              prev.isHovering
                ? { mousePos: newMousePos, isHovering: false, activeIndex: -1, activeData: null }
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