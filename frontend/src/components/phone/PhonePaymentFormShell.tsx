import React from 'react'
import { ChevronLeft } from 'lucide-react'
import styles from './PhonePaymentFormShell.module.css'

interface PhonePaymentFormShellSummary {
  label: string
  detail?: string
  amount: string
}

interface PhonePaymentFormShellProps {
  title?: string
  subtitle?: string
  icon?: React.ReactNode
  ariaLabel?: string
  onBack?: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  summary?: PhonePaymentFormShellSummary | null
  className?: string
  contentClassName?: string
}

/**
 * Layout compartido para formularios de pagos dentro de la app móvil.
 * Replica la estructura embebida de RecordPaymentModal: scroll propio,
 * botón de regreso arriba y acciones dentro del flujo para no tapar campos.
 */
export const PhonePaymentFormShell: React.FC<PhonePaymentFormShellProps> = ({
  title,
  subtitle,
  icon,
  ariaLabel,
  onBack,
  children,
  footer,
  summary = null,
  className = '',
  contentClassName = ''
}) => (
  <section
    className={[
      styles.root,
      onBack ? '' : styles.rootNoBack,
      className
    ].filter(Boolean).join(' ')}
    aria-label={ariaLabel || title}
  >
    {onBack && (
      <button
        type="button"
        className={styles.backButton}
        onClick={onBack}
      >
        <ChevronLeft size={20} aria-hidden="true" />
        <span>Atrás</span>
      </button>
    )}

    <div
      className={styles.scroll}
      data-phone-chat-scrollable="true"
      data-phone-scrollable="true"
      data-phone-payments-scroll-root="true"
    >
      <div className={[styles.content, contentClassName].filter(Boolean).join(' ')}>
        {(title || subtitle || icon) && (
          <header className={styles.header}>
            {icon && <span className={styles.icon}>{icon}</span>}
            <div>
              {title && <h1>{title}</h1>}
              {subtitle && <p>{subtitle}</p>}
            </div>
          </header>
        )}

        <div className={styles.body}>
          {children}
        </div>
      </div>

      {footer && (
        <div className={styles.actions}>
          {summary && (
            <div className={styles.summary}>
              <span>
                {summary.label}
                {summary.detail && <small>{summary.detail}</small>}
              </span>
              <strong>{summary.amount}</strong>
            </div>
          )}
          {footer}
        </div>
      )}
    </div>
  </section>
)
