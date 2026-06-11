import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './PhoneButton.module.css'

interface PhoneButtonProps {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'md' | 'lg'
  type?: 'button' | 'submit'
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  icon?: React.ReactNode
  className?: string
  ariaLabel?: string
  onClick?: () => void
  children?: React.ReactNode
}

/** Botón estándar de la app móvil (pastilla, mismo acento que el resto del celular). */
export const PhoneButton: React.FC<PhoneButtonProps> = ({
  variant = 'primary',
  size = 'md',
  type = 'button',
  loading = false,
  disabled = false,
  fullWidth = false,
  icon,
  className = '',
  ariaLabel,
  onClick,
  children
}) => (
  <button
    type={type}
    className={[
      styles.button,
      styles[variant],
      size === 'lg' ? styles.lg : '',
      fullWidth ? styles.fullWidth : '',
      className
    ].filter(Boolean).join(' ')}
    disabled={disabled || loading}
    aria-label={ariaLabel}
    aria-busy={loading || undefined}
    onClick={onClick}
  >
    {loading ? <Loader2 size={17} className={styles.spin} /> : icon}
    {children}
  </button>
)
