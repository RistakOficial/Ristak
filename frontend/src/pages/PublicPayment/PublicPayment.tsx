import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type StripeElementsOptions } from '@stripe/stripe-js'
import { AlertCircle, CheckCircle2, CreditCard, Download, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, type BadgeVariant } from '@/components/common'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '@/components/common/PaymentPlatformLogo'
import { useTheme } from '@/contexts/ThemeContext'
import {
  mercadoPagoPaymentsService,
  type MercadoPagoCardPaymentPayload,
  type PublicMercadoPagoPayment
} from '@/services/mercadoPagoPaymentsService'
import {
  conektaPaymentsService,
  type PublicConektaPayment
} from '@/services/conektaPaymentsService'
import {
  stripePaymentsService,
  type PublicStripePayment,
  type StripePaymentIntentResponse
} from '@/services/stripePaymentsService'
import { formatCurrency } from '@/utils/format'
import {
  buildInvoiceStyleVars,
  resolveInvoiceDesign,
  type PaymentInvoiceTemplateId
} from '@/utils/paymentInvoiceDesign'
import styles from './PublicPayment.module.css'

type StripePromise = ReturnType<typeof loadStripe>
type PublicPaymentData = PublicStripePayment | PublicMercadoPagoPayment | PublicConektaPayment
type DocumentThemeMode = 'light' | 'dark'
type MercadoPagoBrickController = { unmount?: () => void }
type MercadoPagoBrickBuilder = {
  create: (
    type: 'cardPayment',
    containerId: string,
    settings: Record<string, unknown>
  ) => Promise<MercadoPagoBrickController>
}
type MercadoPagoInstance = {
  bricks: () => MercadoPagoBrickBuilder
}
type MercadoPagoConstructor = new (publicKey: string, options?: { locale?: string }) => MercadoPagoInstance
type ConektaCheckoutComponents = {
  Card: (settings: {
    config: {
      targetIFrame: string
      publicKey: string
      locale?: string
      useExternalSubmit?: boolean
    }
    callbacks: Record<string, (...args: any[]) => void>
    options?: Record<string, unknown>
  }) => void
}
type MercadoPagoCardSubmitData = {
  token?: string
  payment_method_id?: string
  paymentMethodId?: string
  issuer_id?: string | number
  issuerId?: string | number
  installments?: string | number
  payer?: {
    email?: string
    first_name?: string
    firstName?: string
    last_name?: string
    lastName?: string
    identification?: {
      type?: string
      number?: string
    }
  }
}

declare global {
  interface Window {
    MercadoPago?: MercadoPagoConstructor
    ConektaCheckoutComponents?: ConektaCheckoutComponents
  }
}

const MERCADOPAGO_SDK_SRC = 'https://sdk.mercadopago.com/js/v2'
const CONEKTA_CHECKOUT_SDK_SRC = 'https://pay.conekta.com/v1.0/js/conekta-checkout.min.js'
let mercadoPagoSdkPromise: Promise<void> | null = null
let conektaCheckoutSdkPromise: Promise<void> | null = null
const STRIPE_SPANISH_COUNTRIES = new Set([
  'AR', 'BO', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'ES', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'UY', 'VE'
])
const PUBLIC_PAYMENT_LIGHT_MODE_FLAG = 'publicPaymentLightMode'

const printTemplateClassById: Record<PaymentInvoiceTemplateId, string> = {
  classic: 'printThemeClassic',
  executive: 'printThemeExecutive',
  accent: 'printThemeAccent',
  ledger: 'printThemeLedger'
}

function formatDate(value?: string | null) {
  if (!value) return 'Sin vencimiento'
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).split('T')[0]
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date)
}

function getStatusCopy(status: string) {
  const normalized = status.toLowerCase()
  if (['paid', 'succeeded', 'completed'].includes(normalized)) {
    return { label: 'Pagado', variant: 'success' as BadgeVariant }
  }
  if (['failed', 'void', 'refunded'].includes(normalized)) {
    return { label: normalized === 'refunded' ? 'Reembolsado' : 'No disponible', variant: 'error' as BadgeVariant }
  }
  return { label: 'Pendiente', variant: 'info' as BadgeVariant }
}

function readToken(name: string) {
  if (typeof window === 'undefined') return ''
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value || ''
}

function applyDocumentThemeMode(mode: DocumentThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const body = document.body
  body.classList.remove('light', 'dark')
  body.classList.add(mode)
  root.dataset.theme = mode
  body.dataset.theme = mode
  root.dataset.mode = mode
  body.dataset.mode = mode
}

function buildStripeAppearance() {
  return {
    theme: 'stripe' as const,
    variables: {
      colorPrimary: readToken('--accent'),
      colorText: readToken('--text'),
      colorTextSecondary: readToken('--text-dim'),
      colorBackground: readToken('--surface-solid') || readToken('--surface'),
      colorDanger: readToken('--neg'),
      fontFamily: readToken('--font-body'),
      borderRadius: '10px'
    }
  }
}

function buildMercadoPagoCustomization() {
  const customVariables: Record<string, string> = {
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontWeightNormal: '500',
    fontWeightSemiBold: '600',
    inputVerticalPadding: '12px',
    inputHorizontalPadding: '14px',
    inputBorderWidth: '1px',
    inputFocusedBorderWidth: '1px',
    borderRadiusSmall: '10px',
    borderRadiusMedium: '10px',
    borderRadiusLarge: '10px',
    formPadding: '0px'
  }
  const tokenMap: Record<string, string> = {
    textPrimaryColor: '--text',
    textSecondaryColor: '--text-dim',
    inputBackgroundColor: '--surface',
    formBackgroundColor: '--surface-solid',
    baseColor: '--accent',
    baseColorFirstVariant: '--accent',
    baseColorSecondVariant: '--accent-soft',
    errorColor: '--neg',
    successColor: '--pos',
    successSecondaryColor: '--pos-soft',
    outlinePrimaryColor: '--border-strong',
    outlineSecondaryColor: '--border',
    buttonTextColor: '--on-accent',
    inputFocusedBoxShadow: '--ristak-focus-ring',
    inputErrorFocusedBoxShadow: '--ristak-focus-ring'
  }

  Object.entries(tokenMap).forEach(([variable, token]) => {
    const value = readToken(token)
    if (value) customVariables[variable] = value
  })

  return {
    visual: {
      style: {
        theme: document.body?.dataset?.mode === 'dark' ? 'dark' : 'default',
        customVariables
      }
    }
  }
}

function resolveStripeLocale(payment?: PublicStripePayment | null): StripeElementsOptions['locale'] {
  const country = payment?.tax?.country?.trim().toUpperCase()
  if (country && !STRIPE_SPANISH_COUNTRIES.has(country)) return 'auto'
  return 'es'
}

function getPlanInstallmentStatusCopy(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'registered'].includes(normalized)) return 'Pagado'
  if (['scheduled', 'active'].includes(normalized)) return 'Programado'
  if (['waiting_card_authorization', 'requires_payment_method'].includes(normalized)) return 'Espera tarjeta'
  if (['deleted', 'cancelled', 'canceled', 'void'].includes(normalized)) return 'Cancelado'
  return 'Pendiente'
}

function getPlanPaymentMethodCopy(method?: string | null) {
  const normalized = String(method || '').toLowerCase()
  if (normalized.includes('stripe') || normalized.includes('card') || normalized.includes('tarjeta')) return 'Tarjeta domiciliada'
  if (normalized.includes('cash') || normalized.includes('efectivo')) return 'Manual'
  if (normalized.includes('transfer')) return 'Transferencia'
  return method || 'Por definir'
}

function loadMercadoPagoSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Mercado Pago solo se puede cargar en el navegador.'))
  if (window.MercadoPago) return Promise.resolve()
  if (mercadoPagoSdkPromise) return mercadoPagoSdkPromise

  mercadoPagoSdkPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${MERCADOPAGO_SDK_SRC}"]`)
    const handleReady = () => {
      if (window.MercadoPago) {
        resolve()
      } else {
        reject(new Error('No se pudo cargar el SDK de Mercado Pago.'))
      }
    }

    if (existingScript) {
      existingScript.addEventListener('load', handleReady, { once: true })
      existingScript.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de Mercado Pago.')), { once: true })
      window.setTimeout(handleReady, 0)
      return
    }

    const script = document.createElement('script')
    script.src = MERCADOPAGO_SDK_SRC
    script.async = true
    script.addEventListener('load', handleReady, { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de Mercado Pago.')), { once: true })
    document.head.appendChild(script)
  })

  return mercadoPagoSdkPromise
}

function loadConektaCheckoutSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Conekta solo se puede cargar en el navegador.'))
  if (window.ConektaCheckoutComponents) return Promise.resolve()
  if (conektaCheckoutSdkPromise) return conektaCheckoutSdkPromise

  conektaCheckoutSdkPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${CONEKTA_CHECKOUT_SDK_SRC}"]`)
    const handleReady = () => {
      if (window.ConektaCheckoutComponents) {
        resolve()
      } else {
        reject(new Error('No se pudo cargar el tokenizador de Conekta.'))
      }
    }

    if (existingScript) {
      existingScript.addEventListener('load', handleReady, { once: true })
      existingScript.addEventListener('error', () => reject(new Error('No se pudo cargar el tokenizador de Conekta.')), { once: true })
      window.setTimeout(handleReady, 0)
      return
    }

    const script = document.createElement('script')
    script.src = CONEKTA_CHECKOUT_SDK_SRC
    script.async = true
    script.crossOrigin = 'anonymous'
    script.addEventListener('load', handleReady, { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar el tokenizador de Conekta.')), { once: true })
    document.head.appendChild(script)
  })

  return conektaCheckoutSdkPromise
}

function createPaymentAttemptKey(publicPaymentId: string) {
  const randomId = typeof window !== 'undefined' && window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `ristak-${publicPaymentId}-${randomId}`
}

function normalizeConektaStatusMessage(status?: string) {
  const normalized = String(status || '').toLowerCase()
  if (['paid', 'succeeded', 'completed'].includes(normalized)) {
    return { kind: 'success' as const, text: 'Pago recibido. Gracias.' }
  }
  if (['pending', 'pending_payment', 'processing', 'in_process'].includes(normalized)) {
    return { kind: 'info' as const, text: 'Conekta está procesando el pago. Esta página se actualizará cuando se confirme.' }
  }
  return {
    kind: 'error' as const,
    text: 'Conekta rechazó el pago. Revisa los datos o intenta con otra tarjeta.'
  }
}

function normalizeMercadoPagoStatusMessage(status?: string, statusDetail?: string) {
  const normalized = String(status || '').toLowerCase()
  if (['approved', 'paid', 'succeeded', 'completed'].includes(normalized)) {
    return { kind: 'success' as const, text: 'Pago recibido. Gracias.' }
  }
  if (['pending', 'in_process', 'authorized'].includes(normalized)) {
    return { kind: 'info' as const, text: 'Mercado Pago está procesando el pago. Esta página se actualizará cuando se confirme.' }
  }

  const detail = String(statusDetail || '').trim()
  return {
    kind: 'error' as const,
    text: detail
      ? `Mercado Pago rechazó el pago: ${detail}. Revisa los datos o intenta con otra tarjeta.`
      : 'Mercado Pago rechazó el pago. Revisa los datos o intenta con otra tarjeta.'
  }
}

function buildMercadoPagoCardPayload(payment: PublicMercadoPagoPayment, formData: MercadoPagoCardSubmitData): MercadoPagoCardPaymentPayload {
  const token = String(formData.token || '').trim()
  const paymentMethodId = String(formData.payment_method_id || formData.paymentMethodId || '').trim()
  const issuerId = String(formData.issuer_id || formData.issuerId || '').trim()
  const payer = formData.payer || {}
  const email = String(payer.email || payment.contact?.email || '').trim()

  if (!email) {
    throw new Error('Agrega un correo para poder procesar el pago con Mercado Pago.')
  }

  return {
    token,
    paymentMethodId,
    issuerId,
    installments: Number(formData.installments || 1),
    idempotencyKey: createPaymentAttemptKey(payment.publicPaymentId),
    payer: {
      email,
      firstName: payer.firstName || payer.first_name,
      lastName: payer.lastName || payer.last_name,
      identification: payer.identification
    }
  }
}

const PublicPaymentForm: React.FC<{
  payment: PublicStripePayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)
  const isCardSetupPlan = Boolean(payment.paymentPlan?.cardSetupRequired || payment.paymentPlan?.trigger === 'card_setup')
  const submitLabel = isCardSetupPlan
    ? 'Autorizar tarjeta'
    : payment.settings?.checkout?.buttonLabel || 'Pagar'
  const submitAmount = Number(payment.amount || 0) > 0 ? ` ${formatCurrency(payment.amount, payment.currency)}` : ''
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false
  const authorizationNotice = isCardSetupPlan
    ? 'Al confirmar, Stripe guardará esta tarjeta para cobrar automáticamente los pagos programados de este plan.'
    : payment.contact?.id
      ? 'Al pagar autorizas que esta tarjeta quede resguardada en Stripe para futuros cargos acordados con este negocio.'
      : 'La tarjeta se captura en campos seguros de Stripe. Ristak solo recibe el resultado del cobro.'

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || submitting) return

    setSubmitting(true)
    setMessage('')

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/pay/${payment.publicPaymentId}?payment=return`
      },
      redirect: 'if_required'
    })

    if (result.error) {
      setMessage(result.error.message || 'No se pudo completar el pago. Revisa los datos e intenta otra vez.')
      setSubmitting(false)
      return
    }

    if (result.paymentIntent?.status === 'succeeded') {
      setSuccess(true)
      setMessage('Pago recibido. Gracias.')
      await onPaid()
    } else if (result.paymentIntent?.status === 'processing') {
      setMessage('Stripe está procesando el pago. Esta página se actualizará cuando se confirme.')
      await onPaid()
    } else {
      setMessage('Stripe necesita una acción adicional. Sigue las instrucciones del banco.')
    }

    setSubmitting(false)
  }

  return (
    <form className={styles.stripeBox} onSubmit={handleSubmit}>
      <div className={styles.stripeElementShell}>
        <PaymentElement />
      </div>

      {message && (
        <p className={`${styles.message} ${success ? styles.messageSuccess : styles.messageError}`}>
          {success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{message}</span>
        </p>
      )}

      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          fullWidth
          className={styles.payButton}
          disabled={!stripe || !elements || submitting}
          leftIcon={submitting ? <Loader2 size={16} className={styles.spin} /> : <CreditCard size={16} />}
        >
          {submitting ? 'Procesando' : `${submitLabel}${submitAmount}`}
        </Button>
      </div>

      {(showSecureNotice || payment.contact?.id || isCardSetupPlan) && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>{authorizationNotice}</span>
        </p>
      )}
    </form>
  )
}

const MercadoPagoCardPaymentForm: React.FC<{
  payment: PublicMercadoPagoPayment
  onPaid: () => Promise<void>
  onFallback: () => Promise<void>
  fallbackLoading: boolean
}> = ({ payment, onPaid, onFallback, fallbackLoading }) => {
  const containerId = useMemo(
    () => `mercadopago-card-${payment.publicPaymentId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [payment.publicPaymentId]
  )
  const controllerRef = useRef<MercadoPagoBrickController | null>(null)
  const onPaidRef = useRef(onPaid)
  const [loadingBrick, setLoadingBrick] = useState(Boolean(payment.publicKey))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info')
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false

  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])

  useEffect(() => {
    if (!payment.publicKey) {
      setLoadingBrick(false)
      setMessage('Mercado Pago no devolvió una llave pública para montar el formulario. Usa Checkout Pro como respaldo.')
      setMessageKind('error')
      return
    }

    let cancelled = false
    const mountBrick = async () => {
      setLoadingBrick(true)
      setMessage('')

      try {
        await loadMercadoPagoSdk()
        if (cancelled || !window.MercadoPago) return

        const container = document.getElementById(containerId)
        if (container) container.innerHTML = ''

        const mercadoPago = new window.MercadoPago(payment.publicKey || '', { locale: 'es-MX' })
        const bricksBuilder = mercadoPago.bricks()
        const controller = await bricksBuilder.create('cardPayment', containerId, {
          initialization: {
            amount: Number(payment.amount || 0)
          },
          customization: buildMercadoPagoCustomization(),
          callbacks: {
            onReady: () => {
              if (!cancelled) setLoadingBrick(false)
            },
            onSubmit: async (cardFormData: MercadoPagoCardSubmitData) => {
              setSubmitting(true)
              setMessage('')

              try {
                const payload = buildMercadoPagoCardPayload(payment, cardFormData)
                const result = await mercadoPagoPaymentsService.createPublicCardPayment(payment.publicPaymentId, payload)
                const statusMessage = normalizeMercadoPagoStatusMessage(result.payment?.status || result.status, result.statusDetail)
                setMessageKind(statusMessage.kind)
                setMessage(statusMessage.text)
                await onPaidRef.current()

                if (statusMessage.kind === 'error') {
                  throw new Error(statusMessage.text)
                }

                return result
              } catch (submitError: any) {
                const text = submitError?.message || 'No se pudo completar el pago. Revisa los datos e intenta otra vez.'
                setMessageKind('error')
                setMessage(text)
                throw submitError
              } finally {
                setSubmitting(false)
              }
            },
            onError: () => {
              if (cancelled) return
              setLoadingBrick(false)
              setMessageKind('error')
              setMessage('Mercado Pago no pudo montar el formulario de tarjeta. Puedes intentar de nuevo o abrir Checkout Pro.')
            }
          }
        })

        if (cancelled) {
          controller?.unmount?.()
          return
        }
        controllerRef.current = controller
      } catch (brickError: any) {
        if (cancelled) return
        setLoadingBrick(false)
        setMessageKind('error')
        setMessage(brickError?.message || 'No se pudo cargar el formulario de Mercado Pago.')
      }
    }

    mountBrick()

    return () => {
      cancelled = true
      controllerRef.current?.unmount?.()
      controllerRef.current = null
      const container = document.getElementById(containerId)
      if (container) container.innerHTML = ''
    }
  }, [containerId, payment.amount, payment.publicKey, payment.publicPaymentId])

  const messageClassName = [
    styles.message,
    messageKind === 'success' ? styles.messageSuccess : '',
    messageKind === 'error' ? styles.messageError : ''
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.stripeBox}>
      <div className={styles.mercadoPagoBrickShell}>
        {loadingBrick && (
          <div className={styles.brickLoading}>
            <Loader2 size={18} className={styles.spin} />
            <span>Cargando formulario seguro</span>
          </div>
        )}
        <div id={containerId} className={styles.mercadoPagoBrick} />
      </div>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>La tarjeta se captura en campos seguros de Mercado Pago. Ristak solo recibe el resultado del cobro.</span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{message}</span>
        </p>
      )}

      <div className={styles.fallbackAction}>
        <span>Si tu banco pide otro método, abre el checkout completo de Mercado Pago.</span>
        <Button
          type="button"
          variant="secondary"
          onClick={onFallback}
          disabled={fallbackLoading || submitting}
          leftIcon={fallbackLoading ? <Loader2 size={16} className={styles.spin} /> : <ExternalLink size={16} />}
        >
          {fallbackLoading ? 'Abriendo' : 'Checkout Pro'}
        </Button>
      </div>
    </div>
  )
}

const ConektaCardTokenizerForm: React.FC<{
  payment: PublicConektaPayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const containerId = useMemo(
    () => `conekta-card-${payment.publicPaymentId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [payment.publicPaymentId]
  )
  const onPaidRef = useRef(onPaid)
  const submitTokenizerRef = useRef<(() => void) | null>(null)
  const [loadingTokenizer, setLoadingTokenizer] = useState(Boolean(payment.publicKey))
  const [tokenizerReady, setTokenizerReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info')
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false

  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])

  useEffect(() => {
    if (!payment.publicKey) {
      setLoadingTokenizer(false)
      setMessage('Conekta no devolvió una llave pública para montar el tokenizador.')
      setMessageKind('error')
      return
    }

    let cancelled = false
    const mountTokenizer = async () => {
      setLoadingTokenizer(true)
      setTokenizerReady(false)
      submitTokenizerRef.current = null
      setMessage('')

      try {
        await loadConektaCheckoutSdk()
        if (cancelled || !window.ConektaCheckoutComponents) return

        const container = document.getElementById(containerId)
        if (container) container.innerHTML = ''

        window.ConektaCheckoutComponents.Card({
          config: {
            targetIFrame: `#${containerId}`,
            publicKey: payment.publicKey,
            locale: 'es',
            useExternalSubmit: true
          },
          callbacks: {
            onUpdateSubmitTrigger: (submitFunction: () => void) => {
              if (cancelled) return
              submitTokenizerRef.current = submitFunction
              setTokenizerReady(true)
            },
            onCreateTokenSucceeded: async (token: string | { id?: string }) => {
              const tokenId = typeof token === 'string' ? token : String(token?.id || '').trim()
              if (!tokenId) {
                setMessageKind('error')
                setMessage('Conekta no devolvió un token válido. Intenta nuevamente.')
                return
              }

              setSubmitting(true)
              setMessage('')
              try {
                const result = await conektaPaymentsService.createPublicCardPayment(payment.publicPaymentId, {
                  tokenId,
                  savePaymentSource: Boolean(payment.contact?.id)
                })
                const statusMessage = normalizeConektaStatusMessage(result.payment?.status || result.status)
                setMessageKind(statusMessage.kind)
                setMessage(statusMessage.text)
                await onPaidRef.current()
              } catch (submitError: any) {
                setMessageKind('error')
                setMessage(submitError?.message || 'No se pudo completar el pago con Conekta.')
              } finally {
                setSubmitting(false)
              }
            },
            onCreateTokenError: (tokenError: any) => {
              if (cancelled) return
              const details = Array.isArray(tokenError?.details)
                ? tokenError.details.map((detail: any) => detail?.message || detail?.debug_message).filter(Boolean).join(' ')
                : ''
              setMessageKind('error')
              setMessage(tokenError?.message || details || 'Conekta no pudo tokenizar la tarjeta.')
              setSubmitting(false)
            },
            onGetInfoSuccess: () => {
              if (!cancelled) setLoadingTokenizer(false)
            }
          },
          options: {
            backgroundMode: 'lightMode',
            inputType: 'minimalMode',
            hideLogo: true,
            colorPrimary: readToken('--accent'),
            colorText: readToken('--text'),
            colorLabel: readToken('--text-dim'),
            autoResize: true
          }
        })
      } catch (tokenizerError: any) {
        if (cancelled) return
        setLoadingTokenizer(false)
        setMessageKind('error')
        setMessage(tokenizerError?.message || 'No se pudo cargar el tokenizador de Conekta.')
      }
    }

    mountTokenizer()

    return () => {
      cancelled = true
      submitTokenizerRef.current = null
      const container = document.getElementById(containerId)
      if (container) container.innerHTML = ''
    }
  }, [containerId, payment.contact?.id, payment.publicKey, payment.publicPaymentId])

  const handleSubmit = () => {
    const submitTokenizer = submitTokenizerRef.current
    if (!submitTokenizer) {
      setMessageKind('error')
      setMessage('El formulario seguro de Conekta todavía no está listo. Espera un momento e intenta de nuevo.')
      return
    }

    setMessage('')
    submitTokenizer()
  }

  const messageClassName = [
    styles.message,
    messageKind === 'success' ? styles.messageSuccess : '',
    messageKind === 'error' ? styles.messageError : ''
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.stripeBox}>
      <div className={`${styles.mercadoPagoBrickShell} ${styles.conektaTokenizerShell}`}>
        {loadingTokenizer && (
          <div className={styles.brickLoading}>
            <Loader2 size={18} className={styles.spin} />
            <span>Cargando campos seguros</span>
          </div>
        )}
        <div className={styles.conektaTokenizerViewport}>
          <div id={containerId} className={styles.conektaTokenizerFrame} />
        </div>
      </div>

      <Button
        type="button"
        variant="primary"
        className={styles.conektaSubmitButton}
        onClick={handleSubmit}
        loading={submitting}
        disabled={loadingTokenizer || !tokenizerReady}
        leftIcon={!submitting ? <ShieldCheck size={16} /> : undefined}
      >
        {submitting ? 'Procesando pago' : `Pagar ${formatCurrency(payment.amount, payment.currency)}`}
      </Button>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>
            Tus datos de tarjeta viajan en campos seguros de Conekta. Ristak solo recibe el resultado del cobro.
          </span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{message}</span>
        </p>
      )}
    </div>
  )
}

export const PublicPayment: React.FC = () => {
  const { publicPaymentId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const { theme } = useTheme()
  const restoreThemeRef = useRef<DocumentThemeMode>(theme)
  const autoReceiptPrintRef = useRef('')
  const [payment, setPayment] = useState<PublicPaymentData | null>(null)
  const [intent, setIntent] = useState<StripePaymentIntentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingPayment, setStartingPayment] = useState(false)
  const [error, setError] = useState('')

  restoreThemeRef.current = theme

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return undefined

    const root = document.documentElement
    const body = document.body
    const applyPublicPaymentLightMode = () => {
      body.dataset[PUBLIC_PAYMENT_LIGHT_MODE_FLAG] = 'true'
      root.dataset[PUBLIC_PAYMENT_LIGHT_MODE_FLAG] = 'true'
      applyDocumentThemeMode('light')
    }

    applyPublicPaymentLightMode()

    const observer = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          const alreadyLight = body.dataset.mode === 'light' && root.dataset.mode === 'light' && !body.classList.contains('dark')
          if (!alreadyLight) applyPublicPaymentLightMode()
        })
      : null

    observer?.observe(body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-mode'] })
    observer?.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] })

    return () => {
      observer?.disconnect()
      delete body.dataset[PUBLIC_PAYMENT_LIGHT_MODE_FLAG]
      delete root.dataset[PUBLIC_PAYMENT_LIGHT_MODE_FLAG]
      applyDocumentThemeMode(restoreThemeRef.current)
    }
  }, [])

  const status = getStatusCopy(payment?.status || '')
  const isPaid = Boolean(payment && ['paid', 'succeeded', 'completed'].includes(payment.status.toLowerCase()))
  const isClosed = Boolean(payment && ['void', 'refunded', 'deleted'].includes(payment.status.toLowerCase()))
  const receiptDownloadRequested = searchParams.get('receipt') === '1'
  const isStripePayment = payment?.provider === 'stripe'
  const isMercadoPagoPayment = payment?.provider === 'mercadopago'
  const isConektaPayment = payment?.provider === 'conekta'
  const stripePayment = payment?.provider === 'stripe' ? payment : null
  const paymentPlan = stripePayment?.paymentPlan || null
  const shouldSavePaymentMethod = Boolean(stripePayment?.contact?.id || paymentPlan?.cardSetupRequired)
  const providerLabel = isMercadoPagoPayment ? 'Mercado Pago' : isConektaPayment ? 'Conekta' : 'Stripe'
  const providerLogo: PaymentPlatformLogoId = isMercadoPagoPayment ? 'mercadopago' : isConektaPayment ? 'conekta' : 'stripe'

  const stripePromise = useMemo<StripePromise | null>(() => {
    if (!stripePayment) return null
    const key = intent?.publishableKey || stripePayment.publishableKey
    const stripeAccount = intent?.stripeAccountId || stripePayment.stripeAccountId
    return key ? loadStripe(key, stripeAccount ? { stripeAccount } : undefined) : null
  }, [intent?.publishableKey, intent?.stripeAccountId, stripePayment])

  const elementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (!intent?.clientSecret || !stripePayment) return null
    return {
      clientSecret: intent.clientSecret,
      appearance: buildStripeAppearance(),
      locale: resolveStripeLocale(stripePayment)
    }
  }, [intent?.clientSecret, stripePayment])

  const loadPayment = async (sync = false) => {
    if (!publicPaymentId) return
    const data = await loadPublicPayment(publicPaymentId, sync)
    setPayment(data)
  }

  const loadPublicPayment = async (id: string, sync = false): Promise<PublicPaymentData> => {
    try {
      return await stripePaymentsService.getPublicPayment(id, sync)
    } catch (stripeError: any) {
      try {
        return await mercadoPagoPaymentsService.getPublicPayment(id)
      } catch {
        try {
          return await conektaPaymentsService.getPublicPayment(id)
        } catch {
          throw stripeError
        }
      }
    }
  }

  useEffect(() => {
    let mounted = true

    async function run() {
      setLoading(true)
      setError('')
      try {
        const sync = searchParams.get('payment') === 'return'
        const data = await loadPublicPayment(publicPaymentId, sync)
        if (mounted) setPayment(data)
      } catch (loadError: any) {
        if (mounted) setError(loadError.message || 'No pudimos cargar este pago.')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    run()

    return () => {
      mounted = false
    }
  }, [publicPaymentId, searchParams])

  const startPayment = async () => {
    if (!payment || startingPayment) return

    setStartingPayment(true)
    setError('')
    try {
      if (payment.provider === 'mercadopago') {
        const nextPreference = await mercadoPagoPaymentsService.ensurePublicPreference(payment.publicPaymentId)
        const paymentUrl = nextPreference.checkoutUrl || nextPreference.paymentUrl || payment.paymentUrl
        if (!paymentUrl) {
          throw new Error('Mercado Pago no devolvió un link de pago.')
        }
        window.location.assign(paymentUrl)
        return
      }

      const nextIntent = await stripePaymentsService.createPublicPaymentIntent(payment.publicPaymentId, {
        savePaymentMethod: shouldSavePaymentMethod
      })
      setIntent(nextIntent)
    } catch (intentError: any) {
      setError(intentError.message || 'No se pudo iniciar el cobro.')
    } finally {
      setStartingPayment(false)
    }
  }

  const handleDownloadPdf = () => {
    if (!payment || typeof window === 'undefined') return
    const previousTitle = document.title
    document.title = `comprobante-${payment.publicPaymentId}`
    window.requestAnimationFrame(() => {
      window.print()
      window.setTimeout(() => {
        document.title = previousTitle
      }, 500)
    })
  }

  useEffect(() => {
    if (!payment || !isPaid || !receiptDownloadRequested || typeof window === 'undefined') return
    if (autoReceiptPrintRef.current === payment.publicPaymentId) return

    autoReceiptPrintRef.current = payment.publicPaymentId
    const timer = window.setTimeout(() => {
      handleDownloadPdf()
    }, 350)

    return () => window.clearTimeout(timer)
  }, [payment, isPaid, receiptDownloadRequested])

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.statePanel}>
            <Loader2 size={34} className={styles.spin} />
            <h1>Cargando pago</h1>
            <p>Estamos preparando la información de tu pago.</p>
          </section>
        </div>
      </main>
    )
  }

  if (error && !payment) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.statePanel}>
            <AlertCircle size={34} />
            <h1>No se pudo abrir este pago</h1>
            <p>{error}</p>
          </section>
        </div>
      </main>
    )
  }

  if (!payment) return null

  const checkoutSettings = payment.settings?.checkout
  const receiptSettings = payment.settings?.receipt
  const taxDetails = payment.tax
  const logoUrl = checkoutSettings?.logoUrl || receiptSettings?.logoUrl || ''
  const invoiceLogoUrl = receiptSettings?.logoUrl || logoUrl
  const showBusinessInfo = receiptSettings?.showBusinessInfo !== false
  const showCustomerInfo = receiptSettings?.showCustomerInfo !== false
  const showTerms = receiptSettings?.showTerms !== false
  const supportItems = [
    checkoutSettings?.supportEmail,
    checkoutSettings?.supportPhone
  ].filter(Boolean)
  const businessDetails = [
    receiptSettings?.businessEmail,
    receiptSettings?.businessPhone,
    receiptSettings?.businessAddress,
    receiptSettings?.businessWebsite
  ].filter(Boolean)
  const showCheckoutBusinessInfo = !isPaid && showBusinessInfo && Boolean(receiptSettings?.businessName || businessDetails.length)
  const showCheckoutTerms = !isPaid && showTerms && Boolean(receiptSettings?.terms)
  const showCheckoutInfo = showCheckoutBusinessInfo || (!isPaid && supportItems.length > 0) || showCheckoutTerms
  const taxLabel = taxDetails?.enabled
    ? `${taxDetails.taxName || 'Impuesto'} ${taxDetails.rateValue || 0}%`
    : ''
  const hasTaxBreakdown = Boolean(taxDetails?.enabled && taxDetails.taxAmount > 0)
  const subtotalAmount = hasTaxBreakdown ? taxDetails?.subtotalAmount || 0 : payment.amount
  const taxAmount = hasTaxBreakdown ? taxDetails?.taxAmount || 0 : 0
  const totalAmount = hasTaxBreakdown ? taxDetails?.totalAmount || payment.amount : payment.amount
  const invoiceDesign = resolveInvoiceDesign(receiptSettings)
  const invoiceStyleVars = buildInvoiceStyleVars(receiptSettings)
  const printSheetClassName = [
    styles.printSheet,
    styles[printTemplateClassById[invoiceDesign.template.id]]
  ].filter(Boolean).join(' ')
  const paymentModeLabel = payment.paymentMode === 'live' ? 'Producción' : 'Prueba'
  const headline = isPaid
    ? 'Pago confirmado'
    : checkoutSettings?.headline || payment.title || 'Pago pendiente'
  const description = isPaid
    ? 'Tu pago fue recibido correctamente. Puedes descargar tu comprobante en PDF cuando lo necesites.'
    : checkoutSettings?.description || `Revisa los datos del cobro y paga de forma segura con ${providerLabel}. Ristak no ve ni guarda el número de tu tarjeta.`
  const planInstallments = paymentPlan?.installments || []
  const firstPlanPayment = paymentPlan?.firstPayment || null
  const scheduledPlanCount = planInstallments.length
  const totalPlanPayments = scheduledPlanCount + (firstPlanPayment ? 1 : 0)
  const isCardSetupPlan = Boolean(paymentPlan?.cardSetupRequired || paymentPlan?.trigger === 'card_setup')
  const planTotal = Number(paymentPlan?.total || 0)
  const addedInstallmentCount = Number(paymentPlan?.changeSummary?.addedInstallmentCount || 0)
  const hasPlanSummary = Boolean(paymentPlan && (planTotal > 0 || firstPlanPayment || scheduledPlanCount > 0))

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brandLockup}>
            {logoUrl && (
              <img className={styles.brandLogo} src={logoUrl} alt="" />
            )}
            <div>
              <span className={styles.eyebrow}>Ristak Payments</span>
              <strong>{receiptSettings?.businessName || 'Pago seguro'}</strong>
            </div>
          </div>
          <Badge variant={status.variant} className={styles.statusBadge}>
            {isPaid ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />}
            {status.label}
          </Badge>
        </header>

        <section className={styles.checkoutLayout}>
          <section className={styles.summaryPane} aria-label="Resumen del pago">
            <div className={styles.summaryIntro}>
              <span className={styles.eyebrow}>{isPaid ? 'Comprobante listo' : hasPlanSummary ? 'Plan de pagos' : 'Checkout seguro'}</span>
              <h1 className={styles.title}>{headline}</h1>
              <p className={styles.subtitle}>{description}</p>
            </div>

            <div className={styles.summaryAmountBlock} aria-label={isPaid ? 'Total pagado' : 'Total a pagar'}>
              <span>{isPaid ? 'Total pagado' : isCardSetupPlan ? 'Monto de este link' : 'Total a pagar'}</span>
              <strong>
                {isCardSetupPlan && Number(totalAmount || 0) <= 0
                  ? 'Sin cargo inmediato'
                  : formatCurrency(totalAmount, payment.currency)}
              </strong>
            </div>

            <div className={styles.summarySection}>
              <div className={styles.sectionHeading}>
                <span className={styles.eyebrow}>Concepto</span>
                <h2>{payment.title || 'Pago'}</h2>
                {payment.description && <p>{payment.description}</p>}
              </div>

              <div className={styles.summaryRows}>
                <div>
                  <span>Cliente</span>
                  <strong>{payment.contact?.name || 'Cliente'}</strong>
                </div>
                {payment.contact?.email && (
                  <div>
                    <span>Email</span>
                    <strong>{payment.contact.email}</strong>
                  </div>
                )}
                <div>
                  <span>Vencimiento</span>
                  <strong>{formatDate(payment.dueDate)}</strong>
                </div>
                {hasTaxBreakdown && (
                  <div>
                    <span>Subtotal</span>
                    <strong>{formatCurrency(subtotalAmount, payment.currency)}</strong>
                  </div>
                )}
                {hasTaxBreakdown && (
                  <div>
                    <span>{taxDetails?.calculationMode === 'inclusive' ? 'Impuesto incluido' : 'Impuesto'}</span>
                    <strong>{taxLabel} · {formatCurrency(taxAmount, payment.currency)}</strong>
                  </div>
                )}
                <div>
                  <span>Total</span>
                  <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
                </div>
                <div>
                  <span>Referencia</span>
                  <strong>{payment.publicPaymentId}</strong>
                </div>
              </div>
            </div>

            {showCheckoutInfo && (
              <div className={styles.checkoutInfoBlock}>
                {showCheckoutBusinessInfo && (
                  <div className={styles.checkoutInfoGroup}>
                    <span className={styles.eyebrow}>Información del negocio</span>
                    <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                    {businessDetails.map((detail, index) => (
                      <span className={styles.checkoutInfoLine} key={`${detail}-${index}`}>{detail}</span>
                    ))}
                  </div>
                )}

                {!isPaid && supportItems.length > 0 && (
                  <div className={styles.checkoutInfoGroup}>
                    <span className={styles.eyebrow}>Soporte del cobro</span>
                    <p>¿Necesitas ayuda con tu pago? {supportItems.join(' · ')}</p>
                  </div>
                )}

                {showCheckoutTerms && (
                  <div className={styles.checkoutInfoGroup}>
                    <span className={styles.eyebrow}>Términos y condiciones</span>
                    <p>{receiptSettings?.terms}</p>
                  </div>
                )}
              </div>
            )}

            {hasPlanSummary && paymentPlan && (
              <div className={styles.planSection}>
                <div className={styles.sectionHeading}>
                  <span className={styles.eyebrow}>Resumen del plan</span>
                  <h2>{paymentPlan.title || 'Plan de pagos'}</h2>
                  {paymentPlan.description && <p>{paymentPlan.description}</p>}
                </div>

                {isCardSetupPlan && (
                  <p className={styles.planNotice}>
                    Este link domicilia tu tarjeta para cobrar automáticamente los pagos programados del plan.
                  </p>
                )}

                {addedInstallmentCount > 0 && (
                  <p className={styles.planNotice}>
                    {paymentPlan.changeSummary?.label || `${addedInstallmentCount} pagos agregados`}. Ya están incluidos en el calendario de cobro.
                  </p>
                )}

                <div className={styles.planStats}>
                  <div>
                    <span>Total del plan</span>
                    <strong>{formatCurrency(planTotal || totalAmount, paymentPlan.currency || payment.currency)}</strong>
                  </div>
                  <div>
                    <span>Pagos del plan</span>
                    <strong>{totalPlanPayments || scheduledPlanCount || 1}</strong>
                  </div>
                  <div>
                    <span>Frecuencia</span>
                    <strong>{paymentPlan.recurrenceLabel || 'Personalizada'}</strong>
                  </div>
                </div>

                {firstPlanPayment && (
                  <div className={styles.planLine}>
                    <span>Primer pago</span>
                    <strong>
                      {formatCurrency(firstPlanPayment.amount, paymentPlan.currency || payment.currency)} · {formatDate(firstPlanPayment.date)}
                    </strong>
                    <small>
                      {getPlanInstallmentStatusCopy(firstPlanPayment.status)} · {getPlanPaymentMethodCopy(firstPlanPayment.method)}
                    </small>
                  </div>
                )}

                {scheduledPlanCount > 0 && (
                  <div className={styles.planTimeline}>
                    <div className={styles.planTimelineHeader}>
                      <span>Calendario</span>
                      <strong>{scheduledPlanCount} {scheduledPlanCount === 1 ? 'pago programado' : 'pagos programados'}</strong>
                    </div>
                    {planInstallments.map((installment, index) => (
                      <div className={styles.timelineItem} key={installment.id || `${installment.sequence}-${index}`}>
                        <span className={styles.timelineIndex}>{installment.sequence || index + 1}</span>
                        <div>
                          <strong>
                            {formatCurrency(installment.amount, paymentPlan.currency || payment.currency)}
                            {installment.changeType === 'added' && <span className={styles.addedTag}>Agregado</span>}
                          </strong>
                          <span>{formatDate(installment.dueDate)} · {getPlanInstallmentStatusCopy(installment.status)}</span>
                          <small>{getPlanPaymentMethodCopy(installment.paymentMethod)}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={styles.payPanel} aria-label="Formulario de pago">
            <div className={styles.payHeader}>
              <div className={styles.payHeaderTop}>
                <PaymentPlatformLogo platform={providerLogo} size="lg" decorative />
                <div>
                  <span className={styles.payKicker}>{isPaid ? 'Estado final' : 'Método de pago'}</span>
                  <h2>{isPaid ? 'Pago confirmado' : isCardSetupPlan ? 'Autorizar tarjeta' : 'Pagar con tarjeta'}</h2>
                </div>
              </div>
              <p>
                {isPaid
                  ? 'Este pago ya aparece como pagado en Ristak.'
                  : isMercadoPagoPayment
                    ? 'Captura la tarjeta en el formulario seguro de Mercado Pago sin salir de esta página.'
                    : isConektaPayment
                      ? 'Captura la tarjeta en el tokenizador seguro de Conekta sin salir de esta página.'
                      : isCardSetupPlan
                        ? 'Stripe guardará la tarjeta para cobrar el plan según el calendario mostrado.'
                        : 'Los datos se capturan en el formulario seguro de Stripe.'}
              </p>
            </div>

            {error && (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </p>
            )}

            {isPaid ? (
              <div className={styles.receiptBox}>
                <p className={`${styles.message} ${styles.messageSuccess}`}>
                  <CheckCircle2 size={16} />
                  <span>Listo. El pago fue recibido y el invoice quedó marcado como pagado.</span>
                </p>
                <div className={styles.receiptRows}>
                  {showBusinessInfo && (
                    <div>
                      <span>Negocio</span>
                      <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                    </div>
                  )}
                  {showCustomerInfo && (
                    <div>
                      <span>Cliente</span>
                      <strong>{payment.contact?.name || 'Cliente'}</strong>
                    </div>
                  )}
                  <div>
                    <span>Total pagado</span>
                    <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
                  </div>
                  <div>
                    <span>Fecha de pago</span>
                    <strong>{formatDate(payment.paidAt || new Date().toISOString())}</strong>
                  </div>
                  <div>
                    <span>Vencimiento</span>
                    <strong>{formatDate(payment.dueDate)}</strong>
                  </div>
                  {hasTaxBreakdown && (
                    <div>
                      <span>Impuesto</span>
                      <strong>{formatCurrency(taxAmount, payment.currency)}</strong>
                    </div>
                  )}
                  <div>
                    <span>Pasarela</span>
                    <strong className={styles.providerValue}>
                      <PaymentPlatformLogo platform={providerLogo} size="sm" decorative />
                      <span>{providerLabel} · {paymentModeLabel}</span>
                    </strong>
                  </div>
                  <div>
                    <span>Referencia</span>
                    <strong>{payment.publicPaymentId}</strong>
                  </div>
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    leftIcon={<Download size={16} />}
                    onClick={handleDownloadPdf}
                  >
                    Descargar PDF
                  </Button>
                </div>
                {showBusinessInfo && receiptSettings && (
                  <div className={styles.businessInfo}>
                    {receiptSettings.businessEmail && <span>{receiptSettings.businessEmail}</span>}
                    {receiptSettings.businessPhone && <span>{receiptSettings.businessPhone}</span>}
                    {receiptSettings.businessAddress && <span>{receiptSettings.businessAddress}</span>}
                    {receiptSettings.businessWebsite && <span>{receiptSettings.businessWebsite}</span>}
                  </div>
                )}
              </div>
            ) : isClosed ? (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>Este link ya no está disponible para cobrar.</span>
              </p>
            ) : isMercadoPagoPayment ? (
              <MercadoPagoCardPaymentForm
                payment={payment}
                onPaid={() => loadPayment(true)}
                onFallback={startPayment}
                fallbackLoading={startingPayment}
              />
            ) : isConektaPayment ? (
              <ConektaCardTokenizerForm
                payment={payment}
                onPaid={() => loadPayment(true)}
              />
            ) : isStripePayment && stripePromise && elementsOptions ? (
              <Elements stripe={stripePromise} options={elementsOptions}>
                <PublicPaymentForm payment={payment} onPaid={() => loadPayment(true)} />
              </Elements>
            ) : (
              <div className={styles.stripeBox}>
                <p className={styles.message}>
                  <ShieldCheck size={16} />
                  <span>Stripe abrirá el campo seguro de tarjeta cuando inicies el pago.</span>
                </p>
                {shouldSavePaymentMethod && (
                  <p className={styles.cardAuthorizationNotice}>
                    <ShieldCheck size={16} />
                    <span>
                      {isCardSetupPlan
                        ? 'Al iniciar, Stripe preparará la autorización para guardar la tarjeta y domiciliar este plan.'
                        : 'Al iniciar y completar este pago, Stripe guardará la tarjeta para que el negocio pueda cobrar futuros pagos que acuerdes.'}
                    </span>
                  </p>
                )}
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="primary"
                    fullWidth
                    className={styles.payButton}
                    onClick={startPayment}
                    disabled={startingPayment || !isStripePayment || !payment.publishableKey}
                    leftIcon={startingPayment ? <Loader2 size={16} className={styles.spin} /> : <CreditCard size={16} />}
                  >
                    {startingPayment ? 'Preparando' : isCardSetupPlan ? 'Autorizar tarjeta' : checkoutSettings?.buttonLabel || 'Iniciar pago'}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </section>
      </div>

      {isPaid && (
        <article className={styles.printDocument} aria-label="Comprobante de pago para PDF">
          <section className={printSheetClassName} style={invoiceStyleVars}>
            <header className={styles.printHeader}>
              <div className={styles.printIdentity}>
                {invoiceLogoUrl && <img src={invoiceLogoUrl} alt="" />}
                <div>
                  <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                  {(receiptSettings?.businessWebsite || receiptSettings?.businessEmail) && (
                    <p>{receiptSettings?.businessWebsite || receiptSettings?.businessEmail}</p>
                  )}
                </div>
              </div>
              <div className={styles.printMeta}>
                <h1>{receiptSettings?.title || 'Comprobante de pago'}</h1>
                <span>Referencia {payment.publicPaymentId}</span>
                <span>Fecha de pago {formatDate(payment.paidAt || new Date().toISOString())}</span>
              </div>
            </header>

            {receiptSettings?.intro && <p className={styles.printIntro}>{receiptSettings.intro}</p>}

            <section className={styles.printPaymentMeta}>
              <div>
                <span>Estado</span>
                <strong>Pagado</strong>
              </div>
              <div>
                <span>Fecha de pago</span>
                <strong>{formatDate(payment.paidAt || new Date().toISOString())}</strong>
              </div>
              <div>
                <span>Vencimiento</span>
                <strong>{formatDate(payment.dueDate)}</strong>
              </div>
              <div>
                <span>Pasarela</span>
                <strong className={styles.providerValue}>
                  <PaymentPlatformLogo platform={providerLogo} size="sm" decorative />
                  <span>{providerLabel} · {paymentModeLabel}</span>
                </strong>
              </div>
            </section>

            <section className={styles.printParties}>
              {showBusinessInfo && (
                <div>
                  <span>Emitido por</span>
                  <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                  {receiptSettings?.businessEmail && <p>{receiptSettings.businessEmail}</p>}
                  {receiptSettings?.businessPhone && <p>{receiptSettings.businessPhone}</p>}
                  {receiptSettings?.businessAddress && <p>{receiptSettings.businessAddress}</p>}
                </div>
              )}
              {showCustomerInfo && (
                <div>
                  <span>Cliente</span>
                  <strong>{payment.contact?.name || 'Cliente'}</strong>
                  {payment.contact?.email && <p>{payment.contact.email}</p>}
                  {payment.contact?.phone && <p>{payment.contact.phone}</p>}
                  <p>Referencia {payment.publicPaymentId}</p>
                </div>
              )}
            </section>

            <section className={styles.printLines}>
              <div className={styles.printLineHeader}>
                <span>Concepto</span>
                <span>Cant.</span>
                <span>Importe</span>
              </div>
              <div className={styles.printLineItem}>
                <strong>{payment.title || 'Pago'}</strong>
                <span>1</span>
                <span>{formatCurrency(subtotalAmount, payment.currency)}</span>
              </div>
              {payment.description && <p className={styles.printDescription}>{payment.description}</p>}
            </section>

            <section className={styles.printTotals}>
              <div>
                <span>Subtotal</span>
                <strong>{formatCurrency(subtotalAmount, payment.currency)}</strong>
              </div>
              {hasTaxBreakdown && (
                <div>
                  <span>{taxDetails?.calculationMode === 'inclusive' ? `${taxDetails?.taxName || 'Impuesto'} incluido` : taxDetails?.taxName || 'Impuesto'}</span>
                  <strong>{formatCurrency(taxAmount, payment.currency)}</strong>
                </div>
              )}
              <div>
                <span>Total pagado</span>
                <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
              </div>
            </section>

            {showTerms && receiptSettings?.terms && (
              <section className={styles.printTerms}>
                <strong>Términos y condiciones</strong>
                <p>{receiptSettings.terms}</p>
              </section>
            )}

            {receiptSettings?.footer && <p className={styles.printFooter}>{receiptSettings.footer}</p>}
          </section>
        </article>
      )}
    </main>
  )
}
