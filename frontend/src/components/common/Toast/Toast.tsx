import React, { useEffect, useState } from 'react'
import { X, CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'
import styles from './Toast.module.css'

type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastProps {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
  onClose: (id: string) => void
}

const icons = {
  success: <CheckCircle2 size={20} strokeWidth={2} />,
  error: <XCircle size={20} strokeWidth={2} />,
  info: <Info size={20} strokeWidth={2} />,
  warning: <AlertTriangle size={20} strokeWidth={2} />
}

const EXIT_ANIMATION_MS = 260

export const Toast: React.FC<ToastProps> = ({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose
}) => {
  const [isClosing, setIsClosing] = useState(false)

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setIsClosing(true)
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [duration])

  useEffect(() => {
    if (!isClosing) return

    const timer = setTimeout(() => {
      onClose(id)
    }, EXIT_ANIMATION_MS)

    return () => clearTimeout(timer)
  }, [id, isClosing, onClose])

  const handleClose = () => {
    setIsClosing(true)
  }

  return (
    <div className={`${styles.toast} ${styles[type]} ${isClosing ? styles.closing : ''}`}>
      <div className={styles.icon}>{icons[type]}</div>
      <div className={styles.content}>
        <div className={styles.title}>{title}</div>
        {message && <div className={styles.message}>{message}</div>}
      </div>
      <button
        className={styles.closeButton}
        onClick={handleClose}
        aria-label="Cerrar notificación"
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
