import React from 'react'
import styles from './AppStartupLoader.module.css'

interface AppStartupLoaderProps {
  message?: string
  compact?: boolean
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')

const SkeletonBlock: React.FC<{ className?: string }> = ({ className }) => (
  <span className={cx(styles.skeletonBlock, className)} aria-hidden="true" />
)

export const AppStartupLoader: React.FC<AppStartupLoaderProps> = ({
  message = 'Cargando Ristak',
  compact = false
}) => {
  if (compact) {
    return (
      <div className={styles.compactShell} role="status" aria-live="polite" aria-label={message}>
        <div className={styles.compactInner}>
          <div className={styles.brandMark} aria-hidden="true">R</div>
          <p>{message}</p>
          <div className={styles.compactTrack} aria-hidden="true">
            <span />
          </div>
        </div>
      </div>
    )
  }

  return (
    <main className={styles.screen} role="status" aria-live="polite" aria-label={message}>
      <aside className={styles.rail} aria-hidden="true">
        <div className={styles.brandMark}>R</div>
        <div className={styles.navStack}>
          {Array.from({ length: 7 }).map((_, index) => (
            <span key={index} />
          ))}
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header} aria-hidden="true">
          <div>
            <SkeletonBlock className={styles.headerTitle} />
            <SkeletonBlock className={styles.headerSubtitle} />
          </div>
          <SkeletonBlock className={styles.headerAction} />
        </header>

        <div className={styles.content}>
          <div className={styles.statusLine}>
            <div className={styles.brandPulse} aria-hidden="true" />
            <p>{message}</p>
          </div>

          <div className={styles.kpiGrid} aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className={styles.kpiItem} key={index}>
                <SkeletonBlock className={styles.kpiLabel} />
                <SkeletonBlock className={styles.kpiValue} />
                <SkeletonBlock className={styles.kpiMeta} />
              </div>
            ))}
          </div>

          <div className={styles.panelGrid} aria-hidden="true">
            <div className={styles.panelLarge}>
              <SkeletonBlock className={styles.panelTitle} />
              <SkeletonBlock className={styles.panelSubtitle} />
              <div className={styles.chartSkeleton}>
                {Array.from({ length: 6 }).map((_, index) => (
                  <span key={index} />
                ))}
              </div>
            </div>
            <div className={styles.panelList}>
              <SkeletonBlock className={styles.panelTitleShort} />
              {Array.from({ length: 5 }).map((_, index) => (
                <div className={styles.listRow} key={index}>
                  <span />
                  <SkeletonBlock />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
