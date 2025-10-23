import { useState, useEffect, useRef } from 'react'

type ScrollDirection = 'up' | 'down' | null

export const useScrollDirection = (threshold: number = 10) => {
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(null)
  const lastScrollYRef = useRef(0)

  useEffect(() => {
    const updateScrollDirection = () => {
      const scrollY = window.scrollY
      const direction = scrollY > lastScrollYRef.current ? 'down' : 'up'

      // Solo actualizar si el scroll es mayor al threshold (evita cambios muy pequeños)
      if (Math.abs(scrollY - lastScrollYRef.current) > threshold) {
        setScrollDirection(direction)
        lastScrollYRef.current = scrollY
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
  }, [threshold])

  return scrollDirection
}
