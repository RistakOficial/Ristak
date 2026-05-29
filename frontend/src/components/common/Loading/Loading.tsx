import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './Loading.module.css'

interface LoadingProps {
  message?: string
  fullScreen?: boolean
  size?: 'sm' | 'md' | 'lg'
  variant?: 'skeleton' | 'spinner'
}

export const Loading: React.FC<LoadingProps> = ({
  message = 'Cargando',
  fullScreen = false,
  size = 'md',
  variant = 'skeleton'
}) => {
  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-10 h-10',
    lg: 'w-12 h-12'
  }

  const shouldRenderSpinner = fullScreen || variant === 'spinner'
  const containerClass = fullScreen ? styles.fullScreenContainer : styles.container

  if (!shouldRenderSpinner) {
    return (
      <div className={styles.skeletonPage} role="status" aria-live="polite" aria-label={message}>
        <div className={styles.skeletonInner}>
          <div className={styles.skeletonHeader}>
            <div className={styles.skeletonTitleGroup}>
              <div className={`${styles.skeletonBlock} ${styles.skeletonTitle}`} />
              <div className={`${styles.skeletonBlock} ${styles.skeletonSubtitle}`} />
            </div>
            <div className={`${styles.skeletonBlock} ${styles.skeletonControl}`} />
          </div>

          <div className={styles.skeletonKpiGrid}>
            {Array.from({ length: 8 }).map((_, index) => (
              <div className={styles.skeletonCard} key={`kpi-${index}`}>
                <div className={styles.skeletonCardTop}>
                  <div className={`${styles.skeletonBlock} ${styles.skeletonLabel}`} />
                  <div className={styles.skeletonIcon} />
                </div>
                <div className={`${styles.skeletonBlock} ${styles.skeletonValue}`} />
                <div className={`${styles.skeletonBlock} ${styles.skeletonMeta}`} />
              </div>
            ))}
          </div>

          <div className={styles.skeletonPanel}>
            <div className={styles.skeletonPanelHeader}>
              <div>
                <div className={`${styles.skeletonBlock} ${styles.skeletonPanelTitle}`} />
                <div className={`${styles.skeletonBlock} ${styles.skeletonPanelSubtitle}`} />
              </div>
              <div className={styles.skeletonSegmentGroup}>
                <div className={`${styles.skeletonBlock} ${styles.skeletonSegment}`} />
                <div className={`${styles.skeletonBlock} ${styles.skeletonSegment}`} />
                <div className={`${styles.skeletonBlock} ${styles.skeletonSegment}`} />
              </div>
            </div>
            <div className={styles.skeletonChart} />
          </div>

          <div className={styles.skeletonContentGrid}>
            <div className={styles.skeletonPanel}>
              <div className={`${styles.skeletonBlock} ${styles.skeletonPanelTitle}`} />
              <div className={styles.skeletonList}>
                {Array.from({ length: 5 }).map((_, index) => (
                  <div className={styles.skeletonListItem} key={`list-${index}`}>
                    <div className={styles.skeletonDot} />
                    <div className={`${styles.skeletonBlock} ${styles.skeletonListLine}`} />
                    <div className={`${styles.skeletonBlock} ${styles.skeletonListValue}`} />
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.skeletonPanel}>
              <div className={`${styles.skeletonBlock} ${styles.skeletonPanelTitle}`} />
              <div className={styles.skeletonTable}>
                {Array.from({ length: 6 }).map((_, index) => (
                  <div className={styles.skeletonTableRow} key={`row-${index}`}>
                    <div className={`${styles.skeletonBlock} ${styles.skeletonTableCellWide}`} />
                    <div className={`${styles.skeletonBlock} ${styles.skeletonTableCell}`} />
                    <div className={`${styles.skeletonBlock} ${styles.skeletonTableCell}`} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={containerClass} role="status" aria-live="polite">
      <div className={styles.loadingWrapper}>
        <Loader2 className={`${sizeClasses[size]} ${styles.spinner}`} />
        <p className={styles.message}>{message}</p>
      </div>
    </div>
  )
}
