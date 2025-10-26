import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { Copy, ExternalLink, Check } from 'lucide-react'
import styles from './PaymentLinkDialog.module.css'
import { useNotification } from '@/contexts/NotificationContext'

interface PaymentLinkDialogProps {
  isOpen: boolean
  onClose: () => void
  paymentLink: string
  contactName?: string
}

export const PaymentLinkDialog: React.FC<PaymentLinkDialogProps> = ({
  isOpen,
  onClose,
  paymentLink,
  contactName
}) => {
  const [copied, setCopied] = useState(false)
  const { showToast } = useNotification()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(paymentLink)
      setCopied(true)
      showToast('success', 'Enlace copiado', 'El enlace de pago ha sido copiado al portapapeles')

      // Resetear el ícono después de 2 segundos
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar el enlace')
    }
  }

  const handleOpenLink = () => {
    window.open(paymentLink, '_blank')
  }

  const handleSelectText = (e: React.MouseEvent<HTMLInputElement>) => {
    e.currentTarget.select()
  }

  return createPortal(
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Enlace de Pago Generado"
      size="md"
      type="custom"
    >
      <div className={styles.content}>
        <div className={styles.description}>
          {contactName
            ? `Enlace de pago para ${contactName}. Cópialo y envíalo manualmente.`
            : 'Copia este enlace y envíalo al cliente por el medio que prefieras.'}
        </div>

        <div className={styles.linkContainer}>
          <div className={styles.inputWrapper}>
            <input
              type="text"
              value={paymentLink}
              readOnly
              className={styles.linkInput}
              onClick={handleSelectText}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopy}
              className={styles.copyButton}
            >
              {copied ? (
                <Check size={16} className={styles.checkIcon} />
              ) : (
                <Copy size={16} />
              )}
            </Button>
          </div>
          <p className={styles.hint}>
            Haz clic en el enlace para seleccionarlo o usa el botón para copiarlo
          </p>
        </div>

        <div className={styles.infoBox}>
          <h4 className={styles.infoTitle}>¿Cómo usar este enlace?</h4>
          <ul className={styles.infoList}>
            <li>Copia el enlace y envíalo por WhatsApp, Telegram, o cualquier mensajero</li>
            <li>Pégalo en un email personalizado</li>
            <li>Compártelo en tus redes sociales o grupos</li>
            <li>El cliente podrá pagar directamente desde el enlace</li>
          </ul>
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="secondary" onClick={onClose}>
          Cerrar
        </Button>
        <div className={styles.primaryActions}>
          <Button
            variant="outline"
            onClick={handleOpenLink}
          >
            <ExternalLink size={16} />
            <span style={{ marginLeft: '6px' }}>Abrir en Nueva Pestaña</span>
          </Button>
          <Button
            variant="primary"
            onClick={handleCopy}
          >
            <Copy size={16} />
            <span style={{ marginLeft: '6px' }}>Copiar Enlace</span>
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  )
}