import React from 'react'
import styles from './PhoneStartupLoader.module.css'

interface PhoneStartupLoaderProps {
  message?: string
}

export const PhoneStartupLoader: React.FC<PhoneStartupLoaderProps> = ({
  message = 'Abriendo Ristak'
}) => (
  <main className={styles.loader} role="status" aria-live="polite" aria-label={message}>
    <section className={styles.loaderFrame}>
      <div className={styles.loaderContent}>
        <div className={styles.brandMark} aria-hidden="true">R</div>
        <div className={styles.copy}>
          <p>Ristak</p>
          <h1>{message}</h1>
        </div>
        <div className={styles.progress} aria-hidden="true">
          <span />
        </div>
      </div>

      <div className={styles.previewStack} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  </main>
)
