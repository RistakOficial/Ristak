import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { getFloatingLayerZIndex } from '@/utils/layering'

interface AnchoredPortalOptions {
  /** 'auto' abre abajo y cae hacia arriba si no cabe. */
  placement?: 'auto' | 'top' | 'bottom'
  gap?: number
  minWidth?: number
  maxHeight?: number
  /** Igualar el ancho del panel al del ancla (default true). */
  matchWidth?: boolean
}

/**
 * Posiciona un panel flotante (dropdown, popover) ANCLADO a un elemento, para
 * renderizarlo en un portal en <body> y que SIEMPRE quede por delante — sin que
 * lo recorte ningún contenedor con overflow. Reutilizable en cualquier dropdown.
 *
 * Devuelve el `style` (position: fixed + top/left/width/zIndex) que debe recibir
 * el panel dentro del portal, y el `placement` resuelto ('top' | 'bottom').
 */
export function useAnchoredPortal(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: AnchoredPortalOptions = {}
) {
  const { placement = 'auto', gap = 6, minWidth, maxHeight = 340, matchWidth = true } = options
  const [style, setStyle] = useState<CSSProperties>({})
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom'>('bottom')

  const update = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor || typeof window === 'undefined') return
    const rect = anchor.getBoundingClientRect()
    const pad = 12
    const width = matchWidth
      ? (minWidth ? Math.max(rect.width, minWidth) : rect.width)
      : (minWidth || rect.width)
    const spaceBelow = window.innerHeight - rect.bottom - pad
    const spaceAbove = rect.top - pad
    const openAbove = placement === 'top' ||
      (placement === 'auto' && spaceBelow < maxHeight && spaceAbove > spaceBelow)
    const available = Math.max(160, openAbove ? spaceAbove : spaceBelow)
    const height = Math.min(maxHeight, available)
    setResolvedPlacement(openAbove ? 'top' : 'bottom')
    setStyle({
      position: 'fixed',
      top: openAbove
        ? Math.max(pad, rect.top - height - gap)
        : Math.min(rect.bottom + gap, window.innerHeight - pad - height),
      left: Math.min(Math.max(pad, rect.left), window.innerWidth - width - pad),
      width,
      maxHeight: height,
      zIndex: getFloatingLayerZIndex(anchor, 'popover')
    })
  }, [anchorRef, gap, matchWidth, maxHeight, minWidth, placement])

  // Posición inicial antes de pintar, para evitar el "salto" del panel.
  useLayoutEffect(() => {
    if (open) update()
  }, [open, update])

  useEffect(() => {
    if (!open) return
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, update])

  return { style, placement: resolvedPlacement }
}

export default useAnchoredPortal
