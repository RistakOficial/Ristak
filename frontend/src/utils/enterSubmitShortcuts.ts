const TEXT_INPUT_TYPES = new Set([
  '',
  'date',
  'datetime-local',
  'email',
  'month',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'time',
  'url',
  'week'
])

const ACTION_WORDS = new Set([
  'aceptar',
  'actualizar',
  'agregar',
  'anadir',
  'aplicar',
  'cargar',
  'confirmar',
  'conectar',
  'continuar',
  'crear',
  'enviar',
  'finalizar',
  'generar',
  'guardar',
  'importar',
  'iniciar',
  'listo',
  'mandar',
  'programar',
  'publicar',
  'reconectar',
  'reintentar',
  'siguiente',
  'subir'
])

const NON_ACTION_WORDS = new Set([
  'anterior',
  'atras',
  'borrar',
  'cancelar',
  'cerrar',
  'descartar',
  'desactivar',
  'desconectar',
  'desinstalar',
  'eliminar',
  'limpiar',
  'quitar',
  'remover',
  'revocar',
  'volver'
])

const IGNORE_SELECTOR = [
  '[data-enter-submit="ignore"]',
  '[data-enter-submit-ignore]',
  '[data-no-enter-submit]'
].join(',')

type ClickableAction = HTMLButtonElement | HTMLInputElement
type TextEntryElement = HTMLInputElement | HTMLTextAreaElement

declare global {
  interface Window {
    __ristakEnterSubmitShortcutsInstalled?: boolean
  }
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function getWords(value: string) {
  return normalizeText(value).match(/[a-z0-9]+/g) || []
}

function includesAnyWord(value: string, words: Set<string>) {
  return getWords(value).some((word) => words.has(word))
}

function getEventElement(event: KeyboardEvent) {
  const [first] = event.composedPath()
  if (first instanceof HTMLElement) return first
  return event.target instanceof HTMLElement ? event.target : null
}

function isTextInput(element: HTMLElement): element is HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) return false
  if (element.disabled || element.readOnly) return false
  return TEXT_INPUT_TYPES.has(element.type)
}

function isTextEntryElement(element: HTMLElement): element is TextEntryElement {
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly
  }

  return isTextInput(element)
}

function isSearchLikeInput(input: HTMLInputElement) {
  if (input.type === 'search') return true

  const hints = [
    input.getAttribute('aria-label') || '',
    input.getAttribute('placeholder') || '',
    input.getAttribute('name') || ''
  ].join(' ')

  return includesAnyWord(hints, new Set(['buscar', 'busqueda', 'filtrar', 'filtro', 'search']))
}

function isElementVisible(element: HTMLElement) {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false

  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
}

function isEnabledAction(element: Element): element is ClickableAction {
  if (!(element instanceof HTMLButtonElement) && !(element instanceof HTMLInputElement)) return false
  if (element.matches(IGNORE_SELECTOR)) return false
  if (element.disabled) return false
  if (element.getAttribute('aria-disabled') === 'true') return false
  if (element.getAttribute('data-disabled') === 'true') return false
  if (!isElementVisible(element)) return false

  const type = element.getAttribute('type')?.toLowerCase() || ''
  return type !== 'reset' && type !== 'file' && type !== 'hidden'
}

function getActionLabel(element: ClickableAction) {
  return [
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || '',
    element instanceof HTMLInputElement ? element.value : '',
    element.textContent || ''
  ].join(' ')
}

function getActionScore(element: ClickableAction) {
  const label = getActionLabel(element)
  if (includesAnyWord(label, NON_ACTION_WORDS)) return 0

  if (element.matches('[data-enter-submit], [data-enter-submit-primary]')) return 100
  if ((element.getAttribute('type') || '').toLowerCase() === 'submit') return 90
  if (includesAnyWord(label, ACTION_WORDS)) return element.getAttribute('data-v') === 'primary' ? 85 : 75
  if (element.getAttribute('data-v') === 'primary') return 65
  return 0
}

function findActionInScope(scope: HTMLElement) {
  const actions = Array.from(scope.querySelectorAll('button, input[type="button"], input[type="submit"]'))
    .filter(isEnabledAction)
    .map((element) => ({ element, score: getActionScore(element) }))
    .filter(({ score }) => score >= 75)
    .sort((left, right) => right.score - left.score)

  if (!actions.length) return null

  const [best, next] = actions
  if (next && next.score === best.score) return null
  return best.element
}

function findLocalAction(input: TextEntryElement) {
  let scope = input.parentElement
  let depth = 0

  while (scope && scope !== document.body && depth < 10) {
    const action = findActionInScope(scope)
    if (action) return action

    scope = scope.parentElement
    depth += 1
  }

  const dialog = input.closest<HTMLElement>('[role="dialog"], [data-modal], [data-overlay]')
  return dialog ? findActionInScope(dialog) : null
}

function submitForm(form: HTMLFormElement, submitter?: ClickableAction | null) {
  if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
    submitter.click()
    return
  }

  if (form.matches('[data-enter-submit], [data-enter-submit-primary]') && typeof form.requestSubmit === 'function') {
    form.requestSubmit()
    return
  }

  if (form.matches('[data-enter-submit], [data-enter-submit-primary]')) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
}

function handleEnterSubmitShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (event.key !== 'Enter') return
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.isComposing) return

  const target = getEventElement(event)
  if (!target) return
  if (target.closest(IGNORE_SELECTOR)) return
  if (target.closest('[contenteditable="true"]')) return
  if (!isTextEntryElement(target)) return
  if (document.activeElement !== target) return

  if (target instanceof HTMLTextAreaElement && event.shiftKey) return
  if (event.shiftKey) return

  if (target.form) {
    const action = findActionInScope(target.form)
    if (!action && !target.form.matches('[data-enter-submit], [data-enter-submit-primary]')) return

    event.preventDefault()
    submitForm(target.form, action)
    return
  }

  if (target instanceof HTMLInputElement && isSearchLikeInput(target)) return

  const action = findLocalAction(target)
  if (action) {
    event.preventDefault()
    action.click()
    return
  }

  event.preventDefault()
  target.blur()
}

export function installEnterSubmitShortcuts() {
  if (typeof window === 'undefined' || window.__ristakEnterSubmitShortcutsInstalled) return

  window.__ristakEnterSubmitShortcutsInstalled = true
  document.addEventListener('keydown', handleEnterSubmitShortcut)
}
