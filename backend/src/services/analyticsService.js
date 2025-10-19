import { db } from '../config/database.js'
import { DateTime } from 'luxon'
import { resolveDateRange } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import { getContactsWithAppointmentsHybrid, loadAppointmentsFromDB, loadAppointmentsFromAPI, mergeAppointments } from './appointmentsMerge.js'

const isPostgres = Boolean(process.env.DATABASE_URL)

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]|null>} Array de calendar IDs o null si no están configurados
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    if (!config || !config.config_value) {
      return null // null = usar todos los calendarios
    }

    const calendarIds = JSON.parse(config.config_value)
    return calendarIds.length > 0 ? calendarIds : null
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución: ${error.message} - usando TODOS`)
    return null
  }
}

function attributionMatchCondition(alias = 'contacts', dateColumn = 'created_at') {
  const prefix = alias ? `${alias}.` : ''
  const contactDateExpr = isPostgres
    ? `(${prefix}${dateColumn})::date`
    : `DATE(${prefix}${dateColumn})`
  const adDateExpr = isPostgres ? '(ma.date)::date' : 'DATE(ma.date)'
  return `${prefix}attribution_ad_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM meta_ads ma
    WHERE ma.ad_id = ${prefix}attribution_ad_id
      AND ${adDateExpr} = ${contactDateExpr}
  )`
}

const DEFAULT_NUMBER = {
  total: 0,
  customers: 0,
  with_appointments: 0,
  ltv_total: 0,
  avg_ltv: 0
}

const SUCCESS_PAYMENT_STATUSES = [
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
]

function normalizePhoneValue(phone) {
  if (!phone) {
    return null
  }

  const digits = String(phone).replace(/\D/g, '')

  if (digits.length < 10) {
    return null
  }

  return digits.slice(-10)
}

function buildContactKey(contact) {
  // Prioridad 1: Email (más único y estable que teléfono)
  const email = contact?.email?.toLowerCase().trim()
  if (email && email.includes('@')) {
    return `email::${email}`
  }

  // Prioridad 2: Teléfono (normalizado a últimos 10 dígitos)
  const normalizedPhone = normalizePhoneValue(contact?.phone)
  if (normalizedPhone) {
    return `phone::${normalizedPhone}`
  }

  // Prioridad 3: Contact ID (fallback cuando no hay email ni teléfono)
  if (contact?.contact_id != null) {
    return `id::${String(contact.contact_id)}`
  }

  return null
}

/**
 * Genera expresión SQL para deduplicación por email O teléfono
 * Prioriza email sobre teléfono, usa ID como fallback
 *
 * @param {string} tableAlias - Alias de la tabla (ej: 'c', 'contacts')
 * @returns {string} - Expresión SQL CASE
 */
function buildDedupExpression(tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : ''

  if (isPostgres) {
    return `CASE
      WHEN ${prefix}email IS NOT NULL AND ${prefix}email LIKE '%@%'
        THEN CONCAT('email::', LOWER(TRIM(${prefix}email)))
      WHEN ${prefix}phone IS NOT NULL AND LENGTH(${prefix}phone) >= 10
        THEN CONCAT('phone::', SUBSTRING(${prefix}phone FROM '.{10}$'))
      ELSE CONCAT('id::', ${prefix}id::text)
    END`
  } else {
    // SQLite
    return `CASE
      WHEN ${prefix}email IS NOT NULL AND ${prefix}email LIKE '%@%'
        THEN 'email::' || LOWER(TRIM(${prefix}email))
      WHEN ${prefix}phone IS NOT NULL AND LENGTH(${prefix}phone) >= 10
        THEN 'phone::' || SUBSTR(${prefix}phone, -10)
      ELSE 'id::' || ${prefix}id
    END`
  }
}

function applySuccessStatusFilter(conditions, params, alias = 'p') {
  if (!Array.isArray(conditions) || !Array.isArray(params) || SUCCESS_PAYMENT_STATUSES.length === 0) {
    return
  }

  const placeholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')
  conditions.push(`LOWER(${alias}.status) IN (${placeholders})`)
  params.push(...SUCCESS_PAYMENT_STATUSES)
}

async function fetchPreviousRange(range, fallbackStrategy) {
  if (range.startZoned && range.endZoned && range.providedStart) {
    const spanDays = Math.max(Math.round(range.endZoned.diff(range.startZoned, 'days').days) + 1, 1)
    const prevPeriodEnd = range.startZoned.minus({ days: 1 }).endOf('day')
    const prevPeriodStart = prevPeriodEnd.minus({ days: spanDays - 1 }).startOf('day')

    return {
      startUtc: prevPeriodStart.toUTC().toISO({ suppressMilliseconds: false }),
      endUtc: prevPeriodEnd.toUTC().toISO({ suppressMilliseconds: false })
    }
  }

  if (fallbackStrategy === 'month') {
    const zone = range.appliedTimezone
    const nowZoned = DateTime.now().setZone(zone)
    const currentMonthStart = nowZoned.startOf('month')
    const previousMonthStart = currentMonthStart.minus({ months: 1 })
    const previousMonthEnd = currentMonthStart.minus({ days: 1 }).endOf('day')

    return {
      startUtc: previousMonthStart.toUTC().toISO({ suppressMilliseconds: false }),
      endUtc: previousMonthEnd.toUTC().toISO({ suppressMilliseconds: false })
    }
  }

  return null
}

export async function buildContactStats ({ startDate, endDate, scope = 'all' } = {}) {
  const range = resolveDateRange({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'

  const dedupExpr = buildDedupExpression('')

  const selectClause = `
    SELECT
      COUNT(DISTINCT ${dedupExpr}) as total,
      COUNT(DISTINCT CASE
        WHEN purchases_count > 0 THEN ${dedupExpr}
      END) as customers,
      COUNT(DISTINCT CASE
        WHEN appointment_date IS NOT NULL THEN ${dedupExpr}
      END) as with_appointments,
      COALESCE(SUM(total_paid), 0) as ltv_total,
      COALESCE(AVG(total_paid), 0) as avg_ltv
    FROM contacts
  `

  const filters = []
  const params = []

  if (range.startUtc) {
    filters.push('created_at >= ?')
    params.push(range.startUtc)
  }

  if (range.endUtc) {
    filters.push('created_at <= ?')
    params.push(range.endUtc)
  }

  if (scopeAttributed) {
    filters.push(attributionMatchCondition('contacts'))
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  const currentResult = await db.get(`${selectClause} ${whereClause}`, params)

  let previousResult = { ...DEFAULT_NUMBER }

  const previousRange = await fetchPreviousRange(range, range.isFiltered ? null : 'month')

  if (previousRange) {
    const previousFilters = ['created_at BETWEEN ? AND ?']
    const previousParams = [previousRange.startUtc, previousRange.endUtc]
    if (scopeAttributed) {
      previousFilters.push(attributionMatchCondition('contacts'))
    }
    previousResult = await db.get(
      `${selectClause} WHERE ${previousFilters.join(' AND ')}`,
      previousParams
    ) || { ...DEFAULT_NUMBER }
  }

  const metrics = {
    total: parseInt(currentResult?.total || 0),
    totalPrev: parseInt(previousResult?.total || 0),
    withAppointments: parseInt(currentResult?.with_appointments || 0),
    withAppointmentsPrev: parseInt(previousResult?.with_appointments || 0),
    customers: parseInt(currentResult?.customers || 0),
    customersPrev: parseInt(previousResult?.customers || 0),
    ltvTotal: parseFloat(currentResult?.ltv_total || 0),
    ltvTotalPrev: parseFloat(previousResult?.ltv_total || 0),
    avgLtv: parseFloat(currentResult?.avg_ltv || 0),
    avgLtvPrev: parseFloat(previousResult?.avg_ltv || 0)
  }

  return {
    range,
    metrics
  }
}

export async function buildContactTimeline ({ startDate, endDate, scope = 'all' } = {}, groupBy = 'day') {
  const range = resolveDateRange({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'

  const params = []
  const filters = []

  if (range.startUtc) {
    filters.push('created_at >= ?')
    params.push(range.startUtc)
  }

  if (range.endUtc) {
    filters.push('created_at <= ?')
    params.push(range.endUtc)
  }

  if (scopeAttributed) {
    filters.push(attributionMatchCondition('contacts'))
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  let dateExpression = 'DATE(created_at)'
  if (groupBy === 'month') {
    dateExpression = "strftime('%Y-%m', created_at)"
  } else if (groupBy === 'year') {
    dateExpression = "strftime('%Y', created_at)"
  }

  // Ajuste para Postgres
  if (isPostgres) {
    if (groupBy === 'month') {
      dateExpression = "TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM')"
    } else if (groupBy === 'year') {
      dateExpression = "TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY')"
    } else {
      dateExpression = "TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
    }
  }

  const timelineQuery = `
    SELECT
      ${dateExpression} as period,
      COUNT(DISTINCT ${dedupExpr}) as contacts,
      COUNT(DISTINCT CASE
        WHEN purchases_count > 0 THEN ${dedupExpr}
      END) as customers
    FROM contacts
    ${whereClause}
    GROUP BY period
    ORDER BY period
  `

  const rows = await db.all(timelineQuery, params)

  return {
    range,
    data: rows.map(row => ({
      period: row.period,
      contacts: Number(row.contacts || 0),
      customers: Number(row.customers || 0)
    }))
  }
}

export async function buildTransactionStats ({ startDate, endDate, scope = 'all' } = {}) {
  const range = resolveDateRange({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'

  const baseFilters = ['status = ?']
  const baseParams = ['succeeded']

  if (range.startUtc) {
    baseFilters.push('date >= ?')
    baseParams.push(range.startUtc)
  }

  if (range.endUtc) {
    baseFilters.push('date <= ?')
    baseParams.push(range.endUtc)
  }

  if (scopeAttributed) {
    baseFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${attributionMatchCondition('c')}
    )`)
  }

  const whereClause = `WHERE ${baseFilters.join(' AND ')}`

  const totalResult = await db.get(
    `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total, COALESCE(AVG(amount), 0) as average FROM payments ${whereClause}`,
    baseParams
  )

  const byMethodRows = await db.all(
    `SELECT payment_method, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments ${whereClause} GROUP BY payment_method`,
    baseParams
  )

  const statusFilters = []
  const statusParams = []

  if (range.startUtc) {
    statusFilters.push('date >= ?')
    statusParams.push(range.startUtc)
  }

  if (range.endUtc) {
    statusFilters.push('date <= ?')
    statusParams.push(range.endUtc)
  }

  if (scopeAttributed) {
    statusFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${attributionMatchCondition('c')}
    )`)
  }

  const statusWhereClause = statusFilters.length ? `WHERE ${statusFilters.join(' AND ')}` : ''
  const byStatusRows = await db.all(
    `SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payments ${statusWhereClause} GROUP BY status`,
    statusParams
  )

  return {
    range,
    stats: {
      total: {
        count: Number(totalResult?.count || 0),
        amount: Number(totalResult?.total || 0),
        average: Number(totalResult?.average || 0)
      },
      byMethod: byMethodRows.map(row => ({
        payment_method: row.payment_method,
        count: Number(row.count || 0),
        total: Number(row.total || 0)
      })),
      byStatus: byStatusRows.map(row => ({
        status: row.status,
        count: Number(row.count || 0),
        total: Number(row.total || 0)
      }))
    }
  }
}

export async function buildTransactionSummary ({ startDate, endDate, scope = 'all' } = {}) {
  const range = resolveDateRange({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'

  const successFilters = ['status = ?']
  const successParams = ['succeeded']

  if (range.startUtc) {
    successFilters.push('date >= ?')
    successParams.push(range.startUtc)
  }

  if (range.endUtc) {
    successFilters.push('date <= ?')
    successParams.push(range.endUtc)
  }

  if (scopeAttributed) {
    successFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${attributionMatchCondition('c')}
    )`)
  }

  const whereClause = `WHERE ${successFilters.join(' AND ')}`
  const currentResult = await db.get(
    `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total, COALESCE(AVG(amount), 0) as average FROM payments ${whereClause}`,
    successParams
  )

  const refundsFilters = ['status = ?']
  const refundsParams = ['refunded']

  if (range.startUtc) {
    refundsFilters.push('date >= ?')
    refundsParams.push(range.startUtc)
  }

  if (range.endUtc) {
    refundsFilters.push('date <= ?')
    refundsParams.push(range.endUtc)
  }

  if (scopeAttributed) {
    refundsFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${attributionMatchCondition('c')}
    )`)
  }

  const refundsWhere = `WHERE ${refundsFilters.join(' AND ')}`
  const refundsResult = await db.get(
    `SELECT COUNT(*) as count FROM payments ${refundsWhere}`,
    refundsParams
  )

  let previousResult = { count: 0, total: 0, average: 0 }
  let refundsPrevResult = { count: 0 }

  const previousRange = await fetchPreviousRange(range, range.isFiltered ? null : 'month')

  if (previousRange) {
    const prevSuccessFilters = ['status = ?', 'date BETWEEN ? AND ?']
    const prevSuccessParams = ['succeeded', previousRange.startUtc, previousRange.endUtc]
    if (scopeAttributed) {
      prevSuccessFilters.push(`contact_id IN (
        SELECT c.id FROM contacts c
        WHERE ${attributionMatchCondition('c')}
      )`)
    }
    previousResult = await db.get(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total, COALESCE(AVG(amount), 0) as average FROM payments WHERE ${prevSuccessFilters.join(' AND ')}`,
      prevSuccessParams
    ) || { count: 0, total: 0, average: 0 }

    const prevRefundFilters = ['status = ?', 'date BETWEEN ? AND ?']
    const prevRefundParams = ['refunded', previousRange.startUtc, previousRange.endUtc]
    if (scopeAttributed) {
      prevRefundFilters.push(`contact_id IN (
        SELECT c.id FROM contacts c
        WHERE ${attributionMatchCondition('c')}
      )`)
    }
    refundsPrevResult = await db.get(
      `SELECT COUNT(*) as count FROM payments WHERE ${prevRefundFilters.join(' AND ')}`,
      prevRefundParams
    ) || { count: 0 }
  }

  return {
    range,
    summary: {
      totalRevenue: parseFloat(currentResult?.total || 0),
      totalRevenuePrev: parseFloat(previousResult?.total || 0),
      completedPayments: parseInt(currentResult?.count || 0),
      completedPaymentsPrev: parseInt(previousResult?.count || 0),
      averageTicket: parseFloat(currentResult?.average || 0),
      averageTicketPrev: parseFloat(previousResult?.average || 0),
      refunds: parseInt(refundsResult?.count || 0),
      refundsPrev: parseInt(refundsPrevResult?.count || 0)
    }
  }
}

export async function buildCampaignSummary ({ startDate, endDate } = {}) {
  const range = resolveDateRange({ startDate, endDate })

  const hasRange = Boolean(range.startZoned && range.endZoned)
  const dedupExpr = buildDedupExpression('')

  let adsTotals
  let contactsTotals
  let adsTotalsPrev = { spend: 0, clicks: 0, reach: 0 }
  let contactsTotalsPrev = { leads: 0, sales: 0, revenue: 0 }

  if (hasRange) {
    const adsStart = range.startZoned.toISODate()
    const adsEnd = range.endZoned.toISODate()

    adsTotals = await db.get(
      `SELECT
        COALESCE(SUM(spend), 0) as spend,
        COALESCE(SUM(clicks), 0) as clicks,
        COALESCE(SUM(reach), 0) as reach
      FROM meta_ads
      WHERE date BETWEEN ? AND ?`,
      [adsStart, adsEnd]
    ) || { spend: 0, clicks: 0, reach: 0 }

    contactsTotals = await db.get(
      `SELECT
        COUNT(DISTINCT ${dedupExpr}) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 THEN ${dedupExpr}
        END) as sales,
        COALESCE(SUM(total_paid), 0) as revenue
      FROM contacts
      WHERE ${attributionMatchCondition('contacts')}
      AND created_at >= ?
      AND created_at <= ?`,
      [range.startUtc, range.endUtc]
    ) || { leads: 0, sales: 0, revenue: 0 }

    const previousRange = await fetchPreviousRange(range, null)

    if (previousRange) {
      const prevStartZoned = DateTime.fromISO(previousRange.startUtc, { zone: 'utc' }).setZone(range.appliedTimezone)
      const prevEndZoned = DateTime.fromISO(previousRange.endUtc, { zone: 'utc' }).setZone(range.appliedTimezone)

      const adsPrevStart = prevStartZoned.toISODate()
      const adsPrevEnd = prevEndZoned.toISODate()

      adsTotalsPrev = await db.get(
        `SELECT
          COALESCE(SUM(spend), 0) as spend,
          COALESCE(SUM(clicks), 0) as clicks,
          COALESCE(SUM(reach), 0) as reach
        FROM meta_ads
        WHERE date BETWEEN ? AND ?`,
        [adsPrevStart, adsPrevEnd]
      ) || { spend: 0, clicks: 0, reach: 0 }

      contactsTotalsPrev = await db.get(
        `SELECT
          COUNT(DISTINCT ${dedupExpr}) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 THEN ${dedupExpr}
          END) as sales,
          COALESCE(SUM(total_paid), 0) as revenue
        FROM contacts
        WHERE ${attributionMatchCondition('contacts')}
        AND created_at >= ?
        AND created_at <= ?`,
        [previousRange.startUtc, previousRange.endUtc]
      ) || { leads: 0, sales: 0, revenue: 0 }
    }
  } else {
    adsTotals = await db.get(
      `SELECT
        COALESCE(SUM(spend), 0) as spend,
        COALESCE(SUM(clicks), 0) as clicks,
        COALESCE(SUM(reach), 0) as reach
      FROM meta_ads`
    ) || { spend: 0, clicks: 0, reach: 0 }

    contactsTotals = await db.get(
      `SELECT
        COUNT(DISTINCT ${dedupExpr}) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 THEN ${dedupExpr}
        END) as sales,
        COALESCE(SUM(total_paid), 0) as revenue
      FROM contacts
      WHERE ${attributionMatchCondition('contacts')}`
    ) || { leads: 0, sales: 0, revenue: 0 }

    const rangeForFallback = await fetchPreviousRange(range, 'month')

    if (rangeForFallback) {
      const prevStartZoned = DateTime.fromISO(rangeForFallback.startUtc, { zone: 'utc' }).setZone(range.appliedTimezone)
      const prevEndZoned = DateTime.fromISO(rangeForFallback.endUtc, { zone: 'utc' }).setZone(range.appliedTimezone)

      const adsPrevStart = prevStartZoned.toISODate()
      const adsPrevEnd = prevEndZoned.toISODate()

      adsTotalsPrev = await db.get(
        `SELECT
          COALESCE(SUM(spend), 0) as spend,
          COALESCE(SUM(clicks), 0) as clicks,
          COALESCE(SUM(reach), 0) as reach
        FROM meta_ads
        WHERE date BETWEEN ? AND ?`,
        [adsPrevStart, adsPrevEnd]
      ) || { spend: 0, clicks: 0, reach: 0 }

      contactsTotalsPrev = await db.get(
        `SELECT
          COUNT(DISTINCT ${dedupExpr}) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 THEN ${dedupExpr}
          END) as sales,
          COALESCE(SUM(total_paid), 0) as revenue
        FROM contacts
        WHERE ${attributionMatchCondition('contacts')}
        AND created_at >= ?
        AND created_at <= ?`,
        [rangeForFallback.startUtc, rangeForFallback.endUtc]
      ) || { leads: 0, sales: 0, revenue: 0 }
    }
  }

  const spend = parseFloat(adsTotals.spend || 0)
  const revenue = parseFloat(contactsTotals.revenue || 0)
  const spendPrev = parseFloat(adsTotalsPrev.spend || 0)
  const revenuePrev = parseFloat(contactsTotalsPrev.revenue || 0)

  return {
    range,
    summary: {
      spend,
      spendPrev,
      clicks: parseInt(adsTotals.clicks || 0),
      clicksPrev: parseInt(adsTotalsPrev.clicks || 0),
      reach: parseInt(adsTotals.reach || 0),
      reachPrev: parseInt(adsTotalsPrev.reach || 0),
      leads: parseInt(contactsTotals.leads || 0),
      leadsPrev: parseInt(contactsTotalsPrev.leads || 0),
      sales: parseInt(contactsTotals.sales || 0),
      salesPrev: parseInt(contactsTotalsPrev.sales || 0),
      revenue,
      revenuePrev,
      roas: spend > 0 ? revenue / spend : 0,
      roasPrev: spendPrev > 0 ? revenuePrev / spendPrev : 0
    }
  }
}

function getGroupExpression(column, groupBy) {
  // America/Mexico_City timezone offset (UTC-6)
  const tzOffset = '-6 hours'

  if (groupBy === 'year') {
    return isPostgres
      ? `TO_CHAR(${column}::date, 'YYYY')`
      : `strftime('%Y', datetime(${column}, '${tzOffset}'))`
  }

  if (groupBy === 'month') {
    return isPostgres
      ? `TO_CHAR(${column}::date, 'YYYY-MM')`
      : `strftime('%Y-%m', datetime(${column}, '${tzOffset}'))`
  }

  // day
  return isPostgres
    ? `TO_CHAR(${column}::date, 'YYYY-MM-DD')`
    : `strftime('%Y-%m-%d', datetime(${column}, '${tzOffset}'))`
}

function buildRangeConditions(column, range, params) {
  const conditions = []

  if (range.startUtc) {
    conditions.push(`${column} >= ?`)
    params.push(range.startUtc)
  }

  if (range.endUtc) {
    conditions.push(`${column} <= ?`)
    params.push(range.endUtc)
  }

  return conditions
}

export async function buildReportMetrics ({ startDate, endDate, groupBy = 'day', scope = 'all' } = {}) {
  const range = resolveDateRange({ startDate, endDate })
  const isAttributed = scope === 'campaigns' || scope === 'attributed'
  const useContactAttribution = scope === 'campaigns' || scope === 'attributed'
  // "Todos" usa la fecha real del evento (pagos, citas, etc.).
  // "Última atribución" reasigna todas las métricas al día en que se creó el contacto.

  const periodMap = new Map()

  const contactParams = []
  const contactConditions = buildRangeConditions('created_at', range, contactParams)

  if (isAttributed) {
    contactConditions.push(attributionMatchCondition('contacts'))
  }

  const contactWhere = contactConditions.length ? `WHERE ${contactConditions.join(' AND ')}` : ''
  const contactGroupExpr = getGroupExpression('contacts.created_at', groupBy)

  // PASO 2: Obtener contactos individuales con su período
  const contactsRawQuery = `
    SELECT
      ${contactGroupExpr} as period,
      contacts.id as contact_id,
      contacts.email,
      contacts.phone,
      contacts.purchases_count
    FROM contacts
    ${contactWhere}
  `

  const contactsRaw = await db.all(contactsRawQuery, contactParams)

  // PASO 3: Agrupar por período con deduplicación
  const ensureBucket = (period) => {
    if (!periodMap.has(period)) {
      periodMap.set(period, {
        period,
        leads: 0,
        customers: 0,
        appointments: 0,
        spend: 0,
        clicks: 0,
        reach: 0,
        visitors: 0,
        revenue: 0,
        sales: 0,
        new_customers: 0,
        leadsSet: new Set(),
        customersSet: new Set(),
        appointmentsSet: new Set()
      })
    }
    return periodMap.get(period)
  }

  let contactKeyFallback = 0

  // Procesar contactos con deduplicación por teléfono
  contactsRaw.forEach(contact => {
    const bucket = ensureBucket(contact.period)
    const baseKey = buildContactKey(contact) ?? `contact-${contactKeyFallback++}`

    // Deduplicar leads
    bucket.leadsSet.add(baseKey)

    // Deduplicar customers
    if (contact.purchases_count > 0) {
      bucket.customersSet.add(baseKey)
    }
  })

  // PASO 4: Procesar appointments según el scope
  // Vista "Última atribución": Cuenta contactos con AL MENOS 1 cita (métrica de atribución)
  // - Se agrupa por FECHA DE CREACIÓN DEL CONTACTO
  // - Mide el impacto de las campañas en generar leads que agendan citas
  // - Si un contacto creado en enero agenda cita en febrero, se atribuye a enero
  // Vista "Todos": Agrupa por FECHA EN QUE SE AGENDÓ LA CITA
  // - Se agrupa por appointments.date_added (cuando se creó la cita en HighLevel)
  // - Refleja el flujo real de citas día a día

  if (useContactAttribution) {
    // Vista "Última atribución": Usar fecha de creación del contacto
    // Solo necesitamos saber SI el contacto tiene cita (híbrido DB + API)
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
    const attributionCalendarIds = await getAttributionCalendarIds()

    const contactsWithAppointments = config && config.api_token
      ? await getContactsWithAppointmentsHybrid(config.location_id, config.api_token, attributionCalendarIds)
      : new Set()

    logger.info(`📊 ${contactsWithAppointments.size} contactos con citas (híbrido DB + API - Reports atribución)`)

    contactsRaw.forEach(contact => {
      if (contactsWithAppointments.has(contact.contact_id)) {
        const bucket = ensureBucket(contact.period)
        const baseKey = buildContactKey(contact) ?? `contact-${contactKeyFallback++}`
        bucket.appointmentsSet.add(baseKey)
      }
    })
  } else {
    // Vista "Todos": Agrupar por dateAdded (híbrido DB + API)
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
    const attributionCalendarIds = await getAttributionCalendarIds()

    // Cargar de ambas fuentes en paralelo
    const [dbAppointments, apiAppointments] = await Promise.all([
      loadAppointmentsFromDB({
        calendarIds: attributionCalendarIds,
        startDate: range.startUtc,
        endDate: range.endUtc
      }),
      config && config.api_token
        ? loadAppointmentsFromAPI(config.location_id, config.api_token, attributionCalendarIds)
        : []
    ])

    logger.info(`📊 Reports - DB appointments: ${dbAppointments.length}, API appointments: ${apiAppointments.length}`)
    logger.info(`📊 Reports - Rango: ${range.startUtc} -> ${range.endUtc}`)

    // Combinar con deduplicación (tomar dateAdded más antiguo)
    const allAppointments = mergeAppointments(dbAppointments, apiAppointments, 'oldest_date')
    logger.info(`📊 Reports - Total merged: ${allAppointments.length}`)

    // Filtrar por rango de fechas de dateAdded
    const appointmentsInRange = allAppointments.filter(apt => {
      if (!apt.dateAdded) {
        logger.warn(`⚠️  Cita sin dateAdded: ${apt.id}`)
        return false
      }
      const dateAdded = new Date(apt.dateAdded)
      const start = new Date(range.startUtc)
      const end = new Date(range.endUtc)
      return dateAdded >= start && dateAdded <= end
    })

    logger.info(`📊 Reports - En rango: ${appointmentsInRange.length}`)
    if (appointmentsInRange.length > 0) {
      logger.info(`📊 Reports - Ejemplo de cita: ${JSON.stringify(appointmentsInRange[0])}`)
    }

    // Agrupar por período y deduplicar contactos
    appointmentsInRange.forEach(apt => {
      const dateAdded = new Date(apt.dateAdded)
      let periodKey

      if (groupBy === 'month') {
        periodKey = `${dateAdded.getFullYear()}-${String(dateAdded.getMonth() + 1).padStart(2, '0')}`
      } else if (groupBy === 'year') {
        periodKey = `${dateAdded.getFullYear()}`
      } else {
        periodKey = `${dateAdded.getFullYear()}-${String(dateAdded.getMonth() + 1).padStart(2, '0')}-${String(dateAdded.getDate()).padStart(2, '0')}`
      }

      const bucket = ensureBucket(periodKey)

      // Buscar contacto para deduplicar
      const contact = contactsRaw.find(c => c.contact_id === apt.contactId)
      if (contact) {
        const baseKey = buildContactKey(contact) ?? `contact-${contactKeyFallback++}`
        bucket.appointmentsSet.add(baseKey)
      }
    })

    logger.info(`📊 Appointments agrupados por dateAdded (híbrido DB + API - vista Todos - Reports tabla)`)
  }

  // Convertir sets a conteos
  periodMap.forEach((bucket) => {
    bucket.leads = bucket.leadsSet.size
    bucket.customers = bucket.customersSet.size
    bucket.new_customers = bucket.customersSet.size
    // Para vista atribución, appointments ya fueron agregados en appointmentsSet
    if (useContactAttribution) {
      bucket.appointments = bucket.appointmentsSet.size
    }
    // Limpiar sets temporales
    delete bucket.leadsSet
    delete bucket.customersSet
    delete bucket.appointmentsSet
  })


  const contactDedupExpr = buildDedupExpression('c')

  if (!useContactAttribution) {
    const paymentParams = []
    const paymentConditions = buildRangeConditions('p.date', range, paymentParams)

    applySuccessStatusFilter(paymentConditions, paymentParams, 'p')

    const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
    const paymentGroupExpr = getGroupExpression('p.date', groupBy)

    const paymentsQuery = `
      SELECT
        ${paymentGroupExpr} as period,
        COUNT(DISTINCT ${contactDedupExpr}) as unique_sales,
        COALESCE(SUM(p.amount), 0) as revenue
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ${paymentWhere}
      GROUP BY period
      ORDER BY period
    `

    const paymentRows = await db.all(paymentsQuery, paymentParams)

    paymentRows.forEach(row => {
      const period = row.period
      const bucket = ensureBucket(period)
      bucket.revenue += Number(row.revenue || 0)
      bucket.sales += Number(row.unique_sales || 0)
    })
  } else {
    const paymentParams = []
    const paymentConditions = buildRangeConditions('c.created_at', range, paymentParams)

    if (isAttributed) {
      paymentConditions.push(attributionMatchCondition('c'))
    }

    applySuccessStatusFilter(paymentConditions, paymentParams, 'p')

    const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
    const paymentGroupExpr = getGroupExpression('c.created_at', groupBy)

    const paymentsQuery = `
      SELECT
        ${paymentGroupExpr} as period,
        COUNT(DISTINCT CASE
          WHEN p.id IS NOT NULL THEN ${contactDedupExpr}
        END) as unique_sales,
        COALESCE(SUM(p.amount), 0) as revenue
      FROM contacts c
      LEFT JOIN payments p ON p.contact_id = c.id
      ${paymentWhere}
      GROUP BY period
      ORDER BY period
    `

    const paymentRows = await db.all(paymentsQuery, paymentParams)

    paymentRows.forEach(row => {
      const period = row.period
      const bucket = ensureBucket(period)
      bucket.revenue += Number(row.revenue || 0)
      bucket.sales += Number(row.unique_sales || 0)
    })
  }

  const spendParams = []
  const spendConditions = buildRangeConditions('date', range, spendParams)
  const spendWhere = spendConditions.length ? `WHERE ${spendConditions.join(' AND ')}` : ''
  const spendGroupExpr = getGroupExpression('meta_ads.date', groupBy)

  const spendQuery = `
      SELECT
      ${spendGroupExpr} as period,
      COALESCE(SUM(spend), 0) as spend,
      COALESCE(SUM(clicks), 0) as clicks,
      COALESCE(SUM(reach), 0) as reach
    FROM meta_ads
    ${spendWhere}
    GROUP BY period
    ORDER BY period
  `

  const spendRows = await db.all(spendQuery, spendParams)

  spendRows.forEach(row => {
    const period = row.period
    const bucket = ensureBucket(period)
    bucket.spend += Number(row.spend || 0)
    bucket.clicks += Number(row.clicks || 0)
    bucket.reach += Number(row.reach || 0)
    bucket.visitors += Number(row.clicks || 0)
  })

  // Las citas ahora se cuentan basadas en la fecha de creación del contacto,
  // no en la fecha de la cita, y ya se incluyen en el query de contactos arriba

  const metrics = Array.from(periodMap.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(item => ({
      date: item.period,
      spend: item.spend,
      revenue: item.revenue,
      leads: item.leads,
      customers: item.customers,
      appointments: item.appointments,
      sales: item.sales,
      clicks: item.clicks,
      reach: item.reach,
      visitors: item.visitors,
      new_customers: item.new_customers,
      roas: item.spend > 0 ? item.revenue / item.spend : 0,
      profit: item.revenue - item.spend
    }))


  return {
    range,
    metrics
  }
}

async function fetchPaymentsForContacts(contactIds, range = {}) {
  if (!contactIds.length) {
    return new Map()
  }

  const placeholders = contactIds.map(() => '?').join(',')
  const conditions = [`contact_id IN (${placeholders})`]
  const params = [...contactIds]

  if (range?.startUtc) {
    conditions.push('date >= ?')
    params.push(range.startUtc)
  }

  if (range?.endUtc) {
    conditions.push('date <= ?')
    params.push(range.endUtc)
  }

  const paymentsQuery = `
    SELECT id, contact_id, amount, status, date
    FROM payments
    WHERE ${conditions.join(' AND ')}
    ORDER BY date DESC
  `

  const rows = await db.all(paymentsQuery, params)

  return rows.reduce((map, row) => {
    const list = map.get(row.contact_id) || []
    list.push({
      id: row.id,
      amount: Number(row.amount || 0),
      status: row.status,
      date: row.date
    })
    map.set(row.contact_id, list)
    return map
  }, new Map())
}

async function fetchAppointmentsForContacts(contactIds, range = {}) {
  if (!contactIds.length) {
    return new Map()
  }

  const placeholders = contactIds.map(() => '?').join(',')
  const conditions = [`contact_id IN (${placeholders})`]
  const params = [...contactIds]

  if (range?.startUtc) {
    conditions.push('start_time >= ?')
    params.push(range.startUtc)
  }

  if (range?.endUtc) {
    conditions.push('start_time <= ?')
    params.push(range.endUtc)
  }

  // Filtrar por calendarios de atribución configurados
  const attributionCalendarIds = await getAttributionCalendarIds()
  if (attributionCalendarIds && attributionCalendarIds.length > 0) {
    const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',')
    conditions.push(`calendar_id IN (${calendarPlaceholders})`)
    params.push(...attributionCalendarIds)
  }

  const appointmentsQuery = `
    SELECT id, contact_id, title, status, start_time
    FROM appointments
    WHERE ${conditions.join(' AND ')}
    ORDER BY start_time DESC
  `

  const rows = await db.all(appointmentsQuery, params)

  return rows.reduce((map, row) => {
    const list = map.get(row.contact_id) || []
    list.push({
      id: row.id,
      title: row.title,
      status: row.status,
      start_time: row.start_time
    })
    map.set(row.contact_id, list)
    return map
  }, new Map())
}

export async function buildContactsList ({ startDate, endDate, type = 'interesados', scope = 'all' } = {}) {
  const range = resolveDateRange({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'
  const useContactAttribution = scope === 'campaigns' || scope === 'attributed'
  let contacts = []
  let contactIds = []
  let paymentsMap = new Map()
  let appointmentsMap = new Map()

  if (type === 'sales') {
    if (useContactAttribution) {
      const paymentParams = []
      const paymentConditions = buildRangeConditions('c.created_at', range, paymentParams)
      if (scopeAttributed) {
        paymentConditions.push(attributionMatchCondition('c'))
      }
      const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
      const paymentsQuery = `
        SELECT DISTINCT c.id as contact_id
        FROM contacts c
        INNER JOIN payments p ON p.contact_id = c.id
        ${paymentWhere}
      `
      const paymentContacts = await db.all(paymentsQuery, paymentParams)
      contactIds = paymentContacts.map(row => row.contact_id)
      paymentsMap = await fetchPaymentsForContacts(contactIds)
    } else {
      const paymentConditions = []
      const paymentParams = []
      if (range.startUtc) {
        paymentConditions.push('date >= ?')
        paymentParams.push(range.startUtc)
      }
      if (range.endUtc) {
        paymentConditions.push('date <= ?')
        paymentParams.push(range.endUtc)
      }
      if (scopeAttributed) {
        paymentConditions.push(`contact_id IN (
          SELECT c.id FROM contacts c
          WHERE ${attributionMatchCondition('c')}
        )`)
      }

      const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
      const paymentsQuery = `
        SELECT DISTINCT contact_id
        FROM payments
        ${paymentWhere}
      `
      const paymentContacts = await db.all(paymentsQuery, paymentParams)
      contactIds = paymentContacts.map(row => row.contact_id)
      paymentsMap = await fetchPaymentsForContacts(contactIds, range)
    }
  } else if (type === 'appointments') {
    if (useContactAttribution) {
      const appointmentParams = []
      const appointmentConditions = buildRangeConditions('c.created_at', range, appointmentParams)
      if (scopeAttributed) {
        appointmentConditions.push(attributionMatchCondition('c'))
      }

      // Filtrar por calendarios de atribución configurados
      const attributionCalendarIds = await getAttributionCalendarIds()
      if (attributionCalendarIds && attributionCalendarIds.length > 0) {
        const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',')
        appointmentConditions.push(`a.calendar_id IN (${calendarPlaceholders})`)
        appointmentParams.push(...attributionCalendarIds)
      }

      const appointmentWhere = appointmentConditions.length ? `WHERE ${appointmentConditions.join(' AND ')}` : ''
      const appointmentsQuery = `
        SELECT DISTINCT c.id as contact_id
        FROM contacts c
        INNER JOIN appointments a ON a.contact_id = c.id
        ${appointmentWhere}
      `
      const appointmentContacts = await db.all(appointmentsQuery, appointmentParams)
      contactIds = appointmentContacts.map(row => row.contact_id)
      appointmentsMap = await fetchAppointmentsForContacts(contactIds)
    } else {
      // Vista "Todos": Híbrido DB + API filtrado por dateAdded
      const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
      const attributionCalendarIds = await getAttributionCalendarIds()

      // Cargar de ambas fuentes en paralelo
      const [dbAppointments, apiAppointments] = await Promise.all([
        loadAppointmentsFromDB({
          calendarIds: attributionCalendarIds
        }),
        config && config.api_token
          ? loadAppointmentsFromAPI(config.location_id, config.api_token, attributionCalendarIds)
          : []
      ])

      // Combinar con deduplicación (tomar dateAdded más antiguo)
      const allAppointments = mergeAppointments(dbAppointments, apiAppointments, 'oldest_date')

      // Filtrar por rango de fechas de dateAdded
      const appointmentsInRange = allAppointments.filter(apt => {
        if (!apt.dateAdded) return false
        const dateAdded = new Date(apt.dateAdded)
        const start = range.startUtc ? new Date(range.startUtc) : null
        const end = range.endUtc ? new Date(range.endUtc) : null

        if (start && dateAdded < start) return false
        if (end && dateAdded > end) return false
        return true
      })

      // Extraer contact_ids únicos
      const contactIdsSet = new Set(appointmentsInRange.map(apt => apt.contactId))
      contactIds = Array.from(contactIdsSet)
      appointmentsMap = await fetchAppointmentsForContacts(contactIds, range)

      logger.info(`📊 ${contactIds.length} contactos con citas agendadas en el rango (híbrido DB + API - Reports modal)`)
    }
  }

  if (type === 'interesados' || type === 'customers') {
    const contactConditions = []
    const contactParams = []
    if (range.startUtc) {
      contactConditions.push('created_at >= ?')
      contactParams.push(range.startUtc)
    }
    if (range.endUtc) {
      contactConditions.push('created_at <= ?')
      contactParams.push(range.endUtc)
    }
    if (type === 'customers') {
      contactConditions.push('purchases_count > 0')
    }
    if (scopeAttributed) {
      contactConditions.push(attributionMatchCondition('contacts'))
    }

    const contactWhere = contactConditions.length ? `WHERE ${contactConditions.join(' AND ')}` : ''
    const contactsQuery = `
      SELECT
        id,
        full_name,
        email,
        phone,
        created_at,
        total_paid,
        purchases_count,
        attribution_ad_id,
        attribution_ad_name,
        source
      FROM contacts
      ${contactWhere}
      ORDER BY created_at DESC
    `

    contacts = await db.all(contactsQuery, contactParams)
    contactIds = contacts.map(contact => contact.id)
    paymentsMap = await fetchPaymentsForContacts(contactIds, useContactAttribution ? undefined : range)
  } else if (type === 'sales' || type === 'appointments') {
    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => '?').join(',')
      const contactsQuery = `
        SELECT
          id,
          full_name,
          email,
          phone,
          created_at,
          total_paid,
          purchases_count,
          attribution_ad_id,
          attribution_ad_name,
          source
        FROM contacts
        WHERE id IN (${placeholders})
        ${scopeAttributed ? `AND ${attributionMatchCondition('contacts')}` : ''}
        ORDER BY created_at DESC
      `
      contacts = await db.all(contactsQuery, contactIds)

      if (type === 'appointments') {
        paymentsMap = await fetchPaymentsForContacts(contactIds, useContactAttribution ? undefined : range)
      }
    } else {
      contacts = []
    }
  }

  const result = contacts.map(contact => {
    const payments = paymentsMap.get(contact.id) || []
    const appointments = appointmentsMap.get(contact.id) || []
    const totalFromPayments = payments.reduce((sum, payment) => sum + payment.amount, 0)

    // Para "customers" o vista "atribución", usar el LTV total histórico
    // Para "sales" en vista "Todos", usar solo pagos del período
    const useTotalLtv = type === 'customers' || type === 'interesados' || useContactAttribution
    const lifetimeLtv = contact.total_paid ? Number(contact.total_paid) : totalFromPayments
    const finalLtv = useTotalLtv ? lifetimeLtv : totalFromPayments
    const finalPurchases = useTotalLtv ? (contact.purchases_count || 0) : payments.length
    const lifetimePurchases = contact.purchases_count || 0
    const hasRangePayments = payments.some(payment => payment.amount > 0)
    const isCustomer = lifetimeLtv > 0 || lifetimePurchases > 0 || hasRangePayments

    return {
      id: contact.id,
      name: contact.full_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      created_at: contact.created_at,
      ltv: finalLtv,
      purchases: finalPurchases,
      attributed: Boolean(contact.attribution_ad_id),
      payments,
      appointments,
      source: contact.source || null,
      ad_name: contact.attribution_ad_name || null,
      ad_id: contact.attribution_ad_id || null,
      lifetimeLtv,
      lifetimePurchases,
      isCustomer,
      hasAppointments: appointments.length > 0
    }
  })


  return {
    range,
    contacts: result
  }
}
