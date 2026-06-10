import React from 'react'
import { cn } from '@/utils/cn'
import styles from './PageHeader.module.css'

interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** Small uppercase label rendered above the title (e.g. "Sistema"). */
  eyebrow?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Right-aligned actions, typically <Button> elements. */
  actions?: React.ReactNode
  /** Heading level for the title. Defaults to h1. */
  as?: 'h1' | 'h2'
  className?: string
}

/**
 * Shared page header: eyebrow → title → subtitle on the left, actions on the
 * right, separated from the page body by a single subtle bottom border.
 * This is the canonical header treatment for desktop pages — flat, minimal,
 * token-driven so it adapts to every theme and design preset.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  eyebrow,
  title,
  subtitle,
  actions,
  as = 'h1',
  className,
  ...rest
}) => {
  const Title = as
  return (
    <header className={cn(styles.header, className)} data-ristak-page-header {...rest}>
      <div className={styles.heading}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <Title className={styles.title}>{title}</Title>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  )
}
