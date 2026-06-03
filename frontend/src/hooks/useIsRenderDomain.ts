import { useMemo } from 'react'

/**
 * Hook para detectar si estamos en un dominio de Render (.onrender.com)
 * Ejemplos de dominios Render:
 * - ristak-app.onrender.com
 * - ristak-app342.onrender.com
 * - drramirez.onrender.com
 * - mipagina.onrender.com
 *
 * Uso:
 * ```tsx
 * const isRenderDomain = useIsRenderDomain()
 * if (isRenderDomain) {
 *   // Bloquear tracking, ocultar Analytics, etc.
 * }
 * ```
 */
export const useIsRenderDomain = (): boolean => {
  return useMemo(() => {
    // Verificar si el hostname contiene '.onrender.com'
    // Esto cubre TODOS los subdominios posibles de Render
    return window.location.hostname.includes('.onrender.com')
  }, []) // Sin dependencias - solo se evalúa una vez al montar
}
