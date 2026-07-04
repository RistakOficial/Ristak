import React from 'react'
import styles from './RistakAppMark.module.css'

type RistakAppMarkSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type RistakAppMarkVariant = 'auto' | 'blue' | 'white'

interface RistakAppMarkProps {
  className?: string
  decorative?: boolean
  size?: RistakAppMarkSize
  variant?: RistakAppMarkVariant
}

const sizeClasses: Record<RistakAppMarkSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
  xl: styles.xl,
  '2xl': styles.size2xl
}

const markSources = {
  blue: {
    src: '/ristak-app-mark-blue-384.webp',
    srcSet: '/ristak-app-mark-blue-192.webp 192w, /ristak-app-mark-blue-384.webp 384w, /ristak-app-mark-blue-768.webp 768w'
  },
  white: {
    src: '/ristak-app-mark-white-384.webp',
    srcSet: '/ristak-app-mark-white-192.webp 192w, /ristak-app-mark-white-384.webp 384w, /ristak-app-mark-white-768.webp 768w'
  }
}

export const RistakAppMark: React.FC<RistakAppMarkProps> = ({
  className = '',
  decorative = false,
  size = 'md',
  variant = 'auto'
}) => {
  const renderImage = (resolvedVariant: Exclude<RistakAppMarkVariant, 'auto'>, imageClassName = styles.image) => {
    const source = markSources[resolvedVariant]

    return (
      <img
        src={source.src}
        srcSet={source.srcSet}
        sizes="(max-width: 480px) 160px, 180px"
        alt={decorative ? '' : 'Ristak'}
        className={imageClassName}
        decoding="async"
        draggable={false}
      />
    )
  }

  return (
    <span
      className={`${styles.mark} ${sizeClasses[size]} ${variant === 'auto' ? styles.auto : ''} ${className}`}
      aria-hidden={decorative ? true : undefined}
    >
      {variant === 'auto' ? (
        <>
          {renderImage('blue', `${styles.image} ${styles.blueImage}`)}
          {renderImage('white', `${styles.image} ${styles.whiteImage}`)}
        </>
      ) : (
        renderImage(variant)
      )}
    </span>
  )
}
