import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from './logger.js'

/**
 * (DB-010) Registra un evento de auditoría para entidades sensibles (contactos, pagos,
 * citas). Best-effort: NUNCA debe romper la operación principal — si el insert falla,
 * se loguea y se continúa.
 *
 * @param {object} p
 * @param {string} p.entityType - 'contact' | 'payment' | 'appointment' | ...
 * @param {string|null} [p.entityId]
 * @param {string} p.action - p.ej. 'soft_delete', 'restore', 'permanent_delete', 'merge'
 * @param {object|null} [p.actor] - req.user (userId/email/username)
 * @param {object|null} [p.details] - datos extra (se serializan a JSON)
 */
export async function recordAudit({ entityType, entityId = null, action, actor = null, details = null }) {
  try {
    const id = crypto.randomBytes(16).toString('hex')
    const actorUserId = actor?.userId || actor?.id || null
    const actorLabel = actor?.email || actor?.username || null
    const detailsJson = details ? JSON.stringify(details) : null
    await db.run(
      `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_user_id, actor_label, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, String(entityType), entityId ? String(entityId) : null, String(action), actorUserId, actorLabel, detailsJson]
    )
  } catch (error) {
    logger.warn(`[Auditoría] No se pudo registrar ${action} en ${entityType}: ${error.message}`)
  }
}
