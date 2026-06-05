import React, { createContext, useContext, useState, useCallback } from 'react'

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastData {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
}

interface ModalData {
  isOpen: boolean
  type: 'confirm' | 'alert' | 'info'
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm?: () => void
  onCancel?: () => void
}

interface NotificationContextType {
  showToast: (type: ToastType, title: string, message?: string, duration?: number) => void
  showConfirm: (title: string, message: string, onConfirm: () => void, confirmText?: string, cancelText?: string, onCancel?: () => void) => void
  showAlert: (title: string, message: string, confirmText?: string) => void
  showInfo: (title: string, message: string, confirmText?: string) => void
  toasts: ToastData[]
  modal: ModalData
  removeToast: (id: string) => void
  closeModal: () => void
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined)

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
    const id = Date.now().toString()
    const newToast: ToastData = { id, type, title, message, duration }
    setToasts(prev => [...prev, newToast])
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }, [])

  const showConfirm = useCallback((
    title: string,
    message: string,
    onConfirm: () => void,
    confirmText: string = 'Aceptar',
    cancelText: string = 'Cancelar',
    onCancel?: () => void
  ) => {
    setModal({
      isOpen: true,
      type: 'confirm',
      title,
      message,
      confirmText,
      cancelText,
      onConfirm,
      onCancel
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
