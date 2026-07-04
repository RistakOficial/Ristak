import React from 'react'
import { RistakAppMark } from '@/components/common/RistakAppMark'
import styles from './PhoneStartupLoader.module.css'

interface PhoneStartupLoaderProps {
  message?: string
}

export const PhoneStartupLoader: React.FC<PhoneStartupLoaderProps> = ({
  message = 'Abriendo Ristak'
}) => (
  <main className={styles.loader} role="status" aria-live="polite" aria-label={message}>
    <div className={styles.brandStage}>
      <RistakAppMark size="xl" className={styles.brandMark} decorative />
    </div>
    <p className={styles.brandName}>Ristak</p>
  </main>
)
