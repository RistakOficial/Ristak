import { useMemo } from 'react'

/**
 * Hook para detectar si estamos en un dominio de Render (.onrender.com)
 * Ejemplos de dominios Render:
 * - cliente-demo.onrender.com
 * - cliente-demo-342.onrender.com
 * - drramirez.onrender.com
 * - mipagina.onrender.com
 *
 * Uso:
 * ```tsx
 * const isRenderDomain = useIsRenderDomain()
 * if (isRenderDomain) {
 *   // Mostrar instrucciones de dominio personalizado para el rastreo web.
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
