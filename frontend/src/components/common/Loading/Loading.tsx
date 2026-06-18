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
  | 'settings-form'
  | 'settings-list'
  | 'calendar-settings'
  | 'sites'
  | 'automations'
  | 'chat'
  | 'ai-agent'
  | 'initialization'
  | 'api-docs'

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

const renderKpiCards = (
  count: number,
  layout: 'cards' | 'joined' = 'cards',
  options: { dashboard?: boolean } = {}
) => {
  const normalizedKpiCount = Math.max(0, Math.floor(count))
  if (normalizedKpiCount === 0) return null

  const gridClassName = cx(
    styles.skeletonKpiGrid,
    layout === 'joined' && styles.skeletonKpiGridJoined
  )

  return (
    <div
      className={gridClassName}
      data-dashboard-kpi-grid={options.dashboard ? true : undefined}
      data-kpi-count={normalizedKpiCount}
    >
      {Array.from({ length: normalizedKpiCount }).map((_, index) => (
        <div data-ristak-kpi-card className={styles.skeletonCard} key={`kpi-${index}`}>
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

const renderSettingsFormSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    <div className={styles.skeletonSettingsLayout}>
      <div className={styles.skeletonSettingsNav} aria-hidden="true">
        {Array.from({ length: 9 }).map((_, index) => (
          <div className={styles.skeletonSettingsNavItem} key={`settings-nav-${index}`}>
            {icon(styles.skeletonSettingsNavIcon)}
            {block(styles.skeletonSettingsNavLabel)}
          </div>
        ))}
      </div>
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
        {Array.from({ length: 3 }).map((_, sectionIndex) => (
          <div className={styles.skeletonSettingsSection} key={`settings-form-section-${sectionIndex}`}>
            {block(styles.skeletonSectionTitle)}
            {block(styles.skeletonSectionText)}
            <div className={styles.skeletonFieldGrid}>
              {Array.from({ length: sectionIndex === 0 ? 4 : 3 }).map((__, fieldIndex) => (
                <div className={styles.skeletonField} key={`settings-field-${sectionIndex}-${fieldIndex}`}>
                  {block(styles.skeletonFieldLabel)}
                  {block(styles.skeletonSelect)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  </>
)

const renderSettingsListSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    <div className={cx(styles.skeletonPanel, styles.skeletonSettingsCard)}>
      <div className={styles.skeletonSettingsHeader}>
        <div className={styles.skeletonSettingsTitleRow}>
          <div className={styles.skeletonSettingsIcon}>{icon()}</div>
          <div className={styles.skeletonTitleGroup}>
            {block(styles.skeletonPanelTitle)}
            {block(styles.skeletonPanelSubtitle)}
          </div>
        </div>
        {block(styles.skeletonSettingsButton)}
      </div>
      <div className={styles.skeletonSettingsSection}>
        {block(styles.skeletonSearch)}
      </div>
      <div className={styles.skeletonSettingsListFlush}>
        {Array.from({ length: 7 }).map((_, index) => (
          <div className={styles.skeletonSettingsRow} key={`settings-list-${index}`}>
            <div className={styles.skeletonTitleGroup}>
              {block(styles.skeletonSettingsRowTitle)}
              {block(styles.skeletonSettingsRowMeta)}
            </div>
            {block(index % 2 === 0 ? styles.skeletonStatusPill : styles.skeletonSettingsButton)}
          </div>
        ))}
      </div>
    </div>
  </>
)

const renderDashboardChartPanel = () => (
  <div data-ristak-card data-dashboard-chart-card className={cx(styles.skeletonPanel, styles.skeletonDashboardChartCard)}>
    <div className={styles.skeletonDashboardChartHeader}>
      <div className={styles.skeletonDashboardChartToolbar}>
        {block(styles.skeletonDashboardChartTitle)}
        {block(styles.skeletonDashboardChartSelect)}
        {block(styles.skeletonDashboardChartSelectWide)}
        <div className={styles.skeletonDashboardLegend}>
          {Array.from({ length: 2 }).map((_, index) => (
            <span key={`dashboard-legend-${index}`}>
              <i />
              {block(styles.skeletonDashboardLegendLabel)}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.skeletonDashboardScopeTabs}>
        {Array.from({ length: 3 }).map((_, index) => (
          <div className={cx(styles.skeletonBlock, styles.skeletonDashboardScopeTab)} key={`dashboard-chart-scope-${index}`} />
        ))}
      </div>
    </div>
    <div className={styles.skeletonDashboardChartCanvas}>
      {[34, 34, 34, 34, 34, 34, 34, 78, 72, 61, 54, 46].map((height, index) => (
        <span style={{ height: `${height}%` }} key={`dashboard-chart-canvas-${index}`} />
      ))}
    </div>
  </div>
)

const renderDashboardPanels = () => (
  <div className={styles.skeletonDashboardPanelGrid}>
    <div data-ristak-card className={cx(styles.skeletonPanel, styles.skeletonDashboardConversionPanel)}>
      <div className={styles.skeletonDashboardPanelTop}>
        {block(styles.skeletonDashboardPanelTitle)}
        <div className={styles.skeletonDashboardScopeTabs}>
          {Array.from({ length: 3 }).map((_, index) => (
            <div className={cx(styles.skeletonBlock, styles.skeletonDashboardScopeTab)} key={`dashboard-panel-scope-${index}`} />
          ))}
        </div>
      </div>
      <div className={styles.skeletonDashboardConversionList}>
        {[92, 68, 54, 42].map((width, index) => (
          <div className={styles.skeletonDashboardConversionRow} key={`dashboard-conversion-${index}`}>
            {icon(styles.skeletonDashboardConversionIcon)}
            <div className={styles.skeletonDashboardConversionBody}>
              <div className={styles.skeletonDashboardConversionMeta}>
                {block(styles.skeletonDashboardConversionLabel)}
                {block(styles.skeletonDashboardConversionValue)}
              </div>
              {block(styles.skeletonDashboardProgressTrack, { width: `${width}%` })}
            </div>
          </div>
        ))}
      </div>
    </div>

    <div data-ristak-card className={cx(styles.skeletonPanel, styles.skeletonDashboardOriginPanel)}>
      {block(styles.skeletonDashboardPanelTitleShort)}
      <div className={styles.skeletonDashboardOriginMetric}>
        {block(styles.skeletonDashboardOriginNumber)}
        {block(styles.skeletonDashboardOriginMeta)}
      </div>
      <div className={styles.skeletonDashboardOriginBody}>
        <div className={styles.skeletonDashboardDonut} />
        <div className={styles.skeletonDashboardOriginLegend}>
          {Array.from({ length: 4 }).map((_, index) => (
            <span key={`dashboard-origin-${index}`}>
              <i />
              {block(styles.skeletonDashboardOriginLabel)}
            </span>
          ))}
        </div>
      </div>
    </div>
  </div>
)

const renderDashboardOperations = () => (
  <section data-dashboard-operations className={styles.skeletonDashboardOperationsGrid}>
    {Array.from({ length: 3 }).map((_, cardIndex) => (
      <div data-ristak-card className={cx(styles.skeletonPanel, styles.skeletonDashboardOperationCard)} key={`dashboard-operation-${cardIndex}`}>
        <div className={styles.skeletonDashboardOperationHeader}>
          <div className={styles.skeletonTitleGroup}>
            {block(styles.skeletonDashboardOperationEyebrow)}
            {block(styles.skeletonDashboardOperationTitle)}
            {block(styles.skeletonDashboardOperationSubtitle)}
          </div>
          {block(styles.skeletonDashboardOperationLink)}
        </div>
        <div className={styles.skeletonDashboardOperationList}>
          {[76, 62, 70].map((width, rowIndex) => (
            <div className={styles.skeletonDashboardOperationRow} key={`dashboard-operation-${cardIndex}-${rowIndex}`}>
              <div className={styles.skeletonTitleGroup}>
                {block(styles.skeletonDashboardOperationRowTitle)}
                {block(styles.skeletonDashboardOperationRowMeta)}
              </div>
              {block(styles.skeletonDashboardOperationPill, { width })}
            </div>
          ))}
        </div>
      </div>
    ))}
  </section>
)

const renderDashboardSkeleton = (kpiCount: number, kpiLayout: 'cards' | 'joined') => (
  <div data-ristak-dashboard className={styles.skeletonDashboardFlow}>
    {renderHeader({ actions: 1 })}
    {renderKpiCards(kpiCount, kpiLayout, { dashboard: true })}
    {renderDashboardChartPanel()}
    {renderDashboardPanels()}
    {renderDashboardOperations()}
  </div>
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

const renderSitesSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 2 })}
    {renderToolbar({ left: 2, tabs: 2, right: 1 })}
    <div className={styles.skeletonSitesGrid}>
      {Array.from({ length: 3 }).map((_, index) => (
        <div className={styles.skeletonPanel} key={`site-card-${index}`}>
          <div className={styles.skeletonSitePreview}>
            {block(styles.skeletonSiteHero)}
            {block(styles.skeletonSiteLine)}
            {block(styles.skeletonSiteLineShort)}
          </div>
          {block(styles.skeletonPanelTitle)}
          {block(styles.skeletonPanelSubtitle)}
        </div>
      ))}
    </div>
    <div className={styles.skeletonEditorLayout}>
      <div className={styles.skeletonPanel}>
        {block(styles.skeletonPanelTitle)}
        <div className={styles.skeletonCanvasPreview}>
          {block(styles.skeletonCanvasHero)}
          <div className={styles.skeletonCanvasColumns}>
            {block(styles.skeletonCanvasColumn)}
            {block(styles.skeletonCanvasColumn)}
          </div>
        </div>
      </div>
      <div className={cx(styles.skeletonPanel, styles.skeletonInspectorPanel)}>
        {block(styles.skeletonPanelTitle)}
        {Array.from({ length: 5 }).map((_, index) => (
          <div className={styles.skeletonField} key={`site-inspector-${index}`}>
            {block(styles.skeletonFieldLabel)}
            {block(styles.skeletonSelect)}
          </div>
        ))}
      </div>
    </div>
  </>
)

const renderAutomationsSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    {renderToolbar({ left: 1, tabs: 3, right: 1 })}
    <div className={styles.skeletonAutomationLayout}>
      <div className={styles.skeletonPanel}>
        {block(styles.skeletonPanelTitle)}
        <div className={styles.skeletonAutomationCanvas}>
          {Array.from({ length: 4 }).map((_, index) => (
            <div className={styles.skeletonAutomationNode} key={`automation-node-${index}`}>
              {icon()}
              <div className={styles.skeletonTitleGroup}>
                {block(styles.skeletonSettingsRowTitle)}
                {block(styles.skeletonSettingsRowMeta)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={cx(styles.skeletonPanel, styles.skeletonInspectorPanel)}>
        {block(styles.skeletonPanelTitle)}
        {Array.from({ length: 4 }).map((_, index) => (
          <div className={styles.skeletonField} key={`automation-field-${index}`}>
            {block(styles.skeletonFieldLabel)}
            {block(styles.skeletonSelect)}
          </div>
        ))}
      </div>
    </div>
    {renderTableSkeleton({ columns: 5, rows: 5, filters: 1, actions: 1 })}
  </>
)

const renderChatSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    <div className={styles.skeletonChatLayout}>
      <aside className={styles.skeletonChatSidebar}>
        {block(styles.skeletonSearch)}
        {Array.from({ length: 8 }).map((_, index) => (
          <div className={styles.skeletonChatRow} key={`chat-row-${index}`}>
            {icon(styles.skeletonChatAvatar)}
            <div className={styles.skeletonTitleGroup}>
              {block(styles.skeletonSettingsRowTitle)}
              {block(styles.skeletonSettingsRowMeta)}
            </div>
          </div>
        ))}
      </aside>
      <section className={styles.skeletonChatThread}>
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            className={cx(styles.skeletonMessageBubble, index % 2 === 1 && styles.skeletonMessageBubbleRight)}
            key={`chat-message-${index}`}
          >
            {block(index % 3 === 0 ? styles.skeletonMessageLineShort : styles.skeletonMessageLine)}
            {index % 2 === 0 && block(styles.skeletonMessageLineTiny)}
          </div>
        ))}
        <div className={styles.skeletonComposer}>
          {block(styles.skeletonComposerInput)}
          {block(styles.skeletonNavIcon)}
        </div>
      </section>
    </div>
  </>
)

const renderAIAgentSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    <div className={styles.skeletonTwoColumnGrid}>
      <div className={cx(styles.skeletonPanel, styles.skeletonSettingsCard)}>
        <div className={styles.skeletonSettingsSection}>
          {block(styles.skeletonSectionTitle)}
          {block(styles.skeletonSectionText)}
          {Array.from({ length: 5 }).map((_, index) => (
            <div className={styles.skeletonField} key={`ai-field-${index}`}>
              {block(styles.skeletonFieldLabel)}
              {block(styles.skeletonSelect)}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.skeletonPanel}>
        {block(styles.skeletonPanelTitle)}
        <div className={styles.skeletonChatThreadCompact}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              className={cx(styles.skeletonMessageBubble, index % 2 === 1 && styles.skeletonMessageBubbleRight)}
              key={`ai-message-${index}`}
            >
              {block(styles.skeletonMessageLine)}
            </div>
          ))}
        </div>
      </div>
    </div>
  </>
)

const renderInitializationSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 0 })}
    <div className={styles.skeletonInitializationLayout}>
      <div className={styles.skeletonPanel}>
        {block(styles.skeletonPanelTitle)}
        {block(styles.skeletonPanelSubtitle)}
        <div className={styles.skeletonSettingsList}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div className={styles.skeletonCheckboxRow} key={`initialization-step-${index}`}>
              <div className={styles.skeletonCheckbox} />
              <div className={styles.skeletonTitleGroup}>
                {block(styles.skeletonSettingsRowTitle)}
                {block(styles.skeletonSettingsRowMeta)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={cx(styles.skeletonPanel, styles.skeletonSettingsCard)}>
        <div className={styles.skeletonSettingsSection}>
          {block(styles.skeletonSectionTitle)}
          {block(styles.skeletonSectionText)}
          <div className={styles.skeletonFieldGrid}>
            {Array.from({ length: 5 }).map((_, index) => (
              <div className={styles.skeletonField} key={`initialization-field-${index}`}>
                {block(styles.skeletonFieldLabel)}
                {block(styles.skeletonSelect)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </>
)

const renderApiDocsSkeleton = () => (
  <>
    {renderHeader({ subtitle: true, actions: 1 })}
    <div className={styles.skeletonApiDocsLayout}>
      <div className={styles.skeletonPanel}>
        {Array.from({ length: 9 }).map((_, index) => (
          <div className={styles.skeletonSettingsNavItem} key={`api-nav-${index}`}>
            {block(styles.skeletonMethodBadge)}
            {block(styles.skeletonSettingsNavLabel)}
          </div>
        ))}
      </div>
      <div className={styles.skeletonPanel}>
        {block(styles.skeletonPanelTitle)}
        {block(styles.skeletonSectionText)}
        {Array.from({ length: 5 }).map((_, index) => (
          <div className={styles.skeletonApiEndpoint} key={`api-endpoint-${index}`}>
            {block(styles.skeletonMethodBadge)}
            {block(styles.skeletonApiPath)}
          </div>
        ))}
      </div>
    </div>
  </>
)

const renderPageSkeleton = (page: LoadingPage, kpiCount: number, kpiLayout: 'cards' | 'joined', message: string) => {
  const isWide = page === 'reports' || page === 'sites' || page === 'automations' || page === 'chat'
  const content = {
    dashboard: renderDashboardSkeleton(kpiCount, kpiLayout),
    contacts: renderContactsSkeleton(),
    appointments: renderAppointmentsSkeleton(),
    reports: renderReportsSkeleton(),
    analytics: renderAnalyticsSkeleton(),
    campaigns: renderCampaignsSkeleton(),
    transactions: renderTransactionsSkeleton(),
    settings: renderSettingsFormSkeleton(),
    'settings-form': renderSettingsFormSkeleton(),
    'settings-list': renderSettingsListSkeleton(),
    'calendar-settings': renderSettingsCalendarSkeleton(),
    sites: renderSitesSkeleton(),
    automations: renderAutomationsSkeleton(),
    chat: renderChatSkeleton(),
    'ai-agent': renderAIAgentSkeleton(),
    initialization: renderInitializationSkeleton(),
    'api-docs': renderApiDocsSkeleton()
  }[page]

  return (
    <div data-ristak-page className={styles.skeletonPage} role="status" aria-live="polite" aria-label={message}>
      <div data-ristak-page-inner className={cx(styles.skeletonInner, isWide && styles.skeletonInnerWide)}>
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
    <div className={containerClass} role="status" aria-live="polite" aria-label={message}>
      <div className={styles.loadingWrapper}>
        <Loader2 className={`${sizeClasses[size]} ${styles.spinner}`} aria-hidden="true" />
      </div>
    </div>
  )
}
