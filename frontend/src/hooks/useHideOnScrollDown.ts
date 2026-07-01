import { useEffect, useRef, useState } from 'react'

type ScrollTarget = HTMLElement | null

interface Options {
  /** Movimiento mínimo (px) para reaccionar; evita parpadeos por micro-scrolls. */
  threshold?: number
  /** Cerca del tope siempre se revela (px). */
  revealNearTop?: number
}

/**
 * Oculta un control flotante (p. ej. el botón "Atrás") cuando el usuario scrollea
 * hacia ABAJO y lo revela cuando scrollea hacia ARRIBA o llega cerca del tope.
 *
 * La app móvil (`/movil`) scrollea contenedores internos (`[data-phone-scrollable]`),
 * NO la ventana, así que se le pasa el elemento scrolleable ya resuelto. Si es `null`
 * escucha `window` como respaldo.
 */
export function useHideOnScrollDown(
  scrollElement: ScrollTarget,
  { threshold = 8, revealNearTop = 16 }: Options = {},
): boolean {
  const [hidden, setHidden] = useState(false)
  const lastYRef = useRef(0)

  useEffect(() => {
    const scroller: HTMLElement | Window = scrollElement ?? window
    const readTop = () =>
      scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop

    lastYRef.current = readTop()
    let ticking = false

    const update = () => {
      ticking = false
      const y = readTop()

      // Cerca del tope: siempre visible.
      if (y <= revealNearTop) {
        setHidden(false)
        lastYRef.current = y
        return
      }

      const delta = y - lastYRef.current
      if (Math.abs(delta) < threshold) return
      // Baja (delta > 0) => ocultar. Sube => mostrar.
      setHidden(delta > 0)
      lastYRef.current = y
    }

    const onScroll = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(update)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scrollElement, threshold, revealNearTop])

  return hidden
}
