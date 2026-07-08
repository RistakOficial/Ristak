import React from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import styles from './Logo.module.css'

interface LogoProps {
  className?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  variant?: 'auto' | 'black' | 'white'
}

const sizeClasses: Record<NonNullable<LogoProps['size']>, string | undefined> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
  xl: styles.xl,
  '2xl': styles.size2xl
}

const logoSources = {
  black: {
    src: '/logo-web-black.webp'
  },
  white: {
    src: '/logo-web-white.webp'
  }
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 'md', variant = 'auto' }) => {
  const { theme } = useTheme()
  const resolvedVariant = variant === 'auto' ? (theme === 'dark' ? 'white' : 'black') : variant
  const source = logoSources[resolvedVariant]

  return (
    <span className={`${styles.logo} ${sizeClasses[size] || ''} ${className}`} aria-label="ristak">
      <img
        src={source.src}
        alt="ristak"
        className={styles.image}
        decoding="async"
      />
    </span>
  )
}
