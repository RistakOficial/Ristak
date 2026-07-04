import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { CardCvcElement, CardExpiryElement, CardNumberElement, Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import {
  loadStripe,
  type StripeCardCvcElementChangeEvent,
  type StripeCardExpiryElementChangeEvent,
  type StripeCardNumberElementChangeEvent,
  type StripeElementsOptions,
  type StripePaymentElementOptions
} from '@stripe/stripe-js'
import { AlertCircle, CheckCircle2, ChevronDown, Copy, CreditCard, Download, ExternalLink, Info, Loader2, ShieldCheck } from 'lucide-react'
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
  clipPaymentsService,
  type PublicClipPayment
} from '@/services/clipPaymentsService'
import {
  rebillPaymentsService,
  type PublicRebillPayment,
  type RebillCustomerInformation,
  type RebillInstantProduct
} from '@/services/rebillPaymentsService'
import {
  stripePaymentsService,
  type PublicStripePayment,
  type StripeInstallmentPlan,
  type StripePaymentIntentResponse
} from '@/services/stripePaymentsService'
import { formatCurrency, formatDate as formatBusinessDate } from '@/utils/format'
import {
  buildInvoiceStyleVars,
  resolveInvoiceDesign,
  type PaymentInvoiceTemplateId
} from '@/utils/paymentInvoiceDesign'
import { PAYMENT_TEST_GUIDES } from '../../../../shared/sites/paymentTestGuides.js'
import { DEFAULT_TIMEZONE } from '@/utils/timezone'
import styles from './PublicPayment.module.css'

type StripePromise = ReturnType<typeof loadStripe>
type PublicPaymentData = PublicStripePayment | PublicMercadoPagoPayment | PublicConektaPayment | PublicClipPayment | PublicRebillPayment
type DocumentThemeMode = 'light' | 'dark'
type MercadoPagoBrickController = { unmount?: () => void }
type MetaPixelFn = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void
  queue?: unknown[]
  loaded?: boolean
  version?: string
}

function formatDate(value?: string | null, timezone = DEFAULT_TIMEZONE) {
  return formatBusinessDate(value, {
    timezone,
    includeYear: true,
    fallback: 'Sin vencimiento'
  })
}
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
type ClipCardElement = {
  mount: (containerId: string) => void
  cardToken: () => Promise<{ id?: string }>
  installments?: () => Promise<unknown>
  unmount?: () => void
}
type ClipSdkInstance = {
  element: {
    create: (type: 'Card', options?: {
      theme?: 'light' | 'dark'
      locale?: 'es' | 'en'
      paymentAmount?: number
      terms?: { enabled?: boolean }
    }) => ClipCardElement
  }
}
type ClipSdkConstructor = new (apiKey: string) => ClipSdkInstance
type RebillCheckoutElement = HTMLElement & {
  submit?: () => Promise<void>
  publicKey?: string
  language?: 'en' | 'es' | 'pt'
  instantProduct?: RebillInstantProduct
  customerInformation?: RebillCustomerInformation
  display?: RebillCheckoutDisplay
  css?: string
  oneClickCheckout?: boolean
}
type RebillExcludedPaymentMethod = 'cash' | 'bank_transfer'
type RebillCheckoutDisplay = {
  checkoutSummary: boolean
  successPage: boolean
  sandboxMode: boolean
  submitButton: boolean
  billingAddress: boolean
  customerInformation: boolean
  discountCode: boolean
  logo: boolean
  footer: boolean
  processingPayment: boolean
  errorMessage: boolean
  useAddressSearch: boolean
  excludePaymentMethods: RebillExcludedPaymentMethod[]
}
type SuccessDetailRow = {
  label: string
  value: React.ReactNode
}
type PaymentSuccessExperienceProps = {
  providerLogo: PaymentPlatformLogoId
  providerLabel: string
  title: string
  description: string
  amountLabel?: string
  amountValue?: React.ReactNode
  conceptTitle?: string
  conceptDescription?: string
  details?: SuccessDetailRow[]
  businessDetails?: string[]
  action?: React.ReactNode
  reference?: string
  confettiDelay?: number
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
    ClipSDK?: ClipSdkConstructor
    fbq?: MetaPixelFn
    _fbq?: MetaPixelFn
  }
}

const MERCADOPAGO_SDK_SRC = 'https://sdk.mercadopago.com/js/v2'
const CONEKTA_CHECKOUT_SDK_SRC = 'https://pay.conekta.com/v1.0/js/conekta-checkout.min.js'
const CLIP_SDK_SRC = 'https://sdk.clip.mx/js/clip-sdk.js'
const META_PIXEL_SDK_SRC = 'https://connect.facebook.net/en_US/fbevents.js'
const MERCADOPAGO_TEST_CARD_HELP = 'Modo prueba de Mercado Pago: usa cualquier correo con formato valido y elige el resultado con el nombre del titular, por ejemplo APRO para aprobar o FUND para fondos insuficientes.'
const CLIP_INSTALLMENT_MIN_AMOUNT = 300
const CLIP_INSTALLMENT_MONTHS = new Set([3, 6, 9, 12, 18, 24])
const STRIPE_PAYMENT_ELEMENT_OPTIONS: StripePaymentElementOptions = {
  terms: {
    card: 'never'
  },
  wallets: {
    link: 'never'
  }
}
let mercadoPagoSdkPromise: Promise<void> | null = null
let conektaCheckoutSdkPromise: Promise<void> | null = null
let clipSdkPromise: Promise<void> | null = null
let rebillSdkPromise: Promise<void> | null = null
let metaPixelSdkPromise: Promise<void> | null = null
const STRIPE_SPANISH_COUNTRIES = new Set([
  'AR', 'BO', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'ES', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'UY', 'VE'
])
const PUBLIC_PAYMENT_LIGHT_MODE_FLAG = 'publicPaymentLightMode'
// Colores de marca para el confetti de la pantalla de éxito. Se leen en vivo desde
// los tokens del tema del negocio, así el confetti siempre combina con su acento.
const CONFETTI_COLOR_TOKENS = ['--accent', '--accent-2', '--pos', '--warn', '--info'] as const
const CONFETTI_COLOR_FALLBACK = ['#2f6fed', '#4c8dff', '#1f9d57', '#c98a1e', '#1f8aa0']
const REBILL_CARD_ONLY_EXCLUDED_PAYMENT_METHODS: RebillExcludedPaymentMethod[] = ['cash', 'bank_transfer']
const REBILL_USE_HOSTED_PAYMENT_LINKS = true
const REBILL_CHECKOUT_CSS = [
  '.rebill-submit-button { border-radius: 14px; font-weight: 700; }',
  '.rebill-checkout.full-width-layout { min-height: 0 !important; overflow: visible !important; }',
  '.rebill-checkout.full-width-layout .left-section { width: 100% !important; justify-content: stretch !important; background: transparent !important; }',
  '.rebill-checkout.full-width-layout .left-section-container { width: 100% !important; max-width: 100% !important; min-width: 0 !important; margin: 0 !important; background: transparent !important; }',
  '.rebill-checkout.full-width-layout .checkout-form-section { gap: 20px !important; background: transparent !important; }',
  '.rebill-checkout.full-width-layout .payment-button-container { margin-bottom: 0 !important; }',
  '.rebill-checkout.full-width-layout .country-dropdown, .rebill-checkout.full-width-layout .select-dropdown { max-width: 100% !important; }',
  '@media (max-width: 1024px) { .rebill-checkout.full-width-layout { padding: 0 !important; } }'
].join('\n')
const REBILL_INSTALLMENT_MONTHS = [3, 6, 9, 12, 18, 24]

const printTemplateClassById: Record<PaymentInvoiceTemplateId, string> = {
  classic: 'printThemeClassic',
  executive: 'printThemeExecutive',
  accent: 'printThemeAccent',
  ledger: 'printThemeLedger'
}

type PaymentTestProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill'
type PaymentTestCardRow = {
  kind: string
  brand: string
  number: string
  cvc: string
  expiry: string
  result?: string
}
type PaymentTestScenarioRow = {
  holder: string
  result: string
}
type PaymentTestGuide = {
  title: string
  description: string
  emailHint: string
  cards: PaymentTestCardRow[]
  scenarios?: PaymentTestScenarioRow[]
}

const paymentTestGuides = PAYMENT_TEST_GUIDES as Record<PaymentTestProvider, PaymentTestGuide>

// (PAY2-004) Parámetros que Mercado Pago (Checkout Pro) adjunta en sus back_urls al
// regresar al sitio. Si la URL trae cualquiera de ellos, el usuario viene del checkout.
const MERCADOPAGO_RETURN_PARAMS = [
  'collection_status',
  'collection_id',
  'payment_id',
  'preference_id',
  'merchant_order_id',
  'external_reference'
] as const

// (PAY2-004) ¿Volvimos del checkout? true para Stripe (?payment=return) y para
// Mercado Pago (sus parámetros de retorno, incluido status=approved|pending|...).
function isPaymentReturn(params: URLSearchParams) {
  const paymentParam = params.get('payment')
  if (paymentParam === 'return' || paymentParam === 'success') return true
  if (params.has('rebill_return')) return true
  if (params.has('status')) return true
  return MERCADOPAGO_RETURN_PARAMS.some((key) => params.has(key))
}

function usePublicPaymentLightMode(theme: DocumentThemeMode) {
  const restoreThemeRef = useRef<DocumentThemeMode>(theme)
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
}

function resolveGatewayProvider(provider?: string | null): { label: string; logo: PaymentPlatformLogoId } {
  const normalized = String(provider || '').trim().toLowerCase()
  if (normalized.includes('mercado')) return { label: 'Mercado Pago', logo: 'mercadopago' }
  if (normalized.includes('conekta')) return { label: 'Conekta', logo: 'conekta' }
  if (normalized.includes('clip')) return { label: 'CLIP', logo: 'clip' }
  if (normalized.includes('rebill')) return { label: 'Rebill', logo: 'rebill' }
  return { label: 'Stripe', logo: 'stripe' }
}

function resolveGatewayReturnState(params: URLSearchParams): 'success' | 'pending' | 'cancelled' {
  const explicitResult = String(params.get('result') || '').trim().toLowerCase()
  const gatewayStatus = String(params.get('status') || params.get('collection_status') || '').trim().toLowerCase()
  const normalized = gatewayStatus || explicitResult

  if (['cancelled', 'canceled', 'cancel', 'failure', 'failed', 'rejected', 'void', 'error'].includes(normalized)) return 'cancelled'
  if (['pending', 'processing', 'in_process', 'in-process', 'requires_action'].includes(normalized)) return 'pending'
  if (['success', 'approved', 'authorized', 'paid', 'succeeded', 'completed'].includes(normalized)) return 'success'
  if (explicitResult === 'cancelled' || explicitResult === 'canceled') return 'cancelled'
  if (explicitResult === 'pending') return 'pending'
  return 'success'
}

function getStatusCopy(status: string) {
  const normalized = status.toLowerCase()
  if (['paid', 'succeeded', 'completed'].includes(normalized)) {
    return { label: 'Pagado', variant: 'success' as BadgeVariant }
  }
  if (['failed', 'void', 'refunded'].includes(normalized)) {
    return { label: normalized === 'refunded' ? 'Reembolsado' : 'No disponible', variant: 'error' as BadgeVariant }
  }
  if (normalized === 'scheduled') {
    return { label: 'Programado', variant: 'info' as BadgeVariant }
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

function buildStripeCardElementOptions() {
  const style = {
    base: {
      color: readToken('--text'),
      fontFamily: readToken('--font-body'),
      fontSize: '15px',
      fontWeight: '500',
      '::placeholder': {
        color: readToken('--text-mute')
      }
    },
    invalid: {
      color: readToken('--neg')
    }
  }

  return {
    hidePostalCode: true,
    style
  }
}

function buildStripeSplitElementOptions() {
  return {
    style: buildStripeCardElementOptions().style
  }
}

function buildStripeCardNumberElementOptions() {
  return {
    ...buildStripeSplitElementOptions(),
    showIcon: true
  }
}

function isStripeMissingAdditionalCardDetails(error?: { code?: string; message?: string } | null) {
  const blob = `${error?.code || ''} ${error?.message || ''}`.toLowerCase()
  return (
    blob.includes('incomplete_expiry') ||
    blob.includes('incomplete_cvc') ||
    blob.includes('expiration') ||
    blob.includes('expiry') ||
    blob.includes('cvc') ||
    blob.includes('security code') ||
    blob.includes('caducidad') ||
    blob.includes('código de seguridad') ||
    blob.includes('codigo de seguridad')
  )
}

function stripeControlledInstallmentsEnabled(payment?: PublicStripePayment | null) {
  return Boolean(
    payment?.stripeInstallments?.enabled &&
    String(payment.currency || '').toUpperCase() === 'MXN' &&
    Number(payment.amount || 0) >= Number(payment.stripeInstallments?.minAmount || 300)
  )
}

function getStripeInstallmentMax(payment?: PublicStripePayment | null) {
  const max = Math.trunc(Number(payment?.stripeInstallments?.maxInstallments || 24))
  if (!Number.isFinite(max) || max <= 0) return 24
  return Math.max(3, Math.min(max, 24))
}

function getStripePlanMonthlyAmount(payment: PublicStripePayment, count: number) {
  const months = Math.max(1, Math.trunc(Number(count || 1)))
  return Math.round((Number(payment.amount || 0) / months) * 100) / 100
}

function getMercadoPagoMaxInstallments(payment?: PublicMercadoPagoPayment | null) {
  const maxInstallments = Number(payment?.mercadoPagoInstallments?.maxInstallments || 0)
  if (!Number.isFinite(maxInstallments) || maxInstallments <= 0) return null
  return Math.max(1, Math.min(Math.trunc(maxInstallments), 60))
}

const CONEKTA_INSTALLMENT_TERMS = [
  { months: 3, minAmount: 300 },
  { months: 6, minAmount: 600 },
  { months: 9, minAmount: 900 },
  { months: 12, minAmount: 1200 },
  { months: 18, minAmount: 1800 },
  { months: 24, minAmount: 2400 }
]

function getAvailableConektaInstallmentOptions(payment: PublicConektaPayment) {
  const configured = payment.conektaInstallments
  if (!configured?.enabled) return []

  const amount = Number(payment.amount || 0)
  const maxInstallments = Math.trunc(Number(configured.maxInstallments || 0))
  if (!Number.isFinite(maxInstallments) || maxInstallments <= 1) return []

  const configuredOptions = Array.isArray(configured.options) && configured.options.length
    ? configured.options
    : CONEKTA_INSTALLMENT_TERMS

  return configuredOptions
    .map((option) => ({
      months: Math.trunc(Number(option.months)),
      minAmount: Number(option.minAmount || 0)
    }))
    .filter((option) => (
      Number.isFinite(option.months) &&
      option.months > 1 &&
      option.months <= maxInstallments &&
      amount >= option.minAmount
    ))
    .sort((left, right) => left.months - right.months)
}

function clipInstallmentsEnabledForPayment(payment: PublicClipPayment) {
  const configured = payment.clipInstallments
  return Boolean(
    configured?.enabled &&
    Number(configured.maxInstallments || 0) > 1 &&
    String(payment.currency || '').toUpperCase() === 'MXN' &&
    Number(payment.amount || 0) >= CLIP_INSTALLMENT_MIN_AMOUNT
  )
}

function normalizeClipInstallmentSelection(value: unknown) {
  const source = value && typeof value === 'object'
    ? (value as Record<string, unknown>).installments ??
      (value as Record<string, unknown>).installment ??
      (value as Record<string, unknown>).months ??
      (value as Record<string, unknown>).value
    : value
  const parsed = Math.trunc(Number(source || 1))
  return CLIP_INSTALLMENT_MONTHS.has(parsed) ? parsed : 1
}

async function readClipSelectedInstallments(card: ClipCardElement, enabled: boolean) {
  if (!enabled || typeof card.installments !== 'function') return 1
  try {
    return normalizeClipInstallmentSelection(await card.installments())
  } catch {
    return 1
  }
}

function buildMercadoPagoCustomization(payment?: PublicMercadoPagoPayment | null) {
  const customVariables: Record<string, string> = {
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontWeightNormal: '500',
    fontWeightSemiBold: '600',
    inputVerticalPadding: '13px',
    inputHorizontalPadding: '14px',
    inputBorderWidth: '1px',
    inputFocusedBorderWidth: '1px',
    borderRadiusSmall: '10px',
    borderRadiusMedium: '10px',
    borderRadiusLarge: '10px',
    formPadding: '2px 0 0'
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

  const maxInstallments = getMercadoPagoMaxInstallments(payment)

  return {
    visual: {
      style: {
        theme: document.body?.dataset?.mode === 'dark' ? 'dark' : 'default',
        customVariables
      }
    },
    ...(maxInstallments
      ? {
          paymentMethods: {
            minInstallments: 1,
            maxInstallments
          }
        }
      : {})
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

function loadClipSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('CLIP solo se puede cargar en el navegador.'))
  if (window.ClipSDK) return Promise.resolve()
  if (clipSdkPromise) return clipSdkPromise

  clipSdkPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${CLIP_SDK_SRC}"]`)
    const handleReady = () => {
      if (window.ClipSDK) {
        resolve()
      } else {
        reject(new Error('No se pudo cargar el SDK de CLIP.'))
      }
    }

    if (existingScript) {
      existingScript.addEventListener('load', handleReady, { once: true })
      existingScript.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de CLIP.')), { once: true })
      window.setTimeout(handleReady, 0)
      return
    }

    const script = document.createElement('script')
    script.src = CLIP_SDK_SRC
    script.async = true
    script.addEventListener('load', handleReady, { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de CLIP.')), { once: true })
    document.head.appendChild(script)
  })

  return clipSdkPromise
}

function loadRebillSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Rebill solo se puede cargar en el navegador.'))
  if (window.customElements?.get('rebill-checkout')) return Promise.resolve()
  if (!rebillSdkPromise) {
    rebillSdkPromise = import('rebill').then(() => undefined)
  }
  return rebillSdkPromise
}

function ensureMetaPixelStub() {
  if (typeof window === 'undefined') return
  if (window.fbq) return

  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) {
      fbq.callMethod(...args)
    } else {
      fbq.queue?.push(args)
    }
  } as MetaPixelFn
  fbq.queue = []
  fbq.loaded = true
  fbq.version = '2.0'
  window.fbq = fbq
  window._fbq = fbq
}

function loadMetaPixelSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Meta Pixel solo se puede cargar en el navegador.'))
  ensureMetaPixelStub()
  if (metaPixelSdkPromise) return metaPixelSdkPromise

  metaPixelSdkPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${META_PIXEL_SDK_SRC}"]`)
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true })
      existingScript.addEventListener('error', () => reject(new Error('No se pudo cargar Meta Pixel.')), { once: true })
      window.setTimeout(() => resolve(), 0)
      return
    }

    const script = document.createElement('script')
    script.async = true
    script.src = META_PIXEL_SDK_SRC
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar Meta Pixel.')), { once: true })
    document.head.appendChild(script)
  })

  return metaPixelSdkPromise
}

function normalizeMetaPixelCustomData(value?: Record<string, unknown>) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(
    Object.entries(source).filter(([, entry]) => {
      if (Array.isArray(entry)) return entry.length > 0
      return entry !== null && entry !== undefined && entry !== ''
    })
  )
}

async function fireMetaPurchasePixelEvent(payment: PublicPaymentData) {
  const metaPurchaseEvent = payment.metaPurchaseEvent
  if (!metaPurchaseEvent?.pixelId || !metaPurchaseEvent.eventId) return
  if (typeof window === 'undefined') return

  const storageKey = `ristak-meta-purchase:${payment.publicPaymentId}:${metaPurchaseEvent.pixelId}:${metaPurchaseEvent.eventId}`
  try {
    if (window.sessionStorage.getItem(storageKey)) return
  } catch {
    // sessionStorage puede fallar en navegadores restrictivos; Pixel sigue siendo idempotente por eventID.
  }

  await loadMetaPixelSdk()
  window.fbq?.('init', metaPurchaseEvent.pixelId)
  window.fbq?.(
    'track',
    metaPurchaseEvent.eventName || 'Purchase',
    normalizeMetaPixelCustomData(metaPurchaseEvent.customData),
    { eventID: metaPurchaseEvent.eventId }
  )

  try {
    window.sessionStorage.setItem(storageKey, '1')
  } catch {
    // No bloqueamos el checkout por storage.
  }
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
    // No anunciamos el éxito aquí: la pantalla de éxito animada es la que revela
    // el resultado (mantener el elemento sorpresa). Solo un estado neutral.
    return { kind: 'info' as const, text: 'Confirmando tu pago…' }
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
    // No anunciamos el éxito aquí: la pantalla de éxito animada es la que revela
    // el resultado (mantener el elemento sorpresa). Solo un estado neutral.
    return { kind: 'info' as const, text: 'Confirmando tu pago…' }
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

function normalizeClipStatusMessage(status?: string, statusDetail?: unknown, pendingAction?: { url?: string } | null) {
  const normalized = String(status || '').toLowerCase()
  if (['approved', 'paid', 'succeeded', 'completed'].includes(normalized)) {
    // No anunciamos el éxito aquí: la pantalla de éxito animada es la que revela
    // el resultado (mantener el elemento sorpresa). Solo un estado neutral.
    return { kind: 'info' as const, text: 'Confirmando tu pago…' }
  }
  if (pendingAction?.url || ['pending', 'authorized', 'processing'].includes(normalized)) {
    return { kind: 'info' as const, text: pendingAction?.url ? 'CLIP necesita validar este pago con 3DS.' : 'CLIP está procesando el pago. Esta página se actualizará cuando se confirme.' }
  }

  const detailText = typeof statusDetail === 'string'
    ? statusDetail
    : typeof statusDetail === 'object' && statusDetail
      ? String((statusDetail as any).message || (statusDetail as any).code || '').trim()
      : ''

  return {
    kind: 'error' as const,
    text: detailText
      ? `CLIP rechazó el pago: ${detailText}. Revisa los datos o intenta con otra tarjeta.`
      : 'CLIP rechazó el pago. Revisa los datos o intenta con otra tarjeta.'
  }
}

function normalizeClipErrorMessage(error: unknown) {
  const message = String((error as any)?.message || error || '').trim()
  return message || 'No se pudo completar el pago con CLIP. Revisa los datos e intenta otra vez.'
}

function isRebillPaidStatus(status?: string) {
  return ['approved', 'paid', 'succeeded', 'success', 'completed', 'complete', 'fulfilled']
    .includes(String(status || '').toLowerCase())
}

function isRebillPendingStatus(status?: string) {
  return ['pending', 'authorized', 'processing', 'pending_customer_charge']
    .includes(String(status || '').toLowerCase())
}

function normalizeRebillStatusMessage(status?: string, statusDetail?: unknown) {
  const normalized = String(status || '').toLowerCase()
  if (isRebillPaidStatus(normalized)) {
    return { kind: 'info' as const, text: 'Confirmando tu pago…' }
  }
  if (isRebillPendingStatus(normalized)) {
    return { kind: 'info' as const, text: 'Rebill está procesando el pago. Esta página se actualizará cuando se confirme.' }
  }

  const detailText = typeof statusDetail === 'string'
    ? statusDetail
    : typeof statusDetail === 'object' && statusDetail
      ? String((statusDetail as any).message || (statusDetail as any).code || '').trim()
      : ''

  return {
    kind: 'error' as const,
    text: detailText
      ? `Rebill rechazó el pago: ${detailText}. Revisa los datos o intenta con otra tarjeta.`
      : 'Rebill rechazó el pago. Revisa los datos o intenta con otra tarjeta.'
  }
}

function normalizeRebillErrorMessage(error: unknown) {
  const message = String((error as any)?.message || error || '').trim()
  return message || 'No se pudo completar el pago con Rebill. Revisa los datos e intenta otra vez.'
}

function extractRebillPaymentId(event: Event) {
  const detail = (event as CustomEvent<any>).detail || {}
  const data = detail.data || detail
  const result = data.result || detail.result || {}
  const candidates = [
    result.paymentId,
    result.payment_id,
    data.paymentId,
    data.payment_id,
    data.id,
    detail.paymentId,
    detail.payment_id
  ]
  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find(Boolean) || ''
}

function extractRebillInstallments(event: Event) {
  const detail = (event as CustomEvent<any>).detail || {}
  const data = detail.data || detail
  const result = data.result || detail.result || {}
  const candidates = [
    result.installments,
    result.installment,
    result.selectedInstallments,
    result.months,
    data.installments,
    data.installment,
    data.selectedInstallments,
    data.months,
    detail.installments,
    detail.installment
  ]
  const parsed = candidates
    .map((candidate) => {
      const source = candidate && typeof candidate === 'object'
        ? (candidate as Record<string, unknown>).installments ??
          (candidate as Record<string, unknown>).installment ??
          (candidate as Record<string, unknown>).selectedInstallments ??
          (candidate as Record<string, unknown>).months ??
          (candidate as Record<string, unknown>).count ??
          (candidate as Record<string, unknown>).value
        : candidate
      return Math.trunc(Number(source))
    })
    .find((candidate) => Number.isFinite(candidate) && candidate > 1)

  return parsed || null
}

function getRebillInstallmentMonths(payment: PublicRebillPayment) {
  const config = payment.rebillInstallments
  if (!config?.enabled) return []

  const configuredMonths = Array.isArray(config.enabledInstallments)
    ? config.enabledInstallments
        .map((month) => Math.trunc(Number(month)))
        .filter((month) => Number.isFinite(month) && month > 1)
    : []
  const maxInstallments = Math.trunc(Number(config.maxInstallments || 0))
  const fallbackMonths = maxInstallments > 1
    ? REBILL_INSTALLMENT_MONTHS.filter((month) => month <= maxInstallments)
    : []

  return Array.from(new Set([...configuredMonths, ...fallbackMonths]))
    .sort((left, right) => left - right)
}

function getRebillInstallmentBreakdown(payment: PublicRebillPayment, totalAmount: number) {
  const amount = Number(totalAmount || payment.amount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return []
  return getRebillInstallmentMonths(payment).map((months) => ({
    months,
    amountLabel: formatCurrency(amount / months, payment.currency)
  }))
}

function formatRebillInstallmentOptions(months: number[]) {
  if (!months.length) return ''
  if (months.length === 1) return `${months[0]} meses`
  return `${months.slice(0, -1).join(', ')} y ${months[months.length - 1]} meses`
}

const RebillInstallmentPreview: React.FC<{
  payment: PublicRebillPayment
  totalAmount: number
}> = ({ payment, totalAmount }) => {
  const breakdown = getRebillInstallmentBreakdown(payment, totalAmount)
  if (!breakdown.length) return null

  return (
    <div className={styles.rebillInstallmentPreview}>
      <div className={styles.rebillInstallmentPreviewHeader}>
        <span className={styles.eyebrow}>Meses sin intereses</span>
        <p>Si tu tarjeta aplica, Rebill puede mostrar estas opciones al pagar.</p>
      </div>
      <div className={styles.rebillInstallmentRows}>
        {breakdown.map((item) => (
          <div key={item.months}>
            <span>{item.months} meses</span>
            <strong>{item.amountLabel} por mes</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function normalizeMercadoPagoCardErrorMessage(error: unknown) {
  const message = String((error as any)?.message || error || '').trim()
  const lowerMessage = message.toLowerCase()

  if (
    lowerMessage.includes('invalid test user email') ||
    lowerMessage.includes('invalid users involved') ||
    lowerMessage.includes('testuser')
  ) {
    return MERCADOPAGO_TEST_CARD_HELP
  }

  return message || 'No se pudo completar el pago. Revisa los datos e intenta otra vez.'
}

async function copyPublicPaymentText(text: string) {
  const value = text.trim()
  if (!value) return false

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      const input = document.createElement('input')
      input.value = value
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    }
    return true
  } catch {
    return false
  }
}

const TestCopyButton: React.FC<{
  value: string
  label: string
  copied: boolean
  onCopy: (value: string, label: string) => void
}> = ({ value, label, copied, onCopy }) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className={styles.testCopyButton}
    onClick={() => onCopy(value, label)}
    title={label}
    aria-label={label}
  >
    {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
  </Button>
)

const PaymentTestHelper: React.FC<{ provider: PaymentTestProvider }> = ({ provider }) => {
  const guide = paymentTestGuides[provider]
  const [copiedKey, setCopiedKey] = useState('')

  const handleCopy = async (value: string, label: string) => {
    const copied = await copyPublicPaymentText(value)
    if (!copied) return

    setCopiedKey(`${label}:${value}`)
    window.setTimeout(() => {
      setCopiedKey((current) => current === `${label}:${value}` ? '' : current)
    }, 1600)
  }

  const isCopied = (label: string, value: string) => copiedKey === `${label}:${value}`

  return (
    <details className={styles.testGuide}>
      <summary>
        <span>
          <Info size={16} />
          {guide.title}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className={styles.testGuideBody}>
        <p>{guide.description}</p>
        <div className={styles.testGuideHint}>{guide.emailHint}</div>

        <div className={styles.testGuideSection}>
          <strong>Tarjetas</strong>
          <div className={styles.testGuideScroller}>
            <table className={styles.testCardsMatrix}>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Bandera</th>
                  <th>Numero</th>
                  <th>CVV</th>
                  <th>Vence</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {guide.cards.map((card) => (
                  <tr key={`${provider}-${card.number}-${card.result || card.brand}`}>
                    <td>{card.kind}</td>
                    <td>{card.brand}</td>
                    <td className={styles.testCopyCell}>
                      <span className={styles.testCopyValue}>
                        <span>{card.number}</span>
                        <TestCopyButton
                          value={card.number}
                          label="Copiar numero"
                          copied={isCopied('Copiar numero', card.number)}
                          onCopy={handleCopy}
                        />
                      </span>
                    </td>
                    <td className={styles.testCopyCell}>
                      <span className={styles.testCopyValue}>
                        <span>{card.cvc}</span>
                        <TestCopyButton
                          value={card.cvc}
                          label="Copiar CVV"
                          copied={isCopied('Copiar CVV', card.cvc)}
                          onCopy={handleCopy}
                        />
                      </span>
                    </td>
                    <td className={styles.testCopyCell}>
                      <span className={styles.testCopyValue}>
                        <span>{card.expiry}</span>
                        <TestCopyButton
                          value={card.expiry}
                          label="Copiar vencimiento"
                          copied={isCopied('Copiar vencimiento', card.expiry)}
                          onCopy={handleCopy}
                        />
                      </span>
                    </td>
                    <td>{card.result || 'Segun titular'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {guide.scenarios?.length ? (
          <div className={styles.testGuideSection}>
            <strong>Escenarios por titular</strong>
            <div className={styles.testGuideScroller}>
              <table className={styles.testCardsMatrix}>
                <thead>
                  <tr>
                    <th>Nombre del titular</th>
                    <th>Estado que simula</th>
                  </tr>
                </thead>
                <tbody>
                  {guide.scenarios.map((scenario) => (
                    <tr key={`${provider}-${scenario.holder}`}>
                      <td className={styles.testCopyCell}>
                        <span className={styles.testCopyValue}>
                          <span>{scenario.holder}</span>
                          <TestCopyButton
                            value={scenario.holder}
                            label="Copiar titular"
                            copied={isCopied('Copiar titular', scenario.holder)}
                            onCopy={handleCopy}
                          />
                        </span>
                      </td>
                      <td>{scenario.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  )
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

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return reduced
}

type ConfettiParticle = {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  size: number
  ratio: number
  color: string
  round: boolean
  drift: number
  phase: number
}

// Ráfaga de confetti dibujada en canvas con física real (cañones desde las
// esquinas + lluvia superior, gravedad, fricción y aleteo). Sin dependencias
// externas y se apaga sola tras la celebración. Respeta prefers-reduced-motion.
const SuccessConfettiBurst: React.FC<{ delayMs?: number }> = ({ delayMs = 0 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    if (reducedMotion) return undefined
    const canvas = canvasRef.current
    if (!canvas || typeof window === 'undefined') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let width = window.innerWidth
    let height = window.innerHeight
    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const colors = CONFETTI_COLOR_TOKENS.map((token) => readToken(token)).filter(Boolean)
    if (!colors.length) colors.push(...CONFETTI_COLOR_FALLBACK)

    const rand = (min: number, max: number) => min + Math.random() * (max - min)
    const pick = () => colors[Math.floor(Math.random() * colors.length)]
    const particles: ConfettiParticle[] = []

    const launch = (originX: number, originY: number, angle: number, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const dir = angle + rand(-0.45, 0.45)
        const power = rand(10, 19)
        particles.push({
          x: originX,
          y: originY,
          vx: Math.cos(dir) * power,
          vy: Math.sin(dir) * power,
          rot: rand(0, Math.PI * 2),
          vr: rand(-0.26, 0.26),
          size: rand(7, 13),
          ratio: rand(0.42, 1),
          color: pick(),
          round: Math.random() > 0.76,
          drift: rand(-0.7, 0.7),
          phase: rand(0, Math.PI * 2)
        })
      }
    }

    // Dos cañones que disparan hacia arriba y al centro desde las esquinas.
    launch(width * 0.14, height * 0.62, -Math.PI / 2.35, 58)
    launch(width * 0.86, height * 0.62, -Math.PI / 1.76, 58)
    // Lluvia superior para llenar el cuadro.
    for (let i = 0; i < 46; i += 1) {
      particles.push({
        x: rand(0, width),
        y: rand(-height * 0.2, -12),
        vx: rand(-1.6, 1.6),
        vy: rand(2, 5.5),
        rot: rand(0, Math.PI * 2),
        vr: rand(-0.22, 0.22),
        size: rand(6, 12),
        ratio: rand(0.42, 1),
        color: pick(),
        round: Math.random() > 0.8,
        drift: rand(-0.8, 0.8),
        phase: rand(0, Math.PI * 2)
      })
    }

    const gravity = 0.34
    const drag = 0.99
    const totalMs = 3000
    const fadeStart = totalMs - 800
    let raf = 0
    let startTs = 0

    const frame = (now: number) => {
      if (!startTs) startTs = now
      const elapsed = now - startTs
      ctx.clearRect(0, 0, width, height)
      const fade = elapsed > fadeStart ? Math.max(0, 1 - (elapsed - fadeStart) / 800) : 1
      let onScreen = 0

      for (const p of particles) {
        p.vy += gravity
        p.vx *= drag
        p.vy *= drag
        p.phase += 0.12
        p.x += p.vx + Math.sin(p.phase) * p.drift
        p.y += p.vy
        p.rot += p.vr
        if (p.y > height + 40 || fade <= 0) continue
        onScreen += 1
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.globalAlpha = fade
        ctx.fillStyle = p.color
        if (p.round) {
          ctx.beginPath()
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillRect(-p.size * 0.5, -p.size * p.ratio * 0.5, p.size, p.size * p.ratio)
        }
        ctx.restore()
      }

      if (onScreen > 0 && elapsed < totalMs) {
        raf = window.requestAnimationFrame(frame)
      } else {
        ctx.clearRect(0, 0, width, height)
      }
    }

    // Retrasamos el estallido lo justo para que, cuando venimos de la transición
    // de la tarjeta al centro, el confetti aparezca al aterrizar (y no oculto tras
    // el overlay de la View Transition).
    const startTimer = window.setTimeout(() => {
      raf = window.requestAnimationFrame(frame)
    }, Math.max(0, delayMs))
    window.addEventListener('resize', resize)
    return () => {
      window.clearTimeout(startTimer)
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [reducedMotion, delayMs])

  if (reducedMotion) return null
  return <canvas ref={canvasRef} className={styles.confettiCanvas} aria-hidden="true" />
}

const PaymentSuccessExperience: React.FC<PaymentSuccessExperienceProps> = ({
  providerLogo,
  providerLabel,
  title,
  description,
  amountLabel,
  amountValue,
  conceptTitle,
  conceptDescription,
  details = [],
  businessDetails = [],
  action,
  reference,
  confettiDelay = 0
}) => {
  const visibleBusinessDetails = businessDetails.filter(Boolean)

  return (
    <div className={styles.successExperience}>
      <SuccessConfettiBurst delayMs={confettiDelay} />

      <div className={styles.successHero}>
        <div className={styles.successSeal} aria-hidden="true">
          <CheckCircle2 size={74} strokeWidth={1.8} />
        </div>

        <div className={styles.successHeroCopy}>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>

      {amountValue !== undefined && amountValue !== null && (
        <div className={styles.successAmount}>
          <span>{amountLabel || 'Total pagado'}</span>
          <strong>{amountValue}</strong>
          <div className={styles.successProvider}>
            <PaymentPlatformLogo platform={providerLogo} size="sm" decorative />
            <span>{providerLabel}</span>
          </div>
        </div>
      )}

      {conceptTitle && (
        <div className={styles.successConcept}>
          <span className={styles.eyebrow}>Concepto</span>
          <strong>{conceptTitle}</strong>
          {conceptDescription && <p>{conceptDescription}</p>}
        </div>
      )}

      {details.length > 0 && (
        <div className={styles.successRows}>
          {details.map((detail) => (
            <div key={detail.label}>
              <span>{detail.label}</span>
              <strong>{detail.value}</strong>
            </div>
          ))}
        </div>
      )}

      {action && (
        <div className={styles.successActions}>
          {action}
        </div>
      )}

      {(visibleBusinessDetails.length > 0 || reference) && (
        <div className={styles.successFooter}>
          {visibleBusinessDetails.length > 0 && (
            <div className={styles.successBusinessInfo}>
              {visibleBusinessDetails.map((detail, index) => (
                <span key={`${detail}-${index}`}>{detail}</span>
              ))}
            </div>
          )}
          {reference && (
            <span className={styles.successReference}>Referencia {reference}</span>
          )}
        </div>
      )}
    </div>
  )
}

const PublicPaymentForm: React.FC<{
  payment: PublicStripePayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [errored, setErrored] = useState(false)
  const isCardSetupPlan = Boolean(payment.paymentPlan?.cardSetupRequired || payment.paymentPlan?.trigger === 'card_setup')
  const submitLabel = isCardSetupPlan
    ? 'Autorizar tarjeta'
    : payment.settings?.checkout?.buttonLabel || 'Pagar'
  const submitAmount = Number(payment.amount || 0) > 0 ? ` ${formatCurrency(payment.amount, payment.currency)}` : ''
  const showStripeInstallmentsNotice = Boolean(payment.stripeInstallments?.enabled)
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false
  const isTestMode = payment.paymentMode === 'test' || String(payment.publishableKey || '').startsWith('pk_test_')

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || submitting) return

    setSubmitting(true)
    setErrored(false)
    setMessage('')

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/pay/${payment.publicPaymentId}?payment=return`
      },
      redirect: 'if_required'
    })

    if (result.error) {
      setErrored(true)
      setMessage(result.error.message || 'No se pudo completar el pago. Revisa los datos e intenta otra vez.')
      setSubmitting(false)
      return
    }

    if (result.paymentIntent?.status === 'succeeded') {
      // Sin aviso de "pago exitoso": dejamos el spinner y un "Confirmando…"
      // neutral, y que la pantalla de éxito animada sea la que revele el
      // resultado (mantener el elemento sorpresa). No reactivamos el botón.
      setMessage('Confirmando tu pago…')
      await onPaid()
      return
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
        <PaymentElement options={STRIPE_PAYMENT_ELEMENT_OPTIONS} />
      </div>

      {message && (
        <p className={`${styles.providerMessage} ${errored ? styles.messageError : ''}`}>
          {errored ? <AlertCircle size={16} /> : <Loader2 size={16} className={styles.spin} />}
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

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>La tarjeta se captura en campos seguros de Stripe. Ristak solo recibe el resultado del cobro.</span>
        </p>
      )}

      {showStripeInstallmentsNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <Info size={16} />
          <span>Si tu tarjeta de crédito aplica, Stripe mostrará los meses sin intereses disponibles antes de confirmar el pago.</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="stripe" />}
    </form>
  )
}

const PublicStripeInstallmentPaymentForm: React.FC<{
  payment: PublicStripePayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info')
  const [cardFields, setCardFields] = useState({ number: false, expiry: false, cvc: false })
  const [installmentStatus, setInstallmentStatus] = useState<'idle' | 'checking' | 'ready' | 'error'>('idle')
  const [paymentIntentId, setPaymentIntentId] = useState('')
  const [availablePlans, setAvailablePlans] = useState<StripeInstallmentPlan[] | null>(null)
  const [selectedInstallments, setSelectedInstallments] = useState<number | null>(null)
  const [numberTriggeredPrepareAttempted, setNumberTriggeredPrepareAttempted] = useState(false)
  const cardNumberOptions = useMemo(() => buildStripeCardNumberElementOptions(), [])
  const cardFieldOptions = useMemo(() => buildStripeSplitElementOptions(), [])
  const submitAmount = Number(payment.amount || 0) > 0 ? ` ${formatCurrency(payment.amount, payment.currency)}` : ''
  const maxInstallments = getStripeInstallmentMax(payment)
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false
  const isTestMode = payment.paymentMode === 'test' || String(payment.publishableKey || '').startsWith('pk_test_')
  const savePaymentMethod = Boolean(payment.contact?.id || payment.paymentPlan?.cardSetupRequired)
  const cardNumberComplete = cardFields.number
  const cardComplete = cardFields.number && cardFields.expiry && cardFields.cvc
  const hasPreparedCard = installmentStatus === 'ready' && Boolean(paymentIntentId)
  const showInstallmentSelector = Boolean(hasPreparedCard && availablePlans?.length)
  const canSubmitPayment = Boolean(stripe && elements && hasPreparedCard && !submitting)

  const resetPreparedCard = useCallback(() => {
    setPaymentIntentId('')
    setAvailablePlans(null)
    setSelectedInstallments(null)
    setMessage('')
    setMessageKind('info')
    setInstallmentStatus('idle')
  }, [])

  const resetCardSelection = () => {
    setCardFields({ number: false, expiry: false, cvc: false })
    setNumberTriggeredPrepareAttempted(false)
    resetPreparedCard()
    elements?.getElement(CardNumberElement)?.clear()
    elements?.getElement(CardExpiryElement)?.clear()
    elements?.getElement(CardCvcElement)?.clear()
  }

  const handleSplitCardChange = useCallback((
    field: 'number' | 'expiry' | 'cvc',
    event: StripeCardNumberElementChangeEvent | StripeCardExpiryElementChangeEvent | StripeCardCvcElementChangeEvent
  ) => {
    setCardFields((current) => ({
      ...current,
      [field]: event.complete
    }))

    const hasPreparedState = Boolean(paymentIntentId || availablePlans || installmentStatus === 'ready' || installmentStatus === 'error')
    if (field === 'number') {
      setNumberTriggeredPrepareAttempted(false)
    }
    if (!event.complete || hasPreparedState) {
      resetPreparedCard()
      return
    }

    setMessage('')
    setMessageKind('info')
  }, [availablePlans, installmentStatus, paymentIntentId, resetPreparedCard])

  const preparePlans = useCallback(async (options: { quietIncompleteCardDetails?: boolean } = {}) => {
    if (!stripe || !elements || installmentStatus === 'checking') return
    const card = elements.getElement(CardNumberElement)
    if (!card) {
      setMessageKind('error')
      setMessage('No pudimos cargar los campos seguros de tarjeta. Recarga la página e intenta otra vez.')
      setInstallmentStatus('error')
      return
    }

    setInstallmentStatus('checking')
    setMessage('')
    try {
      const paymentMethod = await stripe.createPaymentMethod({
        type: 'card',
        card,
        billing_details: {
          name: payment.contact?.name || undefined,
          email: payment.contact?.email || undefined,
          phone: payment.contact?.phone || undefined,
          address: {
            country: 'MX'
          }
        }
      })

      if (paymentMethod.error || !paymentMethod.paymentMethod?.id) {
        if (options.quietIncompleteCardDetails && isStripeMissingAdditionalCardDetails(paymentMethod.error)) {
          setMessage('')
          setMessageKind('info')
          setInstallmentStatus('idle')
          return
        }
        setMessageKind('error')
        setMessage(paymentMethod.error?.message || 'Revisa los datos de la tarjeta e intenta otra vez.')
        setInstallmentStatus('error')
        return
      }

      const prepared = await stripePaymentsService.preparePublicInstallmentPlans(payment.publicPaymentId, {
        paymentMethodId: paymentMethod.paymentMethod.id,
        savePaymentMethod
      })
      const plans = (prepared.availablePlans || []).filter((plan) => plan.count <= maxInstallments)
      setPaymentIntentId(prepared.paymentIntentId)
      setAvailablePlans(plans)
      setSelectedInstallments(null)
      setMessageKind('info')
      setMessage('')
      setInstallmentStatus('ready')
    } catch (error: any) {
      setMessageKind('error')
      setMessage(error.message || 'No se pudieron consultar los meses disponibles con Stripe.')
      setInstallmentStatus('error')
    }
  }, [elements, installmentStatus, maxInstallments, payment.contact?.email, payment.contact?.id, payment.contact?.name, payment.contact?.phone, payment.paymentPlan?.cardSetupRequired, payment.publicPaymentId, savePaymentMethod, stripe])

  const finishPayment = async () => {
    if (!stripe || !paymentIntentId) return

    setSubmitting(true)
    setMessage('')
    try {
      const confirmed = await stripePaymentsService.confirmPublicInstallmentPayment(payment.publicPaymentId, {
        paymentIntentId,
        selectedInstallments,
        returnUrl: `${window.location.origin}/pay/${payment.publicPaymentId}?payment=return`
      })

      let nextStatus = confirmed.status
      if (confirmed.status === 'requires_action' && confirmed.clientSecret) {
        const actionResult = await stripe.handleNextAction({ clientSecret: confirmed.clientSecret })
        if (actionResult.error) {
          setMessageKind('error')
          setMessage(actionResult.error.message || 'El banco no pudo completar la autenticación. Intenta otra vez.')
          setSubmitting(false)
          return
        }
        nextStatus = actionResult.paymentIntent?.status || nextStatus
      }

      if (nextStatus === 'succeeded') {
        setMessageKind('success')
        setMessage('Pago recibido. Gracias.')
        await onPaid()
      } else if (nextStatus === 'processing') {
        setMessageKind('info')
        setMessage('Stripe está procesando el pago. Esta página se actualizará cuando se confirme.')
        await onPaid()
      } else {
        setMessageKind('info')
        setMessage('Stripe necesita una acción adicional. Sigue las instrucciones del banco.')
      }
    } catch (error: any) {
      setMessageKind('error')
      setMessage(error.message || 'No se pudo completar el pago con Stripe.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || submitting) return
    if (!hasPreparedCard) {
      if (cardComplete && installmentStatus === 'idle') {
        await preparePlans()
      }
      return
    }
    await finishPayment()
  }

  useEffect(() => {
    if (!cardNumberComplete || numberTriggeredPrepareAttempted || installmentStatus !== 'idle' || paymentIntentId) return
    setNumberTriggeredPrepareAttempted(true)
    void preparePlans({ quietIncompleteCardDetails: true })
  }, [cardNumberComplete, installmentStatus, numberTriggeredPrepareAttempted, paymentIntentId, preparePlans])

  useEffect(() => {
    if (!cardComplete || installmentStatus !== 'idle' || paymentIntentId) return
    void preparePlans()
  }, [cardComplete, installmentStatus, paymentIntentId, preparePlans])

  return (
    <form className={styles.stripeBox} onSubmit={handleSubmit}>
      <div className={styles.stripeExpandedCardForm}>
        <div className={styles.stripeCardMethodHeader}>
          <CreditCard size={16} />
          <span>Tarjeta</span>
        </div>

        <div className={styles.stripeFormField}>
          <label>Número de tarjeta</label>
          <div className={styles.stripeSplitElementShell}>
            <CardNumberElement
              options={cardNumberOptions}
              onChange={(event) => handleSplitCardChange('number', event)}
            />
          </div>
        </div>

        <div className={styles.stripeSplitGrid}>
          <div className={styles.stripeFormField}>
            <label>Fecha de caducidad</label>
            <div className={styles.stripeSplitElementShell}>
              <CardExpiryElement
                options={cardFieldOptions}
                onChange={(event) => handleSplitCardChange('expiry', event)}
              />
            </div>
          </div>

          <div className={styles.stripeFormField}>
            <label>Código de seguridad</label>
            <div className={styles.stripeSplitElementShell}>
              <CardCvcElement
                options={cardFieldOptions}
                onChange={(event) => handleSplitCardChange('cvc', event)}
              />
            </div>
          </div>
        </div>

        <div className={styles.stripeFormField}>
          <label>País</label>
          <div className={styles.stripeCountryField} aria-label="País México">
            <span>México</span>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        </div>
      </div>

      {showInstallmentSelector && (
        <div className={styles.stripeInstallmentSelector}>
          <div className={styles.stripeInstallmentSelectorHeader}>
            <span>Meses sin intereses</span>
            <strong>Máximo {maxInstallments} meses</strong>
          </div>

          <button
            type="button"
            className={styles.stripeInstallmentOption}
            data-selected={selectedInstallments === null ? 'true' : 'false'}
            aria-pressed={selectedInstallments === null}
            onClick={() => setSelectedInstallments(null)}
          >
            <span>Pago de contado</span>
            <strong>{formatCurrency(payment.amount, payment.currency)}</strong>
          </button>

          {(availablePlans || []).map((plan) => (
            <button
              key={plan.count}
              type="button"
              className={styles.stripeInstallmentOption}
              data-selected={selectedInstallments === plan.count ? 'true' : 'false'}
              aria-pressed={selectedInstallments === plan.count}
              onClick={() => setSelectedInstallments(plan.count)}
            >
              <span>{plan.count} pagos de {formatCurrency(getStripePlanMonthlyAmount(payment, plan.count), payment.currency)}</span>
              <strong>Total {formatCurrency(payment.amount, payment.currency)}</strong>
            </button>
          ))}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetCardSelection}
          >
            Usar otra tarjeta
          </Button>
        </div>
      )}

      {message && (
        <p className={`${styles.providerMessage} ${messageKind === 'success' ? styles.messageSuccess : messageKind === 'error' ? styles.messageError : ''}`}>
          {messageKind === 'success' ? <CheckCircle2 size={16} /> : messageKind === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
          <span>{message}</span>
        </p>
      )}

      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          fullWidth
          className={styles.payButton}
          disabled={!canSubmitPayment}
          leftIcon={(submitting || installmentStatus === 'checking') ? <Loader2 size={16} className={styles.spin} /> : <CreditCard size={16} />}
        >
          {submitting
            ? 'Procesando'
            : `Pagar ahora${submitAmount}`}
        </Button>
      </div>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>La tarjeta se captura en campos seguros de Stripe. Ristak sólo recibe el resultado del cobro.</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="stripe" />}
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
  const isTestMode = payment.paymentMode === 'test' || String(payment.publicKey || '').startsWith('TEST-')

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
          customization: buildMercadoPagoCustomization(payment),
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
                const text = normalizeMercadoPagoCardErrorMessage(submitError)
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
        setMessage(normalizeMercadoPagoCardErrorMessage(brickError))
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
  }, [containerId, payment.amount, payment.mercadoPagoInstallments?.maxInstallments, payment.publicKey, payment.publicPaymentId])

  const messageClassName = [
    styles.providerMessage,
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
        <div id={containerId} className={styles.mercadoPagoBrick} data-ristak-unstyled />
      </div>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>La tarjeta se captura en campos seguros de Mercado Pago. Ristak solo recibe el resultado del cobro.</span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'error' ? <AlertCircle size={16} /> : messageKind === 'success' ? <CheckCircle2 size={16} /> : <Loader2 size={16} className={styles.spin} />}
          <span>{message}</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="mercadopago" />}

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
  const isTestMode = payment.paymentMode === 'test'
  const isSubscriptionStart = Boolean(payment.subscriptionStart?.subscriptionId)
  const conektaInstallmentOptions = useMemo(
    () => isSubscriptionStart ? [] : getAvailableConektaInstallmentOptions(payment),
    [
      isSubscriptionStart,
      payment.amount,
      payment.conektaInstallments?.enabled,
      payment.conektaInstallments?.maxInstallments,
      payment.conektaInstallments?.options
    ]
  )
  const [selectedConektaInstallments, setSelectedConektaInstallments] = useState(1)
  const selectedConektaInstallmentsRef = useRef(1)

  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])

  useEffect(() => {
    selectedConektaInstallmentsRef.current = selectedConektaInstallments
  }, [selectedConektaInstallments])

  useEffect(() => {
    if (!conektaInstallmentOptions.some((option) => option.months === selectedConektaInstallments)) {
      setSelectedConektaInstallments(1)
    }
  }, [conektaInstallmentOptions, selectedConektaInstallments])

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
                const result = isSubscriptionStart
                  ? await conektaPaymentsService.createPublicSubscription(payment.publicPaymentId, { tokenId })
                  : await conektaPaymentsService.createPublicCardPayment(payment.publicPaymentId, {
                      tokenId,
                      savePaymentSource: Boolean(payment.contact?.id),
                      installments: selectedConektaInstallmentsRef.current
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
  }, [containerId, payment.contact?.id, payment.publicKey, payment.publicPaymentId, isSubscriptionStart])

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
    styles.providerMessage,
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

      {conektaInstallmentOptions.length > 0 && (
        <label className={styles.conektaInstallmentSelector}>
          <span>Meses sin intereses</span>
          <select
            value={selectedConektaInstallments}
            onChange={(event) => setSelectedConektaInstallments(Number(event.target.value) || 1)}
            disabled={submitting}
          >
            <option value={1}>Pago de contado</option>
            {conektaInstallmentOptions.map((option) => (
              <option key={option.months} value={option.months}>
                {option.months} meses sin intereses
              </option>
            ))}
          </select>
          <small>Conekta valida la disponibilidad con el banco emisor. Ristak registra el total del pago.</small>
        </label>
      )}

      <Button
        type="button"
        variant="primary"
        className={styles.conektaSubmitButton}
        onClick={handleSubmit}
        loading={submitting}
        disabled={loadingTokenizer || !tokenizerReady}
        leftIcon={!submitting ? <ShieldCheck size={16} /> : undefined}
      >
        {submitting
          ? (isSubscriptionStart ? 'Autorizando' : 'Procesando pago')
          : isSubscriptionStart
            ? `Autorizar suscripción ${formatCurrency(payment.amount, payment.currency)}`
            : `Pagar ${formatCurrency(payment.amount, payment.currency)}`}
      </Button>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>
            {isSubscriptionStart
              ? 'Tus datos de tarjeta viajan en campos seguros de Conekta. Ristak solo recibe la autorización para crear la suscripción.'
              : 'Tus datos de tarjeta viajan en campos seguros de Conekta. Ristak solo recibe el resultado del cobro.'}
          </span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'error' ? <AlertCircle size={16} /> : messageKind === 'success' ? <CheckCircle2 size={16} /> : <Loader2 size={16} className={styles.spin} />}
          <span>{message}</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="conekta" />}
    </div>
  )
}

const ClipCardPaymentForm: React.FC<{
  payment: PublicClipPayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const containerId = useMemo(
    () => `clip-card-${payment.publicPaymentId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [payment.publicPaymentId]
  )
  const onPaidRef = useRef(onPaid)
  const cardRef = useRef<ClipCardElement | null>(null)
  const [loadingCard, setLoadingCard] = useState(Boolean(payment.apiKey))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info')
  const [threeDsUrl, setThreeDsUrl] = useState('')
  const [threeDsPaymentId, setThreeDsPaymentId] = useState('')
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false
  const isTestMode = payment.paymentMode === 'test' || String(payment.apiKey || '').startsWith('test_')
  const isSubscriptionStart = Boolean(payment.subscriptionStart?.subscriptionId)
  const clipInstallmentsEnabled = !isSubscriptionStart && clipInstallmentsEnabledForPayment(payment)

  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])

  useEffect(() => {
    if (!payment.apiKey) {
      setLoadingCard(false)
      setMessage('CLIP no devolvió una API Key para montar el formulario seguro.')
      setMessageKind('error')
      return
    }

    let cancelled = false
    const mountCard = async () => {
      setLoadingCard(true)
      setMessage('')

      try {
        await loadClipSdk()
        if (cancelled || !window.ClipSDK) return

        const container = document.getElementById(containerId)
        if (container) container.innerHTML = ''

        const clip = new window.ClipSDK(payment.apiKey || '')
        const card = clip.element.create('Card', {
          theme: 'light',
          locale: 'es',
          ...(clipInstallmentsEnabled
            ? {
                paymentAmount: Math.round(Number(payment.amount || 0) * 100) / 100,
                terms: { enabled: true }
              }
            : {})
        })
        card.mount(containerId)
        cardRef.current = card
        setLoadingCard(false)
      } catch (clipError: any) {
        if (cancelled) return
        setLoadingCard(false)
        setMessageKind('error')
        setMessage(normalizeClipErrorMessage(clipError))
      }
    }

    mountCard()

    return () => {
      cancelled = true
      cardRef.current?.unmount?.()
      cardRef.current = null
      const container = document.getElementById(containerId)
      if (container) container.innerHTML = ''
    }
  }, [clipInstallmentsEnabled, containerId, payment.amount, payment.apiKey])

  useEffect(() => {
    if (!threeDsUrl) return undefined

    const expectedOrigin = (() => {
      try {
        return new URL(threeDsUrl).origin
      } catch {
        return ''
      }
    })()

    const handleMessage = async (event: MessageEvent) => {
      if (expectedOrigin && event.origin !== expectedOrigin) return
      const returnedPaymentId = String((event.data as any)?.paymentId || (event.data as any)?.payment_id || threeDsPaymentId || '').trim()
      if (!returnedPaymentId) return

      setSubmitting(true)
      setMessageKind('info')
      setMessage('Validación recibida. Confirmando el pago con CLIP.')
      try {
        const result = await clipPaymentsService.refreshPublicPayment(payment.publicPaymentId, returnedPaymentId)
        const statusMessage = normalizeClipStatusMessage(result.payment?.status || result.status, result.statusDetail, result.pendingAction)
        setMessageKind(statusMessage.kind)
        setMessage(statusMessage.text)
        setThreeDsUrl('')
        await onPaidRef.current()
      } catch (refreshError: any) {
        setMessageKind('error')
        setMessage(normalizeClipErrorMessage(refreshError))
      } finally {
        setSubmitting(false)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [isSubscriptionStart, payment.publicPaymentId, threeDsPaymentId, threeDsUrl])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return

    const card = cardRef.current
    if (!card) {
      setMessageKind('error')
      setMessage('El formulario seguro de CLIP todavía no está listo. Espera un momento e intenta de nuevo.')
      return
    }

    setSubmitting(true)
    setMessage('')
    setThreeDsUrl('')

    try {
      const cardToken = await card.cardToken()
      const tokenId = String(cardToken?.id || '').trim()
      if (!tokenId) {
        throw new Error('CLIP no devolvió un token válido. Intenta nuevamente.')
      }
      const selectedInstallments = await readClipSelectedInstallments(card, clipInstallmentsEnabled)

      const result = await clipPaymentsService.createPublicCardPayment(payment.publicPaymentId, {
        cardTokenId: tokenId,
        email: payment.contact?.email || '',
        phone: payment.contact?.phone || '',
        installments: selectedInstallments
      })
      const statusMessage = normalizeClipStatusMessage(result.payment?.status || result.status, result.statusDetail, result.pendingAction)
      setMessageKind(statusMessage.kind)
      setMessage(statusMessage.text)

      if (result.pendingAction?.url) {
        setThreeDsPaymentId(result.clipPaymentId || result.payment?.clipPaymentId || '')
        setThreeDsUrl(result.pendingAction.url)
      }

      await onPaidRef.current()
    } catch (submitError: any) {
      setMessageKind('error')
      setMessage(normalizeClipErrorMessage(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  const messageClassName = [
    styles.providerMessage,
    messageKind === 'success' ? styles.messageSuccess : '',
    messageKind === 'error' ? styles.messageError : ''
  ].filter(Boolean).join(' ')

  return (
    <form className={styles.stripeBox} onSubmit={handleSubmit}>
      <div className={styles.clipCardShell}>
        {loadingCard && (
          <div className={styles.brickLoading}>
            <Loader2 size={18} className={styles.spin} />
            <span>Cargando campos seguros</span>
          </div>
        )}
        <div id={containerId} className={styles.clipCardFrame} />
      </div>

      {clipInstallmentsEnabled && (
        <p className={styles.cardAuthorizationNotice}>
          <CreditCard size={16} />
          <span>Si tu tarjeta califica, CLIP mostrará meses sin intereses dentro del formulario seguro.</span>
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        className={styles.conektaSubmitButton}
        loading={submitting}
        disabled={loadingCard}
        leftIcon={!submitting ? <ShieldCheck size={16} /> : undefined}
      >
        {submitting
          ? (isSubscriptionStart ? 'Autorizando' : 'Procesando pago')
          : isSubscriptionStart
            ? `Autorizar suscripción ${formatCurrency(payment.amount, payment.currency)}`
            : `Pagar ${formatCurrency(payment.amount, payment.currency)}`}
      </Button>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>
            {isSubscriptionStart
              ? 'La tarjeta se captura en campos seguros de CLIP. Ristak solo recibe el resultado del pago inicial.'
              : 'La tarjeta se captura en campos seguros de CLIP. Ristak solo recibe el resultado del cobro.'}
          </span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'error' ? <AlertCircle size={16} /> : messageKind === 'success' ? <CheckCircle2 size={16} /> : <Loader2 size={16} className={styles.spin} />}
          <span>{message}</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="clip" />}

      {threeDsUrl && (
        <div className={styles.threeDsOverlay} role="dialog" aria-modal="true" aria-label="Validación bancaria">
          <div className={styles.threeDsPanel}>
            <div className={styles.threeDsHeader}>
              <div>
                <span className={styles.eyebrow}>Validación bancaria</span>
                <strong>Confirma el pago con tu banco</strong>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setThreeDsUrl('')}
                disabled={submitting}
              >
                Cerrar
              </Button>
            </div>
            <iframe
              title="Validación 3DS CLIP"
              src={threeDsUrl}
              className={styles.threeDsFrame}
              allow="payment *"
            />
          </div>
        </div>
      )}
    </form>
  )
}

const RebillCheckoutForm: React.FC<{
  payment: PublicRebillPayment
  totalAmount: number
  onPaid: () => Promise<void>
}> = ({ payment, totalAmount, onPaid }) => {
  const checkoutRef = useRef<RebillCheckoutElement | null>(null)
  const onPaidRef = useRef(onPaid)
  const [loadingCheckout, setLoadingCheckout] = useState(Boolean(payment.publicKey))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info')
  const showSecureNotice = payment.settings?.checkout?.showSecureBadge !== false
  const isTestMode = payment.paymentMode === 'test'
  const instantProduct = useMemo<RebillInstantProduct>(() => payment.instantProduct || {
    name: [{ language: 'es', text: payment.title || 'Pago Ristak' }],
    description: payment.description ? [{ language: 'es', text: payment.description }] : [],
    amount: payment.amount,
    currency: payment.currency,
    metadata: {
      publicPaymentId: payment.publicPaymentId,
      provider: 'rebill'
    }
  }, [
    payment.amount,
    payment.currency,
    payment.description,
    payment.instantProduct,
    payment.publicPaymentId,
    payment.title
  ])
  const customerInformation = payment.customerInformation || null
  const oneClickCheckoutEnabled = payment.rebillInstallments?.enabled !== true
  const display = useMemo<RebillCheckoutDisplay>(() => ({
    checkoutSummary: false,
    successPage: false,
    sandboxMode: isTestMode,
    submitButton: true,
    billingAddress: true,
    customerInformation: true,
    discountCode: false,
    logo: false,
    footer: false,
    processingPayment: true,
    errorMessage: true,
    useAddressSearch: true,
    excludePaymentMethods: REBILL_CARD_ONLY_EXCLUDED_PAYMENT_METHODS
  }), [isTestMode])
  const instantProductJson = useMemo(() => JSON.stringify(instantProduct), [instantProduct])
  const customerInformationJson = useMemo(
    () => customerInformation ? JSON.stringify(customerInformation) : '',
    [customerInformation]
  )
  const displayJson = useMemo(() => JSON.stringify(display), [display])

  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])

  useEffect(() => {
    if (!payment.publicKey) {
      setLoadingCheckout(false)
      setMessageKind('error')
      setMessage('Rebill no devolvió una public key para montar el checkout seguro.')
      return
    }

    let cancelled = false
    setLoadingCheckout(true)
    setMessage('')

    loadRebillSdk()
      .then(() => {
        if (!cancelled) setLoadingCheckout(false)
      })
      .catch((error) => {
        if (cancelled) return
        setLoadingCheckout(false)
        setMessageKind('error')
        setMessage(normalizeRebillErrorMessage(error))
      })

    return () => {
      cancelled = true
    }
  }, [payment.publicKey])

  useEffect(() => {
    if (loadingCheckout) return
    const element = checkoutRef.current
    if (!element || !payment.publicKey) return

    element.setAttribute('public-key', payment.publicKey)
    element.setAttribute('language', 'es')
    element.setAttribute('instant-product', instantProductJson)
    element.setAttribute('display', displayJson)
    element.setAttribute('css', REBILL_CHECKOUT_CSS)
    element.setAttribute('one-click-checkout', oneClickCheckoutEnabled ? 'true' : 'false')
    element.publicKey = payment.publicKey
    element.language = 'es'
    element.instantProduct = instantProduct
    element.display = display
    element.css = REBILL_CHECKOUT_CSS
    element.oneClickCheckout = oneClickCheckoutEnabled

    if (customerInformation) {
      element.setAttribute('customer-information', customerInformationJson)
      element.customerInformation = customerInformation
    } else {
      element.removeAttribute('customer-information')
      element.customerInformation = undefined
    }
  }, [
    customerInformation,
    customerInformationJson,
    display,
    displayJson,
    instantProduct,
    instantProductJson,
    loadingCheckout,
    oneClickCheckoutEnabled,
    payment.publicKey
  ])

  useEffect(() => {
    if (loadingCheckout) return undefined
    const element = checkoutRef.current
    if (!element) return undefined

    const handleReady = () => {
      setLoadingCheckout(false)
    }

    const handleSuccess = async (event: Event) => {
      const rebillPaymentId = extractRebillPaymentId(event)
      const installments = extractRebillInstallments(event)

      if (!rebillPaymentId) {
        setMessageKind('error')
        setMessage('Rebill aprobó el intento, pero no devolvió el paymentId para confirmar el pago.')
        return
      }

      setSubmitting(true)
      setMessageKind('info')
      setMessage('Rebill autorizó el pago. Confirmando contra el servidor antes de cerrar.')

      try {
        const response = await rebillPaymentsService.confirmPublicPayment(payment.publicPaymentId, {
          rebillPaymentId,
          installments
        })
        const confirmedStatus = response.payment?.status || response.status
        const statusMessage = normalizeRebillStatusMessage(confirmedStatus, response.statusDetail)
        setMessageKind(statusMessage.kind)
        setMessage(statusMessage.text)
        if (isRebillPaidStatus(confirmedStatus) || isRebillPendingStatus(confirmedStatus)) {
          await onPaidRef.current()
        }
      } catch (confirmError) {
        setMessageKind('error')
        setMessage(normalizeRebillErrorMessage(confirmError))
      } finally {
        setSubmitting(false)
      }
    }

    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {}
      const reason = detail?.data?.result?.statusDetail ||
        detail?.data?.error?.error?.message ||
        detail?.error?.message ||
        detail?.message
      setMessageKind('error')
      setMessage(normalizeRebillErrorMessage(reason))
    }

    const handleSuccessRedirect = () => {
      setMessageKind('info')
      setMessage('Rebill está abriendo una validación externa. Al volver, esta página refrescará el estado del pago.')
    }

    element.addEventListener('ready', handleReady)
    element.addEventListener('success', handleSuccess)
    element.addEventListener('error', handleError)
    element.addEventListener('successRedirect', handleSuccessRedirect)

    return () => {
      element.removeEventListener('ready', handleReady)
      element.removeEventListener('success', handleSuccess)
      element.removeEventListener('error', handleError)
      element.removeEventListener('successRedirect', handleSuccessRedirect)
    }
  }, [loadingCheckout, payment.publicPaymentId])

  const messageClassName = [
    styles.providerMessage,
    messageKind === 'success' ? styles.messageSuccess : '',
    messageKind === 'error' ? styles.messageError : ''
  ].filter(Boolean).join(' ')
  const checkoutProps: Record<string, unknown> = {
    key: payment.publicPaymentId,
    ref: checkoutRef,
    'public-key': payment.publicKey || '',
    'instant-product': instantProductJson,
    language: 'es',
    display: displayJson,
    css: REBILL_CHECKOUT_CSS,
    'one-click-checkout': oneClickCheckoutEnabled ? 'true' : 'false'
  }
  if (customerInformationJson) {
    checkoutProps['customer-information'] = customerInformationJson
  }

  return (
    <div className={styles.rebillBox}>
      <RebillInstallmentPreview payment={payment} totalAmount={totalAmount} />

      <div className={styles.rebillCheckoutShell}>
        {loadingCheckout && (
          <div className={styles.brickLoading}>
            <Loader2 size={18} className={styles.spin} />
            <span>Cargando checkout seguro</span>
          </div>
        )}
        <div className={styles.rebillCheckoutHost}>
          {React.createElement('rebill-checkout', checkoutProps)}
        </div>
      </div>

      {showSecureNotice && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>Rebill protege los datos de la tarjeta. Ristak confirma el resultado antes de marcar el pago como cobrado.</span>
        </p>
      )}

      {message && (
        <p className={messageClassName}>
          {messageKind === 'error' ? <AlertCircle size={16} /> : messageKind === 'success' ? <CheckCircle2 size={16} /> : <Loader2 size={16} className={styles.spin} />}
          <span>{message}</span>
        </p>
      )}

      {submitting && (
        <p className={styles.providerMessage}>
          <Loader2 size={16} className={styles.spin} />
          <span>Validando el resultado con Rebill.</span>
        </p>
      )}

      {isTestMode && <PaymentTestHelper provider="rebill" />}
    </div>
  )
}

const RebillHostedPaymentRedirect: React.FC<{
  payment: PublicRebillPayment
  totalAmount: number
  returnedFromRebill: boolean
  onRefresh: () => Promise<void>
}> = ({ payment, totalAmount, returnedFromRebill, onRefresh }) => {
  const hostedPaymentUrl = payment.hostedPaymentUrl || payment.rebillHostedPaymentLink?.url || ''
  const [redirecting, setRedirecting] = useState(Boolean(hostedPaymentUrl && !returnedFromRebill))
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!hostedPaymentUrl || returnedFromRebill || typeof window === 'undefined') return undefined
    const timer = window.setTimeout(() => {
      window.location.assign(hostedPaymentUrl)
    }, 650)
    return () => window.clearTimeout(timer)
  }, [hostedPaymentUrl, returnedFromRebill])

  const openHostedPayment = () => {
    if (!hostedPaymentUrl || typeof window === 'undefined') return
    setRedirecting(true)
    window.location.assign(hostedPaymentUrl)
  }

  const refreshStatus = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  if (!hostedPaymentUrl) {
    return (
      <div className={styles.rebillBox}>
        <p className={`${styles.providerMessage} ${styles.messageError}`}>
          <AlertCircle size={16} />
          <span>Rebill no devolvió el link hospedado para completar este pago.</span>
        </p>
      </div>
    )
  }

  return (
    <div className={styles.rebillBox}>
      <RebillInstallmentPreview payment={payment} totalAmount={totalAmount} />

      <p className={styles.providerMessage}>
        {returnedFromRebill
          ? (refreshing ? <Loader2 size={16} className={styles.spin} /> : <ShieldCheck size={16} />)
          : <Loader2 size={16} className={styles.spin} />}
        <span>
          {returnedFromRebill
            ? 'Estamos confirmando el resultado con Rebill. Si ya terminaste el pago, el estado se actualizará en cuanto Rebill avise.'
            : 'Te estamos llevando al checkout seguro de Rebill para completar el pago con tarjeta.'}
        </span>
      </p>

      <div className={styles.actions}>
        {returnedFromRebill ? (
          <Button
            type="button"
            variant="secondary"
            fullWidth
            className={styles.payButton}
            onClick={refreshStatus}
            disabled={refreshing}
            leftIcon={refreshing ? <Loader2 size={16} className={styles.spin} /> : <ShieldCheck size={16} />}
          >
            {refreshing ? 'Revisando' : 'Actualizar estado'}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={returnedFromRebill ? 'primary' : 'secondary'}
          fullWidth
          className={styles.payButton}
          onClick={openHostedPayment}
          disabled={redirecting && !returnedFromRebill}
          leftIcon={(redirecting && !returnedFromRebill) ? <Loader2 size={16} className={styles.spin} /> : <ExternalLink size={16} />}
        >
          {(redirecting && !returnedFromRebill) ? 'Abriendo Rebill' : returnedFromRebill ? 'Volver a Rebill' : 'Abrir checkout Rebill'}
        </Button>
      </div>

      <p className={styles.cardAuthorizationNotice}>
        <ShieldCheck size={16} />
        <span>Rebill procesa la tarjeta en su portal seguro. Ristak confirma el resultado con webhooks antes de marcar el pago como cobrado.</span>
      </p>
    </div>
  )
}

export const PublicPaymentGatewayReturn: React.FC = () => {
  const [searchParams] = useSearchParams()
  const { theme } = useTheme()
  usePublicPaymentLightMode(theme)

  const provider = resolveGatewayProvider(
    searchParams.get('provider') ||
    searchParams.get('gateway') ||
    searchParams.get('payment_provider')
  )
  const returnState = resolveGatewayReturnState(searchParams)
  const isSuccess = returnState === 'success'
  const isPending = returnState === 'pending'
  const badgeVariant: BadgeVariant = isSuccess ? 'success' : isPending ? 'info' : 'error'
  const title = isSuccess
    ? 'Pago exitoso'
    : isPending
      ? 'Pago en proceso'
      : 'Checkout no completado'
  const description = isSuccess
    ? `La autorización de la suscripción volvió desde ${provider.label}. Ristak actualizará el registro con el webhook de la pasarela.`
    : isPending
      ? `${provider.label} todavía está procesando el resultado. Ristak actualizará la suscripción en cuanto la pasarela lo confirme.`
      : `No recibimos una autorización completada desde ${provider.label}. Puedes volver a intentar desde el enlace original.`

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brandLockup}>
            <div>
              <span className={styles.eyebrow}>Ristak Payments</span>
              <strong>Checkout seguro</strong>
            </div>
          </div>
          <Badge variant={badgeVariant} className={styles.statusBadge}>
            {isSuccess ? <CheckCircle2 size={15} /> : isPending ? <ShieldCheck size={15} /> : <AlertCircle size={15} />}
            {isSuccess ? 'Exitoso' : isPending ? 'Procesando' : 'No completado'}
          </Badge>
        </header>

        <section className={styles.successStage} aria-label="Resultado del checkout">
          {isSuccess ? (
            <PaymentSuccessExperience
              providerLogo={provider.logo}
              providerLabel={provider.label}
              title="Suscripción autorizada"
              description={description}
              details={[
                { label: 'Tipo', value: 'Suscripción' },
                { label: 'Estado', value: 'Autorización recibida' },
                { label: 'Pasarela', value: provider.label }
              ]}
            />
          ) : (
            <div className={styles.noticeCard}>
              <div className={styles.gatewayReturnNotice}>
                <div className={styles.gatewayReturnIcon} aria-hidden="true">
                  {isPending ? <ShieldCheck size={34} /> : <AlertCircle size={34} />}
                </div>
                <div className={styles.gatewayReturnCopy}>
                  <span className={styles.eyebrow}>
                    <PaymentPlatformLogo platform={provider.logo} size="sm" decorative />
                    {provider.label}
                  </span>
                  <h1>{title}</h1>
                  <p>{description}</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export const PublicPayment: React.FC = () => {
  const { publicPaymentId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const { theme } = useTheme()
  const autoReceiptPrintRef = useRef('')
  const metaPurchasePixelRef = useRef('')
  const autoStartedStripePaymentRef = useRef('')
  const [payment, setPayment] = useState<PublicPaymentData | null>(null)
  const [intent, setIntent] = useState<StripePaymentIntentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingPayment, setStartingPayment] = useState(false)
  const [error, setError] = useState('')

  usePublicPaymentLightMode(theme)

  useEffect(() => {
    autoStartedStripePaymentRef.current = ''
    setIntent(null)
  }, [publicPaymentId])

  const status = getStatusCopy(payment?.status || '')
  const isPaid = Boolean(payment && ['paid', 'succeeded', 'completed'].includes(payment.status.toLowerCase()))
  const isClosed = Boolean(payment && ['void', 'refunded', 'deleted'].includes(payment.status.toLowerCase()))
  const isScheduled = Boolean(payment && payment.status.toLowerCase() === 'scheduled')
  const receiptDownloadRequested = searchParams.get('receipt') === '1'
  const isStripePayment = payment?.provider === 'stripe'
  const isMercadoPagoPayment = payment?.provider === 'mercadopago'
  const isConektaPayment = payment?.provider === 'conekta'
  const isClipPayment = payment?.provider === 'clip'
  const rebillPayment = payment?.provider === 'rebill' ? payment : null
  const isRebillPayment = Boolean(rebillPayment)
  const isRebillHostedPayment = Boolean(rebillPayment?.hostedPaymentUrl || rebillPayment?.rebillHostedPaymentLink?.url)
  const returnedFromRebill = Boolean(rebillPayment && searchParams.has('rebill_return'))
  const stripePayment = payment?.provider === 'stripe' ? payment : null
  const paymentPlan = stripePayment?.paymentPlan || null
  const subscriptionStart = payment && 'subscriptionStart' in payment ? payment.subscriptionStart : null
  const isSubscriptionStart = Boolean(subscriptionStart?.subscriptionId)
  const shouldSavePaymentMethod = Boolean(stripePayment?.contact?.id || paymentPlan?.cardSetupRequired)
  const isControlledStripeInstallments = Boolean(stripePayment && stripeControlledInstallmentsEnabled(stripePayment) && !isSubscriptionStart && !paymentPlan?.cardSetupRequired)
  const providerLabel = isMercadoPagoPayment ? 'Mercado Pago' : isConektaPayment ? 'Conekta' : isClipPayment ? 'CLIP' : isRebillPayment ? 'Rebill' : 'Stripe'
  const providerLogo: PaymentPlatformLogoId = isMercadoPagoPayment ? 'mercadopago' : isConektaPayment ? 'conekta' : isClipPayment ? 'clip' : isRebillPayment ? 'rebill' : 'stripe'

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

  const cardElementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (!stripePayment) return null
    return {
      appearance: buildStripeAppearance(),
      locale: resolveStripeLocale(stripePayment)
    }
  }, [stripePayment])

  const reducedMotion = usePrefersReducedMotion()
  const animatedRef = useRef(false)

  const loadPayment = async (sync = false) => {
    if (!publicPaymentId) return
    const data = await loadPublicPayment(publicPaymentId, sync)
    setPayment(data)
  }

  const loadPublicPayment = async (id: string, sync = false): Promise<PublicPaymentData> => {
    try {
      return await stripePaymentsService.getPublicPayment(id, sync, searchParams.get('session_id') || '')
    } catch (stripeError: any) {
      try {
        return await mercadoPagoPaymentsService.getPublicPayment(id)
      } catch {
        try {
          return await conektaPaymentsService.getPublicPayment(id)
        } catch {
          try {
            return await clipPaymentsService.getPublicPayment(id)
          } catch {
            try {
              return await rebillPaymentsService.getPublicPayment(id)
            } catch {
              throw stripeError
            }
          }
        }
      }
    }
  }

  const isPaidStatus = (value?: string) =>
    ['paid', 'succeeded', 'completed'].includes(String(value || '').toLowerCase())

  // Aplica la actualización del pago. Si el pago acaba de completarse en vivo y el
  // navegador soporta View Transitions (y no hay reduce-motion), envolvemos el cambio
  // para que la tarjeta de pago viaje al centro y se transforme en la pantalla de
  // éxito con un morph suave, en vez de un corte abrupto. Cualquier fallo cae al
  // cambio directo, sin afectar el registro del pago.
  const applyPaymentUpdate = (data: PublicPaymentData) => {
    const startViewTransition = typeof document !== 'undefined'
      ? (document as any).startViewTransition?.bind(document)
      : undefined
    const shouldAnimate = isPaidStatus(data.status)
      && !isPaid
      && !reducedMotion
      && typeof startViewTransition === 'function'

    if (shouldAnimate) {
      animatedRef.current = true
      try {
        startViewTransition(() => {
          flushSync(() => setPayment(data))
        })
        return
      } catch {
        // Si la transición falla, seguimos con el cambio directo.
      }
    }
    setPayment(data)
  }

  const handlePaid = async () => {
    try {
      const data = await loadPublicPayment(publicPaymentId, true)
      applyPaymentUpdate(data)
    } catch {
      await loadPayment(true)
    }
  }

  useEffect(() => {
    let mounted = true

    async function run() {
      setLoading(true)
      setError('')
      try {
        // (PAY2-004) Detecta el retorno del checkout. Stripe vuelve con ?payment=return,
        // pero Mercado Pago (Checkout Pro) regresa con sus propios parámetros
        // (collection_status / status / payment_id / preference_id / merchant_order_id /
        // external_reference). En cualquiera de esos casos forzamos un sync para refrescar
        // el estado del pago en vez de quedarnos con la vista en caché.
        const sync = isPaymentReturn(searchParams)
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

      if (payment.provider === 'rebill') {
        const paymentUrl = REBILL_USE_HOSTED_PAYMENT_LINKS
          ? payment.hostedPaymentUrl || payment.rebillHostedPaymentLink?.url || payment.paymentUrl
          : payment.paymentUrl
        if (!paymentUrl) {
          throw new Error('Rebill no devolvió un link de pago.')
        }
        window.location.assign(paymentUrl)
        return
      }

      if (payment.provider === 'stripe' && isSubscriptionStart) {
        const checkout = await stripePaymentsService.createPublicSubscriptionCheckout(payment.publicPaymentId)
        if (checkout.alreadyActive) {
          await loadPayment(true)
          return
        }
        if (!checkout.checkoutUrl) {
          throw new Error('Stripe no devolvió el checkout de suscripción.')
        }
        window.location.assign(checkout.checkoutUrl)
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

  useEffect(() => {
    if (!stripePayment || !stripePayment.publishableKey || intent?.clientSecret || startingPayment || isPaid || isClosed || isScheduled) return
    if (isSubscriptionStart) return
    if (isControlledStripeInstallments) return

    const autoStartKey = `${stripePayment.publicPaymentId}:${shouldSavePaymentMethod ? 'save' : 'charge'}`
    if (autoStartedStripePaymentRef.current === autoStartKey) return

    autoStartedStripePaymentRef.current = autoStartKey
    void startPayment()
  }, [
    intent?.clientSecret,
    isClosed,
    isPaid,
    isScheduled,
    stripePayment?.publicPaymentId,
    stripePayment?.publishableKey,
    shouldSavePaymentMethod,
    isSubscriptionStart,
    isControlledStripeInstallments,
    startingPayment
  ])

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

  useEffect(() => {
    if (!payment || !isPaid || !payment.metaPurchaseEvent) return
    const eventKey = `${payment.publicPaymentId}:${payment.metaPurchaseEvent.pixelId}:${payment.metaPurchaseEvent.eventId}`
    if (metaPurchasePixelRef.current === eventKey) return
    metaPurchasePixelRef.current = eventKey

    fireMetaPurchasePixelEvent(payment).catch(() => {
      metaPurchasePixelRef.current = ''
    })
  }, [payment, isPaid])

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
  const publicTimezone = payment.timezone || payment.timeZone || DEFAULT_TIMEZONE
  const taxLabel = taxDetails?.enabled
    ? `${taxDetails.taxName || 'Impuesto'} ${taxDetails.rateValue || 0}%`
    : ''
  const hasTaxBreakdown = Boolean(taxDetails?.enabled && taxDetails.taxAmount > 0)
  const subtotalAmount = hasTaxBreakdown ? taxDetails?.subtotalAmount || 0 : payment.amount
  const taxAmount = hasTaxBreakdown ? taxDetails?.taxAmount || 0 : 0
  const totalAmount = hasTaxBreakdown ? taxDetails?.totalAmount || payment.amount : payment.amount
  const rebillInstallmentMonths = rebillPayment ? getRebillInstallmentMonths(rebillPayment) : []
  const rebillInstallmentSummary = rebillInstallmentMonths.length
    ? `${formatRebillInstallmentOptions(rebillInstallmentMonths)} si tu tarjeta aplica`
    : ''
  const invoiceDesign = resolveInvoiceDesign(receiptSettings)
  const invoiceStyleVars = buildInvoiceStyleVars(receiptSettings)
  const printSheetClassName = [
    styles.printSheet,
    styles[printTemplateClassById[invoiceDesign.template.id]]
  ].filter(Boolean).join(' ')
  const paymentModeLabel = payment.paymentMode === 'live' ? 'Producción' : 'Prueba'
  const headline = isPaid
    ? (isSubscriptionStart ? 'Suscripción autorizada' : 'Pago confirmado')
    : isSubscriptionStart
      ? 'Autoriza tu suscripción'
    : checkoutSettings?.headline || payment.title || 'Pago pendiente'
  const description = isPaid
    ? (isSubscriptionStart
        ? 'La suscripción fue autorizada correctamente.'
        : 'Tu pago fue recibido correctamente. Puedes descargar tu comprobante en PDF cuando lo necesites.')
    : isSubscriptionStart
      ? `Revisa los datos de la suscripción y autoriza el cobro recurrente con ${providerLabel}.`
    : checkoutSettings?.description || `Revisa los datos del cobro y paga de forma segura con ${providerLabel}. Ristak no ve ni guarda el número de tu tarjeta.`
  const planInstallments = paymentPlan?.installments || []
  const firstPlanPayment = paymentPlan?.firstPayment || null
  const scheduledPlanCount = planInstallments.length
  const totalPlanPayments = scheduledPlanCount + (firstPlanPayment ? 1 : 0)
  const isCardSetupPlan = Boolean(paymentPlan?.cardSetupRequired || paymentPlan?.trigger === 'card_setup')
  const planTotal = Number(paymentPlan?.total || 0)
  const addedInstallmentCount = Number(paymentPlan?.changeSummary?.addedInstallmentCount || 0)
  const hasPlanSummary = Boolean(paymentPlan && (planTotal > 0 || firstPlanPayment || scheduledPlanCount > 0))
  const successDetails: SuccessDetailRow[] = [
    ...(showBusinessInfo
      ? [{
          label: 'Negocio',
          value: receiptSettings?.businessName || 'Negocio'
        }]
      : []),
    ...(showCustomerInfo
      ? [{
          label: 'Cliente',
          value: payment.contact?.name || 'Cliente'
        }]
      : []),
    {
      label: 'Fecha de pago',
      value: formatDate(payment.paidAt || new Date().toISOString(), publicTimezone)
    },
    ...(hasTaxBreakdown
      ? [{
          label: 'Impuesto',
          value: formatCurrency(taxAmount, payment.currency)
        }]
      : [])
  ]
  const successBusinessDetails = showBusinessInfo && receiptSettings
    ? [
        receiptSettings.businessEmail,
        receiptSettings.businessPhone,
        receiptSettings.businessAddress,
        receiptSettings.businessWebsite
      ].filter(Boolean) as string[]
    : []

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

        {isPaid ? (
          <section className={styles.successStage} aria-label="Comprobante del pago">
            <PaymentSuccessExperience
              providerLogo={providerLogo}
              providerLabel={`${providerLabel} · ${paymentModeLabel}`}
              title={isSubscriptionStart ? 'Suscripción autorizada' : '¡Pago confirmado!'}
              description={isSubscriptionStart
                ? 'Tu suscripción quedó autorizada correctamente. Ya puedes cerrar esta ventana con tranquilidad.'
                : 'Recibimos tu pago y quedó confirmado. Guarda o descarga tu comprobante cuando lo necesites.'}
              amountLabel={isSubscriptionStart ? 'Monto autorizado' : 'Total pagado'}
              amountValue={isCardSetupPlan && Number(totalAmount || 0) <= 0
                ? 'Sin cargo inmediato'
                : formatCurrency(totalAmount, payment.currency)}
              conceptTitle={payment.title || 'Pago'}
              conceptDescription={payment.description || undefined}
              details={successDetails}
              businessDetails={successBusinessDetails}
              reference={payment.publicPaymentId}
              confettiDelay={animatedRef.current ? 720 : 240}
              action={(
                <Button
                  type="button"
                  variant="secondary"
                  leftIcon={<Download size={16} />}
                  onClick={handleDownloadPdf}
                >
                  Descargar comprobante PDF
                </Button>
              )}
            />
          </section>
        ) : (
        <section className={[styles.checkoutLayout, isRebillPayment ? styles.rebillCheckoutLayout : ''].filter(Boolean).join(' ')}>
          <section className={styles.summaryPane} aria-label="Resumen del pago">
            <div className={styles.summaryIntro}>
              <span className={styles.eyebrow}>{isPaid ? 'Comprobante listo' : hasPlanSummary ? 'Plan de pagos' : 'Checkout seguro'}</span>
              <h1 className={styles.title}>{headline}</h1>
              <p className={styles.subtitle}>{description}</p>
            </div>

            <div className={styles.summaryAmountBlock} aria-label={isPaid ? 'Total pagado' : isSubscriptionStart ? 'Monto recurrente' : 'Total a pagar'}>
              <span>{isPaid ? 'Total pagado' : isSubscriptionStart ? 'Monto recurrente' : isCardSetupPlan ? 'Monto de este link' : 'Total a pagar'}</span>
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
                  <strong>{formatDate(payment.dueDate, publicTimezone)}</strong>
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
                  <span>{isSubscriptionStart ? 'Monto recurrente' : 'Total'}</span>
                  <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
                </div>
                {rebillInstallmentSummary && (
                  <div>
                    <span>Meses sin intereses</span>
                    <strong>{rebillInstallmentSummary}</strong>
                  </div>
                )}
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
                    Este link autoriza el método de pago para el calendario programado del plan.
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
                      {formatCurrency(firstPlanPayment.amount, paymentPlan.currency || payment.currency)} · {formatDate(firstPlanPayment.date, publicTimezone)}
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
                          <span>{formatDate(installment.dueDate, publicTimezone)} · {getPlanInstallmentStatusCopy(installment.status)}</span>
                          <small>{getPlanPaymentMethodCopy(installment.paymentMethod)}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={[styles.payPanel, isRebillPayment ? styles.rebillPayPanel : ''].filter(Boolean).join(' ')} aria-label="Formulario de pago">
            <div className={styles.payHeader}>
              <div className={styles.payHeaderTop}>
                {isRebillPayment ? (
                  <span className={styles.payHeaderIcon} aria-hidden="true">
                    <CreditCard size={18} />
                  </span>
                ) : (
                  <PaymentPlatformLogo platform={providerLogo} size="lg" decorative />
                )}
                <div>
                  <span className={styles.payKicker}>{isPaid ? 'Estado final' : isScheduled ? 'Aún no disponible' : 'Método de pago'}</span>
                  <h2>{isPaid ? (isSubscriptionStart ? 'Suscripción autorizada' : 'Pago confirmado') : isScheduled ? 'Pago programado' : isSubscriptionStart ? 'Autorizar suscripción' : isCardSetupPlan ? 'Autorizar tarjeta' : 'Pagar con tarjeta'}</h2>
                </div>
              </div>
              <p>
                {isPaid
                  ? (isSubscriptionStart ? 'Esta suscripción ya quedó autorizada.' : 'Este pago ya aparece como pagado en Ristak.')
                  : isScheduled
                    ? 'Este cobro todavía no está disponible. Ristak habilitará el checkout cuando llegue la fecha programada.'
                  : isMercadoPagoPayment
                    ? 'Captura la tarjeta en el formulario seguro de Mercado Pago sin salir de esta página.'
                    : isConektaPayment
                      ? (isSubscriptionStart
                          ? 'Captura la tarjeta en el tokenizador seguro de Conekta para autorizar la suscripción.'
                          : 'Captura la tarjeta en el tokenizador seguro de Conekta sin salir de esta página.')
                      : isClipPayment
                        ? (isSubscriptionStart
                            ? 'Captura la tarjeta en el formulario seguro de CLIP para pagar el inicio de la suscripción.'
                            : 'Captura la tarjeta en el formulario seguro de CLIP sin salir de esta página.')
                        : isRebillPayment
                          ? 'Completa el checkout seguro de Rebill sin salir de esta página.'
                      : isCardSetupPlan
                        ? 'Stripe abrirá el formulario seguro para autorizar el calendario mostrado.'
                        : isSubscriptionStart
                          ? 'Stripe abrirá su Checkout seguro para autorizar la suscripción.'
                          : isControlledStripeInstallments && stripePayment
                            ? `Captura la tarjeta y Ristak mostrará sólo los meses compatibles hasta ${getStripeInstallmentMax(stripePayment)} meses.`
                          : 'Los datos se capturan en el formulario seguro de Stripe.'}
              </p>
            </div>

            {error && (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </p>
            )}

            {isClosed ? (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>Este link ya no está disponible para cobrar.</span>
              </p>
            ) : isScheduled ? (
              <p className={styles.message}>
                <Info size={16} />
                <span>Este pago está programado y todavía no se puede cobrar. Vuelve a abrir este enlace cuando llegue la fecha indicada.</span>
              </p>
            ) : isStripePayment && isSubscriptionStart ? (
              <div className={styles.stripeBox}>
                <p className={styles.message}>
                  {startingPayment ? <Loader2 size={16} className={styles.spin} /> : <ShieldCheck size={16} />}
                  <span>{startingPayment ? 'Abriendo Checkout de Stripe.' : 'Continúa a Stripe para autorizar la suscripción.'}</span>
                </p>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="primary"
                    fullWidth
                    className={styles.payButton}
                    onClick={startPayment}
                    disabled={startingPayment}
                    leftIcon={startingPayment ? <Loader2 size={16} className={styles.spin} /> : <ExternalLink size={16} />}
                  >
                    {startingPayment ? 'Abriendo' : 'Continuar a Stripe'}
                  </Button>
                </div>
              </div>
            ) : isMercadoPagoPayment ? (
              <MercadoPagoCardPaymentForm
                payment={payment}
                onPaid={handlePaid}
                onFallback={startPayment}
                fallbackLoading={startingPayment}
              />
            ) : isConektaPayment ? (
              <ConektaCardTokenizerForm
                payment={payment}
                onPaid={handlePaid}
              />
            ) : isClipPayment ? (
              <ClipCardPaymentForm
                payment={payment}
                onPaid={handlePaid}
              />
            ) : rebillPayment && REBILL_USE_HOSTED_PAYMENT_LINKS && isRebillHostedPayment ? (
              <RebillHostedPaymentRedirect
                payment={rebillPayment}
                totalAmount={totalAmount}
                returnedFromRebill={returnedFromRebill}
                onRefresh={handlePaid}
              />
            ) : rebillPayment ? (
              <RebillCheckoutForm
                payment={rebillPayment}
                totalAmount={totalAmount}
                onPaid={handlePaid}
              />
            ) : isStripePayment && isControlledStripeInstallments && stripePromise && cardElementsOptions ? (
              <Elements stripe={stripePromise} options={cardElementsOptions}>
                <PublicStripeInstallmentPaymentForm payment={payment} onPaid={handlePaid} />
              </Elements>
            ) : isStripePayment && stripePromise && elementsOptions ? (
              <Elements stripe={stripePromise} options={elementsOptions}>
                <PublicPaymentForm payment={payment} onPaid={handlePaid} />
              </Elements>
            ) : (
              <div className={styles.stripeBox}>
                <p className={styles.message}>
                  {startingPayment ? <Loader2 size={16} className={styles.spin} /> : <ShieldCheck size={16} />}
                  <span>{startingPayment ? 'Preparando el formulario seguro de Stripe.' : 'No se pudo montar el formulario seguro de Stripe automáticamente.'}</span>
                </p>
                {error && (
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
                      {startingPayment ? 'Preparando' : 'Reintentar'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
        </section>
        )}
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
                <span>Fecha de pago {formatDate(payment.paidAt || new Date().toISOString(), publicTimezone)}</span>
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
                <strong>{formatDate(payment.paidAt || new Date().toISOString(), publicTimezone)}</strong>
              </div>
              <div>
                <span>Vencimiento</span>
                <strong>{formatDate(payment.dueDate, publicTimezone)}</strong>
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
