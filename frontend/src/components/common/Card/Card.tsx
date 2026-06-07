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
  default: 'bg-[var(--design-panel-bg)] border border-[var(--design-panel-border)] shadow-none',
  glass: 'bg-[var(--design-panel-bg)] border border-[var(--design-panel-border)] shadow-none backdrop-blur-xl'
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  padding = 'lg',
  variant = 'default',
  onClick,
  ...props
}) => {
  return (
    <div
      data-ristak-card
      className={cn(
        'relative rounded-xl transition-colors duration-300',
        variantClasses[variant],
        paddingClasses[padding],
        onClick ? 'cursor-pointer' : '',
        className
      )}
      onClick={onClick}
      {...props}
    >
      <div data-ristak-card-content className="relative z-10 w-full">{children}</div>
    </div>
  )
}
