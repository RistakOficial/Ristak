import React from 'react'
import { cn } from '@/utils/cn'
import styles from './ChatMessageSurface.module.css'

export type ChatMessageSurfaceProps = React.HTMLAttributes<HTMLDivElement>

export const ChatMessageSurface = React.forwardRef<HTMLDivElement, ChatMessageSurfaceProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cn(styles.surface, className)} {...props}>
      {children}
    </div>
  )
)

ChatMessageSurface.displayName = 'ChatMessageSurface'

export default ChatMessageSurface
