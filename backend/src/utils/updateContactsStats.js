import { db } from '../config/database.js'
import { logger } from './logger.js'
import { nonTestPaymentCondition } from './paymentMode.js'

const DEFAULT_CONTACT_STATS_BATCH_SIZE = 250

/**
 * Actualiza las estadísticas de un contacto específico
 */
export async function updateSingleContactStats(contactId) {
  try {
    const updateQuery = `
      UPDATE contacts
      SET
        total_paid = COALESCE((
          SELECT SUM(amount)
          FROM payments
          WHERE payments.contact_id = ?
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
          AND ${nonTestPaymentCondition('payments')}
        ), 0),
        purchases_count = COALESCE((
          SELECT COUNT(*)
          FROM payments
          WHERE payments.contact_id = ?
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
          AND ${nonTestPaymentCondition('payments')}
        ), 0),
        last_purchase_date = (
          SELECT MAX(date)
          FROM payments
          WHERE payments.contact_id = ?
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
          AND ${nonTestPaymentCondition('payments')}
        )
      WHERE id = ?
    `

    await db.run(updateQuery, [contactId, contactId, contactId, contactId])
    logger.info(`✅ Estadísticas actualizadas para contacto ${contactId}`)
  } catch (error) {
    logger.error(`Error actualizando estadísticas del contacto ${contactId}: ${error.message}`)
  }
}

/**
 * Actualiza las estadísticas de contactos (total_paid, purchases_count, last_purchase_date)
 * basándose en los pagos exitosos
 */
export async function updateContactsStats({ batchSize = DEFAULT_CONTACT_STATS_BATCH_SIZE } = {}) {
  try {
    const normalizedBatchSize = Math.max(1, Math.min(1000, Number(batchSize) || DEFAULT_CONTACT_STATS_BATCH_SIZE))
    logger.info(`Actualizando estadísticas de contactos en lotes de ${normalizedBatchSize}...`)

    let lastId = ''
    let processed = 0
    let updated = 0

    while (true) {
      const rows = await db.all(
        `
          SELECT id
          FROM contacts
          WHERE id > ?
          ORDER BY id
          LIMIT ?
        `,
        [lastId, normalizedBatchSize]
      )

      if (!rows.length) break

      const ids = rows.map(row => String(row.id || '')).filter(Boolean)
      if (!ids.length) break

      const placeholders = ids.map(() => '?').join(', ')
      const updateQuery = `
        UPDATE contacts
        SET
          total_paid = COALESCE((
            SELECT SUM(amount)
            FROM payments
            WHERE payments.contact_id = contacts.id
            AND payments.amount > 0
            AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
            AND ${nonTestPaymentCondition('payments')}
          ), 0),
          purchases_count = COALESCE((
            SELECT COUNT(*)
            FROM payments
            WHERE payments.contact_id = contacts.id
            AND payments.amount > 0
            AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
            AND ${nonTestPaymentCondition('payments')}
          ), 0),
          last_purchase_date = (
            SELECT MAX(date)
            FROM payments
            WHERE payments.contact_id = contacts.id
            AND payments.amount > 0
            AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
            AND ${nonTestPaymentCondition('payments')}
          )
        WHERE id IN (${placeholders})
      `

      const result = await db.run(updateQuery, ids)
      processed += ids.length
      updated += Number(result?.changes || ids.length)
      lastId = ids[ids.length - 1]

      await new Promise(resolve => setImmediate(resolve))
    }

    // Obtener estadísticas actualizadas
    const stats = await db.get(`
      SELECT
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN purchases_count > 0 THEN 1 END) as contacts_with_purchases,
        SUM(total_paid) as total_revenue
      FROM contacts
    `)

    logger.success(`✅ Estadísticas actualizadas:`)
    logger.info(`   - Contactos procesados: ${processed}`)
    logger.info(`   - Filas actualizadas: ${updated}`)
    logger.info(`   - Total contactos: ${stats.total_contacts}`)
    logger.info(`   - Contactos con compras: ${stats.contacts_with_purchases}`)
    logger.info(`   - Ingresos totales: $${stats.total_revenue || 0}`)

    return {
      ...stats,
      processed,
      updated,
      batchSize: normalizedBatchSize
    }
  } catch (error) {
    logger.error(`Error actualizando estadísticas de contactos: ${error.message}`)
    throw error
  }
}
