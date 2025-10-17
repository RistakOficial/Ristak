/**
 * Servicio de sincronización de invoices desde HighLevel
 *
 * Funcionalidad:
 * - Obtiene invoices desde la API de HighLevel
 * - Los guarda en BD local para evitar duplicados
 * - Actualiza estados si ya existen
 * - Permite mostrar pagos pendientes y pagados
 */

import { db } from '../config/database.js'
import { getGHLClient } from './ghlClient.js'
import { logger } from '../utils/logger.js'

/**
 * Sincroniza invoices desde HighLevel a BD local
 * @param {Object} options - Opciones de sincronización
 * @param {number} options.limit - Número de invoices a obtener (default: 100)
 * @param {number} options.offset - Offset para paginación (default: 0)
 * @param {string} options.contactId - Filtrar por contacto específico
 * @returns {Promise<Object>} - Estadísticas de sincronización
 */
export async function syncInvoices({ limit = 100, offset = 0, contactId } = {}) {
  try {
    logger.info(`Iniciando sincronización de invoices (limit: ${limit}, offset: ${offset})`)

    const ghlClient = await getGHLClient()

    // Obtener invoices desde HighLevel
    const response = await ghlClient.listInvoices({ limit, offset, contactId })

    // GHL puede devolver { invoices: [...] } o { data: [...] }
    const invoices = response.invoices || response.data || []

    logger.info(`Obtenidos ${invoices.length} invoices desde HighLevel`)

    let created = 0
    let updated = 0
    let skipped = 0

    for (const invoice of invoices) {
      try {
        // ID del invoice en HighLevel
        const ghlInvoiceId = invoice.id || invoice._id

        if (!ghlInvoiceId) {
          logger.warn('Invoice sin ID, saltando:', invoice)
          skipped++
          continue
        }

        // Verificar si ya existe en BD local
        const existing = await db.get(
          'SELECT id, status FROM payments WHERE ghl_invoice_id = ?',
          [ghlInvoiceId]
        )

        // Datos comunes del invoice
        const invoiceData = {
          contact_id: invoice.contactId || invoice.altId,
          amount: invoice.total || invoice.amount || 0,
          currency: invoice.currency || 'MXN',
          status: mapInvoiceStatus(invoice.status),
          payment_method: invoice.paymentMode || null,
          reference: invoice.invoiceNumber || null,
          description: invoice.title || invoice.name || 'Pago',
          date: invoice.createdAt || invoice.issueDate || new Date().toISOString(),
          ghl_invoice_id: ghlInvoiceId,
          invoice_number: invoice.invoiceNumber || null,
          due_date: invoice.dueDate || null,
          sent_at: invoice.sentAt || null,
        }

        if (existing) {
          // Actualizar solo si el status cambió
          if (existing.status !== invoiceData.status) {
            await db.run(
              `UPDATE payments
               SET status = ?, amount = ?, currency = ?, payment_method = ?,
                   reference = ?, due_date = ?, sent_at = ?
               WHERE ghl_invoice_id = ?`,
              [
                invoiceData.status,
                invoiceData.amount,
                invoiceData.currency,
                invoiceData.payment_method,
                invoiceData.reference,
                invoiceData.due_date,
                invoiceData.sent_at,
                ghlInvoiceId
              ]
            )
            updated++
            logger.info(`Invoice actualizado: ${ghlInvoiceId} (${existing.status} → ${invoiceData.status})`)
          } else {
            skipped++
          }
        } else {
          // PRIMERO: Verificar si el contacto existe en la BD
          const contactExists = await db.get(
            'SELECT id FROM contacts WHERE id = ?',
            [invoiceData.contact_id]
          )

          if (!contactExists && invoiceData.contact_id) {
            // El contacto NO existe en BD local/remota, necesitamos crearlo
            logger.warn(`Contacto ${invoiceData.contact_id} no existe en BD, obteniéndolo desde HighLevel...`)

            try {
              // Obtener datos del contacto desde HighLevel
              const ghlClient = await getGHLClient()
              const contactResponse = await ghlClient.getContact(invoiceData.contact_id)
              const contact = contactResponse?.contact || contactResponse

              if (contact && contact.id) {
                // Preparar datos del contacto
                const contactName = contact.name ||
                  `${contact.firstName || ''} ${contact.lastName || ''}`.trim() ||
                  contact.email ||
                  contact.phone ||
                  'Sin nombre'

                // Insertar contacto en BD
                await db.run(
                  `INSERT INTO contacts (
                    id, full_name, email, phone, source, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  [
                    contact.id,
                    contactName,
                    contact.email || null,
                    contact.phone || null,
                    'highlevel' // Fuente del contacto
                  ]
                )
                logger.success(`Contacto ${contact.id} creado en BD: ${contactName}`)
              } else {
                logger.error(`No se pudo obtener información del contacto ${invoiceData.contact_id} desde HighLevel`)
                skipped++
                continue // Saltar este invoice
              }
            } catch (contactError) {
              // Si el contacto no existe en HighLevel (404/400), crear un contacto placeholder
              // para evitar loop infinito de reintentos
              const isNotFound = contactError.message?.includes('not found') ||
                                 contactError.message?.includes('400') ||
                                 contactError.message?.includes('404')

              if (isNotFound) {
                logger.warn(`Contacto ${invoiceData.contact_id} no existe en HighLevel, creando placeholder...`)

                // Crear contacto placeholder para evitar reintentos
                try {
                  await db.run(
                    `INSERT INTO contacts (
                      id, full_name, email, phone, source, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [
                      invoiceData.contact_id,
                      `[Contacto eliminado] ${invoiceData.contact_id}`,
                      null,
                      null,
                      'highlevel_deleted' // Marcar como eliminado
                    ]
                  )
                  logger.info(`Contacto placeholder creado para ${invoiceData.contact_id}`)
                } catch (placeholderError) {
                  logger.error(`Error creando placeholder para ${invoiceData.contact_id}:`, placeholderError)
                  skipped++
                  continue
                }
              } else {
                // Otro tipo de error (red, timeout, etc.), skip sin crear placeholder
                logger.error(`Error obteniendo contacto ${invoiceData.contact_id}:`, contactError)
                skipped++
                continue
              }
            }
          }

          // AHORA SÍ: Crear nuevo invoice en BD
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_method,
              reference, description, date, ghl_invoice_id, invoice_number,
              due_date, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              ghlInvoiceId, // Usar mismo ID que en HighLevel
              invoiceData.contact_id,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.status,
              invoiceData.payment_method,
              invoiceData.reference,
              invoiceData.description,
              invoiceData.date,
              invoiceData.ghl_invoice_id,
              invoiceData.invoice_number,
              invoiceData.due_date,
              invoiceData.sent_at
            ]
          )
          created++
          logger.success(`Invoice creado: ${ghlInvoiceId} (${invoiceData.status})`)
        }

        // Si el invoice está pagado, actualizar estadísticas del contacto
        if (invoiceData.status === 'paid' && invoiceData.contact_id) {
          await updateContactStats(invoiceData.contact_id)
        }

      } catch (error) {
        logger.error(`Error procesando invoice ${invoice.id}:`, error)
        skipped++
      }
    }

    const stats = {
      total: invoices.length,
      created,
      updated,
      skipped
    }

    logger.success(`Sincronización completada: ${JSON.stringify(stats)}`)

    return stats

  } catch (error) {
    logger.error('Error en sincronización de invoices:', error)
    throw error
  }
}

/**
 * Mapea el status de HighLevel a nuestros estados internos
 * @param {string} ghlStatus - Status de HighLevel
 * @returns {string} - Status interno
 */
function mapInvoiceStatus(ghlStatus) {
  // Mapeo directo 1:1 - mantenemos TODOS los estados de HighLevel
  const statusMap = {
    'draft': 'draft',                // Borrador
    'sent': 'sent',                  // Enviado
    'paid': 'paid',                  // Pagado
    'void': 'void',                  // Anulado
    'voided': 'void',                // Anulado (variante)
    'refunded': 'refunded',          // Reembolsado
    'partially_paid': 'partial',     // Parcialmente pagado
    'partial': 'partial',            // Parcialmente pagado (variante)
    'pending': 'pending',            // Pendiente
    'overdue': 'overdue',            // Vencido
    'deleted': 'deleted'             // Eliminado
  }

  return statusMap[ghlStatus] || ghlStatus || 'pending'
}

/**
 * Actualiza las estadísticas de un contacto (total_paid, purchases_count, last_purchase_date)
 * @param {string} contactId - ID del contacto
 */
async function updateContactStats(contactId) {
  try {
    // Calcular estadísticas desde los pagos
    const stats = await db.get(
      `SELECT
        SUM(amount) as total_paid,
        COUNT(*) as purchases_count,
        MAX(date) as last_purchase_date
       FROM payments
       WHERE contact_id = ? AND status = 'paid'`,
      [contactId]
    )

    if (stats) {
      await db.run(
        `UPDATE contacts
         SET total_paid = ?, purchases_count = ?, last_purchase_date = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          stats.total_paid || 0,
          stats.purchases_count || 0,
          stats.last_purchase_date || null,
          contactId
        ]
      )
    }
  } catch (error) {
    logger.error(`Error actualizando stats del contacto ${contactId}:`, error)
  }
}

/**
 * Obtiene todos los invoices desde BD local con filtros opcionales
 * @param {Object} filters - Filtros opcionales
 * @param {string} filters.status - Filtrar por status
 * @param {string} filters.contactId - Filtrar por contacto
 * @param {number} filters.limit - Límite de resultados
 * @param {number} filters.offset - Offset para paginación
 * @returns {Promise<Array>} - Lista de invoices
 */
export async function getInvoicesFromDB({ status, contactId, limit = 100, offset = 0 } = {}) {
  try {
    let query = 'SELECT * FROM payments WHERE 1=1'
    const params = []

    if (status) {
      query += ' AND status = ?'
      params.push(status)
    }

    if (contactId) {
      query += ' AND contact_id = ?'
      params.push(contactId)
    }

    query += ' ORDER BY date DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const invoices = await db.all(query, params)

    return invoices

  } catch (error) {
    logger.error('Error obteniendo invoices desde BD:', error)
    throw error
  }
}

/**
 * Obtiene un invoice específico por su ghl_invoice_id
 * @param {string} ghlInvoiceId - ID del invoice en HighLevel
 * @returns {Promise<Object>} - Datos del invoice
 */
export async function getInvoiceByGHLId(ghlInvoiceId) {
  try {
    const invoice = await db.get(
      'SELECT * FROM payments WHERE ghl_invoice_id = ?',
      [ghlInvoiceId]
    )

    return invoice

  } catch (error) {
    logger.error(`Error obteniendo invoice ${ghlInvoiceId}:`, error)
    throw error
  }
}
