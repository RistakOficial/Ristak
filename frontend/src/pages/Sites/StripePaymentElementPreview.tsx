import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Elements, PaymentElement } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { stripePaymentsService } from '@/services/stripePaymentsService'
import { buildStripeAppearanceVariables } from '../../../../shared/sites/paymentGateContract.js'

// Preview del editor que monta el Stripe Payment Element REAL (modo diferido, sin crear
// PaymentIntent ni cargo) para que el bloque de pago luzca IDÉNTICO al checkout en vivo.
// Usa la misma apariencia (tema + tokens) que el runtime publicado (mountStripe), leída de
// los tokens --rstk-* del lienzo. Si no hay llave publicable, cae al fallback (mock).

type StripePromise = ReturnType<typeof loadStripe>

let cachedStripePromise: StripePromise | null = null
let cachedPublishableKey: string | null = null
let publishableKeyFetch: Promise<string> | null = null

function getPreviewPublishableKey(): Promise<string> {
  if (cachedPublishableKey !== null) return Promise.resolve(cachedPublishableKey)
  if (!publishableKeyFetch) {
    publishableKeyFetch = stripePaymentsService
      .getConfig()
      .then((config) => {
        // El preview del editor es SOLO visual (readOnly, sin cobro), así que la llave que
        // use no afecta la función. Preferimos una llave LIVE (pk_live_) para que Stripe NO
        // inyecte su "helper" de tarjetas de prueba (solo aparece con pk_test_ y se queda
        // pegado en document.body aunque cambies de pasarela o de página). El modo test real
        // (con su helper) aplica en el sitio PUBLICADO y en el preview de ruta pública.
        const liveKey = config.manualModes?.live?.publishableKey || ''
        const activeKey = config.publishableKey || ''
        const testKey = config.manualModes?.test?.publishableKey || ''
        const key = liveKey
          || (activeKey && !activeKey.startsWith('pk_test_') ? activeKey : '')
          || activeKey
          || testKey
          || ''
        cachedPublishableKey = key
        return key
      })
      .catch(() => {
        cachedPublishableKey = ''
        return ''
      })
  }
  return publishableKeyFetch
}

// Brillo de un color rgb/rgba (0=negro, 1=blanco). Transparente => se trata como claro.
function luminanceOf(color: string): number {
  const m = String(color || '').match(/rgba?\(([^)]+)\)/)
  if (!m) return 1
  const p = m[1].split(',')
  const a = p.length > 3 ? parseFloat(p[3]) : 1
  if (!(a > 0.15)) return 1
  return (0.299 * parseFloat(p[0]) + 0.587 * parseFloat(p[1]) + 0.114 * parseFloat(p[2])) / 255
}

interface StripePaymentElementPreviewProps {
  amount: number
  currency: string
  fallback: React.ReactNode
  fieldTextColor?: string
  showCountry?: boolean
}

export const StripePaymentElementPreview: React.FC<StripePaymentElementPreviewProps> = ({ amount, currency, fallback, fieldTextColor, showCountry = true }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [stripePromise, setStripePromise] = useState<StripePromise | null>(cachedStripePromise)
  const [failed, setFailed] = useState(false)
  const [appearance, setAppearance] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    let active = true
    getPreviewPublishableKey()
      .then((key) => {
        if (!active) return
        if (!key) { setFailed(true); return }
        if (!cachedStripePromise) cachedStripePromise = loadStripe(key)
        setStripePromise(cachedStripePromise)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])

  // Lee los tokens del lienzo para replicar EXACTO la apariencia del checkout en vivo,
  // y auto-adapta el tema al fondo REAL de la tarjeta (custom incluido) para legibilidad.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const token = (name: string) => {
      const value = cs.getPropertyValue(name).trim()
      return value || undefined
    }
    const card = el.closest('.rstk-checkout-card')
    const cardBg = card ? getComputedStyle(card).backgroundColor : ''
    const dark = luminanceOf(cardBg) < 0.5 || Boolean(el.closest('.rstk-dark'))
    // Color de texto de los campos: ajuste manual > var del bloque > color de texto del
    // bloque (--rstk-block-text) > tinta del tema — mismo orden que el runtime publicado.
    const fieldText = fieldTextColor || token('--rstk-checkout-field-text') || token('--rstk-block-text') || token('--rstk-ink')
    const muted = token('--rstk-muted')
    // Misma fórmula de apariencia que el runtime publicado (mountStripe), en el contrato
    // compartido — un test de equivalencia en backend garantiza que no se separen.
    setAppearance(buildStripeAppearanceVariables({
      dark,
      accent: token('--rstk-accent'),
      fieldText,
      muted,
      inputBg: token('--rstk-input-bg'),
      radius: token('--rstk-radius'),
    }) as unknown as Record<string, unknown>)
  }, [stripePromise, amount, currency, fieldTextColor])

  const options = useMemo(
    () => ({
      mode: 'payment' as const,
      // Stripe exige monto/moneda en modo diferido. Clamp a un mínimo razonable (MXN ≈ 10).
      amount: Math.max(1000, Math.round((Number(amount) || 1) * 100)),
      currency: (currency || 'mxn').toLowerCase(),
      // Mismo locale que el runtime publicado (mountStripe usa 'es') para labels idénticos.
      locale: 'es' as const,
      appearance: appearance || undefined,
    }),
    [amount, currency, appearance],
  )

  // Mientras carga la llave / SDK, o si falló, mostramos el fallback (mock).
  const showReal = Boolean(stripePromise && appearance && !failed)

  return (
    <div ref={containerRef} className="rstk-checkout-fields" style={{ pointerEvents: 'none' }}>
      {showReal ? (
        <Elements key={`${options.amount}-${options.currency}-${(options.appearance as { theme?: string })?.theme}-${fieldTextColor || ''}-${showCountry ? '1' : '0'}`} stripe={stripePromise!} options={options}>
          <PaymentElement options={{ layout: 'tabs', readOnly: true, fields: { billingDetails: { address: { country: showCountry ? 'auto' : 'never' } } } }} />
        </Elements>
      ) : (
        fallback
      )}
    </div>
  )
}
