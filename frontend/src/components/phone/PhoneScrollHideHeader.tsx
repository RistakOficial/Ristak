import React, { useEffect, useState } from 'react'
import { useHideOnScrollDown } from '../../hooks/useHideOnScrollDown'

const DEFAULT_SCROLL_SELECTOR =
  '[data-phone-chat-scrollable="true"], [data-phone-scrollable="true"]'

interface PhoneScrollHideHeaderProps extends React.HTMLAttributes<HTMLElement> {
  /** Selector del contenedor scrolleable asociado (por defecto los de la app móvil). */
  scrollSelector?: string
}

/**
 * Encabezado de panel móvil que reacciona al scroll: al bajar esconde su botón
 * "Atrás" y al subir lo revela. Descubre solo su contenedor scrolleable — primero
 * el hermano inmediato que sigue al <header>, y si no coincide, el primer
 * scrolleable dentro del mismo panel.
 *
 * Solo expone `data-hidden` en el <header>; el CSS decide qué ocultar (el back).
 * Así la barra y su título quedan estables y no se abre ningún hueco al colapsar.
 */
export const PhoneScrollHideHeader: React.FC<PhoneScrollHideHeaderProps> = ({
  scrollSelector = DEFAULT_SCROLL_SELECTOR,
  children,
  ...rest
}) => {
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const hidden = useHideOnScrollDown(scrollEl)

  useEffect(() => {
    if (!headerEl) return
    const sibling = headerEl.nextElementSibling as HTMLElement | null
    const resolved =
      sibling && sibling.matches(scrollSelector)
        ? sibling
        : headerEl.parentElement?.querySelector<HTMLElement>(scrollSelector) ?? null
    setScrollEl(resolved)
  }, [headerEl, scrollSelector])

  return (
    <header ref={setHeaderEl} data-hidden={hidden ? 'true' : undefined} {...rest}>
      {children}
    </header>
  )
}
