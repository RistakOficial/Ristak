import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './Loading.module.css'

type LoadingPage =
  | 'dashboard'
  | 'contacts'
  | 'appointments'
  | 'reports'
  | 'analytics'
  | 'campaigns'
  | 'transactions'
  | 'settings'
  | 'settings-form'
  | 'settings-list'
  | 'calendar-settings'
  | 'sites'
  | 'automations'
  | 'chat'
  | 'ai-agent'
  | 'initialization'
  | 'api-docs'

interface LoadingProps {
  message?: string
  fullScreen?: boolean
  size?: 'sm' | 'md' | 'lg'
  variant?: 'spinner'
  page?: LoadingPage
  kpiLayout?: 'cards' | 'joined'
  kpiCount?: number
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')

const sizeClasses = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg
}

export const Loading: React.FC<LoadingProps> = ({
  message = 'Cargando',
  fullScreen = false,
  size = 'md'
}) => {
  const ariaMessage = message.trim() || 'Cargando'
  const containerClass = fullScreen ? styles.fullScreenContainer : styles.container

  return (
    <div className={containerClass} role="status" aria-live="polite" aria-label={ariaMessage}>
      <div className={cx(styles.loadingWrapper, sizeClasses[size])}>
        <Loader2 className={styles.spinner} aria-hidden="true" />
        <p className={styles.message}>Cargando</p>
      </div>
    </div>
  )
}
