import { db } from '../config/database.js'
import { logger } from './logger.js'

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
        ), 0),
        purchases_count = COALESCE((
          SELECT COUNT(*)
          FROM payments
          WHERE payments.contact_id = ?
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
        ), 0),
        last_purchase_date = (
          SELECT MAX(date)
          FROM payments
          WHERE payments.contact_id = ?
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
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
export async function updateContactsStats() {
  try {
    logger.info('Actualizando estadísticas de contactos...')

    // Actualizar total_paid, purchases_count y last_purchase_date de todos los contactos
    const updateQuery = `
      UPDATE contacts
      SET
        total_paid = COALESCE((
          SELECT SUM(amount)
          FROM payments
          WHERE payments.contact_id = contacts.id
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
        ), 0),
        purchases_count = COALESCE((
          SELECT COUNT(*)
          FROM payments
          WHERE payments.contact_id = contacts.id
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
        ), 0),
        last_purchase_date = (
          SELECT MAX(date)
          FROM payments
          WHERE payments.contact_id = contacts.id
          AND payments.amount > 0
          AND LOWER(payments.status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
        )
    `

    await db.run(updateQuery)

    // Obtener estadísticas actualizadas
    const stats = await db.get(`
      SELECT
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN purchases_count > 0 THEN 1 END) as contacts_with_purchases,
        SUM(total_paid) as total_revenue
      FROM contacts
    `)

    logger.success(`✅ Estadísticas actualizadas:`)
    logger.info(`   - Total contactos: ${stats.total_contacts}`)
    logger.info(`   - Contactos con compras: ${stats.contacts_with_purchases}`)
    logger.info(`   - Ingresos totales: $${stats.total_revenue || 0}`)

    return stats
  } catch (error) {
    logger.error(`Error actualizando estadísticas de contactos: ${error.message}`)
    throw error
  }
}
