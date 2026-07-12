import { logger } from '../utils/logger.js'
import { db } from '../config/database.js'
import {
  buildContactStats,
  buildContactTimeline,
  buildTransactionStats,
  buildTransactionSummary,
  buildCampaignSummary,
  buildReportMetrics,
  buildContactsList
} from '../services/analyticsService.js'
import {
  MANUAL_BUSINESS_EXPENSE_PERIODS,
  deleteManualBusinessExpenseDescendants,
  normalizeManualBusinessExpensePeriodStart,
  normalizeManualBusinessExpenseRow
} from '../services/manualBusinessExpensesService.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'
import { buildPaymentDisplay } from '../utils/paymentDisplay.js'
import { serializePaymentAmount } from '../utils/paymentAmountSerialization.js'
// (ACL-002) Excluir contactos ocultos en la lista de transacciones de reportes (LEFT JOIN expone PII).
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

const buildRangePayload = (range) => ({
  start: range.startUtc,
  end: range.endUtc,
  timezone: range.appliedTimezone,
  filtered: range.isFiltered
})

export const getContactsReport = async (req, res) => {
  try {
    const { from, to, groupBy = 'day', scope = 'all' } = req.query

    const { range, metrics } = await buildContactStats({ startDate: from, endDate: to, scope })
    const timelineResult = await buildContactTimeline({ startDate: from, endDate: to, scope }, groupBy)

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'todos'

    logger.info(`Reporte de contactos - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: {
        range: buildRangePayload(range),
        metrics,
        timeline: timelineResult.data
      }
    })
  } catch (error) {
    logger.error(`Error en getContactsReport: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener el reporte de contactos'
    })
  }
}

export const getPaymentsReport = async (req, res) => {
  try {
    const { from, to, scope = 'all' } = req.query

    const statsResult = await buildTransactionStats({ startDate: from, endDate: to, scope })
    const summaryResult = await buildTransactionSummary({ startDate: from, endDate: to, scope })

    const rangeLabel = statsResult.range.isFiltered
      ? `${statsResult.range.startUtc || '---'} -> ${statsResult.range.endUtc || '---'} (${statsResult.range.appliedTimezone})`
      : 'todos'

    logger.info(`Reporte de pagos - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: {
        range: buildRangePayload(statsResult.range),
        stats: statsResult.stats,
        summary: summaryResult.summary
      }
    })
  } catch (error) {
    logger.error(`Error en getPaymentsReport: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener el reporte de pagos'
    })
  }
}

export const getCampaignsReport = async (req, res) => {
  try {
    const { from, to } = req.query

    const { range, summary } = await buildCampaignSummary({ startDate: from, endDate: to })

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'default 30 días'

    logger.info(`Reporte de campañas - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: {
        range: buildRangePayload(range),
        summary
      }
    })
  } catch (error) {
    logger.error(`Error en getCampaignsReport: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener el reporte de campañas'
    })
  }
}

export const getSummary = async (req, res) => {
  try {
    const { from, to, scope = 'all' } = req.query

    const [contactsResult, paymentsSummary, campaignsSummary] = await Promise.all([
      buildContactStats({ startDate: from, endDate: to, scope }),
      buildTransactionSummary({ startDate: from, endDate: to, scope }),
      buildCampaignSummary({ startDate: from, endDate: to })
    ])

    logger.info('Reporte resumen consolidado generado')

    res.json({
      success: true,
      data: {
        range: buildRangePayload(contactsResult.range),
        contacts: contactsResult.metrics,
        payments: paymentsSummary.summary,
        campaigns: campaignsSummary.summary
      }
    })
  } catch (error) {
    logger.error(`Error en getSummary: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener el resumen de reportes'
    })
  }
}

export const getMetrics = async (req, res) => {
  try {
    const { from, to, groupBy = 'day', scope = 'all' } = req.query

    const { range, metrics } = await buildReportMetrics({
      startDate: from,
      endDate: to,
      groupBy,
      scope
    })

    logger.info('Reporte de métricas generado')

    res.json({
      success: true,
      data: {
        metrics,
        range: buildRangePayload(range)
      }
    })
  } catch (error) {
    logger.error(`Error en getMetrics: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener métricas'
    })
  }
}

export const getManualBusinessExpenses = async (req, res) => {
  try {
    const expenses = await db.all(`
      SELECT period_type, period_start, amount
      FROM report_manual_business_expenses
      ORDER BY period_start ASC, period_type ASC
    `)

    res.json({
      success: true,
      data: {
        expenses: expenses.map(normalizeManualBusinessExpenseRow)
      }
    })
  } catch (error) {
    logger.error(`Error en getManualBusinessExpenses: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener gastos manuales de negocio'
    })
  }
}

export const upsertManualBusinessExpense = async (req, res) => {
  try {
    const { period_type, period_start, amount } = req.body || {}
    const shouldDelete = req.body?.delete === true || req.body?.clear === true
    const shouldResetChildren = req.body?.reset_children === true || req.body?.resetChildren === true
    const periodType = String(period_type || '').trim()

    if (!MANUAL_BUSINESS_EXPENSE_PERIODS.has(periodType)) {
      return res.status(400).json({
        success: false,
        error: 'period_type debe ser "day", "month" o "year"'
      })
    }

    const normalizedPeriodStart = normalizeManualBusinessExpensePeriodStart(periodType, period_start)
    if (!normalizedPeriodStart) {
      return res.status(400).json({
        success: false,
        error: 'period_start no tiene un formato válido para el periodo'
      })
    }

    const runMutation = async (database) => {
      const deletedChildCount = shouldResetChildren
        ? await deleteManualBusinessExpenseDescendants(database, periodType, normalizedPeriodStart)
        : 0

      if (shouldDelete) {
        await database.run(`
          DELETE FROM report_manual_business_expenses
          WHERE period_type = ? AND period_start = ?
        `, [periodType, normalizedPeriodStart])

        return {
          expense: null,
          deletedChildCount
        }
      }

      const numericAmount = Number(amount)
      if (!Number.isFinite(numericAmount) || numericAmount < 0) {
        const validationError = new Error('amount debe ser un número válido')
        validationError.statusCode = 400
        throw validationError
      }

      await database.run(`
        INSERT INTO report_manual_business_expenses (period_type, period_start, amount, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(period_type, period_start) DO UPDATE SET
          amount = excluded.amount,
          updated_at = CURRENT_TIMESTAMP
      `, [periodType, normalizedPeriodStart, numericAmount])

      const expense = await database.get(`
        SELECT period_type, period_start, amount
        FROM report_manual_business_expenses
        WHERE period_type = ? AND period_start = ?
      `, [periodType, normalizedPeriodStart])

      return {
        expense: normalizeManualBusinessExpenseRow(expense),
        deletedChildCount
      }
    }

    const mutationResult = shouldResetChildren
      ? await db.transaction(runMutation)
      : await runMutation(db)

    res.json({
      success: true,
      data: {
        expense: mutationResult.expense,
        deleted_child_count: mutationResult.deletedChildCount
      }
    })
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({
        success: false,
        error: error.message
      })
    }

    logger.error(`Error en upsertManualBusinessExpense: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al guardar gasto manual de negocio'
    })
  }
}

export const getContactsList = async (req, res) => {
  try {
    const { from, to, type = 'interesados', scope = 'all', dedupe } = req.query

    const { range, contacts } = await buildContactsList({
      startDate: from,
      endDate: to,
      type,
      scope,
      // (MET-CONSIST) dedupe=person -> el modal colapsa por email/teléfono para empatar el
      // número de Reports (cuenta por persona). Dashboard no lo envía (cuenta por id).
      dedupeByPerson: dedupe === 'person'
    })

    logger.info(`Lista de contactos (${type}) generada: ${contacts.length} registros`)

    res.json({
      success: true,
      data: {
        contacts,
        range: buildRangePayload(range)
      }
    })
  } catch (error) {
    logger.error(`Error en getContactsList: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener la lista de contactos'
    })
  }
}

// (RPT-008) Tope duro para las listas de reportes: evita cargar miles de pagos en
// memoria y tumbar la instancia de 512MB (OOM/502) o que el reporte timeouté.
const REPORTS_LIST_MAX_LIMIT = 1000
const REPORTS_LIST_DEFAULT_LIMIT = 500

export const getTransactionsList = async (req, res) => {
  try {
    const { from, to, page, limit } = req.query

    // Importar db aquí para evitar problemas de importación circular
    const { db } = await import('../config/database.js')
    const { resolveDateRangeWithGHLTimezone } = await import('../utils/dateUtils.js')

    const range = await resolveDateRangeWithGHLTimezone({ startDate: from, endDate: to })

    const params = []
    const conditions = []

    // Solo contar transacciones exitosas
    const SUCCESS_PAYMENT_STATUSES = [
      'succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'
    ]
    const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')
    conditions.push(`LOWER(p.status) IN (${statusPlaceholders})`)
    conditions.push(nonTestPaymentCondition('p'))
    params.push(...SUCCESS_PAYMENT_STATUSES)

    if (range.startUtc) {
      conditions.push('p.date >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('p.date <= ?')
      params.push(range.endUtc)
    }

    // (ACL-002) Excluir filas cuyo contacto (LEFT JOIN c) cae bajo un filtro de ocultos.
    // Las transacciones sin contacto (c.* NULL) pasan gracias al COALESCE del filtro.
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // (RPT-008) Paginación con tope: nunca devolvemos toda la tabla de pagos de golpe.
    const limitNumber = Math.min(
      Math.max(Number(limit) || REPORTS_LIST_DEFAULT_LIMIT, 1),
      REPORTS_LIST_MAX_LIMIT
    )
    const pageNumber = Math.max(Number(page) || 1, 1)
    const offset = (pageNumber - 1) * limitNumber

    // (MET-CONSIST) COUNT y SUM se calculan sobre TODO el periodo (mismo WHERE que la
    // celda de la tabla), no sobre la página. Así el modal muestra el total real de
    // transacciones y el monto total real aunque la lista venga paginada por RPT-008.
    const countResult = await db.get(`SELECT COUNT(*) as total, COALESCE(SUM(p.amount), 0) as total_amount FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id ${whereClause}`, params)
    const total = Number(countResult?.total || 0)
    const totalAmount = Number(countResult?.total_amount || 0)
    const paymentDateSort = timestampSortExpression('p.date')
    const paymentCreatedSort = timestampSortExpression('p.created_at')

    const query = `
      SELECT
        p.id,
        p.contact_id,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone,
        p.amount,
        p.currency,
        p.status,
        p.date,
        p.payment_provider,
        p.payment_method,
        p.metadata_json,
        p.description
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ${whereClause}
      ORDER BY ${paymentDateSort} DESC, ${paymentCreatedSort} DESC, p.id DESC
      LIMIT ? OFFSET ?
    `

    const rows = await db.all(query, [...params, limitNumber, offset])
    const transactions = rows.map((row) => {
      const display = buildPaymentDisplay(row)
      const { metadata_json: _metadataJson, ...publicRow } = row
      return {
        ...publicRow,
        amount: serializePaymentAmount(row.amount),
        payment_method_category: display.paymentMethodCategory,
        payment_method_category_id: display.paymentMethodCategoryId,
        payment_type: display.paymentType,
        payment_channel: display.paymentChannel,
        payment_channel_id: display.paymentChannelId
      }
    })

    logger.info(`Lista de transacciones generada: ${transactions.length} de ${total} registros (página ${pageNumber}, límite ${limitNumber})`)

    res.json({
      success: true,
      data: {
        transactions,
        range: buildRangePayload(range),
        // (MET-CONSIST) Totales del periodo completo para que el modal empate con la celda.
        summary: {
          count: total,
          totalAmount
        },
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.ceil(total / limitNumber),
          hasNext: offset + transactions.length < total,
          hasPrev: pageNumber > 1
        }
      }
    })
  } catch (error) {
    logger.error(`Error en getTransactionsList: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener la lista de transacciones'
    })
  }
}
