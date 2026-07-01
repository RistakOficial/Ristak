import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Elements, PaymentElement } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { stripePaymentsService } from '@/services/stripePaymentsService'

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
        // Para el preview preferimos la llave de prueba; si no, la activa.
        const key = config.manualModes?.test?.publishableKey || config.publishableKey || ''
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

interface StripePaymentElementPreviewProps {
  amount: number
  currency: string
  fallback: React.ReactNode
}

export const StripePaymentElementPreview: React.FC<StripePaymentElementPreviewProps> = ({ amount, currency, fallback }) => {
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

  // Lee los tokens del lienzo para replicar EXACTO la apariencia del checkout en vivo.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const token = (name: string) => {
      const value = cs.getPropertyValue(name).trim()
      return value || undefined
    }
    const dark = Boolean(el.closest('.rstk-dark'))
    setAppearance({
      theme: dark ? 'night' : 'stripe',
      variables: {
        colorPrimary: token('--rstk-accent'),
        colorText: token('--rstk-ink'),
        colorBackground: token('--rstk-input-bg'),
        borderRadius: token('--rstk-radius'),
      },
    })
  }, [stripePromise])

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
        <Elements key={`${options.amount}-${options.currency}-${(options.appearance as { theme?: string })?.theme}`} stripe={stripePromise!} options={options}>
          <PaymentElement options={{ layout: 'tabs', readOnly: true }} />
        </Elements>
      ) : (
        fallback
      )}
    </div>
  )
}
