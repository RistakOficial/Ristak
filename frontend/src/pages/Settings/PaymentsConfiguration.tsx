import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Card, Button, NumberInput } from '@/components/common'
import { CheckCircle, Clock, CreditCard, Loader2 } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useHighLevelConnected } from '@/hooks/useHighLevelConnected'
import styles from './HighLevelIntegration.module.css'

type PaymentGatewayId = 'highlevel' | 'stripe' | 'mercado-libre' | 'clip' | 'gigstacK'
type PaymentGatewayCategoryId = 'charge' | 'tax'

interface PaymentGatewayOption {
  id: PaymentGatewayId
  name: string
  description: string
  status: 'connected' | 'soon'
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
    id: 'stripe',
    name: 'Stripe',
    description: 'Para cobrar con tarjeta y links de pago cuando esta conexión esté lista.',
    status: 'soon'
  },
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
const isPaymentGatewayId = (value?: string): value is PaymentGatewayId => paymentGatewayIds.includes(value as PaymentGatewayId)
const parsePaymentGatewayRoute = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const paymentsIndex = segments.indexOf('payments')
  const gateway = paymentsIndex >= 0 ? segments[paymentsIndex + 1] : ''
  return isPaymentGatewayId(gateway) ? gateway : ''
}

export const PaymentsConfiguration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeGateway = parsePaymentGatewayRoute(location.pathname)
  const { showToast } = useNotification()
  const { connected: highLevelConnected, loading: loadingHighLevelConnection } = useHighLevelConnected()

  const [selectedGateway, setSelectedGateway] = useState<PaymentGatewayId>(routeGateway || 'stripe')
  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [paymentTermsNotes, setPaymentTermsNotes] = useState('')
  const [transferInfoUrl, setTransferInfoUrl] = useState('')
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [ghlInvoiceMode, setGhlInvoiceMode] = useState<'live' | 'test'>('live')
  const [loadingPaymentConfig, setLoadingPaymentConfig] = useState(false)

  useEffect(() => {
    if (loadingHighLevelConnection) return

    setSelectedGateway(routeGateway || (highLevelConnected ? 'highlevel' : 'stripe'))

    if (highLevelConnected) {
      loadPaymentConfig()
    }
  }, [highLevelConnected, loadingHighLevelConnection, routeGateway])

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

  const handleSelectGateway = (gateway: PaymentGatewayOption) => {
    setSelectedGateway(gateway.id)
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
                <h2 className={styles.pageTitle}>Pagos</h2>
                <p className={styles.pageSubtitle}>
                  Elige qué pasarela de pago usará Ristak para cobrar y dar seguimiento a tus pagos.
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {loadingHighLevelConnection ? (
                <div className={styles.statusWarning}>
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Revisando conexión</span>
                </div>
              ) : highLevelConnected ? (
                <div className={styles.statusConnected}>
                  <CheckCircle size={16} />
                  <span>GoHighLevel conectado</span>
                </div>
              ) : (
                <div className={styles.statusDisconnected}>
                  <Clock size={16} />
                  <span>Pasarela pendiente</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.section}>
          {gatewayCategories.map((category, index) => (
            <section key={category.id} style={index > 0 ? { marginTop: 'var(--spacing-lg)' } : undefined}>
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
                        <span className={isConnected ? styles.gatewayStatusConnected : styles.gatewayStatusSoon}>
                          {isConnected ? 'Conectado' : 'Próximamente'}
                        </span>
                      </span>
                      <span className={styles.gatewayCardDescription}>{gateway.description}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}

          {!loadingHighLevelConnection && !highLevelConnected && (
            <div className={styles.gatewayNotice}>
              <h4>Primero conecta una pasarela</h4>
              <p>
                Cuando una pasarela esté disponible, aquí podrás activarla y Ristak mostrará sus ajustes. Mientras tanto no se muestran opciones de GoHighLevel porque esa conexión no está activa.
              </p>
            </div>
          )}

          {selectedGatewayOption?.status === 'soon' && (
            <div className={styles.gatewayNotice}>
              <h4>{selectedGatewayOption.name} estará disponible próximamente</h4>
              <p>
                Esta opción todavía no cobra ni guarda datos reales. La dejamos visible para que elijas el camino que quieres usar cuando se libere.
              </p>
            </div>
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
                    className={styles.input}
                    style={{ minHeight: '120px', resize: 'vertical' }}
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
