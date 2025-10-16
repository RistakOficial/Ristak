import React, { useRef, useEffect, useState } from 'react'
import { Tooltip as RechartsTooltip } from 'recharts'

interface SmartRechartsTooltipProps {
  content: React.ReactElement | ((props: any) => React.ReactNode)
  cursor?: boolean
  prefer?: string
  offset?: { x: number; y: number } | number
  portalToBody?: boolean
  allowEscapeViewBox?: { x?: boolean; y?: boolean }
  wrapperStyle?: React.CSSProperties
  [key: string]: any
}

const CustomTooltipWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Asegurar que el tooltip tiene las propiedades correctas para ser visible
    if (ref.current) {
      ref.current.style.pointerEvents = 'none'
      ref.current.style.visibility = 'visible'
      ref.current.style.zIndex = '1000'
    }
  }, [])

  return (
    <div
      ref={ref}
      className="rounded-lg border border-[rgba(148,163,184,0.14)] px-4 py-3 bg-[var(--color-background-secondary)] dark:shadow-[0_18px_35px_-25px_rgba(15,23,42,0.6)] shadow-lg"
      style={{
        pointerEvents: 'none',
        zIndex: 1000,
        visibility: 'visible'
      }}
    >
      {children}
    </div>
  )
}

export function SmartRechartsTooltip({
  content,
  cursor = false,
  wrapperStyle,
  ...rest
}: SmartRechartsTooltipProps) {
  return (
    <RechartsTooltip
      content={content}
      cursor={cursor}
      wrapperStyle={{
        outline: 'none',
        pointerEvents: 'none',
        ...wrapperStyle
      }}
      isAnimationActive={false}
      {...rest}
    />
  )
}

export default SmartRechartsTooltip
