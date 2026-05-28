import { db } from '../config/database.js'
import { DateTime } from 'luxon'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import {
  getContactsWithAppointmentsHybrid,
  getContactsWithShowedAppointmentsHybrid,
  loadAppointmentsFromDB,
  loadAppointmentsFromAPI,
  mergeAppointments
} from './appointmentsMerge.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns'

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

  // Aplicar filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
  if (hiddenCondition) {
    filters.push(hiddenCondition)
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
    if (hiddenCondition) {
      previousFilters.push(hiddenCondition)
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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns'
  const timezone = range.appliedTimezone
  const dedupExpr = buildDedupExpression('')

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

  // Aplicar filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
  if (hiddenCondition) {
    filters.push(hiddenCondition)
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  // Usar getGroupExpression para timezone dinámico
  const dateExpression = getGroupExpression('created_at', groupBy, timezone)

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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns'

  // Obtener filtro de contactos ocultos
  const { getHiddenContactFilters, buildHiddenContactsCondition } = await import('../utils/hiddenContactsFilter.js')
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', true)

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

  // Filtrar por contactos (ocultos + atribución si aplica)
  const contactConditions = []
  if (hiddenCondition) {
    contactConditions.push(hiddenCondition.replace('AND ', ''))
  }
  if (scopeAttributed) {
    contactConditions.push(attributionMatchCondition('c'))
  }

  if (contactConditions.length > 0) {
    baseFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${contactConditions.join(' AND ')}
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

  // Aplicar mismo filtro de contactos para stats por status
  if (contactConditions.length > 0) {
    statusFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${contactConditions.join(' AND ')}
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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const scopeAttributed = scope === 'campaigns'

  // Obtener filtro de contactos ocultos
  const { getHiddenContactFilters, buildHiddenContactsCondition } = await import('../utils/hiddenContactsFilter.js')
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', true)

  // Construir condiciones de contacto (ocultos + atribución)
  const contactConditions = []
  if (hiddenCondition) {
    contactConditions.push(hiddenCondition.replace('AND ', ''))
  }
  if (scopeAttributed) {
    contactConditions.push(attributionMatchCondition('c'))
  }

  // Usar TODOS los status válidos de pago (no solo 'succeeded')
  const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')
  const successFilters = [`status IN (${statusPlaceholders})`]
  const successParams = [...SUCCESS_PAYMENT_STATUSES]

  if (range.startUtc) {
    successFilters.push('date >= ?')
    successParams.push(range.startUtc)
  }

  if (range.endUtc) {
    successFilters.push('date <= ?')
    successParams.push(range.endUtc)
  }

  if (contactConditions.length > 0) {
    successFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${contactConditions.join(' AND ')}
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

  if (contactConditions.length > 0) {
    refundsFilters.push(`contact_id IN (
      SELECT c.id FROM contacts c
      WHERE ${contactConditions.join(' AND ')}
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
    const prevStatusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')
    const prevSuccessFilters = [`status IN (${prevStatusPlaceholders})`, 'date BETWEEN ? AND ?']
    const prevSuccessParams = [...SUCCESS_PAYMENT_STATUSES, previousRange.startUtc, previousRange.endUtc]
    if (contactConditions.length > 0) {
      prevSuccessFilters.push(`contact_id IN (
        SELECT c.id FROM contacts c
        WHERE ${contactConditions.join(' AND ')}
      )`)
    }
    previousResult = await db.get(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total, COALESCE(AVG(amount), 0) as average FROM payments WHERE ${prevSuccessFilters.join(' AND ')}`,
      prevSuccessParams
    ) || { count: 0, total: 0, average: 0 }

    const prevRefundFilters = ['status = ?', 'date BETWEEN ? AND ?']
    const prevRefundParams = ['refunded', previousRange.startUtc, previousRange.endUtc]
    if (contactConditions.length > 0) {
      prevRefundFilters.push(`contact_id IN (
        SELECT c.id FROM contacts c
        WHERE ${contactConditions.join(' AND ')}
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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

  const hasRange = Boolean(range.startZoned && range.endZoned)
  const dedupExpr = buildDedupExpression('')

  // Aplicar filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

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

    const contactConditions = [attributionMatchCondition('contacts'), 'created_at >= ?', 'created_at <= ?']
    if (hiddenCondition) contactConditions.push(hiddenCondition)

    contactsTotals = await db.get(
      `SELECT
        COUNT(DISTINCT ${dedupExpr}) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 THEN ${dedupExpr}
        END) as sales,
        COALESCE(SUM(total_paid), 0) as revenue
      FROM contacts
      WHERE ${contactConditions.join(' AND ')}`,
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

      const prevContactConditions = [attributionMatchCondition('contacts'), 'created_at >= ?', 'created_at <= ?']
      if (hiddenCondition) prevContactConditions.push(hiddenCondition)

      contactsTotalsPrev = await db.get(
        `SELECT
          COUNT(DISTINCT ${dedupExpr}) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 THEN ${dedupExpr}
          END) as sales,
          COALESCE(SUM(total_paid), 0) as revenue
        FROM contacts
        WHERE ${prevContactConditions.join(' AND ')}`,
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

    const allContactConditions = [attributionMatchCondition('contacts')]
    if (hiddenCondition) allContactConditions.push(hiddenCondition)

    contactsTotals = await db.get(
      `SELECT
        COUNT(DISTINCT ${dedupExpr}) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 THEN ${dedupExpr}
        END) as sales,
        COALESCE(SUM(total_paid), 0) as revenue
      FROM contacts
      WHERE ${allContactConditions.join(' AND ')}`
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

      const fallbackContactConditions = [attributionMatchCondition('contacts'), 'created_at >= ?', 'created_at <= ?']
      if (hiddenCondition) fallbackContactConditions.push(hiddenCondition)

      contactsTotalsPrev = await db.get(
        `SELECT
          COUNT(DISTINCT ${dedupExpr}) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 THEN ${dedupExpr}
          END) as sales,
          COALESCE(SUM(total_paid), 0) as revenue
        FROM contacts
        WHERE ${fallbackContactConditions.join(' AND ')}`,
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

export function getGroupExpression(column, groupBy, timezone = 'America/Mexico_City') {
  // Para SQLite, convertir timezone IANA a offset en horas
  // Nota: SQLite no soporta timezone names, solo offsets numéricos
  // Por ahora usamos el offset de Mexico City como default
  const tzOffset = '-6 hours' // TODO: calcular dinámicamente desde timezone IANA

  if (!isPostgres) {
    if (groupBy === 'year') {
      return `strftime('%Y', datetime(${column}, '${tzOffset}'))`
    }

    if (groupBy === 'month') {
      return `strftime('%Y-%m', datetime(${column}, '${tzOffset}'))`
    }

    return `strftime('%Y-%m-%d', datetime(${column}, '${tzOffset}'))`
  }

  const safeTimezone = (timezone || 'UTC').replace(/'/g, "''")
  const columnExpr = `((${column})::timestamptz AT TIME ZONE 'UTC' AT TIME ZONE '${safeTimezone}')`

  if (groupBy === 'year') {
    return `TO_CHAR(${columnExpr}, 'YYYY')`
  }

  if (groupBy === 'month') {
    return `TO_CHAR(${columnExpr}, 'YYYY-MM')`
  }

  // day
  return `TO_CHAR(${columnExpr}, 'YYYY-MM-DD')`
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
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  // scope = 'all' → agrupa por fecha del evento (pagos, citas reales)
  // scope = 'attribution' → agrupa por fecha creación contacto (todos los contactos)
  // scope = 'campaigns' → agrupa por fecha creación contacto + filtro ad_id

  // useContactAttribution: TRUE para ambas vistas de atribución (attribution y campaigns)
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns'

  // isAttributed: TRUE solo para campaigns (último toque desde anuncio con filtro de ad_id)
  const isAttributed = scope === 'campaigns'

  // "Todos" usa la fecha real del evento (pagos, citas, etc.).
  // "Último toque" / "Último toque desde anuncio" reasigna todas las métricas al día en que se creó el contacto.

  const periodMap = new Map()

  // Timezone dinámico de HighLevel (ya resuelto en range.appliedTimezone)
  const timezone = range.appliedTimezone

  const contactParams = []
  const contactConditions = buildRangeConditions('created_at', range, contactParams)

  if (isAttributed) {
    contactConditions.push(attributionMatchCondition('contacts'))
  }

  // Aplicar filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
  if (hiddenCondition) {
    contactConditions.push(hiddenCondition)
  }

  const contactWhere = contactConditions.length ? `WHERE ${contactConditions.join(' AND ')}` : ''
  const contactGroupExpr = getGroupExpression('contacts.created_at', groupBy, timezone)

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
        attendances: 0,
        spend: 0,
        clicks: 0,
        reach: 0,
        visitors: 0,
        revenue: 0,
        sales: 0,
        new_customers: 0,
        leadsSet: new Set(),
        customersSet: new Set(),
        appointmentsSet: new Set(),
        attendancesSet: new Set()
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

    // Combinar con deduplicación (tomar dateAdded más antiguo)
    const allAppointments = mergeAppointments(dbAppointments, apiAppointments, 'oldest_date')

    // Filtrar por rango de fechas de dateAdded
    const appointmentsInRange = allAppointments.filter(apt => {
      if (!apt.dateAdded) {
        return false
      }
      const dateAdded = new Date(apt.dateAdded)
      const start = new Date(range.startUtc)
      const end = new Date(range.endUtc)
      return dateAdded >= start && dateAdded <= end
    })

    // Agrupar por período y deduplicar contactos
    let matchedContacts = 0
    let unmatchedContacts = 0
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
        matchedContacts++
        const baseKey = buildContactKey(contact) ?? `contact-${contactKeyFallback++}`
        bucket.appointmentsSet.add(baseKey)
      } else {
        unmatchedContacts++
      }
    })
  }

  // PASO 4.5: Asistencias siempre se atribuye por fecha de creación del contacto.
  const attendanceConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
  const attendanceCalendarIds = await getAttributionCalendarIds()
  const contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
    attendanceConfig?.location_id,
    attendanceConfig?.api_token,
    attendanceCalendarIds
  )

  contactsRaw.forEach(contact => {
    if (contactsWithAttendances.has(contact.contact_id)) {
      const bucket = ensureBucket(contact.period)
      const baseKey = buildContactKey(contact) ?? `contact-${contactKeyFallback++}`
      bucket.attendancesSet.add(baseKey)
    }
  })

  // PASO 5: Contar clientes nuevos según el scope
  // Vista "Última atribución": Cliente nuevo = contacto con purchases_count > 0, agrupado por fecha de creación del contacto
  // Vista "Todos": Cliente nuevo = fecha del PRIMER PAGO (no fecha de creación)
  const newCustomersMap = new Map() // period -> Set de customer keys

  if (!useContactAttribution) {
    // Vista "Todos": Agrupar por fecha del PRIMER PAGO
    // Subquery para obtener la fecha del primer pago de cada contacto
    const firstPaymentSubquery = `
      SELECT contact_id, MIN(date) as first_payment_date
      FROM payments
      WHERE LOWER(status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')})
      GROUP BY contact_id
    `

    const firstPaymentsParams = [...SUCCESS_PAYMENT_STATUSES]
    const firstPaymentsConditions = []

    if (range.startUtc) {
      firstPaymentsConditions.push('first_p.first_payment_date >= ?')
      firstPaymentsParams.push(range.startUtc)
    }

    if (range.endUtc) {
      firstPaymentsConditions.push('first_p.first_payment_date <= ?')
      firstPaymentsParams.push(range.endUtc)
    }

    const firstPaymentGroupExpr = getGroupExpression('first_p.first_payment_date', groupBy, timezone)

    // Query principal: obtener contactos con su fecha de primer pago
    // Aplicar filtro de contactos ocultos
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    if (hiddenConditionC) {
      firstPaymentsConditions.push(hiddenConditionC)
    }

    const firstPaymentsWhere = firstPaymentsConditions.length ? `WHERE ${firstPaymentsConditions.join(' AND ')}` : ''

    const firstPaymentsQuery = `
      SELECT
        ${firstPaymentGroupExpr} as period,
        c.id as contact_id,
        c.email,
        c.phone
      FROM contacts c
      INNER JOIN (${firstPaymentSubquery}) first_p ON first_p.contact_id = c.id
      ${firstPaymentsWhere}
    `

    const firstPaymentsRaw = await db.all(firstPaymentsQuery, firstPaymentsParams)

    // Agrupar por período con deduplicación
    firstPaymentsRaw.forEach(row => {
      const period = row.period
      if (!newCustomersMap.has(period)) {
        newCustomersMap.set(period, new Set())
      }
      const customerSet = newCustomersMap.get(period)
      const baseKey = buildContactKey(row) ?? `contact-${row.contact_id}`
      customerSet.add(baseKey)
    })
  } else {
    // Vista "Última atribución" / "Último toque desde anuncio":
    // Cliente nuevo = contacto con purchases_count > 0
    // Agrupa por fecha de CREACIÓN del contacto (NO primer pago)
    // Ya procesamos estos contactos en contactsRaw (PASO 2), solo necesitamos contarlos
    contactsRaw.forEach(contact => {
      if (contact.purchases_count > 0) {
        const period = contact.period
        if (!newCustomersMap.has(period)) {
          newCustomersMap.set(period, new Set())
        }
        const customerSet = newCustomersMap.get(period)
        const baseKey = buildContactKey(contact) ?? `contact-${contact.contact_id}`
        customerSet.add(baseKey)
      }
    })
  }

  // Convertir sets a conteos
  periodMap.forEach((bucket) => {
    bucket.leads = bucket.leadsSet.size
    bucket.customers = bucket.customersSet.size
    // new_customers siempre viene de newCustomersMap (ya procesado según el scope arriba)
    bucket.new_customers = newCustomersMap.has(bucket.period) ? newCustomersMap.get(bucket.period).size : 0
    bucket.appointments = bucket.appointmentsSet.size  // ✅ Siempre convertir appointments
    bucket.attendances = bucket.attendancesSet.size
    // Limpiar sets temporales
    delete bucket.leadsSet
    delete bucket.customersSet
    delete bucket.appointmentsSet
    delete bucket.attendancesSet
  })


  const contactDedupExpr = buildDedupExpression('c')

  if (!useContactAttribution) {
    const paymentParams = []
    const paymentConditions = buildRangeConditions('p.date', range, paymentParams)

    applySuccessStatusFilter(paymentConditions, paymentParams, 'p')

    const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
    const paymentGroupExpr = getGroupExpression('p.date', groupBy, timezone)

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
    const paymentGroupExpr = getGroupExpression('c.created_at', groupBy, timezone)

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
  const spendConditions = []

  // IMPORTANTE: meta_ads.date es TEXT con formato YYYY-MM-DD.
  // Debemos comparar contra fechas YYYY-MM-DD en timezone de GHL, no contra startUtc/endUtc con hora.
  if (range.startZoned) {
    spendConditions.push('date >= ?')
    spendParams.push(range.startZoned.toISODate())
  }

  if (range.endZoned) {
    spendConditions.push('date <= ?')
    spendParams.push(range.endZoned.toISODate())
  }

  const spendWhere = spendConditions.length ? `WHERE ${spendConditions.join(' AND ')}` : ''
  const spendGroupExpr = getGroupExpression('meta_ads.date', groupBy, timezone)

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
  })

  // PASO 6: Procesar VISITANTES según el scope
  // Vista "Todos": Agrupa por fecha de la sesión (started_at)
  // Vista "Última atribución": Agrupa por fecha de creación del contacto (created_at)
  if (!useContactAttribution) {
    // Vista "Todos": visitantes por fecha de sesión
    const visitorsParams = []
    const visitorsConditions = buildRangeConditions('started_at', range, visitorsParams)
    const visitorsWhere = visitorsConditions.length ? `WHERE ${visitorsConditions.join(' AND ')}` : ''
    const visitorsGroupExpr = getGroupExpression('started_at', groupBy, timezone)

    const visitorsQuery = `
      SELECT
        ${visitorsGroupExpr} as period,
        COUNT(DISTINCT visitor_id) as visitors
      FROM sessions
      ${visitorsWhere}
      GROUP BY period
      ORDER BY period
    `

    const visitorsRows = await db.all(visitorsQuery, visitorsParams)

    visitorsRows.forEach(row => {
      const period = row.period
      const bucket = ensureBucket(period)
      bucket.visitors += Number(row.visitors || 0)
    })
  } else {
    // Vista "Última atribución": visitantes que SE CONVIRTIERON en contacto
    // Agrupa por fecha de creación del contacto
    const visitorsParams = []
    const visitorsConditions = buildRangeConditions('c.created_at', range, visitorsParams)

    if (isAttributed) {
      visitorsConditions.push(attributionMatchCondition('c'))
    }

    const visitorsWhere = visitorsConditions.length ? `WHERE ${visitorsConditions.join(' AND ')}` : ''
    const visitorsGroupExpr = getGroupExpression('c.created_at', groupBy, timezone)

    const visitorsQuery = `
      SELECT
        ${visitorsGroupExpr} as period,
        COUNT(DISTINCT s.visitor_id) as visitors
      FROM sessions s
      INNER JOIN contacts c ON c.id = s.contact_id
      ${visitorsWhere}
      GROUP BY period
      ORDER BY period
    `

    const visitorsRows = await db.all(visitorsQuery, visitorsParams)

    visitorsRows.forEach(row => {
      const period = row.period
      const bucket = ensureBucket(period)
      bucket.visitors += Number(row.visitors || 0)
    })
  }

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
      attendances: item.attendances,
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

  // IMPORTANTE: NO filtrar pagos por rango de fechas
  // El modal debe mostrar TODOS los pagos del cliente, independientemente del rango seleccionado
  // El filtro de fechas solo aplica para determinar QUÉ contactos mostrar, no sus pagos completos
  const paymentsQuery = `
    SELECT id, contact_id, amount, status, date
    FROM payments
    WHERE contact_id IN (${placeholders})
    ORDER BY date DESC
  `

  const rows = await db.all(paymentsQuery, contactIds)

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
  const params = [...contactIds]

  // IMPORTANTE: NO filtrar citas por rango de fechas (start_time)
  // El modal debe mostrar TODAS las citas del cliente, independientemente del rango seleccionado
  // El filtro de fechas solo aplica para determinar QUÉ contactos mostrar, no sus citas completas

  // Filtrar por calendarios de atribución configurados
  const attributionCalendarIds = await getAttributionCalendarIds()
  let calendarCondition = ''
  if (attributionCalendarIds && attributionCalendarIds.length > 0) {
    const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',')
    calendarCondition = ` AND calendar_id IN (${calendarPlaceholders})`
    params.push(...attributionCalendarIds)
  }

  const appointmentsQuery = `
    SELECT id, contact_id, title, status, appointment_status, start_time
    FROM appointments
    WHERE contact_id IN (${placeholders})${calendarCondition}
    ORDER BY start_time DESC
  `

  const rows = await db.all(appointmentsQuery, params)

  return rows.reduce((map, row) => {
    const list = map.get(row.contact_id) || []
    list.push({
      id: row.id,
      title: row.title,
      status: row.appointment_status || row.status,
      start_time: row.start_time
    })
    map.set(row.contact_id, list)
    return map
  }, new Map())
}

export async function buildContactsList ({ startDate, endDate, type = 'interesados', scope = 'all' } = {}) {
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns'
  const scopeAttributed = scope === 'campaigns'
  let contacts = []
  let contactIds = []

  // Aplicar filtro de contactos ocultos (para usar en todas las queries)
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

  // ========================================
  // PASO 1: Obtener contactIds según el tipo de filtro
  // ========================================
  if (type === 'sales') {
    if (useContactAttribution) {
      const paymentParams = []
      const paymentConditions = buildRangeConditions('c.created_at', range, paymentParams)
      if (scopeAttributed) {
        paymentConditions.push(attributionMatchCondition('c'))
      }
      // CRÍTICO: Filtrar solo pagos exitosos (consistente con la tabla)
      applySuccessStatusFilter(paymentConditions, paymentParams, 'p')
      if (hiddenConditionC) {
        paymentConditions.push(hiddenConditionC)
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
      // CRÍTICO: Filtrar solo pagos exitosos (consistente con la tabla)
      applySuccessStatusFilter(paymentConditions, paymentParams, 'payments')
      if (hiddenCondition) {
        paymentConditions.push(`contact_id IN (SELECT id FROM contacts WHERE ${hiddenCondition})`)
      }

      const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
      const paymentsQuery = `
        SELECT DISTINCT contact_id
        FROM payments
        ${paymentWhere}
      `
      const paymentContacts = await db.all(paymentsQuery, paymentParams)
      contactIds = paymentContacts.map(row => row.contact_id)
    }
  } else if (type === 'attendances') {
    const attendanceParams = []
    const attendanceConditions = buildRangeConditions('c.created_at', range, attendanceParams)
    if (scopeAttributed) {
      attendanceConditions.push(attributionMatchCondition('c'))
    }
    if (hiddenConditionC) {
      attendanceConditions.push(hiddenConditionC)
    }

    const attendanceWhere = attendanceConditions.length ? `WHERE ${attendanceConditions.join(' AND ')}` : ''
    const attendanceCandidates = await db.all(`
      SELECT c.id as contact_id
      FROM contacts c
      ${attendanceWhere}
    `, attendanceParams)
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
    const attributionCalendarIds = await getAttributionCalendarIds()
    const contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
      config?.location_id,
      config?.api_token,
      attributionCalendarIds
    )

    contactIds = attendanceCandidates
      .map(row => row.contact_id)
      .filter(contactId => contactsWithAttendances.has(contactId))
  } else if (type === 'appointments') {
    if (useContactAttribution) {
      const appointmentParams = []
      const appointmentConditions = buildRangeConditions('c.created_at', range, appointmentParams)
      if (scopeAttributed) {
        appointmentConditions.push(attributionMatchCondition('c'))
      }
      if (hiddenConditionC) {
        appointmentConditions.push(hiddenConditionC)
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
    }
  } else if (type === 'interesados' || type === 'customers') {
    if (type === 'customers' && !useContactAttribution) {
      // Vista "Todos": Clientes nuevos = contactos cuyo PRIMER PAGO está en el rango
      const firstPaymentSubquery = `
        SELECT contact_id, MIN(date) as first_payment_date
        FROM payments
        WHERE LOWER(status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')})
        GROUP BY contact_id
      `

      const firstPaymentsParams = [...SUCCESS_PAYMENT_STATUSES]
      const firstPaymentsConditions = []

      if (range.startUtc) {
        firstPaymentsConditions.push('first_p.first_payment_date >= ?')
        firstPaymentsParams.push(range.startUtc)
      }

      if (range.endUtc) {
        firstPaymentsConditions.push('first_p.first_payment_date <= ?')
        firstPaymentsParams.push(range.endUtc)
      }

      // Aplicar filtro de contactos ocultos
      if (hiddenConditionC) {
        firstPaymentsConditions.push(hiddenConditionC)
      }

      const firstPaymentsWhere = firstPaymentsConditions.length ? `WHERE ${firstPaymentsConditions.join(' AND ')}` : ''

      const firstPaymentsQuery = `
        SELECT DISTINCT c.id
        FROM contacts c
        INNER JOIN (${firstPaymentSubquery}) first_p ON first_p.contact_id = c.id
        ${firstPaymentsWhere}
      `

      const contactsResult = await db.all(firstPaymentsQuery, firstPaymentsParams)
      contactIds = contactsResult.map(row => row.id)
    } else {
      // Vista "Último toque" / "Último toque desde anuncio": Usar created_at
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
      if (hiddenCondition) {
        contactConditions.push(hiddenCondition)
      }

      const contactWhere = contactConditions.length ? `WHERE ${contactConditions.join(' AND ')}` : ''
      const contactsQuery = `
        SELECT id
        FROM contacts
        ${contactWhere}
      `

      const contactsResult = await db.all(contactsQuery, contactParams)
      contactIds = contactsResult.map(row => row.id)
    }
  }

  // ========================================
  // PASO 2: Obtener información completa de los contactos
  // ========================================
  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',')
    const additionalConditions = []
    if (scopeAttributed) {
      additionalConditions.push(attributionMatchCondition('contacts'))
    }
    if (hiddenCondition) {
      additionalConditions.push(hiddenCondition)
    }
    const additionalWhere = additionalConditions.length ? ` AND ${additionalConditions.join(' AND ')}` : ''

    const contactsQuery = `
      SELECT
        contacts.id,
        contacts.full_name,
        contacts.email,
        contacts.phone,
        contacts.created_at,
        contacts.total_paid,
        contacts.purchases_count,
        contacts.attribution_ad_id,
        contacts.attribution_ad_name,
        contacts.source,
        meta_ads.campaign_id,
        meta_ads.campaign_name,
        meta_ads.adset_id,
        meta_ads.adset_name,
        meta_ads.ad_name as meta_ad_name
      FROM contacts
      LEFT JOIN meta_ads ON meta_ads.ad_id = contacts.attribution_ad_id
      WHERE contacts.id IN (${placeholders})${additionalWhere}
      GROUP BY contacts.id,
               contacts.full_name,
               contacts.email,
               contacts.phone,
               contacts.created_at,
               contacts.total_paid,
               contacts.purchases_count,
               contacts.attribution_ad_id,
               contacts.attribution_ad_name,
               contacts.source,
               meta_ads.campaign_id,
               meta_ads.campaign_name,
               meta_ads.adset_id,
               meta_ads.adset_name,
               meta_ads.ad_name
      ORDER BY contacts.created_at DESC
    `
    contacts = await db.all(contactsQuery, contactIds)
  } else {
    contacts = []
  }

  // ========================================
  // PASO 3: SIEMPRE cargar TODA la información (payments, appointments, firstSession)
  // ========================================
  let paymentsMap = new Map()
  let appointmentsMap = new Map()
  let firstSessionMap = new Map()
  let contactsWithAttendances = new Set()

  if (contactIds.length > 0) {
    // Cargar payments para todos
    paymentsMap = await fetchPaymentsForContacts(contactIds, useContactAttribution ? undefined : range)

    // Cargar appointments para todos
    appointmentsMap = await fetchAppointmentsForContacts(contactIds)

    const attendanceConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
    const attributionCalendarIds = await getAttributionCalendarIds()
    contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
      attendanceConfig?.location_id,
      attendanceConfig?.api_token,
      attributionCalendarIds
    )

    // Cargar primera sesión (primera atribución) para todos
    const placeholders = contactIds.map(() => '?').join(',')
    const firstSessionsQuery = `
      SELECT
        s1.contact_id,
        s1.started_at,
        s1.page_url,
        s1.referrer_url,
        s1.utm_source,
        s1.utm_medium,
        s1.utm_campaign,
        s1.utm_content,
        s1.utm_term,
        s1.source_platform,
        s1.site_source_name,
        s1.campaign_name,
        s1.ad_name,
        s1.ad_id,
        s1.device_type,
        s1.browser,
        s1.geo_city,
        s1.geo_region,
        s1.geo_country
      FROM sessions s1
      INNER JOIN (
        SELECT contact_id, MIN(started_at) as first_started_at
        FROM sessions
        WHERE contact_id IN (${placeholders})
        GROUP BY contact_id
      ) s2 ON s1.contact_id = s2.contact_id AND s1.started_at = s2.first_started_at
    `

    const firstSessionRows = await db.all(firstSessionsQuery, contactIds)

    firstSessionMap = firstSessionRows.reduce((map, session) => {
      map.set(session.contact_id, {
        started_at: session.started_at,
        page_url: session.page_url,
        referrer_url: session.referrer_url,
        utm_source: session.utm_source,
        utm_medium: session.utm_medium,
        utm_campaign: session.utm_campaign,
        utm_content: session.utm_content,
        utm_term: session.utm_term,
        source_platform: session.source_platform,
        site_source_name: session.site_source_name,
        campaign_name: session.campaign_name,
        ad_name: session.ad_name,
        ad_id: session.ad_id,
        device_type: session.device_type,
        browser: session.browser,
        geo_city: session.geo_city,
        geo_region: session.geo_region,
        geo_country: session.geo_country
      })
      return map
    }, new Map())
  }

  const result = contacts.map(contact => {
    const payments = paymentsMap.get(contact.id) || []
    const appointments = appointmentsMap.get(contact.id) || []
    const firstSession = firstSessionMap.get(contact.id) || null
    // CRÍTICO: Solo sumar pagos exitosos, NO incluir refunded/cancelled
    const validStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
    const totalFromPayments = payments
      .filter(payment => validStatuses.includes(payment.status?.toLowerCase()))
      .reduce((sum, payment) => sum + payment.amount, 0)

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
      firstSession,
      source: contact.source || null,
      ad_name: contact.attribution_ad_name || contact.meta_ad_name || null,
      ad_id: contact.attribution_ad_id || null,
      campaign_id: contact.campaign_id || null,
      campaign_name: contact.campaign_name || null,
      adset_id: contact.adset_id || null,
      adset_name: contact.adset_name || null,
      lifetimeLtv,
      lifetimePurchases,
      isCustomer,
      hasAppointments: appointments.length > 0,
      hasShowedAppointment: contactsWithAttendances.has(contact.id),
      hasAttendedAppointment: contactsWithAttendances.has(contact.id)
    }
  })


  return {
    range,
    contacts: result
  }
}
