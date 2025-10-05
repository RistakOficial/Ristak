import React from 'react'
import { cn } from '@/utils/cn'

interface PageContainerProps {
  children: React.ReactNode
  className?: string
}

export const PageContainer: React.FC<PageContainerProps> = ({ children, className }) => {
  return (
    <div className={cn('px-4 py-6 text-[var(--color-text-primary)] sm:px-6 lg:px-8', className)}>
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </div>
  )
}
