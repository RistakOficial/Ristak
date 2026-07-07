import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './AppStartupLoader.module.css'

interface AppStartupLoaderProps {
  message?: string
  compact?: boolean
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')

export const AppStartupLoader: React.FC<AppStartupLoaderProps> = ({
  message = 'Cargando',
  compact = false
}) => {
  const ariaMessage = message.trim() || 'Cargando'

  return (
    <main
      data-ristak-layout={!compact ? true : undefined}
      className={cx(styles.screen, compact && styles.compact)}
      role="status"
      aria-live="polite"
      aria-label={ariaMessage}
    >
      <div className={styles.loadingIndicator} aria-hidden="true">
        <Loader2 className={styles.spinner} aria-hidden="true" focusable="false" />
      </div>
      <span className={styles.accessibleMessage}>{ariaMessage}</span>
    </main>
  )
}
