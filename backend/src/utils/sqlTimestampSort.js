const isPostgresDatabase = Boolean(process.env.DATABASE_URL)

const postgresTimestampEpochExpression = (valueExpression) => (
  `EXTRACT(EPOCH FROM NULLIF(${valueExpression}::text, '')::timestamptz)`
)

const sqliteTimestampEpochExpression = (valueExpression) => (
  `COALESCE(julianday(${valueExpression}), julianday(REPLACE(REPLACE(${valueExpression}, 'T', ' '), 'Z', '')))`
)

export const timestampSortExpression = (valueExpression) => (
  isPostgresDatabase
    ? `COALESCE(${postgresTimestampEpochExpression(valueExpression)}, 0)`
    : `COALESCE(${sqliteTimestampEpochExpression(valueExpression)}, 0)`
)

// Safe for prepared-statement cursors: unlike timestampSortExpression('?'),
// this expression contains exactly one bind placeholder on both databases.
// SQLite's julianday() already understands the ISO and UTC SQLite formats used
// by chat timestamps, so its defensive REPLACE fallback is unnecessary here.
export const timestampSortParameterExpression = () => (
  isPostgresDatabase
    ? `COALESCE(${postgresTimestampEpochExpression('?')}, 0)`
    : 'COALESCE(julianday(?), 0)'
)

export const coalescedTimestampSortExpression = (...valueExpressions) => {
  const cleanExpressions = valueExpressions
    .map(value => String(value || '').trim())
    .filter(Boolean)

  if (cleanExpressions.length === 0) return '0'

  const normalizedExpressions = cleanExpressions.map(valueExpression => (
    isPostgresDatabase
      ? postgresTimestampEpochExpression(valueExpression)
      : sqliteTimestampEpochExpression(valueExpression)
  ))

  return `COALESCE(${normalizedExpressions.join(', ')}, 0)`
}

export const parseSortableTimestamp = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return 0

  let normalized = raw
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T00:00:00.000Z`
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    const withDateSeparator = raw.replace(/\s+/, 'T')
    const withNormalizedOffset = withDateSeparator
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
      .replace(/([+-]\d{2})$/, '$1:00')
    normalized = /[zZ]$|[+-]\d{2}:\d{2}$/.test(withNormalizedOffset)
      ? withNormalizedOffset
      : `${withNormalizedOffset}Z`
  }

  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : 0
}
