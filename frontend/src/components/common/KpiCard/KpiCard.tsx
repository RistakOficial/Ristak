import React from 'react'
import { Card } from '@/components/common'
import { cn } from '@/utils/cn'

type IconProp = React.ReactNode | React.ElementType<{ className?: string }>

interface KpiCardProps {
  title: string
  value: string | number
  delta?: number
  deltaLabel?: string
  icon?: IconProp
  iconColorClassName?: string
  className?: string
  loading?: boolean
}

export const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  delta,
  deltaLabel,
  icon,
  iconColorClassName = 'text-[var(--color-text-tertiary)]',
  className,
  loading = false
}) => {
  const formattedDelta = delta !== undefined ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : null
  const trendColor = delta === undefined
    ? 'text-[var(--color-text-tertiary)]'
    : delta >= 0
      ? 'text-[var(--color-status-success)]'
      : 'text-[var(--color-status-error)]'

  const renderIcon = () => {
    if (!icon) return null

    if (React.isValidElement(icon)) {
      const iconElement = icon as React.ReactElement<{ className?: string }>
      const existingClassName = iconElement.props.className
      return React.cloneElement(iconElement, {
        className: cn(existingClassName ?? 'h-6 w-6')
      })
    }

    const IconComponent = icon as React.ElementType<{ className?: string }>
    return <IconComponent className="h-6 w-6" />
  }

  return (
    <Card
      data-ristak-kpi-card
      variant="glass"
      padding="sm"
      className={cn('flex h-full overflow-hidden', className)}
      aria-busy={loading || undefined}
    >
      <div
        data-ristak-kpi-content
        className="flex min-h-[var(--app-kpi-content-min-height,calc(var(--design-kpi-min-height,112px)-2rem))] items-center justify-between gap-[var(--app-kpi-gap,0.75rem)]"
      >
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[length:var(--app-kpi-title-size,0.875rem)] text-[var(--color-text-tertiary)]">
            {title}
          </p>
          <p className={cn(
            'mb-1 text-[length:var(--app-kpi-value-size,1.5rem)] font-bold text-[var(--color-text-primary)] truncate transition-opacity duration-150',
            loading && 'invisible'
          )}>
            {value}
          </p>
          {formattedDelta && (
            <div className={cn(
              'flex items-center gap-2 text-[length:var(--app-kpi-delta-size,0.75rem)] transition-opacity duration-150',
              trendColor,
              loading && 'invisible'
            )}>
              <span className="font-medium">{formattedDelta}</span>
              {deltaLabel && (
                <span className="text-[var(--color-text-tertiary)]">{deltaLabel}</span>
              )}
            </div>
          )}
        </div>
        {icon && (
          <div className={cn('flex-shrink-0', iconColorClassName)}>{renderIcon()}</div>
        )}
      </div>
    </Card>
  )
}
