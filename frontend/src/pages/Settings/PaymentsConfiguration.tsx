import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Cable,
  CheckCircle,
  Clock,
  Copy,
  CreditCard,
  ChevronDown,
  ExternalLink,
  FileCheck2,
  Image,
  ImageUp,
  Info,
  KeyRound,
  Loader2,
  Paintbrush,
  PackageCheck,
  Percent,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unplug,
  Webhook
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CustomSelect,
  NumberInput,
  PageContainer,
  PageHeader,
  PaymentPlatformLogo,
  type PaymentPlatformLogoId,
  SegmentTabs,
  Switch,
  MetaBrandMark,
  MetaParameterValueInput,
  Modal,
  type MetaParameterVariable
} from '@/components/common'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAuth } from '@/contexts/AuthContext'
import { useAccountCurrency, useAppConfig } from '@/hooks'
import { useHighLevelConnected } from '@/hooks/useHighLevelConnected'
import {
  ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY,
  defaultAccountBusinessProfile,
  hasAccountBusinessProfileDetails,
  normalizeAccountBusinessProfile,
  type AccountBusinessProfile
} from '@/services/accountBusinessProfile'
import { invalidateIntegrationsStatus } from '@/services/integrationsService'
import mediaService from '@/services/mediaService'
import {
  defaultPaymentSettings,
  paymentSettingsService,
  type PaymentAutomationSettings,
  type PaymentCheckoutSettings,
  type PaymentReceiptSettings,
  type PaymentSettings,
  type PaymentTaxSettings
} from '@/services/paymentSettingsService'
import { conektaPaymentsService, type ConektaPaymentConfig, type SaveConektaPaymentConfigPayload } from '@/services/conektaPaymentsService'
import { clipPaymentsService, type ClipPaymentConfig, type SaveClipPaymentConfigPayload } from '@/services/clipPaymentsService'
import { mercadoPagoPaymentsService, type MercadoPagoPaymentConfig } from '@/services/mercadoPagoPaymentsService'
import { rebillPaymentsService, type RebillPaymentConfig, type SaveRebillPaymentConfigPayload } from '@/services/rebillPaymentsService'
import { stripePaymentsService, type SaveStripePaymentConfigPayload, type StripePaymentConfig } from '@/services/stripePaymentsService'
import { whatsappApiService, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import {
  buildInvoiceStyleVars,
  invoicePaletteOptions,
  invoiceTemplateOptions,
  resolveInvoiceDesign,
  type PaymentInvoicePaletteId,
  type PaymentInvoiceTemplateId
} from '@/utils/paymentInvoiceDesign'
import {
  getWhatsAppStatusConnectionAvailability,
  type WhatsAppConnectionAvailability
} from '@/utils/whatsappQrFallbackWarning'
import {
  getGigstackUnitName,
  gigstackPaymentMethodOptions,
  gigstackProductKeyOptions,
  gigstackUnitOptions,
  isValidGigstackProductKey,
  isValidGigstackUnitKey,
  normalizeGigstackProductKeyInput,
  normalizeGigstackUnitKeyInput
} from '@/utils/gigstackFiscalCatalog'
import {
  BASE_VARIABLES,
  loadAllVariables,
  type FlowVariable
} from '@/pages/Automations/editor/variablesCatalog'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower, formatCrmLabelWithDefiniteArticle } from '@/utils/crmLabels'
import {
  hasPaymentAutomationsAccess as canAccessPaymentAutomations,
  hasPaymentCheckoutAccess as canAccessPaymentCheckout,
  hasPaymentGatewaysAccess as canAccessPaymentGateways
} from '@/utils/accessControl'
import styles from './PaymentsConfiguration.module.css'

type PaymentsSectionId = 'checkout' | 'receipt' | 'meta' | 'automations' | 'gateways' | 'taxes'
type PaymentGatewayId = 'highlevel' | 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill'
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error'
type PaymentAutomationTemplateKind = 'reminder' | 'receipt' | 'failed'
type StripeModeId = 'test' | 'live'
type PaymentModeId = 'test' | 'live'
type PaymentMetaPurchaseEventChannel = 'site' | 'whatsapp' | 'smart'

interface PaymentMetaPurchaseEventParameter {
  id: string
  key: string
  value: string
}

interface PaymentMetaPurchaseEventParameters {
  sendValue: boolean
  usePaymentPlanTotalValue: boolean
  value: string
  predictedLtv: string
  custom: PaymentMetaPurchaseEventParameter[]
}

interface PaymentMetaPurchaseEventConfig {
  enabled: boolean
  channel: PaymentMetaPurchaseEventChannel
  eventName: string
  parameters: PaymentMetaPurchaseEventParameters
}

interface StripeModeCredentials {
  publishableKey: string
  secretKey: string
  webhookSecret: string
}

interface ConektaModeCredentials {
  publicKey: string
  privateKey: string
}

interface ClipModeCredentials {
  apiKey: string
  accountLabel: string
}

interface RebillModeCredentials {
  publicKey: string
  secretKey: string
}

interface MercadoPagoSubscriptionTestCredentials {
  publicKey: string
  accessToken: string
  webhookSecret: string
}

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'available'
  logo?: PaymentPlatformLogoId
}

interface WebhookEventGuideItem {
  event: string
  description: string
}

interface GatewayAutomaticConnectionStatus {
  configured?: boolean
  webhookConfigured?: boolean
  webhookStatus?: string | null
  webhookLastError?: string | null
}

const gatewayStatusCopy: Record<PaymentGatewayOption['status'], { label: string; variant: 'success' | 'neutral' }> = {
  connected: { label: 'Conectada', variant: 'success' },
  available: { label: 'Sin conexión', variant: 'neutral' }
}

const sectionItems: Array<{ id: PaymentsSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'checkout', label: 'Página de cobro', icon: <CreditCard size={17} /> },
  { id: 'receipt', label: 'Comprobante', icon: <ReceiptText size={17} /> },
  { id: 'automations', label: 'Automatizaciones', icon: <BellRing size={17} /> },
  { id: 'gateways', label: 'Pasarelas', icon: <Cable size={17} /> },
  { id: 'taxes', label: 'Impuestos', icon: <Percent size={17} /> },
  { id: 'meta', label: 'Meta', icon: <MetaBrandMark size={17} /> }
]

const sectionIds = sectionItems.map((item) => item.id)
const gatewayIds: PaymentGatewayId[] = ['highlevel', 'stripe', 'conekta', 'mercadopago', 'clip', 'rebill']
const GIGSTACK_API_URL = 'https://gigstack.pro/api-facturacion'
const SAT_PRODUCT_CATALOG_URL = 'https://wwwmat.sat.gob.mx/consultas/53693/catalogo-de-productos-y-servicios'
const stripeModeIds: StripeModeId[] = ['test', 'live']
const emptyStripeModeCredentials: Record<StripeModeId, StripeModeCredentials> = {
  test: { publishableKey: '', secretKey: '', webhookSecret: '' },
  live: { publishableKey: '', secretKey: '', webhookSecret: '' }
}
const emptyConektaModeCredentials: Record<StripeModeId, ConektaModeCredentials> = {
  test: { publicKey: '', privateKey: '' },
  live: { publicKey: '', privateKey: '' }
}
const emptyClipModeCredentials: Record<StripeModeId, ClipModeCredentials> = {
  test: { apiKey: '', accountLabel: '' },
  live: { apiKey: '', accountLabel: '' }
}
const emptyRebillModeCredentials: Record<StripeModeId, RebillModeCredentials> = {
  test: { publicKey: '', secretKey: '' },
  live: { publicKey: '', secretKey: '' }
}
const emptyMercadoPagoSubscriptionTestCredentials: MercadoPagoSubscriptionTestCredentials = {
  publicKey: '',
  accessToken: '',
  webhookSecret: ''
}
const stripeModeLabels: Record<StripeModeId, { title: string; description: string; publishablePlaceholder: string; secretPlaceholder: string }> = {
  test: {
    title: 'Modo prueba',
    description: 'Para probar links y tarjetas sin mover dinero real.',
    publishablePlaceholder: 'pk_test_...',
    secretPlaceholder: 'sk_test_...'
  },
  live: {
    title: 'Modo en vivo',
    description: 'Para aceptar pagos reales con tu cuenta de Stripe.',
    publishablePlaceholder: 'pk_live_...',
    secretPlaceholder: 'sk_live_...'
  }
}
const paymentModeLabels: Record<PaymentModeId, { title: string; badge: string; description: string; mercadoPagoHelp: string }> = {
  test: {
    title: 'Modo prueba',
    badge: 'Prueba',
    description: 'Todos los nuevos cobros usarán modo prueba para validar tarjetas, rechazos y flujos sin mover dinero real.',
    mercadoPagoHelp: 'Mercado Pago prueba pagos únicos y suscripciones con reglas distintas. Revisa la guía antes de probar para no mezclar cuentas reales con usuarios test.'
  },
  live: {
    title: 'Modo en vivo',
    badge: 'En vivo',
    description: 'Todos los nuevos cobros usarán credenciales reales y podrán mover dinero.',
    mercadoPagoHelp: 'Para cobrar real con Mercado Pago, inicia sesión con tu cuenta normal de Mercado Pago y autoriza la conexión.'
  }
}
const mercadoPagoSinglePaymentTestSteps = [
  'Conecta Mercado Pago en modo prueba.',
  'Crea un link de pago único y abre el checkout.',
  'Usa tarjeta de prueba: APRO aprueba, FUND rechaza por fondos.',
  'Captura un correo válido distinto al de la cuenta conectada.'
]
const mercadoPagoSubscriptionTestSteps = [
  'Crea vendedor test y comprador test del mismo país.',
  'En incógnito, entra como vendedor test y crea una app en Tus integraciones.',
  'Copia la Public Key y el Access Token de esa app.',
  'Configura Webhooks con URL de Ristak, eventos y clave secreta.',
  'Abre el link como comprador test. No uses vendedor ni cuenta real.'
]
const mercadoPagoSubscriptionWebhookEvents: WebhookEventGuideItem[] = [
  {
    event: 'Pagos',
    description: 'Sincroniza pagos aprobados, pendientes, fallidos o reembolsados.'
  },
  {
    event: 'Planes y suscripciones',
    description: 'Activa suscripciones, cambios de estado y cobros recurrentes autorizados.'
  },
  {
    event: 'Reclamos',
    description: 'Detecta reclamos o contracargos relacionados con pagos.'
  }
]
const mercadoPagoSubscriptionWebhookEventNames = mercadoPagoSubscriptionWebhookEvents.map((item) => item.event).join('\n')
const PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME = 'Purchase'
const PAYMENT_META_DEFAULT_EVENT_CHANNEL: PaymentMetaPurchaseEventChannel = 'smart'
const PAYMENT_META_PARAMETER_VARIABLE_CATEGORIES = new Set([
  'contact',
  'custom',
  'variable',
  'payment',
  'conversation',
  'automation'
])
const PAYMENT_META_PARAMETER_VARIABLE_LABELS: Record<string, string> = {
  contact: 'Contacto',
  custom: 'Campos personalizados',
  variable: 'Campos del sistema',
  payment: 'Pago',
  conversation: 'Conversación',
  automation: 'Automatización'
}
const toPaymentMetaParameterVariable = (variable: FlowVariable): MetaParameterVariable => ({
  fieldId: variable.fieldId,
  label: variable.label,
  category: variable.category,
  categoryLabel: variable.categoryLabel || PAYMENT_META_PARAMETER_VARIABLE_LABELS[variable.category]
})
const cleanPaymentMetaParameterString = (value: unknown) => String(value ?? '').trim()
const normalizePaymentMetaPurchaseEventParameter = (
  parameter?: Partial<PaymentMetaPurchaseEventParameter> | null
): PaymentMetaPurchaseEventParameter => ({
  id: cleanPaymentMetaParameterString(parameter?.id) || `payment-meta-param-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  key: cleanPaymentMetaParameterString(parameter?.key)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64),
  value: cleanPaymentMetaParameterString(parameter?.value)
})
const createPaymentMetaPurchaseEventParameter = (): PaymentMetaPurchaseEventParameter => ({
  id: `payment-meta-param-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  key: '',
  value: ''
})
const conektaModeLabels: Record<StripeModeId, { title: string; description: string; publicPlaceholder: string; privatePlaceholder: string }> = {
  test: {
    title: 'Modo prueba',
    description: 'Para validar tokenización, tarjetas de prueba y cargos sin dinero real.',
    publicPlaceholder: 'key_...',
    privatePlaceholder: 'key_...'
  },
  live: {
    title: 'Modo en vivo',
    description: 'Para aceptar pagos reales con tu cuenta de Conekta.',
    publicPlaceholder: 'key_...',
    privatePlaceholder: 'key_...'
  }
}

const clipModeLabels: Record<StripeModeId, { title: string; description: string; apiKeyPlaceholder: string }> = {
  test: {
    title: 'Modo prueba',
    description: 'Para montar el SDK de Checkout Transparente de CLIP sin mover dinero real.',
    apiKeyPlaceholder: 'test_...'
  },
  live: {
    title: 'Modo en vivo',
    description: 'Para aceptar pagos reales con el SDK de Checkout Transparente de CLIP.',
    apiKeyPlaceholder: 'Clave API en vivo'
  }
}
const rebillModeLabels: Record<StripeModeId, { title: string; description: string; publicPlaceholder: string; secretPlaceholder: string }> = {
  test: {
    title: 'Modo prueba',
    description: 'Para montar el checkout sandbox de Rebill sin mover dinero real.',
    publicPlaceholder: 'pk_...',
    secretPlaceholder: 'sk_...'
  },
  live: {
    title: 'Modo en vivo',
    description: 'Para aceptar pagos reales con tu organizacion productiva de Rebill.',
    publicPlaceholder: 'pk_...',
    secretPlaceholder: 'sk_...'
  }
}
const looksLikeClipSdkApiKey = (value: string) => {
  const clean = value.trim()
  if (!clean || clean.includes('•') || clean.includes('*')) return false
  return /^(test|live)_[a-z0-9-]{16,}$/i.test(clean) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)
}
const looksLikeRebillPublicKey = (value: string) => /^pk_[a-z0-9_ -]{16,}$/i.test(value.trim())
const looksLikeRebillSecretKey = (value: string) => /^sk_[a-z0-9_ -]{16,}$/i.test(value.trim())
const parseBooleanLike = (value: unknown, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback

  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)
}
const createDefaultPaymentMetaPurchaseEventConfig = (): PaymentMetaPurchaseEventConfig => ({
  enabled: false,
  channel: PAYMENT_META_DEFAULT_EVENT_CHANNEL,
  eventName: PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME,
  parameters: {
    sendValue: true,
    usePaymentPlanTotalValue: true,
    value: '',
    predictedLtv: '',
    custom: []
  }
})

const normalizePaymentMetaPurchaseEventParameters = (
  value?: Partial<PaymentMetaPurchaseEventParameters> | null
): PaymentMetaPurchaseEventParameters => {
  const source = value || {}
  const custom = Array.isArray(source.custom)
    ? source.custom
      .map(normalizePaymentMetaPurchaseEventParameter)
      .slice(0, 12)
    : []

  return {
    sendValue: parseBooleanLike(source.sendValue, true),
    usePaymentPlanTotalValue: parseBooleanLike(source.usePaymentPlanTotalValue, true),
    value: cleanPaymentMetaParameterString(source.value),
    predictedLtv: cleanPaymentMetaParameterString(source.predictedLtv),
    custom
  }
}

const normalizePaymentMetaPurchaseEventConfig = (
  value?: Partial<PaymentMetaPurchaseEventConfig> | null
): PaymentMetaPurchaseEventConfig => {
  const rawChannel = String(value?.channel || '').trim().toLowerCase()
  const channel: PaymentMetaPurchaseEventChannel = rawChannel === 'site' || rawChannel === 'whatsapp' || rawChannel === 'smart'
    ? rawChannel
    : PAYMENT_META_DEFAULT_EVENT_CHANNEL

  return {
    enabled: Boolean(value?.enabled),
    channel,
    eventName: PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME,
    parameters: normalizePaymentMetaPurchaseEventParameters(value?.parameters)
  }
}

const taxCountryOptions = [
  { value: 'MX', label: 'México · IVA 16%' },
  { value: 'CO', label: 'Colombia · IVA 19%' },
  { value: 'CL', label: 'Chile · IVA 19%' },
  { value: 'US', label: 'Estados Unidos · automático 0%' }
]

const isPaymentsSectionId = (value?: string): value is PaymentsSectionId =>
  sectionIds.includes(value as PaymentsSectionId)

const isPaymentGatewayId = (value?: string): value is PaymentGatewayId =>
  gatewayIds.includes(value as PaymentGatewayId)

const getPaymentRouteSegment = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const paymentsIndex = segments.indexOf('payments')
  return paymentsIndex >= 0 ? segments[paymentsIndex + 1] : ''
}

const getInitialSection = (pathname: string): PaymentsSectionId => {
  const segment = getPaymentRouteSegment(pathname)
  if (isPaymentsSectionId(segment)) return segment
  if (isPaymentGatewayId(segment)) return 'gateways'
  return 'checkout'
}

const RECEIPT_PREVIEW_LOADING_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Previsualizando comprobante...</title>
    <style>
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: Canvas;
        color: CanvasText;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        gap: 12px;
        justify-items: center;
        padding: 24px;
        text-align: center;
      }
      i {
        width: 40px;
        aspect-ratio: 1;
        border: 3px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-top-color: CanvasText;
        border-radius: 999px;
        animation: spin .8s linear infinite;
      }
      strong {
        font-size: 16px;
        letter-spacing: 0;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        i { animation: none; }
      }
    </style>
  </head>
  <body>
    <main aria-live="polite" aria-busy="true">
      <i aria-hidden="true"></i>
      <strong>Preparando vista previa</strong>
    </main>
  </body>
</html>`

const writeReceiptPreviewLoadingPage = (previewWindow: Window) => {
  previewWindow.document.open()
  previewWindow.document.write(RECEIPT_PREVIEW_LOADING_HTML)
  previewWindow.document.close()
}

function formatCompactMoney(value: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(value)
}

function getTaxRateValue(taxes: PaymentTaxSettings) {
  const parsed = Number(taxes.rateValue)
  return Number.isFinite(parsed) ? parsed : 0
}

function calculatePreviewTax(baseAmount: number, taxes: PaymentTaxSettings) {
  if (!taxes.enabled) return 0
  const rateValue = getTaxRateValue(taxes)
  if (rateValue <= 0) return 0

  if (taxes.calculationMode === 'inclusive') {
    return Math.round(baseAmount - (baseAmount / (1 + rateValue / 100)))
  }

  return Math.round(baseAmount * (rateValue / 100))
}

const channelOptions = [
  { value: 'whatsapp', label: 'WhatsApp API' },
  { value: 'whatsapp_qr', label: 'WhatsApp QR solo' },
  { value: 'email', label: 'Correo electrónico' },
  { value: 'both', label: 'WhatsApp API y correo electrónico' }
]

const channelLabelById: Record<PaymentAutomationSettings['reminderChannel'], string> = {
  whatsapp: 'WhatsApp API',
  whatsapp_qr: 'WhatsApp QR solo',
  email: 'correo electrónico',
  both: 'WhatsApp API y correo electrónico'
}

const afterPaymentActionLabelById: Record<PaymentAutomationSettings['afterPaymentAction'], string> = {
  send_receipt: 'Enviar comprobante',
  start_automation: 'Iniciar automatización',
  tag_contact: 'Etiquetar contacto',
  none: 'No hacer nada'
}

const paymentAutomationTemplateDefaults: Record<PaymentAutomationTemplateKind, {
  label: string
  defaultName: string
  defaultLanguage: string
  defaultMessageText: string
  contentModeKey: keyof PaymentAutomationSettings
  messageTextKey: keyof PaymentAutomationSettings
  templateIdKey: keyof PaymentAutomationSettings
  templateNameKey: keyof PaymentAutomationSettings
  templateLanguageKey: keyof PaymentAutomationSettings
}> = {
  reminder: {
    label: 'Recordatorio de pago',
    defaultName: 'recordatorio_pago_pendiente',
    defaultLanguage: 'es_MX',
    defaultMessageText: 'Hola {{contact.first_name}}, tienes un pago pendiente de {{payment.amount}} por {{payment.product}}. Puedes completarlo aquí: {{payment.url}}',
    contentModeKey: 'reminderContentMode',
    messageTextKey: 'reminderMessageText',
    templateIdKey: 'reminderTemplateId',
    templateNameKey: 'reminderTemplateName',
    templateLanguageKey: 'reminderTemplateLanguage'
  },
  receipt: {
    label: 'Comprobante de pago',
    defaultName: 'comprobante_pago_recibido',
    defaultLanguage: 'es_MX',
    defaultMessageText: 'Hola {{contact.first_name}}, recibimos tu pago de {{payment.amount}} por {{payment.product}}. Puedes descargar tu comprobante aquí: {{payment.receipt_url}}',
    contentModeKey: 'receiptContentMode',
    messageTextKey: 'receiptMessageText',
    templateIdKey: 'receiptTemplateId',
    templateNameKey: 'receiptTemplateName',
    templateLanguageKey: 'receiptTemplateLanguage'
  },
  failed: {
    label: 'Cobro fallido',
    defaultName: 'pago_fallido_reintento',
    defaultLanguage: 'es_MX',
    defaultMessageText: 'Hola {{contact.first_name}}, no pudimos procesar tu pago de {{payment.amount}} por {{payment.product}}. Puedes intentarlo de nuevo aquí: {{payment.url}}',
    contentModeKey: 'failedPaymentContentMode',
    messageTextKey: 'failedPaymentMessageText',
    templateIdKey: 'failedPaymentTemplateId',
    templateNameKey: 'failedPaymentTemplateName',
    templateLanguageKey: 'failedPaymentTemplateLanguage'
  }
}

const channelUsesWhatsApp = (channel: PaymentAutomationSettings['reminderChannel']) => (
  channel === 'whatsapp' || channel === 'whatsapp_qr' || channel === 'both'
)

const channelUsesWhatsappQrOnly = (channel: PaymentAutomationSettings['reminderChannel']) => channel === 'whatsapp_qr'

const defaultWhatsAppAvailability: WhatsAppConnectionAvailability = {
  hasApiConnected: false,
  hasQrConnected: false,
  canShowQrFallbackSwitch: false
}

const invoiceTemplateClassById: Record<PaymentInvoiceTemplateId, string> = {
  classic: 'documentThemeClassic',
  executive: 'documentThemeExecutive',
  accent: 'documentThemeAccent',
  ledger: 'documentThemeLedger'
}

const getStripeModeCredentialsFromConfig = (config?: StripePaymentConfig | null): Record<StripeModeId, StripeModeCredentials> => {
  if (!config) return emptyStripeModeCredentials

  const nextCredentials: Record<StripeModeId, StripeModeCredentials> = {
    test: { ...emptyStripeModeCredentials.test },
    live: { ...emptyStripeModeCredentials.live }
  }

  stripeModeIds.forEach((mode) => {
    const modeConfig = config.manualModes?.[mode]
    nextCredentials[mode] = {
      publishableKey: modeConfig?.publishableKey || (config.mode === mode ? config.publishableKey : ''),
      secretKey: modeConfig?.secretKeyPreview || (config.mode === mode ? config.secretKeyPreview || '' : ''),
      webhookSecret: modeConfig?.webhookSecretPreview || (config.mode === mode ? config.webhookSecretPreview || '' : '')
    }
  })

  return nextCredentials
}

const getConektaModeCredentialsFromConfig = (config?: ConektaPaymentConfig | null): Record<StripeModeId, ConektaModeCredentials> => {
  if (!config) return emptyConektaModeCredentials

  const nextCredentials: Record<StripeModeId, ConektaModeCredentials> = {
    test: { ...emptyConektaModeCredentials.test },
    live: { ...emptyConektaModeCredentials.live }
  }

  stripeModeIds.forEach((mode) => {
    const modeConfig = config.manualModes?.[mode]
    nextCredentials[mode] = {
      publicKey: modeConfig?.publicKey || (config.mode === mode ? config.publicKey : ''),
      privateKey: modeConfig?.privateKeyPreview || (config.mode === mode ? config.privateKeyPreview || '' : '')
    }
  })

  return nextCredentials
}

const getClipModeCredentialsFromConfig = (config?: ClipPaymentConfig | null): Record<StripeModeId, ClipModeCredentials> => {
  if (!config) return emptyClipModeCredentials

  const nextCredentials: Record<StripeModeId, ClipModeCredentials> = {
    test: { ...emptyClipModeCredentials.test },
    live: { ...emptyClipModeCredentials.live }
  }

  stripeModeIds.forEach((mode) => {
    const modeConfig = config.modeConnections?.[mode]
    nextCredentials[mode] = {
      apiKey: modeConfig?.apiKeyPreview || (config.mode === mode ? config.apiKeyPreview || '' : ''),
      accountLabel: modeConfig?.accountLabel || (config.mode === mode ? config.accountLabel || '' : '')
    }
  })

  return nextCredentials
}

const getRebillModeCredentialsFromConfig = (config?: RebillPaymentConfig | null): Record<StripeModeId, RebillModeCredentials> => {
  if (!config) return emptyRebillModeCredentials

  const nextCredentials: Record<StripeModeId, RebillModeCredentials> = {
    test: { ...emptyRebillModeCredentials.test },
    live: { ...emptyRebillModeCredentials.live }
  }

  stripeModeIds.forEach((mode) => {
    const modeConfig = config.modeConnections?.[mode]
    nextCredentials[mode] = {
      publicKey: modeConfig?.publicKey || (config.mode === mode ? config.publicKey || '' : ''),
      secretKey: modeConfig?.secretKeyPreview || (config.mode === mode ? config.secretKeyPreview || '' : '')
    }
  })

  return nextCredentials
}

const getMercadoPagoSubscriptionTestCredentialsFromConfig = (config?: MercadoPagoPaymentConfig | null): MercadoPagoSubscriptionTestCredentials => ({
  publicKey: config?.subscriptionTestCredentials?.publicKey || '',
  accessToken: config?.subscriptionTestCredentials?.accessTokenPreview || '',
  webhookSecret: config?.subscriptionTestCredentials?.webhookSecretPreview || ''
})

const applyBusinessProfileToCheckout = (
  checkout: PaymentCheckoutSettings,
  profile: AccountBusinessProfile
): PaymentCheckoutSettings => {
  if (checkout.useBusinessProfile === false) return checkout

  return {
    ...checkout,
    logoUrl: profile.logoUrl || checkout.logoUrl,
    supportEmail: profile.email || checkout.supportEmail,
    supportPhone: profile.phone || checkout.supportPhone
  }
}

const applyBusinessProfileToReceipt = (
  receipt: PaymentReceiptSettings,
  profile: AccountBusinessProfile
): PaymentReceiptSettings => {
  if (receipt.useBusinessProfile === false) return receipt

  return {
    ...receipt,
    logoUrl: profile.logoUrl || receipt.logoUrl,
    businessName: profile.name || receipt.businessName,
    businessEmail: profile.email || receipt.businessEmail,
    businessPhone: profile.phone || receipt.businessPhone,
    businessAddress: profile.address || receipt.businessAddress,
    businessWebsite: profile.website || receipt.businessWebsite,
    terms: profile.terms || receipt.terms
  }
}

export const PaymentsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast, showConfirm } = useNotification()
  const { user } = useAuth()
  const { labels } = useLabels()
  const customerLabel = labels.customer?.trim() || DEFAULT_CRM_LABELS.customer
  const customerLowerLabel = formatCrmLabelLower(labels.customer, DEFAULT_CRM_LABELS.customer)
  const customerWithArticle = formatCrmLabelWithDefiniteArticle(labels.customer, DEFAULT_CRM_LABELS.customer)
  const customerWithPlainArticle = formatCrmLabelWithDefiniteArticle(labels.customer, DEFAULT_CRM_LABELS.customer, 'none')
  const customersLowerLabel = formatCrmLabelLower(labels.customers, DEFAULT_CRM_LABELS.customers)
  const { connected: highLevelConnected, loading: loadingHighLevelConnection } = useHighLevelConnected()
  const hasPaymentCheckoutAccess = canAccessPaymentCheckout(user)
  const hasPaymentAutomationsAccess = canAccessPaymentAutomations(user)
  const hasPaymentGatewaysAccess = canAccessPaymentGateways(user)
  const [accountCurrency] = useAccountCurrency()
  const [accountBusinessProfileRaw] = useAppConfig<AccountBusinessProfile>(
    ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY,
    defaultAccountBusinessProfile
  )

  const [activeSection, setActiveSection] = useState<PaymentsSectionId>(() => getInitialSection(location.pathname))
  const defaultSection: PaymentsSectionId = hasPaymentCheckoutAccess ? 'checkout' : 'receipt'
  const visibleSectionItems = useMemo(() => sectionItems.filter((item) => {
    if (item.id === 'checkout') return hasPaymentCheckoutAccess
    if (item.id === 'automations') return hasPaymentAutomationsAccess
    if (item.id === 'gateways') return hasPaymentGatewaysAccess
    return true
  }), [hasPaymentAutomationsAccess, hasPaymentCheckoutAccess, hasPaymentGatewaysAccess])

  useEffect(() => {
    if (visibleSectionItems.some((item) => item.id === activeSection)) return
    setActiveSection(defaultSection)
    navigate(defaultSection === 'checkout' ? '/settings/payments' : `/settings/payments/${defaultSection}`, { replace: true })
  }, [activeSection, defaultSection, navigate, visibleSectionItems])
  const [settings, setSettings] = useState<PaymentSettings>(defaultPaymentSettings)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [savingPaymentMode, setSavingPaymentMode] = useState(false)
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle')
  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [transferInfoUrl, setTransferInfoUrl] = useState('')
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [stripeConfig, setStripeConfig] = useState<StripePaymentConfig | null>(null)
  const [stripeManualCredentials, setStripeManualCredentials] = useState<Record<StripeModeId, StripeModeCredentials>>(emptyStripeModeCredentials)
  const [loadingStripeConfig, setLoadingStripeConfig] = useState(false)
  const [savingHighLevelConfig, setSavingHighLevelConfig] = useState(false)
  const [savingStripeMode, setSavingStripeMode] = useState<StripeModeId | null>(null)
  const [stripeConnectionFailed, setStripeConnectionFailed] = useState(false)
  const [disconnectingStripeMode, setDisconnectingStripeMode] = useState<StripeModeId | null>(null)
  const [conektaConfig, setConektaConfig] = useState<ConektaPaymentConfig | null>(null)
  const [conektaManualCredentials, setConektaManualCredentials] = useState<Record<StripeModeId, ConektaModeCredentials>>(emptyConektaModeCredentials)
  const [loadingConektaConfig, setLoadingConektaConfig] = useState(false)
  const [savingConektaMode, setSavingConektaMode] = useState<StripeModeId | null>(null)
  const [conektaConnectionFailed, setConektaConnectionFailed] = useState(false)
  const [disconnectingConektaMode, setDisconnectingConektaMode] = useState<StripeModeId | null>(null)
  const [clipConfig, setClipConfig] = useState<ClipPaymentConfig | null>(null)
  const [clipManualCredentials, setClipManualCredentials] = useState<Record<StripeModeId, ClipModeCredentials>>(emptyClipModeCredentials)
  const [loadingClipConfig, setLoadingClipConfig] = useState(false)
  const [savingClipMode, setSavingClipMode] = useState<StripeModeId | null>(null)
  const [testingClipMode, setTestingClipMode] = useState<StripeModeId | null>(null)
  const [clipConnectionFailed, setClipConnectionFailed] = useState(false)
  const [disconnectingClipMode, setDisconnectingClipMode] = useState<StripeModeId | null>(null)
  const [rebillConfig, setRebillConfig] = useState<RebillPaymentConfig | null>(null)
  const [rebillManualCredentials, setRebillManualCredentials] = useState<Record<StripeModeId, RebillModeCredentials>>(emptyRebillModeCredentials)
  const [loadingRebillConfig, setLoadingRebillConfig] = useState(false)
  const [savingRebillMode, setSavingRebillMode] = useState<StripeModeId | null>(null)
  const [testingRebillMode, setTestingRebillMode] = useState<StripeModeId | null>(null)
  const [testingGigstackMode, setTestingGigstackMode] = useState<PaymentModeId | null>(null)
  const [syncingGigstackFiscal, setSyncingGigstackFiscal] = useState(false)
  const [rebillConnectionFailed, setRebillConnectionFailed] = useState(false)
  const [disconnectingRebillMode, setDisconnectingRebillMode] = useState<StripeModeId | null>(null)
  const [mercadoPagoConfig, setMercadoPagoConfig] = useState<MercadoPagoPaymentConfig | null>(null)
  const [mercadoPagoSubscriptionTestCredentials, setMercadoPagoSubscriptionTestCredentials] = useState<MercadoPagoSubscriptionTestCredentials>(emptyMercadoPagoSubscriptionTestCredentials)
  const [loadingMercadoPagoConfig, setLoadingMercadoPagoConfig] = useState(false)
  const [connectingMercadoPago, setConnectingMercadoPago] = useState(false)
  const [mercadoPagoSubscriptionTestModalOpen, setMercadoPagoSubscriptionTestModalOpen] = useState(false)
  const [savingMercadoPagoSubscriptionTestCredentials, setSavingMercadoPagoSubscriptionTestCredentials] = useState(false)
  const [disconnectingMercadoPago, setDisconnectingMercadoPago] = useState(false)
  const [clearingMercadoPagoSubscriptionTestCredentials, setClearingMercadoPagoSubscriptionTestCredentials] = useState(false)
  const [uploadingCheckoutLogo, setUploadingCheckoutLogo] = useState(false)
  const [checkoutLogoUploadProgress, setCheckoutLogoUploadProgress] = useState(0)
  const [uploadingReceiptLogo, setUploadingReceiptLogo] = useState(false)
  const [receiptLogoUploadProgress, setReceiptLogoUploadProgress] = useState(0)
  const [previewingReceipt, setPreviewingReceipt] = useState(false)
  const [whatsappAvailability, setWhatsappAvailability] = useState<WhatsAppConnectionAvailability>(defaultWhatsAppAvailability)
  const [paymentWhatsappTemplates, setPaymentWhatsappTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [loadingPaymentWhatsappTemplates, setLoadingPaymentWhatsappTemplates] = useState(false)
  const [paymentMetaPurchaseEventConfigRaw, setPaymentMetaPurchaseEventConfig] = useAppConfig(
    'meta_payment_purchase_event_config',
    createDefaultPaymentMetaPurchaseEventConfig()
  )
  const [paymentMetaParamsOpen, setPaymentMetaParamsOpen] = useState(false)
  const [loadedMetaVariables, setLoadedMetaVariables] = useState<FlowVariable[]>(BASE_VARIABLES)
  const checkoutLogoInputRef = useRef<HTMLInputElement>(null)
  const receiptLogoInputRef = useRef<HTMLInputElement>(null)
  const latestSettingsRef = useRef(settings)
  const loadedSettingsRef = useRef(false)
  const lastSavedSettingsRef = useRef(JSON.stringify(defaultPaymentSettings))
  const gatewayConfigLoadedRef = useRef(new Set<PaymentGatewayId>())
  const paymentAutomationsPanelLoadedRef = useRef(false)
  const paymentMetaVariablesLoadedRef = useRef(false)

  const checkout = settings.checkout
  const receipt = settings.receipt
  const automations = settings.automations
  const taxes = settings.taxes
  const accountBusinessProfile = useMemo(
    () => normalizeAccountBusinessProfile(accountBusinessProfileRaw),
    [accountBusinessProfileRaw]
  )
  const hasBusinessProfile = useMemo(
    () => hasAccountBusinessProfileDetails(accountBusinessProfile),
    [accountBusinessProfile]
  )
  const effectiveCheckout = useMemo(
    () => applyBusinessProfileToCheckout(checkout, accountBusinessProfile),
    [accountBusinessProfile, checkout]
  )
  const effectiveReceipt = useMemo(
    () => applyBusinessProfileToReceipt(receipt, accountBusinessProfile),
    [accountBusinessProfile, receipt]
  )
  const paymentMode: PaymentModeId = settings.paymentMode === 'test' ? 'test' : 'live'
  const paymentModeCopy = paymentModeLabels[paymentMode]
  const routeSegment = getPaymentRouteSegment(location.pathname)
  const activeGatewayRoute = isPaymentGatewayId(routeSegment) ? routeSegment : null
  const paymentMetaPurchaseEventConfig = useMemo(
    () => normalizePaymentMetaPurchaseEventConfig(paymentMetaPurchaseEventConfigRaw),
    [paymentMetaPurchaseEventConfigRaw]
  )
  const paymentMetaPurchaseEventHasParameters = useMemo(() => {
    const parameters = paymentMetaPurchaseEventConfig.parameters
    return Boolean(
      cleanPaymentMetaParameterString(parameters.value) ||
      cleanPaymentMetaParameterString(parameters.predictedLtv) ||
      parameters.custom.some(parameter => parameter.key || parameter.value)
    )
  }, [paymentMetaPurchaseEventConfig.parameters])
  const paymentMetaParameterVariables = useMemo(() => {
    const variables = loadedMetaVariables
      .filter(variable => PAYMENT_META_PARAMETER_VARIABLE_CATEGORIES.has(variable.category))
      .map(toPaymentMetaParameterVariable)
    const seen = new Set<string>()
    return variables.filter((variable) => {
      if (!variable.fieldId || seen.has(variable.fieldId)) return false
      seen.add(variable.fieldId)
      return true
    })
  }, [loadedMetaVariables])

  useEffect(() => {
    latestSettingsRef.current = settings
  }, [settings])

  useEffect(() => {
    if (!loadedSettingsRef.current) return

    setSettings((current) => {
      const nextCheckout = applyBusinessProfileToCheckout(current.checkout, accountBusinessProfile)
      const nextReceipt = applyBusinessProfileToReceipt(current.receipt, accountBusinessProfile)
      if (
        JSON.stringify(nextCheckout) === JSON.stringify(current.checkout) &&
        JSON.stringify(nextReceipt) === JSON.stringify(current.receipt)
      ) {
        return current
      }
      return {
        ...current,
        checkout: nextCheckout,
        receipt: nextReceipt
      }
    })
  }, [accountBusinessProfile])

  useEffect(() => {
    if (activeSection !== 'meta' || paymentMetaVariablesLoadedRef.current) return
    let cancelled = false
    void loadAllVariables().then((variables) => {
      if (!cancelled) {
        setLoadedMetaVariables(variables)
        paymentMetaVariablesLoadedRef.current = true
      }
    })
    return () => { cancelled = true }
  }, [activeSection])

  useEffect(() => {
    const nextSection = getInitialSection(location.pathname)
    setActiveSection(nextSection)
  }, [location.pathname])

  useEffect(() => {
    const controller = new AbortController()
    void loadPaymentSettings(controller.signal)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (activeSection !== 'automations' || paymentAutomationsPanelLoadedRef.current) return
    const controller = new AbortController()
    void Promise.allSettled([
      loadWhatsAppAvailability(controller.signal),
      loadPaymentWhatsappTemplates(controller.signal)
    ]).then(() => {
      if (!controller.signal.aborted) paymentAutomationsPanelLoadedRef.current = true
    })
    return () => controller.abort()
  }, [activeSection])

  useEffect(() => {
    if (activeSection !== 'gateways') return
    if (activeGatewayRoute === 'highlevel' && loadingHighLevelConnection) return
    const targetGateways: PaymentGatewayId[] = activeGatewayRoute
      ? [activeGatewayRoute]
      : ['stripe', 'conekta', 'mercadopago', 'clip', 'rebill']
    const controllers: AbortController[] = []
    const loadGateway = (gateway: PaymentGatewayId) => {
      if (gatewayConfigLoadedRef.current.has(gateway)) return
      if (gateway === 'highlevel' && !highLevelConnected) return
      const controller = new AbortController()
      controllers.push(controller)
      if (gateway === 'highlevel') void loadHighLevelPaymentConfig(controller.signal)
      if (gateway === 'stripe') void loadStripeConfig(controller.signal)
      if (gateway === 'conekta') void loadConektaConfig(controller.signal)
      if (gateway === 'mercadopago') void loadMercadoPagoConfig(controller.signal)
      if (gateway === 'clip') void loadClipConfig(controller.signal)
      if (gateway === 'rebill') void loadRebillConfig(controller.signal)
    }
    targetGateways.forEach(loadGateway)
    return () => controllers.forEach(controller => controller.abort())
  }, [activeGatewayRoute, activeSection, highLevelConnected, loadingHighLevelConnection])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const status = params.get('mercadopago_connect')
    if (!status) return

    const message = params.get('mercadopago_message') || ''
    const handoffToken = params.get('mercadopago_handoff_token') || ''
    const finishMercadoPagoReturn = async () => {
      setActiveSection('gateways')

      if (status === 'success' || status === 'warning') {
        setLoadingMercadoPagoConfig(true)
        try {
          const config = await mercadoPagoPaymentsService.syncConnect({ handoffToken })
          applyMercadoPagoConfig(config)
          invalidateIntegrationsStatus()
          if (status === 'success') {
            showToast('success', 'Mercado Pago conectado', message || 'La cuenta quedó lista para crear cobros desde Ristak.')
          } else {
            showToast('warning', 'Mercado Pago conectado con pendiente', message || 'La cuenta conectó, pero el webhook necesita revisión.')
          }
        } catch (error: any) {
          showToast('warning', 'Mercado Pago autorizó, falta guardar conexión', error.message || 'Vuelve a conectar Mercado Pago desde esta pantalla.')
          await loadMercadoPagoConfig()
        } finally {
          setLoadingMercadoPagoConfig(false)
        }
      } else {
        showToast('error', 'No se pudo conectar Mercado Pago', message || 'Intenta conectar la cuenta de nuevo.')
        await loadMercadoPagoConfig()
      }

      navigate('/settings/payments/mercadopago', { replace: true })
    }

    void finishMercadoPagoReturn()
  }, [location.search, navigate, showToast])

  const stripeGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'stripe',
    name: 'Stripe',
    logo: 'stripe',
    description: stripeConfig?.configured
      ? `Listo para cobrar en ${stripeConfig.mode === 'live' ? 'modo en vivo' : 'modo prueba'}.`
      : 'Configura Stripe con las llaves de tu propia cuenta.',
    status: stripeConfig?.configured ? 'connected' : 'available'
  }), [stripeConfig?.configured, stripeConfig?.mode])

  const conektaGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'conekta',
    name: 'Conekta',
    logo: 'conekta',
    description: conektaConfig?.configured
      ? `Listo para cobrar en ${conektaConfig.mode === 'live' ? 'modo en vivo' : 'modo prueba'}.`
      : 'Configura Conekta para links de pago y cobros con tarjetas guardadas.',
    status: conektaConfig?.configured ? 'connected' : 'available'
  }), [conektaConfig?.configured, conektaConfig?.mode])

  const clipGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'clip',
    name: 'CLIP',
    logo: 'clip',
    description: clipConfig?.configured
      ? `Listo para cobros en MXN con Checkout Transparente en ${clipConfig.mode === 'live' ? 'modo en vivo' : 'modo prueba'}.`
      : 'Configura CLIP para pagos únicos y pago inicial de suscripciones internas.',
    status: clipConfig?.configured ? 'connected' : 'available'
  }), [clipConfig?.configured, clipConfig?.mode])

  const rebillGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'rebill',
    name: 'Rebill',
    logo: 'rebill',
    description: rebillConfig?.configured
      ? `Listo para checkout Rebill en ${rebillConfig.mode === 'live' ? 'modo en vivo' : 'modo prueba'}.`
      : 'Configura Rebill para pagos únicos con checkout embebido y webhooks automáticos.',
    status: rebillConfig?.configured ? 'connected' : 'available'
  }), [rebillConfig?.configured, rebillConfig?.mode])

  const gatewayOptions: PaymentGatewayOption[] = [
    ...(highLevelConnected
      ? [{
        id: 'highlevel' as const,
        name: 'GoHighLevel',
        description: 'Usa la conexión activa para cobros, links, domiciliación y parcialidades.',
        status: 'connected' as const
      }]
      : []),
    stripeGatewayOption,
    conektaGatewayOption,
    {
      id: 'mercadopago',
      name: 'Mercado Pago',
      logo: 'mercadopago',
      description: mercadoPagoConfig?.configured
        ? `Listo para links y suscripciones en ${mercadoPagoConfig.mode === 'live' ? 'modo en vivo' : 'modo prueba'}.`
        : `Conecta Mercado Pago para usar ${paymentMode === 'live' ? 'cobros reales' : 'tarjetas de prueba en links de pago'}.`,
      status: mercadoPagoConfig?.configured ? 'connected' : 'available'
    },
    clipGatewayOption,
    rebillGatewayOption
  ]

  const mercadoPagoWebhookEndpoints = mercadoPagoConfig?.webhookEndpoints || []
  const clipWebhookEndpoints = clipConfig?.webhookEndpoints || []
  const stripeConnected = Boolean(stripeConfig?.configured)
  const conektaConnected = Boolean(conektaConfig?.configured)
  const mercadoPagoConnected = Boolean(mercadoPagoConfig?.configured)
  const clipConnected = Boolean(clipConfig?.configured)
  const rebillConnected = Boolean(rebillConfig?.configured)
  const stripeModeIsComplete = (mode: StripeModeId) => {
    const values = stripeManualCredentials[mode]
    return Boolean(values.publishableKey.trim() && values.secretKey.trim())
  }
  const stripeModeIsSaved = (mode: StripeModeId) => Boolean(
    stripeConfig?.manualModes?.[mode]?.configured ||
    (stripeConfig?.configured && stripeConfig.mode === mode)
  )
  const stripeModeCanSave = (mode: StripeModeId) => stripeModeIsComplete(mode)
  const stripeActiveModeConfigured = stripeModeIsSaved(paymentMode)
  const stripeConfigurationStatus = stripeConnectionFailed
    ? 'connection_failed'
    : stripeConfig?.configurationStatus || (stripeConnected ? 'configured_manually' : 'not_configured')
  const stripeStatusBadge = (() => {
    if (loadingStripeConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (stripeConfigurationStatus === 'connection_failed') return { label: 'Conexión fallida', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    if (stripeActiveModeConfigured) return { label: 'Configurado', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    if (stripeConfigurationStatus === 'disconnected') return { label: 'Desconectado', variant: 'neutral' as const, icon: <Unplug size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const conektaModeIsComplete = (mode: StripeModeId) => {
    const values = conektaManualCredentials[mode]
    return Boolean(values.publicKey.trim() && values.privateKey.trim())
  }
  const conektaModeIsSaved = (mode: StripeModeId) => Boolean(
    conektaConfig?.manualModes?.[mode]?.configured ||
    (conektaConfig?.configured && conektaConfig.mode === mode)
  )
  const conektaModeCanSave = (mode: StripeModeId) => conektaModeIsComplete(mode)
  const conektaActiveModeConfigured = conektaModeIsSaved(paymentMode)
  const conektaConfigurationStatus = conektaConnectionFailed
    ? 'connection_failed'
    : conektaConnected ? 'configured_manually' : 'not_configured'
  const conektaStatusBadge = (() => {
    if (loadingConektaConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (conektaConfigurationStatus === 'connection_failed') return { label: 'Conexión fallida', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    if (conektaActiveModeConfigured) return { label: 'Configurado', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const clipModeIsComplete = (mode: StripeModeId) => {
    const values = clipManualCredentials[mode]
    return Boolean(values.apiKey.trim() || looksLikeClipSdkApiKey(values.accountLabel))
  }
  const clipModeIsSaved = (mode: StripeModeId) => Boolean(
    clipConfig?.modeConnections?.[mode]?.configured ||
    (clipConfig?.configured && clipConfig.mode === mode)
  )
  const clipModeCanSave = (mode: StripeModeId) => clipModeIsComplete(mode)
  const clipActiveModeConfigured = clipModeIsSaved(paymentMode)
  const clipConfigurationStatus = clipConnectionFailed
    ? 'connection_failed'
    : clipConnected ? 'configured_manually' : 'not_configured'
  const clipStatusBadge = (() => {
    if (loadingClipConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (clipConfigurationStatus === 'connection_failed') return { label: 'Revisar clave', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    if (clipActiveModeConfigured) return { label: 'Configurado', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const rebillModeIsComplete = (mode: StripeModeId) => {
    const values = rebillManualCredentials[mode]
    return Boolean(values.publicKey.trim() && values.secretKey.trim())
  }
  const rebillModeIsSaved = (mode: StripeModeId) => Boolean(
    rebillConfig?.modeConnections?.[mode]?.configured ||
    (rebillConfig?.configured && rebillConfig.mode === mode)
  )
  const rebillModeCanSave = (mode: StripeModeId) => rebillModeIsComplete(mode)
  const rebillWebhookNeedsAttention = stripeModeIds.some((mode) => {
    if (!rebillModeIsSaved(mode)) return false
    const connection = rebillConfig?.modeConnections?.[mode]
    const status = String(connection?.webhookStatus || '').toLowerCase()
    return !connection?.webhookConfigured && ['pending_public_url', 'error'].includes(status)
  })
  const rebillWebhookAttentionStatus = stripeModeIds
    .map((mode) => rebillConfig?.modeConnections?.[mode])
    .find((connection) => {
      const status = String(connection?.webhookStatus || '').toLowerCase()
      return connection?.configured && !connection?.webhookConfigured && ['pending_public_url', 'error'].includes(status)
    })?.webhookStatus?.toLowerCase()
  const rebillActiveModeConfigured = rebillModeIsSaved(paymentMode)
  const rebillConfigurationStatus = rebillConnectionFailed
    ? 'connection_failed'
    : rebillConnected ? 'configured_manually' : 'not_configured'
  const rebillStatusBadge = (() => {
    if (loadingRebillConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (rebillConfigurationStatus === 'connection_failed') return { label: 'Revisar llaves', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    if (rebillActiveModeConfigured) return { label: 'Configurado', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const mercadoPagoModeIsConnected = (mode: PaymentModeId) => Boolean(
    mercadoPagoConfig?.modeConnections?.[mode]?.connected ||
    (mercadoPagoConnected && mercadoPagoConfig?.mode === mode)
  )
  const mercadoPagoStatusBadge = (() => {
    if (loadingMercadoPagoConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (mercadoPagoModeIsConnected(paymentMode)) return { label: 'Conectado', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    return { label: 'Listo para conectar', variant: 'info' as const, icon: <KeyRound size={14} /> }
  })()
  const mercadoPagoSubscriptionTestConfigured = Boolean(mercadoPagoConfig?.subscriptionTestCredentials?.configured)
  const mercadoPagoSubscriptionTestCanSave = Boolean(
    mercadoPagoSubscriptionTestCredentials.publicKey.trim() &&
    mercadoPagoSubscriptionTestCredentials.accessToken.trim() &&
    mercadoPagoSubscriptionTestCredentials.webhookSecret.trim()
  )
  const paymentWhatsappTemplateOptions = useMemo(() => {
    const options = Object.values(paymentAutomationTemplateDefaults).map((template) => ({
      value: template.defaultName,
      label: `Predeterminada · ${template.label}`
    }))
    const seen = new Set(options.map((option) => option.value))

    paymentWhatsappTemplates.forEach((template) => {
      const value = template.id || template.name
      if (!value || seen.has(value)) return
      seen.add(value)
      options.push({
        value,
        label: `${template.name}${template.language ? ` · ${template.language}` : ''}`
      })
    })

    return options
  }, [paymentWhatsappTemplates])

  const setCheckoutValue = <K extends keyof PaymentCheckoutSettings>(key: K, value: PaymentCheckoutSettings[K]) => {
    setSettings((current) => ({
      ...current,
      checkout: { ...current.checkout, [key]: value }
    }))
  }

  const setReceiptValue = <K extends keyof PaymentReceiptSettings>(key: K, value: PaymentReceiptSettings[K]) => {
    setSettings((current) => ({
      ...current,
      receipt: { ...current.receipt, [key]: value }
    }))
  }

  const patchReceiptValues = (patch: Partial<PaymentReceiptSettings>) => {
    setSettings((current) => ({
      ...current,
      receipt: { ...current.receipt, ...patch }
    }))
  }

  const setAutomationValue = <K extends keyof PaymentAutomationSettings>(key: K, value: PaymentAutomationSettings[K]) => {
    setSettings((current) => ({
      ...current,
      automations: { ...current.automations, [key]: value }
    }))
  }

  const patchAutomationValues = (patch: Partial<PaymentAutomationSettings>) => {
    setSettings((current) => ({
      ...current,
      automations: { ...current.automations, ...patch }
    }))
  }

  const setAutomationQrFallbackValue = (
    key: 'reminderQrFallbackEnabled' | 'receiptQrFallbackEnabled' | 'failedPaymentQrFallbackEnabled',
    value: boolean
  ) => {
    setAutomationValue(key, value)
  }

  const setTaxValue = <K extends keyof PaymentTaxSettings>(key: K, value: PaymentTaxSettings[K]) => {
    setSettings((current) => ({
      ...current,
      taxes: { ...current.taxes, [key]: value }
    }))
  }

  const patchTaxValues = (patch: Partial<PaymentTaxSettings>) => {
    setSettings((current) => ({
      ...current,
      taxes: { ...current.taxes, ...patch }
    }))
  }

  const handleGigstackTokenChange = (mode: PaymentModeId, value: string) => {
    if (mode === 'test') {
      patchTaxValues({
        gigstackTestApiToken: value,
        clearGigstackTestApiToken: false
      })
      return
    }
    patchTaxValues({
      gigstackLiveApiToken: value,
      clearGigstackLiveApiToken: false
    })
  }

  const handleTestGigstackConnection = async (mode: PaymentModeId) => {
    setTestingGigstackMode(mode)
    try {
      const token = mode === 'test' ? taxes.gigstackTestApiToken : taxes.gigstackLiveApiToken
      const result = await paymentSettingsService.testGigstackConnection(mode, token || '')
      showToast(
        'success',
        `${mode === 'test' ? 'Test' : 'Live'} conectado`,
        `Gigstack reconoció la llave correcta${result.keyIdSuffix ? ` · termina en ${result.keyIdSuffix}` : ''}. No se generó ninguna factura.`
      )
    } catch (error: any) {
      showToast('error', 'No se pudo validar Gigstack', error.message || 'Revisa que la API key corresponda al ambiente elegido.')
    } finally {
      setTestingGigstackMode(null)
    }
  }

  const handleDisconnectGigstackMode = (mode: PaymentModeId) => {
    const modeTitle = mode === 'test' ? 'Test' : 'Live'
    showConfirm(
      `Borrar API key ${modeTitle}`,
      `Ristak dejará de enviar pagos ${modeTitle} a Gigstack. La otra API key seguirá guardada.`,
      () => {
        if (mode === 'test') {
          patchTaxValues({
            gigstackTestApiToken: '',
            gigstackTestApiTokenPreview: '',
            hasGigstackTestApiToken: false,
            clearGigstackTestApiToken: true
          })
        } else {
          patchTaxValues({
            gigstackLiveApiToken: '',
            gigstackLiveApiTokenPreview: '',
            hasGigstackLiveApiToken: false,
            clearGigstackLiveApiToken: true
          })
        }
        showToast('success', `API key ${modeTitle} eliminada`, 'El cambio se guardará automáticamente.')
      },
      'Borrar API key',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const copyTextToClipboard = async (text: string) => {
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

  const handleCopyGatewayText = async (value: string, label: string, gatewayName: string) => {
    const copied = await copyTextToClipboard(value)
    if (copied) {
      showToast('success', `${label} copiado`, `Ya lo puedes pegar en ${gatewayName}.`)
    } else {
      showToast('error', 'No se pudo copiar', 'Selecciona el campo y copia el texto manualmente.')
    }
  }

  const renderWebhookEventGuide = (
    gatewayName: string,
    title: string,
    description: string,
    events: WebhookEventGuideItem[]
  ) => {
    const eventList = events.map((item) => item.event).join('\n')

    return (
      <div className={styles.webhookEventGuide}>
        <div className={styles.webhookEventGuideHeader}>
          <div>
            <strong>{title}</strong>
            <span>{description}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<Copy size={15} />}
            onClick={() => handleCopyGatewayText(eventList, 'Eventos', gatewayName)}
          >
            Copiar eventos
          </Button>
        </div>
        <div className={styles.webhookEventList}>
          {events.map((item) => (
            <div key={item.event} className={styles.webhookEventItem}>
              <code>{item.event}</code>
              <span>{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const handleCopyGigstackPortalUrl = async () => {
    const portalUrl = taxes.gigstackPortalUrl?.trim() || ''
    if (!portalUrl) {
      showToast('warning', 'Pega primero el link', 'Agrega la URL de tu portal de Gigstack para poder copiarla.')
      return
    }

    const copied = await copyTextToClipboard(portalUrl)
    if (copied) {
      showToast('success', 'Link copiado', 'Ya puedes mandarlo por WhatsApp, correo o donde te convenga.')
    } else {
      showToast('error', 'No se pudo copiar', 'Selecciona el campo y copia el link manualmente.')
    }
  }

  const handleOpenGigstackPortalUrl = () => {
    const portalUrl = taxes.gigstackPortalUrl?.trim() || ''
    if (!portalUrl) {
      showToast('warning', 'Falta el link', 'Pega la URL de tu portal de Gigstack antes de abrirlo.')
      return
    }
    window.open(portalUrl, '_blank', 'noopener,noreferrer')
  }

  const handleDisconnectGigstack = () => {
    showConfirm(
      'Desconectar Gigstack',
      'Se apagará el envío fiscal y se borrarán las API keys Test y Live. Los pagos ya registrados no se cancelan ni se borran.',
      () => {
        patchTaxValues({
          gigstackEnabled: false,
          gigstackTestApiToken: '',
          gigstackTestApiTokenPreview: '',
          hasGigstackTestApiToken: false,
          clearGigstackTestApiToken: true,
          gigstackLiveApiToken: '',
          gigstackLiveApiTokenPreview: '',
          hasGigstackLiveApiToken: false,
          clearGigstackLiveApiToken: true,
          hasGigstackApiToken: false,
        })
        showToast('success', 'Gigstack desconectado', 'Las dos API keys se borrarán de Ristak al guardar automáticamente.')
      },
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const syncGigstackFiscalProfile = async (draftSettings = latestSettingsRef.current) => {
    if (syncingGigstackFiscal) return
    const mode: PaymentModeId = draftSettings.paymentMode === 'test' ? 'test' : 'live'
    const token = mode === 'test'
      ? draftSettings.taxes.gigstackTestApiToken
      : draftSettings.taxes.gigstackLiveApiToken
    const hasSavedToken = mode === 'test'
      ? draftSettings.taxes.hasGigstackTestApiToken
      : draftSettings.taxes.hasGigstackLiveApiToken
    if (!token && !hasSavedToken) {
      showToast('warning', `Falta la API key ${mode === 'test' ? 'Test' : 'Live'}`, 'Pega la llave del ambiente activo antes de conectar Gigstack.')
      return
    }

    setSyncingGigstackFiscal(true)
    setAutoSaveState('saving')
    try {
      const synced = await paymentSettingsService.syncGigstackFiscalProfile(draftSettings, mode, token || '')
      const serialized = JSON.stringify(synced)
      latestSettingsRef.current = synced
      lastSavedSettingsRef.current = serialized
      setSettings(synced)
      setAutoSaveState('saved')
      showToast('success', 'Datos fiscales actualizados', 'RFC, razón social, régimen, código postal e impuesto ya vienen del equipo de Gigstack.')
    } catch (error: any) {
      setAutoSaveState('error')
      showToast('error', 'No se pudo activar Gigstack', error?.message || 'Revisa la configuración fiscal de tu equipo en Gigstack.')
    } finally {
      setSyncingGigstackFiscal(false)
    }
  }

  const setGigstackDefaultUnit = (unitKey: string) => {
    setSettings((current) => ({
      ...current,
      taxes: {
        ...current.taxes,
        gigstackDefaultUnitKey: unitKey,
        gigstackDefaultUnitName: getGigstackUnitName(unitKey) || unitKey
      }
    }))
  }

  const loadPaymentSettings = async (signal?: AbortSignal) => {
    setLoadingSettings(true)
    try {
      let nextSettings = await paymentSettingsService.getSettings(signal)
      if (signal?.aborted) return
      if (nextSettings.taxes.gigstackEnabled && !nextSettings.taxes.gigstackSatConnected) {
        const mode: PaymentModeId = nextSettings.paymentMode === 'test' ? 'test' : 'live'
        try {
          nextSettings = await paymentSettingsService.syncGigstackFiscalProfile(nextSettings, mode)
        } catch (error: any) {
          showToast('warning', 'Gigstack necesita revisión', error?.message || 'No se pudieron actualizar los datos fiscales desde Gigstack.')
        }
      }
      const serialized = JSON.stringify(nextSettings)
      loadedSettingsRef.current = true
      lastSavedSettingsRef.current = serialized
      latestSettingsRef.current = nextSettings
      setSettings(nextSettings)
      setAutoSaveState('saved')
    } catch (error: any) {
      if (!signal?.aborted) showToast('warning', 'Configuración local', error.message || 'Usaremos valores por defecto mientras se carga pagos.')
    } finally {
      setLoadingSettings(false)
    }
  }

  const loadWhatsAppAvailability = async (signal?: AbortSignal) => {
    try {
      const status = await whatsappApiService.getStatus({ signal })
      if (!signal?.aborted) setWhatsappAvailability(getWhatsAppStatusConnectionAvailability(status))
    } catch {
      if (!signal?.aborted) setWhatsappAvailability(defaultWhatsAppAvailability)
    }
  }

  const loadPaymentWhatsappTemplates = async (signal?: AbortSignal) => {
    setLoadingPaymentWhatsappTemplates(true)
    try {
      const items = (await whatsappApiService.getTemplates('APPROVED', { signal })).items || []
      if (!signal?.aborted) {
        setPaymentWhatsappTemplates(items.filter((template) => String(template.status || '').toUpperCase() === 'APPROVED'))
      }
    } catch {
      if (!signal?.aborted) setPaymentWhatsappTemplates([])
    } finally {
      setLoadingPaymentWhatsappTemplates(false)
    }
  }

  const loadHighLevelPaymentConfig = async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/highlevel/config', { signal })
      const config = await response.json()
      if (signal?.aborted) return

      if (config.invoiceTitle) setPaymentTitle(config.invoiceTitle)
      if (config.invoiceNumberPrefix) setPaymentNumberPrefix(config.invoiceNumberPrefix)
      if (config.invoiceDueDays) setPaymentDueDays(config.invoiceDueDays)
      if (config.transferInfoUrl) setTransferInfoUrl(config.transferInfoUrl)
      if (config.cardSetupAmount) setCardSetupAmount(Number(config.cardSetupAmount))
      setSettings((current) => ({
        ...current,
        receipt: current.receipt.useBusinessProfile === false
          ? {
              ...current.receipt,
              logoUrl: current.receipt.logoUrl || config.companyLogoUrl || '',
              businessName: current.receipt.businessName || config.businessName || '',
              businessEmail: current.receipt.businessEmail || config.businessEmail || '',
              businessPhone: current.receipt.businessPhone || config.businessPhone || '',
              businessAddress: current.receipt.businessAddress || [config.businessAddress, config.businessCity, config.businessState, config.businessCountry]
                .filter(Boolean)
                .join(', '),
              businessWebsite: current.receipt.businessWebsite || config.companyWebsite || '',
              terms: current.receipt.terms || config.invoiceTermsNotes || ''
            }
          : current.receipt,
        checkout: current.checkout.useBusinessProfile === false
          ? {
              ...current.checkout,
              logoUrl: current.checkout.logoUrl || config.companyLogoUrl || ''
            }
          : current.checkout
      }))
      gatewayConfigLoadedRef.current.add('highlevel')
    } catch {
      // Usar valores por defecto si no hay configuración todavía.
    }
  }

  const saveHighLevelInvoiceConfig = useCallback(async (nextSettings: PaymentSettings, modeOverride: PaymentModeId = paymentMode) => {
    if (!highLevelConnected) return
    const highLevelReceipt = applyBusinessProfileToReceipt(nextSettings.receipt, accountBusinessProfile)

    const response = await fetch('/api/highlevel/invoice-config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invoiceTitle: paymentTitle.trim(),
        invoiceNumberPrefix: paymentNumberPrefix.trim(),
        invoiceTermsNotes: highLevelReceipt.terms.trim() || null,
        invoiceDueDays: paymentDueDays,
        transferInfoUrl: transferInfoUrl.trim() || null,
        cardSetupAmount,
        ghlInvoiceMode: modeOverride
      })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || 'Error al guardar configuración de GoHighLevel')
    }

    window.dispatchEvent(new CustomEvent('ristak-payment-config-changed', {
      detail: { ghlInvoiceMode: modeOverride }
    }))
  }, [accountBusinessProfile, cardSetupAmount, highLevelConnected, paymentDueDays, paymentMode, paymentNumberPrefix, paymentTitle, transferInfoUrl])

  const persistPaymentSettings = useCallback(async ({ showSuccess = false } = {}) => {
    const nextSettings = latestSettingsRef.current
    const pendingSerialized = JSON.stringify(nextSettings)
    setSavingSettings(true)
    setAutoSaveState('saving')
    try {
      const savedSettings = await paymentSettingsService.saveSettings(nextSettings)
      const savedSerialized = JSON.stringify(savedSettings)
      lastSavedSettingsRef.current = savedSerialized

      if (JSON.stringify(latestSettingsRef.current) === pendingSerialized) {
        latestSettingsRef.current = savedSettings
        setSettings(savedSettings)
        setAutoSaveState('saved')
      }

      try {
        await saveHighLevelInvoiceConfig(savedSettings)
        if (showSuccess) {
          showToast('success', 'Pagos guardado', 'La configuración quedó actualizada.')
        }
      } catch (highLevelError: any) {
        if (showSuccess) {
          showToast('warning', 'Pagos guardado', highLevelError.message || 'La configuración global se guardó; revisa GoHighLevel sólo si usas esa integración opcional.')
        }
      }
    } catch (error: any) {
      setAutoSaveState('error')
      if (showSuccess) {
        showToast('error', 'No se pudo guardar', error.message || 'Revisa la configuración de pagos.')
      }
    } finally {
      setSavingSettings(false)
    }
  }, [saveHighLevelInvoiceConfig, showToast])

  useEffect(() => {
    if (!loadedSettingsRef.current || loadingSettings) return

    const serialized = JSON.stringify(settings)
    if (serialized === lastSavedSettingsRef.current) {
      setAutoSaveState((current) => current === 'saving' ? current : 'saved')
      return
    }

    setAutoSaveState('idle')
    const timer = window.setTimeout(() => {
      void persistPaymentSettings()
    }, 750)

    return () => window.clearTimeout(timer)
  }, [loadingSettings, persistPaymentSettings, settings])

  const handleSaveHighLevelGatewayConfig = async () => {
    setSavingHighLevelConfig(true)
    try {
      await saveHighLevelInvoiceConfig(latestSettingsRef.current)
      showToast('success', 'GoHighLevel guardado', 'La configuración de comprobantes quedó actualizada.')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar GoHighLevel', error.message || 'Revisa la configuración de comprobantes.')
    } finally {
      setSavingHighLevelConfig(false)
    }
  }

  const applyStripeConfig = (config: StripePaymentConfig) => {
    setStripeConfig(config)
    setStripeManualCredentials(getStripeModeCredentialsFromConfig(config))
    setStripeConnectionFailed(false)
  }

  const loadStripeConfig = async (signal?: AbortSignal) => {
    setLoadingStripeConfig(true)
    try {
      const config = await stripePaymentsService.getConfig(signal)
      if (signal?.aborted) return
      applyStripeConfig(config)
      gatewayConfigLoadedRef.current.add('stripe')
    } catch {
      if (!signal?.aborted) {
        setStripeConfig(null)
        setStripeManualCredentials(emptyStripeModeCredentials)
      }
    } finally {
      setLoadingStripeConfig(false)
    }
  }

  const applyConektaConfig = (config: ConektaPaymentConfig) => {
    setConektaConfig(config)
    setConektaManualCredentials(getConektaModeCredentialsFromConfig(config))
    setConektaConnectionFailed(false)
  }

  const loadConektaConfig = async (signal?: AbortSignal) => {
    setLoadingConektaConfig(true)
    try {
      const config = await conektaPaymentsService.getConfig(signal)
      if (signal?.aborted) return
      applyConektaConfig(config)
      gatewayConfigLoadedRef.current.add('conekta')
    } catch {
      if (!signal?.aborted) {
        setConektaConfig(null)
        setConektaManualCredentials(emptyConektaModeCredentials)
      }
    } finally {
      setLoadingConektaConfig(false)
    }
  }

  const applyMercadoPagoConfig = (config: MercadoPagoPaymentConfig) => {
    setMercadoPagoConfig(config)
    setMercadoPagoSubscriptionTestCredentials(getMercadoPagoSubscriptionTestCredentialsFromConfig(config))
  }

  const loadMercadoPagoConfig = async (signal?: AbortSignal) => {
    setLoadingMercadoPagoConfig(true)
    try {
      const config = await mercadoPagoPaymentsService.getConfig(signal)
      if (signal?.aborted) return
      applyMercadoPagoConfig(config)
      gatewayConfigLoadedRef.current.add('mercadopago')
    } catch {
      if (!signal?.aborted) {
        setMercadoPagoConfig(null)
        setMercadoPagoSubscriptionTestCredentials(emptyMercadoPagoSubscriptionTestCredentials)
      }
    } finally {
      setLoadingMercadoPagoConfig(false)
    }
  }

  const applyClipConfig = (config: ClipPaymentConfig) => {
    setClipConfig(config)
    setClipManualCredentials(getClipModeCredentialsFromConfig(config))
    setClipConnectionFailed(false)
  }

  const loadClipConfig = async (signal?: AbortSignal) => {
    setLoadingClipConfig(true)
    try {
      const config = await clipPaymentsService.getConfig(signal)
      if (signal?.aborted) return
      applyClipConfig(config)
      gatewayConfigLoadedRef.current.add('clip')
    } catch {
      if (!signal?.aborted) {
        setClipConfig(null)
        setClipManualCredentials(emptyClipModeCredentials)
      }
    } finally {
      setLoadingClipConfig(false)
    }
  }

  const applyRebillConfig = (config: RebillPaymentConfig) => {
    setRebillConfig(config)
    setRebillManualCredentials(getRebillModeCredentialsFromConfig(config))
    setRebillConnectionFailed(false)
  }

  const loadRebillConfig = async (signal?: AbortSignal) => {
    setLoadingRebillConfig(true)
    try {
      const config = await rebillPaymentsService.getConfig(signal)
      if (signal?.aborted) return
      applyRebillConfig(config)
      gatewayConfigLoadedRef.current.add('rebill')
    } catch {
      if (!signal?.aborted) {
        setRebillConfig(null)
        setRebillManualCredentials(emptyRebillModeCredentials)
      }
    } finally {
      setLoadingRebillConfig(false)
    }
  }

  const handlePaymentModeChange = async (nextMode: PaymentModeId) => {
    if (nextMode === paymentMode || savingPaymentMode) return

    const previousSettings = latestSettingsRef.current
    const nextSettings: PaymentSettings = {
      ...previousSettings,
      paymentMode: nextMode
    }
    const nextSerialized = JSON.stringify(nextSettings)

    setSavingPaymentMode(true)
    setSavingSettings(true)
    setAutoSaveState('saving')
    setSettings(nextSettings)
    latestSettingsRef.current = nextSettings

    try {
      const savedSettings = await paymentSettingsService.saveSettings(nextSettings)
      latestSettingsRef.current = savedSettings
      lastSavedSettingsRef.current = JSON.stringify(savedSettings)
      setSettings(savedSettings)
      setAutoSaveState('saved')

      await saveHighLevelInvoiceConfig(savedSettings, nextMode)
      await Promise.all([
        loadStripeConfig(),
        loadConektaConfig(),
        loadMercadoPagoConfig(),
        loadClipConfig(),
        loadRebillConfig()
      ])
      invalidateIntegrationsStatus()
      showToast('success', 'Modo de pasarelas actualizado', `Los nuevos cobros usarán ${paymentModeLabels[nextMode].title.toLowerCase()}.`)
    } catch (error: any) {
      latestSettingsRef.current = previousSettings
      lastSavedSettingsRef.current = JSON.stringify(previousSettings)
      setSettings(previousSettings)
      setAutoSaveState('error')
      showToast('error', 'No se pudo cambiar el modo', error.message || 'Intenta de nuevo.')
    } finally {
      if (lastSavedSettingsRef.current === nextSerialized) setAutoSaveState('saved')
      setSavingSettings(false)
      setSavingPaymentMode(false)
    }
  }

  const buildStripeModeConfigPayload = (mode: StripeModeId, modeValues: StripeModeCredentials = stripeManualCredentials[mode]): SaveStripePaymentConfigPayload => {
    return {
      enabled: true,
      mode: paymentMode,
      defaultCurrency: accountCurrency,
      manualModes: {
        [mode]: {
          publishableKey: modeValues.publishableKey.trim(),
          secretKey: modeValues.secretKey.trim()
        }
      }
    }
  }

  const updateStripeModeCredential = (mode: StripeModeId, key: keyof StripeModeCredentials, value: string) => {
    setStripeManualCredentials((current) => ({
      ...current,
      [mode]: {
        ...current[mode],
        [key]: value
      }
    }))
  }

  const buildConektaModeConfigPayload = (mode: StripeModeId, modeValues: ConektaModeCredentials = conektaManualCredentials[mode]): SaveConektaPaymentConfigPayload => {
    return {
      enabled: true,
      mode: paymentMode,
      defaultCurrency: accountCurrency,
      manualModes: {
        [mode]: {
          publicKey: modeValues.publicKey.trim(),
          privateKey: modeValues.privateKey.trim()
        }
      }
    }
  }

  const updateConektaModeCredential = (mode: StripeModeId, key: keyof ConektaModeCredentials, value: string) => {
    setConektaManualCredentials((current) => ({
      ...current,
      [mode]: {
        ...current[mode],
        [key]: value
      }
    }))
  }

  const buildClipModeConfigPayload = (mode: StripeModeId, modeValues: ClipModeCredentials = clipManualCredentials[mode]): SaveClipPaymentConfigPayload => {
    const accountLabel = modeValues.accountLabel.trim()
    const apiKey = modeValues.apiKey.trim()
    const accountLabelHasApiKey = looksLikeClipSdkApiKey(accountLabel)
    const apiKeyHasApiKey = looksLikeClipSdkApiKey(apiKey)

    return {
      enabled: true,
      mode,
      accountLabel: accountLabelHasApiKey && !apiKeyHasApiKey ? '' : accountLabel,
      apiKey: accountLabelHasApiKey && !apiKeyHasApiKey ? accountLabel : apiKey
    }
  }

  const updateClipModeCredential = (mode: StripeModeId, key: keyof ClipModeCredentials, value: string) => {
    setClipManualCredentials((current) => ({
      ...current,
      [mode]: {
        ...current[mode],
        [key]: value
      }
    }))
  }

  const buildRebillModeConfigPayload = (mode: StripeModeId, modeValues: RebillModeCredentials = rebillManualCredentials[mode]): SaveRebillPaymentConfigPayload => {
    return {
      enabled: true,
      mode,
      defaultCurrency: accountCurrency,
      publicKey: modeValues.publicKey.trim(),
      secretKey: modeValues.secretKey.trim()
    }
  }

  const updateRebillModeCredential = (mode: StripeModeId, key: keyof RebillModeCredentials, value: string) => {
    setRebillManualCredentials((current) => ({
      ...current,
      [mode]: {
        ...current[mode],
        [key]: value
      }
    }))
  }

  const getGatewaySaveMessage = (
    gatewayName: 'Stripe' | 'Conekta' | 'Rebill',
    modeTitle: string,
    connection?: GatewayAutomaticConnectionStatus | null
  ) => {
    const status = String(connection?.webhookStatus || '').toLowerCase()
    if (connection?.webhookConfigured || ['active', 'enabled', 'configured'].includes(status)) {
      return `${modeTitle} quedó listo para cobrar con ${gatewayName}.`
    }
    if (status === 'pending_public_url') {
      return `${modeTitle} quedó guardado. Para terminar la conexión automática, Ristak necesita estar publicado con una URL segura HTTPS.`
    }
    return `${modeTitle} quedó listo para cobrar.`
  }

  const handleSaveStripeModeConfig = async (mode: StripeModeId) => {
    setSavingStripeMode(mode)
    try {
      const config = await stripePaymentsService.saveConfig(buildStripeModeConfigPayload(mode))
      applyStripeConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Stripe guardado', getGatewaySaveMessage('Stripe', stripeModeLabels[mode].title, config.manualModes?.[mode]))
    } catch (error: any) {
      setStripeConnectionFailed(true)
      showToast('error', 'No se pudo guardar Stripe', error.message || 'Revisa las credenciales de Stripe.')
    } finally {
      setSavingStripeMode(null)
    }
  }

  const handleDisconnectStripeMode = (mode: StripeModeId) => {
    showConfirm(
      'Desconectar credenciales',
      `Se borrarán las credenciales de ${stripeModeLabels[mode].title.toLowerCase()} y Stripe dejará de usarse para nuevos cobros en ese modo. Esta acción no se puede deshacer.`,
      () => disconnectStripeMode(mode),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const disconnectStripeMode = async (mode: StripeModeId) => {
    const otherMode = mode === 'live' ? 'test' : 'live'
    const otherModeHasConfig = stripeModeIsSaved(otherMode) || stripeModeIsComplete(otherMode)

    setDisconnectingStripeMode(mode)
    try {
      const emptyMode = { publishableKey: '', secretKey: '', webhookSecret: '' }
      const disconnectPayload = {
        ...buildStripeModeConfigPayload(mode, emptyMode),
        manualModes: {
          [mode]: {
            publishableKey: '',
            secretKey: '',
            webhookSecret: ''
          },
          ...(stripeModeIsComplete(otherMode)
            ? {
                [otherMode]: {
                  publishableKey: stripeManualCredentials[otherMode].publishableKey.trim(),
                  secretKey: stripeManualCredentials[otherMode].secretKey.trim(),
                  webhookSecret: stripeManualCredentials[otherMode].webhookSecret.trim()
                }
              }
            : {})
        }
      }
      const config = otherModeHasConfig
        ? await stripePaymentsService.saveConfig(disconnectPayload)
        : await stripePaymentsService.deleteConfig()
      applyStripeConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Stripe desconectado', `${stripeModeLabels[mode].title} dejó de usarse para nuevos cobros.`)
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar Stripe', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingStripeMode(null)
    }
  }

  const handleSaveConektaModeConfig = async (mode: StripeModeId) => {
    setSavingConektaMode(mode)
    try {
      const config = await conektaPaymentsService.saveConfig(buildConektaModeConfigPayload(mode))
      applyConektaConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Conekta guardado', getGatewaySaveMessage('Conekta', conektaModeLabels[mode].title, config.manualModes?.[mode]))
    } catch (error: any) {
      setConektaConnectionFailed(true)
      showToast('error', 'No se pudo guardar Conekta', error.message || 'Revisa las credenciales de Conekta.')
    } finally {
      setSavingConektaMode(null)
    }
  }

  const handleDisconnectConektaMode = (mode: StripeModeId) => {
    showConfirm(
      'Desconectar Conekta',
      `Se borrarán las credenciales de ${conektaModeLabels[mode].title.toLowerCase()} y Conekta dejará de usarse para nuevos cobros en ese modo. Esta acción no se puede deshacer.`,
      () => disconnectConektaMode(mode),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const disconnectConektaMode = async (mode: StripeModeId) => {
    const otherMode = mode === 'live' ? 'test' : 'live'
    const otherModeHasConfig = conektaModeIsSaved(otherMode) || conektaModeIsComplete(otherMode)

    setDisconnectingConektaMode(mode)
    try {
      const emptyMode = { publicKey: '', privateKey: '' }
      const disconnectPayload = {
        ...buildConektaModeConfigPayload(mode, emptyMode),
        manualModes: {
          [mode]: {
            publicKey: '',
            privateKey: ''
          },
          ...(conektaModeIsComplete(otherMode)
            ? {
                [otherMode]: {
                  publicKey: conektaManualCredentials[otherMode].publicKey.trim(),
                  privateKey: conektaManualCredentials[otherMode].privateKey.trim()
                }
              }
            : {})
        }
      }
      const config = otherModeHasConfig
        ? await conektaPaymentsService.saveConfig(disconnectPayload)
        : await conektaPaymentsService.deleteConfig()
      applyConektaConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Conekta desconectado', `${conektaModeLabels[mode].title} dejó de usarse para nuevos cobros.`)
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar Conekta', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingConektaMode(null)
    }
  }

  const handleSaveClipModeConfig = async (mode: StripeModeId) => {
    setSavingClipMode(mode)
    try {
      const config = await clipPaymentsService.saveConfig(buildClipModeConfigPayload(mode))
      applyClipConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'CLIP guardado', `${clipModeLabels[mode].title} quedó listo para montar el SDK de Checkout Transparente.`)
    } catch (error: any) {
      setClipConnectionFailed(true)
      showToast('error', 'No se pudo guardar CLIP', error.message || 'Pega la Clave API visible de CLIP; la clave secreta no se usa para el SDK.')
    } finally {
      setSavingClipMode(null)
    }
  }

  const handleTestClipModeConfig = async (mode: StripeModeId) => {
    setTestingClipMode(mode)
    try {
      const result = await clipPaymentsService.testConfig(buildClipModeConfigPayload(mode))
      setClipConnectionFailed(false)
      showToast('success', 'Clave API lista para SDK', `Ristak puede montar Checkout Transparente de CLIP en modo ${result.mode === 'live' ? 'en vivo' : 'prueba'}. El cargo real se confirma cuando ${customerWithPlainArticle} paga.`)
    } catch (error: any) {
      setClipConnectionFailed(true)
      showToast('error', 'No se pudo validar la Clave API', error.message || 'Pega la Clave API visible de CLIP, no la clave secreta.')
    } finally {
      setTestingClipMode(null)
    }
  }

  const handleDisconnectClipMode = (mode: StripeModeId) => {
    showConfirm(
      'Desconectar CLIP',
      `Se borrará la API Key de ${clipModeLabels[mode].title.toLowerCase()} y CLIP dejará de usarse para nuevos cobros en ese modo. Esta acción no se puede deshacer.`,
      () => disconnectClipMode(mode),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const disconnectClipMode = async (mode: StripeModeId) => {
    setDisconnectingClipMode(mode)
    try {
      const config = await clipPaymentsService.saveConfig({
        mode,
        enabled: false,
        disconnectMode: true
      })
      applyClipConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'CLIP desconectado', `${clipModeLabels[mode].title} dejó de usarse para nuevos cobros.`)
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar CLIP', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingClipMode(null)
    }
  }

  const handleSaveRebillModeConfig = async (mode: StripeModeId) => {
    setSavingRebillMode(mode)
    try {
      const config = await rebillPaymentsService.saveConfig(buildRebillModeConfigPayload(mode))
      applyRebillConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Rebill guardado', getGatewaySaveMessage('Rebill', rebillModeLabels[mode].title, config.modeConnections?.[mode]))
    } catch (error: any) {
      setRebillConnectionFailed(true)
      showToast('error', 'No se pudo guardar Rebill', error.message || 'Revisa las llaves pk_ y sk_ de Rebill.')
    } finally {
      setSavingRebillMode(null)
    }
  }

  const handleTestRebillModeConfig = async (mode: StripeModeId) => {
    setTestingRebillMode(mode)
    try {
      const result = await rebillPaymentsService.testConfig(buildRebillModeConfigPayload(mode))
      setRebillConnectionFailed(false)
      showToast('success', 'Rebill respondió', `${result.organization?.name || 'La organizacion'} quedó validada en modo ${result.mode === 'live' ? 'en vivo' : 'prueba'}.`)
    } catch (error: any) {
      setRebillConnectionFailed(true)
      showToast('error', 'No se pudo validar Rebill', error.message || 'Revisa que la secret key sea sk_ y pertenezca a Rebill.')
    } finally {
      setTestingRebillMode(null)
    }
  }

  const handleDisconnectRebillMode = (mode: StripeModeId) => {
    showConfirm(
      'Desconectar Rebill',
      `Se borrarán las llaves de ${rebillModeLabels[mode].title.toLowerCase()} y Rebill dejará de usarse para nuevos cobros en ese modo. Esta acción no se puede deshacer.`,
      () => disconnectRebillMode(mode),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const disconnectRebillMode = async (mode: StripeModeId) => {
    setDisconnectingRebillMode(mode)
    try {
      const config = await rebillPaymentsService.saveConfig({
        mode,
        enabled: false,
        disconnectMode: true
      })
      applyRebillConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Rebill desconectado', `${rebillModeLabels[mode].title} dejó de usarse para nuevos cobros.`)
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar Rebill', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingRebillMode(null)
    }
  }

  const handleConnectMercadoPago = async () => {
    setConnectingMercadoPago(true)
    try {
      const response = await mercadoPagoPaymentsService.createConnectUrl({
        mode: paymentMode,
        returnPath: '/settings/payments/mercadopago',
        appUrl: window.location.origin
      })
      window.location.assign(response.url)
    } catch (error: any) {
      showToast('error', 'No se pudo abrir Mercado Pago', error.message || 'Revisa Mercado Pago en el Installer.')
      setConnectingMercadoPago(false)
    }
  }

  const handleDisconnectMercadoPago = () => {
    showConfirm(
      'Desconectar Mercado Pago',
      'Se borrará la conexión de la cuenta y Ristak dejará de usarla para nuevos cobros. Esta acción no se puede deshacer.',
      () => disconnectMercadoPago(),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const disconnectMercadoPago = async () => {
    setDisconnectingMercadoPago(true)
    try {
      const config = await mercadoPagoPaymentsService.deleteConfig()
      applyMercadoPagoConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Mercado Pago desconectado', 'Ristak dejó de usar esta cuenta para nuevos cobros.')
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar Mercado Pago', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingMercadoPago(false)
    }
  }

  const updateMercadoPagoSubscriptionTestCredential = (field: keyof MercadoPagoSubscriptionTestCredentials, value: string) => {
    setMercadoPagoSubscriptionTestCredentials((current) => ({
      ...current,
      [field]: value
    }))
  }

  const handleSaveMercadoPagoSubscriptionTestCredentials = async () => {
    setSavingMercadoPagoSubscriptionTestCredentials(true)
    try {
      const config = await mercadoPagoPaymentsService.saveSubscriptionTestCredentials({
        publicKey: mercadoPagoSubscriptionTestCredentials.publicKey.trim(),
        accessToken: mercadoPagoSubscriptionTestCredentials.accessToken.trim(),
        webhookSecret: mercadoPagoSubscriptionTestCredentials.webhookSecret.trim()
      })
      applyMercadoPagoConfig(config)
      showToast('success', 'Credenciales guardadas', 'Las suscripciones test de Mercado Pago usarán la app del vendedor test.')
    } catch (error: any) {
      showToast('error', 'No se guardaron las credenciales', error.message || 'Revisa las credenciales de la app del vendedor test.')
    } finally {
      setSavingMercadoPagoSubscriptionTestCredentials(false)
    }
  }

  const handleClearMercadoPagoSubscriptionTestCredentials = () => {
    showConfirm(
      'Desconectar credenciales test',
      'Se borrarán las credenciales de la app usadas para probar suscripciones de Mercado Pago. Los pagos únicos de prueba seguirán usando la conexión normal. Esta acción no se puede deshacer.',
      () => clearMercadoPagoSubscriptionTestCredentials(),
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const clearMercadoPagoSubscriptionTestCredentials = async () => {
    setClearingMercadoPagoSubscriptionTestCredentials(true)
    try {
      const config = await mercadoPagoPaymentsService.deleteSubscriptionTestCredentials()
      applyMercadoPagoConfig(config)
      showToast('success', 'Credenciales borradas', 'Ristak dejó de usar esa app para suscripciones test.')
    } catch (error: any) {
      showToast('error', 'No se borraron las credenciales', error.message || 'Intenta de nuevo.')
    } finally {
      setClearingMercadoPagoSubscriptionTestCredentials(false)
    }
  }

  const handleSectionChange = (sectionId: string) => {
    if (!isPaymentsSectionId(sectionId) || !visibleSectionItems.some((item) => item.id === sectionId)) return
    setActiveSection(sectionId)
    navigate(sectionId === 'checkout' ? '/settings/payments' : `/settings/payments/${sectionId}`)
  }

  const handleSelectGateway = (gateway: PaymentGatewayOption) => {
    navigate(`/settings/payments/${gateway.id}`)
  }

  const handleGatewayCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, gateway: PaymentGatewayOption) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleSelectGateway(gateway)
  }

  const handleCheckoutLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo no válido', 'Sube una imagen para el logo de la página de cobro.')
      return
    }

    setUploadingCheckoutLogo(true)
    setCheckoutLogoUploadProgress(0)
    try {
      const uploaded = await mediaService.uploadFile({
        file,
        module: 'payments',
        moduleEntityId: 'checkout-logo',
        isPublic: true,
        onProgress: ({ percent }) => setCheckoutLogoUploadProgress(percent)
      })
      setCheckoutValue('logoUrl', uploaded.publicUrl || `/api/media/assets/${encodeURIComponent(uploaded.id)}/file`)
      showToast('success', 'Logo subido', 'El logo quedó guardado en Media y enlazado a la página de cobro.')
    } catch (uploadError: any) {
      showToast('error', 'No se pudo subir el logo', uploadError.message || 'Revisa el archivo e intenta de nuevo.')
    } finally {
      setUploadingCheckoutLogo(false)
      setCheckoutLogoUploadProgress(0)
    }
  }

  const handleReceiptLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo no válido', 'Sube una imagen para el logo del comprobante.')
      return
    }

    setUploadingReceiptLogo(true)
    setReceiptLogoUploadProgress(0)
    try {
      const uploaded = await mediaService.uploadFile({
        file,
        module: 'payments',
        moduleEntityId: 'receipt-logo',
        isPublic: true,
        onProgress: ({ percent }) => setReceiptLogoUploadProgress(percent)
      })
      setReceiptValue('logoUrl', uploaded.publicUrl || `/api/media/assets/${encodeURIComponent(uploaded.id)}/file`)
      showToast('success', 'Logo subido', 'El logo quedó guardado en Media y enlazado al comprobante.')
    } catch (uploadError: any) {
      showToast('error', 'No se pudo subir el logo', uploadError.message || 'Revisa el archivo e intenta de nuevo.')
    } finally {
      setUploadingReceiptLogo(false)
      setReceiptLogoUploadProgress(0)
    }
  }

  const handlePreviewReceipt = async () => {
    if (previewingReceipt) return

    const previewWindow = window.open('', '_blank')
    if (!previewWindow) {
      showToast('error', 'Preview bloqueado', 'Permite popups para abrir la previsualización del comprobante.')
      return
    }

    writeReceiptPreviewLoadingPage(previewWindow)
    setPreviewingReceipt(true)
    try {
      const previewSettings = {
        ...latestSettingsRef.current,
        checkout: applyBusinessProfileToCheckout(latestSettingsRef.current.checkout, accountBusinessProfile),
        receipt: applyBusinessProfileToReceipt(latestSettingsRef.current.receipt, accountBusinessProfile)
      }
      const session = await paymentSettingsService.createReceiptPreviewSession(previewSettings, accountCurrency)
      previewWindow.location.replace(session.url)
    } catch (error: any) {
      previewWindow.close()
      showToast('error', 'No se pudo previsualizar', error.message || 'Intenta guardar y abrir de nuevo.')
    } finally {
      setPreviewingReceipt(false)
    }
  }

  const handleInvoiceTemplateSelect = (templateId: PaymentInvoiceTemplateId) => {
    setReceiptValue('invoiceTemplate', templateId)
  }

  const handleInvoicePaletteSelect = (paletteId: Exclude<PaymentInvoicePaletteId, 'custom'>) => {
    const palette = invoicePaletteOptions.find((option) => option.id === paletteId)
    if (!palette) return

    patchReceiptValues({
      invoicePalette: palette.id,
      invoiceAccentColor: palette.accentColor,
      invoicePaperColor: palette.paperColor,
      invoiceTextColor: palette.textColor
    })
  }

  const renderField = (
    label: string,
    control: React.ReactNode,
    hint?: React.ReactNode
  ) => (
    <label className={styles.formField}>
      <span>{label}</span>
      {control}
      {hint ? <small>{hint}</small> : null}
    </label>
  )

  const renderSwitchRow = (
    label: string,
    description: string,
    checked: boolean,
    onChange: (next: boolean) => void
  ) => (
    <div className={styles.switchRow}>
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
  )

  const updatePaymentMetaPurchaseEventConfig = async (patch: Partial<PaymentMetaPurchaseEventConfig>) => {
    const nextConfig = normalizePaymentMetaPurchaseEventConfig({
      ...paymentMetaPurchaseEventConfig,
      channel: PAYMENT_META_DEFAULT_EVENT_CHANNEL,
      ...patch
    })

    try {
      await setPaymentMetaPurchaseEventConfig(nextConfig)
    } catch (error: any) {
      showToast('error', 'No se pudo guardar Meta Purchase', error.message || 'Revisa la conexión e intenta de nuevo.')
      throw error
    }
  }

  const handlePaymentMetaPurchaseEventEnabledChange = (enabled: boolean) => {
    void updatePaymentMetaPurchaseEventConfig({
      enabled,
      channel: PAYMENT_META_DEFAULT_EVENT_CHANNEL
    })
  }

  const handlePaymentMetaPurchaseEventSendValueChange = (sendValue: boolean) => {
    void updatePaymentMetaPurchaseEventParameters({ sendValue })
  }

  const handlePaymentMetaPurchaseEventPlanTotalValueChange = (usePaymentPlanTotalValue: boolean) => {
    void updatePaymentMetaPurchaseEventParameters({ usePaymentPlanTotalValue })
  }

  const updatePaymentMetaPurchaseEventParameters = (patch: Partial<PaymentMetaPurchaseEventParameters>) => {
    updatePaymentMetaPurchaseEventConfig({
      parameters: {
        ...paymentMetaPurchaseEventConfig.parameters,
        ...patch
      }
    }).catch(() => {})
  }

  const updatePaymentMetaPurchaseEventParameterRow = (
    parameterId: string,
    patch: Partial<PaymentMetaPurchaseEventParameter>
  ) => {
    const custom = paymentMetaPurchaseEventConfig.parameters.custom
      .map(parameter => parameter.id === parameterId
        ? normalizePaymentMetaPurchaseEventParameter({ ...parameter, ...patch })
        : parameter
      )
    updatePaymentMetaPurchaseEventParameters({ custom })
  }

  const addPaymentMetaPurchaseEventParameterRow = () => {
    setPaymentMetaParamsOpen(true)
    updatePaymentMetaPurchaseEventParameters({
      custom: [
        ...paymentMetaPurchaseEventConfig.parameters.custom,
        createPaymentMetaPurchaseEventParameter()
      ]
    })
  }

  const removePaymentMetaPurchaseEventParameterRow = (parameterId: string) => {
    updatePaymentMetaPurchaseEventParameters({
      custom: paymentMetaPurchaseEventConfig.parameters.custom.filter(parameter => parameter.id !== parameterId)
    })
  }

  const getAutoSaveLabel = () => {
    if (savingSettings || autoSaveState === 'saving') return 'Guardando cambios...'
    if (autoSaveState === 'error') return 'No se pudo guardar'
    if (autoSaveState === 'saved') return 'Guardado automático activo'
    return 'Se guarda automáticamente'
  }

  const renderSectionSaveBar = (buttonLabel: string) => (
    <div className={styles.sectionSaveBar}>
      <span>{getAutoSaveLabel()}</span>
      <Button
        type="button"
        variant="secondary"
        onClick={() => persistPaymentSettings({ showSuccess: true })}
        disabled={savingSettings || loadingSettings}
      >
        {savingSettings ? (
          <>
            <Loader2 size={16} className={styles.spinIcon} />
            Guardando...
          </>
        ) : (
          buttonLabel
        )}
      </Button>
    </div>
  )

  const renderBusinessProfileSource = (
    title: string,
    description: string,
    checked: boolean,
    onChange: (next: boolean) => void
  ) => {
    const previewItems = [
      accountBusinessProfile.logoUrl ? 'Logo configurado' : '',
      accountBusinessProfile.name,
      accountBusinessProfile.email,
      accountBusinessProfile.phone,
      accountBusinessProfile.website,
      accountBusinessProfile.address,
      accountBusinessProfile.terms ? 'Términos configurados' : ''
    ].filter(Boolean)

    return (
      <div className={styles.businessProfileSource}>
        <div className={styles.businessProfileSummary}>
          <div>
            <strong>{title}</strong>
            <span>{description}</span>
          </div>
          <Switch checked={checked} onChange={onChange} aria-label={title} />
        </div>
        {checked && (
          <div className={styles.businessProfilePreview}>
            {hasBusinessProfile
              ? previewItems.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)
              : <span>No hay datos de negocio guardados todavía.</span>}
          </div>
        )}
        {checked && (
          <div className={styles.logoUploadActions}>
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate('/settings/account')}>
              Editar negocio
            </Button>
          </div>
        )}
      </div>
    )
  }

  const renderCheckoutSection = () => (
    <div className={styles.twoColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Diseño de la página de cobro</h2>
            <p>Controla el logo, el texto principal y el soporte visible antes de pagar.</p>
          </div>
          <Badge variant="info">
            <Paintbrush size={14} />
            Editable
          </Badge>
        </div>

        {renderBusinessProfileSource(
          'Usar logo y soporte de Negocio',
          'El logo, correo y teléfono de soporte salen de Configuración > Negocio.',
          checkout.useBusinessProfile !== false,
          (next) => setCheckoutValue('useBusinessProfile', next)
        )}

        <div className={styles.formGrid}>
          <div className={`${styles.formField} ${styles.fullWidthField}`}>
            <span>Logo del negocio</span>
            <div className={styles.logoUploadControl}>
              <div className={styles.logoUploadPreview}>
                {effectiveCheckout.logoUrl ? <img src={effectiveCheckout.logoUrl} alt="" /> : <Image size={22} />}
              </div>
              <div className={styles.logoUploadContent}>
                <div className={styles.logoUploadActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => checkoutLogoInputRef.current?.click()}
                    disabled={uploadingCheckoutLogo || checkout.useBusinessProfile !== false}
                  >
                    {uploadingCheckoutLogo ? (
                      <>
                        <Loader2 size={15} className={styles.spinIcon} />
                        Subiendo {checkoutLogoUploadProgress > 0 ? `${checkoutLogoUploadProgress}%` : ''}
                      </>
                    ) : (
                      <>
                        <ImageUp size={15} />
                        Subir logo
                      </>
                    )}
                  </Button>
                  {checkout.useBusinessProfile === false && checkout.logoUrl && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setCheckoutValue('logoUrl', '')}>
                      <Trash2 size={15} />
                      Quitar
                    </Button>
                  )}
                </div>
                <input
                  ref={checkoutLogoInputRef}
                  className={styles.fileInputHidden}
                  type="file"
                  accept="image/*"
                  onChange={handleCheckoutLogoUpload}
                />
                <small>{checkout.useBusinessProfile === false ? 'Se guarda en Media y aparece en la parte superior del link de cobro.' : 'Heredado desde Configuración > Negocio.'}</small>
                {effectiveCheckout.logoUrl && (
                  <input
                    type="url"
                    value={effectiveCheckout.logoUrl}
                    onChange={(event) => setCheckoutValue('logoUrl', event.target.value)}
                    disabled={checkout.useBusinessProfile !== false}
                    placeholder="https://tu-dominio.com/logo.png"
                  />
                )}
              </div>
            </div>
          </div>
          {renderField(
            'Título de cobro',
            <input
              type="text"
              value={checkout.headline}
              onChange={(event) => setCheckoutValue('headline', event.target.value)}
              placeholder="Pago seguro"
            />
          )}
          {renderField(
            'Texto de ayuda',
            <textarea
              value={checkout.description}
              onChange={(event) => setCheckoutValue('description', event.target.value)}
              placeholder={`Explica qué va a revisar ${customerWithPlainArticle} antes de pagar.`}
            />
          )}
          {renderField(
            'Texto del botón',
            <input
              type="text"
              value={checkout.buttonLabel}
              onChange={(event) => setCheckoutValue('buttonLabel', event.target.value)}
              placeholder="Pagar ahora"
            />
          )}
          {renderField(
            'Correo de soporte',
              <input
                type="email"
                value={effectiveCheckout.supportEmail}
                onChange={(event) => setCheckoutValue('supportEmail', event.target.value)}
                disabled={checkout.useBusinessProfile !== false}
                placeholder="pagos@tu-negocio.com"
              />
            )}
          {renderField(
            'Teléfono de soporte',
              <input
                type="tel"
                value={effectiveCheckout.supportPhone}
                onChange={(event) => setCheckoutValue('supportPhone', event.target.value)}
                disabled={checkout.useBusinessProfile !== false}
                placeholder="+52 656 000 0000"
              />
            )}
        </div>

        <div className={styles.subsectionBlock}>
          <div className={styles.subsectionHeader}>
            <h3>Información visible antes de pagar</h3>
            <p>Estos datos son los mismos del comprobante descargable y también aparecen en el resumen del link de cobro.</p>
          </div>

          {renderBusinessProfileSource(
            'Usar datos de Negocio',
            'Nombre, contacto, web, dirección y términos se toman del perfil de negocio.',
            receipt.useBusinessProfile !== false,
            (next) => setReceiptValue('useBusinessProfile', next)
          )}

          <div className={styles.formGrid}>
            {renderField(
              'Nombre del negocio',
              <input
                type="text"
                value={effectiveReceipt.businessName}
                onChange={(event) => setReceiptValue('businessName', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Nombre comercial"
              />
            )}
            {renderField(
              'Correo del negocio',
              <input
                type="email"
                value={effectiveReceipt.businessEmail}
                onChange={(event) => setReceiptValue('businessEmail', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="pagos@tu-negocio.com"
              />
            )}
            {renderField(
              'Teléfono del negocio',
              <input
                type="tel"
                value={effectiveReceipt.businessPhone}
                onChange={(event) => setReceiptValue('businessPhone', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="+52 656 000 0000"
              />
            )}
            {renderField(
              'Sitio web',
              <input
                type="url"
                value={effectiveReceipt.businessWebsite}
                onChange={(event) => setReceiptValue('businessWebsite', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="https://tu-negocio.com"
              />
            )}
            {renderField(
              'Dirección fiscal o comercial',
              <textarea
                value={effectiveReceipt.businessAddress}
                onChange={(event) => setReceiptValue('businessAddress', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Calle, ciudad, estado, país"
              />
            )}
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Términos y condiciones</span>
              <textarea
                className={styles.largeTextarea}
                value={effectiveReceipt.terms}
                onChange={(event) => setReceiptValue('terms', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio."
              />
              <small>Se muestran en el resumen antes de pagar y al final del comprobante descargable.</small>
            </div>
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow('Mostrar datos del negocio', 'Aparecen en el link de cobro y en el comprobante.', receipt.showBusinessInfo, (next) => setReceiptValue('showBusinessInfo', next))}
            {renderSwitchRow('Mostrar términos', 'Aparecen antes de pagar y al final del comprobante descargable.', receipt.showTerms, (next) => setReceiptValue('showTerms', next))}
          </div>
        </div>

        <div className={styles.sectionDividerStack}>
          {renderSwitchRow(
            'Mostrar sello de pago seguro',
            'Aparece debajo del botón de pago para reforzar confianza sin duplicar el resumen.',
            checkout.showSecureBadge,
            (next) => setCheckoutValue('showSecureBadge', next)
          )}
        </div>

        {renderSectionSaveBar('Guardar página de cobro')}
      </Card>

      <Card className={styles.previewCard}>
        <div className={styles.previewPaymentHeader}>
          {effectiveCheckout.logoUrl ? <img src={effectiveCheckout.logoUrl} alt="" /> : <span>{(effectiveReceipt.businessName || 'R').slice(0, 1)}</span>}
          <div>
            <strong>{effectiveCheckout.headline || 'Pago seguro'}</strong>
            <p>{effectiveCheckout.description || 'Revisa el resumen y completa tu pago con tarjeta.'}</p>
          </div>
        </div>
        <div className={styles.previewInvoice}>
          <div>
            <span>Concepto</span>
            <strong>Plan mensual</strong>
          </div>
          <div>
            <span>Total</span>
            <strong>{formatCompactMoney(2490, accountCurrency)}</strong>
          </div>
          <div>
            <span>Vencimiento</span>
            <strong>8 jul 2026</strong>
          </div>
        </div>
        {effectiveReceipt.showBusinessInfo && (effectiveReceipt.businessName || effectiveReceipt.businessEmail || effectiveReceipt.businessPhone || effectiveReceipt.businessAddress || effectiveReceipt.businessWebsite) && (
          <div className={styles.previewInfoBlock}>
            <strong>{effectiveReceipt.businessName || 'Tu negocio'}</strong>
            {effectiveReceipt.businessEmail && <span>{effectiveReceipt.businessEmail}</span>}
            {effectiveReceipt.businessPhone && <span>{effectiveReceipt.businessPhone}</span>}
            {effectiveReceipt.businessAddress && <span>{effectiveReceipt.businessAddress}</span>}
            {effectiveReceipt.businessWebsite && <span>{effectiveReceipt.businessWebsite}</span>}
          </div>
        )}
        {effectiveReceipt.showTerms && effectiveReceipt.terms && (
          <p className={styles.previewTerms}>
            <strong>Términos y condiciones</strong>
            <span>{effectiveReceipt.terms}</span>
          </p>
        )}
        <div className={styles.previewButton}>
          <CreditCard size={16} />
          {effectiveCheckout.buttonLabel || 'Pagar ahora'}
        </div>
        {effectiveCheckout.showSecureBadge && (
          <p className={styles.previewTrust}>
            <ShieldCheck size={15} />
            Pago procesado de forma segura.
          </p>
        )}
      </Card>
    </div>
  )

  const renderMetaSection = () => (
    <div className={styles.singleColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Evento de Meta al completar pago</h2>
            <p>Activa el evento estándar de compra para pagos completados. En esta sección siempre se envía Purchase.</p>
          </div>
          <Badge variant="info">
            <Sparkles size={14} />
            Meta
          </Badge>
        </div>

        <div className={styles.paymentMetaEventSwitchRow}>
          <div>
            <span>Enviar evento de compra</span>
            <small>
              Si está apagado, no se enviará ningún evento de Meta para pagos desde este flujo de cobros.
            </small>
          </div>
          <Switch
            checked={paymentMetaPurchaseEventConfig.enabled}
            onChange={handlePaymentMetaPurchaseEventEnabledChange}
            aria-label="Activar evento de compra Meta"
          />
        </div>

        {paymentMetaPurchaseEventConfig.enabled && (
          <div className={styles.paymentMetaEventControls}>
            {renderSwitchRow(
              'Incluir monto del pago',
              'Envía automáticamente lo que se pagó en la transacción. Puedes desactivarlo si no quieres exponer el valor.',
              paymentMetaPurchaseEventConfig.parameters.sendValue,
              handlePaymentMetaPurchaseEventSendValueChange
            )}

            {renderSwitchRow(
              'Usar total del plan de pagos',
              'Encendido por default. Solo aplica a planes de pagos: Meta recibe el total del plan en la primera parcialidad y las siguientes parcialidades del mismo plan no se vuelven a registrar.',
              paymentMetaPurchaseEventConfig.parameters.usePaymentPlanTotalValue,
              handlePaymentMetaPurchaseEventPlanTotalValueChange
            )}

            <button
              type="button"
              className={[
                styles.paymentMetaEventInlineToggle,
                paymentMetaParamsOpen ? styles.paymentMetaEventInlineToggleActive : '',
                paymentMetaPurchaseEventHasParameters ? styles.paymentMetaEventInlineToggleFilled : ''
              ].filter(Boolean).join(' ')}
              aria-expanded={paymentMetaParamsOpen}
              onClick={() => setPaymentMetaParamsOpen(open => !open)}
            >
              <SlidersHorizontal size={14} />
              <span>Parámetros opcionales</span>
              <ChevronDown size={13} />
            </button>

            {paymentMetaParamsOpen && (
              <div className={styles.paymentMetaEventParameterPanel}>
                <div className={styles.paymentMetaEventParameterGrid}>
                  <label>
                    <span className={styles.paymentMetaEventParameterLabel}>Valor de conversión alterno</span>
                    <MetaParameterValueInput
                      value={paymentMetaPurchaseEventConfig.parameters.value}
                      placeholder="Ej. {{payment.amount}}"
                      inputMode="decimal"
                      variables={paymentMetaParameterVariables}
                      onChange={(value) => updatePaymentMetaPurchaseEventParameters({ value })}
                    />
                  </label>
                  <label>
                    <span className={styles.paymentMetaEventParameterLabel}>LTV estimado</span>
                    <MetaParameterValueInput
                      value={paymentMetaPurchaseEventConfig.parameters.predictedLtv}
                      placeholder="Ej. {{contact.custom.valor_ltv}}"
                      inputMode="decimal"
                      variables={paymentMetaParameterVariables}
                      onChange={(predictedLtv) => updatePaymentMetaPurchaseEventParameters({ predictedLtv })}
                    />
                  </label>
                </div>

                <div className={styles.paymentMetaEventCustomParameterHeader}>
                  <span className={styles.paymentMetaEventFieldTitle}>Parámetros extra</span>
                  <Button variant="secondary" size="sm" onClick={addPaymentMetaPurchaseEventParameterRow}>
                    <Plus size={14} />
                    Añadir parámetro
                  </Button>
                </div>

                <div className={styles.paymentMetaEventCustomParameterList}>
                  {paymentMetaPurchaseEventConfig.parameters.custom.length ? (
                    paymentMetaPurchaseEventConfig.parameters.custom.map(parameter => (
                      <div key={parameter.id} className={styles.paymentMetaEventCustomParameterRow}>
                        <input
                          className={styles.input}
                          value={parameter.key}
                          onChange={(event) => updatePaymentMetaPurchaseEventParameterRow(parameter.id, { key: event.target.value })}
                          placeholder="nombre_parametro"
                        />
                        <MetaParameterValueInput
                          value={parameter.value}
                          onChange={(value) => updatePaymentMetaPurchaseEventParameterRow(parameter.id, { value })}
                          placeholder="valor"
                          variables={paymentMetaParameterVariables}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removePaymentMetaPurchaseEventParameterRow(parameter.id)}
                          aria-label="Eliminar parámetro"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className={styles.paymentMetaEventCustomParameterEmpty}>
                      Sin parámetros extra. Ristak manda los datos base del pago automáticamente.
                    </p>
                  )}
                </div>
              </div>
            )}

            {paymentMetaPurchaseEventConfig.parameters.usePaymentPlanTotalValue && (
              <div className={styles.paymentMetaEventSmartHint}>
                <Info size={16} />
                <div>
                  <strong>Cómo se reportan los planes de pagos</strong>
                  <small>
                    Si el pago pertenece a un plan, Ristak manda a Meta el valor total del plan como compra.
                    Ese plan queda marcado con un identificador propio, así que los siguientes pagos parciales
                    se omiten para no duplicar conversiones ni inflar ingresos. Si apagas esta opción, cada pago
                    se reporta con el monto cobrado en ese momento.
                  </small>
                </div>
              </div>
            )}

            <div className={styles.paymentMetaEventSmartHint}>
              <Info size={16} />
              <div>
                <strong>Evento enviado: Purchase</strong>
                <small>
                  Para pagos completados no se elige otro evento ni se agregan eventos personalizados.
                  Ristak usa el evento estándar Purchase para mantener los reportes de compras limpios y comparables en Meta.
                </small>
              </div>
            </div>

            <div className={styles.paymentMetaEventSmartHint}>
              <Info size={16} />
              <div>
                <strong>Modo inteligente</strong>
                <small>
                  Si el contacto nació por WhatsApp con atribución, se manda Purchase por Business Messaging.
                  Si no se detecta ese origen, se manda desde Sitios con acción de Website.
                </small>
              </div>
            </div>

          </div>
        )}

        {renderSectionSaveBar('Guardar evento de Meta')}
      </Card>
    </div>
  )

  const renderReceiptSection = () => {
    const previewBaseAmount = 2490
    const previewTaxAmount = calculatePreviewTax(previewBaseAmount, taxes)
    const previewSubtotal = taxes.enabled && taxes.calculationMode === 'inclusive'
      ? Math.max(0, previewBaseAmount - previewTaxAmount)
      : previewBaseAmount
    const previewTotal = taxes.enabled && taxes.calculationMode === 'exclusive'
      ? previewBaseAmount + previewTaxAmount
      : previewBaseAmount
    const previewTaxLabel = taxes.taxName || 'Impuesto'
    const invoiceDesign = resolveInvoiceDesign(receipt)
    const invoiceSheetClassName = [
      styles.documentSheet,
      styles[invoiceTemplateClassById[invoiceDesign.template.id]]
    ].filter(Boolean).join(' ')
    const invoiceStyleVars = buildInvoiceStyleVars(receipt)

    return (
      <div className={`${styles.twoColumnLayout} ${styles.receiptDocumentLayout}`}>
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Comprobante de pago descargable</h2>
              <p>Configura la hoja PDF que {customerWithPlainArticle} podrá descargar desde la confirmación de pago.</p>
            </div>
            <Badge variant="success">
              <FileCheck2 size={14} />
              PDF
            </Badge>
          </div>

          {renderBusinessProfileSource(
            'Usar datos de Negocio',
            'Logo, nombre, contacto, web, dirección y términos se toman del perfil de negocio.',
            receipt.useBusinessProfile !== false,
            (next) => setReceiptValue('useBusinessProfile', next)
          )}

          <div className={styles.formGrid}>
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Logo del comprobante</span>
              <div className={styles.logoUploadControl}>
                <div className={styles.logoUploadPreview}>
                  {effectiveReceipt.logoUrl ? <img src={effectiveReceipt.logoUrl} alt="" /> : <Image size={22} />}
                </div>
                <div className={styles.logoUploadContent}>
                  <div className={styles.logoUploadActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => receiptLogoInputRef.current?.click()}
                      disabled={uploadingReceiptLogo || receipt.useBusinessProfile !== false}
                    >
                      {uploadingReceiptLogo ? (
                        <>
                          <Loader2 size={15} className={styles.spinIcon} />
                          Subiendo {receiptLogoUploadProgress > 0 ? `${receiptLogoUploadProgress}%` : ''}
                        </>
                      ) : (
                        <>
                          <ImageUp size={15} />
                          Subir logo
                        </>
                      )}
                    </Button>
                    {receipt.useBusinessProfile === false && receipt.logoUrl && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setReceiptValue('logoUrl', '')}>
                        <Trash2 size={15} />
                        Quitar
                      </Button>
                    )}
                  </div>
                  <input
                    ref={receiptLogoInputRef}
                    className={styles.fileInputHidden}
                    type="file"
                    accept="image/*"
                    onChange={handleReceiptLogoUpload}
                  />
                  <small>{receipt.useBusinessProfile === false ? 'Se guarda en Media y se usa en la hoja PDF del comprobante.' : 'Heredado desde Configuración > Negocio.'}</small>
                  {effectiveReceipt.logoUrl && (
                    <input
                      type="url"
                      value={effectiveReceipt.logoUrl}
                      onChange={(event) => setReceiptValue('logoUrl', event.target.value)}
                      disabled={receipt.useBusinessProfile !== false}
                      placeholder="https://tu-dominio.com/logo.png"
                    />
                  )}
                </div>
              </div>
            </div>

            {renderField(
              'Título del documento',
              <input
                type="text"
                value={receipt.title}
                onChange={(event) => setReceiptValue('title', event.target.value)}
                placeholder="Comprobante de pago"
              />
            )}
            {renderField(
              'Nota superior',
              <textarea
                value={receipt.intro}
                onChange={(event) => setReceiptValue('intro', event.target.value)}
                placeholder="Tu pago fue recibido correctamente."
              />
            )}
            {renderField(
              'Nombre del negocio',
              <input
                type="text"
                value={effectiveReceipt.businessName}
                onChange={(event) => setReceiptValue('businessName', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Nombre comercial"
              />
            )}
            {renderField(
              'Correo del negocio',
              <input
                type="email"
                value={effectiveReceipt.businessEmail}
                onChange={(event) => setReceiptValue('businessEmail', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="pagos@tu-negocio.com"
              />
            )}
            {renderField(
              'Teléfono del negocio',
              <input
                type="tel"
                value={effectiveReceipt.businessPhone}
                onChange={(event) => setReceiptValue('businessPhone', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="+52 656 000 0000"
              />
            )}
            {renderField(
              'Sitio web',
              <input
                type="url"
                value={effectiveReceipt.businessWebsite}
                onChange={(event) => setReceiptValue('businessWebsite', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="https://tu-negocio.com"
              />
            )}
            {renderField(
              'Dirección fiscal o comercial',
              <textarea
                value={effectiveReceipt.businessAddress}
                onChange={(event) => setReceiptValue('businessAddress', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Calle, ciudad, estado, país"
              />
            )}
            {renderField(
              'Nota al pie',
              <textarea
                value={receipt.footer}
                onChange={(event) => setReceiptValue('footer', event.target.value)}
                placeholder="Gracias por tu pago."
              />
            )}
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Términos y condiciones</span>
              <textarea
                className={styles.largeTextarea}
                value={effectiveReceipt.terms}
                onChange={(event) => setReceiptValue('terms', event.target.value)}
                disabled={receipt.useBusinessProfile !== false}
                placeholder="Políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio."
              />
              <small>Este texto puede ser largo y también se sincroniza como nota de términos para comprobantes de GoHighLevel cuando esté conectado.</small>
            </div>
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow('Mostrar datos del negocio', 'Incluye nombre, contacto y dirección en la hoja.', receipt.showBusinessInfo, (next) => setReceiptValue('showBusinessInfo', next))}
            {renderSwitchRow(`Mostrar datos ${customerWithArticle}`, 'Incluye nombre, correo y referencia del pago.', receipt.showCustomerInfo, (next) => setReceiptValue('showCustomerInfo', next))}
            {renderSwitchRow('Mostrar términos', 'Agrega términos al final del comprobante descargable.', receipt.showTerms, (next) => setReceiptValue('showTerms', next))}
          </div>

          {renderSectionSaveBar('Guardar comprobante')}
        </Card>

        <Card className={styles.documentPreviewCard}>
          <div className={styles.documentPreviewHeader}>
            <div>
              <h3>Vista de hoja</h3>
              <p>Así se imprime o guarda como PDF desde el link pagado.</p>
            </div>
            <div className={styles.documentPreviewActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handlePreviewReceipt}
                disabled={loadingSettings || previewingReceipt}
              >
                {previewingReceipt ? (
                  <>
                    <Loader2 size={14} className={styles.spinIcon} />
                    Abriendo...
                  </>
                ) : (
                  <>
                    <ExternalLink size={14} />
                    Previsualizar
                  </>
                )}
              </Button>
              <Badge variant="success">
                <CheckCircle size={14} />
                Pagado
              </Badge>
            </div>
          </div>

          <div className={styles.documentDesignPanel}>
            <div className={styles.designGroup}>
              <span>Diseño</span>
              <div className={styles.templateChooser}>
                {invoiceTemplateOptions.map((template) => {
                  const active = invoiceDesign.template.id === template.id

                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={active ? styles.templateOptionActive : styles.templateOption}
                      onClick={() => handleInvoiceTemplateSelect(template.id)}
                      aria-pressed={active}
                    >
                      <span className={`${styles.templateMini} ${styles[invoiceTemplateClassById[template.id]]}`} style={invoiceStyleVars}>
                        <i />
                        <b />
                        <em />
                      </span>
                      <strong>{template.label}</strong>
                      <small>{template.description}</small>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className={styles.designGroup}>
              <span>Paleta</span>
              <div className={styles.paletteChooser}>
                {invoicePaletteOptions.map((palette) => {
                  const active = receipt.invoicePalette === palette.id

                  return (
                    <button
                      key={palette.id}
                      type="button"
                      className={active ? styles.paletteOptionActive : styles.paletteOption}
                      onClick={() => handleInvoicePaletteSelect(palette.id)}
                      aria-pressed={active}
                    >
                      <span style={{ '--palette-accent': palette.accentColor, '--palette-paper': palette.paperColor, '--palette-ink': palette.textColor } as React.CSSProperties} />
                      <strong>{palette.label}</strong>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className={styles.colorControls}>
              <label>
                <span>Acento</span>
                <input
                  type="color"
                  value={invoiceDesign.accentColor}
                  onChange={(event) => patchReceiptValues({ invoicePalette: 'custom', invoiceAccentColor: event.target.value })}
                />
              </label>
              <label>
                <span>Papel</span>
                <input
                  type="color"
                  value={invoiceDesign.paperColor}
                  onChange={(event) => patchReceiptValues({ invoicePalette: 'custom', invoicePaperColor: event.target.value })}
                />
              </label>
              <label>
                <span>Texto</span>
                <input
                  type="color"
                  value={invoiceDesign.textColor}
                  onChange={(event) => patchReceiptValues({ invoicePalette: 'custom', invoiceTextColor: event.target.value })}
                />
              </label>
            </div>
          </div>

          <div className={styles.documentViewport}>
            <article className={invoiceSheetClassName} style={invoiceStyleVars} aria-label="Vista previa del comprobante de pago descargable">
              <header className={styles.documentSheetHeader}>
                <div className={styles.documentIdentity}>
                  {effectiveReceipt.logoUrl ? (
                    <img src={effectiveReceipt.logoUrl} alt="" />
                  ) : (
                    <span><ReceiptText size={22} /></span>
                  )}
                  <div>
                    <strong>{effectiveReceipt.businessName || 'Tu negocio'}</strong>
                    <p>{effectiveReceipt.businessWebsite || effectiveReceipt.businessEmail || 'tu-negocio.com'}</p>
                  </div>
                </div>
                <div className={styles.documentMeta}>
                  <h4>{receipt.title || 'Comprobante de pago'}</h4>
                  <span>PAY-1048</span>
                  <span>20 jun 2026</span>
                </div>
              </header>

              {receipt.intro && <p className={styles.documentIntro}>{receipt.intro}</p>}

              <section className={styles.documentPaymentMeta} aria-label="Datos del pago">
                <div>
                  <span>Estado</span>
                  <strong>Pagado</strong>
                </div>
                <div>
                  <span>Vencimiento</span>
                  <strong>8 jul 2026</strong>
                </div>
                <div>
                  <span>Pasarela</span>
                  <strong className={styles.platformValue}>
                    <PaymentPlatformLogo platform="stripe" size="sm" decorative />
                    <span>Stripe</span>
                  </strong>
                </div>
                <div>
                  <span>Moneda</span>
                  <strong>{accountCurrency}</strong>
                </div>
              </section>

              <section className={styles.documentParties}>
                {receipt.showBusinessInfo && (
                  <div>
                    <span>Emitido por</span>
                    <strong>{effectiveReceipt.businessName || 'Tu negocio'}</strong>
                    {effectiveReceipt.businessEmail && <p>{effectiveReceipt.businessEmail}</p>}
                    {effectiveReceipt.businessPhone && <p>{effectiveReceipt.businessPhone}</p>}
                    {effectiveReceipt.businessAddress && <p>{effectiveReceipt.businessAddress}</p>}
                  </div>
                )}
                {receipt.showCustomerInfo && (
                  <div>
                    <span>{customerLabel}</span>
                    <strong>María López</strong>
                    <p>maria@ejemplo.com</p>
                    <p>Referencia PAY-1048</p>
                  </div>
                )}
              </section>

              <section className={styles.documentLines} aria-label="Detalle del pago">
                <div className={styles.documentLineHead}>
                  <span>Concepto</span>
                  <span>Cant.</span>
                  <span>Importe</span>
                </div>
                <div className={styles.documentLineRow}>
                  <strong>Plan mensual</strong>
                  <span>1</span>
                  <span>{formatCompactMoney(previewSubtotal, accountCurrency)}</span>
                </div>
              </section>

              <section className={styles.documentTotals} aria-label="Totales">
                <div>
                  <span>Subtotal</span>
                  <strong>{formatCompactMoney(previewSubtotal, accountCurrency)}</strong>
                </div>
                {taxes.enabled && (
                  <div>
                    <span>{taxes.calculationMode === 'inclusive' ? `${previewTaxLabel} incluido` : previewTaxLabel}</span>
                    <strong>{formatCompactMoney(previewTaxAmount, accountCurrency)}</strong>
                  </div>
                )}
                <div>
                  <span>Total pagado</span>
                  <strong>{formatCompactMoney(previewTotal, accountCurrency)}</strong>
                </div>
              </section>

              {receipt.showTerms && (
                <section className={styles.documentTerms}>
                  <strong>Términos y condiciones</strong>
                  <p>{effectiveReceipt.terms || 'Agrega aquí políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio.'}</p>
                </section>
              )}

              {receipt.footer && <p className={styles.documentFooter}>{receipt.footer}</p>}
            </article>
          </div>
        </Card>
      </div>
    )
  }

  const renderAutomationQrFallbackControl = (
    key: 'reminderQrFallbackEnabled' | 'receiptQrFallbackEnabled' | 'failedPaymentQrFallbackEnabled',
    checked: boolean,
    channel: PaymentAutomationSettings['reminderChannel']
  ) => {
    if (!channelUsesWhatsApp(channel)) return null

    if (channelUsesWhatsappQrOnly(channel) || !whatsappAvailability.canShowQrFallbackSwitch) return null

    return renderSwitchRow(
      'Usar QR como respaldo',
      'Si WhatsApp API no está disponible, Ristak intentará enviar el mensaje por QR.',
      checked,
      (next) => setAutomationQrFallbackValue(key, next)
    )
  }

  const getAutomationWhatsAppHelp = (
    channel: PaymentAutomationSettings['reminderChannel'],
    apiHelp: string
  ) => {
    if (!channelUsesWhatsApp(channel)) return undefined
    if (channelUsesWhatsappQrOnly(channel)) return 'Usa WhatsApp QR como canal principal. No requiere plantilla aprobada de Meta ni ventana de 24 horas.'
    if (whatsappAvailability.hasApiConnected) return apiHelp
    if (whatsappAvailability.hasQrConnected) return 'WhatsApp enviará el texto del mensaje por QR.'
    return 'Conecta WhatsApp API o WhatsApp QR para enviar mensajes por WhatsApp desde esta automatización.'
  }

  const getAutomationTemplateValue = (kind: PaymentAutomationTemplateKind) => {
    const template = paymentAutomationTemplateDefaults[kind]
    const id = String(automations[template.templateIdKey] || '')
    const name = String(automations[template.templateNameKey] || template.defaultName)
    return id || name
  }

  const getAutomationTemplateName = (kind: PaymentAutomationTemplateKind) => {
    const template = paymentAutomationTemplateDefaults[kind]
    return String(automations[template.templateNameKey] || template.defaultName)
  }

  const getAutomationContentMode = (kind: PaymentAutomationTemplateKind) => {
    const template = paymentAutomationTemplateDefaults[kind]
    return automations[template.contentModeKey] === 'direct' ? 'direct' : 'template'
  }

  const setAutomationContentMode = (kind: PaymentAutomationTemplateKind, value: 'template' | 'direct') => {
    const template = paymentAutomationTemplateDefaults[kind]
    patchAutomationValues({ [template.contentModeKey]: value } as Partial<PaymentAutomationSettings>)
  }

  const getAutomationDirectMessage = (kind: PaymentAutomationTemplateKind) => {
    const template = paymentAutomationTemplateDefaults[kind]
    return String(automations[template.messageTextKey] || template.defaultMessageText)
  }

  const setAutomationDirectMessage = (kind: PaymentAutomationTemplateKind, value: string) => {
    const template = paymentAutomationTemplateDefaults[kind]
    patchAutomationValues({ [template.messageTextKey]: value } as Partial<PaymentAutomationSettings>)
  }

  const getAutomationContentSummary = (
    kind: PaymentAutomationTemplateKind,
    channel: PaymentAutomationSettings['reminderChannel']
  ) => {
    if (getAutomationContentMode(kind) === 'direct') return 'mensaje directo'
    if (channelUsesWhatsApp(channel)) return getAutomationTemplateName(kind)
    return 'mensaje predeterminado'
  }

  const setAutomationTemplateValue = (kind: PaymentAutomationTemplateKind, value: string) => {
    const config = paymentAutomationTemplateDefaults[kind]
    const selectedTemplate = paymentWhatsappTemplates.find((template) => (
      template.id === value || template.name === value
    ))
    const selectedDefault = Object.values(paymentAutomationTemplateDefaults).find((template) => template.defaultName === value)
    const patch = {
      [config.templateIdKey]: selectedTemplate?.id || '',
      [config.templateNameKey]: selectedTemplate?.name || selectedDefault?.defaultName || value || config.defaultName,
      [config.templateLanguageKey]: selectedTemplate?.language || selectedDefault?.defaultLanguage || config.defaultLanguage
    } as Partial<PaymentAutomationSettings>

    patchAutomationValues(patch)
  }

  const openPaymentTemplateEditor = (kind: PaymentAutomationTemplateKind) => {
    const config = paymentAutomationTemplateDefaults[kind]
    const templateId = String(automations[config.templateIdKey] || '')
    const templateName = String(automations[config.templateNameKey] || config.defaultName)
    const params = new URLSearchParams()

    if (templateId) {
      params.set('template', templateId)
    } else if (templateName) {
      params.set('templateName', templateName)
    }

    navigate(`/settings/whatsapp/templates${params.toString() ? `?${params.toString()}` : ''}`)
  }

  const openNewPaymentTemplate = () => {
    navigate('/settings/whatsapp/templates?action=new')
  }

  const renderAutomationTemplateControl = (
    kind: PaymentAutomationTemplateKind,
    channel: PaymentAutomationSettings['reminderChannel']
  ) => {
    const config = paymentAutomationTemplateDefaults[kind]
    const mode = getAutomationContentMode(kind)
    const usesWhatsApp = channelUsesWhatsApp(channel)
    const usesQrOnly = channelUsesWhatsappQrOnly(channel)
    const value = getAutomationTemplateValue(kind)
    const selectedTemplate = paymentWhatsappTemplates.find((template) => (
      template.id === value || template.name === value
    ))
    const templateName = selectedTemplate?.name || getAutomationTemplateName(kind)

    return (
      <div className={styles.automationTemplateBlock}>
        {renderField(
          'Contenido',
          <CustomSelect
            value={mode}
            onValueChange={(nextValue) => setAutomationContentMode(kind, nextValue as 'template' | 'direct')}
            options={[
              { value: 'template', label: usesQrOnly ? 'Plantilla como texto QR' : usesWhatsApp ? 'Plantilla / predeterminado' : 'Mensaje predeterminado' },
              { value: 'direct', label: 'Escribir mensaje propio' }
            ]}
          />,
          mode === 'direct'
            ? usesWhatsApp
              ? usesQrOnly
                ? 'Usará este texto por WhatsApp QR como canal principal, sin aprobación de Meta ni ventana de 24 horas.'
                : 'Usará este texto. Con WhatsApp API activa necesita conversación abierta de 24 horas; el QR sólo entra si la API deja de estar disponible.'
              : 'Usará el texto que escribas aquí para los canales seleccionados.'
            : usesWhatsApp
              ? usesQrOnly
                ? 'WhatsApp QR usará el texto del mensaje seleccionado, no una plantilla API aprobada.'
                : 'WhatsApp usará plantilla; correo usará el mensaje predeterminado del sistema.'
              : 'Correo usará el mensaje predeterminado del sistema.'
        )}

        {mode === 'direct' ? (
          renderField(
            'Mensaje propio',
            <textarea
              value={getAutomationDirectMessage(kind)}
              onChange={(event) => setAutomationDirectMessage(kind, event.target.value)}
              placeholder={`Escribe aquí el mensaje para ${config.label.toLowerCase()}.`}
            />,
            'Variables disponibles: {{contact.first_name}}, {{payment.amount}}, {{payment.product}}, {{payment.url}}, {{payment.receipt_url}}.'
          )
        ) : usesWhatsApp ? (
          <>
        {renderField(
          usesQrOnly ? 'Mensaje de WhatsApp QR' : whatsappAvailability.hasApiConnected ? 'Plantilla WhatsApp API' : 'Mensaje de WhatsApp',
          <CustomSelect
            value={value}
            onValueChange={(nextValue) => setAutomationTemplateValue(kind, nextValue)}
            options={paymentWhatsappTemplateOptions}
            placeholder={loadingPaymentWhatsappTemplates ? 'Cargando plantillas...' : 'Selecciona una plantilla'}
            disabled={loadingPaymentWhatsappTemplates && paymentWhatsappTemplateOptions.length === 0}
          />,
          selectedTemplate
            ? usesQrOnly
              ? `Usará el texto de ${selectedTemplate.name} (${selectedTemplate.language || config.defaultLanguage}) por QR.`
              : `Usará ${selectedTemplate.name} (${selectedTemplate.language || config.defaultLanguage}).`
            : usesQrOnly
              ? `Usará el texto del mensaje ${templateName} por QR.`
              : whatsappAvailability.hasQrConnected && !whatsappAvailability.hasApiConnected
              ? `Usará el texto del mensaje predeterminado ${templateName}.`
              : `Usará la plantilla predeterminada ${templateName}.`
        )}
        <div className={styles.automationTemplateActions}>
          <Button type="button" variant="secondary" size="sm" onClick={() => openPaymentTemplateEditor(kind)}>
            <FileCheck2 size={15} />
            Editar mensaje
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={openNewPaymentTemplate}>
            <Sparkles size={15} />
            Crear propia
          </Button>
        </div>
        {loadingPaymentWhatsappTemplates && (
          <span className={styles.automationTemplateLoading}>
            <Loader2 size={14} />
            Cargando plantillas aprobadas
          </span>
        )}
          </>
        ) : (
          <span className={styles.automationTemplateLoading}>
            Correo usará el mensaje predeterminado de {config.label.toLowerCase()}.
          </span>
        )}
      </div>
    )
  }

  const getAutomationTransportSummary = (
    channel: PaymentAutomationSettings['reminderChannel'],
    qrFallbackEnabled: boolean
  ) => {
    if (!channelUsesWhatsApp(channel)) return ''
    if (channelUsesWhatsappQrOnly(channel)) return ' · QR solo'
    if (whatsappAvailability.canShowQrFallbackSwitch && qrFallbackEnabled) return ' · QR respaldo'
    if (whatsappAvailability.hasQrConnected && !whatsappAvailability.hasApiConnected) return ' · QR'
    return ''
  }

  const renderAutomationsSection = () => (
    <div className={styles.singleColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Automatizaciones de pago</h2>
            <p>Separa lo que pasa antes del vencimiento, después de pagar y cuando un cobro falla.</p>
          </div>
          <Badge variant={whatsappAvailability.hasApiConnected || whatsappAvailability.hasQrConnected ? 'success' : 'neutral'}>
            <BellRing size={14} />
            {whatsappAvailability.hasApiConnected
              ? 'WhatsApp API primero'
              : whatsappAvailability.hasQrConnected
                ? 'WhatsApp QR activo'
                : 'WhatsApp pendiente'}
          </Badge>
        </div>

        <div className={styles.automationColumns}>
          <section className={styles.automationColumn}>
            <div className={styles.automationColumnHeader}>
              <Clock size={18} />
              <div>
                <h3>Antes del pago</h3>
                <p>Recordatorios previos al vencimiento.</p>
              </div>
            </div>
            <div className={styles.automationColumnBody}>
              {renderSwitchRow('Enviar recordatorios', 'Avisa antes de que llegue la fecha de pago.', automations.remindersEnabled, (next) => setAutomationValue('remindersEnabled', next))}
              {renderField(
                'Días antes del vencimiento',
                <NumberInput
                  min="1"
                  max="60"
                  value={automations.reminderDaysBefore}
                  onValueChange={(value) => setAutomationValue('reminderDaysBefore', Math.trunc(value) || 1)}
                />
              )}
              {renderField(
                'Canal',
                <CustomSelect
                  value={automations.reminderChannel}
                  onValueChange={(value) => setAutomationValue('reminderChannel', value as PaymentAutomationSettings['reminderChannel'])}
                  options={channelOptions}
                />,
                getAutomationWhatsAppHelp(automations.reminderChannel, 'Los mensajes de WhatsApp salen por WhatsApp API.')
              )}
              {renderAutomationTemplateControl('reminder', automations.reminderChannel)}
              {renderAutomationQrFallbackControl(
                'reminderQrFallbackEnabled',
                automations.reminderQrFallbackEnabled,
                automations.reminderChannel
              )}
            </div>
          </section>

          <section className={styles.automationColumn}>
            <div className={styles.automationColumnHeader}>
              <CheckCircle size={18} />
              <div>
                <h3>Después del pago</h3>
                <p>Comprobante y acción cuando el pago queda confirmado.</p>
              </div>
            </div>
            <div className={styles.automationColumnBody}>
              {renderSwitchRow('Enviar comprobante', 'Manda el comprobante cuando el pago se confirme.', automations.receiptDeliveryEnabled, (next) => setAutomationValue('receiptDeliveryEnabled', next))}
              {renderField(
                'Canal del comprobante',
                <CustomSelect
                  value={automations.receiptDeliveryChannel}
                  onValueChange={(value) => setAutomationValue('receiptDeliveryChannel', value as PaymentAutomationSettings['receiptDeliveryChannel'])}
                  options={channelOptions}
                />,
                getAutomationWhatsAppHelp(automations.receiptDeliveryChannel, 'El comprobante por WhatsApp usa WhatsApp API como ruta principal.')
              )}
              {renderAutomationTemplateControl('receipt', automations.receiptDeliveryChannel)}
              {renderAutomationQrFallbackControl(
                'receiptQrFallbackEnabled',
                automations.receiptQrFallbackEnabled,
                automations.receiptDeliveryChannel
              )}
              {renderField(
                'Acción después del pago',
                <CustomSelect
                  value={automations.afterPaymentAction}
                  onValueChange={(value) => setAutomationValue('afterPaymentAction', value as PaymentAutomationSettings['afterPaymentAction'])}
                  options={[
                    { value: 'send_receipt', label: 'Enviar comprobante' },
                    { value: 'start_automation', label: 'Iniciar automatización' },
                    { value: 'tag_contact', label: 'Etiquetar contacto' },
                    { value: 'none', label: 'No hacer nada' }
                  ]}
                />
              )}
              {renderField(
                'Mensaje después del pago',
                <textarea
                  value={automations.afterPaymentMessage}
                  onChange={(event) => setAutomationValue('afterPaymentMessage', event.target.value)}
                  placeholder={`Mensaje que recibirá ${customerWithPlainArticle} cuando el pago entre.`}
                />
              )}
            </div>
          </section>

          <section className={styles.automationColumn}>
            <div className={styles.automationColumnHeader}>
              <AlertTriangle size={18} />
              <div>
                <h3>Cobro fallido</h3>
                <p>Seguimiento cuando la tarjeta o el cobro automático falla.</p>
              </div>
            </div>
            <div className={styles.automationColumnBody}>
              {renderSwitchRow('Avisar si falla', 'Prepara una regla para cobros rechazados.', automations.failedPaymentEnabled, (next) => setAutomationValue('failedPaymentEnabled', next))}
              {renderField(
                'Horas después del fallo',
                <NumberInput
                  min="1"
                  max="168"
                  value={automations.failedPaymentDelayHours}
                  onValueChange={(value) => setAutomationValue('failedPaymentDelayHours', Math.trunc(value) || 1)}
                />
              )}
              {renderField(
                'Canal',
                <CustomSelect
                  value={automations.failedPaymentChannel}
                  onValueChange={(value) => setAutomationValue('failedPaymentChannel', value as PaymentAutomationSettings['failedPaymentChannel'])}
                  options={channelOptions}
                />,
                getAutomationWhatsAppHelp(automations.failedPaymentChannel, 'El aviso por WhatsApp usa WhatsApp API como ruta principal.')
              )}
              {renderAutomationTemplateControl('failed', automations.failedPaymentChannel)}
              {renderAutomationQrFallbackControl(
                'failedPaymentQrFallbackEnabled',
                automations.failedPaymentQrFallbackEnabled,
                automations.failedPaymentChannel
              )}
            </div>
          </section>
        </div>

        {renderSectionSaveBar('Guardar automatizaciones')}
      </Card>

      <div className={styles.summaryStrip}>
        <div>
          <Clock size={17} />
          <strong>{automations.remindersEnabled ? `${automations.reminderDaysBefore} días antes` : 'Recordatorios apagados'}</strong>
          <span>{channelLabelById[automations.reminderChannel]} · {getAutomationContentSummary('reminder', automations.reminderChannel)}{getAutomationTransportSummary(automations.reminderChannel, automations.reminderQrFallbackEnabled)}</span>
        </div>
        <div>
          <CheckCircle size={17} />
          <strong>{automations.receiptDeliveryEnabled ? 'Comprobante activo' : 'Comprobante apagado'}</strong>
          <span>{afterPaymentActionLabelById[automations.afterPaymentAction]} · {channelLabelById[automations.receiptDeliveryChannel]} · {getAutomationContentSummary('receipt', automations.receiptDeliveryChannel)}{getAutomationTransportSummary(automations.receiptDeliveryChannel, automations.receiptQrFallbackEnabled)}</span>
        </div>
        <div>
          <AlertTriangle size={17} />
          <strong>{automations.failedPaymentEnabled ? `${automations.failedPaymentDelayHours} h tras fallo` : 'Sin seguimiento'}</strong>
          <span>{channelLabelById[automations.failedPaymentChannel]} · {getAutomationContentSummary('failed', automations.failedPaymentChannel)}{getAutomationTransportSummary(automations.failedPaymentChannel, automations.failedPaymentQrFallbackEnabled)}</span>
        </div>
      </div>
    </div>
  )

  const renderGatewaysSection = () => (
    <div className={styles.singleColumnLayout}>
      {activeGatewayRoute && (
        <div className={styles.gatewayDetailBar}>
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate('/settings/payments/gateways')}>
            <ArrowLeft size={16} />
            Volver
          </Button>
        </div>
      )}

      {!activeGatewayRoute && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.gatewayTitleRow}>
                <h2>Pasarela de pagos</h2>
                <Badge variant={paymentMode === 'live' ? 'success' : 'warning'}>
                  <Clock size={14} />
                  {paymentModeCopy.badge}
                </Badge>
              </div>
              <p>Elige con qué proveedor se cobran links, tarjetas, parcialidades y suscripciones. Nuevos cobros en {paymentModeCopy.title.toLowerCase()}.</p>
            </div>
            <div className={styles.paymentModeControl}>
              <span className={paymentMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch
                checked={paymentMode === 'live'}
                onChange={(next) => void handlePaymentModeChange(next ? 'live' : 'test')}
                disabled={savingPaymentMode || savingSettings}
                aria-label="Cambiar modo global de pasarelas"
              />
              <span className={paymentMode === 'live' ? styles.modeActive : ''}>En vivo</span>
            </div>
          </div>

          <div className={styles.gatewayList}>
            {gatewayOptions.map((gateway) => {
              const statusCopy = gatewayStatusCopy[gateway.status]

              return (
                <Card
                  key={gateway.id}
                  className={`${styles.gatewayItem} ${styles.gatewayItemInteractive}`}
                  padding="md"
                  role="button"
                  tabIndex={0}
                  aria-label={`Abrir configuración de ${gateway.name}`}
                  onClick={() => handleSelectGateway(gateway)}
                  onKeyDown={(event) => handleGatewayCardKeyDown(event, gateway)}
                >
                  <div className={styles.gatewayItemIdentity}>
                    {gateway.logo && (
                      <PaymentPlatformLogo platform={gateway.logo} size="lg" decorative />
                    )}
                    <div className={styles.gatewayItemCopy}>
                      <div className={styles.gatewayItemTitleRow}>
                        <strong>{gateway.name}</strong>
                      </div>
                      <p>{gateway.description}</p>
                    </div>
                  </div>
                  <div className={styles.gatewayItemActions}>
                    <Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
                  </div>
                </Card>
              )
            })}
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'highlevel' && !highLevelConnected && (
        <Card className={styles.noticeCard}>
          <AlertTriangle size={18} />
          <div>
            <strong>Comprobantes de GoHighLevel opcionales</strong>
            <p>Esta sección sólo aplica si quieres administrar comprobantes de GoHighLevel. Los cobros de Ristak pueden operar con las pasarelas conectadas.</p>
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'highlevel' && highLevelConnected && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Comprobantes de GoHighLevel</h2>
              <p>Personaliza cómo se generan documentos, vencimientos y cargos de domiciliación.</p>
            </div>
          </div>

          <div className={styles.formGrid}>
            {renderField(
              'Título del documento',
              <input
                type="text"
                value={paymentTitle}
                onChange={(event) => setPaymentTitle(event.target.value)}
                placeholder="PAGO, COMPROBANTE, RECIBO"
              />
            )}
            {renderField(
              'Prefijo de número de pago',
              <input
                type="text"
                value={paymentNumberPrefix}
                onChange={(event) => setPaymentNumberPrefix(event.target.value)}
                placeholder="INV-"
              />
            )}
            {renderField(
              'Días para vencimiento',
              <NumberInput
                min="1"
                value={paymentDueDays}
                onValueChange={(value) => setPaymentDueDays(Math.trunc(value) || 7)}
              />
            )}
            {renderField(
              'URL para transferencias',
              <input
                type="url"
                value={transferInfoUrl}
                onChange={(event) => setTransferInfoUrl(event.target.value)}
                placeholder="https://tu-sitio.com/como-transferir"
              />
            )}
            {renderField(
              'Monto para domiciliar tarjeta',
              <NumberInput
                min="1"
                step="0.01"
                value={cardSetupAmount}
                onValueChange={(value) => setCardSetupAmount(value || 25)}
              />,
              'Se cobra cuando hace falta guardar o autorizar una tarjeta antes de activar parcialidades automáticas.'
            )}
          </div>

          <div className={styles.sectionSaveBar}>
            <span>Guarda esta configuración dentro de la integración de GoHighLevel.</span>
            <Button type="button" onClick={handleSaveHighLevelGatewayConfig} disabled={savingHighLevelConfig}>
              {savingHighLevelConfig ? (
                <>
                  <Loader2 size={16} className={styles.spinIcon} />
                  Guardando...
                </>
              ) : (
                'Guardar GoHighLevel'
              )}
            </Button>
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'stripe' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="stripe" size="lg" decorative />
              <div>
                <h2>Stripe</h2>
                <p>Pega tus llaves de Stripe. Ristak deja la conexión lista automáticamente para cobrar con links, planes y suscripciones.</p>
              </div>
            </div>
            <Badge variant={stripeStatusBadge.variant}>
              {stripeStatusBadge.icon}
              {stripeStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.stripeModeGrid}>
              {stripeModeIds.map((mode) => {
                const modeCopy = stripeModeLabels[mode]
                const values = stripeManualCredentials[mode]
                const savedMode = stripeConfig?.manualModes?.[mode]
                const modeSaved = stripeModeIsSaved(mode)
                const modeIsSaving = savingStripeMode === mode
                const modeIsDisconnecting = disconnectingStripeMode === mode

                return (
                  <div key={mode} className={styles.stripeModePanel}>
                    <div className={styles.stripeModeHeader}>
                      <div>
                        <h3>{modeCopy.title}</h3>
                        <p>{modeCopy.description}</p>
                      </div>
                    </div>

                    <div className={styles.formGrid}>
                      {renderField(
                        'Publishable key',
                        <input
                          type="text"
                          value={values.publishableKey}
                          onChange={(event) => updateStripeModeCredential(mode, 'publishableKey', event.target.value)}
                          placeholder={modeCopy.publishablePlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      )}
                      {renderField(
                        'Secret key',
                        <input
                          type="password"
                          value={values.secretKey}
                          onChange={(event) => updateStripeModeCredential(mode, 'secretKey', event.target.value)}
                          onFocus={(event) => {
                            if (savedMode?.secretKeyPreview && values.secretKey === savedMode.secretKeyPreview) event.currentTarget.select()
                          }}
                          placeholder={savedMode?.hasSecretKey ? savedMode.secretKeyPreview : modeCopy.secretPlaceholder}
                          autoComplete="new-password"
                          spellCheck={false}
                        />
                      )}
                    </div>

                    <div className={styles.stripeModeActions}>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleSaveStripeModeConfig(mode)}
                        disabled={modeIsSaving || Boolean(disconnectingStripeMode) || !stripeModeCanSave(mode)}
                      >
                        {modeIsSaving ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Guardando...
                          </>
                        ) : (
                          modeSaved ? 'Guardar cambios' : 'Guardar configuración'
                        )}
                      </Button>
                      {modeSaved && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDisconnectStripeMode(mode)}
                          disabled={modeIsDisconnecting || Boolean(savingStripeMode)}
                        >
                          {modeIsDisconnecting ? (
                            <>
                              <Loader2 size={15} className={styles.spinIcon} />
                              Desconectando...
                            </>
                          ) : (
                            <>
                              <Unplug size={15} />
                              Desconectar
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

          </div>
        </Card>
      )}

      {activeGatewayRoute === 'conekta' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="conekta" size="lg" decorative />
              <div>
                <h2>Conekta</h2>
                <p>Pega tus llaves de Conekta. Ristak deja la conexión lista automáticamente para cobrar con tarjetas, links y suscripciones.</p>
              </div>
            </div>
            <Badge variant={conektaStatusBadge.variant}>
              {conektaStatusBadge.icon}
              {conektaStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.stripeModeGrid}>
              {stripeModeIds.map((mode) => {
                const modeCopy = conektaModeLabels[mode]
                const values = conektaManualCredentials[mode]
                const savedMode = conektaConfig?.manualModes?.[mode]
                const modeSaved = conektaModeIsSaved(mode)
                const modeIsSaving = savingConektaMode === mode
                const modeIsDisconnecting = disconnectingConektaMode === mode

                return (
                  <div key={mode} className={styles.stripeModePanel}>
                    <div className={styles.stripeModeHeader}>
                      <div>
                        <h3>{modeCopy.title}</h3>
                        <p>{modeCopy.description}</p>
                      </div>
                    </div>

                    <div className={styles.formGrid}>
                      {renderField(
                        'Llave pública',
                        <input
                          type="text"
                          value={values.publicKey}
                          onChange={(event) => updateConektaModeCredential(mode, 'publicKey', event.target.value)}
                          placeholder={modeCopy.publicPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      )}
                      {renderField(
                        'Llave privada',
                        <input
                          type="password"
                          value={values.privateKey}
                          onChange={(event) => updateConektaModeCredential(mode, 'privateKey', event.target.value)}
                          onFocus={(event) => {
                            if (savedMode?.privateKeyPreview && values.privateKey === savedMode.privateKeyPreview) event.currentTarget.select()
                          }}
                          placeholder={savedMode?.hasPrivateKey ? savedMode.privateKeyPreview : modeCopy.privatePlaceholder}
                          autoComplete="new-password"
                          spellCheck={false}
                        />
                      )}
                    </div>

                    <div className={styles.stripeModeActions}>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleSaveConektaModeConfig(mode)}
                        disabled={modeIsSaving || Boolean(disconnectingConektaMode) || !conektaModeCanSave(mode)}
                      >
                        {modeIsSaving ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Guardando...
                          </>
                        ) : (
                          modeSaved ? 'Guardar cambios' : 'Guardar configuración'
                        )}
                      </Button>
                      {modeSaved && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDisconnectConektaMode(mode)}
                          disabled={modeIsDisconnecting || Boolean(savingConektaMode)}
                        >
                          {modeIsDisconnecting ? (
                            <>
                              <Loader2 size={15} className={styles.spinIcon} />
                              Desconectando...
                            </>
                          ) : (
                            <>
                              <Unplug size={15} />
                              Desconectar
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

          </div>
        </Card>
      )}

      {activeGatewayRoute === 'mercadopago' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="mercadopago" size="lg" decorative />
              <div>
                <h2>Mercado Pago</h2>
                <p>Conecta Mercado Pago para crear links de pago y suscripciones desde Ristak.</p>
              </div>
            </div>
            <Badge variant={mercadoPagoStatusBadge.variant}>
              {mercadoPagoStatusBadge.icon}
              {mercadoPagoStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            {(() => {
              const modeConnection = mercadoPagoConfig?.modeConnections?.[paymentMode]
              const modeConnected = mercadoPagoModeIsConnected(paymentMode)
              const accountLabel = modeConnection?.accountLabel || mercadoPagoConfig?.accountLabel || 'Mercado Pago'
              const userId = modeConnection?.userId || mercadoPagoConfig?.userId || 'Cuenta conectada'
              const tokenLabel = (modeConnection?.hasRefreshToken ?? mercadoPagoConfig?.hasRefreshToken) ? 'Renovable' : 'Activo'

              return (
                <div className={styles.mercadoPagoConnectionPanel}>
                  <div className={styles.stripeModeHeader}>
                    <div>
                      <h3>{paymentMode === 'test' ? 'Conexión de prueba' : 'Conexión en vivo'}</h3>
                      <p>{paymentModeCopy.mercadoPagoHelp}</p>
                    </div>
                  </div>

                  {modeConnected && (
                    <div className={styles.connectionSummary}>
                      <div>
                        <span>Cuenta</span>
                        <strong>{accountLabel}</strong>
                      </div>
                      <div>
                        <span>Usuario</span>
                        <strong>{userId}</strong>
                      </div>
                      <div>
                        <span>Token OAuth</span>
                        <strong>{tokenLabel}</strong>
                      </div>
                    </div>
                  )}

                  <div className={styles.inlineWarning}>
                    <AlertTriangle size={16} />
                    <span>
                      {paymentMode === 'test'
                        ? 'En prueba, los pagos únicos se validan con tarjeta de prueba. Las suscripciones requieren comprador y vendedor test separados en Mercado Pago.'
                        : 'Este modo usa tu cuenta real de Mercado Pago. Los links y suscripciones nuevos pueden generar cobros reales.'}
                    </span>
                  </div>

                  {paymentMode === 'test' && (
                    <div className={styles.mercadoPagoTestLayout}>
                      <section className={styles.mercadoPagoTestColumn}>
                        <div className={styles.mercadoPagoTestColumnHeader}>
                          <div className={styles.mercadoPagoTestHeading}>
                            <span className={styles.mercadoPagoTestIcon}>
                              <CreditCard size={16} />
                            </span>
                            <div>
                              <strong>Pagos únicos test</strong>
                              <span>OAuth normal de Mercado Pago + tarjetas de prueba.</span>
                            </div>
                          </div>
                          <Badge variant="info">Simple</Badge>
                        </div>
                        <ol className={styles.mercadoPagoTestGuideSteps}>
                          {mercadoPagoSinglePaymentTestSteps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                        <p className={styles.mercadoPagoTestGuideNote}>
                          Si el comprador escribe otro correo, Mercado Pago lo usa como correo del pagador.
                          Ristak mantiene el pago ligado al contacto y al link original.
                        </p>

                        <div className={styles.mercadoPagoTestLinkRow}>
                          <div>
                            <strong>Suscripciones test</strong>
                            <span>Abre la guía, webhook y credenciales del vendedor test.</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            leftIcon={<FileCheck2 size={15} />}
                            onClick={() => setMercadoPagoSubscriptionTestModalOpen(true)}
                          >
                            Probar suscripciones test
                          </Button>
                        </div>
                      </section>
                    </div>
                  )}

                  <div className={styles.stripeModeActions}>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleConnectMercadoPago}
                      disabled={connectingMercadoPago || disconnectingMercadoPago}
                    >
                      {connectingMercadoPago ? (
                        <>
                          <Loader2 size={15} className={styles.spinIcon} />
                          Abriendo...
                        </>
                      ) : (
                        <>
                          <ExternalLink size={15} />
                          {modeConnected ? 'Reconectar cuenta' : 'Conectar cuenta'}
                        </>
                      )}
                    </Button>
                    {modeConnected && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleDisconnectMercadoPago}
                        disabled={disconnectingMercadoPago || connectingMercadoPago}
                      >
                        {disconnectingMercadoPago ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Desconectando...
                          </>
                        ) : (
                          <>
                            <Unplug size={15} />
                            Desconectar
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'clip' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="clip" size="lg" decorative />
              <div>
                <h2>CLIP</h2>
                <p>Configura el SDK de Checkout Transparente de CLIP para pagos únicos en MXN y pago inicial de suscripciones internas.</p>
              </div>
            </div>
            <Badge variant={clipStatusBadge.variant}>
              {clipStatusBadge.icon}
              {clipStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.inlineWarning}>
              <Info size={16} />
              <span>Usa la Clave API visible del panel de CLIP; la clave secreta no se necesita para el SDK. El cobro real se hace cuando {customerWithPlainArticle} paga y requiere correo/teléfono.</span>
            </div>

            <div className={styles.stripeModeGrid}>
              {stripeModeIds.map((mode) => {
                const modeCopy = clipModeLabels[mode]
                const values = clipManualCredentials[mode]
                const savedMode = clipConfig?.modeConnections?.[mode]
                const modeSaved = clipModeIsSaved(mode)
                const modeIsSaving = savingClipMode === mode
                const modeIsTesting = testingClipMode === mode
                const modeIsDisconnecting = disconnectingClipMode === mode

                return (
                  <div key={mode} className={styles.stripeModePanel}>
                    <div className={styles.stripeModeHeader}>
                      <div>
                        <h3>{modeCopy.title}</h3>
                        <p>{modeCopy.description}</p>
                      </div>
                    </div>

                    {modeSaved && (
                      <div className={styles.connectionSummary}>
                        <div>
                          <span>Cuenta</span>
                          <strong>{savedMode?.accountLabel || clipConfig?.accountLabel || 'CLIP'}</strong>
                        </div>
                        <div>
                          <span>Clave API</span>
                          <strong>{savedMode?.apiKeyPreview || clipConfig?.apiKeyPreview || 'Guardada'}</strong>
                        </div>
                      </div>
                    )}

                    <div className={styles.formGrid}>
                      {renderField(
                        'Nombre de la clave',
                        <input
                          type="text"
                          value={values.accountLabel}
                          onChange={(event) => updateClipModeCredential(mode, 'accountLabel', event.target.value)}
                          placeholder={mode === 'live' ? 'CLIP en vivo' : 'CLIP prueba'}
                          autoComplete="off"
                          spellCheck={false}
                        />,
                        'Ponle un nombre para reconocer esta clave dentro de Ristak.'
                      )}
                      {renderField(
                        'Clave API de CLIP',
                        <input
                          type="text"
                          value={values.apiKey}
                          onChange={(event) => updateClipModeCredential(mode, 'apiKey', event.target.value)}
                          onFocus={(event) => {
                            if (savedMode?.apiKeyPreview && values.apiKey === savedMode.apiKeyPreview) event.currentTarget.select()
                          }}
                          placeholder={savedMode?.hasApiKey ? savedMode.apiKeyPreview : modeCopy.apiKeyPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                        />,
                        'Pega la Clave API visible. No pegues la clave secreta.'
                      )}
                    </div>

                    <div className={styles.stripeModeActions}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTestClipModeConfig(mode)}
                        disabled={modeIsTesting || modeIsSaving || !clipModeCanSave(mode)}
                      >
                        {modeIsTesting ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Validando...
                          </>
                        ) : (
                          <>
                            <ShieldCheck size={15} />
                            Validar conexión
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleSaveClipModeConfig(mode)}
                        disabled={modeIsSaving || Boolean(disconnectingClipMode) || !clipModeCanSave(mode)}
                      >
                        {modeIsSaving ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Guardando...
                          </>
                        ) : (
                          modeSaved ? 'Guardar cambios' : 'Guardar configuración'
                        )}
                      </Button>
                      {modeSaved && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDisconnectClipMode(mode)}
                          disabled={modeIsDisconnecting || Boolean(savingClipMode)}
                        >
                          {modeIsDisconnecting ? (
                            <>
                              <Loader2 size={15} className={styles.spinIcon} />
                              Desconectando...
                            </>
                          ) : (
                            <>
                              <Unplug size={15} />
                              Desconectar
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={styles.mercadoPagoMiniSection}>
              <div className={styles.mercadoPagoMiniTitle}>
                <Webhook size={16} />
                <strong>Postback Webhook</strong>
              </div>
              <p className={styles.mercadoPagoTestGuideNote}>
                Copia esta URL en el Postback Webhook del panel de CLIP para que Ristak reciba confirmaciones y actualice pagos aunque {customerWithPlainArticle} cierre la página.
              </p>
              {clipWebhookEndpoints.length > 0 ? (
                <div className={styles.endpointList}>
                  {clipWebhookEndpoints.map((endpoint) => (
                    <div key={`${endpoint.source}-${endpoint.url}`} className={styles.endpointItem}>
                      <div>
                        <strong>{endpoint.label}</strong>
                        <span>{endpoint.url}</span>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        leftIcon={<Copy size={15} />}
                        onClick={() => handleCopyGatewayText(endpoint.url, 'Postback Webhook', 'CLIP')}
                      >
                        Copiar
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.inlineInfo}>
                  <Info size={16} />
                  <span>Publica Ristak en una URL HTTPS para generar el endpoint que CLIP pueda llamar.</span>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'rebill' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="rebill" size="lg" decorative />
              <div>
                <h2>Rebill</h2>
                <p>Configura Rebill para recibir pagos y confirmarlos automáticamente en Ristak.</p>
              </div>
            </div>
            <Badge variant={rebillStatusBadge.variant}>
              {rebillStatusBadge.icon}
              {rebillStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.stripeModeGrid}>
              {stripeModeIds.map((mode) => {
                const modeCopy = rebillModeLabels[mode]
                const values = rebillManualCredentials[mode]
                const savedMode = rebillConfig?.modeConnections?.[mode]
                const modeSaved = rebillModeIsSaved(mode)
                const modeIsSaving = savingRebillMode === mode
                const modeIsTesting = testingRebillMode === mode
                const modeIsDisconnecting = disconnectingRebillMode === mode
                const webhookStatus = savedMode?.webhookConfigured
                  ? 'Configurado'
                  : savedMode?.webhookStatus === 'pending_public_url'
                    ? 'Pendiente HTTPS'
                    : savedMode?.webhookStatus === 'error'
                      ? 'Revisar'
                      : 'Pendiente'

                return (
                  <div key={mode} className={styles.stripeModePanel}>
                    <div className={styles.stripeModeHeader}>
                      <div>
                        <h3>{modeCopy.title}</h3>
                        <p>{modeCopy.description}</p>
                      </div>
                    </div>

                    {modeSaved && (
                      <div className={styles.connectionSummary}>
                        <div>
                          <span>Organización</span>
                          <strong>{savedMode?.accountLabel || rebillConfig?.accountLabel || 'Rebill'}</strong>
                        </div>
                        <div>
                          <span>Public key</span>
                          <strong>{savedMode?.publicKey || rebillConfig?.publicKey || 'Guardada'}</strong>
                        </div>
                        <div>
                          <span>Secret key</span>
                          <strong>{savedMode?.secretKeyPreview || rebillConfig?.secretKeyPreview || 'Guardada'}</strong>
                        </div>
                        <div>
                          <span>Webhook</span>
                          <strong>{webhookStatus}</strong>
                        </div>
                      </div>
                    )}

                    <div className={styles.formGrid}>
                      {renderField(
                        'Public key',
                        <input
                          type="text"
                          value={values.publicKey}
                          onChange={(event) => updateRebillModeCredential(mode, 'publicKey', event.target.value)}
                          placeholder={savedMode?.hasPublicKey ? savedMode.publicKey : modeCopy.publicPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                        />,
                        'Copia aquí la Public key de tu organización en Rebill.'
                      )}
                      {renderField(
                        'Secret key',
                        <input
                          type="password"
                          value={values.secretKey}
                          onChange={(event) => updateRebillModeCredential(mode, 'secretKey', event.target.value)}
                          onFocus={(event) => {
                            if (savedMode?.secretKeyPreview && values.secretKey === savedMode.secretKeyPreview) event.currentTarget.select()
                          }}
                          placeholder={savedMode?.hasSecretKey ? savedMode.secretKeyPreview : modeCopy.secretPlaceholder}
                          autoComplete="new-password"
                          spellCheck={false}
                        />,
                        'Copia aquí la Secret key de tu organización en Rebill.'
                      )}
                    </div>

                    <div className={styles.stripeModeActions}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTestRebillModeConfig(mode)}
                        disabled={modeIsTesting || modeIsSaving || !rebillModeCanSave(mode)}
                      >
                        {modeIsTesting ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Validando...
                          </>
                        ) : (
                          <>
                            <ShieldCheck size={15} />
                            Validar conexión
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleSaveRebillModeConfig(mode)}
                        disabled={modeIsSaving || Boolean(disconnectingRebillMode) || !rebillModeCanSave(mode)}
                      >
                        {modeIsSaving ? (
                          <>
                            <Loader2 size={15} className={styles.spinIcon} />
                            Guardando...
                          </>
                        ) : (
                          modeSaved ? 'Guardar cambios' : 'Guardar configuración'
                        )}
                      </Button>
                      {modeSaved && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDisconnectRebillMode(mode)}
                          disabled={modeIsDisconnecting || Boolean(savingRebillMode)}
                        >
                          {modeIsDisconnecting ? (
                            <>
                              <Loader2 size={15} className={styles.spinIcon} />
                              Desconectando...
                            </>
                          ) : (
                            <>
                              <Unplug size={15} />
                              Desconectar
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {rebillWebhookNeedsAttention && (
              <div className={styles.mercadoPagoMiniSection}>
                <div className={styles.mercadoPagoMiniTitle}>
                  <Webhook size={16} />
                  <strong>Webhook automático</strong>
                </div>
                <div className={styles.inlineInfo}>
                  <Info size={16} />
                  <span>
                    {rebillWebhookAttentionStatus === 'error'
                      ? 'Ristak no pudo terminar la conexión automática con Rebill. Revisa la URL pública de la app y vuelve a guardar las llaves.'
                      : 'Ristak necesita estar publicado con una URL HTTPS para terminar la conexión automática con Rebill.'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'mercadopago' && (
        <Modal
          isOpen={mercadoPagoSubscriptionTestModalOpen}
          onClose={() => setMercadoPagoSubscriptionTestModalOpen(false)}
          title="Suscripciones test de Mercado Pago"
          size="xl"
        >
          <div className={styles.mercadoPagoSubscriptionModal}>
            <div className={styles.mercadoPagoSubscriptionModalIntro}>
              <div className={styles.mercadoPagoTestHeading}>
                <span className={styles.mercadoPagoTestIcon}>
                  <FileCheck2 size={16} />
                </span>
                <div>
                  <strong>App del vendedor test</strong>
                  <span>Credenciales separadas para probar suscripciones sin mezclar la conexión OAuth.</span>
                </div>
              </div>
              <Badge variant={mercadoPagoSubscriptionTestConfigured ? 'success' : 'neutral'}>
                {mercadoPagoSubscriptionTestConfigured ? 'Configurado' : 'Pendiente'}
              </Badge>
            </div>

            <div className={styles.inlineWarning}>
              <AlertTriangle size={16} />
              <span>
                Mercado Pago identifica al comprador en el checkout. No autorices con el vendedor ni con una cuenta real.
              </span>
            </div>

            <ol className={styles.mercadoPagoTestGuideSteps}>
              {mercadoPagoSubscriptionTestSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            <div className={styles.mercadoPagoMiniSection}>
              <div className={styles.mercadoPagoMiniTitle}>
                <Webhook size={16} />
                <strong>Webhook</strong>
              </div>
              {mercadoPagoWebhookEndpoints.length > 0 && (
                <div className={styles.endpointList}>
                  {mercadoPagoWebhookEndpoints.map((endpoint) => (
                    <div key={`${endpoint.source}-${endpoint.url}`} className={styles.endpointItem}>
                      <div>
                        <strong>{endpoint.label}</strong>
                        <span>{endpoint.url}</span>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        leftIcon={<Copy size={15} />}
                        onClick={() => handleCopyGatewayText(endpoint.url, 'URL', 'Mercado Pago')}
                      >
                        Copiar
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.mercadoPagoEventStrip}>
                <div>
                  <strong>Eventos</strong>
                  <span>Marca: Pagos, Planes y suscripciones, Reclamos.</span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  leftIcon={<Copy size={15} />}
                  onClick={() => handleCopyGatewayText(mercadoPagoSubscriptionWebhookEventNames, 'Eventos', 'Mercado Pago')}
                >
                  Copiar eventos
                </Button>
              </div>
            </div>

            <div className={styles.mercadoPagoCredentialGrid}>
              {renderField(
                'Public Key de la app',
                <input
                  type="text"
                  value={mercadoPagoSubscriptionTestCredentials.publicKey}
                  onChange={(event) => updateMercadoPagoSubscriptionTestCredential('publicKey', event.target.value)}
                  placeholder="APP_USR-..."
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
              {renderField(
                'Access Token de la app',
                <input
                  type="password"
                  value={mercadoPagoSubscriptionTestCredentials.accessToken}
                  onChange={(event) => updateMercadoPagoSubscriptionTestCredential('accessToken', event.target.value)}
                  onFocus={(event) => {
                    if (mercadoPagoConfig?.subscriptionTestCredentials?.accessTokenPreview && mercadoPagoSubscriptionTestCredentials.accessToken === mercadoPagoConfig.subscriptionTestCredentials.accessTokenPreview) {
                      event.currentTarget.select()
                    }
                  }}
                  placeholder={mercadoPagoConfig?.subscriptionTestCredentials?.hasAccessToken ? mercadoPagoConfig.subscriptionTestCredentials.accessTokenPreview : 'APP_USR-...'}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              )}
              {renderField(
                'Clave secreta del webhook',
                <input
                  type="password"
                  value={mercadoPagoSubscriptionTestCredentials.webhookSecret}
                  onChange={(event) => updateMercadoPagoSubscriptionTestCredential('webhookSecret', event.target.value)}
                  onFocus={(event) => {
                    if (mercadoPagoConfig?.subscriptionTestCredentials?.webhookSecretPreview && mercadoPagoSubscriptionTestCredentials.webhookSecret === mercadoPagoConfig.subscriptionTestCredentials.webhookSecretPreview) {
                      event.currentTarget.select()
                    }
                  }}
                  placeholder={mercadoPagoConfig?.subscriptionTestCredentials?.hasWebhookSecret ? mercadoPagoConfig.subscriptionTestCredentials.webhookSecretPreview : 'Clave secreta de Webhooks'}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              )}
            </div>

            <div className={styles.stripeModeActions}>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveMercadoPagoSubscriptionTestCredentials}
                disabled={savingMercadoPagoSubscriptionTestCredentials || clearingMercadoPagoSubscriptionTestCredentials || !mercadoPagoSubscriptionTestCanSave}
              >
                {savingMercadoPagoSubscriptionTestCredentials ? (
                  <>
                    <Loader2 size={15} className={styles.spinIcon} />
                    Guardando...
                  </>
                ) : (
                  'Guardar credenciales'
                )}
              </Button>
              {mercadoPagoSubscriptionTestConfigured && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleClearMercadoPagoSubscriptionTestCredentials}
                  disabled={savingMercadoPagoSubscriptionTestCredentials || clearingMercadoPagoSubscriptionTestCredentials}
                >
                  {clearingMercadoPagoSubscriptionTestCredentials ? (
                    <>
                      <Loader2 size={15} className={styles.spinIcon} />
                      Borrando...
                    </>
                  ) : (
                    <>
                      <Unplug size={15} />
                      Desconectar
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )

  const renderTaxesSection = () => {
    const taxRateLabel = `${getTaxRateValue(taxes)}%`
    const gigstackControlsFiscalData = taxes.gigstackEnabled
    const hasAnyGigstackToken = Boolean(taxes.hasGigstackTestApiToken || taxes.hasGigstackLiveApiToken)
    const hasBothGigstackTokens = Boolean(taxes.hasGigstackTestApiToken && taxes.hasGigstackLiveApiToken)

    return (
      <div className={styles.taxSettingsLayout}>
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Impuestos</h2>
              <p>{gigstackControlsFiscalData
                ? 'Gigstack es la fuente de los datos fiscales usados para los pagos y las facturas.'
                : 'Configura una regla de impuestos interna para mostrarla en tus cobros aunque no uses facturación automática.'}</p>
            </div>
            <Badge variant={gigstackControlsFiscalData ? 'info' : taxes.enabled ? 'success' : 'neutral'}>
              <Percent size={14} />
              {gigstackControlsFiscalData ? 'Controlado por Gigstack' : taxes.enabled ? 'Manual activo' : 'Manual apagado'}
            </Badge>
          </div>

          {gigstackControlsFiscalData ? (
            <div className={styles.fiscalSourceRow}>
              <div>
                <ShieldCheck size={17} />
                <span>El RFC, la razón social, el régimen, el código postal y la tasa se importan del equipo fiscal de Gigstack.</span>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void syncGigstackFiscalProfile()}
                disabled={syncingGigstackFiscal}
              >
                {syncingGigstackFiscal ? <Loader2 size={15} className={styles.spinIcon} /> : <RefreshCw size={15} />}
                Actualizar desde Gigstack
              </Button>
            </div>
          ) : (
            <div className={styles.switchStack}>
              {renderSwitchRow('Cobrar impuestos', 'Cuando está apagado, registrar pagos y links no muestran opciones de impuestos.', taxes.enabled, (next) => setTaxValue('enabled', next))}
            </div>
          )}

          <div className={styles.formGrid}>
            {renderField(
              'Nombre del impuesto',
              <input
                type="text"
                value={taxes.taxName}
                onChange={(event) => setTaxValue('taxName', event.target.value)}
                placeholder="IVA"
                disabled={gigstackControlsFiscalData}
              />
            )}
            {renderField(
              gigstackControlsFiscalData ? 'País fiscal' : 'País de la tasa automática',
              <CustomSelect
                value={taxes.country || 'MX'}
                onValueChange={(value) => setTaxValue('country', value)}
                options={taxCountryOptions}
                disabled={gigstackControlsFiscalData}
              />,
              gigstackControlsFiscalData ? `Gigstack indicó una tasa de ${taxRateLabel}.` : `Ristak usará ${taxRateLabel} según el país seleccionado.`
            )}
            {gigstackControlsFiscalData ? renderField(
              'Tasa configurada en Gigstack',
              <input type="text" value={taxRateLabel} disabled readOnly />
            ) : null}
            {renderField(
              'Modo de cálculo',
              <CustomSelect
                value={taxes.calculationMode}
                onValueChange={(value) => setTaxValue('calculationMode', value as PaymentTaxSettings['calculationMode'])}
                options={[
                  { value: 'exclusive', label: 'Se suma al total' },
                  { value: 'inclusive', label: 'Ya incluido en el precio' }
                ]}
                disabled={gigstackControlsFiscalData}
              />
            )}
            {renderField(
              'RFC / ID fiscal',
              <input
                type="text"
                value={taxes.fiscalId}
                onChange={(event) => setTaxValue('fiscalId', event.target.value)}
                placeholder="RFC o identificador fiscal"
                disabled={gigstackControlsFiscalData}
              />
            )}
            {renderField(
              'Razón social fiscal',
              <input
                type="text"
                value={taxes.fiscalLegalName}
                onChange={(event) => setTaxValue('fiscalLegalName', event.target.value)}
                placeholder="Nombre o razón social"
                disabled={gigstackControlsFiscalData}
              />
            )}
            {renderField(
              'Código postal fiscal',
              <input
                type="text"
                value={taxes.fiscalPostalCode}
                onChange={(event) => setTaxValue('fiscalPostalCode', event.target.value)}
                placeholder="Ej. 06600"
                disabled={gigstackControlsFiscalData}
              />
            )}
            {renderField(
              'Régimen fiscal',
              <input
                type="text"
                value={taxes.fiscalRegime}
                onChange={(event) => setTaxValue('fiscalRegime', event.target.value)}
                placeholder="Ej. 612 - Personas físicas"
                disabled={gigstackControlsFiscalData}
              />
            )}
          </div>

          {renderSectionSaveBar('Guardar impuestos')}
        </Card>

        <Card className={styles.gigstackCard}>
          <div className={styles.gigstackHeader}>
            <div>
              <h3>Facturas del SAT en automático</h3>
              <p>Gigstack recibe el pago ya confirmado y, según lo que elijas, registra el cobro o crea una factura PUE. No procesa tarjetas ni mueve dinero.</p>
            </div>
            <Badge variant={taxes.gigstackEnabled ? (hasBothGigstackTokens ? 'success' : 'warning') : 'neutral'}>
              {taxes.gigstackEnabled ? (hasBothGigstackTokens ? 'Test y Live listos' : 'Falta una API key') : 'Envío fiscal apagado'}
            </Badge>
          </div>
          {renderSwitchRow(
            'Enviar pagos confirmados a Gigstack',
            'Sólo se envían pagos nuevos que ya traen impuesto y un ambiente Test o Live explícito. No se facturan pagos anteriores.',
            taxes.gigstackEnabled,
            (next) => {
              if (next) {
                void syncGigstackFiscalProfile()
              } else {
                setTaxValue('gigstackEnabled', false)
              }
            }
          )}

          <div className={styles.stripeModeGrid}>
            {stripeModeIds.map((mode) => {
              const isTest = mode === 'test'
              const saved = isTest ? taxes.hasGigstackTestApiToken : taxes.hasGigstackLiveApiToken
              const token = isTest ? taxes.gigstackTestApiToken : taxes.gigstackLiveApiToken
              const preview = isTest ? taxes.gigstackTestApiTokenPreview : taxes.gigstackLiveApiTokenPreview
              const inputValue = token || (saved ? preview || '••••' : '')
              const showingSavedToken = Boolean(!token && saved && inputValue)
              const isTesting = testingGigstackMode === mode

              return (
                <div key={mode} className={styles.stripeModePanel}>
                  <div className={styles.stripeModeHeader}>
                    <div>
                      <h3>{isTest ? 'API key Test' : 'API key Live'}</h3>
                      <p>{isTest
                        ? 'Pruebas fiscales de Gigstack. Nunca timbra una factura real ante el SAT.'
                        : 'Pagos reales. Puede generar un CFDI real si eliges facturación automática.'}</p>
                    </div>
                    <Badge variant={saved ? 'success' : 'neutral'}>{saved ? 'Guardada' : 'Sin conectar'}</Badge>
                  </div>

                  {renderField(
                    isTest ? 'Llave de prueba' : 'Llave de producción',
                    <input
                      type="password"
                      value={inputValue}
                      onChange={(event) => handleGigstackTokenChange(mode, event.target.value)}
                      onFocus={(event) => {
                        if (showingSavedToken) event.currentTarget.select()
                      }}
                      placeholder="Pega la API key JWT"
                      autoComplete="new-password"
                      spellCheck={false}
                    />,
                    saved ? 'Ya está cifrada en Ristak. Pega una nueva sólo si quieres reemplazarla.' : 'La encuentras en Gigstack → Configuración → API.'
                  )}

                  <div className={styles.stripeModeActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleTestGigstackConnection(mode)}
                      disabled={Boolean(testingGigstackMode) || (!saved && !token)}
                    >
                      {isTesting ? (
                        <>
                          <Loader2 size={15} className={styles.spinIcon} />
                          Validando...
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={15} />
                          Probar conexión
                        </>
                      )}
                    </Button>
                    {saved && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDisconnectGigstackMode(mode)}
                        disabled={Boolean(testingGigstackMode)}
                      >
                        <Unplug size={15} />
                        Borrar llave
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {hasAnyGigstackToken && (
            <div className={styles.gigstackTokenActions}>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleDisconnectGigstack}
              >
                <Unplug size={15} />
                Desconectar todo Gigstack
              </Button>
            </div>
          )}

          <div className={styles.gigstackDefaultsGrid}>
            {renderField(
              'Qué hacer al recibir el pago',
              <CustomSelect
                value={taxes.gigstackAutomationType || 'pue_invoice'}
                onValueChange={(value) => {
                  const automationType = value as PaymentTaxSettings['gigstackAutomationType']
                  patchTaxValues({
                    gigstackAutomationType: automationType,
                    gigstackAutomateInvoiceOnComplete: automationType === 'pue_invoice'
                  })
                }}
                options={[
                  { value: 'pue_invoice', label: 'Crear factura PUE automáticamente' },
                  { value: 'none', label: 'Sólo registrar el pago' }
                ]}
              />,
              'PUE significa pago en una sola exhibición. “Sólo registrar” no timbra automáticamente.'
            )}
            {renderField(
              'Cómo encontrar al cliente',
              <CustomSelect
                value={taxes.gigstackClientMatchMode || 'email'}
                onValueChange={(value) => setTaxValue('gigstackClientMatchMode', value as PaymentTaxSettings['gigstackClientMatchMode'])}
                options={[
                  { value: 'email', label: 'Correo del contacto (recomendado)' },
                  { value: 'client_id_or_email', label: 'ID de Gigstack y después correo' }
                ]}
              />,
              'Con correo, Gigstack busca al cliente y lo crea si todavía no existe.'
            )}
            {renderField(
              'Descripción por defecto',
              <input
                type="text"
                value={taxes.gigstackDefaultDescription || ''}
                onChange={(event) => setTaxValue('gigstackDefaultDescription', event.target.value)}
                placeholder="Servicio cobrado"
              />,
              'Se usa cuando el pago o producto no trae una descripción propia.'
            )}
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow(
              'Enviar factura por correo desde Gigstack',
              `Usa el correo guardado en ${customerLowerLabel}. Si falta correo, Ristak bloquea el envío fiscal en vez de inventar datos.`,
              taxes.gigstackSendEmail !== false,
              (next) => setTaxValue('gigstackSendEmail', next)
            )}
          </div>

          <div className={styles.gigstackPortalSection}>
            <div className={styles.gigstackPortalHeader}>
              <div>
                <h4>Portal para que tus {customersLowerLabel} facturen</h4>
                <p>Gigstack maneja un portal que puedes compartir para que {customerWithPlainArticle} genere o consulte sus facturas. Su API también genera links seguros por {customerLowerLabel}, pero esos links necesitan contacto específico y vencen.</p>
              </div>
              <Badge variant="info">Copiable</Badge>
            </div>
            <div className={styles.copyField}>
              <input
                type="url"
                value={taxes.gigstackPortalUrl || ''}
                onChange={(event) => setTaxValue('gigstackPortalUrl', event.target.value)}
                placeholder="https://tuempresa.gigstack.pro"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleCopyGigstackPortalUrl}
              >
                <Copy size={15} />
                Copiar
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleOpenGigstackPortalUrl}
              >
                <ExternalLink size={15} />
                Abrir
              </Button>
            </div>
          </div>
          <div className={styles.gigstackDefaultsGrid}>
            {renderField(
              'Clave SAT por defecto',
              <CustomSelect
                value={taxes.gigstackDefaultProductKey || defaultPaymentSettings.taxes.gigstackDefaultProductKey}
                onValueChange={(value) => setTaxValue('gigstackDefaultProductKey', value)}
                options={gigstackProductKeyOptions}
                searchable
                searchPlaceholder="Busca o escribe 8 dígitos"
                allowCustomValue
                normalizeCustomValue={normalizeGigstackProductKeyInput}
                isCustomValueValid={isValidGigstackProductKey}
                getCustomValueLabel={(value) => `Usar clave SAT ${value}`}
              />,
              <>
                Los ejemplos son sólo atajos: puedes buscar o escribir cualquier clave válida de 8 dígitos para tu actividad.{' '}
                <a href={SAT_PRODUCT_CATALOG_URL} target="_blank" rel="noreferrer">Consultar catálogo completo del SAT</a>
              </>
            )}
            {renderField(
              'Unidad SAT por defecto',
              <CustomSelect
                value={taxes.gigstackDefaultUnitKey || defaultPaymentSettings.taxes.gigstackDefaultUnitKey}
                onValueChange={setGigstackDefaultUnit}
                options={gigstackUnitOptions}
                searchable
                searchPlaceholder="Busca o escribe la unidad"
                allowCustomValue
                normalizeCustomValue={normalizeGigstackUnitKeyInput}
                isCustomValueValid={isValidGigstackUnitKey}
                getCustomValueLabel={(value) => `Usar unidad SAT ${value}`}
              />,
              'Puedes elegir una unidad frecuente o escribir directamente la clave del catálogo.'
            )}
            {renderField(
              'Nombre de la unidad',
              <input
                type="text"
                value={taxes.gigstackDefaultUnitName || ''}
                onChange={(event) => setTaxValue('gigstackDefaultUnitName', event.target.value)}
                placeholder="Ej. Pieza, consulta, hora"
              />,
              'Así se mostrará la unidad en el concepto de la factura.'
            )}
            {renderField(
              'Forma de pago si no se identifica',
              <CustomSelect
                value={taxes.gigstackDefaultPaymentMethod || defaultPaymentSettings.taxes.gigstackDefaultPaymentMethod}
                onValueChange={(value) => setTaxValue('gigstackDefaultPaymentMethod', value)}
                options={gigstackPaymentMethodOptions}
              />,
              'Ristak sólo usa una forma específica cuando el proveedor confirma cuál fue. Si no, usa este valor para no adivinar datos fiscales.'
            )}
          </div>
          <div className={styles.gigstackActions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate('/transactions/products')}
            >
              <PackageCheck size={15} />
              Elegir claves por producto
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => window.open(GIGSTACK_API_URL, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink size={15} />
              Abrir Gigstack
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <PageContainer size="wide" className={styles.page}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="Configuración"
        title="Pagos"
        subtitle={hasPaymentCheckoutAccess || hasPaymentGatewaysAccess || hasPaymentAutomationsAccess
          ? 'Configura el cobro, comprobante, automatizaciones, pasarelas e impuestos desde un solo setup.'
          : 'Configura comprobantes, impuestos y la operación de tus cobros.'}
      />

      <div className={styles.setupHeader}>
        <SegmentTabs
          aria-label="Setup de configuración de pagos"
          className={styles.setupTabs}
          tabs={visibleSectionItems.map((item) => ({
            id: item.id,
            label: item.label,
            icon: item.icon
          }))}
          value={activeSection}
          onChange={handleSectionChange}
        />
      </div>

      {hasPaymentCheckoutAccess && activeSection === 'checkout' && renderCheckoutSection()}
      {activeSection === 'receipt' && renderReceiptSection()}
      {activeSection === 'meta' && renderMetaSection()}
      {hasPaymentAutomationsAccess && activeSection === 'automations' && renderAutomationsSection()}
      {hasPaymentGatewaysAccess && activeSection === 'gateways' && renderGatewaysSection()}
      {activeSection === 'taxes' && renderTaxesSection()}
    </PageContainer>
  )
}
