import React from 'react'
import { RistakAppMark } from '@/components/common/RistakAppMark'
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
      <div className={styles.brandStage}>
        <RistakAppMark size="xl" className={styles.brandMark} decorative />
      </div>
      <p className={styles.brandName}>Ristak</p>
    </main>
  )
}
