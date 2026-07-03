/**
 * keyboardFocusScroll — mantiene el campo de texto enfocado SIEMPRE por encima
 * del teclado en pantallas táctiles (app móvil Capacitor + tablets + web móvil).
 *
 * Por qué existe: con `Keyboard.setResizeMode(Body)` la unidad `100dvh` NO se
 * encoge cuando sube el teclado (solo el visual viewport lo hace), y las
 * pantallas con contenido centrado vertical (login, "cambiar empresa") dejaban el
 * input debajo del teclado: escribías a ciegas.
 *
 * Qué hace: al enfocar cualquier input/textarea/contenteditable, espera a que el
 * teclado se asiente y desplaza SOLO el contenedor scrollable más cercano
 * (nunca la ventana ni los shells `position: fixed`) lo justo para dejar el campo
 * visible dentro del área realmente visible. Es idempotente (si ya está visible
 * no hace nada).
 *
 * Fuente de verdad = el visual viewport EN VIVO (no las CSS vars), lo que lo hace
 * correcto en AMBOS modos de teclado de Capacitor:
 *  - `Body`: el WebView no encoge; `visualViewport.height` = área sobre el teclado.
 *  - `Native`: el WebView sí encoge; `visualViewport.height` = WebView encogido.
 * En los dos casos el borde inferior visible es `offsetTop + height`, así que la
 * misma cuenta sirve. En escritorio es un no-op: sin teclado el campo enfocado ya
 * está dentro del área visible. Cede el control al chat, que maneja su propio ciclo.
 */

// Tipos de <input> que NO abren teclado de texto: los ignoramos.
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'image',
  'hidden',
])

// Aire que dejamos entre el campo y el borde superior del teclado.
const COMFORT_MARGIN = 24

function isEditableTarget(el: EventTarget | Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return true
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return !NON_TEXT_INPUT_TYPES.has(type)
  }
  return false
}

function isOptedOut(el: HTMLElement): boolean {
  // Mientras el chat gestiona su propio teclado, nosotros no tocamos nada.
  if (document.documentElement.getAttribute('data-phone-chat-keyboard') === 'true') return true
  if (el.closest('[data-no-focus-scroll="true"], [data-phone-chat-composer="true"]')) return true
  return false
}

/**
 * Busca el contenedor scrollable más cercano (por marcador explícito o por
 * overflow real). Nunca devuelve <body>/<html>: así jamás desplazamos la ventana
 * ni un shell `position: fixed`, solo el scroller local del campo.
 */
function findScroller(start: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start.parentElement
  const docEl = document.documentElement
  while (node && node !== document.body && node !== docEl) {
    if (node.matches('[data-phone-scrollable="true"], [data-phone-chat-scrollable="true"]')) {
      return node
    }
    const overflowY = window.getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function scrollFocusedAboveKeyboard(target: HTMLElement): void {
  const scroller = findScroller(target)
  if (!scroller) return

  const vv = window.visualViewport
  const viewportTop = vv ? vv.offsetTop : 0
  const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight

  const scrollerRect = scroller.getBoundingClientRect()
  const visibleTop = Math.max(scrollerRect.top, viewportTop) + COMFORT_MARGIN
  const visibleBottom = Math.min(scrollerRect.bottom, viewportBottom) - COMFORT_MARGIN
  const visibleBand = visibleBottom - visibleTop
  if (visibleBand <= 0) return

  // En un contenteditable (editor rich-text) medimos el CARET, no el elemento:
  // un editor alto donde escribes abajo dejaría el cursor bajo el teclado si
  // alineáramos por el tope del elemento.
  let rect = target.getBoundingClientRect()
  if (target.isContentEditable) {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const caretRect = sel.getRangeAt(0).getBoundingClientRect()
      if (caretRect && (caretRect.width > 0 || caretRect.height > 0)) {
        rect = caretRect
      }
    }
  }

  let delta = 0
  if (rect.height >= visibleBand) {
    // Campo más alto que el área visible (textarea grande): alineamos su inicio.
    delta = rect.top - visibleTop
  } else if (rect.bottom > visibleBottom) {
    delta = rect.bottom - visibleBottom
  } else if (rect.top < visibleTop) {
    delta = rect.top - visibleTop
  }

  if (Math.abs(delta) < 2) return
  // Solo movemos el scroller local, nunca la ventana. `auto` (instantáneo) para
  // no pelear con la animación de subida del teclado.
  scroller.scrollTop += delta
}

/**
 * Instala el guardián global. Devuelve un disposer que quita todos los listeners.
 * No-op seguro si no existe `window.visualViewport`.
 */
export function installKeyboardFocusScroll(): () => void {
  if (typeof window === 'undefined' || !window.visualViewport) {
    return () => {}
  }

  let pendingTarget: HTMLElement | null = null
  let rafId = 0
  const timeouts: number[] = []

  const runAdjust = () => {
    rafId = 0
    const target = pendingTarget
    if (!target) return
    // Pudo perder el foco o desmontarse entre el focus y el reintento.
    if (!target.isConnected || document.activeElement !== target) return
    if (isOptedOut(target)) return
    scrollFocusedAboveKeyboard(target)
  }

  const scheduleAdjust = () => {
    if (rafId) window.cancelAnimationFrame(rafId)
    rafId = window.requestAnimationFrame(runAdjust)
  }

  const clearTimers = () => {
    timeouts.forEach((id) => window.clearTimeout(id))
    timeouts.length = 0
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (!isEditableTarget(target)) {
      pendingTarget = null
      return
    }
    if (isOptedOut(target)) {
      pendingTarget = null
      return
    }
    pendingTarget = target
    // El teclado aún no terminó de subir en el instante del focus. Reintentamos
    // en varios momentos: cubre "teclado ya abierto" (reenfoque entre campos, que
    // no dispara resize) y "teclado subiendo" (el resize lo reajusta al asentar).
    clearTimers()
    ;[80, 220, 400].forEach((delay) => {
      timeouts.push(window.setTimeout(scheduleAdjust, delay))
    })
  }

  // El resize del visual viewport = el teclado terminó de moverse (o rotación).
  // Reajustamos el campo activo. No escuchamos 'scroll' a propósito: el scroll
  // manual del usuario no debe re-centrar el campo en su contra.
  const onViewportResize = () => {
    const active = document.activeElement
    if (isEditableTarget(active) && !isOptedOut(active)) {
      pendingTarget = active
      scheduleAdjust()
    }
  }

  document.addEventListener('focusin', onFocusIn)
  window.visualViewport.addEventListener('resize', onViewportResize)

  return () => {
    document.removeEventListener('focusin', onFocusIn)
    window.visualViewport?.removeEventListener('resize', onViewportResize)
    if (rafId) window.cancelAnimationFrame(rafId)
    clearTimers()
    pendingTarget = null
  }
}
