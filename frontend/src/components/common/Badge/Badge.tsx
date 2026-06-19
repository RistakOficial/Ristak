import React from 'react'
import { cn } from '@/utils/cn'
import styles from './Badge.module.css'

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'purple' | 'neutral' | 'primary'

interface BadgeProps {
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
    <span
      className={cn(styles.badge, variantClass, className)}
      data-badge
      data-tone={variant}
    >
      {children}
    </span>
  )
}
