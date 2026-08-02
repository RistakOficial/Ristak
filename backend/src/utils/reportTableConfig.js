export const REPORTS_TABLE_CONFIG_KEY = 'table_reports_metrics'

export const LEGACY_REPORTS_TABLE_CONFIG_KEYS = [
  'table_reports_metrics_cashflow_month',
  'table_reports_metrics_cashflow_day',
  'table_reports_metrics_cashflow_year',
  'table_reports_metrics_attribution_month',
  'table_reports_metrics_attribution_day',
  'table_reports_metrics_attribution_year',
  'table_reports_metrics_campaigns_month',
  'table_reports_metrics_campaigns_day',
  'table_reports_metrics_campaigns_year'
]

export const DEFAULT_REPORT_TABLE_COLUMN_CONFIG = [
  ['date', true],
  ['profit', true],
  ['revenue', true],
  ['fixedBusinessExpenses', true],
  ['businessExpenses', true],
  ['spend', true],
  ['roas', true],
  ['new_customers', true],
  ['cac', true],
  ['appointments', true],
  ['leads', true],
  ['attendances', false],
  ['transactions', false],
  ['clicks', false],
  ['reach', false],
  ['cpc', false],
  ['cpl', false],
  ['cpa', false],
  ['cpaAttendance', false],
  ['visitors', false],
  ['cpv', false],
  ['webToInteresadosRate', false],
  ['interesadosToApptsRate', false],
  ['apptsToAttendanceRate', false],
  ['attendanceToSalesRate', false],
  ['attendanceToCustomersRate', false],
  ['apptsToSalesRate', false]
].map(([id, visible], order) => ({ id, visible, order }))

export const DEFAULT_REPORT_TABLE_CONFIG_VALUE = JSON.stringify(DEFAULT_REPORT_TABLE_COLUMN_CONFIG)

function parseConfigValue(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function isValidReportTableConfigValue(value) {
  const parsed = parseConfigValue(value)
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(column => (
    column &&
    typeof column === 'object' &&
    typeof column.id === 'string' &&
    (column.visible === undefined || typeof column.visible === 'boolean') &&
    (column.order === undefined || Number.isFinite(column.order))
  ))
}

function configUpdatedAt(value) {
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function selectReportTableConfigMigration(rows = []) {
  const priority = new Map(LEGACY_REPORTS_TABLE_CONFIG_KEYS.map((key, index) => [key, index]))
  const candidates = rows
    .filter(row => priority.has(row?.config_key) && isValidReportTableConfigValue(row?.config_value))
    .sort((left, right) => {
      const timestampDelta = configUpdatedAt(right.updated_at) - configUpdatedAt(left.updated_at)
      if (timestampDelta !== 0) return timestampDelta
      return priority.get(left.config_key) - priority.get(right.config_key)
    })

  return candidates.length > 0
    ? { configValue: candidates[0].config_value, sourceKey: candidates[0].config_key }
    : { configValue: DEFAULT_REPORT_TABLE_CONFIG_VALUE, sourceKey: null }
}

export async function ensureSharedReportTableConfig(database) {
  const existing = await database.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    [REPORTS_TABLE_CONFIG_KEY]
  )

  if (isValidReportTableConfigValue(existing?.config_value)) {
    return { created: false, sourceKey: REPORTS_TABLE_CONFIG_KEY }
  }

  const placeholders = LEGACY_REPORTS_TABLE_CONFIG_KEYS.map(() => '?').join(', ')
  const legacyRows = await database.all(
    `SELECT config_key, config_value, updated_at
     FROM app_config
     WHERE config_key IN (${placeholders})`,
    LEGACY_REPORTS_TABLE_CONFIG_KEYS
  )
  const migration = selectReportTableConfigMigration(legacyRows)

  await database.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [REPORTS_TABLE_CONFIG_KEY, migration.configValue])

  return { created: true, sourceKey: migration.sourceKey }
}
