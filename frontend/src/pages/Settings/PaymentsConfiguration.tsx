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
  KeyRound,
  Loader2,
  Paintbrush,
  Percent,
  ReceiptText,
  ShieldCheck,
  Sparkles,
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
  SegmentTabs,
  Switch
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
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
import { mercadoPagoPaymentsService, type MercadoPagoPaymentConfig, type MercadoPagoWebhookEndpoint } from '@/services/mercadoPagoPaymentsService'
import { stripePaymentsService, type StripePaymentConfig, type StripeWebhookEndpoint } from '@/services/stripePaymentsService'
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
import styles from './PaymentsConfiguration.module.css'

type PaymentsSectionId = 'checkout' | 'receipt' | 'automations' | 'gateways' | 'taxes'
type PaymentGatewayId = 'highlevel' | 'stripe' | 'mercadopago' | 'clip'
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error'
type PaymentAutomationTemplateKind = 'reminder' | 'receipt' | 'failed'

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'available' | 'soon'
}

const gatewayStatusCopy: Record<PaymentGatewayOption['status'], { label: string; variant: 'success' | 'warning' | 'neutral' }> = {
  connected: { label: 'Conectada', variant: 'success' },
  available: { label: 'Sin conexión', variant: 'neutral' },
  soon: { label: 'Próximamente', variant: 'warning' }
}

const sectionItems: Array<{ id: PaymentsSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'checkout', label: 'Página de cobro', icon: <CreditCard size={17} /> },
  { id: 'receipt', label: 'Comprobante', icon: <ReceiptText size={17} /> },
  { id: 'automations', label: 'Automatizaciones', icon: <BellRing size={17} /> },
  { id: 'gateways', label: 'Pasarelas', icon: <WalletCards size={17} /> },
  { id: 'taxes', label: 'Impuestos', icon: <Percent size={17} /> }
]

const sectionIds = sectionItems.map((item) => item.id)
const gatewayIds: PaymentGatewayId[] = ['highlevel', 'stripe', 'mercadopago', 'clip']
const defaultStripeMode: StripePaymentConfig['mode'] = 'live'
const GIGSTACK_API_URL = 'https://gigstack.pro/api-facturacion'

const taxCountryOptions = [
  { value: 'MX', label: 'México · IVA 16%' },
  { value: 'CO', label: 'Colombia · IVA 19%' },
  { value: 'CL', label: 'Chile · IVA 19%' },
  { value: 'US', label: 'Estados Unidos · automático 0%' }
]

const MERCADOPAGO_WEBHOOK_EVENTS = [
  {
    name: 'payment',
    description: 'Cuando un pago cambia de estado en Mercado Pago.'
  },
  {
    name: 'mp-connect',
    description: 'Cuando la conexión OAuth de Mercado Pago cambia.'
  }
]

const STRIPE_WEBHOOK_EVENTS = [
  {
    name: 'payment_intent.succeeded',
    description: 'Cuando el pago con tarjeta de la página pública se completa.'
  },
  {
    name: 'payment_intent.payment_failed',
    description: 'Cuando Stripe rechaza o falla el intento de pago.'
  },
  {
    name: 'payment_intent.canceled',
    description: 'Cuando un cobro se cancela antes de completarse.'
  },
  {
    name: 'charge.refunded',
    description: 'Cuando un cargo se reembolsa, incluso si el reembolso es parcial.'
  },
  {
    name: 'refund.created',
    description: 'Cuando Stripe registra un reembolso nuevo.'
  },
  {
    name: 'invoice.payment_succeeded',
    description: 'Cuando un comprobante de Stripe queda pagado.'
  },
  {
    name: 'invoice.payment_failed',
    description: 'Cuando un comprobante de Stripe falla.'
  }
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

async function copyTextToClipboard(text: string) {
  if (!text) return false

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Continúa con fallback por selección.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
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

const getPreferredStripeMode = (config?: StripePaymentConfig | null): StripePaymentConfig['mode'] => {
  if (!config) return defaultStripeMode
  return config.mode || defaultStripeMode
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
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle')
  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [transferInfoUrl, setTransferInfoUrl] = useState('')
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [ghlInvoiceMode, setGhlInvoiceMode] = useState<'live' | 'test'>('live')
  const [stripeConfig, setStripeConfig] = useState<StripePaymentConfig | null>(null)
  const [stripeMode, setStripeMode] = useState<'test' | 'live'>(defaultStripeMode)
  const [stripeAccountLabel, setStripeAccountLabel] = useState('')
  const [stripePublishableKey, setStripePublishableKey] = useState('')
  const [stripeSecretKey, setStripeSecretKey] = useState('')
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState('')
  const [loadingStripeConfig, setLoadingStripeConfig] = useState(false)
  const [savingHighLevelConfig, setSavingHighLevelConfig] = useState(false)
  const [savingStripeConfig, setSavingStripeConfig] = useState(false)
  const [testingStripeConfig, setTestingStripeConfig] = useState(false)
  const [stripeConnectionFailed, setStripeConnectionFailed] = useState(false)
  const [disconnectingStripe, setDisconnectingStripe] = useState(false)
  const [mercadoPagoConfig, setMercadoPagoConfig] = useState<MercadoPagoPaymentConfig | null>(null)
  const [mercadoPagoMode, setMercadoPagoMode] = useState<'test' | 'live'>('live')
  const [loadingMercadoPagoConfig, setLoadingMercadoPagoConfig] = useState(false)
  const [connectingMercadoPago, setConnectingMercadoPago] = useState(false)
  const [switchingMercadoPagoMode, setSwitchingMercadoPagoMode] = useState(false)
  const [testingMercadoPagoConfig, setTestingMercadoPagoConfig] = useState(false)
  const [disconnectingMercadoPago, setDisconnectingMercadoPago] = useState(false)
  const [uploadingReceiptLogo, setUploadingReceiptLogo] = useState(false)
  const [receiptLogoUploadProgress, setReceiptLogoUploadProgress] = useState(0)
  const [previewingReceipt, setPreviewingReceipt] = useState(false)
  const [whatsappAvailability, setWhatsappAvailability] = useState<WhatsAppConnectionAvailability>(defaultWhatsAppAvailability)
  const [paymentWhatsappTemplates, setPaymentWhatsappTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [loadingPaymentWhatsappTemplates, setLoadingPaymentWhatsappTemplates] = useState(false)
  const receiptLogoInputRef = useRef<HTMLInputElement>(null)
  const latestSettingsRef = useRef(settings)
  const loadedSettingsRef = useRef(false)
  const lastSavedSettingsRef = useRef(JSON.stringify(defaultPaymentSettings))

  const checkout = settings.checkout
  const receipt = settings.receipt
  const automations = settings.automations
  const taxes = settings.taxes
  const routeSegment = getPaymentRouteSegment(location.pathname)
  const activeGatewayRoute = isPaymentGatewayId(routeSegment) ? routeSegment : null

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
    description: stripeConfig?.configured
      ? `Configurado manualmente con tu cuenta de Stripe en modo ${stripeConfig.mode === 'live' ? 'en vivo' : 'prueba'}.`
      : 'Configura Stripe con una Restricted API Key de tu propia cuenta.',
    status: stripeConfig?.configured ? 'connected' : 'available'
  }), [stripeConfig?.configured, stripeConfig?.mode])

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
    {
      id: 'mercadopago',
      name: 'Mercado Pago',
      description: mercadoPagoConfig?.configured
        ? `Cobra con Checkout Pro (${mercadoPagoConfig.mode === 'live' ? 'en vivo' : 'prueba'}).`
        : 'Conecta Mercado Pago para links de cobro y parcialidades controladas por Ristak.',
      status: mercadoPagoConfig?.configured ? 'connected' : 'available'
    },
    {
      id: 'clip',
      name: 'Clip',
      description: 'Para ventas con terminal o links de pago conectados a Clip.',
      status: 'soon'
    }
  ]

  const selectedGatewayOption = gatewayOptions.find((gateway) => gateway.id === (activeGatewayRoute || selectedGateway))
  const stripeWebhookEndpoints = stripeConfig?.webhookEndpoints || []
  const stripeConnected = Boolean(stripeConfig?.configured)
  const mercadoPagoConnected = Boolean(mercadoPagoConfig?.configured)
  const mercadoPagoWebhookReady = Boolean(mercadoPagoConfig?.hasWebhookSecret)
  const mercadoPagoWebhookEndpoints = mercadoPagoConfig?.webhookEndpoints || []
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
  const stripeCanSubmit = Boolean(stripePublishableKey.trim() && (stripeSecretKey.trim() || stripeConfig?.hasSecretKey))
  const isLoadingPage = loadingSettings || loadingHighLevelConnection || loadingStripeConfig || loadingMercadoPagoConfig
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
      setGhlInvoiceMode(config.ghlInvoiceMode === 'test' ? 'test' : 'live')

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

  const saveHighLevelInvoiceConfig = useCallback(async (nextSettings: PaymentSettings) => {
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
        ghlInvoiceMode
      })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || 'Error al guardar configuración de GoHighLevel')
    }

    window.dispatchEvent(new CustomEvent('ristak-payment-config-changed', {
      detail: { ghlInvoiceMode }
    }))
  }, [cardSetupAmount, ghlInvoiceMode, highLevelConnected, paymentDueDays, paymentNumberPrefix, paymentTitle, transferInfoUrl])

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
    setStripeMode(getPreferredStripeMode(config))
    setStripeAccountLabel(config.accountLabel || '')
    setStripePublishableKey(config.publishableKey || '')
    setStripeSecretKey(config.secretKeyPreview || '')
    setStripeWebhookSecret(config.webhookSecretPreview || '')
    setStripeConnectionFailed(false)
  }

  const loadStripeConfig = async () => {
    setLoadingStripeConfig(true)
    try {
      const config = await stripePaymentsService.getConfig()
      applyStripeConfig(config)
    } catch {
      setStripeConfig(null)
      setStripeMode(defaultStripeMode)
    } finally {
      setLoadingStripeConfig(false)
    }
  }

  const applyMercadoPagoConfig = (config: MercadoPagoPaymentConfig) => {
    setMercadoPagoConfig(config)
    setMercadoPagoMode(config.mode || 'live')
  }

  const loadMercadoPagoConfig = async () => {
    setLoadingMercadoPagoConfig(true)
    try {
      const config = await mercadoPagoPaymentsService.getConfig()
      applyMercadoPagoConfig(config)
    } catch {
      setMercadoPagoConfig(null)
      setMercadoPagoMode('live')
    } finally {
      setLoadingMercadoPagoConfig(false)
    }
  }

  const buildStripeConfigPayload = () => ({
    enabled: true,
    mode: stripeMode,
    defaultCurrency: accountCurrency,
    accountLabel: stripeAccountLabel.trim(),
    publishableKey: stripePublishableKey.trim(),
    secretKey: stripeSecretKey.trim(),
    webhookSecret: stripeWebhookSecret.trim()
  })

  const handleSaveStripeConfig = async () => {
    setSavingStripeConfig(true)
    try {
      const config = await stripePaymentsService.saveConfig(buildStripeConfigPayload())
      applyStripeConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Stripe guardado', 'Ristak ya puede crear links de pago con Stripe.')
    } catch (error: any) {
      setStripeConnectionFailed(true)
      showToast('error', 'No se pudo guardar Stripe', error.message || 'Revisa las credenciales de Stripe.')
    } finally {
      setSavingStripeConfig(false)
    }
  }

  const handleTestStripeConfig = async () => {
    setTestingStripeConfig(true)
    try {
      await stripePaymentsService.testConfig(buildStripeConfigPayload())
      setStripeConnectionFailed(false)
      showToast('success', 'Stripe respondió bien', 'La Restricted API Key permite consultar la cuenta.')
    } catch (error: any) {
      setStripeConnectionFailed(true)
      showToast('error', 'Stripe no respondió', error.message || 'Revisa la Restricted API Key.')
    } finally {
      setTestingStripeConfig(false)
    }
  }

  const handleStripeModeChange = (nextLive: boolean) => {
    const nextMode = nextLive ? 'live' : 'test'
    if (nextMode === stripeMode) return
    setStripeMode(nextMode)
  }

  const handleDisconnectStripe = async () => {
    setDisconnectingStripe(true)
    try {
      const config = await stripePaymentsService.deleteConfig()
      applyStripeConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Stripe desconectado', 'Ristak dejó de usar esta cuenta para nuevos cobros.')
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar Stripe', error.message || 'Intenta de nuevo.')
    } finally {
      setDisconnectingStripe(false)
    }
  }

  const handleConnectMercadoPago = async () => {
    setConnectingMercadoPago(true)
    try {
      const response = await mercadoPagoPaymentsService.createConnectUrl({
        mode: mercadoPagoMode,
        returnPath: '/settings/payments/mercadopago',
        appUrl: window.location.origin
      })
      window.location.assign(response.url)
    } catch (error: any) {
      showToast('error', 'No se pudo abrir Mercado Pago', error.message || 'Revisa Mercado Pago en el Installer.')
      setConnectingMercadoPago(false)
    }
  }

  const handleMercadoPagoModeChange = async (nextLive: boolean) => {
    const nextMode: 'test' | 'live' = nextLive ? 'live' : 'test'
    const previousMode = mercadoPagoMode
    if (nextMode === previousMode) return

    if (!mercadoPagoConnected) {
      setMercadoPagoMode(nextMode)
      return
    }

    setMercadoPagoMode(nextMode)
    setSwitchingMercadoPagoMode(true)
    try {
      const config = await mercadoPagoPaymentsService.setConnectMode(nextMode)
      applyMercadoPagoConfig(config)
      invalidateIntegrationsStatus()
      showToast('success', 'Modo Mercado Pago actualizado', `Ristak quedó en modo ${nextMode === 'live' ? 'en vivo' : 'prueba'}.`)
    } catch (error: any) {
      setMercadoPagoMode(previousMode)
      showToast('error', 'No se pudo cambiar el modo', error.message || 'Intenta de nuevo.')
    } finally {
      setSwitchingMercadoPagoMode(false)
    }
  }

  const handleTestMercadoPagoConfig = async () => {
    setTestingMercadoPagoConfig(true)
    try {
      await mercadoPagoPaymentsService.testConfig()
      showToast('success', 'Mercado Pago respondió bien', 'Ristak puede consultar la cuenta conectada.')
    } catch (error: any) {
      showToast('error', 'Mercado Pago no respondió', error.message || 'Revisa la conexión OAuth.')
    } finally {
      setTestingMercadoPagoConfig(false)
    }
  }

  const handleDisconnectMercadoPago = async () => {
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

  const handleCopyStripeWebhookEndpoint = async (endpoint: StripeWebhookEndpoint) => {
    const copied = await copyTextToClipboard(endpoint.url)
    if (copied) {
      showToast('success', 'Endpoint copiado', `Copiaste el webhook de ${endpoint.label}.`)
      return
    }

    showToast('error', 'No se pudo copiar', endpoint.url)
  }

  const handleCopyStripeWebhookEvents = async () => {
    const copied = await copyTextToClipboard(STRIPE_WEBHOOK_EVENTS.map((event) => event.name).join('\n'))
    if (copied) {
      showToast('success', 'Eventos copiados', 'Copiaste los eventos que debes seleccionar en Stripe.')
      return
    }

    showToast('error', 'No se pudieron copiar', 'Selecciona los eventos manualmente en Stripe.')
  }

  const handleCopyMercadoPagoWebhookEndpoint = async (endpoint: MercadoPagoWebhookEndpoint) => {
    const copied = await copyTextToClipboard(endpoint.url)
    if (copied) {
      showToast('success', 'Endpoint copiado', `Copiaste el webhook de ${endpoint.label}.`)
      return
    }

    showToast('error', 'No se pudo copiar', endpoint.url)
  }

  const handleCopyMercadoPagoWebhookEvents = async () => {
    const copied = await copyTextToClipboard(MERCADOPAGO_WEBHOOK_EVENTS.map((event) => event.name).join('\n'))
    if (copied) {
      showToast('success', 'Eventos copiados', 'Copiaste los eventos que debes seleccionar en Mercado Pago.')
      return
    }

    showToast('error', 'No se pudieron copiar', 'Selecciona los eventos manualmente en Mercado Pago.')
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
          {renderField(
            'Logo del negocio',
            <input
              type="url"
              value={checkout.logoUrl}
              onChange={(event) => setCheckoutValue('logoUrl', event.target.value)}
              placeholder="https://tu-dominio.com/logo.png"
            />,
            'Se mostrará en la parte superior del link de cobro.'
          )}
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

        <div className={styles.sectionDividerStack}>
          {renderSwitchRow(
            'Mostrar sello de pago seguro',
            'Aparece junto al formulario para reforzar confianza antes de pagar.',
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
                  <strong>Stripe</strong>
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

      {!activeGatewayRoute && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Pasarela de pagos</h2>
              <p>Elige con qué proveedor se cobran links, tarjetas y parcialidades.</p>
            </div>
            <Badge variant={stripeConnected || mercadoPagoConnected || highLevelConnected ? 'success' : 'warning'}>
              {stripeConnected || mercadoPagoConnected || highLevelConnected ? <CheckCircle size={14} /> : <KeyRound size={14} />}
              {stripeConnected || mercadoPagoConnected || highLevelConnected ? 'Conectada' : 'Pendiente'}
            </Badge>
          </div>

          <div className={styles.gatewayList}>
            {gatewayOptions.map((gateway) => {
              const isConnected = gateway.status === 'connected'
              const isAvailable = gateway.status === 'available'
              const statusCopy = gatewayStatusCopy[gateway.status]

              return (
                <Card key={gateway.id} className={styles.gatewayItem} padding="md">
                  <div className={styles.gatewayItemCopy}>
                    <div className={styles.gatewayItemTitleRow}>
                      <strong>{gateway.name}</strong>
                      <Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
                    </div>
                    <p>{gateway.description}</p>
                  </div>
                  <div className={styles.gatewayItemActions}>
                    <Button type="button" variant={isConnected || isAvailable ? 'primary' : 'secondary'} size="sm" onClick={() => handleSelectGateway(gateway)}>
                      {isConnected ? 'Abrir' : isAvailable ? 'Configurar' : 'Ver estado'}
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>
        </Card>
      )}

      {activeGatewayRoute && selectedGatewayOption?.status === 'soon' && (
        <Card className={styles.noticeCard}>
          <AlertTriangle size={18} />
          <div>
            <strong>{selectedGatewayOption.name} estará disponible próximamente</strong>
            <p>La dejamos visible para que el flujo ya tenga espacio sin mezclarlo con impuestos ni comprobantes.</p>
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'highlevel' && !highLevelConnected && (
        <Card className={styles.noticeCard}>
          <AlertTriangle size={18} />
          <div>
            <strong>GoHighLevel no está conectado</strong>
            <p>Conecta GoHighLevel primero para administrar sus comprobantes desde esta pantalla.</p>
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
            <div className={styles.modeSelector}>
              <span className={ghlInvoiceMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch checked={ghlInvoiceMode === 'live'} onChange={(next) => setGhlInvoiceMode(next ? 'live' : 'test')} aria-label="Cambiar modo de comprobantes de GoHighLevel" />
              <span className={ghlInvoiceMode === 'live' ? styles.modeActive : ''}>En vivo</span>
            </div>
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
            <div>
              <h2>Configuración manual de Stripe</h2>
              <p>Usa tu propia cuenta de Stripe creando una Restricted API Key en tu Dashboard de Stripe.</p>
            </div>
            <Badge variant={stripeStatusBadge.variant}>
              {stripeStatusBadge.icon}
              {stripeStatusBadge.label}
            </Badge>
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.modeSelector}>
              <span className={stripeMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch
                checked={stripeMode === 'live'}
                onChange={handleStripeModeChange}
                disabled={savingStripeConfig || testingStripeConfig || disconnectingStripe}
                aria-label="Cambiar modo de Stripe"
              />
              <span className={stripeMode === 'live' ? styles.modeActive : ''}>En vivo</span>
            </div>

            <div className={styles.stripeManualBox}>
              <div>
                <h3>{stripeConnected ? 'Stripe configurado manualmente' : 'Configuración manual de Stripe'}</h3>
                <p>Ristak usa las credenciales de tu propia cuenta de Stripe y sólo los permisos que actives para esta key. Ristak no procesa pagos en nombre de terceros, no retiene fondos, no administra payouts y no funciona como marketplace ni facilitador de pagos.</p>
                <p>La key se guarda cifrada en el backend y puedes revocarla desde Stripe cuando quieras.</p>
              </div>
            </div>

            <div className={styles.connectionSummary}>
              <div>
                <span>Estado</span>
                <strong>{stripeStatusBadge.label}</strong>
              </div>
              <div>
                <span>Modo</span>
                <strong>{stripeMode === 'live' ? 'En vivo' : 'Prueba'}</strong>
              </div>
              <div>
                <span>Cuenta</span>
                <strong>{stripeAccountLabel.trim() || 'Tu cuenta de Stripe'}</strong>
              </div>
            </div>

            <div className={styles.formGrid}>
              {renderField(
                'Nombre de cuenta',
                <input
                  type="text"
                  value={stripeAccountLabel}
                  onChange={(event) => setStripeAccountLabel(event.target.value)}
                  placeholder="Stripe principal"
                  autoComplete="off"
                />
              )}
              {renderField(
                'Moneda de cuenta',
                <div className={styles.currencyNote}>
                  <span>Moneda de cuenta</span>
                  <strong>{accountCurrency}</strong>
                </div>
              )}
              {renderField(
                'Publishable key',
                <input
                  type="text"
                  value={stripePublishableKey}
                  onChange={(event) => setStripePublishableKey(event.target.value)}
                  placeholder={stripeMode === 'live' ? 'pk_live_...' : 'pk_test_...'}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
              {renderField(
                'Restricted API Key',
                <input
                  type="password"
                  value={stripeSecretKey}
                  onChange={(event) => setStripeSecretKey(event.target.value)}
                  placeholder={stripeConfig?.hasSecretKey ? stripeConfig.secretKeyPreview : stripeMode === 'live' ? 'rk_live_...' : 'rk_test_...'}
                  autoComplete="new-password"
                  spellCheck={false}
                />,
                'Crea esta key en Stripe con permisos sólo para los recursos que Ristak necesita usar.'
              )}
              {renderField(
                'Webhook signing secret',
                <input
                  type="password"
                  value={stripeWebhookSecret}
                  onChange={(event) => setStripeWebhookSecret(event.target.value)}
                  placeholder={stripeConfig?.hasWebhookSecret ? stripeConfig.webhookSecretPreview : 'whsec_...'}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              )}
            </div>

            {stripeWebhookEndpoints.length > 0 && (
              <div className={styles.webhookList}>
                <h3>Endpoints sugeridos</h3>
                {stripeWebhookEndpoints.map((endpoint) => (
                  <div key={endpoint.url} className={styles.webhookRow}>
                    <div>
                      <strong>{endpoint.label}</strong>
                      <span>{endpoint.description}</span>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={() => handleCopyStripeWebhookEndpoint(endpoint)}>
                      <Copy size={15} />
                      Copiar
                    </Button>
                  </div>
                ))}
                <div className={styles.actionsRow}>
                  <Button type="button" variant="secondary" onClick={handleCopyStripeWebhookEvents}>
                    <Copy size={16} />
                    Copiar eventos
                  </Button>
                </div>
              </div>
            )}

            <div className={styles.actionsRow}>
              <Button
                type="button"
                variant="secondary"
                onClick={handleTestStripeConfig}
                disabled={testingStripeConfig || savingStripeConfig || !stripeCanSubmit}
              >
                {testingStripeConfig ? (
                  <>
                    <Loader2 size={18} className={styles.spinIcon} />
                    Probando...
                  </>
                ) : (
                  'Probar conexión'
                )}
              </Button>
              <Button
                type="button"
                onClick={handleSaveStripeConfig}
                disabled={savingStripeConfig || testingStripeConfig || !stripeCanSubmit}
              >
                {savingStripeConfig ? (
                  <>
                    <Loader2 size={18} className={styles.spinIcon} />
                    Guardando...
                  </>
                ) : (
                  'Guardar configuración'
                )}
              </Button>
            </div>

            {stripeConnected && (
              <div className={styles.actionsRow}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleDisconnectStripe}
                  disabled={disconnectingStripe || testingStripeConfig || savingStripeConfig}
                >
                  {disconnectingStripe ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Desconectando...
                    </>
                  ) : (
                    <>
                      <Unplug size={18} />
                      Desconectar Stripe
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'mercadopago' && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Mercado Pago</h2>
              <p>Conecta Mercado Pago para crear links de Checkout Pro y controlar parcialidades desde Ristak.</p>
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
            <div className={styles.modeSelector}>
              <span className={mercadoPagoMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch
                checked={mercadoPagoMode === 'live'}
                onChange={handleMercadoPagoModeChange}
                disabled={connectingMercadoPago || switchingMercadoPagoMode || testingMercadoPagoConfig}
                aria-label="Cambiar modo de Mercado Pago"
              />
              <span className={mercadoPagoMode === 'live' ? styles.modeActive : ''}>En vivo</span>
              {switchingMercadoPagoMode && <Loader2 size={14} className={styles.spinIcon} />}
            </div>

            <div className={styles.stripeConnectBox}>
              <div>
                <h3>{mercadoPagoConnected ? mercadoPagoConfig?.accountLabel || 'Mercado Pago conectado' : 'Conectar con Mercado Pago'}</h3>
                <p>
                  {mercadoPagoConnected
                    ? `Ristak crea links de Mercado Pago en modo ${mercadoPagoConfig?.mode === 'live' ? 'en vivo' : 'prueba'} y escucha cambios por webhook.`
                    : 'Al hacer clic se abrirá Mercado Pago para autorizar la cuenta. Los tokens quedan cifrados en esta instalación.'}
                </p>
              </div>
              <div className={styles.actionsRow}>
                <Button
                  type="button"
                  onClick={handleConnectMercadoPago}
                  disabled={connectingMercadoPago || disconnectingMercadoPago}
                >
                  {connectingMercadoPago ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Abriendo...
                    </>
                  ) : (
                    <>
                      <ExternalLink size={18} />
                      {mercadoPagoConnected ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}
                    </>
                  )}
                </Button>
              </div>
            </div>

            {mercadoPagoConnected && (
              <div className={styles.connectionSummary}>
                <div>
                  <span>Cuenta</span>
                  <strong>{mercadoPagoConfig?.userId || 'Mercado Pago'}</strong>
                </div>
                <div>
                  <span>Modo activo</span>
                  <strong>{mercadoPagoConfig?.mode === 'live' ? 'En vivo' : 'Prueba'}</strong>
                </div>
                <div>
                  <span>Token OAuth</span>
                  <strong>{mercadoPagoConfig?.hasRefreshToken ? 'Renovable' : 'Sin refresh'}</strong>
                </div>
              </div>
            )}

            {mercadoPagoConnected && !mercadoPagoWebhookReady && (
              <div className={styles.inlineWarning}>
                <AlertTriangle size={16} />
                <span>Mercado Pago está conectado, pero falta que esta instalación reciba el Webhook Secret para verificar firmas.</span>
              </div>
            )}

            {mercadoPagoWebhookEndpoints.length > 0 && (
              <div className={styles.webhookList}>
                <h3>Endpoints para webhooks</h3>
                {mercadoPagoWebhookEndpoints.map((endpoint) => (
                  <div key={endpoint.url} className={styles.webhookRow}>
                    <div>
                      <strong>{endpoint.label}</strong>
                      <span>{endpoint.description}</span>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={() => handleCopyMercadoPagoWebhookEndpoint(endpoint)}>
                      <Copy size={15} />
                      Copiar
                    </Button>
                  </div>
                ))}
                <div className={styles.actionsRow}>
                  <Button type="button" variant="secondary" onClick={handleCopyMercadoPagoWebhookEvents}>
                    <Copy size={16} />
                    Copiar eventos
                  </Button>
                </div>
              </div>
            )}

            <div className={styles.actionsRow}>
              {mercadoPagoConnected && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestMercadoPagoConfig}
                    disabled={testingMercadoPagoConfig}
                  >
                    {testingMercadoPagoConfig ? (
                      <>
                        <Loader2 size={18} className={styles.spinIcon} />
                        Probando...
                      </>
                    ) : (
                      'Probar conexión'
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleDisconnectMercadoPago}
                    disabled={disconnectingMercadoPago || connectingMercadoPago}
                  >
                    {disconnectingMercadoPago ? (
                      <>
                        <Loader2 size={18} className={styles.spinIcon} />
                        Desconectando...
                      </>
                    ) : (
                      <>
                        <Unplug size={18} />
                        Desconectar
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
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

    return (
      <div className={styles.twoColumnLayout}>
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
            <Sparkles size={22} />
            <Badge variant={taxes.gigstackEnabled ? (taxes.hasGigstackApiToken ? 'success' : 'warning') : 'neutral'}>
              Gigstack
            </Badge>
          </div>
          <h3>Timbrado automático</h3>
          <p>Gigstack permite registrar el pago y dejar que su API genere el CFDI con validación fiscal y timbrado ante el SAT.</p>
          {renderSwitchRow('Activar Gigstack', 'Al registrar un pago con impuestos, Ristak intentará enviarlo a Gigstack para timbrarlo automáticamente.', taxes.gigstackEnabled, (next) => setTaxValue('gigstackEnabled', next))}
          {renderField(
            'Token API de Gigstack',
            <input
              type="password"
              value={taxes.gigstackApiToken || ''}
              onChange={(event) => setTaxValue('gigstackApiToken', event.target.value)}
              placeholder={taxes.gigstackApiTokenPreview || 'Pega el token JWT'}
              autoComplete="off"
            />,
            taxes.hasGigstackApiToken ? 'Ya hay un token guardado. Pega uno nuevo solo si quieres reemplazarlo.' : 'Se obtiene desde app.gigstack.pro/settings?subtab=api.'
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => window.open(GIGSTACK_API_URL, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={15} />
            Ver API de facturación
          </Button>
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
        actions={(
          <Badge variant={stripeConnected || mercadoPagoConnected || highLevelConnected ? 'success' : 'warning'}>
            {isLoadingPage ? <Loader2 size={14} className={styles.spinIcon} /> : stripeConnected || mercadoPagoConnected || highLevelConnected ? <CheckCircle size={14} /> : <Clock size={14} />}
            {isLoadingPage ? 'Cargando' : stripeConnected ? 'Stripe conectado' : mercadoPagoConnected ? 'Mercado Pago conectado' : highLevelConnected ? 'GoHighLevel conectado' : 'Pasarela pendiente'}
          </Badge>
        )}
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
      {activeSection === 'automations' && renderAutomationsSection()}
      {activeSection === 'gateways' && renderGatewaysSection()}
      {activeSection === 'taxes' && renderTaxesSection()}
    </PageContainer>
  )
}
