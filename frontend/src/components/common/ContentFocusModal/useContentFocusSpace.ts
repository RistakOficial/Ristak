import { useLayoutEffect, useState, type RefObject } from 'react'

/** Available space outside the file's intrinsic size, so fitting never feeds
 * the rendered file's dimensions back into itself. */
export function useContentFocusSpace(ref: RefObject<HTMLElement | null>, enabled = true, withToolbar = false) {
  const [space, setSpace] = useState({ width: 800, height: 600 })
  useLayoutEffect(() => {
    const viewport = ref.current
    if (!enabled || !viewport) return
    const modal = viewport.closest<HTMLElement>('[data-modal]')
    const overlay = modal?.closest<HTMLElement>('[data-overlay]')
    if (!modal || !overlay) return
    const header = modal.querySelector<HTMLElement>('[data-modal-header]')
    const details = modal.querySelector<HTMLElement>('[data-content-focus-details]')
    const stage = viewport.closest<HTMLElement>('[data-content-focus-stage]')
    const toolbar = withToolbar ? viewport.previousElementSibling as HTMLElement | null : null
    const padding = (element: Element | null, axis: 'width' | 'height') => {
      if (!element) return 0
      const css = getComputedStyle(element)
      const keys = axis === 'width' ? ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
        : ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
      return keys.reduce((total, key) => total + (parseFloat(css[key as keyof CSSStyleDeclaration] as string) || 0), 0)
    }
    const measure = () => {
      const css = getComputedStyle(modal)
      const width = Math.min(parseFloat(css.getPropertyValue('--modal-fit-max-width')) || 1200,
        overlay.clientWidth - padding(overlay, 'width'), window.innerWidth - 48)
        - padding(modal, 'width') - padding(stage, 'width') - (viewport !== stage ? padding(viewport, 'width') : 0)
      const height = Math.min(parseFloat(css.maxHeight) || overlay.clientHeight,
        overlay.clientHeight - padding(overlay, 'height')) - padding(modal, 'height')
        - (header?.offsetHeight || 0) - (details?.offsetHeight || 0)
        - (toolbar?.offsetHeight || 0) - padding(stage, 'height')
        - (viewport !== stage ? padding(viewport, 'height') : 0)
      const next = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) }
      setSpace(previous => previous.width === next.width && previous.height === next.height ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [overlay, header, details, toolbar]) if (element) observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [ref, enabled, withToolbar])
  return space
}
