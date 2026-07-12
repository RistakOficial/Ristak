import { randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import { createInternalNotification } from './notificationsService.js'
import { logger } from '../utils/logger.js'

const TEST_ASSIGNMENT_TTL_MS = 5 * 60 * 1000
const TEST_ASSIGNMENT_CLEANUP_LEASE_MS = 2 * 60 * 1000
const TEST_ASSIGNMENT_NOTIFICATION_STALE_MS = 5 * 60 * 1000
const TEST_ASSIGNMENT_CLEANUP_LIMIT = 100

function cleanString(value, maxLength = 500) {
  const normalized = String(value ?? '').trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength)
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function toIso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw assignmentError('El instante de la prueba no es válido.', 400, 'invalid_test_assignment_time')
  }
  return date.toISOString()
}

function assignmentError(message, status = 409, code = 'test_assignment_failed') {
  const error = new Error(message)
  error.status = status
  error.statusCode = status
  error.code = code
  return error
}

function requireIdentifier(value, label) {
  const normalized = cleanString(value, 180)
  if (!normalized) {
    throw assignmentError(`${label} es obligatorio para la asignación de prueba.`, 400, 'test_assignment_identity_required')
  }
  return normalized
}

function publicAssignment(row = {}) {
  if (!row?.effect_id) return null
  return {
    effectId: row.effect_id,
    testRunId: row.test_run_id,
    agentId: row.agent_id,
    requestedByUserId: row.requested_by_user_id,
    contactId: row.contact_id,
    targetUserId: row.target_user_id,
    previousUserId: row.previous_user_id || null,
    status: row.status,
    assigned: row.status === 'assigned',
    cleanupDueAt: row.cleanup_due_at,
    assignedAt: row.assigned_at || null,
    notificationStatus: row.notification_status || null,
    notificationError: row.notification_error || null,
    notificationSentAt: row.notification_sent_at || null,
    cleanedAt: row.cleaned_at || null,
    lastError: row.last_error || null
  }
}

async function loadAssignment(effectId) {
  return db.get(
    'SELECT * FROM conversational_agent_test_assignments WHERE effect_id = ?',
    [effectId]
  )
}

async function loadEffectAuthority(effectId) {
  return db.get(`
    SELECT e.id, e.run_id, e.effect_type, e.entity_id, e.payload_json,
           r.agent_id, r.requested_by_user_id, r.contact_id, r.status AS run_status,
           r.expires_at
    FROM conversational_agent_test_effects e
    JOIN conversational_agent_test_runs r ON r.id = e.run_id
    WHERE e.id = ?
    LIMIT 1
  `, [effectId])
}

function assertAuthority(authority, {
  effectId,
  testRunId,
  agentId,
  requestedByUserId,
  contactId
}) {
  if (!authority) {
    throw assignmentError('El efecto durable de esta prueba ya no existe.', 404, 'test_assignment_effect_not_found')
  }
  if (cleanString(authority.effect_type) !== 'assignment') {
    throw assignmentError('El efecto durable no corresponde a una asignación.', 409, 'test_assignment_effect_type_mismatch')
  }
  const expected = {
    id: effectId,
    run_id: testRunId,
    agent_id: agentId,
    requested_by_user_id: requestedByUserId,
    contact_id: contactId
  }
  for (const [field, value] of Object.entries(expected)) {
    if (cleanString(authority[field]) !== cleanString(value)) {
      throw assignmentError('La identidad de la asignación de prueba no coincide con su sesión.', 409, 'test_assignment_identity_mismatch')
    }
  }
  if (authority.entity_id && cleanString(authority.entity_id) !== contactId) {
    throw assignmentError('El efecto de prueba ya apunta a otra entidad.', 409, 'test_assignment_entity_mismatch')
  }
  const runExpiresAt = Date.parse(authority.expires_at || '')
  if (authority.run_status !== 'active' || !Number.isFinite(runExpiresAt) || runExpiresAt <= Date.now()) {
    throw assignmentError('La sesión de prueba ya no está activa.', 409, 'test_assignment_run_closed')
  }
}

function assertExistingAssignmentIdentity(row, input) {
  const expected = {
    test_run_id: input.testRunId,
    agent_id: input.agentId,
    requested_by_user_id: input.requestedByUserId,
    contact_id: input.contactId,
    target_user_id: input.targetUserId
  }
  for (const [field, value] of Object.entries(expected)) {
    if (cleanString(row[field]) !== cleanString(value)) {
      throw assignmentError('Este efecto ya registró otra asignación. Reinicia la prueba para evitar datos cruzados.', 409, 'test_assignment_payload_mismatch')
    }
  }
}

let createInternalNotificationImpl = createInternalNotification

/**
 * Envía una notificación real al usuario temporalmente asignado. La etiqueta y
 * los metadatos dejan claro que no es una entrega productiva.
 */
export async function dispatchConversationalAgentTestAssignmentNotification({ effectId } = {}) {
  const cleanEffectId = requireIdentifier(effectId, 'El efecto')
  const row = await loadAssignment(cleanEffectId)
  if (!row) {
    throw assignmentError('La asignación de prueba ya no existe.', 404, 'test_assignment_not_found')
  }
  if (row.status !== 'assigned') {
    return { skipped: true, reason: row.status === 'cleaned' ? 'assignment_cleaned' : 'assignment_not_ready' }
  }
  if (row.notification_status === 'sent') return { skipped: true, reason: 'already_notified' }

  const claimedAt = toIso()
  const staleBefore = toIso(Date.now() - TEST_ASSIGNMENT_NOTIFICATION_STALE_MS)
  const claim = await db.run(`
    UPDATE conversational_agent_test_assignments
    SET notification_status = 'dispatching', notification_error = NULL,
        updated_at = ?
    WHERE effect_id = ?
      AND status = 'assigned'
      AND (
        notification_status = 'pending'
        OR (notification_status = 'dispatching' AND updated_at <= ?)
      )
  `, [claimedAt, cleanEffectId, staleBefore])
  if (mutationCount(claim) !== 1) return { skipped: true, reason: 'notification_not_claimed' }

  try {
    const [contact, user] = await Promise.all([
      db.get('SELECT full_name, first_name, last_name FROM contacts WHERE id = ?', [row.contact_id]),
      db.get('SELECT full_name, first_name, last_name, username, email FROM users WHERE CAST(id AS TEXT) = ?', [row.target_user_id])
    ])
    const contactName = cleanString(
      contact?.full_name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || 'Un contacto',
      180
    )
    const userName = cleanString(
      user?.full_name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || user?.email || 'el usuario configurado',
      180
    )
    const message = `${contactName} fue asignado temporalmente a ${userName}. Es una prueba real y la asignación se restaurará automáticamente en cinco minutos.`
    const notification = await createInternalNotificationImpl({
      recipientUserIds: [row.target_user_id],
      source: 'Tester del agente',
      severity: 'info',
      title: '[PRUEBA] Contacto asignado',
      message,
      actionUrl: `/contacts/all/all/${encodeURIComponent(row.contact_id)}`,
      actionLabel: 'Abrir contacto',
      category: 'conversational_agent_test_assignment',
      contactId: row.contact_id,
      metadata: {
        testMode: true,
        testRunId: row.test_run_id,
        testEffectId: row.effect_id,
        testEffectType: 'assignment',
        cleanupDueAt: row.cleanup_due_at
      },
      pushTitle: '[PRUEBA] Contacto asignado',
      pushBody: message
    })
    await db.run(`
      UPDATE conversational_agent_test_assignments
      SET notification_status = 'sent', notification_error = NULL,
          notification_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE effect_id = ? AND notification_status = 'dispatching'
    `, [cleanEffectId])
    return notification
  } catch (error) {
    await db.run(`
      UPDATE conversational_agent_test_assignments
      SET notification_status = 'pending', notification_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE effect_id = ? AND notification_status = 'dispatching'
    `, [cleanString(error?.message || error, 1200), cleanEffectId]).catch(() => undefined)
    throw error
  }
}

/**
 * Asigna de verdad el contacto del tester al usuario configurado. La fila del
 * contacto guarda una marca CAS; una asignación humana/live elimina esa marca,
 * de modo que la limpieza nunca puede deshacer una decisión posterior.
 */
export async function assignConversationalAgentTestContact({
  effectId,
  testRunId,
  agentId,
  requestedByUserId,
  contactId,
  targetUserId,
  now = Date.now()
} = {}) {
  const input = {
    effectId: requireIdentifier(effectId, 'El efecto'),
    testRunId: requireIdentifier(testRunId, 'La sesión'),
    agentId: requireIdentifier(agentId, 'El agente'),
    requestedByUserId: requireIdentifier(requestedByUserId, 'El usuario que ejecuta la prueba'),
    contactId: requireIdentifier(contactId, 'El contacto'),
    targetUserId: requireIdentifier(targetUserId, 'El usuario configurado')
  }
  const nowIso = toIso(now)
  const cleanupDueAt = toIso(new Date(nowIso).getTime() + TEST_ASSIGNMENT_TTL_MS)

  const assignment = await db.transaction(async () => {
    const authority = await loadEffectAuthority(input.effectId)
    assertAuthority(authority, input)

    const existing = await loadAssignment(input.effectId)
    if (existing) {
      assertExistingAssignmentIdentity(existing, input)
      return existing
    }

    const [contact, targetUser] = await Promise.all([
      db.get(`
        SELECT id, assigned_user_id, assignment_test_effect_id
        FROM contacts
        WHERE id = ? AND deleted_at IS NULL
      `, [input.contactId]),
      db.get(`
        SELECT id
        FROM users
        WHERE CAST(id AS TEXT) = ? AND is_active = 1
        LIMIT 1
      `, [input.targetUserId])
    ])
    if (!contact) {
      throw assignmentError('El contacto de prueba ya no existe.', 404, 'test_assignment_contact_not_found')
    }
    if (!targetUser) {
      throw assignmentError('El usuario configurado ya no está activo.', 409, 'test_assignment_user_unavailable')
    }
    if (cleanString(contact.assignment_test_effect_id)) {
      throw assignmentError('El contacto ya tiene otra asignación temporal activa.', 409, 'test_assignment_contact_busy')
    }

    const previousUserId = cleanString(contact.assigned_user_id, 180) || null
    await db.run(`
      INSERT INTO conversational_agent_test_assignments (
        effect_id, test_run_id, agent_id, requested_by_user_id, contact_id,
        target_user_id, previous_user_id, status, cleanup_due_at,
        notification_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigning', ?, 'pending', ?, ?)
    `, [
      input.effectId,
      input.testRunId,
      input.agentId,
      input.requestedByUserId,
      input.contactId,
      input.targetUserId,
      previousUserId,
      cleanupDueAt,
      nowIso,
      nowIso
    ])

    const update = await db.run(`
      UPDATE contacts
      SET assigned_user_id = ?, assignment_test_effect_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND COALESCE(CAST(assigned_user_id AS TEXT), '') = ?
        AND COALESCE(assignment_test_effect_id, '') = ''
    `, [input.targetUserId, input.effectId, input.contactId, previousUserId || ''])
    if (mutationCount(update) !== 1) {
      throw assignmentError('La asignación del contacto cambió mientras iniciaba la prueba. Inténtalo de nuevo.', 409, 'test_assignment_concurrent_change')
    }

    await db.run(`
      UPDATE conversational_agent_test_assignments
      SET status = 'assigned', assigned_at = ?, updated_at = ?
      WHERE effect_id = ? AND status = 'assigning'
    `, [nowIso, nowIso, input.effectId])
    await db.run(`
      UPDATE conversational_agent_test_effects
      SET entity_id = ?, cleanup_status = COALESCE(cleanup_status, 'pending'),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [input.contactId, input.effectId])
    return loadAssignment(input.effectId)
  })

  let notification = null
  let notificationError = null
  if (assignment.status === 'assigned') {
    try {
      notification = await dispatchConversationalAgentTestAssignmentNotification({ effectId: input.effectId })
    } catch (error) {
      notificationError = cleanString(error?.message || error, 1200)
      logger.warn(`[Tester agente] La asignación ${input.effectId} quedó activa, pero su notificación se reintentará: ${notificationError}`)
    }
  }

  return {
    ...publicAssignment(await loadAssignment(input.effectId)),
    notification,
    notificationError
  }
}

async function markRunCleanedWhenComplete(testRunId) {
  const outstanding = await db.get(`
    SELECT COUNT(*) AS total
    FROM conversational_agent_test_effects
    WHERE run_id = ? AND COALESCE(cleanup_status, '') != 'cleaned'
  `, [testRunId])
  if (Number(outstanding?.total || 0) > 0) return
  await db.run(`
    UPDATE conversational_agent_test_runs
    SET status = 'cleaned', cleaned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status != 'cleaned'
  `, [testRunId])
}

/** Restaura sólo si el contacto sigue asignado por este mismo efecto. */
export async function cleanupConversationalAgentTestAssignment({
  effectId,
  requestedByUserId = '',
  now = Date.now()
} = {}) {
  const cleanEffectId = requireIdentifier(effectId, 'El efecto')
  const cleanRequesterId = cleanString(requestedByUserId, 180)
  const nowIso = toIso(now)
  let row = await loadAssignment(cleanEffectId)
  if (!row) {
    throw assignmentError('La asignación de prueba ya no existe.', 404, 'test_assignment_not_found')
  }
  if (cleanRequesterId && cleanString(row.requested_by_user_id) !== cleanRequesterId) {
    throw assignmentError('Esta asignación de prueba pertenece a otro usuario.', 403, 'test_assignment_owner_mismatch')
  }
  if (row.status === 'cleaned') {
    return { cleaned: true, restored: false, alreadyCleaned: true, ...publicAssignment(row) }
  }

  const claimToken = randomUUID()
  const leaseUntilAt = toIso(new Date(nowIso).getTime() + TEST_ASSIGNMENT_CLEANUP_LEASE_MS)
  const claim = await db.run(`
    UPDATE conversational_agent_test_assignments
    SET status = 'cleaning', claim_token = ?, lease_until_at = ?,
        cleanup_attempt_count = cleanup_attempt_count + 1,
        last_error = NULL, updated_at = ?
    WHERE effect_id = ?
      AND (
        status IN ('assigned', 'cleanup_failed')
        OR (status = 'cleaning' AND (lease_until_at IS NULL OR lease_until_at <= ?))
      )
  `, [claimToken, leaseUntilAt, nowIso, cleanEffectId, nowIso])
  if (mutationCount(claim) !== 1) {
    row = await loadAssignment(cleanEffectId)
    return {
      cleaned: row?.status === 'cleaned',
      restored: false,
      pending: row?.status === 'cleaning',
      reason: row?.status === 'cleaning' ? 'cleanup_in_progress' : 'cleanup_not_claimed',
      ...publicAssignment(row)
    }
  }

  try {
    const result = await db.transaction(async () => {
      const active = await loadAssignment(cleanEffectId)
      if (!active || active.status !== 'cleaning' || active.claim_token !== claimToken) {
        throw assignmentError('La limpieza perdió su autorización temporal.', 409, 'test_assignment_cleanup_claim_lost')
      }
      const contact = await db.get(`
        SELECT id, assigned_user_id, assignment_test_effect_id
        FROM contacts WHERE id = ?
      `, [active.contact_id])

      let restored = false
      let superseded = false
      let contactMissing = false
      if (!contact) {
        contactMissing = true
      } else if (cleanString(contact.assignment_test_effect_id) !== cleanEffectId) {
        superseded = true
      } else if (cleanString(contact.assigned_user_id) !== cleanString(active.target_user_id)) {
        // Algún camino externo cambió al responsable sin conocer la marca. Se
        // conserva ese valor y sólo se retira nuestra marca.
        await db.run(`
          UPDATE contacts
          SET assignment_test_effect_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND assignment_test_effect_id = ?
        `, [active.contact_id, cleanEffectId])
        superseded = true
      } else {
        const restore = await db.run(`
          UPDATE contacts
          SET assigned_user_id = ?, assignment_test_effect_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND assignment_test_effect_id = ?
            AND COALESCE(CAST(assigned_user_id AS TEXT), '') = ?
        `, [active.previous_user_id || null, active.contact_id, cleanEffectId, cleanString(active.target_user_id)])
        restored = mutationCount(restore) === 1
        if (!restored) superseded = true
      }

      await db.run(`
        UPDATE conversational_agent_test_assignments
        SET status = 'cleaned', claim_token = NULL, lease_until_at = NULL,
            last_error = NULL, cleaned_at = ?, updated_at = ?
        WHERE effect_id = ? AND status = 'cleaning' AND claim_token = ?
      `, [nowIso, nowIso, cleanEffectId, claimToken])

      const effect = await db.get(
        'SELECT payload_json FROM conversational_agent_test_effects WHERE id = ?',
        [cleanEffectId]
      )
      if (effect) {
        const payload = {
          ...parseJson(effect.payload_json, {}),
          assignmentActive: false,
          assignmentRestored: restored,
          assignmentSuperseded: superseded,
          assignmentContactMissing: contactMissing,
          assignedUserId: active.target_user_id,
          previousAssignedUserId: active.previous_user_id || null,
          cleanedAt: nowIso
        }
        await db.run(`
          UPDATE conversational_agent_test_effects
          SET status = 'cleaned', cleanup_status = 'cleaned', cleanup_error = NULL,
              cleaned_at = COALESCE(cleaned_at, ?), payload_json = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [nowIso, JSON.stringify(payload), cleanEffectId])
      }

      return { restored, superseded, contactMissing, testRunId: active.test_run_id }
    })
    await markRunCleanedWhenComplete(result.testRunId)
    return {
      cleaned: true,
      ...result,
      ...publicAssignment(await loadAssignment(cleanEffectId))
    }
  } catch (error) {
    await db.run(`
      UPDATE conversational_agent_test_assignments
      SET status = 'cleanup_failed', claim_token = NULL, lease_until_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE effect_id = ? AND status = 'cleaning' AND claim_token = ?
    `, [cleanString(error?.message || error, 1200), cleanEffectId, claimToken]).catch(() => undefined)
    throw error
  }
}

export async function cleanupDueConversationalAgentTestAssignments({
  now = Date.now(),
  limit = TEST_ASSIGNMENT_CLEANUP_LIMIT
} = {}) {
  const nowIso = toIso(now)
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || TEST_ASSIGNMENT_CLEANUP_LIMIT, 500))
  const rows = await db.all(`
    SELECT effect_id
    FROM conversational_agent_test_assignments
    WHERE cleanup_due_at <= ?
      AND (
        status IN ('assigned', 'cleanup_failed')
        OR (status = 'cleaning' AND (lease_until_at IS NULL OR lease_until_at <= ?))
      )
    ORDER BY cleanup_due_at ASC, effect_id ASC
    LIMIT ?
  `, [nowIso, nowIso, safeLimit])

  const results = []
  for (const item of rows || []) {
    try {
      results.push(await cleanupConversationalAgentTestAssignment({ effectId: item.effect_id, now }))
    } catch (error) {
      logger.error(`[Tester agente] No se pudo limpiar la asignación ${item.effect_id}: ${error.message}`)
      results.push({ cleaned: false, effectId: item.effect_id, error: cleanString(error?.message || error, 1200) })
    }
  }
  return {
    scanned: (rows || []).length,
    cleaned: results.filter(result => result.cleaned).length,
    failed: results.filter(result => !result.cleaned).length,
    results
  }
}

export async function retryConversationalAgentTestAssignmentNotifications({
  now = Date.now(),
  limit = 50
} = {}) {
  const nowIso = toIso(now)
  const staleBefore = toIso(new Date(nowIso).getTime() - TEST_ASSIGNMENT_NOTIFICATION_STALE_MS)
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200))
  const rows = await db.all(`
    SELECT effect_id
    FROM conversational_agent_test_assignments
    WHERE status = 'assigned'
      AND cleanup_due_at > ?
      AND (
        notification_status = 'pending'
        OR (notification_status = 'dispatching' AND updated_at <= ?)
      )
    ORDER BY created_at ASC, effect_id ASC
    LIMIT ?
  `, [nowIso, staleBefore, safeLimit])

  const results = []
  for (const item of rows || []) {
    try {
      results.push(await dispatchConversationalAgentTestAssignmentNotification({ effectId: item.effect_id }))
    } catch (error) {
      results.push({ sent: false, effectId: item.effect_id, error: cleanString(error?.message || error, 1200) })
    }
  }
  return {
    scanned: (rows || []).length,
    sent: results.filter(result => !result.skipped && result.sent !== false).length,
    failed: results.filter(result => result.sent === false).length,
    results
  }
}

export async function getConversationalAgentTestAssignment({ effectId, requestedByUserId = '' } = {}) {
  const cleanEffectId = requireIdentifier(effectId, 'El efecto')
  const row = await loadAssignment(cleanEffectId)
  if (!row) return null
  const cleanRequesterId = cleanString(requestedByUserId, 180)
  if (cleanRequesterId && cleanString(row.requested_by_user_id) !== cleanRequesterId) {
    throw assignmentError('Esta asignación de prueba pertenece a otro usuario.', 403, 'test_assignment_owner_mismatch')
  }
  return publicAssignment(row)
}

export function setConversationalAgentTestAssignmentDependenciesForTests(overrides = null) {
  createInternalNotificationImpl = overrides?.createInternalNotification || createInternalNotification
}

export const CONVERSATIONAL_AGENT_TEST_ASSIGNMENT_TTL_MS = TEST_ASSIGNMENT_TTL_MS
