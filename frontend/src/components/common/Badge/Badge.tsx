import React from 'react'
import styles from './Badge.module.css'

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'purple' | 'neutral' | 'primary'

export interface BadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  className?: string
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  className
}) => {
  const variantClass = styles[variant] || styles.default

  return (
    <span className={`${styles.badge} ${variantClass} ${className || ''}`}>
      {children}
    </span>
  )
}
