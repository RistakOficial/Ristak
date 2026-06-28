import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

type ToastType = 'success' | 'error' | 'info' | 'warning'
type ModalActionResult = void | boolean | Promise<void | boolean>
type ModalActionHandler = () => ModalActionResult

interface ToastData {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
}

interface ConfirmOptions {
  typeToConfirm?: string
  secondaryActionText?: string
  secondaryActionVariant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  onSecondaryAction?: ModalActionHandler
}

interface ModalData {
  isOpen: boolean
  type: 'confirm' | 'alert' | 'info'
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  secondaryActionText?: string
  secondaryActionVariant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  onConfirm?: ModalActionHandler
  onSecondaryAction?: ModalActionHandler
  onCancel?: () => void
  typeToConfirm?: string
}

interface NotificationContextType {
  showToast: (type: ToastType, title: string, message?: string, duration?: number) => void
  showConfirm: (title: string, message: string, onConfirm: ModalActionHandler, confirmText?: string, cancelText?: string, onCancel?: () => void, options?: ConfirmOptions) => void
  showAlert: (title: string, message: string, confirmText?: string) => void
  showInfo: (title: string, message: string, confirmText?: string) => void
  toasts: ToastData[]
  modal: ModalData
  removeToast: (id: string) => void
  closeModal: () => void
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined)
let toastIdCounter = 0

export const useNotification = () => {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotification debe ser usado dentro de NotificationProvider')
  }
  return context
}

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const [modal, setModal] = useState<ModalData>({
    isOpen: false,
    type: 'info',
    title: '',
    message: ''
  })

  const showToast = useCallback((
    type: ToastType,
    title: string,
    message?: string,
    duration: number = 5000
  ) => {
    toastIdCounter += 1
    const id = `${Date.now()}-${toastIdCounter}`
    const newToast: ToastData = { id, type, title, message, duration }
    setToasts([newToast])
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }, [])

  const showConfirm = useCallback((
    title: string,
    message: string,
    onConfirm: ModalActionHandler,
    confirmText: string = 'Aceptar',
    cancelText: string = 'Cancelar',
    onCancel?: () => void,
    options?: ConfirmOptions
  ) => {
    setModal({
      isOpen: true,
      type: 'confirm',
      title,
      message,
      confirmText,
      cancelText,
      secondaryActionText: options?.secondaryActionText,
      secondaryActionVariant: options?.secondaryActionVariant,
      onConfirm,
      onSecondaryAction: options?.onSecondaryAction,
      onCancel,
      typeToConfirm: options?.typeToConfirm
    })
  }, [])

  const showAlert = useCallback((
    title: string,
    message: string,
    confirmText: string = 'Aceptar'
  ) => {
    setModal({
      isOpen: true,
      type: 'alert',
      title,
      message,
      confirmText
    })
  }, [])

  const showInfo = useCallback((
    title: string,
    message: string,
    confirmText: string = 'Entendido'
  ) => {
    setModal({
      isOpen: true,
      type: 'info',
      title,
      message,
      confirmText
    })
  }, [])

  const closeModal = useCallback(() => {
    setModal(prev => ({ ...prev, isOpen: false }))
  }, [])

  // (LIC-005) Escucha centralizada del evento que emite apiClient cuando el
  // backend responde 403 con code "feature_not_available" (módulo premium fuera
  // del plan). Antes esto fallaba en silencio; ahora mostramos un toast claro.
  useEffect(() => {
    const handleFeatureNotAvailable = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      const message = detail?.message?.trim()
      showToast(
        'warning',
        'Esta función no está incluida en tu plan',
        message || 'Contacta al administrador para activarla.'
      )
    }
    window.addEventListener('ristak:feature-not-available', handleFeatureNotAvailable)
    return () => {
      window.removeEventListener('ristak:feature-not-available', handleFeatureNotAvailable)
    }
  }, [showToast])

  return (
    <NotificationContext.Provider value={{
      showToast,
      showConfirm,
      showAlert,
      showInfo,
      toasts,
      modal,
      removeToast,
      closeModal
    }}>
      {children}
    </NotificationContext.Provider>
  )
}
