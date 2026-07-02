import type React from 'react'
import type { PublicSite, SiteTemplateId } from '../../services/sitesService'
import {
  computeSitePageRenderState,
  isCssColor,
  relLuminance
} from '../../../../shared/sites/renderContract.js'
import type { SiteLike } from '../../../../shared/sites/renderContract.js'
import { ensureCanvasSiteCss } from './canvasSiteCss'

/**
 * WYSIWYG canvas theme — adaptador delgado del contrato compartido.
 *
 * Todo el cálculo de variables/clases de página vive en
 * shared/sites/renderContract.js (computeSitePageRenderState), la MISMA función
 * que consume el renderer público del backend. Aquí solo se agregan las
 * preocupaciones exclusivas del editor: variables de selección
 * (--rstk-selection-*), la simulación de viewport (--rstk-vh100) y el ancho de
 * diseño del stage (designWidth).
 */

export interface CanvasTheme {
  /** All --rstk-* variables, applied inline on the canvas root. */
  vars: React.CSSProperties
  /** body-equivalent classes: rstk-tpl-X rstk-mode rstk-kind-X rstk-centered ... */
  bodyClass: string
  /** Natural ("desktop") page width the canvas is rendered at before scaling. */
  designWidth: number
  templateId: SiteTemplateId
  centered: boolean
  chrome: 'none' | 'facebook' | 'instagram' | 'tiktok'
  isLanding: boolean
}

/**
 * Compute the canvas theme for a site. `device` shrinks the design width so the
 * mobile toggle shows the real responsive layout instead of a scaled desktop one.
 */
export const buildCanvasTheme = (site: PublicSite, device: 'desktop' | 'mobile' = 'desktop'): CanvasTheme => {
  // Shim de tipos: PublicSite.theme es una interfaz cerrada; el contrato
  // compartido acepta el shape legacy abierto (Record<string, unknown>).
  const state = computeSitePageRenderState(site as unknown as SiteLike)
  // Garantiza que la hoja de contenido compartida (rescopeada) esté inyectada
  // para este template antes de pintar el canvas. Idempotente por template.
  ensureCanvasSiteCss(state.template.id)

  // Misma fórmula histórica del editor: fondo sólido oscuro => selección clara;
  // gradientes se tratan como claros (paintFallback no aplica aquí).
  const pageIsDark = isCssColor(state.pageBg) && relLuminance(state.pageBg) < 0.5

  const vars = {
    ...state.vars,
    '--rstk-selection-border': pageIsDark ? '#60a5fa' : '#2563eb',
    '--rstk-selection-border-hover': pageIsDark ? '#93c5fd' : '#1d4ed8',
    '--rstk-selection-shadow': pageIsDark ? 'rgba(96, 165, 250, 0.24)' : 'rgba(37, 99, 235, 0.16)',
    '--rstk-selection-contrast': pageIsDark ? 'rgba(15, 23, 42, 0.36)' : 'rgba(15, 23, 42, 0.2)',
    // Simulación de 100vh dentro del canvas (el rescoper reescribe Nvh sobre
    // esta variable): alto de un viewport típico por dispositivo.
    '--rstk-vh100': device === 'mobile' ? '844px' : '780px'
  } as React.CSSProperties

  const bodyClass = state.bodyClassList.join(' ')
  const desktopChromePadding = state.isLandingType ? 48 : 32
  const designWidth = device === 'mobile' ? 390 : state.pageMaxWidth + desktopChromePadding

  return {
    vars,
    bodyClass,
    designWidth,
    templateId: state.template.id as SiteTemplateId,
    centered: Boolean(state.template.centered),
    chrome: (state.template.chrome === 'facebook' || state.template.chrome === 'instagram' || state.template.chrome === 'tiktok')
      ? state.template.chrome
      : 'none',
    isLanding: state.isLandingType
  }
}
