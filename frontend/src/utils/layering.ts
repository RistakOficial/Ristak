export type FloatingLayer = 'dropdown' | 'popover' | 'tooltip'

export const isInsideModalLayer = (element?: Element | null): boolean => {
  if (!element) return false
  return Boolean(element.closest('[data-modal], [data-overlay], [data-phone-modal-root="true"]'))
}

export const getFloatingLayerZIndex = (
  element: Element | null | undefined,
  layer: FloatingLayer
): string => {
  return `var(--z-index-${isInsideModalLayer(element) ? 'modal-' : ''}${layer})`
}
