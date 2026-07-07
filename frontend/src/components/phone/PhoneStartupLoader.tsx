import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './PhoneStartupLoader.module.css'

interface PhoneStartupLoaderProps {
  message?: string
}

export const PhoneStartupLoader: React.FC<PhoneStartupLoaderProps> = ({
  message = 'Cargando'
}) => {
  const ariaMessage = message.trim() || 'Cargando'

  return (
    <main className={styles.loader} role="status" aria-live="polite" aria-label={ariaMessage}>
      <div className={styles.loadingIndicator} aria-hidden="true">
        <Loader2 className={styles.spinner} aria-hidden="true" focusable="false" />
      </div>
      <span className={styles.accessibleMessage}>{ariaMessage}</span>
    </main>
  )
}
