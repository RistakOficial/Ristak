import React, { useState, useEffect } from 'react'
import { Card, Button, Modal } from '@/components/common'
import { Eye, EyeOff, Loader2, CheckCircle, XCircle, ExternalLink } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { getStripeConfig, saveStripeConfig } from '@/services/paymentMethodsService'
import styles from './HighLevelIntegration.module.css'

export const PaymentsConfiguration: React.FC = () => {
  const { showToast } = useNotification()

  // Estados de configuración
  const [stripeTestKey, setStripeTestKey] = useState('')
  const [stripeLiveKey, setStripeLiveKey] = useState('')
  const [stripeMode, setStripeMode] = useState<'test' | 'live'>('test')
  const [showStripeTestKey, setShowStripeTestKey] = useState(false)
  const [showStripeLiveKey, setShowStripeLiveKey] = useState(false)
  const [loadingStripe, setLoadingStripe] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasTestKey, setHasTestKey] = useState(false)
  const [hasLiveKey, setHasLiveKey] = useState(false)
  const [showDisconnectModal, setShowDisconnectModal] = useState(false)

  // Estados de configuración de pagos
  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [paymentTermsNotes, setPaymentTermsNotes] = useState('')
  const [loadingPaymentConfig, setLoadingPaymentConfig] = useState(false)

  useEffect(() => {
    loadStripeConfig()
    loadPaymentConfig()
  }, [])

  const loadStripeConfig = async () => {
    try {
      const config = await getStripeConfig()

      if (config.configured) {
        setIsConfigured(true)
        setStripeMode(config.mode || 'test')
        setHasTestKey(config.hasTestKey)
        setHasLiveKey(config.hasLiveKey)

        // Mostrar preview ofuscado
        if (config.hasTestKey) {
          setStripeTestKey('sk_test_************************************')
        }
        if (config.hasLiveKey) {
          setStripeLiveKey('sk_live_************************************')
        }
      } else {
        // Resetear estado si no está configurado
        setIsConfigured(false)
        setHasTestKey(false)
        setHasLiveKey(false)
      }
    } catch (error) {
      // Error silencioso
    }
  }

  const handleSaveStripeConfig = async () => {
    // Validar que al menos una key esté presente
    const hasValidTestKey = stripeTestKey.trim() && !stripeTestKey.startsWith('sk_test_***')
    const hasValidLiveKey = stripeLiveKey.trim() && !stripeLiveKey.startsWith('sk_live_***')

    if (!hasValidTestKey && !hasValidLiveKey) {
      showToast('error', 'Debes proporcionar al menos una Secret Key')
      return
    }

    setLoadingStripe(true)
    try {
      await saveStripeConfig({
        testSecretKey: hasValidTestKey ? stripeTestKey.trim() : undefined,
        liveSecretKey: hasValidLiveKey ? stripeLiveKey.trim() : undefined,
        // Cuando NO está configurado, siempre usar 'test' por defecto
        // Solo usar stripeMode cuando ya está configurado (tiene toggle visible)
        mode: isConfigured ? stripeMode : 'test'
      })

      showToast('success', 'Configuración de Stripe guardada exitosamente')

      // Recargar config
      await loadStripeConfig()
    } catch (error: any) {
      showToast('error', error.message || 'Error al guardar configuración de Stripe')
    } finally {
      setLoadingStripe(false)
    }
  }

  const handleToggleMode = async () => {
    const newMode = stripeMode === 'test' ? 'live' : 'test'

    setLoadingStripe(true)
    try {
      await saveStripeConfig({
        mode: newMode
      })

      setStripeMode(newMode)
      showToast('success', `Stripe ahora está en modo ${newMode === 'test' ? 'pruebas' : 'producción'}`)
    } catch (error: any) {
      showToast('error', error.message || 'No se pudo cambiar el modo')
    } finally {
      setLoadingStripe(false)
    }
  }

  const handleDisconnect = async () => {
    setLoadingStripe(true)
    try {
      await saveStripeConfig({
        testSecretKey: '',
        liveSecretKey: '',
        mode: 'test'
      })

      // Resetear estado
      setIsConfigured(false)
      setStripeTestKey('')
      setStripeLiveKey('')
      setStripeMode('test')
      setHasTestKey(false)
      setHasLiveKey(false)

      showToast('success', 'Stripe desconectado exitosamente')
    } catch (error: any) {
      showToast('error', error.message || 'Error al desconectar Stripe')
    } finally {
      setLoadingStripe(false)
      setShowDisconnectModal(false)
    }
  }

  const loadPaymentConfig = async () => {
    try {
      // Por ahora temporal - después conectaremos con el backend
      const response = await fetch('/api/highlevel/config')
      const config = await response.json()

      if (config.invoiceTitle) setPaymentTitle(config.invoiceTitle)
      if (config.invoiceNumberPrefix) setPaymentNumberPrefix(config.invoiceNumberPrefix)
      if (config.invoiceDueDays) setPaymentDueDays(config.invoiceDueDays)
      if (config.invoiceTermsNotes) setPaymentTermsNotes(config.invoiceTermsNotes)
    } catch (error) {
      // Error silencioso - usar valores por defecto
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
          invoiceDueDays: paymentDueDays
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Error al guardar configuración')
      }

      showToast('success', 'Configuración de pagos guardada exitosamente')
      await loadPaymentConfig() // Recargar configuración
    } catch (error: any) {
      showToast('error', error.message || 'Error al guardar configuración de pagos')
    } finally {
      setLoadingPaymentConfig(false)
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <svg width="60" height="25" viewBox="0 0 60 25" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M59.64 14.28h-8.06c.19 1.93 1.6 2.55 3.2 2.55 1.64 0 2.96-.37 4.05-.95v3.32a8.33 8.33 0 0 1-4.56 1.1c-4.01 0-6.83-2.5-6.83-7.48 0-4.19 2.39-7.52 6.3-7.52 3.92 0 5.96 3.28 5.96 7.5 0 .4-.04 1.26-.06 1.48zm-5.92-5.62c-1.03 0-2.17.73-2.17 2.58h4.25c0-1.85-1.07-2.58-2.08-2.58zM40.95 20.3c-1.44 0-2.32-.6-2.9-1.04l-.02 4.63-4.12.87V5.57h3.76l.08 1.02a4.7 4.7 0 0 1 3.23-1.29c2.9 0 5.62 2.6 5.62 7.4 0 5.23-2.7 7.6-5.65 7.6zM40 8.95c-.95 0-1.54.34-1.97.81l.02 6.12c.4.44.98.78 1.95.78 1.52 0 2.54-1.65 2.54-3.87 0-2.15-1.04-3.84-2.54-3.84zM28.24 5.57h4.13v14.44h-4.13V5.57zm0-4.7L32.37 0v3.36l-4.13.88V.88zm-4.32 9.35v9.79H19.8V5.57h3.7l.12 1.22c1-1.77 3.07-1.41 3.62-1.22v3.79c-.52-.17-2.29-.43-3.32.86zm-8.55 4.72c0 2.43 2.6 1.68 3.12 1.46v3.36c-.55.3-1.54.54-2.89.54a4.15 4.15 0 0 1-4.27-4.24l.01-13.17 4.02-.86v3.54h3.14V9.1h-3.13v5.85zm-4.91.7c0 2.97-2.31 4.66-5.73 4.66a11.2 11.2 0 0 1-4.46-.93v-3.93c1.38.75 3.1 1.31 4.46 1.31.92 0 1.53-.24 1.53-1C6.26 13.77 0 14.51 0 9.95 0 7.04 2.28 5.3 5.62 5.3c1.36 0 2.72.2 4.09.75v3.88a9.23 9.23 0 0 0-4.1-1.06c-.86 0-1.44.25-1.44.93 0 1.85 6.29.97 6.29 5.88z" fill="#635BFF"/>
                </svg>
              </div>
              <p className={styles.pageSubtitle}>
                {isConfigured ? 'Conectado correctamente' : 'Configura tus credenciales para cobrar a tarjetas guardadas'}
              </p>
            </div>
            <div className={styles.headerRight}>
              {isConfigured ? (
                <div className={styles.statusConnected}>
                  <CheckCircle size={16} />
                  <span>Conectado</span>
                </div>
              ) : (
                <div className={styles.statusDisconnected}>
                  <XCircle size={16} />
                  <span>No configurado</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {isConfigured ? (
          /* VISTA CONFIGURADO: Información de la cuenta + toggle */
          <>
            {/* Información de Keys Configuradas */}
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>Configuración Actual</h3>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => setShowDisconnectModal(true)}
                  disabled={loadingStripe}
                >
                  Desconectar
                </Button>
              </div>
              <div className={styles.sectionContent}>
                <div className={styles.infoGrid}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>Test Secret Key:</span>
                    <span className={styles.infoValue}>
                      {hasTestKey ? (
                        <span className={styles.statusSuccess}>
                          <CheckCircle size={14} />
                          Configurada
                        </span>
                      ) : (
                        <span className={styles.statusError}>
                          <XCircle size={14} />
                          No configurada
                        </span>
                      )}
                    </span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>Live Secret Key:</span>
                    <span className={styles.infoValue}>
                      {hasLiveKey ? (
                        <span className={styles.statusSuccess}>
                          <CheckCircle size={14} />
                          Configurada
                        </span>
                      ) : (
                        <span className={styles.statusError}>
                          <XCircle size={14} />
                          No configurada
                        </span>
                      )}
                    </span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>Dashboard:</span>
                    <span className={styles.infoValue}>
                      <a
                        href={stripeMode === 'test'
                          ? "https://dashboard.stripe.com/test/dashboard"
                          : "https://dashboard.stripe.com/dashboard"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.link}
                      >
                        Ver en Stripe <ExternalLink size={12} />
                      </a>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Modo de Operación */}
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>Modo de Operación</h3>
              </div>
              <div className={styles.sectionContent}>
                <div className={styles.infoBox}>
                  <p className={styles.infoText}>
                    {stripeMode === 'test'
                      ? 'Usando tarjetas de prueba (sandbox)'
                      : 'Usando tarjetas reales (producción)'}
                  </p>
                  <div className={styles.toggleContainer}>
                    <span className={`${styles.toggleLabel} ${stripeMode === 'test' ? styles.toggleLabelActive : ''}`}>
                      🧪 Test
                    </span>
                    <button
                      onClick={handleToggleMode}
                      className={`${styles.toggle} ${stripeMode === 'live' ? styles.toggleActive : ''}`}
                      disabled={loadingStripe}
                    >
                      <span className={styles.toggleThumb} />
                    </button>
                    <span className={`${styles.toggleLabel} ${stripeMode === 'live' ? styles.toggleLabelActive : ''}`}>
                      ⚡ Live
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* VISTA NO CONFIGURADO: Formulario simplificado */
          <>
            {/* Credenciales */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Credenciales de Stripe</h3>
              <div className={styles.sectionContent}>
                {/* Test Secret Key */}
                <div className={styles.formField}>
                  <label className={styles.label}>Test Secret Key (Sandbox)</label>
                  <div className={styles.inputGroup}>
                    <input
                      type={showStripeTestKey ? 'text' : 'password'}
                      value={stripeTestKey}
                      onChange={(e) => setStripeTestKey(e.target.value)}
                      placeholder="sk_test_..."
                      className={styles.input}
                    />
                    <button
                      type="button"
                      onClick={() => setShowStripeTestKey(!showStripeTestKey)}
                      className={styles.inputButton}
                    >
                      {showStripeTestKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <p className={styles.hint}>
                    Para pruebas. Obtén tu Test Key en{' '}
                    <a href="https://dashboard.stripe.com/test/apikeys" target="_blank" rel="noopener noreferrer" className={styles.link}>
                      Stripe Dashboard <ExternalLink size={12} />
                    </a>
                  </p>
                </div>

                {/* Live Secret Key */}
                <div className={styles.formField}>
                  <label className={styles.label}>Live Secret Key (Producción)</label>
                  <div className={styles.inputGroup}>
                    <input
                      type={showStripeLiveKey ? 'text' : 'password'}
                      value={stripeLiveKey}
                      onChange={(e) => setStripeLiveKey(e.target.value)}
                      placeholder="sk_live_..."
                      className={styles.input}
                    />
                    <button
                      type="button"
                      onClick={() => setShowStripeLiveKey(!showStripeLiveKey)}
                      className={styles.inputButton}
                    >
                      {showStripeLiveKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <p className={styles.hint}>
                    Para cobros reales. Obtén tu Live Key en{' '}
                    <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" className={styles.link}>
                      Stripe Dashboard <ExternalLink size={12} />
                    </a>
                  </p>
                </div>
              </div>
            </div>

            {/* Botón guardar */}
            <div className={styles.actions}>
              <Button
                onClick={handleSaveStripeConfig}
                disabled={loadingStripe}
              >
                {loadingStripe ? (
                  <>
                    <Loader2 size={18} className={styles.spinIcon} />
                    Guardando...
                  </>
                ) : (
                  '💾 Guardar Configuración de Stripe'
                )}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Configuración de Pagos */}
      <Card className={styles.mainCard} style={{ marginTop: '24px' }}>
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración de Pagos</h3>
          </div>
          <p className={styles.sectionDescription} style={{ marginBottom: '24px' }}>
            Personaliza cómo se ven tus pagos y documentos
          </p>

          <div className={styles.sectionContent}>
            {/* Título del documento */}
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

            {/* Prefijo del número */}
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
                Prefijo que se agregará antes del número de pago (ej: INV-000533)
              </p>
            </div>

            {/* Días de vencimiento */}
            <div className={styles.formField}>
              <label className={styles.label}>Días para Vencimiento (predeterminado)</label>
              <input
                type="number"
                min="1"
                value={paymentDueDays}
                onChange={(e) => setPaymentDueDays(parseInt(e.target.value) || 7)}
                className={styles.input}
              />
              <p className={styles.hint}>
                Número de días desde la fecha de emisión hasta el vencimiento
              </p>
            </div>

            {/* Términos y condiciones */}
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
          </div>

          {/* Botón guardar */}
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
                '💾 Guardar Configuración de Pagos'
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Modal de confirmación para desconectar */}
      <Modal
        isOpen={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
        title="¿Desconectar Stripe?"
        message="Se eliminarán todas las configuraciones de Stripe. Tendrás que volver a ingresar tus Secret Keys si quieres reconectar."
        type="confirm"
        confirmText="Desconectar"
        cancelText="Cancelar"
        onConfirm={handleDisconnect}
      />
    </div>
  )
}
