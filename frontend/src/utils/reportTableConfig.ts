export const REPORTS_TABLE_ID = 'reports_metrics'
export const REPORTS_TABLE_CONFIG_KEY = `table_${REPORTS_TABLE_ID}`

const ANALYTICS_REPORT_COLUMN_KEYS = new Set([
  'visitors',
  'cpv',
  'webToInteresadosRate'
])

export function filterAvailableReportColumns<T extends { key: PropertyKey }>(
  columns: T[],
  { analyticsEnabled }: { analyticsEnabled: boolean }
) {
  if (analyticsEnabled) return columns
  return columns.filter(column => !ANALYTICS_REPORT_COLUMN_KEYS.has(String(column.key)))
}
