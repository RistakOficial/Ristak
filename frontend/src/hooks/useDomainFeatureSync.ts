import { useEffect, useRef } from 'react'
import { useAppConfig } from './useAppConfig'
import { useIsRenderDomain } from './useIsRenderDomain'
import { trackingService } from '@/services/trackingService'

type VisitorSource = 'platform' | 'tracking'

/**
 * Mantiene sincronizadas las preferencias dependientes del dominio
 * (como la visibilidad de Analíticas) sin importar desde qué host
 * se cargó la aplicación.
 *
 * - En dominios .onrender.com: se fuerza show_analytics = false y visitor_source = 'platform'
 * - En dominios personalizados: se habilitan automáticamente cuando exista configuración de tracking
 */
export const useDomainFeatureSync = () => {
  const isRenderDomain = useIsRenderDomain()
  const [showAnalytics, setShowAnalytics] = useAppConfig<boolean>('show_analytics', false)
  const [visitorSource, setVisitorSource] = useAppConfig<VisitorSource>('visitor_source', 'platform')
  const syncingRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    const desiredAnalytics = isRenderDomain ? false : true
    const desiredVisitor: VisitorSource = isRenderDomain ? 'platform' : 'tracking'

    // Ya estamos en el estado esperado, no hacer nada
    if (showAnalytics === desiredAnalytics && visitorSource === desiredVisitor) {
      return
    }

    const syncPreferences = async () => {
      if (syncingRef.current) return
      syncingRef.current = true

      let analyticsChanged = false
      let visitorChanged = false

      try {
        if (isRenderDomain) {
          if (showAnalytics !== false) {
            await setShowAnalytics(false)
            analyticsChanged = true
          }
          if (visitorSource !== 'platform') {
            await setVisitorSource('platform')
            visitorChanged = true
          }
        } else {
          let shouldEnable = true

          try {
            const config = await trackingService.getTrackingConfig()
            shouldEnable = Boolean(config?.trackingDomain?.trim()) ||
              Boolean(config?.showAnalytics) ||
              Boolean(config?.isConfigured)
          } catch {
            // Si la API falla, preferimos habilitar (fail-open) para no ocultar Analíticas por error transitorio
            shouldEnable = true
          }

          if (!shouldEnable) return

          if (!showAnalytics) {
            await setShowAnalytics(true)
            analyticsChanged = true
          }
          if (visitorSource !== 'tracking') {
            await setVisitorSource('tracking')
            visitorChanged = true
          }
        }

        if (!cancelled) {
          if (analyticsChanged) {
            window.dispatchEvent(new CustomEvent('analytics-preference-changed', {
              detail: { showAnalytics: !isRenderDomain }
            }))
          }
          if (visitorChanged) {
            window.dispatchEvent(new CustomEvent('visitor-source-changed', {
              detail: { visitorSource: isRenderDomain ? 'platform' : 'tracking' }
            }))
          }
        }
      } catch {
      } finally {
        syncingRef.current = false
      }
    }

    syncPreferences()

    return () => {
      cancelled = true
    }
  }, [isRenderDomain, showAnalytics, visitorSource, setShowAnalytics, setVisitorSource])
}
