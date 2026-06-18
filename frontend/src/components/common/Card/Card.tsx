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
  xs: 'p-[var(--app-card-padding-xs,0.75rem)]',
  sm: 'p-[var(--app-card-padding-sm,1rem)]',
  md: 'p-[var(--app-card-padding-md,1.25rem)]',
  lg: 'p-[var(--app-card-padding-lg,1.5rem)]'
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
