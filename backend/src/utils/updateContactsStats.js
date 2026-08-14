import { databaseDialect, db } from '../config/database.js'
import { parseContactCustomFields } from './contactCustomFields.js'
import { resolveContactLifecycleStage } from './contactLifecycleStage.js'
import { logger } from './logger.js'
import { nonTestPaymentCondition } from './paymentMode.js'

const DEFAULT_CONTACT_STATS_BATCH_SIZE = 250
const sqliteContactStatsLocks = new Map()

async function withSqliteContactStatsLock(contactId, operation) {
  const previous = sqliteContactStatsLocks.get(contactId) || Promise.resolve()
  let releaseCurrent
  const current = new Promise(resolve => { releaseCurrent = resolve })
  sqliteContactStatsLocks.set(contactId, current)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    releaseCurrent()
    if (sqliteContactStatsLocks.get(contactId) === current) {
      sqliteContactStatsLocks.delete(contactId)
    }
  }
}

function storedContactStage(contact = {}) {
  const stageField = parseContactCustomFields(contact.custom_fields)
    .find(field => ['stage', 'contact.stage'].includes(String(field.key || field.fieldKey || '').toLowerCase()))
  return contact.stage || stageField?.value || ''
}

function contactLifecycleStageFromStoredStats(contact = {}) {
  return resolveContactLifecycleStage({
    ...contact,
    stage: storedContactStage(contact)
  })
}

function numericValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizedTimestamp(value) {
  return value === null || value === undefined ? '' : String(value)
}

function paymentStatsChangedFields(before = {}, after = {}) {
  const fields = []
  if (numericValue(before.total_paid) !== numericValue(after.total_paid)) {
    fields.push('totalPaid', 'total_paid')
  }
  if (numericValue(before.purchases_count) !== numericValue(after.purchases_count)) {
    fields.push('payments', 'paymentsCount', 'payments_count', 'purchasesCount', 'purchases_count')
  }
  if (normalizedTimestamp(before.last_purchase_date) !== normalizedTimestamp(after.last_purchase_date)) {
    fields.push('lastPurchaseDate', 'last_purchase_date')
  }
  return [...new Set(fields)]
}

async function publishContactStatsUpdate(contactId, changedFields, lifecycleStageChanged) {
  try {
    const engine = await import('../services/automationEngine.js')
    await engine.handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: [...new Set([
        ...changedFields,
        ...(lifecycleStageChanged ? ['stage'] : [])
      ])],
      contactChangeSource: 'payment',
      lifecycleStageChanged,
      canonicalLifecycleStageChange: lifecycleStageChanged,
      canonicalContactStatsUpdate: true
    })
    return true
  } catch (error) {
    logger.warn(`No se pudo publicar la actualización canónica de estadísticas del contacto ${contactId}: ${error.message}`)
    return false
  }
}

async function reconcileContactPaymentStats(contactId, transaction, { lockContact = false } = {}) {
  const before = await transaction.get(
    `SELECT * FROM contacts WHERE id = ?${lockContact ? ' FOR UPDATE' : ''}`,
    [contactId]
  )
  if (!before) return { updated: false, reason: 'contact_not_found' }

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

  await transaction.run(updateQuery, [contactId, contactId, contactId, contactId])
  const after = await transaction.get('SELECT * FROM contacts WHERE id = ?', [contactId])
  const beforeStage = contactLifecycleStageFromStoredStats(before)
  const afterStage = contactLifecycleStageFromStoredStats(after)

  return {
    updated: true,
    changedFields: paymentStatsChangedFields(before, after),
    lifecycleStageChanged: (beforeStage === 'customer') !== (afterStage === 'customer')
  }
}

/**
 * Actualiza las estadísticas de un contacto específico
 */
export async function updateSingleContactStats(contactId) {
  try {
    const statsUpdate = databaseDialect === 'postgres'
      ? await db.transaction(transaction => reconcileContactPaymentStats(contactId, transaction, { lockContact: true }))
      : await withSqliteContactStatsLock(contactId, () => reconcileContactPaymentStats(contactId, db))

    const contactUpdateEventPublished = statsUpdate.updated && statsUpdate.changedFields.length > 0
      ? await publishContactStatsUpdate(contactId, statsUpdate.changedFields, statsUpdate.lifecycleStageChanged)
      : false
    if (statsUpdate.updated) logger.info(`✅ Estadísticas actualizadas para contacto ${contactId}`)
    return { ...statsUpdate, contactUpdateEventPublished }
  } catch (error) {
    logger.error(`Error actualizando estadísticas del contacto ${contactId}: ${error.message}`)
    return { updated: false, contactUpdateEventPublished: false, error: error.message }
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
