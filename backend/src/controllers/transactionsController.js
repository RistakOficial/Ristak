import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildTransactionStats, buildTransactionSummary } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { getHighLevelConfig } from '../config/database.js'
import { syncInvoices, getInvoicesFromDB } from '../services/invoicesSyncService.js'

/**
 * Obtiene todas las transacciones/pagos con paginación y filtros
 */
export const getTransactions = async (req, res) => {
  try {
    const {
      page = 1,
      limit,
      status = '',
      startDate,
      endDate,
      sortBy = 'date',
      sortOrder = 'DESC',
      sync = 'false' // Por defecto NO sincroniza (más rápido)
    } = req.query

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    // Si NO hay filtro de fechas (modo "TODOS"), traer TODOS los registros sin límite
    const usePagination = range.isFiltered || limit
    const limitNumber = usePagination ? Math.min(Number(limit) || 50, 5000) : 999999
    const pageNumber = usePagination ? (Number(page) || 1) : 1
    const offset = usePagination ? Math.max((pageNumber - 1) * limitNumber, 0) : 0

    logger.info(`Obteniendo transacciones - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}, paginación: ${usePagination}`)

    // Sincronizar invoices desde HighLevel antes de devolver datos
    if (sync !== 'false') {
      try {
        logger.info('Sincronizando invoices desde HighLevel...')
        await syncInvoices({ limit: 100 })
        logger.success('Sincronización de invoices completada')
      } catch (syncError) {
        logger.warn('Error en sincronización de invoices (continuando):', syncError.message)
        // No fallar la request si la sincronización falla
      }
    }

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
        p.ghl_invoice_id,
        p.invoice_number,
        p.due_date,
        p.sent_at,
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
      createdAt: t.created_at,
      invoiceId: t.ghl_invoice_id,
      invoiceNumber: t.invoice_number,
      dueDate: t.due_date,
      sentAt: t.sent_at
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

/**
 * Elimina una transacción/pago
 */
export const deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Eliminando transacción: ${id}`)

    // Verificar que existe
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Eliminar de la base de datos
    await db.run('DELETE FROM payments WHERE id = ?', [id])

    logger.success(`Transacción eliminada: ${id}`)

    res.json({
      success: true,
      message: 'Transacción eliminada correctamente'
    })

  } catch (error) {
    logger.error(`Error eliminando transacción: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error eliminando transacción'
    })
  }
}

/**
 * Anula un pago/invoice en HighLevel
 */
export const voidTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Anulando transacción: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Anular en HighLevel si tiene invoice_id
    if (transaction.invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.voidInvoice(transaction.invoice_id)
    }

    // Actualizar estado en BD
    await db.run('UPDATE payments SET status = ? WHERE id = ?', ['void', id])

    logger.success(`Transacción anulada: ${id}`)

    res.json({
      success: true,
      message: 'Pago anulado correctamente'
    })

  } catch (error) {
    logger.error(`Error anulando transacción: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error anulando pago'
    })
  }
}

/**
 * Registra un pago manual/marca como pagado
 */
export const recordPayment = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, paymentDate, paymentMethod } = req.body

    logger.info(`Registrando pago manual para transacción: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Marcar como pagado en HighLevel si tiene invoice_id
    if (transaction.invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.recordPayment(transaction.invoice_id, {
        amount: amount || transaction.amount,
        currency: transaction.currency || 'MXN',
        fulfilledAt: paymentDate || new Date().toISOString(),
        mode: paymentMethod || 'cash',
        note: 'Pago registrado manualmente'
      })
    }

    // Actualizar estado en BD
    await db.run('UPDATE payments SET status = ? WHERE id = ?', ['paid', id])

    logger.success(`Pago registrado para transacción: ${id}`)

    res.json({
      success: true,
      message: 'Pago registrado correctamente'
    })

  } catch (error) {
    logger.error(`Error registrando pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error registrando pago'
    })
  }
}

/**
 * Envía un pago al cliente (email/SMS)
 */
export const sendTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Enviando pago: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Enviar en HighLevel si tiene invoice_id
    if (transaction.invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.sendInvoice(transaction.invoice_id)
    } else {
      throw new Error('No se puede enviar: el pago no tiene invoice asociado')
    }

    logger.success(`Pago enviado: ${id}`)

    res.json({
      success: true,
      message: 'Pago enviado correctamente'
    })

  } catch (error) {
    logger.error(`Error enviando pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: error.message || 'Error enviando pago'
    })
  }
}

/**
 * Obtiene el enlace de pago
 */
export const getPaymentLink = async (req, res) => {
  try {
    const { id } = req.params

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    if (!transaction.invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'El pago no tiene enlace asociado'
      })
    }

    // Obtener configuración para el domain
    const config = await getHighLevelConfig()
    const ghlClient = await getGHLClient()
    const link = await ghlClient.getInvoicePaymentLink(transaction.invoice_id, config.domain)

    res.json({
      success: true,
      data: {
        link
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo enlace de pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo enlace'
    })
  }
}
