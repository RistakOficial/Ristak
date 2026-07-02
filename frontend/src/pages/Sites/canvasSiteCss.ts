import {
  RSTK_BASE_CSS,
  RSTK_TEMPLATE_EXTRAS,
  RSTK_POPUP_CSS,
  rescopeSiteCssForCanvas
} from '../../../../shared/sites/renderContract.js'

/**
 * Inyección de la hoja de contenido COMPARTIDA en el editor.
 *
 * La misma RSTK_BASE_CSS (+ extras del template + CSS del popup) que publica el
 * backend se rescopea a `.rstkCanvas` (rescopeSiteCssForCanvas) y se añade como
 * <style data-rstk-canvas-site-css> al <head> en runtime. Añadirla en runtime
 * garantiza que cae DESPUÉS del CSS bundleado (sitesCanvas.css / index.css),
 * así la hoja compartida gana los empates de cascada frente al escudo del
 * editor sin necesidad de !important.
 *
 * Memoización por template con insert-if-absent: varios canvases con templates
 * distintos coexisten (editor, biblioteca, popup, video-gate, form embebido),
 * así que los tags nunca se retiran. La base + popup se inyecta una sola vez y
 * los extras por template después (mismo orden que buildStyleSheet en vivo).
 */
let baseInjected = false
const injectedTemplateExtras = new Set<string>()

const appendStyleTag = (key: string, css: string): void => {
  const tag = document.createElement('style')
  tag.setAttribute('data-rstk-canvas-site-css', key)
  tag.textContent = css
  document.head.appendChild(tag)
}

export const ensureCanvasSiteCss = (templateId: string): void => {
  if (typeof document === 'undefined') return
  if (!baseInjected) {
    baseInjected = true
    appendStyleTag('base', rescopeSiteCssForCanvas(`${RSTK_BASE_CSS}\n${RSTK_POPUP_CSS}`))
  }
  const key = templateId || 'ristak'
  if (injectedTemplateExtras.has(key)) return
  injectedTemplateExtras.add(key)
  const extras = RSTK_TEMPLATE_EXTRAS[key]
  if (extras) appendStyleTag(key, rescopeSiteCssForCanvas(extras))
}
