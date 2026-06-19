import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Card, Button, NumberInput } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { ArrowLeft, CheckCircle, Clock, Copy, CreditCard, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useHighLevelConnected } from '@/hooks/useHighLevelConnected'
import { invalidateIntegrationsStatus } from '@/services/integrationsService'
import { stripePaymentsService, type StripePaymentConfig, type StripeWebhookEndpoint } from '@/services/stripePaymentsService'
import styles from './HighLevelIntegration.module.css'

type PaymentGatewayId = 'highlevel' | 'stripe' | 'mercado-libre' | 'clip' | 'gigstacK'
type PaymentGatewayCategoryId = 'charge' | 'tax'

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'available' | 'soon'
}

interface PaymentGatewayCategory {
  id: PaymentGatewayCategoryId
  title: string
  description: string
  options: PaymentGatewayOption[]
}

const HIGHLIGHT_GATEWAY_OPTION: PaymentGatewayOption = {
  id: 'highlevel',
  name: 'GoHighLevel',
  description: 'Usa la conexión activa para cobros, links, domiciliación y parcialidades.',
  status: 'connected'
}

const UPCOMING_CHARGE_GATEWAYS: PaymentGatewayOption[] = [
  {
    id: 'mercado-libre',
    name: 'Mercado Libre',
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

const TAX_GATEWAYS: PaymentGatewayOption[] = [
  {
    id: 'gigstacK',
    name: 'GigstacK',
    description: 'Para organizar tu manejo de impuestos y documentación fiscal en el flujo de pagos.',
    status: 'soon'
  }
]

const paymentGatewayIds: PaymentGatewayId[] = ['highlevel', 'stripe', 'mercado-libre', 'clip', 'gigstacK']
const STRIPE_WEBHOOK_EVENTS = [
  {
    name: 'invoice.payment_failed',
    description: 'Cuando un intento de pago de invoice falla.'
  },
  {
    name: 'invoice.payment_succeeded',
    description: 'Cuando un intento de pago de invoice se completa.'
  },
  {
    name: 'refund.created',
    description: 'Cuando se crea un reembolso.'
  }
]

const isPaymentGatewayId = (value?: string): value is PaymentGatewayId => paymentGatewayIds.includes(value as PaymentGatewayId)
const parsePaymentGatewayRoute = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const paymentsIndex = segments.indexOf('payments')
  const gateway = paymentsIndex >= 0 ? segments[paymentsIndex + 1] : ''
  return isPaymentGatewayId(gateway) ? gateway : ''
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

export const PaymentsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeGateway = parsePaymentGatewayRoute(location.pathname)
  const { showToast } = useNotification()
  const { connected: highLevelConnected, loading: loadingHighLevelConnection } = useHighLevelConnected()

  const selectedGateway = routeGateway
  const isGatewayDetail = Boolean(routeGateway)
  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [paymentTermsNotes, setPaymentTermsNotes] = useState('')
  const [transferInfoUrl, setTransferInfoUrl] = useState('')
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [ghlInvoiceMode, setGhlInvoiceMode] = useState<'live' | 'test'>('live')
  const [loadingPaymentConfig, setLoadingPaymentConfig] = useState(false)
  const [stripeConfig, setStripeConfig] = useState<StripePaymentConfig | null>(null)
  const [stripeMode, setStripeMode] = useState<'test' | 'live'>('test')
  const [stripeDefaultCurrency, setStripeDefaultCurrency] = useState('MXN')
  const [stripeAccountLabel, setStripeAccountLabel] = useState('')
  const [stripePublishableKey, setStripePublishableKey] = useState('')
  const [stripeSecretKey, setStripeSecretKey] = useState('')
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState('')
  const [loadingStripeConfig, setLoadingStripeConfig] = useState(false)
  const [savingStripeConfig, setSavingStripeConfig] = useState(false)
  const [testingStripeConfig, setTestingStripeConfig] = useState(false)

  useEffect(() => {
    if (loadingHighLevelConnection) return

    if (highLevelConnected) {
      loadPaymentConfig()
    }
  }, [highLevelConnected, loadingHighLevelConnection])

  useEffect(() => {
    loadStripeConfig()
  }, [])

  const stripeGatewayOption: PaymentGatewayOption = useMemo(() => ({
    id: 'stripe',
    name: 'Stripe',
    description: stripeConfig?.configured
      ? `Cobra con tarjeta en tu plantilla pública de invoice (${stripeConfig.mode === 'live' ? 'en vivo' : 'prueba'}).`
      : 'Configura Stripe para crear links de pago públicos con tarjeta dentro de Ristak.',
    status: stripeConfig?.configured ? 'connected' : 'available'
  }), [stripeConfig?.configured, stripeConfig?.mode])

  const gatewayCategories: PaymentGatewayCategory[] = [
    {
      id: 'charge',
      title: highLevelConnected ? 'Pasarela para cobrar' : 'Conecta tu pasarela de pago',
      description: highLevelConnected
        ? 'Selecciona qué conexión debe usar Ristak para cobrar. Las nuevas pasarelas se activarán cuando estén listas.'
        : 'Escoge la opción que quieres usar. Por ahora están en lista de espera y aparecerán como disponibles cuando se liberen.',
      options: [
        ...(highLevelConnected
          ? [HIGHLIGHT_GATEWAY_OPTION]
          : []),
        stripeGatewayOption,
        ...UPCOMING_CHARGE_GATEWAYS
      ]
    },
    {
      id: 'tax',
      title: 'Impuestos',
      description: 'Configura tu proveedor de herramientas fiscales para mantener un flujo de cobro consistente.',
      options: TAX_GATEWAYS
    }
  ]
  const allGatewayOptions = gatewayCategories.flatMap((category) => category.options)

  const selectedGatewayOption = allGatewayOptions.find((gateway) => gateway.id === selectedGateway)
  const showHighLevelSettings = highLevelConnected && selectedGateway === 'highlevel'
  const showStripeSettings = selectedGateway === 'stripe'
  const stripeWebhookEndpoints = stripeConfig?.webhookEndpoints || []
  const pageTitle = isGatewayDetail && selectedGatewayOption ? selectedGatewayOption.name : 'Pagos'
  const pageSubtitle = isGatewayDetail && selectedGatewayOption
    ? selectedGatewayOption.description
    : 'Elige qué pasarela de pago usará Ristak para cobrar y dar seguimiento a tus pagos.'

  const loadPaymentConfig = async () => {
    try {
      const response = await fetch('/api/highlevel/config')
      const config = await response.json()

      if (config.invoiceTitle) setPaymentTitle(config.invoiceTitle)
      if (config.invoiceNumberPrefix) setPaymentNumberPrefix(config.invoiceNumberPrefix)
      if (config.invoiceDueDays) setPaymentDueDays(config.invoiceDueDays)
      if (config.invoiceTermsNotes) setPaymentTermsNotes(config.invoiceTermsNotes)
      if (config.transferInfoUrl) setTransferInfoUrl(config.transferInfoUrl)
      if (config.cardSetupAmount) setCardSetupAmount(Number(config.cardSetupAmount))
      setGhlInvoiceMode(config.ghlInvoiceMode === 'test' ? 'test' : 'live')
    } catch {
      // Usar valores por defecto si no hay configuración todavía.
    }
  }

  const handleSavePaymentConfig = async () => {
    setLoadingPaymentConfig(true)
    try {
      const response = await fetch('/api/highlevel/invoice-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          invoiceTitle: paymentTitle.trim(),
          invoiceNumberPrefix: paymentNumberPrefix.trim(),
          invoiceTermsNotes: paymentTermsNotes.trim() || null,
          invoiceDueDays: paymentDueDays,
          transferInfoUrl: transferInfoUrl.trim() || null,
          cardSetupAmount,
          ghlInvoiceMode
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Error al guardar configuración')
      }

      showToast('success', 'Configuración guardada', 'Los pagos de GoHighLevel ya usan estos datos.')
      window.dispatchEvent(new CustomEvent('ristak-payment-config-changed', {
        detail: { ghlInvoiceMode }
      }))
      await loadPaymentConfig()
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error.message || 'Revisa la configuración de pagos.')
    } finally {
      setLoadingPaymentConfig(false)
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
      await stripePaymentsService.testConfig(buildStripeConfigPayload())
      showToast('success', 'Stripe respondió bien', 'Las credenciales permiten consultar la cuenta.')
    } catch (error: any) {
      showToast('error', 'Stripe no respondió', error.message || 'Revisa la Secret key.')
    } finally {
      setTestingStripeConfig(false)
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

  const handleSelectGateway = (gateway: PaymentGatewayOption) => {
    navigate(`/settings/payments/${gateway.id}`)

    if (gateway.status === 'soon') {
      showToast('info', 'Próximamente', `${gateway.name} todavía no está disponible para conectar.`)
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <CreditCard size={22} />
              </div>
              <div>
                <h2 className={styles.pageTitle}>{pageTitle}</h2>
                <p className={styles.pageSubtitle}>{pageSubtitle}</p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {isGatewayDetail && (
                <Button variant="secondary" onClick={() => navigate('/settings/payments')}>
                  <ArrowLeft size={16} />
                  Pasarelas
                </Button>
              )}
              {loadingHighLevelConnection ? (
                <Badge variant="warning">
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Revisando conexión</span>
                </Badge>
              ) : stripeConfig?.configured ? (
                <Badge variant="success">
                  <CheckCircle size={16} />
                  <span>Stripe conectado</span>
                </Badge>
              ) : highLevelConnected ? (
                <Badge variant="success">
                  <CheckCircle size={16} />
                  <span>GoHighLevel conectado</span>
                </Badge>
              ) : (
                <Badge variant="warning">
                  <Clock size={16} />
                  <span>Pasarela pendiente</span>
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className={`${styles.section} ${styles.paymentsConfigurationSection}`}>
          {!isGatewayDetail && (
            <>
              {gatewayCategories.map((category) => (
                <section key={category.id} className={styles.gatewayCategorySection}>
                  <div className={styles.sectionHeader}>
                    <div>
                      <h3 className={styles.sectionTitle}>{category.title}</h3>
                      <p className={styles.sectionDescription}>{category.description}</p>
                    </div>
                  </div>

                  <div className={styles.gatewayGrid}>
                    {category.options.map((gateway) => {
                      const isSelected = selectedGateway === gateway.id
                      const isConnected = gateway.status === 'connected'
                      const isAvailable = gateway.status === 'available'

                      return (
                        <button
                          key={gateway.id}
                          type="button"
                          className={`${styles.gatewayCard} ${isSelected ? styles.gatewayCardSelected : ''}`}
                          onClick={() => handleSelectGateway(gateway)}
                          aria-pressed={isSelected}
                        >
                          <span className={styles.gatewayCardHeader}>
                            <span className={styles.gatewayCardName}>{gateway.name}</span>
                            <Badge variant={isConnected ? 'success' : isAvailable ? 'info' : 'warning'}>
                              {isConnected ? 'Conectado' : isAvailable ? 'Configurar' : 'Próximamente'}
                            </Badge>
                          </span>
                          <span className={styles.gatewayCardDescription}>{gateway.description}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}

              {!loadingHighLevelConnection && !highLevelConnected && !stripeConfig?.configured && (
                <div className={styles.gatewayNotice}>
                  <h4>Conecta Stripe para cobrar con tarjeta</h4>
                  <p>
                    GoHighLevel no está activo en esta cuenta, pero Stripe ya se puede configurar desde su propia pantalla.
                  </p>
                </div>
              )}
            </>
          )}

          {isGatewayDetail && selectedGatewayOption?.status === 'soon' && (
            <div className={styles.gatewayNotice}>
              <h4>{selectedGatewayOption.name} estará disponible próximamente</h4>
              <p>
                Esta opción todavía no cobra ni guarda datos reales. La dejamos visible para que elijas el camino que quieres usar cuando se libere.
              </p>
            </div>
          )}

          {isGatewayDetail && selectedGateway === 'highlevel' && !highLevelConnected && (
            <div className={styles.gatewayNotice}>
              <h4>GoHighLevel no está conectado</h4>
              <p>
                Conecta GoHighLevel primero para administrar sus invoices desde esta pantalla.
              </p>
            </div>
          )}

          {showStripeSettings && (
            <>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Stripe</h3>
                  <p className={styles.sectionDescription}>
                    Guarda las llaves de Stripe en esta instalación para crear links de pago con tu plantilla pública de invoice.
                  </p>
                </div>
                {loadingStripeConfig ? (
                  <Badge variant="warning">
                    <Loader2 size={16} className={styles.spinIcon} />
                    <span>Cargando</span>
                  </Badge>
                ) : stripeConfig?.configured ? (
                  <Badge variant="success">
                    <ShieldCheck size={16} />
                    <span>Listo para cobrar</span>
                  </Badge>
                ) : (
                  <Badge variant="warning">
                    <KeyRound size={16} />
                    <span>Faltan llaves</span>
                  </Badge>
                )}
              </div>

              <div className={styles.sectionContent}>
                <div className={styles.formField}>
                  <label className={styles.label}>Modo de Stripe</label>
                  <div className={styles.toggleContainer}>
                    <span className={`${styles.toggleLabel} ${stripeMode === 'test' ? styles.toggleLabelActive : ''}`}>
                      Prueba
                    </span>
                    <button
                      type="button"
                      onClick={() => setStripeMode(stripeMode === 'live' ? 'test' : 'live')}
                      className={`${styles.toggle} ${stripeMode === 'live' ? styles.toggleActive : ''}`}
                      disabled={savingStripeConfig || testingStripeConfig}
                      aria-pressed={stripeMode === 'live'}
                      aria-label="Cambiar modo de Stripe"
                    >
                      <span className={styles.toggleThumb} />
                    </button>
                    <span className={`${styles.toggleLabel} ${stripeMode === 'live' ? styles.toggleLabelActive : ''}`}>
                      En vivo
                    </span>
                  </div>
                  <p className={styles.hint}>
                    Usa llaves `pk_test_/sk_test_` para pruebas y `pk_live_/sk_live_` cuando vayas a cobrar real.
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Nombre de cuenta</label>
                  <input
                    type="text"
                    value={stripeAccountLabel}
                    onChange={(event) => setStripeAccountLabel(event.target.value)}
                    placeholder="ej: Stripe Principal"
                    className={styles.input}
                    autoComplete="off"
                  />
                  <p className={styles.hint}>Sólo sirve para identificar esta conexión dentro de Ristak.</p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Moneda principal</label>
                  <input
                    type="text"
                    value={stripeDefaultCurrency}
                    onChange={(event) => setStripeDefaultCurrency(event.target.value.toUpperCase().slice(0, 3))}
                    placeholder="MXN"
                    className={styles.input}
                    autoComplete="off"
                  />
                  <p className={styles.hint}>Los cobros pueden enviar otra moneda desde el modal, pero esta queda como default.</p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Publishable key</label>
                  <input
                    type="text"
                    value={stripePublishableKey}
                    onChange={(event) => setStripePublishableKey(event.target.value)}
                    placeholder="pk_test_..."
                    className={styles.input}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className={styles.hint}>Esta llave puede usarse en la página pública para cargar Stripe Elements.</p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Secret key</label>
                  <input
                    type="password"
                    value={stripeSecretKey}
                    onChange={(event) => setStripeSecretKey(event.target.value)}
                    placeholder={stripeConfig?.hasSecretKey ? stripeConfig.secretKeyPreview : 'sk_test_...'}
                    className={styles.input}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <p className={styles.hint}>Se guarda cifrada y sólo la usa el backend para crear PaymentIntents.</p>
                </div>

                <div className={`${styles.formField} ${styles.stripeWebhookField}`}>
                  <label className={styles.label}>Endpoint URL para Stripe</label>
                  <div className={styles.stripeWebhookEndpointList}>
                    {stripeWebhookEndpoints.map((endpoint) => (
                      <div key={endpoint.url} className={styles.stripeWebhookEndpointRow}>
                        <div className={styles.stripeWebhookEndpointMeta}>
                          <p>{endpoint.label}</p>
                          <span>{endpoint.description}</span>
                        </div>
                        <div className={styles.stripeWebhookEndpointCopy}>
                          <input
                            type="text"
                            readOnly
                            value={endpoint.url}
                            className={styles.input}
                            onFocus={(event) => event.target.select()}
                            aria-label={`Endpoint URL de ${endpoint.label}`}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleCopyStripeWebhookEndpoint(endpoint)}
                          >
                            <Copy size={16} />
                            Copiar
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className={styles.hint}>
                    En Stripe pega una de estas URLs en Developers → Webhooks como Endpoint URL.
                  </p>
                  <div className={styles.stripeWebhookEventsBlock}>
                    <div className={styles.stripeWebhookEventsHeader}>
                      <span>Eventos que debes seleccionar</span>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleCopyStripeWebhookEvents}
                      >
                        <Copy size={16} />
                        Copiar eventos
                      </Button>
                    </div>
                    <div className={styles.stripeWebhookEventsList}>
                      {STRIPE_WEBHOOK_EVENTS.map((event) => (
                        <div key={event.name} className={styles.stripeWebhookEventItem}>
                          <code>{event.name}</code>
                          <span>{event.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Webhook signing secret</label>
                  <input
                    type="password"
                    value={stripeWebhookSecret}
                    onChange={(event) => setStripeWebhookSecret(event.target.value)}
                    placeholder={stripeConfig?.hasWebhookSecret ? stripeConfig.webhookSecretPreview : 'whsec_...'}
                    className={styles.input}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <p className={styles.hint}>Después de crear el endpoint en Stripe, copia aquí el signing secret para validar eventos reales.</p>
                </div>
              </div>

              <div className={styles.actions}>
                <Button
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
                    'Probar conexión'
                  )}
                </Button>
                <Button
                  onClick={handleSaveStripeConfig}
                  disabled={savingStripeConfig || testingStripeConfig}
                >
                  {savingStripeConfig ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Guardando...
                    </>
                  ) : (
                    'Guardar Stripe'
                  )}
                </Button>
              </div>
            </>
          )}

          {showHighLevelSettings && (
            <>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>GoHighLevel Invoices</h3>
                  <p className={styles.sectionDescription}>
                    Personaliza cómo se ven tus pagos y documentos de GoHighLevel.
                  </p>
                </div>
              </div>

              <div className={styles.sectionContent}>
                <div className={styles.formField}>
                  <label className={styles.label}>Modo de GoHighLevel Invoices</label>
                  <div className={styles.toggleContainer}>
                    <span className={`${styles.toggleLabel} ${ghlInvoiceMode === 'test' ? styles.toggleLabelActive : ''}`}>
                      Prueba
                    </span>
                    <button
                      type="button"
                      onClick={() => setGhlInvoiceMode(ghlInvoiceMode === 'live' ? 'test' : 'live')}
                      className={`${styles.toggle} ${ghlInvoiceMode === 'live' ? styles.toggleActive : ''}`}
                      disabled={loadingPaymentConfig}
                      aria-pressed={ghlInvoiceMode === 'live'}
                      aria-label="Cambiar modo de GoHighLevel invoices"
                    >
                      <span className={styles.toggleThumb} />
                    </button>
                    <span className={`${styles.toggleLabel} ${ghlInvoiceMode === 'live' ? styles.toggleLabelActive : ''}`}>
                      En vivo
                    </span>
                  </div>
                  <p className={styles.hint}>
                    En modo prueba, los cobros, links y parcialidades se crean para simular pagos sin afectar ventas reales.
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Título del Documento</label>
                  <input
                    type="text"
                    value={paymentTitle}
                    onChange={(e) => setPaymentTitle(e.target.value)}
                    placeholder="ej: PAGO, FACTURA, INVOICE"
                    className={styles.input}
                  />
                  <p className={styles.hint}>
                    Este título aparecerá en la parte superior del documento
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Prefijo de Número de Pago</label>
                  <input
                    type="text"
                    value={paymentNumberPrefix}
                    onChange={(e) => setPaymentNumberPrefix(e.target.value)}
                    placeholder="ej: INV-, PAY-, FACT-"
                    className={styles.input}
                  />
                  <p className={styles.hint}>
                    Prefijo que se agregará antes del número de pago
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Días para Vencimiento</label>
                  <NumberInput
                    min="1"
                    value={paymentDueDays}
                    onValueChange={(value) => setPaymentDueDays(Math.trunc(value) || 7)}
                    className={styles.input}
                  />
                  <p className={styles.hint}>
                    Número de días desde la fecha de emisión hasta el vencimiento
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Términos y Condiciones</label>
                  <textarea
                    value={paymentTermsNotes}
                    onChange={(e) => setPaymentTermsNotes(e.target.value)}
                    placeholder="Escribe tus términos y condiciones aquí..."
                    className={`${styles.input} ${styles.textareaInput}`}
                  />
                  <p className={styles.hint}>
                    Estos términos aparecerán al final del documento de pago
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>URL con Información para Transferencias</label>
                  <input
                    type="url"
                    value={transferInfoUrl}
                    onChange={(e) => setTransferInfoUrl(e.target.value)}
                    placeholder="ej: https://tu-sitio.com/como-transferir"
                    className={styles.input}
                  />
                  <p className={styles.hint}>
                    Este enlace aparecerá en el registro de pagos manuales para que el cajero lo copie y envíe al cliente
                  </p>
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Monto para Domiciliar Tarjeta (MXN)</label>
                  <NumberInput
                    min="1"
                    step="0.01"
                    value={cardSetupAmount}
                    onValueChange={(value) => setCardSetupAmount(value || 25)}
                    className={styles.input}
                  />
                  <p className={styles.hint}>
                    Se cobra solo cuando hace falta guardar o autorizar una tarjeta antes de activar parcialidades automáticas
                  </p>
                </div>
              </div>

              <div className={styles.actions}>
                <Button
                  onClick={handleSavePaymentConfig}
                  disabled={loadingPaymentConfig}
                >
                  {loadingPaymentConfig ? (
                    <>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Guardando...
                    </>
                  ) : (
                    'Guardar configuración de GoHighLevel'
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
