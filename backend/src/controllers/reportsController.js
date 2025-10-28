import { logger } from '../utils/logger.js'
import {
  buildContactStats,
  buildContactTimeline,
  buildTransactionStats,
  buildTransactionSummary,
  buildCampaignSummary,
  buildReportMetrics,
  buildContactsList
} from '../services/analyticsService.js'

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

export const getContactsList = async (req, res) => {
  try {
    const { from, to, type = 'interesados', scope = 'all' } = req.query

    const { range, contacts } = await buildContactsList({
      startDate: from,
      endDate: to,
      type,
      scope
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

export const getTransactionsList = async (req, res) => {
  try {
    const { from, to } = req.query

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
    params.push(...SUCCESS_PAYMENT_STATUSES)

    if (range.startUtc) {
      conditions.push('p.date >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('p.date <= ?')
      params.push(range.endUtc)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const query = `
      SELECT
        p.id,
        p.contact_id,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone,
        p.amount,
        p.status,
        p.date,
        p.payment_method,
        p.description
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ${whereClause}
      ORDER BY p.date DESC
    `

    const transactions = await db.all(query, params)

    logger.info(`Lista de transacciones generada: ${transactions.length} registros`)

    res.json({
      success: true,
      data: {
        transactions,
        range: buildRangePayload(range)
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
