// Contrato de pago de Sites — módulo compartido backend/frontend.
// ESM puro, CERO imports: mismas reglas de elegibilidad de MSI, predicado de
// habilitación y apariencia de Stripe en el editor y en el sitio publicado, para
// que el preview del bloque de pago no invente filas ni colores que el vivo no muestra.
// No cambia flujos de negocio (cobro, tokens, webhooks): solo describe qué se ve.

export const PAYMENT_GATEWAYS = new Set(['stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])

// Opciones de meses ofrecidas en el panel. El monto y la pasarela filtran cuáles
// aplican realmente (ver msiEligibility / conektaInstallmentMonths).
export const MSI_INSTALLMENT_CHOICES = [3, 6, 9, 12, 18, 24]

// Pasarelas que aceptan diferido a meses en el link/checkout HOSTED simple
// (createPaymentGateLink). Stripe se maneja aparte (solo MXN y monto >= 300 vía
// Payment Element), por eso NO está aquí.
export const MSI_LINK_GATEWAYS = new Set(['conekta', 'mercadopago', 'clip'])

// Predicado de "gate habilitado" sobre una config YA normalizada. Espejo exacto de
// isPaymentGateEnabled (backend) e isPaymentGateConfigEnabled (frontend).
export function isNormalizedPaymentGateEnabled(config = {}) {
  return Boolean(config && config.enabled && Number(config.amount) > 0 && PAYMENT_GATEWAYS.has(config.gateway))
}

// Meses de Conekta que el runtime publicado realmente muestra: filtrados por el
// máximo configurado y por monto (cada mes exige amount >= m*100). Debe seguir en
// lockstep con conektaInstallmentMonths del runtime inline (mountConekta).
export function conektaInstallmentMonths({ maxInstallments = 0, amount = 0 } = {}) {
  const max = Math.trunc(Number(maxInstallments) || 0)
  if (!(max > 1)) return []
  const amt = Number(amount) || 0
  return MSI_INSTALLMENT_CHOICES.filter(months => months <= max && amt >= months * 100)
}

// Dónde vive el diferido a meses por pasarela en el checkout EMBEBIDO:
// - Conekta: fila propia (standalone) con un <select> de meses filtrados por monto.
// - Mercado Pago: dentro del Brick (no hay fila propia).
// - Stripe: dentro del Payment Element (solo MXN y monto >= 300; Stripe decide).
// El editor usa esto para mostrar SOLO la fila que el vivo mostraría.
export const STRIPE_MSI_MIN_AMOUNT = 300
export const CLIP_MSI_MIN_AMOUNT = 300

export function msiEligibility({ gateway = '', currency = '', amount = 0, msi = null } = {}) {
  const enabled = Boolean(msi && msi.enabled) && Number(msi.maxInstallments) > 1
  const none = { enabled, standaloneMonths: [], insideElement: false, insideBrick: false }
  if (!enabled) return none
  if (gateway === 'conekta') {
    return { ...none, standaloneMonths: conektaInstallmentMonths({ maxInstallments: msi.maxInstallments, amount }) }
  }
  if (gateway === 'mercadopago') {
    return { ...none, insideBrick: true }
  }
  if (gateway === 'stripe') {
    const eligible = String(currency || '').toUpperCase() === 'MXN' && Number(amount) >= STRIPE_MSI_MIN_AMOUNT
    return { ...none, insideElement: eligible }
  }
  if (gateway === 'clip') {
    const eligible = String(currency || '').toUpperCase() === 'MXN' && Number(amount) >= CLIP_MSI_MIN_AMOUNT
    return { ...none, insideElement: eligible }
  }
  return none
}

// Apariencia de Stripe Elements a partir de tokens del bloque. UNA sola fórmula para
// el preview del editor (StripePaymentElementPreview) y — vía test de equivalencia —
// para el runtime inline mountStripe. `dark` decide tema 'night' vs 'stripe' y si se
// declara colorBackground (el tema night no lo necesita).
export function buildStripeAppearanceVariables({ dark = false, accent, fieldText, muted, inputBg, radius } = {}) {
  const variables = {
    colorPrimary: accent || undefined,
    colorText: fieldText || undefined,
    colorTextSecondary: muted || undefined,
    colorTextPlaceholder: muted || undefined,
    borderRadius: radius || undefined
  }
  if (!dark) variables.colorBackground = inputBg || undefined
  return { theme: dark ? 'night' : 'stripe', variables }
}
