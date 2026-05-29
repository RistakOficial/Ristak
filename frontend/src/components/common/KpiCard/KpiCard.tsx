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
}

export const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  delta,
  deltaLabel,
  icon,
  iconColorClassName = 'text-[var(--color-text-tertiary)]',
  className
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
    >
      <div
        data-ristak-kpi-content
        className="flex min-h-[calc(var(--design-kpi-min-height,112px)-2rem)] items-center justify-between gap-3"
      >
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-sm text-[var(--color-text-tertiary)]">
            {title}
          </p>
          <p className="mb-1 text-2xl font-bold text-[var(--color-text-primary)] truncate">
            {value}
          </p>
          {formattedDelta && (
            <div className={cn('flex items-center gap-2 text-xs', trendColor)}>
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
