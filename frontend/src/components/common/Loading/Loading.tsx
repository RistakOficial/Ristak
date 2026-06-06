import React from 'react'
import { Loader2 } from 'lucide-react'
import styles from './Loading.module.css'

type LoadingPage =
  | 'dashboard'
  | 'contacts'
  | 'appointments'
  | 'reports'
  | 'analytics'
  | 'campaigns'
  | 'transactions'
  | 'settings'
  | 'calendar-settings'

interface LoadingProps {
  message?: string
  fullScreen?: boolean
  size?: 'sm' | 'md' | 'lg'
  variant?: 'skeleton' | 'spinner'
  page?: LoadingPage
  kpiLayout?: 'cards' | 'joined'
  kpiCount?: number
}

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')

const block = (className?: string, style?: React.CSSProperties) => (
  <div className={cx(styles.skeletonBlock, className)} style={style} />
)

const icon = (className?: string) => <div className={cx(styles.skeletonIcon, className)} />

const renderHeader = ({
  subtitle = true,
  actions = 1,
  compact = false
}: {
  subtitle?: boolean
  actions?: number
  compact?: boolean
} = {}) => (
  <div className={cx(styles.skeletonHeader, compact && styles.skeletonHeaderCompact)}>
    <div className={styles.skeletonTitleGroup}>
      {block(styles.skeletonTitle)}
      {subtitle && block(styles.skeletonSubtitle)}
    </div>
    {actions > 0 && (
      <div className={styles.skeletonHeaderActions}>
        {Array.from({ length: actions }).map((_, index) => (
          <div className={cx(styles.skeletonBlock, index === 0 ? styles.skeletonControl : styles.skeletonControlSmall)} key={`header-action-${index}`} />
        ))}
      </div>
    )}
  </div>
)

const renderToolbar = ({
  left = 2,
  right = 1,
  tabs = 0
}: {
  left?: number
  right?: number
  tabs?: number
} = {}) => (
  <div className={styles.skeletonToolbar}>
    <div className={styles.skeletonToolbarGroup}>
      {Array.from({ length: left }).map((_, index) => (
        <div className={cx(styles.skeletonBlock, index === 0 ? styles.skeletonToolbarControlWide : styles.skeletonToolbarControl)} key={`toolbar-left-${index}`} />
      ))}
      {tabs > 0 && (
        <div className={styles.skeletonTabGroup}>
          {Array.from({ length: tabs }).map((_, index) => (
            <div className={`${styles.skeletonBlock} ${styles.skeletonTab}`} key={`toolbar-tab-${index}`} />
          ))}
        </div>
      )}
    </div>
    {right > 0 && (
      <div className={styles.skeletonToolbarGroup}>
        {Array.from({ length: right }).map((_, index) => (
          <div className={`${styles.skeletonBlock} ${styles.skeletonToolbarButton}`} key={`toolbar-right-${index}`} />
        ))}
      </div>
    )}
  </div>
)

const renderKpiCards = (count: number, layout: 'cards' | 'joined' = 'cards') => {
  const normalizedKpiCount = Math.max(0, Math.floor(count))
  if (normalizedKpiCount === 0) return null

  const gridClassName = cx(
    styles.skeletonKpiGrid,
    layout === 'joined' && styles.skeletonKpiGridJoined
  )

  return (
    <div className={gridClassName} data-kpi-count={normalizedKpiCount}>
      {Array.from({ length: normalizedKpiCount }).map((_, index) => (
        <div className={styles.skeletonCard} key={`kpi-${index}`}>
          <div className={styles.skeletonCardTop}>
            {block(styles.skeletonLabel)}
            {icon()}
          </div>
          {block(styles.skeletonValue)}
          {block(styles.skeletonMeta)}
        </div>
      ))}
    </div>
  )
}

const renderChartPanel = ({
  compact = false,
  withLegend = true,
  withSelector = true
}: {
  compact?: boolean
  withLegend?: boolean
  withSelector?: boolean
} = {}) => (
  <div className={styles.skeletonPanel}>
    <div className={styles.skeletonPanelHeader}>
      <div>
        {block(styles.skeletonPanelTitle)}
        {block(styles.skeletonPanelSubtitle)}
      </div>
      {(withLegend || withSelector) && (
        <div className={styles.skeletonSegmentGroup}>
          {withLegend && (
            <>
              <div className={`${styles.skeletonBlock} ${styles.skeletonLegendItem}`} />
              <div className={`${styles.skeletonBlock} ${styles.skeletonLegendItem}`} />
            </>
          )}
          {withSelector && <div className={`${styles.skeletonBlock} ${styles.skeletonSegment}`} />}
        </div>
      )}
    </div>
    <div className={cx(styles.skeletonChart, compact && styles.skeletonChartCompact)} />
  </div>
)

const renderTableSkeleton = ({
  columns = 5,
  rows = 8,
  filters = 1,
  actions = 1
}: {
  columns?: number
  rows?: number
  filters?: number
  actions?: number
} = {}) => {
  const columnCount = Math.max(columns, 1)
  const rowCount = Math.max(rows, 1)
  const tableStyle = {
    '--skeleton-table-columns': columnCount,
    minWidth: `${columnCount * 132}px`
  } as React.CSSProperties

  return (
    <div className={styles.skeletonTableCard}>
      <div className={styles.skeletonTableToolbar}>
        <div className={styles.skeletonToolbarGroup}>
          {block(styles.skeletonSearch)}
          {Array.from({ length: filters }).map((_, index) => (
            <div className={`${styles.skeletonBlock} ${styles.skeletonFilterChip}`} key={`table-filter-${index}`} />
          ))}
        </div>
        {actions > 0 && (
          <div className={styles.skeletonToolbarGroup}>
            {Array.from({ length: actions }).map((_, index) => (
              <div className={`${styles.skeletonBlock} ${styles.skeletonTableAction}`} key={`table-action-${index}`} />
            ))}
          </div>
        )}
      </div>
      <div className={styles.skeletonDataTableWrapper}>
        <div className={styles.skeletonDataTable} style={tableStyle}>
          <div className={`${styles.skeletonDataRow} ${styles.skeletonDataHeaderRow}`}>
            {Array.from({ length: columnCount }).map((_, index) => (
              <div className={`${styles.skeletonBlock} ${styles.skeletonDataHeaderCell}`} key={`table-heading-${index}`} />
            ))}
          </div>
          {Array.from({ length: rowCount }).map((_, rowIndex) => (
            <div className={styles.skeletonDataRow} key={`table-row-${rowIndex}`}>
              {Array.from({ length: columnCount }).map((_, cellIndex) => (
                <div
                  className={cx(
                    styles.skeletonBlock,
                    styles.skeletonDataCell,
                    cellIndex === 0 && styles.skeletonDataCellWide
                  )}
                  key={`table-cell-${rowIndex}-${cellIndex}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const renderListPanel = (rows = 5) => (
  <div className={styles.skeletonPanel}>
    {block(styles.skeletonPanelTitle)}
    <div className={styles.skeletonList}>
      {Array.from({ length: rows }).map((_, index) => (
        <div className={styles.skeletonListItem} key={`list-${index}`}>
          <div className={styles.skeletonDot} />
          {block(styles.skeletonListLine)}
          {block(styles.skeletonListValue)}
        </div>
      ))}
    </div>
  </div>
)

const renderInsightCards = (count = 4) => (
  <div className={styles.skeletonInsightGrid}>
    {Array.from({ length: count }).map((_, cardIndex) => (
      <div className={styles.skeletonPanel} key={`insight-card-${cardIndex}`}>
        <div className={styles.skeletonInsightHeader}>
          {block(styles.skeletonInsightTitle)}
        </div>
        <div className={styles.skeletonInsightBody}>
          {Array.from({ length: 4 }).map((_, rowIndex) => (
            <div className={styles.skeletonProgressRow} key={`insight-row-${cardIndex}-${rowIndex}`}>
              <div className={styles.skeletonProgressMeta}>
                <div className={styles.skeletonDot} />
                {block(styles.skeletonProgressLabel)}
                {block(styles.skeletonProgressValue)}
              </div>
              {block(styles.skeletonProgressTrack)}
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
)

const renderCalendarSkeleton = () => (
  <div className={cx(styles.skeletonPanel, styles.skeletonCalendarCard)}>
    <div className={styles.skeletonCalendarToolbar}>
      <div className={styles.skeletonToolbarGroup}>
        <div className={`${styles.skeletonBlock} ${styles.skeletonPrimaryButton}`} />
        <div className={styles.skeletonTabGroup}>
          {Array.from({ length: 3 }).map((_, index) => (
            <div className={`${styles.skeletonBlock} ${styles.skeletonTab}`} key={`calendar-tab-${index}`} />
          ))}
        </div>
      </div>
      <div className={styles.skeletonCalendarNav}>
        {block(styles.skeletonNavButton)}
        {block(styles.skeletonNavIcon)}
        {block(styles.skeletonDateSelect)}
        {block(styles.skeletonDateSelectSmall)}
        {block(styles.skeletonNavIcon)}
      </div>
    </div>

    <div className={styles.skeletonCalendarDays}>
      {Array.from({ length: 7 }).map((_, index) => (
        <div className={`${styles.skeletonBlock} ${styles.skeletonDayName}`} key={`calendar-day-${index}`} />
      ))}
    </div>
    <div className={styles.skeletonCalendarGrid}>
      {Array.from({ length: 35 }).map((_, cellIndex) => (
        <div className={styles.skeletonCalendarCell} key={`calendar-cell-${cellIndex}`}>
          {block(styles.skeletonDayNumber)}
          {cellIndex % 3 !== 0 && block(styles.skeletonCalendarEvent)}
          {cellIndex % 5 === 0 && block(styles.skeletonCalendarEventShort)}
        </div>
      ))}
    </div>
  </div>
)

const renderSettingsCalendarSkeleton = () => (
  <div className={cx(styles.skeletonPanel, styles.skeletonSettingsCard)}>
    <div className={styles.skeletonSettingsHeader}>
      <div className={styles.skeletonSettingsTitleRow}>
        <div className={styles.skeletonSettingsIcon}>{icon()}</div>
        <div className={styles.skeletonTitleGroup}>
          {block(styles.skeletonPanelTitle)}
          {block(styles.skeletonPanelSubtitle)}
        </div>
      </div>
      {block(styles.skeletonStatusPill)}
    </div>

    <div className={styles.skeletonSettingsSection}>
      {block(styles.skeletonSectionTitle)}
      {block(styles.skeletonSectionText)}
      {block(styles.skeletonSelect)}
      {block(styles.skeletonHint)}
    </div>

    <div className={styles.skeletonSettingsSection}>
      {block(styles.skeletonSectionTitle)}
      {block(styles.skeletonSectionText)}
      <div className={styles.skeletonSettingsList}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div className={styles.skeletonSettingsRow} key={`settings-calendar-${index}`}>
            <div className={styles.skeletonTitleGroup}>
              {block(styles.skeletonSettingsRowTitle)}
              {block(styles.skeletonSettingsRowMeta)}
            </div>
            {block(styles.skeletonSettingsButton)}
          </div>
        ))}
      </div>
    </div>

    <div className={styles.skeletonSettingsSection}>
      {block(styles.skeletonSectionTitle)}
      {block(styles.skeletonSectionText)}
      <div className={styles.skeletonInfoBox}>
        {icon(styles.skeletonInfoIcon)}
        <div className={styles.skeletonTitleGroup}>
          {block(styles.skeletonInfoTitle)}
          {block(styles.skeletonInfoLine)}
          {block(styles.skeletonInfoLineShort)}
        </div>
      </div>
      <div className={styles.skeletonSettingsList}>
        {Array.from({ length: 3 }).map((_, index) => (
          <div className={styles.skeletonCheckboxRow} key={`settings-checkbox-${index}`}>
            <div className={styles.skeletonCheckbox} />
            {block(styles.skeletonCheckboxLabel)}
          </div>
        ))}
      </div>
    </div>
  </div>
)

const renderDashboardSkeleton = (kpiCount: number, kpiLayout: 'cards' | 'joined') => (
  <>
    {renderHeader({ actions: 1 })}
    {renderKpiCards(kpiCount, kpiLayout)}
    {renderChartPanel()}
    <div className={styles.skeletonContentGrid}>
      {renderListPanel(5)}
      {renderTableSkeleton({ columns: 3, rows: 6, filters: 0, actions: 0 })}
    </div>
  </>
)

const renderContactsSkeleton = () => (
  <>
    {renderHeader({ actions: 0 })}
    {renderToolbar({ left: 1, tabs: 2, right: 0 })}
    {renderKpiCards(4)}
    {renderTableSkeleton({ columns: 6, rows: 8, filters: 2, actions: 1 })}
  </>
)

const renderTransactionsSkeleton = () => (
  <>
    {renderHeader({ actions: 0 })}
    {renderToolbar({ left: 1, tabs: 2, right: 2 })}
    {renderKpiCards(4)}
    {renderTableSkeleton({ columns: 7, rows: 8, filters: 2, actions: 1 })}
  </>
)

const renderCampaignsSkeleton = () => (
  <>
    {renderHeader({ subtitle: false, actions: 2 })}
    {renderKpiCards(5)}
    {renderChartPanel({ withLegend: true, withSelector: true })}
    {renderTableSkeleton({ columns: 8, rows: 9, filters: 0, actions: 1 })}
  </>
)

const renderReportsSkeleton = () => (
  <>
    {renderHeader({ subtitle: false, actions: 0 })}
    {renderToolbar({ left: 2, tabs: 6, right: 0 })}
    {renderKpiCards(4)}
    {renderTableSkeleton({ columns: 8, rows: 10, filters: 0, actions: 1 })}
  </>
)

const renderAnalyticsSkeleton = () => (
  <>
    {renderHeader({ subtitle: false, actions: 0 })}
    {renderToolbar({ left: 2, tabs: 3, right: 0 })}
    {renderKpiCards(4)}
    {renderChartPanel({ withLegend: true, withSelector: true })}
    <div className={styles.skeletonTwoColumnGrid}>
      {renderChartPanel({ compact: true, withLegend: true, withSelector: true })}
      {renderListPanel(5)}
    </div>
    {renderInsightCards(6)}
    {renderTableSkeleton({ columns: 6, rows: 6, filters: 0, actions: 1 })}
  </>
)

const renderAppointmentsSkeleton = () => (
  <>
    {renderHeader({ subtitle: false, actions: 3 })}
    {renderKpiCards(4)}
    {renderCalendarSkeleton()}
  </>
)

const renderPageSkeleton = (page: LoadingPage, kpiCount: number, kpiLayout: 'cards' | 'joined', message: string) => {
  const isWide = page === 'reports'
  const content = {
    dashboard: renderDashboardSkeleton(kpiCount, kpiLayout),
    contacts: renderContactsSkeleton(),
    appointments: renderAppointmentsSkeleton(),
    reports: renderReportsSkeleton(),
    analytics: renderAnalyticsSkeleton(),
    campaigns: renderCampaignsSkeleton(),
    transactions: renderTransactionsSkeleton(),
    settings: renderSettingsCalendarSkeleton(),
    'calendar-settings': renderSettingsCalendarSkeleton()
  }[page]

  return (
    <div className={styles.skeletonPage} role="status" aria-live="polite" aria-label={message}>
      <div className={cx(styles.skeletonInner, isWide && styles.skeletonInnerWide)}>
        {content}
      </div>
    </div>
  )
}

export const Loading: React.FC<LoadingProps> = ({
  message = 'Cargando',
  fullScreen = false,
  size = 'md',
  variant = 'skeleton',
  page = 'dashboard',
  kpiLayout = 'joined',
  kpiCount = 4
}) => {
  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-10 h-10',
    lg: 'w-12 h-12'
  }

  const shouldRenderSpinner = fullScreen || variant === 'spinner'
  const containerClass = fullScreen ? styles.fullScreenContainer : styles.container

  if (!shouldRenderSpinner) {
    return renderPageSkeleton(page, kpiCount, kpiLayout, message)
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
