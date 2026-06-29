import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Info, AlertCircle, ShieldAlert } from 'lucide-react'
import { useBottomSheetDismiss } from '@/hooks'
import { Button } from '../Button'
import styles from './Modal.module.css'

type ModalType = 'confirm' | 'alert' | 'info' | 'custom'
type ModalSize = 'sm' | 'md' | 'lg' | 'xl'
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ModalActionResult = void | boolean | Promise<void | boolean>
type ModalActionHandler = () => ModalActionResult

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: React.ReactNode
  message?: string
  type?: ModalType
  size?: ModalSize
  confirmText?: string
  cancelText?: string
  secondaryActionText?: string
  secondaryActionVariant?: ButtonVariant
  onConfirm?: ModalActionHandler
  onSecondaryAction?: ModalActionHandler
  onCancel?: () => void
  showCloseButton?: boolean
  className?: string
  backdropClassName?: string
  contentClassName?: string
  closeIcon?: React.ReactNode
  closeAriaLabel?: string
  closeOnBackdropClick?: boolean
  closeOnEscape?: boolean
  draggableSheet?: boolean
  typeToConfirm?: string
  /** Quita el padding global del contenido. Solo para modales que dibujan su
   * propio layout de borde a borde (listas full-bleed, footers sticky propios);
   * el resto hereda el padding estándar automáticamente. */
  flushContent?: boolean
  children?: React.ReactNode
}

const icons = {
  confirm: <AlertCircle size={22} />,
  alert: <ShieldAlert size={22} />,
  info: <Info size={22} />,
  custom: null
}

const destructiveConfirmTextSignals = [
  'eliminar',
  'borrar',
  'desconectar',
  'revocar',
  'anular',
  'reembolsar',
  'salir sin guardar',
  'cancelar cuenta',
  'cancelar plan',
  'cancelar pago',
  'cancelar factura'
]

const destructiveTitleSignals = [
  ...destructiveConfirmTextSignals,
  'cancelar suscripcion',
  'cancelar suscripción',
  'cancelar subscripcion'
]

const genericConfirmTexts = new Set(['aceptar', 'confirmar', 'si', 'si continuar', 'si, continuar'])

const normalizeModalText = (text = '') =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

const includesSignal = (text: string, signals: string[]) =>
  signals.some(signal => text.includes(signal))

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  message,
  type = 'custom',
  size = 'md',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  secondaryActionText,
  secondaryActionVariant = 'primary',
  onConfirm,
  onSecondaryAction,
  onCancel,
  showCloseButton = true,
  className = '',
  backdropClassName = '',
  contentClassName = '',
  closeIcon,
  closeAriaLabel = 'Cerrar modal',
  closeOnBackdropClick = true,
  closeOnEscape = true,
  draggableSheet = false,
  typeToConfirm,
  flushContent = false,
  children
}) => {
  const [typedConfirmation, setTypedConfirmation] = useState('')
  const [pendingAction, setPendingAction] = useState<'confirm' | 'secondary' | null>(null)
  const requiresTypedConfirmation = type === 'confirm' && !!typeToConfirm
  const typedConfirmationValid = !requiresTypedConfirmation ||
    normalizeModalText(typedConfirmation) === normalizeModalText(typeToConfirm || '')

  useEffect(() => {
    if (!isOpen) {
      setTypedConfirmation('')
      setPendingAction(null)
    }
  }, [isOpen])

  const normalizedConfirmText = normalizeModalText(confirmText)
  const isGenericConfirmText = genericConfirmTexts.has(normalizedConfirmText)
  const isDestructiveConfirm = type === 'confirm' && (
    includesSignal(normalizedConfirmText, destructiveConfirmTextSignals) ||
    (isGenericConfirmText && includesSignal(normalizeModalText(title), destructiveTitleSignals))
  )
  const confirmButtonVariant: ButtonVariant = isDestructiveConfirm ? 'danger' : 'primary'
  const isSystemModal = type !== 'custom'
  const actionPending = pendingAction !== null

  const handleCancel = useCallback(() => {
    if (pendingAction) return
    onCancel?.()
    onClose()
  }, [onCancel, onClose, pendingAction])

  const runAction = useCallback(async (
    actionName: 'confirm' | 'secondary',
    action?: ModalActionHandler
  ) => {
    if (!typedConfirmationValid || pendingAction) return
    setPendingAction(actionName)
    try {
      const result = await action?.()
      if (result !== false) onClose()
    } catch {
      // La acción dueña del flujo muestra el error; el modal se queda abierto.
    } finally {
      setPendingAction(null)
    }
  }, [onClose, pendingAction, typedConfirmationValid])
  const bottomSheetDismiss = useBottomSheetDismiss({
    isOpen: isOpen && draggableSheet,
    onClose: handleCancel
  })
  const closeWithSheetAnimation = bottomSheetDismiss.requestClose
  const bottomSheetMoving = bottomSheetDismiss.dragging || bottomSheetDismiss.closing || bottomSheetDismiss.dragOffset > 0
  const bottomSheetDragging = bottomSheetDismiss.dragging || bottomSheetDismiss.dragOffset > 0

  // Si el padre cierra el sheet por código (isOpen pasa a false sin gesto),
  // lo mantenemos montado el tiempo de la animación para que colapse suave
  // en vez de desaparecer de golpe.
  const [sheetExiting, setSheetExiting] = useState(false)
  const wasOpenRef = useRef(false)
  const animatedCloseRef = useRef(false)
  if (bottomSheetDismiss.closing) {
    animatedCloseRef.current = true
  }

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true
      animatedCloseRef.current = false
      setSheetExiting(false)
      return
    }

    if (!wasOpenRef.current) return
    wasOpenRef.current = false

    if (!draggableSheet || animatedCloseRef.current) {
      animatedCloseRef.current = false
      return
    }

    setSheetExiting(true)
    const timer = window.setTimeout(() => setSheetExiting(false), 260)
    return () => window.clearTimeout(timer)
  }, [draggableSheet, isOpen])

  useEffect(() => {
    if (!isOpen) return

    const previousBodyOverflow = document.body.style.overflow

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && closeOnEscape) {
        if (draggableSheet) closeWithSheetAnimation()
        else handleCancel()
      }
    }

    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = previousBodyOverflow
    }
  }, [closeOnEscape, closeWithSheetAnimation, draggableSheet, handleCancel, isOpen])

  if (!isOpen && !sheetExiting) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) {
      if (draggableSheet) closeWithSheetAnimation()
      else handleCancel()
    }
  }

  const modalContent = (
    <div
      className={`${styles.backdrop} ${isSystemModal ? styles.systemBackdrop : ''} ${draggableSheet ? styles.bottomSheetBackdrop : ''} ${draggableSheet && bottomSheetDragging ? styles.bottomSheetBackdropInteractive : ''} ${draggableSheet && bottomSheetDismiss.closing ? styles.bottomSheetBackdropClosing : ''} ${sheetExiting ? styles.bottomSheetBackdropExiting : ''} ${backdropClassName}`.trim()}
      style={draggableSheet ? bottomSheetDismiss.backdropStyle : undefined}
      onClick={handleBackdropClick}
      data-overlay=""
      data-phone-modal-root="true"
    >
      <div
        className={`${styles.modal} ${styles[type]} ${styles[size]} ${isDestructiveConfirm ? styles.destructive : ''} ${draggableSheet ? styles.bottomSheetModal : ''} ${draggableSheet && bottomSheetMoving ? styles.bottomSheetModalInteractive : ''} ${sheetExiting ? styles.bottomSheetModalExiting : ''} ${className}`.trim()}
        style={draggableSheet ? bottomSheetDismiss.sheetStyle : undefined}
        data-modal=""
        data-modal-size={size}
        data-modal-type={type}
        {...(draggableSheet ? bottomSheetDismiss.sheetDragProps : {})}
      >
        {draggableSheet && (
          <div className={styles.bottomSheetHandle} aria-hidden="true" />
        )}
        {/* Solo mostrar header si hay título o botón de cerrar */}
        {(title || showCloseButton) && (
          <div className={styles.header} data-modal-header="">
            <div className={styles.titleWrapper}>
              {type !== 'custom' && (
                <div className={styles.iconWrapper}>
                  {icons[type]}
                </div>
              )}
              <div className={styles.titleText}>
                {title && <h2 className={styles.title}>{title}</h2>}
                {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
              </div>
            </div>
            {showCloseButton && (
              <button
                className={styles.closeButton}
                onClick={draggableSheet ? closeWithSheetAnimation : handleCancel}
                aria-label={closeAriaLabel}
                disabled={actionPending}
              >
                {closeIcon ?? <X size={20} />}
              </button>
            )}
          </div>
        )}

        {(message || children) && (
          <div
            className={`${styles.content} ${flushContent ? styles.flush : ''} ${contentClassName}`.trim()}
            data-modal-content=""
            data-modal-flush={flushContent ? 'true' : undefined}
            data-phone-scrollable="true"
          >
            {message && <p className={styles.message}>{message}</p>}
            {requiresTypedConfirmation && (
              <div className={styles.typeToConfirm}>
                <label className={styles.typeToConfirmLabel}>
                  Escribe <strong>{typeToConfirm}</strong> para confirmar:
                </label>
                <input
                  type="text"
                  className={styles.typeToConfirmInput}
                  value={typedConfirmation}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  placeholder={typeToConfirm}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            {children}
          </div>
        )}

        {type !== 'custom' && (
          <div className={styles.footer} data-modal-footer="">
            {type === 'confirm' && (
              <>
                <Button
                  variant="secondary"
                  onClick={handleCancel}
                  size="medium"
                  disabled={actionPending}
                >
                  {cancelText}
                </Button>
                <Button
                  variant={confirmButtonVariant}
                  disabled={!typedConfirmationValid || actionPending}
                  loading={pendingAction === 'confirm'}
                  onClick={() => void runAction('confirm', onConfirm)}
                  size="medium"
                >
                  {confirmText}
                </Button>
                {secondaryActionText && onSecondaryAction && (
                  <Button
                    variant={secondaryActionVariant}
                    disabled={!typedConfirmationValid || actionPending}
                    loading={pendingAction === 'secondary'}
                    onClick={() => void runAction('secondary', onSecondaryAction)}
                    size="medium"
                  >
                    {secondaryActionText}
                  </Button>
                )}
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

  return createPortal(modalContent, document.body)
}
