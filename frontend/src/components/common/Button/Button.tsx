import React from 'react'
import { cn } from '@/utils/cn'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg' | 'small' | 'medium' | 'large'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  iconOnly?: boolean
  loading?: boolean
  leftIcon?: React.ReactNode
  children?: React.ReactNode
}

const variantMap: Record<ButtonVariant, 'primary' | 'secondary' | 'ghost' | 'danger'> = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'danger',
  outline: 'secondary'
}

const smallSizes: ButtonSize[] = ['sm', 'small']

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  iconOnly = false,
  loading = false,
  disabled = false,
  leftIcon,
  children,
  className = '',
  ...props
}, ref) => {
  const isDisabled = disabled || loading
  return (
    <button
      ref={ref}
      data-btn=""
      data-v={variantMap[variant]}
      data-size={smallSizes.includes(size) ? 'sm' : undefined}
      data-icon-only={iconOnly ? 'true' : undefined}
      data-disabled={isDisabled ? 'true' : undefined}
      className={cn('relative', fullWidth ? 'w-full' : '', className)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="invisible inline-flex items-center gap-2">
            {leftIcon}
            {children}
          </span>
          <span className="absolute inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
        </>
      ) : (
        <>
          {leftIcon}
          {children}
        </>
      )}
    </button>
  )
})

Button.displayName = 'Button'
