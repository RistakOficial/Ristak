import React from 'react'
import { cn } from '@/utils/cn'

interface PageContainerProps {
  children: React.ReactNode
  className?: string
  size?: 'default' | 'wide'
}

export const PageContainer: React.FC<PageContainerProps> = ({ children, className, size = 'default' }) => {
  const innerClassName = size === 'wide'
    ? 'mx-auto w-full max-w-[88rem]'
    : 'mx-auto w-full max-w-6xl lg:max-w-7xl'

  return (
    <div data-ristak-page className={cn('px-6 pt-12 pb-16 text-[var(--color-text-primary)] md:px-10', className)}>
      <div data-ristak-page-inner className={innerClassName}>{children}</div>
    </div>
  )
}
