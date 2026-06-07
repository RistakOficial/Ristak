import React from 'react'
import { cn } from '@/utils/cn'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg' | 'small' | 'medium' | 'large'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  loading?: boolean
  leftIcon?: React.ReactNode
  children: React.ReactNode
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-text-primary)] text-[var(--color-background-primary)] border border-[rgba(148,163,184,0.24)] dark:shadow-[0_14px_32px_-20px_rgba(15,23,42,0.6)] hover:bg-[color-mix(in_srgb,var(--color-text-primary) 90%,var(--color-background-primary) 10%)]',
  secondary:
    'bg-[var(--design-control-bg)] text-[var(--color-text-primary)] border border-[var(--design-control-border)] shadow-none hover:bg-[var(--design-control-bg-hover)] hover:border-[var(--design-control-border-hover)]',
  ghost:
    'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[rgba(148,163,184,0.08)]',
  danger:
    'bg-[var(--color-status-error)] text-white dark:shadow-[0_10px_28px_-16px_rgba(220,38,38,0.55)] hover:bg-[color-mix(in_srgb,var(--color-status-error) 90%,#000 10%)]',
  outline:
    'border border-[var(--design-control-border)] bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--design-control-bg-hover)] hover:border-[var(--design-control-border-hover)]'
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
  small: 'h-9 px-3 text-sm',
  medium: 'h-10 px-4 text-sm',
  large: 'h-11 px-5 text-base'
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  leftIcon,
  children,
  className = '',
  ...props
}) => {
  return (
    <button
      className={cn(
        'relative inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 focus:outline-none disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? 'w-full' : '',
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
          Cargando…
        </span>
      ) : (
        <>
          {leftIcon}
          {children}
        </>
      )}
    </button>
  )
}
