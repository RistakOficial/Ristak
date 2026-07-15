import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneModifierExpression } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { getVisitorIdentityExpression } from './trackingService.js'
import { createDatabaseAbortError } from '../utils/postgresCancelableQuery.js'

const isPostgres = databaseDialect === 'postgres'
const VALID_GROUPS = new Set(['day', 'month', 'year'])
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled', 'canceled', 'no_show', 'noshow', 'invalid',
  'failed', 'missed', 'deleted', 'void', 'voided'
]
const ATTENDED_APPOINTMENT_STATUSES = ['showed', 'attended', 'completed', 'complete']

function sqlList(values) {
  return values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')
}

function periodExpression(column, groupBy, timezone, { dateOnly = false, range = {} } = {}) {
  const format = groupBy === 'year' ? '%Y' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d'
  if (!isPostgres) {
    const value = dateOnly
      ? column
      : (() => {
          const utcValue = normalizedTimestampExpression(column)
          const modifier = sqliteTimezoneModifierExpression(utcValue, timezone, range)
          return `datetime(${utcValue}, ${modifier})`
        })()
    return `strftime('${format}', ${value})`
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  const value = dateOnly
    ? `(${column})::date`
    : `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')`
  const pgFormat = groupBy === 'year' ? 'YYYY' : groupBy === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
  return `TO_CHAR(${value}, '${pgFormat}')`
}

function sqliteNormalizedTimestampExpression(column) {
  const text = `TRIM(CAST(${column} AS TEXT))`
  const numericValue = `CAST(${column} AS REAL)`
  const numericTimestamp = `CASE
    WHEN ABS(${numericValue}) >= 100000000000 THEN datetime(${numericValue} / 1000.0, 'unixepoch')
    ELSE datetime(${numericValue}, 'unixepoch')
  END`

  return `CASE
    WHEN ${column} IS NULL OR ${text} = '' THEN NULL
    WHEN typeof(${column}) IN ('integer', 'real') THEN ${numericTimestamp}
    WHEN ${text} NOT GLOB '*[^0-9]*' THEN ${numericTimestamp}
    ELSE datetime(${column})
  END`
}

function normalizedTimestampExpression(column) {
  return isPostgres ? column : sqliteNormalizedTimestampExpression(column)
}

function appendRangeConditions(conditions, params, column, range, { normalizeParameters = false } = {}) {
  const placeholder = normalizeParameters && !isPostgres ? 'datetime(?)' : '?'
  if (range.startUtc) {
    conditions.push(`${column} >= ${placeholder}`)
    params.push(range.startUtc)
  }
  if (range.endUtc) {
    conditions.push(`${column} <= ${placeholder}`)
    params.push(range.endUtc)
  }
}

function whereClause(conditions) {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
}

function normalizedAppointmentStatus(alias) {
  return `LOWER(COALESCE(NULLIF(TRIM(${alias}.appointment_status), ''), NULLIF(TRIM(${alias}.status), ''), ''))`
}

function contactDateExpression(column, timezone, range = {}) {
  if (!isPostgres) {
    const utcValue = normalizedTimestampExpression(column)
    return `DATE(datetime(${utcValue}, ${sqliteTimezoneModifierExpression(utcValue, timezone, range)}))`
  }
  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
}

function attributionMatchCondition(alias, timezone, range = {}) {
  const contactDate = contactDateExpression(`${alias}.created_at`, timezone, range)
  const sameCalendarDay = isPostgres
    ? `ma.date = (${contactDate})::text`
    : `ma.date = ${contactDate}`
  return `${alias}.attribution_ad_id IS NOT NULL
    AND ${alias}.attribution_ad_id != ''
    AND EXISTS (
      SELECT 1
      FROM meta_ads ma
      WHERE ma.ad_id = ${alias}.attribution_ad_id
        AND ${sameCalendarDay}
    )`
}

function contactDedupExpression(alias = 'c') {
  if (isPostgres) {
    const phoneDigits = `REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g')`
    return `CASE
      WHEN ${alias}.email IS NOT NULL AND ${alias}.email LIKE '%@%'
        THEN CONCAT('email::', LOWER(TRIM(${alias}.email)))
      WHEN ${alias}.phone IS NOT NULL AND LENGTH(${phoneDigits}) >= 10
        THEN CONCAT('phone::', RIGHT(${phoneDigits}, 10))
      ELSE CONCAT('id::', ${alias}.id::text)
    END`
  }

  // `contact_phone_numbers` es la proyección canónica persistida y con índice.
  // La recursión exacta sólo cubre filas legacy que todavía no pasan por el
  // backfill de teléfonos; no penaliza el camino normal de cuentas grandes.
  const canonicalPhone = `(SELECT cpn.phone
    FROM contact_phone_numbers cpn
    WHERE cpn.contact_id = ${alias}.id
    ORDER BY cpn.is_primary DESC, cpn.updated_at DESC, cpn.id
    LIMIT 1)`
  const canonicalDigits = `REPLACE(COALESCE(${canonicalPhone}, ''), '+', '')`
  const legacyPersonKey = `(WITH RECURSIVE normalized_phone(rest, digits) AS (
    SELECT COALESCE(CAST(${alias}.phone AS TEXT), ''), ''
    UNION ALL
    SELECT
      SUBSTR(rest, 2),
      digits || CASE WHEN SUBSTR(rest, 1, 1) GLOB '[0-9]' THEN SUBSTR(rest, 1, 1) ELSE '' END
    FROM normalized_phone
    WHERE rest != ''
  )
  SELECT CASE
    WHEN LENGTH(digits) >= 10 THEN 'phone::' || SUBSTR(digits, -10)
    ELSE 'id::' || ${alias}.id
  END
  FROM normalized_phone
  WHERE rest = ''
  LIMIT 1)`
  const phonePersonKey = `(WITH canonical_phone(canonical_digits) AS MATERIALIZED (
    SELECT ${canonicalDigits}
  )
  SELECT CASE
    WHEN LENGTH(canonical_digits) >= 10 THEN 'phone::' || SUBSTR(canonical_digits, -10)
    ELSE ${legacyPersonKey}
  END
  FROM canonical_phone)`
  return `CASE
    WHEN ${alias}.email IS NOT NULL AND ${alias}.email LIKE '%@%'
      THEN 'email::' || LOWER(TRIM(${alias}.email))
    ELSE ${phonePersonKey}
  END`
}

function throwIfReportQueryAborted(signal) {
  if (signal?.aborted) throw createDatabaseAbortError()
}

function reportQueryOptions(signal) {
  return signal ? { signal } : undefined
}

async function getAttributionCalendarIds(signal) {
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    ['attribution_calendar_ids'],
    reportQueryOptions(signal)
  )
  if (!row?.config_value) return []
  try {
    const value = JSON.parse(row.config_value)
    return Array.isArray(value) ? value.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function calendarCondition(alias, calendarIds) {
  if (!calendarIds.length) return { sql: '', params: [] }
  return {
    sql: `${alias}.calendar_id IN (${calendarIds.map(() => '?').join(', ')})`,
    params: [...calendarIds]
  }
}

function createMetricBucket(period) {
  return {
    date: period,
    spend: 0,
    revenue: 0,
    leads: 0,
    customers: 0,
    appointments: 0,
    attendances: 0,
    sales: 0,
    clicks: 0,
    reach: 0,
    visitors: 0,
    new_customers: 0,
    roas: 0,
    profit: 0
  }
}

async function runBoundedQueryTasks(tasks, concurrency = 2, signal) {
  const results = new Array(tasks.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < tasks.length) {
      throwIfReportQueryAborted(signal)
      const index = nextIndex
      nextIndex += 1
      results[index] = await tasks[index]()
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), tasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * Agrega la tabla principal de Reportes completamente en SQL. Cada query devuelve
 * una fila por periodo; nunca materializa contactos, citas ni pagos históricos en
 * Node y nunca consulta proveedores durante un GET de pantalla.
 */
export async function buildAggregatedReportMetrics({ startDate, endDate, groupBy = 'day', scope = 'all', signal } = {}) {
  throwIfReportQueryAborted(signal)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  throwIfReportQueryAborted(signal)
  const cleanGroup = VALID_GROUPS.has(groupBy) ? groupBy : 'day'
  const timezone = range.appliedTimezone
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns'
  const isAttributed = scope === 'campaigns'
  const [hiddenFilters, calendarIds] = await Promise.all([
    getHiddenContactFilters({ signal }),
    getAttributionCalendarIds(signal)
  ])
  throwIfReportQueryAborted(signal)
  const queryOptions = reportQueryOptions(signal)
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const contactConditions = []
  const contactParams = []
  appendRangeConditions(contactConditions, contactParams, 'c.created_at', range)
  if (isAttributed) contactConditions.push(attributionMatchCondition('c', timezone, range))
  if (hiddenCondition) contactConditions.push(hiddenCondition)

  const contactPeriod = periodExpression('c.created_at', cleanGroup, timezone, { range })
  const rawContactDedup = contactDedupExpression('c')
  const dedup = rawContactDedup
  const contactRowsDedup = isPostgres ? rawContactDedup : 'c.person_key'
  const activeCalendar = calendarCondition('a', calendarIds)
  const attendedCalendar = calendarCondition('aa', calendarIds)
  const activeAppointment = `EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.contact_id = c.id
      AND ${normalizedAppointmentStatus('a')} NOT IN (${sqlList(INACTIVE_APPOINTMENT_STATUSES)})
      ${activeCalendar.sql ? `AND ${activeCalendar.sql}` : ''}
  )`
  const attendance = `(
    COALESCE(c.purchases_count, 0) > 0
    OR COALESCE(c.total_paid, 0) > 0
    OR EXISTS (SELECT 1 FROM appointment_attendance_signals aas WHERE aas.contact_id = c.id)
    OR EXISTS (
      SELECT 1 FROM appointments aa
      WHERE aa.contact_id = c.id
        AND ${normalizedAppointmentStatus('aa')} IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
        ${attendedCalendar.sql ? `AND ${attendedCalendar.sql}` : ''}
    )
  )`

  const contactRowsTask = () => db.all(`
    WITH ranged_contacts AS ${isPostgres ? '' : 'MATERIALIZED'} (
      SELECT
        c.id,
        c.email,
        c.phone,
        c.purchases_count,
        c.total_paid,
        c.created_at
        ${isPostgres ? '' : `, ${rawContactDedup} AS person_key`}
      FROM contacts c
      ${whereClause(contactConditions)}
    )
    SELECT
      ${contactPeriod} AS period,
      COUNT(DISTINCT ${contactRowsDedup}) AS leads,
      COUNT(DISTINCT CASE WHEN COALESCE(c.purchases_count, 0) > 0 THEN ${contactRowsDedup} END) AS customers,
      ${useContactAttribution
        ? `COUNT(DISTINCT CASE WHEN ${activeAppointment} THEN ${contactRowsDedup} END)`
        : '0'} AS appointments,
      COUNT(DISTINCT CASE WHEN ${attendance} THEN ${contactRowsDedup} END) AS attendances
    FROM ranged_contacts c
    GROUP BY period
    ORDER BY period
  `, [
    ...contactParams,
    ...(useContactAttribution ? activeCalendar.params : []),
    ...attendedCalendar.params
  ], queryOptions)

  const appointmentRowsTask = useContactAttribution
    ? async () => []
    : async () => {
        const appointmentCalendar = calendarCondition('a', calendarIds)
        const appointmentTimestamp = normalizedTimestampExpression('a.date_added')
        const appointmentPeriod = periodExpression('a.date_added', cleanGroup, timezone, { range })
        const conditions = ['a.contact_id IS NOT NULL']
        const appointmentParams = []
        appendRangeConditions(
          conditions,
          appointmentParams,
          appointmentTimestamp,
          range,
          { normalizeParameters: true }
        )
        if (appointmentCalendar.sql) conditions.push(appointmentCalendar.sql)
        if (hiddenCondition) conditions.push(hiddenCondition)
        return db.all(`
          SELECT
            ${appointmentPeriod} AS period,
            COUNT(DISTINCT ${dedup}) AS appointments
          FROM appointments a
          INNER JOIN contacts c ON c.id = a.contact_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY period
          ORDER BY period
        `, [...appointmentParams, ...appointmentCalendar.params], queryOptions)
      }

  const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')
  const firstCustomerRowsTask = useContactAttribution
    ? async () => []
    : async () => {
        const firstPaymentConditions = [
          `LOWER(COALESCE(fp.status, '')) IN (${sqlList(SUCCESS_PAYMENT_STATUSES)})`,
          nonTestPaymentCondition('fp'),
          `NOT EXISTS (
            SELECT 1
            FROM payments earlier
            WHERE earlier.contact_id = fp.contact_id
              AND LOWER(COALESCE(earlier.status, '')) IN (${sqlList(SUCCESS_PAYMENT_STATUSES)})
              AND ${nonTestPaymentCondition('earlier')}
              AND earlier.date < fp.date
          )`
        ]
        const firstPaymentParams = []
        appendRangeConditions(firstPaymentConditions, firstPaymentParams, 'fp.date', range)
        if (hiddenCondition) firstPaymentConditions.push(hiddenCondition)

        return db.all(`
        SELECT
          ${periodExpression('fp.date', cleanGroup, timezone, { range })} AS period,
          COUNT(DISTINCT ${dedup}) AS new_customers
        FROM payments fp
        INNER JOIN contacts c ON c.id = fp.contact_id
        ${whereClause(firstPaymentConditions)}
        GROUP BY period
        ORDER BY period
      `, firstPaymentParams, queryOptions)
      }

  const attributedPaymentConditions = [
    ...contactConditions,
    `LOWER(COALESCE(p.status, '')) IN (${statusPlaceholders})`,
    nonTestPaymentCondition('p')
  ]
  const attributedPaymentParams = [...contactParams, ...SUCCESS_PAYMENT_STATUSES]
  const paymentRowsTask = useContactAttribution
    ? () => db.all(`
        SELECT
          ${contactPeriod} AS period,
          COUNT(DISTINCT ${dedup}) AS sales,
          COALESCE(SUM(p.amount), 0) AS revenue
        FROM contacts c
        INNER JOIN payments p ON p.contact_id = c.id
        ${whereClause(attributedPaymentConditions)}
        GROUP BY period
        ORDER BY period
      `, attributedPaymentParams, queryOptions)
    : async () => {
        const paymentConditions = [
          `LOWER(COALESCE(p.status, '')) IN (${statusPlaceholders})`,
          nonTestPaymentCondition('p')
        ]
        const paymentParams = [...SUCCESS_PAYMENT_STATUSES]
        appendRangeConditions(paymentConditions, paymentParams, 'p.date', range)
        if (hiddenCondition) paymentConditions.push(hiddenCondition)
        return db.all(`
        SELECT
          ${periodExpression('p.date', cleanGroup, timezone, { range })} AS period,
          COUNT(*) AS sales,
          COALESCE(SUM(p.amount), 0) AS revenue
        FROM payments p
        LEFT JOIN contacts c ON c.id = p.contact_id
        ${whereClause(paymentConditions)}
        GROUP BY period
        ORDER BY period
      `, paymentParams, queryOptions)
      }

  const spendFrom = range.startZoned?.toISODate()
  const spendTo = range.endZoned?.toISODate()
  const spendConditions = []
  const spendParams = []
  if (spendFrom) {
    spendConditions.push('ma.date >= ?')
    spendParams.push(spendFrom)
  }
  if (spendTo) {
    spendConditions.push('ma.date <= ?')
    spendParams.push(spendTo)
  }
  const spendRowsTask = () => db.all(`
    SELECT
      ${periodExpression('ma.date', cleanGroup, timezone, { dateOnly: true, range })} AS period,
      COALESCE(SUM(ma.spend), 0) AS spend,
      COALESCE(SUM(ma.clicks), 0) AS clicks,
      COALESCE(SUM(ma.reach), 0) AS reach
    FROM meta_ads ma
    ${whereClause(spendConditions)}
    GROUP BY period
    ORDER BY period
  `, spendParams, queryOptions)

  const visitorRowsTask = useContactAttribution
    ? () => db.all(`
        SELECT
          ${contactPeriod} AS period,
          COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) AS visitors
        FROM sessions s
        INNER JOIN contacts c ON c.id = s.contact_id
        ${whereClause(contactConditions)}
        GROUP BY period
        ORDER BY period
      `, contactParams, queryOptions)
    : async () => {
        const visitorConditions = []
        const visitorParams = []
        appendRangeConditions(visitorConditions, visitorParams, 's.started_at', range)
        return db.all(`
        SELECT
          ${periodExpression('s.started_at', cleanGroup, timezone, { range })} AS period,
          COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) AS visitors
        FROM sessions s
        ${whereClause(visitorConditions)}
        GROUP BY period
        ORDER BY period
      `, visitorParams, queryOptions)
      }

  const [contactRows, appointmentRows, firstCustomerRows, paymentRows, spendRows, visitorRows] = await runBoundedQueryTasks([
    contactRowsTask,
    appointmentRowsTask,
    firstCustomerRowsTask,
    paymentRowsTask,
    spendRowsTask,
    visitorRowsTask
  ], 2, signal)
  throwIfReportQueryAborted(signal)

  const buckets = new Map()
  const getBucket = (period) => {
    const key = String(period || '')
    if (!key) return null
    if (!buckets.has(key)) buckets.set(key, createMetricBucket(key))
    return buckets.get(key)
  }

  contactRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (!bucket) return
    bucket.leads = Number(row.leads || 0)
    bucket.customers = Number(row.customers || 0)
    bucket.appointments = Number(row.appointments || 0)
    bucket.attendances = Number(row.attendances || 0)
    if (useContactAttribution) bucket.new_customers = bucket.customers
  })
  appointmentRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (bucket) bucket.appointments = Number(row.appointments || 0)
  })
  firstCustomerRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (bucket) bucket.new_customers = Number(row.new_customers || 0)
  })
  paymentRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (!bucket) return
    bucket.sales = Number(row.sales || 0)
    bucket.revenue = Number(row.revenue || 0)
  })
  spendRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (!bucket) return
    bucket.spend = Number(row.spend || 0)
    bucket.clicks = Number(row.clicks || 0)
    bucket.reach = Number(row.reach || 0)
  })
  visitorRows.forEach(row => {
    const bucket = getBucket(row.period)
    if (bucket) bucket.visitors = Number(row.visitors || 0)
  })

  const metrics = Array.from(buckets.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(bucket => ({
      ...bucket,
      roas: bucket.spend > 0 ? bucket.revenue / bucket.spend : 0,
      profit: bucket.revenue - bucket.spend
    }))

  return { range, metrics }
}

/**
 * Totales del periodo de comparacion usados por el snapshot principal de
 * Reportes. El periodo actual ya fue recorrido por
 * buildAggregatedReportMetrics(); volver a ejecutar los summaries historicos
 * duplicaba los scans de contactos, pagos y anuncios. Esta lectura toca solo
 * pagos y anuncios del periodo anterior, con exactamente el mismo alcance SQL
 * que la tabla principal, y mantiene el limite de dos queries concurrentes.
 */
export async function buildReportComparisonTotals({ startDate, endDate, scope = 'all', signal } = {}) {
  throwIfReportQueryAborted(signal)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  throwIfReportQueryAborted(signal)
  const timezone = range.appliedTimezone
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns'
  const isAttributed = scope === 'campaigns'
  const hiddenFilters = await getHiddenContactFilters({ signal })
  throwIfReportQueryAborted(signal)
  const queryOptions = reportQueryOptions(signal)
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')

  const paymentTotalsTask = useContactAttribution
    ? () => {
        const conditions = []
        const params = []
        appendRangeConditions(conditions, params, 'c.created_at', range)
        if (isAttributed) conditions.push(attributionMatchCondition('c', timezone, range))
        if (hiddenCondition) conditions.push(hiddenCondition)
        conditions.push(`LOWER(COALESCE(p.status, '')) IN (${statusPlaceholders})`)
        conditions.push(nonTestPaymentCondition('p'))
        params.push(...SUCCESS_PAYMENT_STATUSES)

        return db.get(`
          SELECT
            COUNT(DISTINCT ${contactDedupExpression('c')}) AS sales,
            COALESCE(SUM(p.amount), 0) AS revenue
          FROM contacts c
          INNER JOIN payments p ON p.contact_id = c.id
          ${whereClause(conditions)}
        `, params, queryOptions)
      }
    : () => {
        const conditions = [
          `LOWER(COALESCE(p.status, '')) IN (${statusPlaceholders})`,
          nonTestPaymentCondition('p')
        ]
        const params = [...SUCCESS_PAYMENT_STATUSES]
        appendRangeConditions(conditions, params, 'p.date', range)
        if (hiddenCondition) conditions.push(hiddenCondition)

        return db.get(`
          SELECT
            COUNT(*) AS sales,
            COALESCE(SUM(p.amount), 0) AS revenue
          FROM payments p
          LEFT JOIN contacts c ON c.id = p.contact_id
          ${whereClause(conditions)}
        `, params, queryOptions)
      }

  const spendConditions = []
  const spendParams = []
  const spendFrom = range.startZoned?.toISODate()
  const spendTo = range.endZoned?.toISODate()
  if (spendFrom) {
    spendConditions.push('ma.date >= ?')
    spendParams.push(spendFrom)
  }
  if (spendTo) {
    spendConditions.push('ma.date <= ?')
    spendParams.push(spendTo)
  }
  const adTotalsTask = () => db.get(`
    SELECT
      COALESCE(SUM(ma.spend), 0) AS spend,
      COALESCE(SUM(ma.clicks), 0) AS clicks,
      COALESCE(SUM(ma.reach), 0) AS reach
    FROM meta_ads ma
    ${whereClause(spendConditions)}
  `, spendParams, queryOptions)

  const [payments, ads] = await runBoundedQueryTasks([paymentTotalsTask, adTotalsTask], 2, signal)
  throwIfReportQueryAborted(signal)
  return {
    range,
    revenue: Number(payments?.revenue || 0),
    sales: Number(payments?.sales || 0),
    spend: Number(ads?.spend || 0),
    clicks: Number(ads?.clicks || 0),
    reach: Number(ads?.reach || 0)
  }
}
