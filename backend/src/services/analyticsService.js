import { db } from '../config/database.js'
import { DateTime } from 'luxon'
import { resolveDateRange } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'

const isPostgres = Boolean(process.env.DATABASE_URL)

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

  const selectClause = `
    SELECT
      COUNT(DISTINCT CASE
        WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
        THEN SUBSTR(phone, -10)
        ELSE id
      END) as total,
      COUNT(DISTINCT CASE
        WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
        THEN SUBSTR(phone, -10)
        WHEN purchases_count > 0
        THEN id
      END) as customers,
      COUNT(DISTINCT CASE
        WHEN appointment_date IS NOT NULL AND phone IS NOT NULL AND LENGTH(phone) >= 10
        THEN SUBSTR(phone, -10)
        WHEN appointment_date IS NOT NULL
        THEN id
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
      COUNT(DISTINCT CASE
        WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
        THEN SUBSTR(phone, -10)
        ELSE id
      END) as contacts,
      COUNT(DISTINCT CASE
        WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
        THEN SUBSTR(phone, -10)
        WHEN purchases_count > 0
        THEN id
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
        COUNT(DISTINCT CASE
          WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
          THEN SUBSTR(phone, -10)
          ELSE id
        END) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
          THEN SUBSTR(phone, -10)
          WHEN purchases_count > 0
          THEN id
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
          COUNT(DISTINCT CASE
            WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
            THEN SUBSTR(phone, -10)
            ELSE id
          END) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
            THEN SUBSTR(phone, -10)
            WHEN purchases_count > 0
            THEN id
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
        COUNT(DISTINCT CASE
          WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
          THEN SUBSTR(phone, -10)
          ELSE id
        END) as leads,
        COUNT(DISTINCT CASE
          WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
          THEN SUBSTR(phone, -10)
          WHEN purchases_count > 0
          THEN id
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
          COUNT(DISTINCT CASE
            WHEN phone IS NOT NULL AND LENGTH(phone) >= 10
            THEN SUBSTR(phone, -10)
            ELSE id
          END) as leads,
          COUNT(DISTINCT CASE
            WHEN purchases_count > 0 AND phone IS NOT NULL AND LENGTH(phone) >= 10
            THEN SUBSTR(phone, -10)
            WHEN purchases_count > 0
            THEN id
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
  const contactGroupExpr = getGroupExpression('created_at', groupBy)

  // IMPORTANTE: Columna "appointments" cuenta contactos con AL MENOS 1 cita (métrica de atribución)
  // Se agrupa por FECHA DE CREACIÓN DEL CONTACTO, no por fecha de cita:
  // - Esto mide el impacto real de las campañas en generar leads que agendan citas
  // - Si un contacto creado en enero agenda cita en febrero, se atribuye a enero
  // - Un contacto con múltiples citas cuenta como 1 (métrica binaria: tiene o no tiene cita)
  // - Se maneja deduplicación por teléfono para evitar contar el mismo contacto múltiples veces

  // PASO 1: Obtener contactos individuales con su período y estado de citas en DB
  const contactsRawQuery = `
    SELECT
      ${contactGroupExpr} as period,
      contacts.id as contact_id,
      contacts.phone,
      contacts.purchases_count,
      CASE WHEN a.contact_id IS NOT NULL THEN 1 ELSE 0 END as has_appointment_db
    FROM contacts
    LEFT JOIN (
      SELECT DISTINCT contact_id
      FROM appointments
      WHERE contact_id IS NOT NULL
    ) a ON a.contact_id = contacts.id
    ${contactWhere}
  `

  const contactsRaw = await db.all(contactsRawQuery, contactParams)

  logger.info(`[CITAS REPORTS] Total contactos en período: ${contactsRaw.length}`)
  logger.info(`[CITAS REPORTS] Contactos CON citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 1).length}`)
  logger.info(`[CITAS REPORTS] Contactos SIN citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 0).length}`)

  // PASO 2: Fallback a HighLevel API para contactos sin citas en DB
  const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
  const contactsWithAppointments = new Set()

  // Primero agregar los que ya tienen citas en DB
  contactsRaw.forEach(c => {
    if (c.has_appointment_db === 1) {
      contactsWithAppointments.add(c.contact_id)
    }
  })

  // Obtener contactos que NO tienen citas en DB para verificar en HighLevel
  const contactsToCheck = contactsRaw.filter(c => c.has_appointment_db === 0)

  if (config && config.api_token && contactsToCheck.length > 0) {
    // Batch de 50 contactos simultáneos (HighLevel permite 200k requests/día)
    const batchSize = 50
    logger.info(`[CITAS REPORTS] Verificando ${contactsToCheck.length} contactos sin citas en DB...`)

    for (let i = 0; i < contactsToCheck.length; i += batchSize) {
      const batch = contactsToCheck.slice(i, i + batchSize)
      const progress = Math.min(i + batchSize, contactsToCheck.length)
      logger.info(`[CITAS REPORTS] Procesando batch ${Math.floor(i/batchSize) + 1}: ${progress}/${contactsToCheck.length} contactos...`)

      // Hacer llamadas en paralelo para este batch
      const appointmentChecks = await Promise.all(
        batch.map(async (contact) => {
          try {
            const response = await fetch(
              `https://services.leadconnectorhq.com/contacts/${contact.contact_id}/appointments`,
              {
                headers: {
                  'Authorization': `Bearer ${config.api_token}`,
                  'Version': '2021-07-28'
                }
              }
            )

            if (response.ok) {
              const data = await response.json()
              if (data.events && data.events.length > 0) {
                logger.info(`[CITAS REPORTS] Contacto ${contact.contact_id} tiene ${data.events.length} citas en HighLevel`)

                // Guardar en DB para cache futuro
                for (const event of data.events) {
                  await db.run(`
                    INSERT INTO appointments (id, contact_id, calendar_id, location_id, title, status, start_time, end_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      status = excluded.status,
                      start_time = excluded.start_time,
                      end_time = excluded.end_time
                  `, [
                    event.id,
                    contact.contact_id,
                    event.calendarId || '',
                    event.locationId || config.location_id,
                    event.title || '',
                    event.status || 'scheduled',
                    event.startTime || '',
                    event.endTime || ''
                  ]).catch(err => {
                    logger.error(`Error guardando cita ${event.id}:`, err)
                  })
                }

                return { contactId: contact.contact_id, hasAppointments: true }
              }
            }
            return { contactId: contact.contact_id, hasAppointments: false }
          } catch (error) {
            logger.error(`Error verificando citas para contacto ${contact.contact_id}:`, error)
            return { contactId: contact.contact_id, hasAppointments: false }
          }
        })
      )

      // Actualizar el set con los contactos que tienen citas
      appointmentChecks.forEach(result => {
        if (result.hasAppointments) {
          contactsWithAppointments.add(result.contactId)
        }
      })

      logger.info(`[CITAS REPORTS] Batch ${Math.floor(i/batchSize) + 1} completado. Total con citas hasta ahora: ${contactsWithAppointments.size}`)
    }

    logger.info(`[CITAS REPORTS] Fallback completado. Total contactos con citas (DB + API): ${contactsWithAppointments.size}`)
  } else {
    if (contactsToCheck.length > 0) {
      logger.info(`[CITAS REPORTS] No se puede hacer fallback: ${!config ? 'Sin config de HighLevel' : 'Sin API token'}`)
    }
  }

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

  // Procesar contactos con deduplicación por teléfono
  contactsRaw.forEach(contact => {
    const bucket = ensureBucket(contact.period)

    // Deduplicar leads
    const leadKey = (contact.phone && contact.phone.length >= 10)
      ? contact.phone.slice(-10)
      : contact.contact_id
    bucket.leadsSet.add(leadKey)

    // Deduplicar customers
    if (contact.purchases_count > 0) {
      const customerKey = (contact.phone && contact.phone.length >= 10)
        ? contact.phone.slice(-10)
        : contact.contact_id
      bucket.customersSet.add(customerKey)
    }

    // Deduplicar appointments
    if (contactsWithAppointments.has(contact.contact_id)) {
      const apptKey = (contact.phone && contact.phone.length >= 10)
        ? contact.phone.slice(-10)
        : contact.contact_id
      bucket.appointmentsSet.add(apptKey)
    }
  })

  // Convertir sets a conteos
  periodMap.forEach((bucket) => {
    bucket.leads = bucket.leadsSet.size
    bucket.customers = bucket.customersSet.size
    bucket.appointments = bucket.appointmentsSet.size
    bucket.new_customers = bucket.customersSet.size
    // Limpiar sets temporales
    delete bucket.leadsSet
    delete bucket.customersSet
    delete bucket.appointmentsSet
  })

  logger.info(`[CITAS REPORTS] Total contactos con citas: ${contactsWithAppointments.size}/${contactsRaw.length} (${Math.round(contactsWithAppointments.size * 100 / Math.max(contactsRaw.length, 1))}%)`)

  if (!useContactAttribution) {
    const paymentParams = []
    const paymentConditions = buildRangeConditions('date', range, paymentParams)

    if (isAttributed) {
      paymentConditions.push(`contact_id IN (
        SELECT c.id FROM contacts c
        WHERE ${attributionMatchCondition('c')}
      )`)
    }

    const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
    const paymentGroupExpr = getGroupExpression('date', groupBy)

    const paymentsQuery = `
      SELECT
        ${paymentGroupExpr} as period,
        COUNT(DISTINCT CASE
          WHEN c.phone IS NOT NULL AND LENGTH(c.phone) >= 10
          THEN SUBSTR(c.phone, -10)
          ELSE p.contact_id
        END) as unique_sales,
        COALESCE(SUM(p.amount), 0) as revenue
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ${paymentWhere.replace('date', 'p.date')}
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

    const paymentWhere = paymentConditions.length ? `WHERE ${paymentConditions.join(' AND ')}` : ''
    const paymentGroupExpr = getGroupExpression('c.created_at', groupBy)

    const paymentsQuery = `
      SELECT
        ${paymentGroupExpr} as period,
        COUNT(DISTINCT CASE
          WHEN p.id IS NOT NULL AND c.phone IS NOT NULL AND LENGTH(c.phone) >= 10
          THEN SUBSTR(c.phone, -10)
          WHEN p.id IS NOT NULL
          THEN c.id
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
  const spendGroupExpr = getGroupExpression('date', groupBy)

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

  // LOG CONSOLIDADO PARA DEBUGGING
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const timestamp = new Date().toISOString()
  const scopeLabel = scope === 'all' ? 'TODOS' : 'ÚLTIMA ATRIBUCIÓN'
  logger.info(`\n🔵 ========== [${requestId}] REPORTS ${scopeLabel} - MÉTRICAS ==========`)
  logger.info(`⏰ Timestamp: ${timestamp}`)
  logger.info(`📅 Rango: ${range.startUtc} → ${range.endUtc}`)
  logger.info(`📊 Agrupación: ${groupBy}`)
  logger.info(`📈 Total períodos: ${metrics.length}`)

  const totals = metrics.reduce((sum, m) => ({
    leads: sum.leads + m.leads,
    appointments: sum.appointments + m.appointments,
    sales: sum.sales + m.sales,
    visitors: sum.visitors + m.visitors,
    customers: sum.customers + m.customers,
    spend: sum.spend + m.spend,
    revenue: sum.revenue + m.revenue
  }), { leads: 0, appointments: 0, sales: 0, visitors: 0, customers: 0, spend: 0, revenue: 0 })

  logger.info(`\n💰 TOTALES GENERALES:`)
  logger.info(`   Leads: ${totals.leads}`)
  logger.info(`   Citas: ${totals.appointments}`)
  logger.info(`   Visitantes: ${totals.visitors}`)
  logger.info(`   Ventas: ${totals.sales}`)
  logger.info(`   Clientes: ${totals.customers}`)
  logger.info(`   Gasto: $${totals.spend.toFixed(2)}`)
  logger.info(`   Ingresos: $${totals.revenue.toFixed(2)}`)

  if (metrics.length <= 10) {
    logger.info(`\n📋 DETALLE POR PERÍODO:`)
    metrics.forEach(m => {
      logger.info(`   ${m.period}: Leads=${m.leads}, Citas=${m.appointments}, Visitantes=${m.visitors}, Ventas=${m.sales}`)
    })
  }
  logger.info(`🔵 ========== FIN [${requestId}] ==========\n`)

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
      // Vista "Todos": Usar lógica híbrida (DB + API) para appointments
      logger.info(`[CITAS REPORTS TODOS] Buscando citas con lógica híbrida (DB + API)...`)

      // PASO 1: Obtener contactos en el rango de fechas
      const contactConditionsTemp = []
      const contactParamsTemp = []
      if (range.startUtc) {
        contactConditionsTemp.push('created_at >= ?')
        contactParamsTemp.push(range.startUtc)
      }
      if (range.endUtc) {
        contactConditionsTemp.push('created_at <= ?')
        contactParamsTemp.push(range.endUtc)
      }
      const contactWhereTemp = contactConditionsTemp.length ? `WHERE ${contactConditionsTemp.join(' AND ')}` : ''

      const contactsQuery = `
        SELECT DISTINCT
          c.id,
          CASE WHEN a.contact_id IS NOT NULL THEN 1 ELSE 0 END as has_appointment_db
        FROM contacts c
        LEFT JOIN (
          SELECT DISTINCT contact_id
          FROM appointments
          WHERE contact_id IS NOT NULL
        ) a ON a.contact_id = c.id
        ${contactWhereTemp}
      `
      const contactsRaw = await db.all(contactsQuery, contactParamsTemp)

      logger.info(`[CITAS REPORTS TODOS] Total contactos en período: ${contactsRaw.length}`)
      logger.info(`[CITAS REPORTS TODOS] Contactos CON citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 1).length}`)
      logger.info(`[CITAS REPORTS TODOS] Contactos SIN citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 0).length}`)

      // PASO 2: Lógica híbrida (DB + API)
      const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
      const contactsWithAppointments = new Set()

      // Agregar los que ya tienen citas en DB
      contactsRaw.forEach(c => {
        if (c.has_appointment_db === 1) {
          contactsWithAppointments.add(c.id)
        }
      })

      // Verificar contactos sin citas en DB usando API
      const contactsToCheck = contactsRaw.filter(c => c.has_appointment_db === 0)

      if (config && config.api_token && contactsToCheck.length > 0) {
        const batchSize = 50
        logger.info(`[CITAS REPORTS TODOS] Verificando ${contactsToCheck.length} contactos sin citas en DB...`)

        for (let i = 0; i < contactsToCheck.length; i += batchSize) {
          const batch = contactsToCheck.slice(i, i + batchSize)

          const appointmentChecks = await Promise.all(
            batch.map(async (contact) => {
              try {
                const response = await fetch(
                  `https://services.leadconnectorhq.com/contacts/${contact.id}/appointments`,
                  {
                    headers: {
                      'Authorization': `Bearer ${config.api_token}`,
                      'Version': '2021-07-28'
                    }
                  }
                )

                if (response.ok) {
                  const data = await response.json()
                  if (data.events && data.events.length > 0) {
                    logger.info(`[CITAS REPORTS TODOS] Contacto ${contact.id} tiene ${data.events.length} citas en HighLevel`)

                    // Guardar en DB para cache futuro
                    for (const event of data.events) {
                      await db.run(`
                        INSERT INTO appointments (id, contact_id, calendar_id, location_id, title, status, start_time, end_time)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                          status = excluded.status,
                          start_time = excluded.start_time,
                          end_time = excluded.end_time
                      `, [
                        event.id,
                        contact.id,
                        event.calendarId || '',
                        event.locationId || config.location_id,
                        event.title || '',
                        event.status || 'scheduled',
                        event.startTime || '',
                        event.endTime || ''
                      ]).catch(err => {
                        logger.error(`Error guardando cita ${event.id}:`, err)
                      })
                    }

                    return { contactId: contact.id, hasAppointments: true }
                  }
                }
                return { contactId: contact.id, hasAppointments: false }
              } catch (error) {
                logger.error(`Error verificando citas para contacto ${contact.id}:`, error)
                return { contactId: contact.id, hasAppointments: false }
              }
            })
          )

          appointmentChecks.forEach(result => {
            if (result.hasAppointments) {
              contactsWithAppointments.add(result.contactId)
            }
          })
        }
      }

      contactIds = Array.from(contactsWithAppointments)
      logger.info(`[CITAS REPORTS TODOS] Total contactos con citas (DB + API): ${contactIds.length}`)
      appointmentsMap = await fetchAppointmentsForContacts(contactIds, range)
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
    const finalLtv = useTotalLtv ? (contact.total_paid ? Number(contact.total_paid) : totalFromPayments) : totalFromPayments
    const finalPurchases = useTotalLtv ? (contact.purchases_count || 0) : payments.length

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
      ad_id: contact.attribution_ad_id || null
    }
  })

  // LOG CONSOLIDADO PARA MODAL
  const scopeLabel = scope === 'all' ? 'TODOS' : 'ÚLTIMA ATRIBUCIÓN'
  logger.info(`\n========== MODAL ${type.toUpperCase()} - ${scopeLabel} ==========`)
  logger.info(`📅 Rango: ${range.startUtc} → ${range.endUtc}`)
  logger.info(`📊 Total contactos: ${result.length}`)

  if (type === 'appointments') {
    const withAppts = result.filter(c => c.appointments && c.appointments.length > 0).length
    logger.info(`   Contactos con citas: ${withAppts}`)
    logger.info(`   Contactos sin citas: ${result.length - withAppts}`)
  } else if (type === 'sales') {
    const withPayments = result.filter(c => c.payments && c.payments.length > 0).length
    logger.info(`   Contactos con pagos: ${withPayments}`)
  }

  if (result.length <= 20) {
    logger.info(`\n📋 LISTA DE CONTACTOS:`)
    result.forEach((c, idx) => {
      const apptCount = c.appointments?.length || 0
      const paymentCount = c.payments?.length || 0
      logger.info(`   ${idx + 1}. ${c.name} (${c.email}) - Citas: ${apptCount}, Pagos: ${paymentCount}`)
    })
  }
  logger.info(`=================================================\n`)

  return {
    range,
    contacts: result
  }
}
