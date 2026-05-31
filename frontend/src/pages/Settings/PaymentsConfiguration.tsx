import React, { useEffect, useState } from 'react'
import { Card, Button } from '@/components/common'
import { Loader2 } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './HighLevelIntegration.module.css'

export const PaymentsConfiguration: React.FC = () => {
  const { showToast } = useNotification()

  const [paymentTitle, setPaymentTitle] = useState('PAGO')
  const [paymentNumberPrefix, setPaymentNumberPrefix] = useState('INV-')
  const [paymentDueDays, setPaymentDueDays] = useState(7)
  const [paymentTermsNotes, setPaymentTermsNotes] = useState('')
  const [transferInfoUrl, setTransferInfoUrl] = useState('')
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [ghlInvoiceMode, setGhlInvoiceMode] = useState<'live' | 'test'>('live')
  const [loadingPaymentConfig, setLoadingPaymentConfig] = useState(false)

  useEffect(() => {
    loadPaymentConfig()
  }, [])

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

      showToast('success', 'Configuración de pagos guardada exitosamente')
      window.dispatchEvent(new CustomEvent('ristak-payment-config-changed', {
        detail: { ghlInvoiceMode }
      }))
      await loadPaymentConfig()
    } catch (error: any) {
      showToast('error', error.message || 'Error al guardar configuración de pagos')
    } finally {
      setLoadingPaymentConfig(false)
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <h2 className={styles.pageTitle}>Configuración de Pagos</h2>
              <p className={styles.pageSubtitle}>
                Ristak usa GoHighLevel como fuente de cobros, links, domiciliación y parcialidades.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>GoHighLevel Invoices</h3>
          </div>
          <p className={styles.sectionDescription} style={{ marginBottom: '24px' }}>
            Personaliza cómo se ven tus pagos y documentos
          </p>

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
                En modo prueba, los invoices, links y parcialidades de GoHighLevel se crean con liveMode desactivado para simular pagos.
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
              <input
                type="number"
                min="1"
                step="0.01"
                value={cardSetupAmount}
                onChange={(e) => setCardSetupAmount(Number(e.target.value) || 25)}
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
                'Guardar Configuración de Pagos'
              )}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
