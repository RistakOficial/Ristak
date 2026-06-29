export const suppressBrowserAutofill = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'none',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-form-type': 'other'
} as const

export const suppressContactAutofill = {
  ...suppressBrowserAutofill,
  autoComplete: 'new-password'
} as const

const CONTROL_SELECTOR = 'input, textarea'

const IGNORED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

const PRESERVED_AUTOCOMPLETE_TOKENS = new Set([
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-family-name',
  'cc-given-name',
  'cc-name',
  'cc-number',
  'cc-type',
  'current-password',
  'new-password',
  'one-time-code',
  'transaction-amount',
  'transaction-currency',
  'username',
  'webauthn'
])

const AUTOFILL_ALLOWED_PATHS = new Set([
  '/login',
  '/setup',
  '/reset-password',
  '/sso',
  '/license-blocked',
  '/movil/login',
  '/movil/tenant',
  '/phone/login',
  '/phone/tenant'
])

const AUTOFILL_ALLOW_SELECTOR = [
  '[data-browser-autofill="allow"]',
  '[data-autofill="allow"]'
].join(',')

const CONTACT_HINT_PATTERN = [
  'apellido',
  'cliente',
  'contact',
  'contacto',
  'correo',
  'customer',
  'email',
  'first\\s*name',
  'full\\s*name',
  'guest',
  'invitad',
  'last\\s*name',
  'mobile',
  'name',
  'nombre',
  'phone',
  'tel[eé]fono',
  'whats',
  'whatsapp'
].join('|')

const CONTACT_HINT_RE = new RegExp(CONTACT_HINT_PATTERN, 'i')

declare global {
  interface Window {
    __ristakBrowserAutofillGuardInstalled?: boolean
  }
}

type AutofillControl = HTMLInputElement | HTMLTextAreaElement

function isAutofillAllowedRoute(pathname = window.location.pathname) {
  if (AUTOFILL_ALLOWED_PATHS.has(pathname)) return true
  return pathname.startsWith('/pay/') && pathname.length > '/pay/'.length
}

function getInputType(input: HTMLInputElement) {
  return (input.getAttribute('type') || input.type || 'text').toLowerCase()
}

function getAutocompleteTokens(control: AutofillControl) {
  return (control.getAttribute('autocomplete') || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function hasPreservedAutocomplete(control: AutofillControl) {
  return getAutocompleteTokens(control).some((token) => PRESERVED_AUTOCOMPLETE_TOKENS.has(token))
}

function getControlLabels(control: AutofillControl) {
  const labels = 'labels' in control && control.labels
    ? Array.from(control.labels).map((label) => label.textContent || '')
    : []

  const closestLabel = control.closest('label')?.textContent || ''
  if (closestLabel) labels.push(closestLabel)

  return labels.join(' ')
}

function getControlHints(control: AutofillControl) {
  return [
    control.getAttribute('aria-label') || '',
    control.getAttribute('autocomplete') || '',
    control.getAttribute('id') || '',
    control.getAttribute('name') || '',
    control.getAttribute('placeholder') || '',
    control.getAttribute('title') || '',
    getControlLabels(control)
  ].join(' ')
}

function isContactLikeControl(control: AutofillControl) {
  if (control instanceof HTMLInputElement) {
    const type = getInputType(control)
    if (type === 'email' || type === 'tel') return true
  }

  return CONTACT_HINT_RE.test(getControlHints(control))
}

function shouldSkipControl(control: AutofillControl) {
  if (isAutofillAllowedRoute()) return true
  if (control.closest(AUTOFILL_ALLOW_SELECTOR)) return true
  if (control.disabled || control.readOnly) return true
  if (hasPreservedAutocomplete(control)) return true

  if (control instanceof HTMLInputElement) {
    const type = getInputType(control)
    if (type === 'password') return true
    if (IGNORED_INPUT_TYPES.has(type)) return true
  }

  return false
}

function suppressControl(control: AutofillControl) {
  if (shouldSkipControl(control)) return

  const autoComplete = isContactLikeControl(control) ? suppressContactAutofill.autoComplete : suppressBrowserAutofill.autoComplete

  control.setAttribute('autocomplete', autoComplete)
  control.setAttribute('data-lpignore', suppressBrowserAutofill['data-lpignore'])
  control.setAttribute('data-1p-ignore', suppressBrowserAutofill['data-1p-ignore'])
  control.setAttribute('data-form-type', suppressBrowserAutofill['data-form-type'])

  const form = control.form
  if (form && !form.closest(AUTOFILL_ALLOW_SELECTOR) && !form.querySelector('input[type="password"]')) {
    form.setAttribute('autocomplete', suppressBrowserAutofill.autoComplete)
  }
}

function suppressControlsIn(root: ParentNode) {
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) {
    suppressControl(root)
  }

  root.querySelectorAll?.(CONTROL_SELECTOR).forEach((control) => {
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      suppressControl(control)
    }
  })
}

function handleAutofillFocus(event: FocusEvent) {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    suppressControl(target)
  }
}

function handleAutofillMutations(mutations: MutationRecord[]) {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node instanceof Element || node instanceof DocumentFragment) {
        suppressControlsIn(node)
      }
    })
  })
}

export function installBrowserAutofillGuard() {
  if (typeof window === 'undefined' || window.__ristakBrowserAutofillGuardInstalled) return

  window.__ristakBrowserAutofillGuardInstalled = true
  suppressControlsIn(document)
  document.addEventListener('focusin', handleAutofillFocus, true)

  const observer = new MutationObserver(handleAutofillMutations)
  observer.observe(document.documentElement, { childList: true, subtree: true })
}
