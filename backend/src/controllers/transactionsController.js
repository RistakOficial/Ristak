import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildTransactionStats, buildTransactionSummary } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { getHighLevelConfig } from '../config/database.js'
import { syncAllInvoices, syncLocalPaymentsToHighLevel } from '../services/invoicesSyncService.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { triggerWhatsappFirstPurchaseEvent } from '../services/metaWhatsappEventsService.js'
import { sendPaymentNotification } from '../services/pushNotificationsService.js'
import { formatInvoiceMultilineText, formatInvoiceSingleLineText } from '../utils/invoiceTextFormatter.js'
import { findContactByPhoneCandidates } from '../services/contactIdentityService.js'
import { getAccountCurrency, normalizePhoneForAccount } from '../utils/accountLocale.js'

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const VALID_TRANSACTION_STATUSES = new Set([
  'draft',
  'sent',
  'paid',
  'pending',
  'overdue',
  'partial',
  'void',
  'refunded',
  'failed',
  'deleted'
])

const PAYMENT_METHOD_TO_GHL_MODE = {
  card: 'card',
  transfer: 'bank_transfer',
  bank_transfer: 'bank_transfer',
  cash: 'cash',
  check: 'check',
  paypal: 'other',
  other: 'other'
}

const normalizeGhlInvoiceMode = mode => mode === 'test' ? 'test' : 'live'

async function getGhlInvoiceLiveMode() {
  try {
    const config = await db.get('SELECT ghl_invoice_mode FROM highlevel_config LIMIT 1')
    return normalizeGhlInvoiceMode(config?.ghl_invoice_mode) === 'live'
  } catch {
    return true
  }
}

const normalizeStatus = (status) => {
  if (!status) return status
  const normalized = String(status).toLowerCase()
  return normalized === 'succeeded' ? 'paid' : normalized
}

const normalizeAmount = (amount) => {
  if (amount === undefined || amount === null || amount === '') return undefined
  const parsed = Number(amount)
  if (!Number.isFinite(parsed)) {
    throw new Error('Monto inválido')
  }
  return Math.round(parsed * 100) / 100
}

const cleanString = (value) => String(value || '').trim()

const createLocalId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

const splitName = (name = '') => {
  const parts = cleanString(name).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

const normalizePaymentMode = (mode) => mode === 'test' ? 'test' : 'live'

async function findExistingContactForPayment({ contactId, email, phone }) {
  if (contactId) {
    const byId = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
    if (byId) return byId.id
  }

  const normalizedEmail = cleanString(email).toLowerCase()
  if (normalizedEmail) {
    const byEmail = await db.get('SELECT id FROM contacts WHERE LOWER(email) = ? LIMIT 1', [normalizedEmail])
    if (byEmail) return byEmail.id
  }

  if (phone) {
    const byPhone = await findContactByPhoneCandidates(phone)
    if (byPhone) return byPhone.id
  }

  return null
}

async function ensureLocalContactForPayment({ contactId, contactName, email, phone }) {
  const fullName = cleanString(contactName)
  const normalizedPhone = await normalizePhoneForAccount(phone) || cleanString(phone) || null
  const normalizedEmail = cleanString(email) || null
  const existingContactId = await findExistingContactForPayment({
    contactId: cleanString(contactId),
    email: normalizedEmail,
    phone: normalizedPhone
  })

  if (existingContactId) {
    const nameParts = splitName(fullName)
    try {
      await db.run(
        `UPDATE contacts
         SET phone = COALESCE(NULLIF(phone, ''), ?),
             email = COALESCE(NULLIF(email, ''), ?),
             full_name = COALESCE(NULLIF(full_name, ''), ?),
             first_name = COALESCE(NULLIF(first_name, ''), ?),
             last_name = COALESCE(NULLIF(last_name, ''), ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          normalizedPhone,
          normalizedEmail,
          fullName || null,
          nameParts.firstName || null,
          nameParts.lastName || null,
          existingContactId
        ]
      )
    } catch (error) {
      logger.warn(`No se pudo completar datos del contacto ${existingContactId}: ${error.message}`)
    }

    return existingContactId
  }

  if (!normalizedEmail && !normalizedPhone && !fullName) {
    return null
  }

  const id = cleanString(contactId) || createLocalId('manual_contact')
  const nameParts = splitName(fullName)

  await db.run(
    `INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      email = COALESCE(NULLIF(contacts.email, ''), excluded.email),
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      normalizedPhone,
      normalizedEmail,
      fullName || normalizedEmail || normalizedPhone || 'Contacto manual',
      nameParts.firstName || null,
      nameParts.lastName || null,
      'ristak_manual'
    ]
  )

  return id
}

const toDateOnly = (dateValue) => {
  if (!dateValue) return undefined
  return String(dateValue).split('T')[0]
}

const mapTransactionRow = (t) => ({
  id: t.id,
  date: t.date,
  contactId: t.contact_id,
  contactName: t.contact_name || '',
  email: t.contact_email || '',
  phone: t.contact_phone || '',
  amount: t.amount,
  currency: t.currency,
  method: t.payment_method || 'other',
  status: normalizeStatus(t.status),
  paymentMode: t.payment_mode || 'live',
  reference: t.reference,
  title: t.title || t.description || 'Pago',
  description: t.description,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  invoiceId: t.ghl_invoice_id,
  invoiceNumber: t.invoice_number,
  dueDate: t.due_date,
  sentAt: t.sent_at
})

const getInvoiceFromResponse = (response) => response?.invoice || response?.data || response || {}

const getInvoiceItems = (invoice) => {
  if (Array.isArray(invoice.items)) return invoice.items
  if (Array.isArray(invoice.invoiceItems)) return invoice.invoiceItems
  return []
}

const buildInvoiceItemsForAmount = ({ invoice, amount, currency, title, description }) => {
  const items = getInvoiceItems(invoice)
  const firstItem = items[0] || {}
  const itemName = formatInvoiceSingleLineText(title || firstItem.name || invoice.name || invoice.title || 'Pago') || 'Pago'
  const itemDescription = formatInvoiceMultilineText(description || firstItem.description || firstItem.name || itemName) || itemName
  const rawTaxRate = Number(invoice.tax?.rate || 0)
  const taxRate = Number.isFinite(rawTaxRate) && rawTaxRate > 0 ? rawTaxRate : 0
  const subtotal = taxRate > 0
    ? Math.round((amount / (1 + taxRate / 100)) * 100) / 100
    : amount
  const taxAmount = taxRate > 0 ? Math.round((amount - subtotal) * 100) / 100 : 0

  const nextItem = {
    ...firstItem,
    name: itemName,
    description: itemDescription,
    amount: subtotal,
    qty: firstItem.qty || 1,
    currency
  }

  return {
    items: [nextItem],
    tax: taxRate > 0
      ? {
          ...invoice.tax,
          amount: taxAmount,
          rate: taxRate
        }
      : undefined
  }
}

const buildInvoiceUpdatePayload = ({ invoice, transaction, updates }) => {
  const amount = updates.amount ?? Number(transaction.amount || invoice.total || invoice.amount || 0)
  const currency = updates.currency || transaction.currency || invoice.currency || 'MXN'
  const firstItem = getInvoiceItems(invoice)[0] || {}
  const rawTitle = updates.title ?? transaction.title ?? invoice.title ?? invoice.name ?? firstItem.name ?? 'Pago'
  const rawDescription = updates.description ?? transaction.description ?? firstItem.description ?? firstItem.name ?? rawTitle
  const title = formatInvoiceSingleLineText(rawTitle) || 'Pago'
  const description = formatInvoiceMultilineText(rawDescription) || 'Pago'
  const issueDate = toDateOnly(updates.date || transaction.date || invoice.issueDate || invoice.createdAt)
  const dueDate = toDateOnly(updates.dueDate || transaction.due_date || invoice.dueDate)
  const currentItems = getInvoiceItems(invoice)
  const invoiceItemData = buildInvoiceItemsForAmount({ invoice, amount, currency, title, description })

  const payload = {
    name: title,
    title,
    currency,
    contactDetails: {
      ...(invoice.contactDetails || {}),
      id: updates.contactId || invoice.contactDetails?.id || transaction.contact_id || invoice.contactId,
      name: updates.contactName || invoice.contactDetails?.name || invoice.contactName || '',
      email: updates.email || invoice.contactDetails?.email || '',
      phoneNo: updates.phone || invoice.contactDetails?.phoneNo || invoice.contactDetails?.phone || ''
    },
    businessDetails: invoice.businessDetails,
    liveMode: invoice.liveMode !== undefined ? invoice.liveMode : true,
    items: invoiceItemData.items,
  }

  if (issueDate) payload.issueDate = issueDate
  if (dueDate) payload.dueDate = dueDate
  if (invoiceItemData.tax) payload.tax = invoiceItemData.tax
  if (invoice.termsNotes) payload.termsNotes = formatInvoiceMultilineText(invoice.termsNotes)

  if (!updates.amount && currentItems.length > 0) {
    payload.items = currentItems.map((item, index) => index === 0
      ? {
          ...item,
          name: formatInvoiceSingleLineText(item.name || title) || title,
          description: description || formatInvoiceMultilineText(item.description || item.name),
          currency: item.currency || currency
        }
      : item
    )
  }

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null) {
      delete payload[key]
    }
  })

  return payload
}

const getTransactionByIdForResponse = async (id) => {
  const row = await db.get(
    `SELECT
      p.id,
      p.contact_id,
      p.amount,
      p.currency,
      p.status,
      p.payment_mode,
      p.payment_method,
      p.reference,
      p.title,
      p.description,
      p.date,
      p.created_at,
      p.updated_at,
      p.ghl_invoice_id,
      p.invoice_number,
      p.due_date,
      p.sent_at,
      c.full_name as contact_name,
      c.email as contact_email,
      c.phone as contact_phone
    FROM payments p
    LEFT JOIN contacts c ON p.contact_id = c.id
    WHERE p.id = ?`,
    [id]
  )

  return row ? mapTransactionRow(row) : null
}

/**
 * Crea una transacción/pago local. HighLevel es opcional: si está configurado,
 * el pago se exporta como invoice y se enlaza por ghl_invoice_id.
 */
export const createTransaction = async (req, res) => {
  try {
    const {
      id,
      amount,
      currency,
      method,
      paymentMethod,
      status,
      reference,
      title,
      description,
      date,
      dueDate,
      contactId,
      contactName,
      email,
      phone,
      paymentMode
    } = req.body

    const finalAmount = normalizeAmount(amount)
    if (finalAmount === undefined || finalAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      })
    }

    const finalStatus = normalizeStatus(status) || 'paid'
    if (!VALID_TRANSACTION_STATUSES.has(finalStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Estado de pago inválido'
      })
    }

    const finalContactId = await ensureLocalContactForPayment({
      contactId,
      contactName,
      email,
      phone
    })

    if (!finalContactId) {
      return res.status(400).json({
        success: false,
        error: 'Necesitas asociar el pago a un contacto con nombre, email o teléfono'
      })
    }

    const transactionId = cleanString(id) || createLocalId('manual_payment')
    const finalCurrency = cleanString(currency || await getAccountCurrency()).toUpperCase()
    const finalMethod = cleanString(paymentMethod || method || 'cash') || 'cash'
    const finalTitle = cleanString(title || description || 'Pago')
    const finalDescription = cleanString(description || title || 'Pago')
    const finalDate = date || new Date().toISOString()
    const finalPaymentMode = normalizePaymentMode(paymentMode)

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        reference, title, description, date, due_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        transactionId,
        finalContactId,
        finalAmount,
        finalCurrency,
        finalStatus,
        finalMethod,
        finalPaymentMode,
        reference || null,
        finalTitle,
        finalDescription,
        finalDate,
        dueDate || null
      ]
    )

    await updateSingleContactStats(finalContactId)

    if (SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      await triggerWhatsappFirstPurchaseEvent(finalContactId, {
        amount: finalAmount,
        currency: finalCurrency,
        paymentMode: finalPaymentMode
      })
    }

    try {
      const localExport = await syncLocalPaymentsToHighLevel({ paymentId: transactionId, limit: 1 })
      if (localExport.exported > 0) {
        logger.success(`Pago local exportado a HighLevel: ${transactionId}`)
      }
    } catch (syncError) {
      logger.warn(`Pago ${transactionId} guardado localmente; no se pudo exportar a HighLevel: ${syncError.message}`)
    }

    const createdTransaction = await getTransactionByIdForResponse(transactionId)

    if (createdTransaction && SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      sendPaymentNotification(createdTransaction).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${transactionId}: ${pushError.message}`)
      })
    }

    logger.success(`Transacción creada: ${transactionId}`)

    res.status(201).json({
      success: true,
      data: createdTransaction
    })
  } catch (error) {
    logger.error(`Error creando transacción: ${error.message}`)
    const statusCode = error.message === 'Monto inválido' ? 400 : 500
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Error creando transacción'
    })
  }
}

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
        logger.info('🔄 Sincronizando TODOS los invoices desde HighLevel...')
        const syncStats = await syncAllInvoices()
        logger.success(`✅ Sincronización completa: ${syncStats.totalFetched} invoices obtenidos, ${syncStats.created} creados, ${syncStats.updated} actualizados`)
      } catch (syncError) {
        logger.warn('⚠️ Error en sincronización de invoices (continuando):', syncError.message)
        // No fallar la request si la sincronización falla
      }
    }

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

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

    // Agregar filtro de contactos ocultos (mostrar pagos sin contacto O con contacto NO oculto)
    if (hiddenCondition) {
      filters.push(`(p.contact_id IS NULL OR p.contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition}))`)
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
        p.payment_mode,
        p.payment_method,
        p.reference,
        p.title,
        p.description,
        p.date,
        p.created_at,
        p.updated_at,
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
    const mappedTransactions = transactions.map(mapTransactionRow)

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

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    const conditions = ['p.id = ?']
    // Filtrar contactos ocultos (permitir pagos sin contacto)
    if (hiddenCondition) {
      conditions.push(`(p.contact_id IS NULL OR ${hiddenCondition})`)
    }

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
      WHERE ${conditions.join(' AND ')}`,
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
      status: normalizeStatus(transaction.status),
      paymentMode: transaction.payment_mode || 'live',
      reference: transaction.reference,
      title: transaction.title || transaction.description || 'Pago',
      description: transaction.description,
      createdAt: transaction.created_at,
      updatedAt: transaction.updated_at,
      invoiceId: transaction.ghl_invoice_id,
      invoiceNumber: transaction.invoice_number,
      dueDate: transaction.due_date,
      sentAt: transaction.sent_at,
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
 * Actualiza una transacción/pago y sincroniza los cambios posibles con HighLevel
 */
export const updateTransaction = async (req, res) => {
  try {
    const { id } = req.params
    const {
      amount,
      currency,
      method,
      paymentMethod,
      status,
      reference,
      title,
      description,
      date,
      dueDate,
      contactId,
      contactName,
      email,
      phone
    } = req.body

    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    const updates = {
      amount: normalizeAmount(amount),
      currency: currency ? String(currency).toUpperCase() : undefined,
      method: paymentMethod || method,
      status: status ? normalizeStatus(status) : undefined,
      reference: reference !== undefined ? String(reference || '') : undefined,
      title: title !== undefined ? String(title || '') : undefined,
      description: description !== undefined ? String(description || '') : undefined,
      date: date || undefined,
      dueDate: dueDate || undefined,
      contactId: contactId || undefined,
      contactName: contactName || undefined,
      email: email || undefined,
      phone: phone || undefined
    }

    if (updates.amount !== undefined && updates.amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      })
    }

    if (updates.status && !VALID_TRANSACTION_STATUSES.has(updates.status)) {
      return res.status(400).json({
        success: false,
        error: 'Estado de pago inválido'
      })
    }

    const currentStatus = normalizeStatus(transaction.status)
    const nextStatus = updates.status || currentStatus
    const statusChanged = nextStatus !== currentStatus
    const invoiceId = transaction.ghl_invoice_id

    if (invoiceId && statusChanged && nextStatus === 'refunded') {
      return res.status(422).json({
        success: false,
        error: 'HighLevel no expone un endpoint público para emitir reembolsos desde esta integración. Haz el refund en HighLevel; Ristak lo actualizará por webhook o sincronización.'
      })
    }

    if (invoiceId && statusChanged && nextStatus === 'void' && SUCCESS_PAYMENT_STATUSES.has(currentStatus)) {
      return res.status(422).json({
        success: false,
        error: 'HighLevel no permite anular un invoice pagado sin reembolsarlo primero. Procesa el refund en HighLevel y después sincroniza.'
      })
    }

    if (invoiceId && statusChanged && !['paid', 'void'].includes(nextStatus)) {
      return res.status(422).json({
        success: false,
        error: `HighLevel no permite cambiar manualmente el estado del invoice a "${nextStatus}" por API. Sí se puede editar monto, fecha, descripción, registrar pago o anular.`
      })
    }

    const hasInvoiceFieldUpdates = [
      updates.amount,
      updates.currency,
      updates.title,
      updates.description,
      updates.date,
      updates.dueDate,
      updates.contactId
    ].some(value => value !== undefined)

    if (invoiceId && hasInvoiceFieldUpdates && nextStatus !== 'void') {
      const ghlClient = await getGHLClient()
      const invoiceResponse = await ghlClient.getInvoice(invoiceId)
      const invoice = getInvoiceFromResponse(invoiceResponse)
      const payload = buildInvoiceUpdatePayload({ invoice, transaction, updates })
      await ghlClient.updateInvoice(invoiceId, payload)
    }

    let recordedPaymentMode = transaction.payment_mode || 'live'

    if (invoiceId && statusChanged && nextStatus === 'paid') {
      const ghlClient = await getGHLClient()
      const liveMode = await getGhlInvoiceLiveMode()
      recordedPaymentMode = liveMode ? 'live' : 'test'
      await ghlClient.recordPayment(invoiceId, {
        amount: updates.amount ?? transaction.amount,
        currency: updates.currency || transaction.currency || 'MXN',
        fulfilledAt: updates.date || transaction.date || new Date().toISOString(),
        mode: PAYMENT_METHOD_TO_GHL_MODE[updates.method || transaction.payment_method] || 'cash',
        note: recordedPaymentMode === 'test'
          ? 'Pago registrado desde edición de Ristak\nModo: prueba'
          : 'Pago registrado desde edición de Ristak',
        liveMode
      })
    }

    if (invoiceId && statusChanged && nextStatus === 'void') {
      const ghlClient = await getGHLClient()
      await ghlClient.voidInvoice(invoiceId)
    }

    const finalContactId = updates.contactId ?? transaction.contact_id
    const finalAmount = updates.amount ?? transaction.amount
    const finalCurrency = updates.currency || transaction.currency || 'MXN'
    const finalStatus = nextStatus
    const finalMethod = updates.method ?? transaction.payment_method
    const finalReference = updates.reference ?? transaction.reference
    const finalTitle = updates.title ?? transaction.title
    const finalDescription = updates.description ?? transaction.description
    const finalDate = updates.date ?? transaction.date
    const finalDueDate = updates.dueDate ?? transaction.due_date
    const finalPaymentMode = statusChanged && nextStatus === 'paid'
      ? recordedPaymentMode
      : (transaction.payment_mode || 'live')

    await db.run(
      `UPDATE payments
       SET contact_id = ?, amount = ?, currency = ?, status = ?, payment_method = ?,
           reference = ?, title = ?, description = ?, date = ?, due_date = ?, payment_mode = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        finalContactId,
        finalAmount,
        finalCurrency,
        finalStatus,
        finalMethod,
        finalReference,
        finalTitle,
        finalDescription,
        finalDate,
        finalDueDate,
        finalPaymentMode,
        id
      ]
    )

    const statsContacts = new Set([transaction.contact_id, finalContactId].filter(Boolean))
    await Promise.all([...statsContacts].map(contact => updateSingleContactStats(contact)))

    if (finalContactId && statusChanged && SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      await triggerWhatsappFirstPurchaseEvent(finalContactId, {
        amount: finalAmount,
        currency: finalCurrency,
        paymentMode: finalPaymentMode
      })
    }

    const updatedTransaction = await getTransactionByIdForResponse(id)

    logger.success(`Transacción actualizada: ${id}`)

    res.json({
      success: true,
      data: updatedTransaction
    })

  } catch (error) {
    logger.error(`Error actualizando transacción ${req.params.id}: ${error.message}`)
    const statusCode = error.message === 'Monto inválido' ? 400 : 500
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Error actualizando transacción'
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
    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
    }

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
 * Marca un pago local como reembolsado. HighLevel no expone refund por API aquí,
 * así que los invoices remotos deben reembolsarse en HighLevel y sincronizarse.
 */
export const refundTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Reembolsando transacción: ${id}`)

    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    const currentStatus = normalizeStatus(transaction.status)

    if (currentStatus === 'refunded') {
      return res.json({
        success: true,
        message: 'El pago ya estaba reembolsado'
      })
    }

    if (transaction.ghl_invoice_id) {
      return res.status(422).json({
        success: false,
        error: 'Este pago viene de HighLevel. Haz el reembolso en HighLevel; Ristak lo actualizará por webhook o sincronización.'
      })
    }

    if (!SUCCESS_PAYMENT_STATUSES.has(currentStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Solo se pueden reembolsar pagos completados'
      })
    }

    await db.run(
      'UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['refunded', id]
    )

    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
    }

    logger.success(`Transacción reembolsada: ${id}`)

    res.json({
      success: true,
      message: 'Pago reembolsado correctamente'
    })
  } catch (error) {
    logger.error(`Error reembolsando transacción: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error reembolsando pago'
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

    // Anular en HighLevel si tiene invoice asociado
    if (transaction.ghl_invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.voidInvoice(transaction.ghl_invoice_id)
    }

    // Actualizar estado en BD
    await db.run('UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['void', id])
    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
    }

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

    // Marcar como pagado en HighLevel si tiene invoice asociado
    const liveMode = await getGhlInvoiceLiveMode()
    const paymentMode = liveMode ? 'live' : 'test'

    if (transaction.ghl_invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.recordPayment(transaction.ghl_invoice_id, {
        amount: amount || transaction.amount,
        currency: transaction.currency || 'MXN',
        fulfilledAt: paymentDate || new Date().toISOString(),
        mode: paymentMethod || 'cash',
        note: paymentMode === 'test' ? 'Pago registrado manualmente\nModo: prueba' : 'Pago registrado manualmente',
        liveMode
      })
    }

    // Actualizar estado en BD
    await db.run(
      'UPDATE payments SET status = ?, amount = ?, payment_method = ?, payment_mode = ?, date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['paid', amount || transaction.amount, paymentMethod || transaction.payment_method, paymentMode, paymentDate || transaction.date, id]
    )
    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
      await triggerWhatsappFirstPurchaseEvent(transaction.contact_id, {
        amount: amount || transaction.amount,
        currency: transaction.currency || 'MXN',
        paymentMode
      })
    }

    if (!transaction.ghl_invoice_id) {
      try {
        const localExport = await syncLocalPaymentsToHighLevel({ paymentId: id, limit: 1 })
        if (localExport.exported > 0) {
          logger.success(`Pago registrado y exportado a HighLevel: ${id}`)
        }
      } catch (syncError) {
        logger.warn(`Pago ${id} registrado localmente; no se pudo exportar a HighLevel: ${syncError.message}`)
      }
    }

    const paidTransaction = await getTransactionByIdForResponse(id)
    if (paidTransaction) {
      sendPaymentNotification(paidTransaction).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
      })
    }

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

    // Enviar en HighLevel si tiene invoice asociado
    if (transaction.ghl_invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.sendInvoice(transaction.ghl_invoice_id, {
        liveMode: await getGhlInvoiceLiveMode()
      })
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

    if (!transaction.ghl_invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'El pago no tiene enlace asociado'
      })
    }

    // Obtener configuración para el domain
    const config = await getHighLevelConfig()
    const ghlClient = await getGHLClient()
    const link = await ghlClient.getInvoicePaymentLink(transaction.ghl_invoice_id, config.domain)

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
