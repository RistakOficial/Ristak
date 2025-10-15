import React from 'react'
import { cn } from '@/utils/cn'

interface PageContainerProps {
  children: React.ReactNode
  className?: string
}

export const PageContainer: React.FC<PageContainerProps> = ({ children, className }) => {
  return (
    <div className={cn('px-6 pt-14 pb-10 text-[var(--color-text-primary)]', className)}>
      <div className="mx-auto w-full max-w-7xl">{children}</div>
    </div>
  )
}
