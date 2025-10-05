import React, { useEffect } from 'react'
import { X, CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'
import styles from './Toast.module.css'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

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

export const Toast: React.FC<ToastProps> = ({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose
}) => {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onClose(id)
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [duration, id, onClose])

  return (
    <div className={`${styles.toast} ${styles[type]}`}>
      <div className={styles.icon}>{icons[type]}</div>
      <div className={styles.content}>
        <div className={styles.title}>{title}</div>
        {message && <div className={styles.message}>{message}</div>}
      </div>
      <button
        className={styles.closeButton}
        onClick={() => onClose(id)}
        aria-label="Cerrar notificación"
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
