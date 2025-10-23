import { useState, useEffect } from 'react'

type ScrollDirection = 'up' | 'down' | null

export const useScrollDirection = (threshold: number = 10) => {
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(null)
  const [lastScrollY, setLastScrollY] = useState(0)

  useEffect(() => {
    const updateScrollDirection = () => {
      const scrollY = window.scrollY
      const direction = scrollY > lastScrollY ? 'down' : 'up'

      // Solo actualizar si el scroll es mayor al threshold (evita cambios muy pequeños)
      if (Math.abs(scrollY - lastScrollY) > threshold) {
        setScrollDirection(direction)
        setLastScrollY(scrollY)
      }
    }

    // Usar requestAnimationFrame para mejor performance
    let ticking = false
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          updateScrollDirection()
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', onScroll)

    return () => window.removeEventListener('scroll', onScroll)
  }, [lastScrollY, threshold])

  return scrollDirection
}
