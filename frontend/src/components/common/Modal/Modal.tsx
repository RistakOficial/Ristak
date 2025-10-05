import React, { useEffect } from 'react'
import { X, Info, AlertCircle, ShieldAlert } from 'lucide-react'
import { Button } from '../Button'
import styles from './Modal.module.css'

export type ModalType = 'confirm' | 'alert' | 'info' | 'custom'
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  message?: string
  type?: ModalType
  size?: ModalSize
  confirmText?: string
  cancelText?: string
  onConfirm?: () => void
  showCloseButton?: boolean
  children?: React.ReactNode
}

const icons = {
  confirm: <AlertCircle size={22} />,
  alert: <ShieldAlert size={22} />,
  info: <Info size={22} />,
  custom: null
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  message,
  type = 'custom',
  size = 'md',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  onConfirm,
  showCloseButton = true,
  children
}) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={`${styles.modal} ${styles[type]} ${styles[size]}`}>
        <div className={styles.header}>
          <div className={styles.titleWrapper}>
            {type !== 'custom' && (
              <div className={styles.iconWrapper}>
                {icons[type]}
              </div>
            )}
            <h2 className={styles.title}>{title}</h2>
          </div>
          {showCloseButton && (
            <button
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Cerrar modal"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {(message || children) && (
          <div className={styles.content}>
            {message && <p className={styles.message}>{message}</p>}
            {children}
          </div>
        )}

        {type !== 'custom' && (
          <div className={styles.footer}>
            {type === 'confirm' && (
              <>
                <Button
                  variant="secondary"
                  onClick={onClose}
                  size="medium"
                >
                  {cancelText}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    onConfirm?.()
                    onClose()
                  }}
                  size="medium"
                >
                  {confirmText}
                </Button>
              </>
            )}
            {(type === 'alert' || type === 'info') && (
              <Button
                variant="primary"
                onClick={onClose}
              >
                {confirmText}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}