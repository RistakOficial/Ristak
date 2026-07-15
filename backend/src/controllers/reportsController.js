import { logger } from '../utils/logger.js'
import { db } from '../config/database.js'
import {
  buildContactStats,
  buildContactTimeline,
  buildTransactionStats,
  buildTransactionSummary,
  buildCampaignSummary
} from '../services/analyticsService.js'
import { buildAggregatedReportMetrics } from '../services/reportMetricsAggregationService.js'
import { listReportContactsPage } from '../services/reportContactsPaginationService.js'
import { listReportTransactionsPage } from '../services/reportTransactionsPaginationService.js'
import { getReportsSnapshot as getReportsSnapshotReadModel } from '../services/reportsSnapshotService.js'
import {
  MANUAL_BUSINESS_EXPENSE_PERIODS,
  deleteManualBusinessExpenseDescendants,
  normalizeManualBusinessExpensePeriodStart,
  normalizeManualBusinessExpenseRow
} from '../services/manualBusinessExpensesService.js'

const buildRangePayload = (range) => ({
  start: range.startUtc,
  end: range.endUtc,
  timezone: range.appliedTimezone,
  filtered: range.isFiltered
})

function createReportsRequestAbortScope(req, res) {
  const controller = new AbortController()
  let disconnected = Boolean(req.aborted || res.destroyed)
  const abortIfDisconnected = () => {
    disconnected = true
    if (!res.writableEnded && !res.finished && !controller.signal.aborted) {
      controller.abort()
    }
  }

  req.once?.('aborted', abortIfDisconnected)
  res.once?.('close', abortIfDisconnected)
  if (req.aborted) abortIfDisconnected()

  return {
    signal: controller.signal,
    get disconnected() {
      return disconnected || Boolean(req.aborted) || Boolean(res.destroyed) || res.writable === false
    },
    cleanup() {
      req.off?.('aborted', abortIfDisconnected)
      res.off?.('close', abortIfDisconnected)
      req.removeListener?.('aborted', abortIfDisconnected)
      res.removeListener?.('close', abortIfDisconnected)
    }
  }
}

function isReportsRequestAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

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

    const { range, metrics } = await buildAggregatedReportMetrics({
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

export const getReportsSnapshot = async (req, res) => {
  const requestScope = createReportsRequestAbortScope(req, res)
  try {
    const { from, to, groupBy = 'day', scope = 'all' } = req.query
    const snapshot = await getReportsSnapshotReadModel({
      principal: req.user?.userId || req.user?.id || req.user?.email || 'authenticated-user',
      startDate: from,
      endDate: to,
      groupBy,
      scope,
      waitForFresh: req.query.waitForFresh === '1' || req.query.waitForFresh === 'true',
      signal: requestScope.signal
    })

    if (requestScope.disconnected || requestScope.signal.aborted || res.writableEnded || res.finished) return
    logger.info(`Snapshot unificado de Reportes generado (${snapshot.metrics.length} periodos)`)
    res.json({ success: true, data: snapshot })
  } catch (error) {
    if (isReportsRequestAbort(error) || requestScope.signal.aborted) {
      logger.info('Snapshot de Reportes cancelado porque el cliente abandono la vista')
      if (!requestScope.disconnected && !res.headersSent && !res.writableEnded && !res.finished) {
        res.status(499).json({ success: false, error: 'Consulta cancelada' })
      }
      return
    }
    logger.error(`Error en getReportsSnapshot: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error al obtener el snapshot de reportes'
    })
  } finally {
    requestScope.cleanup()
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
    const { from, to, type = 'interesados', scope = 'all', dedupe, search, cursor, limit } = req.query

    const { range, contacts, pagination } = await listReportContactsPage({
      startDate: from,
      endDate: to,
      type,
      scope,
      // (MET-CONSIST) dedupe=person -> el modal colapsa por email/teléfono para empatar el
      // número de Reports (cuenta por persona). Dashboard no lo envía (cuenta por id).
      dedupeByPerson: dedupe === 'person',
      search,
      cursor,
      limit
    })

    logger.info(`Página de contactos (${type}) generada: ${contacts.length} registros`)

    res.json({
      success: true,
      data: {
        contacts,
        range: buildRangePayload(range),
        pagination
      }
    })
  } catch (error) {
    logger.error(`Error en getContactsList: ${error.message}`)
    const status = Number(error?.status) || 500
    if (status === 503 && error?.retryAfter) {
      res.set?.('Retry-After', String(error.retryAfter))
    }
    res.status(status).json({
      success: false,
      error: status === 503 ? error.message : 'Error al obtener la lista de contactos',
      ...(status === 503
        ? {
            code: error.code,
            retriable: Boolean(error.retriable),
            projection: error.projection,
            projectionStatus: error.projectionStatus
          }
        : {})
    })
  }
}

export const getTransactionsList = async (req, res) => {
  try {
    const result = await listReportTransactionsPage({
      startDate: req.query.from,
      endDate: req.query.to,
      search: req.query.search,
      cursor: req.query.cursor,
      page: req.query.page,
      limit: req.query.limit
    })

    logger.info(`Página de transacciones generada: ${result.transactions.length} registros (límite ${result.pagination.limit})`)

    res.json({
      success: true,
      data: {
        transactions: result.transactions,
        range: buildRangePayload(result.range),
        summary: result.summary,
        pagination: result.pagination
      }
    })
  } catch (error) {
    logger.error(`Error en getTransactionsList: ${error.message}`)
    const status = Number(error?.status) || 500
    res.status(status).json({
      success: false,
      error: status < 500 ? error.message : 'Error al obtener la lista de transacciones'
    })
  }
}
