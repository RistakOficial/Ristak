declare global {
  interface Window {
    __ristakNumberInputSafetyInstalled?: boolean
  }
}

function getWheelInputTarget(event: WheelEvent) {
  const [firstTarget] = event.composedPath()
  if (firstTarget instanceof HTMLInputElement) return firstTarget
  return event.target instanceof HTMLInputElement ? event.target : null
}

function isEditableNumberInput(input: HTMLInputElement) {
  return input.type === 'number' && !input.disabled && !input.readOnly
}

function handleNumberInputWheel(event: WheelEvent) {
  if (event.defaultPrevented) return

  const input = getWheelInputTarget(event)
  if (!input || !isEditableNumberInput(input)) return
  if (document.activeElement !== input) return

  event.preventDefault()
  input.blur()
}

export function installNumberInputWheelGuard() {
  if (typeof window === 'undefined' || window.__ristakNumberInputSafetyInstalled) return

  window.__ristakNumberInputSafetyInstalled = true
  document.addEventListener('wheel', handleNumberInputWheel, { capture: true, passive: false })
}
