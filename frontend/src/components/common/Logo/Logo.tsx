import React from 'react'
import { useTheme } from '@/contexts/ThemeContext'

interface LogoProps {
  className?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
}

const sizeClasses: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'w-10 h-10',
  md: 'w-14 h-14',
  lg: 'w-20 h-20',
  xl: 'w-24 h-24',
  '2xl': 'w-24 h-10'
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 'md' }) => {
  const { theme } = useTheme()

  return (
    <div className={`${sizeClasses[size]} ${className}`}>
      <img
        src="/logo.svg?v=2"
        alt="Ristak"
        className="w-full h-full object-contain"
        style={theme === 'dark' ? { filter: 'invert(1)' } : undefined}
      />
    </div>
  )
}
