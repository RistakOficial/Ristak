import React from 'react'
import styles from './PhoneStartupLoader.module.css'

interface PhoneStartupLoaderProps {
  message?: string
}

export const PhoneStartupLoader: React.FC<PhoneStartupLoaderProps> = ({
  message = 'Abriendo Ristak'
}) => (
  <main className={styles.loader} role="status" aria-live="polite" aria-label={message}>
    <span className={styles.spinner} aria-hidden="true" />
  </main>
)
