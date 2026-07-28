import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { getFloatingLayerZIndex } from '@/utils/layering'

interface AnchoredPortalOptions {
  /** 'auto' abre abajo y cae hacia arriba si no cabe. */
  placement?: 'auto' | 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  gap?: number
  minWidth?: number
  maxWidth?: number
  maxHeight?: number
  /** Igualar el ancho del panel al del ancla (default true). */
  matchWidth?: boolean
  /** Permite medir el ancho real de un panel de contenido variable. */
  panelRef?: RefObject<HTMLElement | null>
  viewportPadding?: number
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
  const {
    placement = 'auto',
    align = 'start',
    gap = 6,
    minWidth,
    maxWidth,
    maxHeight = 340,
    matchWidth = true,
    panelRef,
    viewportPadding = 12
  } = options
  const [style, setStyle] = useState<CSSProperties>({})
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom'>('bottom')
  const [availableHeight, setAvailableHeight] = useState(0)

  const update = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor || typeof window === 'undefined') return
    const rect = anchor.getBoundingClientRect()
    const viewportWidth = Math.max(0, window.innerWidth)
    const viewportHeight = Math.max(0, window.innerHeight)
    const viewportContentWidth = Math.max(0, viewportWidth - viewportPadding * 2)
    const measuredPanelWidth = panelRef?.current?.offsetWidth || 0
    const preferredWidth = matchWidth
      ? Math.max(rect.width, minWidth || 0)
      : Math.max(measuredPanelWidth, minWidth || 0, rect.width)
    const width = Math.min(preferredWidth, maxWidth || preferredWidth, viewportContentWidth)
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap - viewportPadding)
    const spaceAbove = Math.max(0, rect.top - gap - viewportPadding)
    const openAbove = placement === 'top' ||
      (placement === 'auto' && spaceBelow < maxHeight && spaceAbove > spaceBelow)
    const available = openAbove ? spaceAbove : spaceBelow
    const height = Math.min(maxHeight, available)
    const preferredLeft = align === 'end'
      ? rect.right - width
      : align === 'center'
        ? rect.left + (rect.width - width) / 2
        : rect.left
    const maxLeft = Math.max(viewportPadding, viewportWidth - width - viewportPadding)
    const maxTop = Math.max(viewportPadding, viewportHeight - height - viewportPadding)

    setResolvedPlacement(openAbove ? 'top' : 'bottom')
    setAvailableHeight(height)
    setStyle({
      position: 'fixed',
      top: openAbove
        ? Math.max(viewportPadding, rect.top - height - gap)
        : Math.min(rect.bottom + gap, maxTop),
      left: Math.min(Math.max(viewportPadding, preferredLeft), maxLeft),
      right: 'auto',
      bottom: 'auto',
      width,
      maxHeight: height,
      zIndex: getFloatingLayerZIndex(anchor, 'popover')
    })
  }, [
    anchorRef,
    align,
    gap,
    matchWidth,
    maxHeight,
    maxWidth,
    minWidth,
    panelRef,
    placement,
    viewportPadding
  ])

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

  return { style, placement: resolvedPlacement, availableHeight, update }
}

export default useAnchoredPortal
