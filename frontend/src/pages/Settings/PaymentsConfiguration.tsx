import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  BellRing,
  CheckCircle,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  FileCheck2,
  Image,
  ImageUp,
  Info,
  KeyRound,
  Loader2,
  Paintbrush,
  Plus,
  PackageCheck,
  Percent,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ChevronDown,
  Trash2,
  Unplug,
  WalletCards
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
  Switch
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency, useAppConfig } from '@/hooks'
import { useHighLevelConnected } from '@/hooks/useHighLevelConnected'
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
import { mercadoPagoPaymentsService, type MercadoPagoPaymentConfig } from '@/services/mercadoPagoPaymentsService'
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
  WHATSAPP_QR_PRECAUTION_MESSAGE,
  WHATSAPP_QR_PRECAUTION_TITLE,
  WHATSAPP_QR_FALLBACK_CONFIRM_WORD,
  WHATSAPP_QR_FALLBACK_TITLE,
  buildWhatsAppQrFallbackMessage,
  getWhatsAppStatusConnectionAvailability,
  type WhatsAppConnectionAvailability
} from '@/utils/whatsappQrFallbackWarning'
import {
  getGigstackUnitName,
  gigstackPaymentMethodOptions,
  gigstackProductKeyOptions,
  gigstackUnitOptions
} from '@/utils/gigstackFiscalCatalog'
import styles from './PaymentsConfiguration.module.css'

type PaymentsSectionId = 'checkout' | 'receipt' | 'meta' | 'automations' | 'gateways' | 'taxes'
type PaymentGatewayId = 'highlevel' | 'stripe' | 'conekta' | 'mercadopago'
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

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'available'
  logo?: PaymentPlatformLogoId
}

const gatewayStatusCopy: Record<PaymentGatewayOption['status'], { label: string; variant: 'success' | 'neutral' }> = {
  connected: { label: 'Conectada', variant: 'success' },
  available: { label: 'Sin conexión', variant: 'neutral' }
}

const sectionItems: Array<{ id: PaymentsSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'checkout', label: 'Página de cobro', icon: <CreditCard size={17} /> },
  { id: 'receipt', label: 'Comprobante', icon: <ReceiptText size={17} /> },
  { id: 'meta', label: 'Meta', icon: <Sparkles size={17} /> },
  { id: 'automations', label: 'Automatizaciones', icon: <BellRing size={17} /> },
  { id: 'gateways', label: 'Pasarelas', icon: <WalletCards size={17} /> },
  { id: 'taxes', label: 'Impuestos', icon: <Percent size={17} /> }
]

const sectionIds = sectionItems.map((item) => item.id)
const gatewayIds: PaymentGatewayId[] = ['highlevel', 'stripe', 'conekta', 'mercadopago']
const GIGSTACK_API_URL = 'https://gigstack.pro/api-facturacion'
const stripeModeIds: StripeModeId[] = ['test', 'live']
const emptyStripeModeCredentials: Record<StripeModeId, StripeModeCredentials> = {
  test: { publishableKey: '', secretKey: '', webhookSecret: '' },
  live: { publishableKey: '', secretKey: '', webhookSecret: '' }
}
const emptyConektaModeCredentials: Record<StripeModeId, ConektaModeCredentials> = {
  test: { publicKey: '', privateKey: '' },
  live: { publicKey: '', privateKey: '' }
}
const stripeModeLabels: Record<StripeModeId, { title: string; description: string; publishablePlaceholder: string; secretPlaceholder: string }> = {
  test: {
    title: 'Modo prueba',
    description: 'Para probar links, webhooks y tarjetas de prueba.',
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
    description: 'Todos los nuevos cobros usarán credenciales sandbox o usuarios de prueba.',
    mercadoPagoHelp: 'Para probar Mercado Pago, entra con un TEST USER creado desde Mercado Pago Developers. No uses tu cuenta real para este modo.'
  },
  live: {
    title: 'Modo en vivo',
    badge: 'En vivo',
    description: 'Todos los nuevos cobros usarán credenciales reales y podrán mover dinero.',
    mercadoPagoHelp: 'Para cobrar real con Mercado Pago, inicia sesión con tu cuenta normal de Mercado Pago y autoriza la conexión.'
  }
}
const PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME = 'Purchase'
const PAYMENT_META_DEFAULT_EVENT_CHANNEL: PaymentMetaPurchaseEventChannel = 'smart'
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

const PAYMENT_META_EVENT_OPTIONS = [
  { value: 'Schedule', label: 'Schedule · cita agendada' },
  { value: 'Lead', label: 'Lead · lead nuevo' },
  { value: 'Contact', label: 'Contact · contacto iniciado' },
  { value: 'FormSubmitted', label: 'FormSubmitted · formulario enviado' },
  { value: 'CompleteRegistration', label: 'CompleteRegistration · registro completo' },
  { value: 'ViewContent', label: 'ViewContent · visita de contenido' },
  { value: PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME, label: 'Purchase · compra' },
  { value: 'AddPaymentInfo', label: 'AddPaymentInfo · información de pago' }
]
const PAYMENT_META_PARAMETER_FIELDS: Array<{
  key: 'value' | 'predictedLtv'
  label: string
  placeholder: string
}> = [
  { key: 'value', label: 'Valor monetario', placeholder: '2500' },
  { key: 'predictedLtv', label: 'LTV estimado', placeholder: '12000' }
]
const parseBooleanLike = (value: unknown, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback

  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)
}
const createDefaultPaymentMetaPurchaseEventParameter = (): PaymentMetaPurchaseEventParameter => ({
  id: `meta-pp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  key: '',
  value: ''
})

const createDefaultPaymentMetaPurchaseEventConfig = (): PaymentMetaPurchaseEventConfig => ({
  enabled: false,
  channel: PAYMENT_META_DEFAULT_EVENT_CHANNEL,
  eventName: PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME,
  parameters: {
    sendValue: true,
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
      .map(parameter => ({
        id: String(parameter.id || `meta-pp-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        key: String(parameter.key || '').trim(),
        value: String(parameter.value || '').trim()
      }))
      .slice(0, 12)
    : []

  return {
    sendValue: parseBooleanLike(source.sendValue, true),
    value: String(source.value || '').trim(),
    predictedLtv: String(source.predictedLtv || '').trim(),
    custom
  }
}

const normalizePaymentMetaPurchaseEventConfig = (
  value?: Partial<PaymentMetaPurchaseEventConfig> | null
): PaymentMetaPurchaseEventConfig => {
  const eventName = String(value?.eventName || '').trim()
  const channel = PAYMENT_META_DEFAULT_EVENT_CHANNEL

  return {
    enabled: Boolean(value?.enabled),
    channel,
    eventName: PAYMENT_META_EVENT_OPTIONS.some(option => option.value === eventName)
      ? eventName
      : PAYMENT_META_DEFAULT_PURCHASE_EVENT_NAME,
    parameters: normalizePaymentMetaPurchaseEventParameters(value?.parameters)
  }
}

const hasPaymentMetaPurchaseEventParameters = (parameters?: PaymentMetaPurchaseEventParameters | null) => {
  const normalized = normalizePaymentMetaPurchaseEventParameters(parameters)
  return PAYMENT_META_PARAMETER_FIELDS.some(field => Boolean(normalized[field.key])) ||
    normalized.custom.some(parameter => parameter.key || parameter.value)
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

const getInitialGateway = (pathname: string): PaymentGatewayId => {
  const segment = getPaymentRouteSegment(pathname)
  return isPaymentGatewayId(segment) ? segment : 'stripe'
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
  { value: 'email', label: 'Email' },
  { value: 'both', label: 'WhatsApp API y email' }
]

const channelLabelById: Record<PaymentAutomationSettings['reminderChannel'], string> = {
  whatsapp: 'WhatsApp API',
  email: 'email',
  both: 'WhatsApp API y email'
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
  templateIdKey: keyof PaymentAutomationSettings
  templateNameKey: keyof PaymentAutomationSettings
  templateLanguageKey: keyof PaymentAutomationSettings
}> = {
  reminder: {
    label: 'Recordatorio de pago',
    defaultName: 'recordatorio_pago_pendiente',
    defaultLanguage: 'es_MX',
    templateIdKey: 'reminderTemplateId',
    templateNameKey: 'reminderTemplateName',
    templateLanguageKey: 'reminderTemplateLanguage'
  },
  receipt: {
    label: 'Comprobante de pago',
    defaultName: 'comprobante_pago_recibido',
    defaultLanguage: 'es_MX',
    templateIdKey: 'receiptTemplateId',
    templateNameKey: 'receiptTemplateName',
    templateLanguageKey: 'receiptTemplateLanguage'
  },
  failed: {
    label: 'Cobro fallido',
    defaultName: 'pago_fallido_reintento',
    defaultLanguage: 'es_MX',
    templateIdKey: 'failedPaymentTemplateId',
    templateNameKey: 'failedPaymentTemplateName',
    templateLanguageKey: 'failedPaymentTemplateLanguage'
  }
}

const channelUsesWhatsApp = (channel: PaymentAutomationSettings['reminderChannel']) => (
  channel === 'whatsapp' || channel === 'both'
)

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

export const PaymentsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast, showConfirm } = useNotification()
  const { connected: highLevelConnected, loading: loadingHighLevelConnection } = useHighLevelConnected()
  const [accountCurrency] = useAccountCurrency()

  const [activeSection, setActiveSection] = useState<PaymentsSectionId>(() => getInitialSection(location.pathname))
  const [selectedGateway, setSelectedGateway] = useState<PaymentGatewayId>(() => getInitialGateway(location.pathname))
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
  const [mercadoPagoConfig, setMercadoPagoConfig] = useState<MercadoPagoPaymentConfig | null>(null)
  const [loadingMercadoPagoConfig, setLoadingMercadoPagoConfig] = useState(false)
  const [connectingMercadoPago, setConnectingMercadoPago] = useState(false)
  const [disconnectingMercadoPago, setDisconnectingMercadoPago] = useState(false)
  const [uploadingCheckoutLogo, setUploadingCheckoutLogo] = useState(false)
  const [checkoutLogoUploadProgress, setCheckoutLogoUploadProgress] = useState(0)
  const [uploadingReceiptLogo, setUploadingReceiptLogo] = useState(false)
  const [receiptLogoUploadProgress, setReceiptLogoUploadProgress] = useState(0)
  const [previewingReceipt, setPreviewingReceipt] = useState(false)
  const [whatsappAvailability, setWhatsappAvailability] = useState<WhatsAppConnectionAvailability>(defaultWhatsAppAvailability)
  const [paymentWhatsappTemplates, setPaymentWhatsappTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [loadingPaymentWhatsappTemplates, setLoadingPaymentWhatsappTemplates] = useState(false)
  const [paymentMetaPurchaseEventParamsOpen, setPaymentMetaPurchaseEventParamsOpen] = useState(false)
  const [paymentMetaPurchaseEventConfigRaw, setPaymentMetaPurchaseEventConfig] = useAppConfig(
    'meta_payment_purchase_event_config',
    createDefaultPaymentMetaPurchaseEventConfig()
  )
  const checkoutLogoInputRef = useRef<HTMLInputElement>(null)
  const receiptLogoInputRef = useRef<HTMLInputElement>(null)
  const latestSettingsRef = useRef(settings)
  const loadedSettingsRef = useRef(false)
  const lastSavedSettingsRef = useRef(JSON.stringify(defaultPaymentSettings))

  const checkout = settings.checkout
  const receipt = settings.receipt
  const automations = settings.automations
  const taxes = settings.taxes
  const paymentMode: PaymentModeId = settings.paymentMode === 'test' ? 'test' : 'live'
  const paymentModeCopy = paymentModeLabels[paymentMode]
  const routeSegment = getPaymentRouteSegment(location.pathname)
  const activeGatewayRoute = isPaymentGatewayId(routeSegment) ? routeSegment : null
  const paymentMetaPurchaseEventConfig = useMemo(
    () => normalizePaymentMetaPurchaseEventConfig(paymentMetaPurchaseEventConfigRaw),
    [paymentMetaPurchaseEventConfigRaw]
  )
  const paymentMetaPurchaseEventHasParameters = useMemo(
    () => hasPaymentMetaPurchaseEventParameters(paymentMetaPurchaseEventConfig.parameters),
    [paymentMetaPurchaseEventConfig.parameters]
  )

  useEffect(() => {
    latestSettingsRef.current = settings
  }, [settings])

  useEffect(() => {
    const nextSection = getInitialSection(location.pathname)
    setActiveSection(nextSection)
    const routeGateway = getInitialGateway(location.pathname)
    if (routeGateway) setSelectedGateway(routeGateway)
  }, [location.pathname])

  useEffect(() => {
    loadPaymentSettings()
    loadStripeConfig()
    loadConektaConfig()
    loadMercadoPagoConfig()
    loadWhatsAppAvailability()
    loadPaymentWhatsappTemplates()
  }, [])

  useEffect(() => {
    if (loadingHighLevelConnection) return
    if (highLevelConnected) loadHighLevelPaymentConfig()
  }, [highLevelConnected, loadingHighLevelConnection])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const status = params.get('mercadopago_connect')
    if (!status) return

    const message = params.get('mercadopago_message') || ''
    const handoffToken = params.get('mercadopago_handoff_token') || ''
    const finishMercadoPagoReturn = async () => {
      setActiveSection('gateways')
      setSelectedGateway('mercadopago')

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
        : `Conecta una cuenta de Mercado Pago para usar ${paymentMode === 'live' ? 'cobros reales' : 'pruebas con TEST USER'}.`,
      status: mercadoPagoConfig?.configured ? 'connected' : 'available'
    }
  ]

  const selectedGatewayOption = gatewayOptions.find((gateway) => gateway.id === (activeGatewayRoute || selectedGateway))
  const stripeWebhookEndpoints = stripeConfig?.webhookEndpoints || []
  const stripeConnected = Boolean(stripeConfig?.configured)
  const conektaConnected = Boolean(conektaConfig?.configured)
  const mercadoPagoConnected = Boolean(mercadoPagoConfig?.configured)
  const stripeConfigurationStatus = stripeConnectionFailed
    ? 'connection_failed'
    : stripeConfig?.configurationStatus || (stripeConnected ? 'configured_manually' : 'not_configured')
  const stripeStatusBadge = (() => {
    if (loadingStripeConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (stripeConfigurationStatus === 'configured_manually') return { label: 'Configurado manualmente', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    if (stripeConfigurationStatus === 'connection_failed') return { label: 'Conexión fallida', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    if (stripeConfigurationStatus === 'disconnected') return { label: 'Desconectado', variant: 'neutral' as const, icon: <Unplug size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const stripeModeIsComplete = (mode: StripeModeId) => {
    const values = stripeManualCredentials[mode]
    return Boolean(values.publishableKey.trim() && values.secretKey.trim())
  }
  const stripeModeIsSaved = (mode: StripeModeId) => Boolean(stripeConfig?.manualModes?.[mode]?.configured)
  const stripeModeCanSave = (mode: StripeModeId) => stripeModeIsComplete(mode)
  const conektaConfigurationStatus = conektaConnectionFailed
    ? 'connection_failed'
    : conektaConnected ? 'configured_manually' : 'not_configured'
  const conektaStatusBadge = (() => {
    if (loadingConektaConfig) return { label: 'Cargando', variant: 'warning' as const, icon: <Loader2 size={14} className={styles.spinIcon} /> }
    if (conektaConfigurationStatus === 'configured_manually') return { label: 'Configurado manualmente', variant: 'success' as const, icon: <ShieldCheck size={14} /> }
    if (conektaConfigurationStatus === 'connection_failed') return { label: 'Conexión fallida', variant: 'warning' as const, icon: <AlertTriangle size={14} /> }
    return { label: 'Sin configurar', variant: 'neutral' as const, icon: <KeyRound size={14} /> }
  })()
  const conektaModeIsComplete = (mode: StripeModeId) => {
    const values = conektaManualCredentials[mode]
    return Boolean(values.publicKey.trim() && values.privateKey.trim())
  }
  const conektaModeIsSaved = (mode: StripeModeId) => Boolean(conektaConfig?.manualModes?.[mode]?.configured)
  const conektaModeCanSave = (mode: StripeModeId) => conektaModeIsComplete(mode)
  const mercadoPagoModeIsConnected = (mode: PaymentModeId) => Boolean(
    mercadoPagoConfig?.modeConnections?.[mode]?.connected ||
    (mercadoPagoConnected && mercadoPagoConfig?.mode === mode)
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

  const confirmAutomationQrFallback = (
    contextLabel: string,
    onConfirm: () => void
  ) => {
    showConfirm(
      WHATSAPP_QR_FALLBACK_TITLE,
      buildWhatsAppQrFallbackMessage(contextLabel),
      onConfirm,
      'Activar respaldo QR',
      'Cancelar',
      undefined,
      { typeToConfirm: WHATSAPP_QR_FALLBACK_CONFIRM_WORD }
    )
  }

  const setAutomationQrFallbackValue = (
    key: 'reminderQrFallbackEnabled' | 'receiptQrFallbackEnabled' | 'failedPaymentQrFallbackEnabled',
    value: boolean,
    contextLabel: string
  ) => {
    if (!value) {
      setAutomationValue(key, false)
      return
    }

    confirmAutomationQrFallback(contextLabel, () => setAutomationValue(key, true))
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

  const handleGigstackTokenChange = (value: string) => {
    patchTaxValues({
      gigstackApiToken: value,
      clearGigstackApiToken: false
    })
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
      'Se apagará el timbrado automático y se borrará el token API guardado. Después podrás pegar una key nueva desde este mismo campo.',
      () => {
        patchTaxValues({
          gigstackEnabled: false,
          gigstackApiToken: '',
          gigstackApiTokenPreview: '',
          hasGigstackApiToken: false,
          clearGigstackApiToken: true
        })
        showToast('success', 'Gigstack desconectado', 'La API key se borrará de Ristak al guardar automáticamente.')
      },
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const setGigstackDefaultUnit = (unitKey: string) => {
    setSettings((current) => ({
      ...current,
      taxes: {
        ...current.taxes,
        gigstackDefaultUnitKey: unitKey,
        gigstackDefaultUnitName: getGigstackUnitName(unitKey) || current.taxes.gigstackDefaultUnitName
      }
    }))
  }

  const loadPaymentSettings = async () => {
    setLoadingSettings(true)
    try {
      const nextSettings = await paymentSettingsService.getSettings()
      const serialized = JSON.stringify(nextSettings)
      loadedSettingsRef.current = true
      lastSavedSettingsRef.current = serialized
      latestSettingsRef.current = nextSettings
      setSettings(nextSettings)
      setAutoSaveState('saved')
    } catch (error: any) {
      showToast('warning', 'Configuración local', error.message || 'Usaremos valores por defecto mientras se carga pagos.')
    } finally {
      setLoadingSettings(false)
    }
  }

  const loadWhatsAppAvailability = async () => {
    try {
      const status = await whatsappApiService.getStatus()
      setWhatsappAvailability(getWhatsAppStatusConnectionAvailability(status))
    } catch {
      setWhatsappAvailability(defaultWhatsAppAvailability)
    }
  }

  const loadPaymentWhatsappTemplates = async () => {
    setLoadingPaymentWhatsappTemplates(true)
    try {
      let items = (await whatsappApiService.getTemplates('APPROVED')).items || []
      if (!items.length) {
        try {
          await whatsappApiService.refresh()
          items = (await whatsappApiService.getTemplates('APPROVED')).items || []
        } catch {
          // La pantalla sigue permitiendo las plantillas predeterminadas por nombre.
        }
      }
      setPaymentWhatsappTemplates(items.filter((template) => String(template.status || '').toUpperCase() === 'APPROVED'))
    } catch {
      setPaymentWhatsappTemplates([])
    } finally {
      setLoadingPaymentWhatsappTemplates(false)
    }
  }

  const loadHighLevelPaymentConfig = async () => {
    try {
      const response = await fetch('/api/highlevel/config')
      const config = await response.json()

      if (config.invoiceTitle) setPaymentTitle(config.invoiceTitle)
      if (config.invoiceNumberPrefix) setPaymentNumberPrefix(config.invoiceNumberPrefix)
      if (config.invoiceDueDays) setPaymentDueDays(config.invoiceDueDays)
      if (config.transferInfoUrl) setTransferInfoUrl(config.transferInfoUrl)
      if (config.cardSetupAmount) setCardSetupAmount(Number(config.cardSetupAmount))
      setSettings((current) => ({
        ...current,
        receipt: {
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
        },
        checkout: {
          ...current.checkout,
          logoUrl: current.checkout.logoUrl || config.companyLogoUrl || ''
        }
      }))
    } catch {
      // Usar valores por defecto si no hay configuración todavía.
    }
  }

  const saveHighLevelInvoiceConfig = useCallback(async (nextSettings: PaymentSettings, modeOverride: PaymentModeId = paymentMode) => {
    if (!highLevelConnected) return

    const response = await fetch('/api/highlevel/invoice-config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invoiceTitle: paymentTitle.trim(),
        invoiceNumberPrefix: paymentNumberPrefix.trim(),
        invoiceTermsNotes: nextSettings.receipt.terms.trim() || null,
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
  }, [cardSetupAmount, highLevelConnected, paymentDueDays, paymentMode, paymentNumberPrefix, paymentTitle, transferInfoUrl])

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
          showToast('warning', 'Pagos guardado', highLevelError.message || 'La configuración global se guardó, pero GoHighLevel necesita revisión.')
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

  const loadStripeConfig = async () => {
    setLoadingStripeConfig(true)
    try {
      const config = await stripePaymentsService.getConfig()
      applyStripeConfig(config)
    } catch {
      setStripeConfig(null)
      setStripeManualCredentials(emptyStripeModeCredentials)
    } finally {
      setLoadingStripeConfig(false)
    }
  }

  const applyConektaConfig = (config: ConektaPaymentConfig) => {
    setConektaConfig(config)
    setConektaManualCredentials(getConektaModeCredentialsFromConfig(config))
    setConektaConnectionFailed(false)
  }

  const loadConektaConfig = async () => {
    setLoadingConektaConfig(true)
    try {
      const config = await conektaPaymentsService.getConfig()
      applyConektaConfig(config)
    } catch {
      setConektaConfig(null)
      setConektaManualCredentials(emptyConektaModeCredentials)
    } finally {
      setLoadingConektaConfig(false)
    }
  }

  const applyMercadoPagoConfig = (config: MercadoPagoPaymentConfig) => {
    setMercadoPagoConfig(config)
  }

  const loadMercadoPagoConfig = async () => {
    setLoadingMercadoPagoConfig(true)
    try {
      const config = await mercadoPagoPaymentsService.getConfig()
      applyMercadoPagoConfig(config)
    } catch {
      setMercadoPagoConfig(null)
    } finally {
      setLoadingMercadoPagoConfig(false)
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
        loadMercadoPagoConfig()
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
          secretKey: modeValues.secretKey.trim(),
          webhookSecret: modeValues.webhookSecret.trim()
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

  const handleSaveStripeModeConfig = async (mode: StripeModeId) => {
    setSavingStripeMode(mode)
    try {
      const config = await stripePaymentsService.saveConfig(buildStripeModeConfigPayload(mode))
      applyStripeConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Stripe guardado', `${stripeModeLabels[mode].title} quedó listo para cobrar.`)
    } catch (error: any) {
      setStripeConnectionFailed(true)
      showToast('error', 'No se pudo guardar Stripe', error.message || 'Revisa las credenciales de Stripe.')
    } finally {
      setSavingStripeMode(null)
    }
  }

  const handleDisconnectStripeMode = (mode: StripeModeId) => {
    showConfirm(
      'Desconectar Stripe',
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
      showToast('success', 'Conekta guardado', `${conektaModeLabels[mode].title} quedó listo para cobrar.`)
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

  const handleSectionChange = (sectionId: string) => {
    if (!isPaymentsSectionId(sectionId)) return
    setActiveSection(sectionId)
    navigate(sectionId === 'checkout' ? '/settings/payments' : `/settings/payments/${sectionId}`)
  }

  const handleSelectGateway = (gateway: PaymentGatewayOption) => {
    setSelectedGateway(gateway.id)
    navigate(`/settings/payments/${gateway.id}`)
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
      const session = await paymentSettingsService.createReceiptPreviewSession(latestSettingsRef.current, accountCurrency)
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

  const updatePaymentMetaPurchaseEventParameters = (patch: Partial<PaymentMetaPurchaseEventParameters>) => {
    updatePaymentMetaPurchaseEventConfig({
      parameters: {
        ...paymentMetaPurchaseEventConfig.parameters,
        ...patch
      }
    }).catch(() => {})
  }

  const addPaymentMetaPurchaseEventCustomParameter = () => {
    const currentParameters = paymentMetaPurchaseEventConfig.parameters.custom || []
    updatePaymentMetaPurchaseEventParameters({
      custom: [...currentParameters, createDefaultPaymentMetaPurchaseEventParameter()]
    })
  }

  const updatePaymentMetaPurchaseEventCustomRow = (parameterId: string, patch: Partial<PaymentMetaPurchaseEventParameter>) => {
    const currentParameters = paymentMetaPurchaseEventConfig.parameters.custom || []
    updatePaymentMetaPurchaseEventParameters({
      custom: currentParameters.map((parameter) => (
        parameter.id === parameterId ? { ...parameter, ...patch } : parameter
      ))
    })
  }

  const removePaymentMetaPurchaseEventCustomRow = (parameterId: string) => {
    const currentParameters = paymentMetaPurchaseEventConfig.parameters.custom || []
    updatePaymentMetaPurchaseEventParameters({
      custom: currentParameters.filter((parameter) => parameter.id !== parameterId)
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

        <div className={styles.formGrid}>
          <div className={`${styles.formField} ${styles.fullWidthField}`}>
            <span>Logo del negocio</span>
            <div className={styles.logoUploadControl}>
              <div className={styles.logoUploadPreview}>
                {checkout.logoUrl ? <img src={checkout.logoUrl} alt="" /> : <Image size={22} />}
              </div>
              <div className={styles.logoUploadContent}>
                <div className={styles.logoUploadActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => checkoutLogoInputRef.current?.click()}
                    disabled={uploadingCheckoutLogo}
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
                  {checkout.logoUrl && (
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
                <small>Se guarda en Media y aparece en la parte superior del link de cobro.</small>
                {checkout.logoUrl && (
                  <input
                    type="url"
                    value={checkout.logoUrl}
                    onChange={(event) => setCheckoutValue('logoUrl', event.target.value)}
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
              placeholder="Explica qué va a revisar el cliente antes de pagar."
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
            'Email de soporte',
            <input
              type="email"
              value={checkout.supportEmail}
              onChange={(event) => setCheckoutValue('supportEmail', event.target.value)}
              placeholder="pagos@tu-negocio.com"
            />
          )}
          {renderField(
            'Teléfono de soporte',
            <input
              type="tel"
              value={checkout.supportPhone}
              onChange={(event) => setCheckoutValue('supportPhone', event.target.value)}
              placeholder="+52 656 000 0000"
            />
          )}
        </div>

        <div className={styles.subsectionBlock}>
          <div className={styles.subsectionHeader}>
            <h3>Información visible antes de pagar</h3>
            <p>Estos datos son los mismos del comprobante descargable y también aparecen en el resumen del link de cobro.</p>
          </div>

          <div className={styles.formGrid}>
            {renderField(
              'Nombre del negocio',
              <input
                type="text"
                value={receipt.businessName}
                onChange={(event) => setReceiptValue('businessName', event.target.value)}
                placeholder="Nombre comercial"
              />
            )}
            {renderField(
              'Email del negocio',
              <input
                type="email"
                value={receipt.businessEmail}
                onChange={(event) => setReceiptValue('businessEmail', event.target.value)}
                placeholder="pagos@tu-negocio.com"
              />
            )}
            {renderField(
              'Teléfono del negocio',
              <input
                type="tel"
                value={receipt.businessPhone}
                onChange={(event) => setReceiptValue('businessPhone', event.target.value)}
                placeholder="+52 656 000 0000"
              />
            )}
            {renderField(
              'Sitio web',
              <input
                type="url"
                value={receipt.businessWebsite}
                onChange={(event) => setReceiptValue('businessWebsite', event.target.value)}
                placeholder="https://tu-negocio.com"
              />
            )}
            {renderField(
              'Dirección fiscal o comercial',
              <textarea
                value={receipt.businessAddress}
                onChange={(event) => setReceiptValue('businessAddress', event.target.value)}
                placeholder="Calle, ciudad, estado, país"
              />
            )}
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Términos y condiciones</span>
              <textarea
                className={styles.largeTextarea}
                value={receipt.terms}
                onChange={(event) => setReceiptValue('terms', event.target.value)}
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
          {checkout.logoUrl ? <img src={checkout.logoUrl} alt="" /> : <span>{(receipt.businessName || 'R').slice(0, 1)}</span>}
          <div>
            <strong>{checkout.headline || 'Pago seguro'}</strong>
            <p>{checkout.description || 'Revisa el resumen y completa tu pago con tarjeta.'}</p>
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
        {receipt.showBusinessInfo && (receipt.businessName || receipt.businessEmail || receipt.businessPhone || receipt.businessAddress || receipt.businessWebsite) && (
          <div className={styles.previewInfoBlock}>
            <strong>{receipt.businessName || 'Tu negocio'}</strong>
            {receipt.businessEmail && <span>{receipt.businessEmail}</span>}
            {receipt.businessPhone && <span>{receipt.businessPhone}</span>}
            {receipt.businessAddress && <span>{receipt.businessAddress}</span>}
            {receipt.businessWebsite && <span>{receipt.businessWebsite}</span>}
          </div>
        )}
        {receipt.showTerms && receipt.terms && (
          <p className={styles.previewTerms}>
            <strong>Términos y condiciones</strong>
            <span>{receipt.terms}</span>
          </p>
        )}
        <div className={styles.previewButton}>
          <CreditCard size={16} />
          {checkout.buttonLabel || 'Pagar ahora'}
        </div>
        {checkout.showSecureBadge && (
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
            <p>Elige cómo quieres enviar la conversión de compras al momento de pagar.</p>
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

            <div className={styles.paymentMetaEventSmartHint}>
              <Info size={16} />
              <div>
                <strong>Modo inteligente</strong>
                <small>
                  Si el contacto nació por WhatsApp con atribución, se manda LeadSubmitted por Business Messaging.
                  Si no se detecta ese origen, se manda desde Sitios con acción de Website.
                </small>
              </div>
            </div>

            <label className={styles.paymentMetaEventField}>
              <span className={styles.paymentMetaEventFieldTitle}>Evento de Meta</span>
              <CustomSelect
                value={paymentMetaPurchaseEventConfig.eventName}
                onValueChange={(value) => updatePaymentMetaPurchaseEventConfig({ eventName: value })}
                options={PAYMENT_META_EVENT_OPTIONS}
              />
              <small>Usa Purchase para reportes de conversión de compras cuando el pago no venga de WhatsApp.</small>
            </label>

            <div className={styles.paymentMetaEventField}>
              <button
                type="button"
                className={[
                  styles.paymentMetaEventInlineToggle,
                  paymentMetaPurchaseEventParamsOpen ? styles.paymentMetaEventInlineToggleActive : '',
                  paymentMetaPurchaseEventHasParameters ? styles.paymentMetaEventInlineToggleFilled : ''
                ].filter(Boolean).join(' ')}
                aria-expanded={paymentMetaPurchaseEventParamsOpen}
                onClick={() => setPaymentMetaPurchaseEventParamsOpen(open => !open)}
              >
                <SlidersHorizontal size={14} />
                <span>Parámetros opcionales</span>
                <ChevronDown size={13} />
              </button>

              {paymentMetaPurchaseEventParamsOpen && (
                <div className={styles.paymentMetaEventParameterPanel}>
                  <div className={styles.paymentMetaEventCurrencyNote}>
                    <span>Moneda del contacto</span>
                    <strong>{accountCurrency}</strong>
                    <small>Se usa para convertir y calcular métricas en Meta.</small>
                  </div>

                  <div className={styles.paymentMetaEventParameterGrid}>
                    {PAYMENT_META_PARAMETER_FIELDS.map(field => (
                      <label key={field.key}>
                        <span className={styles.paymentMetaEventParameterLabel}>{field.label}</span>
                        <input
                          disabled={field.key === 'value' && !paymentMetaPurchaseEventConfig.parameters.sendValue}
                          value={String(paymentMetaPurchaseEventConfig.parameters[field.key] || '')}
                          onChange={(event) => updatePaymentMetaPurchaseEventParameters({ [field.key]: event.target.value } as Partial<PaymentMetaPurchaseEventParameters>)}
                          placeholder={field.placeholder}
                        />
                        {field.key === 'value' && !paymentMetaPurchaseEventConfig.parameters.sendValue ? (
                          <small>Activa “Incluir monto del pago” para enviarlo.</small>
                        ) : null}
                      </label>
                    ))}
                  </div>

                  <div className={styles.paymentMetaEventCustomParameterHeader}>
                    <span className={styles.paymentMetaEventFieldTitle}>Parámetros extra</span>
                    <Button variant="secondary" size="small" onClick={addPaymentMetaPurchaseEventCustomParameter}>
                      <Plus size={14} />
                      Añadir parámetro
                    </Button>
                  </div>

                  <div className={styles.paymentMetaEventCustomParameterList}>
                    {(paymentMetaPurchaseEventConfig.parameters.custom || []).length ? (
                      (paymentMetaPurchaseEventConfig.parameters.custom || []).map(parameter => (
                        <div key={parameter.id} className={styles.paymentMetaEventCustomParameterRow}>
                          <input
                            value={parameter.key}
                            onChange={(event) => updatePaymentMetaPurchaseEventCustomRow(parameter.id, { key: event.target.value })}
                            placeholder="nombre_parametro"
                          />
                          <input
                            value={parameter.value}
                            onChange={(event) => updatePaymentMetaPurchaseEventCustomRow(parameter.id, { value: event.target.value })}
                            placeholder="valor"
                          />
                          <Button
                            variant="ghost"
                            size="small"
                            onClick={() => removePaymentMetaPurchaseEventCustomRow(parameter.id)}
                            aria-label="Eliminar parámetro"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className={styles.paymentMetaEventCustomParameterEmpty}>
                        Sin parámetros extra. Puedes usar esto para enviar campos personalizados por cada pago.
                      </p>
                    )}
                  </div>

                  <small>
                    Si no escribes nada aquí, Ristak manda al menos el evento, moneda y tipo de conversión para Meta.
                  </small>
                </div>
              )}
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
              <p>Configura la hoja PDF que el cliente podrá descargar desde la confirmación de pago.</p>
            </div>
            <Badge variant="success">
              <FileCheck2 size={14} />
              PDF
            </Badge>
          </div>

          <div className={styles.formGrid}>
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Logo del comprobante</span>
              <div className={styles.logoUploadControl}>
                <div className={styles.logoUploadPreview}>
                  {receipt.logoUrl ? <img src={receipt.logoUrl} alt="" /> : <Image size={22} />}
                </div>
                <div className={styles.logoUploadContent}>
                  <div className={styles.logoUploadActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => receiptLogoInputRef.current?.click()}
                      disabled={uploadingReceiptLogo}
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
                    {receipt.logoUrl && (
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
                  <small>Se guarda en Media y se usa en la hoja PDF del comprobante.</small>
                  {receipt.logoUrl && (
                    <input
                      type="url"
                      value={receipt.logoUrl}
                      onChange={(event) => setReceiptValue('logoUrl', event.target.value)}
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
                value={receipt.businessName}
                onChange={(event) => setReceiptValue('businessName', event.target.value)}
                placeholder="Nombre comercial"
              />
            )}
            {renderField(
              'Email del negocio',
              <input
                type="email"
                value={receipt.businessEmail}
                onChange={(event) => setReceiptValue('businessEmail', event.target.value)}
                placeholder="pagos@tu-negocio.com"
              />
            )}
            {renderField(
              'Teléfono del negocio',
              <input
                type="tel"
                value={receipt.businessPhone}
                onChange={(event) => setReceiptValue('businessPhone', event.target.value)}
                placeholder="+52 656 000 0000"
              />
            )}
            {renderField(
              'Sitio web',
              <input
                type="url"
                value={receipt.businessWebsite}
                onChange={(event) => setReceiptValue('businessWebsite', event.target.value)}
                placeholder="https://tu-negocio.com"
              />
            )}
            {renderField(
              'Dirección fiscal o comercial',
              <textarea
                value={receipt.businessAddress}
                onChange={(event) => setReceiptValue('businessAddress', event.target.value)}
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
                value={receipt.terms}
                onChange={(event) => setReceiptValue('terms', event.target.value)}
                placeholder="Políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio."
              />
              <small>Este texto puede ser largo y también se sincroniza como nota de términos para comprobantes de GoHighLevel cuando esté conectado.</small>
            </div>
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow('Mostrar datos del negocio', 'Incluye nombre, contacto y dirección en la hoja.', receipt.showBusinessInfo, (next) => setReceiptValue('showBusinessInfo', next))}
            {renderSwitchRow('Mostrar datos del cliente', 'Incluye nombre, email y referencia del pago.', receipt.showCustomerInfo, (next) => setReceiptValue('showCustomerInfo', next))}
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
                  {receipt.logoUrl ? (
                    <img src={receipt.logoUrl} alt="" />
                  ) : (
                    <span><ReceiptText size={22} /></span>
                  )}
                  <div>
                    <strong>{receipt.businessName || 'Tu negocio'}</strong>
                    <p>{receipt.businessWebsite || receipt.businessEmail || 'tu-negocio.com'}</p>
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
                    <strong>{receipt.businessName || 'Tu negocio'}</strong>
                    {receipt.businessEmail && <p>{receipt.businessEmail}</p>}
                    {receipt.businessPhone && <p>{receipt.businessPhone}</p>}
                    {receipt.businessAddress && <p>{receipt.businessAddress}</p>}
                  </div>
                )}
                {receipt.showCustomerInfo && (
                  <div>
                    <span>Cliente</span>
                    <strong>María López</strong>
                    <p>maria@cliente.com</p>
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
                  <p>{receipt.terms || 'Agrega aquí políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio.'}</p>
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
    channel: PaymentAutomationSettings['reminderChannel'],
    contextLabel: string
  ) => {
    if (!channelUsesWhatsApp(channel)) return null

    if (!whatsappAvailability.canShowQrFallbackSwitch) {
      if (!whatsappAvailability.hasQrConnected) return null

      return (
        <div className={`${styles.automationQrFallback} ${styles.automationQrNotice}`}>
          <AlertTriangle className={styles.automationQrFallbackIcon} size={17} aria-hidden="true" />
          <div>
            <strong>{WHATSAPP_QR_PRECAUTION_TITLE}</strong>
            <span>Sólo hay QR conectado para WhatsApp. {WHATSAPP_QR_PRECAUTION_MESSAGE} Conecta WhatsApp API para activar QR como respaldo controlado.</span>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.automationQrFallback}>
        <AlertTriangle className={styles.automationQrFallbackIcon} size={17} aria-hidden="true" />
        <div>
          <strong>QR como respaldo</strong>
          <span>WhatsApp API se intenta primero. QR sólo entra si la API falla o queda restringida. {WHATSAPP_QR_PRECAUTION_MESSAGE}</span>
        </div>
        <Switch
          checked={checked}
          onChange={(next) => setAutomationQrFallbackValue(key, next, contextLabel)}
          aria-label={`Activar QR como respaldo para ${contextLabel}`}
        />
      </div>
    )
  }

  const getAutomationWhatsAppHelp = (
    channel: PaymentAutomationSettings['reminderChannel'],
    apiHelp: string
  ) => {
    if (!channelUsesWhatsApp(channel)) return undefined
    if (whatsappAvailability.hasApiConnected) return apiHelp
    if (whatsappAvailability.hasQrConnected) return 'Sólo hay QR conectado para WhatsApp; revisa la advertencia de abajo antes de automatizar envíos.'
    return 'Conecta WhatsApp API para enviar mensajes por WhatsApp desde esta automatización.'
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
    if (!channelUsesWhatsApp(channel)) return null

    const config = paymentAutomationTemplateDefaults[kind]
    const value = getAutomationTemplateValue(kind)
    const selectedTemplate = paymentWhatsappTemplates.find((template) => (
      template.id === value || template.name === value
    ))
    const templateName = selectedTemplate?.name || getAutomationTemplateName(kind)

    return (
      <div className={styles.automationTemplateBlock}>
        {renderField(
          'Plantilla WhatsApp API',
          <CustomSelect
            value={value}
            onValueChange={(nextValue) => setAutomationTemplateValue(kind, nextValue)}
            options={paymentWhatsappTemplateOptions}
            placeholder={loadingPaymentWhatsappTemplates ? 'Cargando plantillas...' : 'Selecciona una plantilla'}
            disabled={loadingPaymentWhatsappTemplates && paymentWhatsappTemplateOptions.length === 0}
          />,
          selectedTemplate
            ? `Usará ${selectedTemplate.name} (${selectedTemplate.language || config.defaultLanguage}).`
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
      </div>
    )
  }

  const renderAutomationsSection = () => (
    <div className={styles.singleColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Automatizaciones de pago</h2>
            <p>Separa lo que pasa antes del vencimiento, después de pagar y cuando un cobro falla.</p>
          </div>
          <Badge variant="warning">
            <BellRing size={14} />
            WhatsApp API primero
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
                automations.reminderChannel,
                'recordatorios antes del pago'
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
                automations.receiptDeliveryChannel,
                'comprobantes después del pago'
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
                  placeholder="Mensaje que recibirá el cliente cuando el pago entre."
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
                automations.failedPaymentChannel,
                'avisos de cobro fallido'
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
          <span>{channelLabelById[automations.reminderChannel]}{channelUsesWhatsApp(automations.reminderChannel) ? ` · ${getAutomationTemplateName('reminder')}` : ''}{whatsappAvailability.canShowQrFallbackSwitch && automations.reminderQrFallbackEnabled ? ' · QR respaldo' : ''}</span>
        </div>
        <div>
          <CheckCircle size={17} />
          <strong>{automations.receiptDeliveryEnabled ? 'Comprobante activo' : 'Comprobante apagado'}</strong>
          <span>{afterPaymentActionLabelById[automations.afterPaymentAction]} · {channelLabelById[automations.receiptDeliveryChannel]}{channelUsesWhatsApp(automations.receiptDeliveryChannel) ? ` · ${getAutomationTemplateName('receipt')}` : ''}{whatsappAvailability.canShowQrFallbackSwitch && automations.receiptQrFallbackEnabled ? ' · QR respaldo' : ''}</span>
        </div>
        <div>
          <AlertTriangle size={17} />
          <strong>{automations.failedPaymentEnabled ? `${automations.failedPaymentDelayHours} h tras fallo` : 'Sin seguimiento'}</strong>
          <span>{channelLabelById[automations.failedPaymentChannel]}{channelUsesWhatsApp(automations.failedPaymentChannel) ? ` · ${getAutomationTemplateName('failed')}` : ''}{whatsappAvailability.canShowQrFallbackSwitch && automations.failedPaymentQrFallbackEnabled ? ' · QR respaldo' : ''}</span>
        </div>
      </div>
    </div>
  )

  const renderGatewaysSection = () => (
    <div className={styles.singleColumnLayout}>
      {activeGatewayRoute && (
        <div className={styles.gatewayDetailBar}>
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate('/settings/payments/gateways')}>
            <WalletCards size={16} />
            Pasarelas
          </Button>
          <Badge variant={selectedGatewayOption ? gatewayStatusCopy[selectedGatewayOption.status].variant : 'neutral'}>
            {selectedGatewayOption ? gatewayStatusCopy[selectedGatewayOption.status].label : 'Sin conexión'}
          </Badge>
        </div>
      )}

      <Card className={styles.paymentModeCard}>
        <div className={styles.paymentModeCopy}>
          <Badge variant={paymentMode === 'live' ? 'success' : 'warning'}>
            <Clock size={14} />
            {paymentModeCopy.badge}
          </Badge>
          <div>
            <h2>Modo global de pasarelas</h2>
            <p>{paymentModeCopy.description} Este switch aplica a Stripe, Conekta, GoHighLevel y Mercado Pago para nuevos cobros.</p>
          </div>
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
      </Card>

      {!activeGatewayRoute && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Pasarela de pagos</h2>
              <p>Elige con qué proveedor se cobran links, tarjetas, parcialidades y suscripciones.</p>
            </div>
          </div>

          <div className={styles.gatewayList}>
            {gatewayOptions.map((gateway) => {
              const isConnected = gateway.status === 'connected'
              const statusCopy = gatewayStatusCopy[gateway.status]

              return (
                <Card key={gateway.id} className={styles.gatewayItem} padding="md">
                  <div className={styles.gatewayItemIdentity}>
                    {gateway.logo && (
                      <PaymentPlatformLogo platform={gateway.logo} size="lg" decorative />
                    )}
                    <div className={styles.gatewayItemCopy}>
                      <div className={styles.gatewayItemTitleRow}>
                        <strong>{gateway.name}</strong>
                        <Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
                      </div>
                      <p>{gateway.description}</p>
                    </div>
                  </div>
                  <div className={styles.gatewayItemActions}>
                    <Button type="button" variant="primary" size="sm" onClick={() => handleSelectGateway(gateway)}>
                      {isConnected ? 'Abrir' : 'Configurar'}
                    </Button>
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
                <h2>Configuración manual de Stripe</h2>
                <p>Pega las llaves de prueba y en vivo de tu propia cuenta de Stripe. Ristak las guarda en backend y las usa para crear cobros, links, planes y suscripciones.</p>
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
                      <Badge variant={stripeModeIsComplete(mode) || savedMode?.configured ? 'success' : 'neutral'}>
                        {stripeModeIsComplete(mode) || savedMode?.configured ? 'Listo' : 'Pendiente'}
                      </Badge>
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
                      {renderField(
                        'Webhook signing secret',
                        <input
                          type="password"
                          value={values.webhookSecret}
                          onChange={(event) => updateStripeModeCredential(mode, 'webhookSecret', event.target.value)}
                          onFocus={(event) => {
                            if (savedMode?.webhookSecretPreview && values.webhookSecret === savedMode.webhookSecretPreview) event.currentTarget.select()
                          }}
                          placeholder={savedMode?.hasWebhookSecret ? savedMode.webhookSecretPreview : 'whsec_...'}
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

            {stripeWebhookEndpoints.length > 0 && (
              <div className={styles.webhookList}>
                <h3>Endpoint URL</h3>
                {stripeWebhookEndpoints.map((endpoint) => (
                  <div key={endpoint.url} className={styles.formField}>
                    <span>{endpoint.label}</span>
                    <input
                      type="text"
                      readOnly
                      value={endpoint.url}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'conekta' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div className={styles.gatewaySectionTitle}>
              <PaymentPlatformLogo platform="conekta" size="lg" decorative />
              <div>
                <h2>Configuración manual de Conekta</h2>
                <p>Pega las llaves pública y privada de Conekta. Ristak usa la pública para tokenizar tarjetas y la privada para crear órdenes y cargos con tarjetas guardadas.</p>
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
                      <Badge variant={conektaModeIsComplete(mode) || savedMode?.configured ? 'success' : 'neutral'}>
                        {conektaModeIsComplete(mode) || savedMode?.configured ? 'Listo' : 'Pendiente'}
                      </Badge>
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
                <p>Conecta Mercado Pago para crear links de Checkout Pro y suscripciones desde Ristak.</p>
              </div>
            </div>
            {loadingMercadoPagoConfig ? (
              <Badge variant="warning">
                <Loader2 size={14} className={styles.spinIcon} />
                Cargando
              </Badge>
            ) : mercadoPagoConnected ? (
              <Badge variant="success">
                <ShieldCheck size={14} />
                Conectado
              </Badge>
            ) : (
              <Badge variant="info">
                <KeyRound size={14} />
                Listo para conectar
              </Badge>
            )}
          </div>

          <div className={styles.stripePanel}>
            {(() => {
              const modeConnection = mercadoPagoConfig?.modeConnections?.[paymentMode]
              const modeConnected = mercadoPagoModeIsConnected(paymentMode)
              const accountLabel = modeConnection?.accountLabel || mercadoPagoConfig?.accountLabel || 'Mercado Pago'
              const userId = modeConnection?.userId || mercadoPagoConfig?.userId || 'Cuenta conectada'
              const tokenLabel = (modeConnection?.hasRefreshToken ?? mercadoPagoConfig?.hasRefreshToken) ? 'Renovable' : 'Conectado'

              return (
                <div className={styles.mercadoPagoConnectionPanel}>
                  <div className={styles.stripeModeHeader}>
                    <div>
                      <h3>{paymentMode === 'test' ? 'Conexión de prueba' : 'Conexión en vivo'}</h3>
                      <p>{paymentModeCopy.mercadoPagoHelp}</p>
                    </div>
                    <Badge variant={modeConnected ? 'success' : 'neutral'}>
                      {modeConnected ? 'Conectado' : 'Pendiente'}
                    </Badge>
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
                        ? 'Mercado Pago no tiene un switch sandbox separado dentro de Ristak: para probar debes autorizar con un TEST USER creado desde tu panel de Developers.'
                        : 'Este modo usa tu cuenta real de Mercado Pago. Los links y suscripciones nuevos pueden generar cobros reales.'}
                    </span>
                  </div>

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
                          {modeConnected ? 'Reconectar cuenta' : paymentMode === 'test' ? 'Conectar TEST USER' : 'Conectar cuenta real'}
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
    </div>
  )

  const renderTaxesSection = () => {
    const previewBaseAmount = 2490
    const previewTaxAmount = calculatePreviewTax(previewBaseAmount, taxes)
    const previewTotalAmount = taxes.enabled && taxes.calculationMode === 'exclusive'
      ? previewBaseAmount + previewTaxAmount
      : previewBaseAmount
    const taxRateLabel = `${getTaxRateValue(taxes)}%`
    const gigstackTokenInputValue = taxes.gigstackApiToken || (taxes.hasGigstackApiToken ? taxes.gigstackApiTokenPreview || '••••' : '')
    const showingSavedGigstackToken = Boolean(!taxes.gigstackApiToken && taxes.hasGigstackApiToken && gigstackTokenInputValue)

    return (
      <div className={styles.taxSettingsLayout}>
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Impuestos</h2>
              <p>Activa una regla fiscal global para que los formularios de cobro muestren impuestos solo cuando corresponda.</p>
            </div>
            <Badge variant={taxes.enabled ? 'success' : 'neutral'}>
              <Percent size={14} />
              {taxes.enabled ? 'Activo' : 'Apagado'}
            </Badge>
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow('Cobrar impuestos', 'Cuando está apagado, registrar pagos y links no muestran opciones de impuestos.', taxes.enabled, (next) => setTaxValue('enabled', next))}
          </div>

          <div className={styles.formGrid}>
            {renderField(
              'Nombre del impuesto',
              <input
                type="text"
                value={taxes.taxName}
                onChange={(event) => setTaxValue('taxName', event.target.value)}
                placeholder="IVA"
              />
            )}
            {renderField(
              'País de la tasa automática',
              <CustomSelect
                value={taxes.country || 'MX'}
                onValueChange={(value) => setTaxValue('country', value)}
                options={taxCountryOptions}
              />,
              `Ristak usará ${taxRateLabel} según el país seleccionado.`
            )}
            {renderField(
              'Modo de cálculo',
              <CustomSelect
                value={taxes.calculationMode}
                onValueChange={(value) => setTaxValue('calculationMode', value as PaymentTaxSettings['calculationMode'])}
                options={[
                  { value: 'exclusive', label: 'Se suma al total' },
                  { value: 'inclusive', label: 'Ya incluido en el precio' }
                ]}
              />
            )}
            {renderField(
              'RFC / ID fiscal',
              <input
                type="text"
                value={taxes.fiscalId}
                onChange={(event) => setTaxValue('fiscalId', event.target.value)}
                placeholder="RFC o identificador fiscal"
              />
            )}
            {renderField(
              'Razón social fiscal',
              <input
                type="text"
                value={taxes.fiscalLegalName}
                onChange={(event) => setTaxValue('fiscalLegalName', event.target.value)}
                placeholder="Nombre o razón social"
              />
            )}
            {renderField(
              'Código postal fiscal',
              <input
                type="text"
                value={taxes.fiscalPostalCode}
                onChange={(event) => setTaxValue('fiscalPostalCode', event.target.value)}
                placeholder="Ej. 06600"
              />
            )}
            {renderField(
              'Régimen fiscal',
              <input
                type="text"
                value={taxes.fiscalRegime}
                onChange={(event) => setTaxValue('fiscalRegime', event.target.value)}
                placeholder="Ej. 612 - Personas físicas"
              />
            )}
          </div>

          {renderSectionSaveBar('Guardar impuestos')}
        </Card>

        <Card className={styles.gigstackCard}>
          <div className={styles.gigstackHeader}>
            <div>
              <h3>Facturas del SAT en automático</h3>
              <p>Gigstack es el servicio que timbra CFDI ante el SAT. Si lo conectas, Ristak manda los pagos con impuesto para que no estés facturando a mano.</p>
            </div>
            <Badge variant={taxes.gigstackEnabled ? (taxes.hasGigstackApiToken ? 'success' : 'warning') : 'neutral'}>
              {taxes.gigstackEnabled ? (taxes.hasGigstackApiToken ? 'Listo para facturar' : 'Falta conectar') : 'Opcional para facturar'}
            </Badge>
          </div>
          {renderSwitchRow('Quiero facturar automático', 'Cuando entra un pago con impuestos, Ristak intenta mandarlo a Gigstack para generar la factura sin capturarla a mano.', taxes.gigstackEnabled, (next) => setTaxValue('gigstackEnabled', next))}
          {renderField(
            'Token para conectar Gigstack',
            <input
              type="password"
              value={gigstackTokenInputValue}
              onChange={(event) => handleGigstackTokenChange(event.target.value)}
              onFocus={(event) => {
                if (showingSavedGigstackToken) event.currentTarget.select()
              }}
              placeholder="Pega el token JWT"
              autoComplete="off"
            />,
            taxes.hasGigstackApiToken ? 'Ya hay un token guardado. Selecciona el campo y pega uno nuevo si quieres cambiarlo.' : 'Lo sacas de Gigstack, en la sección de API, y lo pegas aquí para dejarlo conectado.'
          )}
          {taxes.hasGigstackApiToken && (
            <div className={styles.gigstackTokenActions}>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleDisconnectGigstack}
              >
                <Unplug size={15} />
                Desconectar Gigstack
              </Button>
            </div>
          )}
          <div className={styles.gigstackPortalSection}>
            <div className={styles.gigstackPortalHeader}>
              <div>
                <h4>Portal para que tus clientes facturen</h4>
                <p>Gigstack maneja un portal que puedes compartir para que el cliente genere o consulte sus facturas. Su API también genera links seguros por cliente, pero esos links necesitan cliente específico y vencen.</p>
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
              />,
              'Se usa en cobros directos o productos sin mapeo propio.'
            )}
            {renderField(
              'Unidad SAT por defecto',
              <CustomSelect
                value={taxes.gigstackDefaultUnitKey || defaultPaymentSettings.taxes.gigstackDefaultUnitKey}
                onValueChange={setGigstackDefaultUnit}
                options={gigstackUnitOptions}
              />
            )}
            {renderField(
              'Forma de pago fallback',
              <CustomSelect
                value={taxes.gigstackDefaultPaymentMethod || defaultPaymentSettings.taxes.gigstackDefaultPaymentMethod}
                onValueChange={(value) => setTaxValue('gigstackDefaultPaymentMethod', value)}
                options={gigstackPaymentMethodOptions}
              />,
              'Ristak detecta tarjeta, transferencia o efectivo; esto cubre casos desconocidos.'
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
          <div className={styles.taxPreview}>
            <div>
              <span>Subtotal</span>
              <strong>{formatCompactMoney(previewBaseAmount, accountCurrency)}</strong>
            </div>
            <div>
              <span>{taxes.taxName || 'IVA'} · {taxRateLabel}</span>
              <strong>{taxes.enabled ? formatCompactMoney(previewTaxAmount, accountCurrency) : 'Apagado'}</strong>
            </div>
            <div>
              <span>Total mostrado</span>
              <strong>{formatCompactMoney(previewTotalAmount, accountCurrency)}</strong>
            </div>
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
        subtitle="Configura el cobro, comprobante, automatizaciones, pasarelas e impuestos desde un solo setup."
      />

      <div className={styles.setupHeader}>
        <SegmentTabs
          aria-label="Setup de configuración de pagos"
          className={styles.setupTabs}
          tabs={sectionItems.map((item) => ({
            id: item.id,
            label: item.label,
            icon: item.icon
          }))}
          value={activeSection}
          onChange={handleSectionChange}
        />
      </div>

      {activeSection === 'checkout' && renderCheckoutSection()}
      {activeSection === 'receipt' && renderReceiptSection()}
      {activeSection === 'meta' && renderMetaSection()}
      {activeSection === 'automations' && renderAutomationsSection()}
      {activeSection === 'gateways' && renderGatewaysSection()}
      {activeSection === 'taxes' && renderTaxesSection()}
    </PageContainer>
  )
}
