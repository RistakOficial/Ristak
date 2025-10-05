import React from 'react'
import { cn } from '@/utils/cn'

type CardPadding = 'none' | 'xs' | 'sm' | 'md' | 'lg'
type CardVariant = 'default' | 'glass'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding
  variant?: CardVariant
}

const paddingClasses: Record<CardPadding, string> = {
  none: '',
  xs: 'p-3',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6'
}

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-[color-mix(in_srgb,var(--color-background-secondary) 92%, rgba(15,23,42,0.04))] border border-[rgba(148,163,184,0.18)] dark:shadow-[0_18px_45px_-28px_rgba(15,23,42,0.65)]',
  glass: 'glass border border-[rgba(148,163,184,0.18)] dark:shadow-[0_18px_45px_-28px_rgba(15,23,42,0.65)] backdrop-blur-xl'
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  padding = 'md',
  variant = 'default',
  onClick,
  ...props
}) => {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl transition-colors duration-300',
        variantClasses[variant],
        paddingClasses[padding],
        onClick ? 'cursor-pointer' : '',
        className
      )}
      onClick={onClick}
      {...props}
    >
      <div className="relative z-10">{children}</div>
    </div>
  )
}
