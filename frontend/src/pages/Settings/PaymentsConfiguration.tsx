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
import { stripePaymentsService, type StripePaymentConfig, type StripeWebhookEndpoint } from '@/services/stripePaymentsService'
import styles from './PaymentsConfiguration.module.css'

type PaymentsSectionId = 'checkout' | 'receipt' | 'automations' | 'gateways' | 'taxes'
type PaymentGatewayId = 'highlevel' | 'stripe' | 'mercado-libre' | 'clip'
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error'

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'available' | 'soon'
}

const sectionItems: Array<{ id: PaymentsSectionId; label: string; icon: React.ReactNode }> = [
  { id: 'checkout', label: 'Página de cobro', icon: <CreditCard size={17} /> },
  { id: 'receipt', label: 'Comprobante', icon: <ReceiptText size={17} /> },
  { id: 'automations', label: 'Automatizaciones', icon: <BellRing size={17} /> },
  { id: 'gateways', label: 'Pasarelas', icon: <WalletCards size={17} /> },
  { id: 'taxes', label: 'Impuestos', icon: <Percent size={17} /> }
]

const sectionIds = sectionItems.map((item) => item.id)
const gatewayIds: PaymentGatewayId[] = ['highlevel', 'stripe', 'mercado-libre', 'clip']

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
    description: 'Cuando un invoice de Stripe queda pagado.'
  },
  {
    name: 'invoice.payment_failed',
    description: 'Cuando un invoice de Stripe falla.'
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

const compactMoney = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0
})

export const PaymentsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast } = useNotification()
  const { connected: highLevelConnected, loading: loadingHighLevelConnection } = useHighLevelConnected()

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
  const [stripeMode, setStripeMode] = useState<'test' | 'live'>('test')
  const [stripeDefaultCurrency, setStripeDefaultCurrency] = useState('MXN')
  const [stripeAccountLabel, setStripeAccountLabel] = useState('')
  const [stripePublishableKey, setStripePublishableKey] = useState('')
  const [stripeSecretKey, setStripeSecretKey] = useState('')
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState('')
  const [loadingStripeConfig, setLoadingStripeConfig] = useState(false)
  const [savingHighLevelConfig, setSavingHighLevelConfig] = useState(false)
  const [savingStripeConfig, setSavingStripeConfig] = useState(false)
  const [testingStripeConfig, setTestingStripeConfig] = useState(false)
  const [connectingStripe, setConnectingStripe] = useState(false)
  const [syncingStripeConnect, setSyncingStripeConnect] = useState(false)
  const [disconnectingStripe, setDisconnectingStripe] = useState(false)
  const [uploadingReceiptLogo, setUploadingReceiptLogo] = useState(false)
  const [receiptLogoUploadProgress, setReceiptLogoUploadProgress] = useState(0)
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
  }, [])

  useEffect(() => {
    if (loadingHighLevelConnection) return
    if (highLevelConnected) loadHighLevelPaymentConfig()
  }, [highLevelConnected, loadingHighLevelConnection])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const status = params.get('stripe_connect')
    if (!status) return

    const message = params.get('stripe_message') || ''

    const finishStripeReturn = async () => {
      setActiveSection('gateways')
      setSelectedGateway('stripe')

      if (status === 'success' || status === 'warning') {
        setSyncingStripeConnect(true)
        try {
          const config = await stripePaymentsService.syncConnect()
          applyStripeConfig(config)
          invalidateIntegrationsStatus()
          if (status === 'success') {
            showToast('success', 'Stripe conectado', message || 'La cuenta quedó lista para cobrar desde Ristak.')
          } else {
            showToast('warning', 'Stripe conectado con pendiente', message || 'La cuenta conectó, pero el webhook necesita revisión.')
          }
        } catch (error: any) {
          showToast('warning', 'Stripe autorizó, falta sincronizar', error.message || 'Vuelve a abrir esta pantalla para sincronizar la conexión.')
          await loadStripeConfig()
        } finally {
          setSyncingStripeConnect(false)
        }
      } else {
        showToast('error', 'No se pudo conectar Stripe', message || 'Intenta conectar la cuenta de nuevo.')
        await loadStripeConfig()
      }

      navigate('/settings/payments/stripe', { replace: true })
    }

    void finishStripeReturn()
  }, [location.search, navigate, showToast])

  const stripeGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'stripe',
    name: 'Stripe',
    description: stripeConfig?.configured
      ? `Cobra con tarjeta por Stripe Connect (${stripeConfig.mode === 'live' ? 'en vivo' : 'prueba'}).`
      : 'Conecta Stripe con OAuth para crear links de pago sin copiar llaves manualmente.',
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
      id: 'mercado-libre',
      name: 'Mercado Pago',
      description: 'Para preparar cobros con Mercado Pago dentro del flujo de Ristak.',
      status: 'soon'
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
  const stripeConnectionType = stripeConfig?.connectionType || 'manual'
  const stripeIsConnect = stripeConnectionType === 'connect'
  const stripeModeOauthReady = stripeConfig?.connectOauthReadyByMode?.[stripeMode] ?? stripeConfig?.connectOauthReady ?? false
  const stripeWebhookReady = stripeConfig?.connectWebhookStatus === 'active' && stripeConfig?.hasWebhookSecret
  const stripeOAuthConnected = Boolean(stripeConfig?.configured && stripeIsConnect && stripeConfig?.connectedAccountId)
  const stripeConnected = Boolean(stripeConfig?.configured)
  const isLoadingPage = loadingSettings || loadingHighLevelConnection || loadingStripeConfig

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

  const setAutomationValue = <K extends keyof PaymentAutomationSettings>(key: K, value: PaymentAutomationSettings[K]) => {
    setSettings((current) => ({
      ...current,
      automations: { ...current.automations, [key]: value }
    }))
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
      showToast('success', 'GoHighLevel guardado', 'La configuración de invoices quedó actualizada.')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar GoHighLevel', error.message || 'Revisa la configuración de invoices.')
    } finally {
      setSavingHighLevelConfig(false)
    }
  }

  const applyStripeConfig = (config: StripePaymentConfig) => {
    setStripeConfig(config)
    setStripeMode(config.mode || 'test')
    setStripeDefaultCurrency(config.defaultCurrency || 'MXN')
    setStripeAccountLabel(config.accountLabel || '')
    setStripePublishableKey(config.publishableKey || '')
    setStripeSecretKey(config.secretKeyPreview || '')
    setStripeWebhookSecret(config.webhookSecretPreview || '')
  }

  const loadStripeConfig = async () => {
    setLoadingStripeConfig(true)
    try {
      const config = await stripePaymentsService.getConfig()
      applyStripeConfig(config)
    } catch {
      setStripeConfig(null)
    } finally {
      setLoadingStripeConfig(false)
    }
  }

  const buildStripeConfigPayload = () => ({
    enabled: true,
    mode: stripeMode,
    defaultCurrency: stripeDefaultCurrency.trim().toUpperCase() || 'MXN',
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
      showToast('error', 'No se pudo guardar Stripe', error.message || 'Revisa tus llaves de Stripe.')
    } finally {
      setSavingStripeConfig(false)
    }
  }

  const handleTestStripeConfig = async () => {
    setTestingStripeConfig(true)
    try {
      await stripePaymentsService.testConfig(stripeIsConnect ? undefined : buildStripeConfigPayload())
      showToast('success', 'Stripe respondió bien', stripeIsConnect ? 'Ristak puede consultar la cuenta conectada.' : 'Las credenciales permiten consultar la cuenta.')
    } catch (error: any) {
      showToast('error', 'Stripe no respondió', error.message || 'Revisa la Secret key.')
    } finally {
      setTestingStripeConfig(false)
    }
  }

  const handleConnectStripe = async () => {
    setConnectingStripe(true)
    try {
      const response = await stripePaymentsService.createConnectUrl({
        mode: stripeMode,
        returnPath: '/settings/payments/stripe'
      })
      window.location.assign(response.url)
    } catch (error: any) {
      showToast('error', 'No se pudo abrir Stripe', error.message || 'Revisa Stripe Connect en el Installer o las variables locales de esta instalación.')
      setConnectingStripe(false)
    }
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
      showToast('error', 'Archivo no válido', 'Sube una imagen para el logo del invoice.')
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
      showToast('success', 'Logo subido', 'El logo quedó guardado en Media y enlazado al invoice.')
    } catch (uploadError: any) {
      showToast('error', 'No se pudo subir el logo', uploadError.message || 'Revisa el archivo e intenta de nuevo.')
    } finally {
      setUploadingReceiptLogo(false)
      setReceiptLogoUploadProgress(0)
    }
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
            <strong>{compactMoney.format(2490)}</strong>
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
    const previewTaxAmount = taxes.enabled
      ? taxes.rateType === 'percentage'
        ? Math.round(previewBaseAmount * (taxes.rateValue / 100))
        : Math.round(taxes.rateValue)
      : 0
    const previewSubtotal = taxes.enabled && taxes.calculationMode === 'inclusive'
      ? Math.max(0, previewBaseAmount - previewTaxAmount)
      : previewBaseAmount
    const previewTotal = taxes.enabled && taxes.calculationMode === 'exclusive'
      ? previewBaseAmount + previewTaxAmount
      : previewBaseAmount
    const previewTaxLabel = taxes.taxName || 'Impuesto'

    return (
      <div className={styles.twoColumnLayout}>
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Invoice descargable</h2>
              <p>Configura la hoja PDF que el cliente podrá descargar desde la confirmación de pago.</p>
            </div>
            <Badge variant="success">
              <FileCheck2 size={14} />
              PDF
            </Badge>
          </div>

          <div className={styles.formGrid}>
            <div className={`${styles.formField} ${styles.fullWidthField}`}>
              <span>Logo del invoice</span>
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
                placeholder="facturacion@tu-negocio.com"
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
                placeholder="Políticas de pago, reembolso, facturación o condiciones del servicio."
              />
              <small>Este texto puede ser largo y también se sincroniza como nota de términos para invoices de GoHighLevel cuando esté conectado.</small>
            </div>
          </div>

          <div className={styles.switchStack}>
            {renderSwitchRow('Mostrar datos del negocio', 'Incluye nombre, contacto y dirección en la hoja.', receipt.showBusinessInfo, (next) => setReceiptValue('showBusinessInfo', next))}
            {renderSwitchRow('Mostrar datos del cliente', 'Incluye nombre, email y referencia del pago.', receipt.showCustomerInfo, (next) => setReceiptValue('showCustomerInfo', next))}
            {renderSwitchRow('Mostrar términos', 'Agrega términos al final del invoice descargable.', receipt.showTerms, (next) => setReceiptValue('showTerms', next))}
          </div>

          {renderSectionSaveBar('Guardar invoice')}
        </Card>

        <Card className={styles.documentPreviewCard}>
          <div className={styles.documentPreviewHeader}>
            <div>
              <h3>Vista de hoja</h3>
              <p>Así se imprime o guarda como PDF desde el link pagado.</p>
            </div>
            <Badge variant="success">
              <CheckCircle size={14} />
              Pagado
            </Badge>
          </div>

          <div className={styles.documentViewport}>
            <article className={styles.documentSheet} aria-label="Vista previa del invoice descargable">
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
                  <span>{compactMoney.format(previewSubtotal)}</span>
                </div>
              </section>

              <section className={styles.documentTotals} aria-label="Totales">
                <div>
                  <span>Subtotal</span>
                  <strong>{compactMoney.format(previewSubtotal)}</strong>
                </div>
                {taxes.enabled && (
                  <div>
                    <span>{taxes.calculationMode === 'inclusive' ? `${previewTaxLabel} incluido` : previewTaxLabel}</span>
                    <strong>{compactMoney.format(previewTaxAmount)}</strong>
                  </div>
                )}
                <div>
                  <span>Total pagado</span>
                  <strong>{compactMoney.format(previewTotal)}</strong>
                </div>
              </section>

              {receipt.showTerms && (
                <section className={styles.documentTerms}>
                  <strong>Términos y condiciones</strong>
                  <p>{receipt.terms || 'Agrega aquí políticas de pago, reembolso, facturación o condiciones del servicio.'}</p>
                </section>
              )}

              {receipt.footer && <p className={styles.documentFooter}>{receipt.footer}</p>}
            </article>
          </div>
        </Card>
      </div>
    )
  }

  const renderAutomationsSection = () => (
    <div className={styles.singleColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Recordatorios y acciones de pago</h2>
            <p>Define el comportamiento estándar antes del vencimiento y después de recibir el pago.</p>
          </div>
          <Badge variant="warning">
            <BellRing size={14} />
            Reglas
          </Badge>
        </div>

        <div className={styles.settingsMatrix}>
          {renderSwitchRow('Recordatorios antes del vencimiento', 'Activa avisos antes de que llegue la fecha de pago.', automations.remindersEnabled, (next) => setAutomationValue('remindersEnabled', next))}
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
            'Canal de recordatorio',
            <CustomSelect
              value={automations.reminderChannel}
              onValueChange={(value) => setAutomationValue('reminderChannel', value as PaymentAutomationSettings['reminderChannel'])}
              options={[
                { value: 'whatsapp', label: 'WhatsApp' },
                { value: 'email', label: 'Email' },
                { value: 'both', label: 'WhatsApp y email' }
              ]}
            />
          )}
          {renderSwitchRow('Enviar comprobante al pagar', 'Prepara el envío del comprobante cuando el pago se confirme.', automations.receiptDeliveryEnabled, (next) => setAutomationValue('receiptDeliveryEnabled', next))}
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
          {renderSwitchRow('Seguimiento si falla el cobro', 'Deja una regla preparada para avisar cuando un pago falla.', automations.failedPaymentEnabled, (next) => setAutomationValue('failedPaymentEnabled', next))}
          {renderField(
            'Horas después de un fallo',
            <NumberInput
              min="1"
              max="168"
              value={automations.failedPaymentDelayHours}
              onValueChange={(value) => setAutomationValue('failedPaymentDelayHours', Math.trunc(value) || 1)}
            />
          )}
        </div>

        {renderSectionSaveBar('Guardar automatizaciones')}
      </Card>

      <div className={styles.summaryStrip}>
        <div>
          <Clock size={17} />
          <strong>{automations.reminderDaysBefore} días antes</strong>
          <span>Recordatorio por {automations.reminderChannel === 'both' ? 'WhatsApp y email' : automations.reminderChannel}</span>
        </div>
        <div>
          <CheckCircle size={17} />
          <strong>{automations.receiptDeliveryEnabled ? 'Comprobante activo' : 'Comprobante apagado'}</strong>
          <span>Acción: {automations.afterPaymentAction.replace('_', ' ')}</span>
        </div>
        <div>
          <AlertTriangle size={17} />
          <strong>{automations.failedPaymentEnabled ? `${automations.failedPaymentDelayHours} h tras fallo` : 'Sin seguimiento'}</strong>
          <span>Regla estándar para cobros rechazados</span>
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
          <Badge variant={selectedGatewayOption?.status === 'connected' ? 'success' : selectedGatewayOption?.status === 'soon' ? 'warning' : 'info'}>
            {selectedGatewayOption?.status === 'connected' ? 'Conectada' : selectedGatewayOption?.status === 'soon' ? 'Próximamente' : 'Configurable'}
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
            <Badge variant={stripeConnected || highLevelConnected ? 'success' : 'warning'}>
              {stripeConnected || highLevelConnected ? <CheckCircle size={14} /> : <KeyRound size={14} />}
              {stripeConnected || highLevelConnected ? 'Conectada' : 'Pendiente'}
            </Badge>
          </div>

          <div className={styles.gatewayList}>
            {gatewayOptions.map((gateway) => {
              const isConnected = gateway.status === 'connected'
              const isAvailable = gateway.status === 'available'

              return (
                <Card key={gateway.id} className={styles.gatewayItem} padding="md">
                  <div>
                    <strong>{gateway.name}</strong>
                    <p>{gateway.description}</p>
                  </div>
                  <div className={styles.gatewayItemActions}>
                    <Badge variant={isConnected ? 'success' : isAvailable ? 'info' : 'warning'}>
                      {isConnected ? 'Conectado' : isAvailable ? 'Configurar' : 'Próximamente'}
                    </Badge>
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
            <p>Conecta GoHighLevel primero para administrar sus invoices desde esta pantalla.</p>
          </div>
        </Card>
      )}

      {activeGatewayRoute === 'highlevel' && highLevelConnected && (
        <Card className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>GoHighLevel Invoices</h2>
              <p>Personaliza cómo se generan documentos, vencimientos y cargos de domiciliación.</p>
            </div>
          </div>

          <div className={styles.formGrid}>
            <div className={styles.modeSelector}>
              <span className={ghlInvoiceMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch checked={ghlInvoiceMode === 'live'} onChange={(next) => setGhlInvoiceMode(next ? 'live' : 'test')} aria-label="Cambiar modo de GoHighLevel invoices" />
              <span className={ghlInvoiceMode === 'live' ? styles.modeActive : ''}>En vivo</span>
            </div>
            {renderField(
              'Título del documento',
              <input
                type="text"
                value={paymentTitle}
                onChange={(event) => setPaymentTitle(event.target.value)}
                placeholder="PAGO, FACTURA, INVOICE"
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
              <h2>Stripe</h2>
              <p>Conecta la cuenta con OAuth o usa credenciales manuales como respaldo.</p>
            </div>
            {loadingStripeConfig || syncingStripeConnect ? (
              <Badge variant="warning">
                <Loader2 size={14} className={styles.spinIcon} />
                {syncingStripeConnect ? 'Sincronizando' : 'Cargando'}
              </Badge>
            ) : stripeConnected ? (
              <Badge variant="success">
                <ShieldCheck size={14} />
                Conectado
              </Badge>
            ) : !stripeModeOauthReady ? (
              <Badge variant="warning">
                <AlertTriangle size={14} />
                Falta plataforma
              </Badge>
            ) : (
              <Badge variant="info">
                <KeyRound size={14} />
                Listo para OAuth
              </Badge>
            )}
          </div>

          <div className={styles.stripePanel}>
            <div className={styles.modeSelector}>
              <span className={stripeMode === 'test' ? styles.modeActive : ''}>Prueba</span>
              <Switch
                checked={stripeMode === 'live'}
                onChange={(next) => setStripeMode(next ? 'live' : 'test')}
                disabled={savingStripeConfig || testingStripeConfig || connectingStripe}
                aria-label="Cambiar modo de Stripe"
              />
              <span className={stripeMode === 'live' ? styles.modeActive : ''}>En vivo</span>
            </div>

            <div className={styles.stripeConnectBox}>
              <div>
                <h3>{stripeOAuthConnected ? stripeAccountLabel || 'Cuenta Stripe conectada' : stripeConnected ? 'Stripe configurado manualmente' : 'Conectar con Stripe'}</h3>
                <p>
                  {stripeOAuthConnected
                    ? `Ristak cobra en modo ${stripeConfig?.mode === 'live' ? 'en vivo' : 'prueba'} usando Stripe Connect.`
                    : stripeConnected
                      ? 'Esta instalación usa llaves guardadas manualmente. Puedes reconectar con OAuth para automatizar cuenta y webhook.'
                      : 'Se abrirá Stripe, autorizas Ristak y regresas aquí con la cuenta lista.'}
                </p>
              </div>
              <div className={styles.actionsRow}>
                <Button
                  type="button"
                  onClick={handleConnectStripe}
                  disabled={connectingStripe || syncingStripeConnect || disconnectingStripe || !stripeModeOauthReady}
                >
                  {connectingStripe ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Abriendo...
                    </>
                  ) : (
                    <>
                      <ExternalLink size={18} />
                      {stripeOAuthConnected ? 'Reconectar Stripe' : 'Conectar con Stripe'}
                    </>
                  )}
                </Button>
                {stripeConnected && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestStripeConfig}
                    disabled={testingStripeConfig || connectingStripe || syncingStripeConnect || disconnectingStripe}
                  >
                    {testingStripeConfig ? (
                      <>
                        <Loader2 size={18} className={styles.spinIcon} />
                        Probando...
                      </>
                    ) : (
                      'Probar API'
                    )}
                  </Button>
                )}
              </div>
            </div>

            {!stripeModeOauthReady && (
              <div className={styles.inlineWarning}>
                <AlertTriangle size={16} />
                <span>
                  Falta configurar Stripe Connect para {stripeMode === 'live' ? 'modo en vivo' : 'modo prueba'}:
                  {' '}
                  {(stripeConfig?.connectMissingEnv || []).join(', ') || `STRIPE_CONNECT_${stripeMode.toUpperCase()}_CLIENT_ID / SECRET_KEY / PUBLISHABLE_KEY`}.
                </span>
              </div>
            )}

            {stripeOAuthConnected && (
              <div className={styles.connectionSummary}>
                <div>
                  <span>Cuenta</span>
                  <strong>{stripeConfig?.connectedAccountPreview || stripeConfig?.connectedAccountId || 'Stripe'}</strong>
                </div>
                <div>
                  <span>Email</span>
                  <strong>{stripeConfig?.connectAccountEmail || 'Sin email visible'}</strong>
                </div>
                <div>
                  <span>Scope</span>
                  <strong>{stripeConfig?.connectScope || 'read_write'}</strong>
                </div>
                <div>
                  <span>Webhook</span>
                  <strong>{stripeWebhookReady ? 'Automático' : 'Pendiente'}</strong>
                </div>
              </div>
            )}

            {stripeOAuthConnected && !stripeWebhookReady && (
              <div className={styles.inlineWarning}>
                <AlertTriangle size={16} />
                <span>{stripeConfig?.connectWebhookLastError || 'Stripe conectó, pero falta confirmar el webhook automático para recibir pagos y reembolsos en tiempo real.'}</span>
              </div>
            )}

            {stripeConfig?.connectWebhookUrl && (
              <div className={styles.copyField}>
                <input
                  type="text"
                  readOnly
                  value={stripeConfig.connectWebhookUrl}
                  onFocus={(event) => event.target.select()}
                  aria-label="Webhook automático de Stripe Connect"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => handleCopyStripeWebhookEndpoint({
                    source: 'connect',
                    label: 'Stripe Connect',
                    description: 'Webhook creado automáticamente por Ristak.',
                    url: stripeConfig.connectWebhookUrl || ''
                  })}
                >
                  <Copy size={16} />
                  Copiar
                </Button>
              </div>
            )}

            <details className={styles.manualDetails}>
              <summary>Configuración manual de respaldo</summary>
              <div className={styles.formGrid}>
                {renderField(
                  'Nombre de cuenta',
                  <input
                    type="text"
                    value={stripeAccountLabel}
                    onChange={(event) => setStripeAccountLabel(event.target.value)}
                    placeholder="Stripe Principal"
                    autoComplete="off"
                  />
                )}
                {renderField(
                  'Moneda principal',
                  <input
                    type="text"
                    value={stripeDefaultCurrency}
                    onChange={(event) => setStripeDefaultCurrency(event.target.value.toUpperCase().slice(0, 3))}
                    placeholder="MXN"
                    autoComplete="off"
                  />
                )}
                {renderField(
                  'Publishable key',
                  <input
                    type="text"
                    value={stripePublishableKey}
                    onChange={(event) => setStripePublishableKey(event.target.value)}
                    placeholder="pk_test_..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                {renderField(
                  'Secret key',
                  <input
                    type="password"
                    value={stripeSecretKey}
                    onChange={(event) => setStripeSecretKey(event.target.value)}
                    placeholder={stripeConfig?.hasSecretKey ? stripeConfig.secretKeyPreview : 'sk_test_...'}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
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
                  disabled={testingStripeConfig || savingStripeConfig || !stripeSecretKey.trim()}
                >
                  {testingStripeConfig ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Probando...
                    </>
                  ) : (
                    'Probar conexión manual'
                  )}
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveStripeConfig}
                  disabled={savingStripeConfig || testingStripeConfig}
                >
                  {savingStripeConfig ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Guardando...
                    </>
                  ) : (
                    'Guardar manual'
                  )}
                </Button>
              </div>
            </details>

            {stripeConnected && (
              <div className={styles.actionsRow}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleDisconnectStripe}
                  disabled={disconnectingStripe || connectingStripe || testingStripeConfig}
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
    </div>
  )

  const renderTaxesSection = () => (
    <div className={styles.twoColumnLayout}>
      <Card className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Impuestos</h2>
            <p>Define la tasa, si va incluida o separada, y conecta herramientas fiscales.</p>
          </div>
          <Badge variant={taxes.enabled ? 'success' : 'neutral'}>
            <Percent size={14} />
            {taxes.enabled ? 'Activo' : 'Apagado'}
          </Badge>
        </div>

        <div className={styles.switchStack}>
          {renderSwitchRow('Cobrar impuestos', 'Activa el cálculo de impuesto como regla estándar de pagos.', taxes.enabled, (next) => setTaxValue('enabled', next))}
          {renderSwitchRow('Aplicar a Stripe', 'Usa esta regla para links de cobro con Stripe.', taxes.applyToStripe, (next) => setTaxValue('applyToStripe', next))}
          {renderSwitchRow('Aplicar a GoHighLevel', 'Usa esta regla cuando generes invoices de GoHighLevel.', taxes.applyToHighLevel, (next) => setTaxValue('applyToHighLevel', next))}
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
            'Tipo de tasa',
            <CustomSelect
              value={taxes.rateType}
              onValueChange={(value) => setTaxValue('rateType', value as PaymentTaxSettings['rateType'])}
              options={[
                { value: 'percentage', label: 'Porcentaje' },
                { value: 'fixed', label: 'Monto fijo' }
              ]}
            />
          )}
          {renderField(
            taxes.rateType === 'percentage' ? 'Tasa impositiva' : 'Monto fijo',
            <NumberInput
              min="0"
              step="0.01"
              value={taxes.rateValue}
              onValueChange={(value) => setTaxValue('rateValue', value)}
            />,
            taxes.rateType === 'percentage' ? 'Ejemplo: 16 para IVA 16%.' : 'Monto que se suma o se reporta como impuesto.'
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
        </div>
      </Card>

      <Card className={styles.jigsawCard}>
        <div className={styles.jigsawHeader}>
          <Sparkles size={22} />
          <Badge variant="warning">Próximamente</Badge>
        </div>
        <h3>Jigsaw</h3>
        <p>Jigsaw vive aquí, en impuestos, para preparar el flujo fiscal sin contaminar la lista de pasarelas de cobro.</p>
        {renderSwitchRow('Preparar conexión con Jigsaw', 'Deja marcada la intención de conectar Jigsaw cuando se libere.', taxes.jigsawEnabled, (next) => setTaxValue('jigsawEnabled', next))}
        <div className={styles.taxPreview}>
          <div>
            <span>Subtotal</span>
            <strong>{compactMoney.format(2490)}</strong>
          </div>
          <div>
            <span>{taxes.taxName || 'IVA'} {taxes.rateType === 'percentage' ? `${taxes.rateValue}%` : ''}</span>
            <strong>{taxes.calculationMode === 'inclusive' ? 'Incluido' : compactMoney.format(taxes.rateType === 'percentage' ? 398 : taxes.rateValue)}</strong>
          </div>
          <div>
            <span>Total mostrado</span>
            <strong>{compactMoney.format(taxes.calculationMode === 'inclusive' ? 2490 : 2888)}</strong>
          </div>
        </div>
      </Card>
    </div>
  )

  return (
    <PageContainer size="wide" className={styles.page}>
      <PageHeader
        className={styles.pageHeader}
        eyebrow="Configuración"
        title="Pagos"
        subtitle="Configura el cobro, comprobante, automatizaciones, pasarelas e impuestos desde un solo setup."
        actions={(
          <Badge variant={stripeConnected || highLevelConnected ? 'success' : 'warning'}>
            {isLoadingPage ? <Loader2 size={14} className={styles.spinIcon} /> : stripeConnected || highLevelConnected ? <CheckCircle size={14} /> : <Clock size={14} />}
            {isLoadingPage ? 'Cargando' : stripeConnected ? 'Stripe conectado' : highLevelConnected ? 'GoHighLevel conectado' : 'Pasarela pendiente'}
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
