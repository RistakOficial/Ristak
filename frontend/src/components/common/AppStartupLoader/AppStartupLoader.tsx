import React from 'react'
import styles from './AppStartupLoader.module.css'

interface AppStartupLoaderProps {
  message?: string
  compact?: boolean
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')

const SkeletonBlock: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <span className={cx(styles.skeletonBlock, className)} style={style} aria-hidden="true" />
)

const navRows = [
  { width: styles.navLabelShort },
  { width: styles.navLabelMedium, active: true },
  { width: styles.navLabelShort },
  { width: styles.navLabelTiny },
  { divider: true },
  { width: styles.navLabelShort },
  { width: styles.navLabelMedium },
  { divider: true },
  { width: styles.navLabelMedium },
  { width: styles.navLabelShort }
]

const chartBars = [34, 34, 34, 34, 34, 34, 34, 78, 72, 61]
const conversionRows = [92, 68, 54, 42]
const operationRows = [76, 62, 70]

export const AppStartupLoader: React.FC<AppStartupLoaderProps> = ({
  message = 'Cargando Ristak',
  compact = false
}) => {
  if (compact) {
    return (
      <div className={styles.compactShell} role="status" aria-live="polite" aria-label={message}>
        <span className={styles.compactSpinner} aria-hidden="true" />
      </div>
    )
  }

  return (
    <main data-ristak-layout className={styles.screen} role="status" aria-live="polite" aria-label={message}>
      <aside data-ristak-layout-sidebar className={styles.rail} aria-hidden="true">
        <div data-ristak-sidebar className={styles.sidebarShell}>
          <div data-ristak-sidebar-header className={styles.accountHeader}>
            <span className={styles.accountAvatar} />
            <SkeletonBlock className={styles.accountName} />
            <span className={styles.accountChevron} />
          </div>

          <nav className={styles.navStack}>
            {navRows.map((item, index) => (
              item.divider ? (
                <span className={styles.navDivider} key={`nav-divider-${index}`} />
              ) : (
                <span
                  data-ristak-sidebar-nav-item
                  data-active={item.active ? 'true' : undefined}
                  className={cx(styles.navRow, item.active && styles.navRowActive)}
                  key={`nav-row-${index}`}
                >
                  <span className={styles.navIcon} />
                  <SkeletonBlock className={item.width} />
                </span>
              )
            ))}
          </nav>
        </div>
      </aside>

      <section className={styles.workspace}>
        <header data-ristak-header className={styles.header} aria-hidden="true">
          <div className={styles.searchShell}>
            <span className={styles.searchIcon} />
            <SkeletonBlock className={styles.searchText} />
          </div>
          <div className={styles.headerActions}>
            <span className={styles.headerActionIcon} />
            <span className={styles.headerNotification}>
              <span />
            </span>
          </div>
        </header>

        <div data-ristak-page className={styles.page}>
          <div data-ristak-page-inner className={styles.pageInner}>
            <div data-ristak-dashboard className={styles.dashboardFlow} aria-hidden="true">
              <div data-dashboard-topbar data-dashboard-heading className={styles.pageHeader}>
                <div className={styles.pageTitleGroup}>
                  <SkeletonBlock className={styles.pageTitle} />
                  <SkeletonBlock className={styles.pageSubtitle} />
                </div>
                <SkeletonBlock className={styles.dateRangeControl} />
              </div>

              <div data-dashboard-kpi-grid className={styles.kpiGrid}>
                {Array.from({ length: 8 }).map((_, index) => (
                  <div data-ristak-kpi-card className={styles.kpiItem} key={`kpi-${index}`}>
                    <div className={styles.kpiTopLine}>
                      <SkeletonBlock className={styles.kpiLabel} />
                      <span className={styles.kpiIcon} />
                    </div>
                    <SkeletonBlock className={styles.kpiValue} />
                    <SkeletonBlock className={styles.kpiMeta} />
                  </div>
                ))}
              </div>

              <div data-ristak-card data-dashboard-chart-card className={styles.chartCard}>
                <div className={styles.chartHeader}>
                  <div className={styles.chartTitleRow}>
                    <SkeletonBlock className={styles.chartTitle} />
                    <SkeletonBlock className={styles.chartSelect} />
                    <SkeletonBlock className={styles.chartSelectWide} />
                    <div className={styles.legendGroup}>
                      <span><i /> <SkeletonBlock /></span>
                      <span><i /> <SkeletonBlock /></span>
                    </div>
                  </div>
                  <div className={styles.scopeTabs}>
                    <SkeletonBlock />
                    <SkeletonBlock />
                    <SkeletonBlock />
                  </div>
                </div>

                <div className={styles.chartCanvas}>
                  {chartBars.map((height, index) => (
                    <span
                      className={index >= 7 ? styles.chartBarTall : undefined}
                      style={{ height: `${height}%` }}
                      key={`chart-bar-${index}`}
                    />
                  ))}
                </div>
              </div>

              <div className={styles.panelGrid}>
                <div data-ristak-card className={styles.conversionPanel}>
                  <div className={styles.panelTop}>
                    <SkeletonBlock className={styles.panelTitle} />
                    <div className={styles.scopeTabs}>
                      <SkeletonBlock />
                      <SkeletonBlock />
                      <SkeletonBlock />
                    </div>
                  </div>
                  <div className={styles.conversionRows}>
                    {conversionRows.map((width, index) => (
                      <div className={styles.conversionRow} key={`conversion-${index}`}>
                        <span className={styles.conversionIcon} />
                        <div>
                          <div className={styles.conversionMeta}>
                            <SkeletonBlock className={styles.conversionLabel} />
                            <SkeletonBlock className={styles.conversionValue} />
                          </div>
                          <span style={{ width: `${width}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div data-ristak-card className={styles.originPanel}>
                  <SkeletonBlock className={styles.panelTitleShort} />
                  <div className={styles.originNumberGroup}>
                    <SkeletonBlock className={styles.originNumber} />
                    <SkeletonBlock className={styles.originMeta} />
                  </div>
                  <div className={styles.originBody}>
                    <div className={styles.originDonut} />
                    <div className={styles.originLegend}>
                      {Array.from({ length: 4 }).map((_, index) => (
                        <span key={`origin-${index}`}>
                          <i />
                          <SkeletonBlock />
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <section data-dashboard-operations className={styles.operationsGrid}>
                {Array.from({ length: 3 }).map((_, cardIndex) => (
                  <div data-ristak-card className={styles.operationCard} key={`operation-${cardIndex}`}>
                    <div className={styles.operationHeader}>
                      <div>
                        <SkeletonBlock className={styles.operationEyebrow} />
                        <SkeletonBlock className={styles.operationTitle} />
                        <SkeletonBlock className={styles.operationSubtitle} />
                      </div>
                      <SkeletonBlock className={styles.operationLink} />
                    </div>
                    <div className={styles.operationList}>
                      {operationRows.map((width, rowIndex) => (
                        <div className={styles.operationRow} key={`operation-${cardIndex}-${rowIndex}`}>
                          <div>
                            <SkeletonBlock className={styles.operationRowTitle} />
                            <SkeletonBlock className={styles.operationRowMeta} />
                          </div>
                          <SkeletonBlock className={styles.operationPill} style={{ width: `${width}px` } as React.CSSProperties} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
