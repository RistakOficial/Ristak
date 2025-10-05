import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { resolveDateRange } from '../utils/dateUtils.js'
import { buildTransactionStats, buildTransactionSummary } from '../services/analyticsService.js'

/**
 * Obtiene todas las transacciones/pagos con paginación y filtros
 */
export const getTransactions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status = '',
      startDate,
      endDate,
      sortBy = 'date',
      sortOrder = 'DESC'
    } = req.query

    const pageNumber = Number(page) || 1
    const limitNumber = Math.min(Number(limit) || 50, 500)
    const offset = Math.max((pageNumber - 1) * limitNumber, 0)

    const range = resolveDateRange({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo transacciones - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    const filters = []
    const params = []

    if (status) {
      filters.push('p.status = ?')
      params.push(status)
    }

    if (range.startUtc) {
      filters.push('p.date >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      filters.push('p.date <= ?')
      params.push(range.endUtc)
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const countResult = await db.get(`SELECT COUNT(*) as total FROM payments p ${whereClause}`, params)
    const totalTransactions = countResult?.total || 0

    const sortableMap = {
      date: 'p.date',
      created_at: 'p.created_at',
      amount: 'p.amount',
      status: 'p.status'
    }

    const safeSortBy = sortableMap[sortBy] || 'p.date'
    const orderDirection = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

    const transactionsQuery = `
      SELECT
        p.id,
        p.contact_id,
        p.amount,
        p.currency,
        p.status,
        p.payment_method,
        p.reference,
        p.description,
        p.date,
        p.created_at,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone
      FROM payments p
      LEFT JOIN contacts c ON p.contact_id = c.id
      ${whereClause}
      ORDER BY ${safeSortBy} ${orderDirection}
      LIMIT ? OFFSET ?
    `

    const transactions = await db.all(transactionsQuery, [...params, limitNumber, offset])

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedTransactions = transactions.map(t => ({
      id: t.id,
      date: t.date,
      contactId: t.contact_id,
      contactName: t.contact_name || '',
      email: t.contact_email || '',
      phone: t.contact_phone || '',
      amount: t.amount,
      currency: t.currency,
      method: t.payment_method || 'other',
      status: t.status === 'succeeded' ? 'paid' : t.status,
      reference: t.reference,
      description: t.description,
      createdAt: t.created_at
    }))

    // Calcular información de paginación
    const totalPages = Math.ceil(totalTransactions / limitNumber)

    logger.debug(
      `Transacciones obtenidas (${rangeLabel}) -> ${transactions.length} registros en esta página, ${totalTransactions} total`
    )

    res.json({
      success: true,
      data: mappedTransactions,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total: totalTransactions,
        totalPages,
        hasNext: pageNumber < totalPages,
        hasPrev: pageNumber > 1
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo transacciones: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo transacciones'
    })
  }
}

/**
 * Obtiene una transacción por ID
 */
export const getTransactionById = async (req, res) => {
  try {
    const { id } = req.params

    const transaction = await db.get(
      `SELECT
        p.*,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone,
        c.source as contact_source,
        c.attribution_ad_name,
        c.attribution_ad_id
      FROM payments p
      LEFT JOIN contacts c ON p.contact_id = c.id
      WHERE p.id = ?`,
      [id]
    )

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedTransaction = {
      id: transaction.id,
      date: transaction.date,
      contactId: transaction.contact_id,
      contactName: transaction.contact_name || '',
      email: transaction.contact_email || '',
      phone: transaction.contact_phone || '',
      amount: transaction.amount,
      currency: transaction.currency,
      method: transaction.payment_method || 'other',
      status: transaction.status === 'succeeded' ? 'paid' : transaction.status,
      reference: transaction.reference,
      description: transaction.description,
      createdAt: transaction.created_at,
      contactSource: transaction.contact_source,
      attributionAdName: transaction.attribution_ad_name,
      attributionAdId: transaction.attribution_ad_id
    }

    res.json({
      success: true,
      data: mappedTransaction
    })

  } catch (error) {
    logger.error(`Error obteniendo transacción ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo transacción'
    })
  }
}

/**
 * Obtiene estadísticas de transacciones
 */
export const getTransactionStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const { range, stats } = await buildTransactionStats({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    res.json({
      success: true,
      data: stats
    })

    logger.debug(
      `Stats transacciones (${rangeLabel}) -> pagos: ${stats.total.count}`
    )

  } catch (error) {
    logger.error(`Error obteniendo estadísticas de transacciones: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    })
  }
}

/**
 * Obtiene el resumen de transacciones para el dashboard
 */
export const getTransactionSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const { range, summary } = await buildTransactionSummary({ startDate, endDate })

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'todos'

    logger.info(`Obteniendo resumen de transacciones - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: summary
    })

    logger.debug(
      `Resumen transacciones (${rangeLabel}) -> total: ${summary.totalRevenue}, reembolsos: ${summary.refunds}`
    )

  } catch (error) {
    logger.error(`Error obteniendo resumen de transacciones: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo resumen'
    })
  }
}
