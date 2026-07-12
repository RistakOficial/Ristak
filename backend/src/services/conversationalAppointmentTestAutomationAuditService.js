import { db } from '../config/database.js'
import { createRistakId } from '../utils/idGenerator.js'
import { normalizeToUtcIso } from '../utils/dateUtils.js'

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function json(value) {
  return JSON.stringify(value ?? {})
}

function nowIso() {
  return new Date().toISOString()
}

function optionalUtcIso(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = normalizeToUtcIso(value, 'UTC')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function requireTestIdentity(context = {}) {
  const identity = {
    testEffectId: cleanString(context.testEffectId || context.test_effect_id),
    testRunId: cleanString(context.testRunId || context.test_run_id),
    appointmentId: cleanString(context.appointmentId || context.appointment_id),
    eventType: cleanString(context.eventType || context.event_type || 'appointment-test')
  }
  if (!identity.testEffectId || !identity.testRunId || !identity.appointmentId) {
    const error = new Error('La ejecución segura de automatizaciones requiere la identidad completa del Modo test.')
    error.code = 'test_automation_identity_required'
    throw error
  }
  return identity
}

export function buildAppointmentTestActionKey(context = {}, action = {}) {
  const identity = requireTestIdentity(context)
  return [
    'conv-appt-test',
    identity.testEffectId,
    identity.eventType,
    cleanString(action.automationId || 'appointment'),
    cleanString(action.nodeId || action.actionType || 'action'),
    cleanString(action.actionType || 'test-action')
  ].join(':')
}

function normalizeReceipt(row) {
  if (!row) return null
  return {
    ...row,
    request: parseJson(row.request_json, {}),
    response: parseJson(row.response_json, {})
  }
}

export async function claimAppointmentTestAction(context = {}, action = {}) {
  const identity = requireTestIdentity(context)
  const idempotencyKey = buildAppointmentTestActionKey(identity, action)
  const receiptId = createRistakId('conv_appt_test_action')
  const inserted = await db.run(`
    INSERT INTO conversational_appointment_test_automation_receipts (
      id, test_effect_id, test_run_id, appointment_id, event_type,
      automation_id, automation_name, node_id, node_type, action_type,
      idempotency_key, execution_mode, status, detail, request_json,
      cleanup_due_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'real', 'dispatching', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (idempotency_key) DO NOTHING
  `, [
    receiptId,
    identity.testEffectId,
    identity.testRunId,
    identity.appointmentId,
    identity.eventType,
    cleanString(action.automationId) || null,
    cleanString(action.automationName) || null,
    cleanString(action.nodeId) || null,
    cleanString(action.nodeType) || null,
    cleanString(action.actionType || 'test-action'),
    idempotencyKey,
    cleanString(action.detail) || null,
    json(action.request),
    optionalUtcIso(context.testExpiresAt || context.test_expires_at)
  ])
  const receipt = normalizeReceipt(await db.get(
    'SELECT * FROM conversational_appointment_test_automation_receipts WHERE idempotency_key = ?',
    [idempotencyKey]
  ))
  return {
    claimed: Number(inserted?.changes || 0) === 1 && receipt?.id === receiptId,
    idempotencyKey,
    receipt
  }
}

export async function completeAppointmentTestAction(receiptId, {
  status = 'sent',
  detail = '',
  response = {}
} = {}) {
  const id = cleanString(receiptId)
  if (!id) return null
  await db.run(`
    UPDATE conversational_appointment_test_automation_receipts
    SET status = ?, detail = ?, response_json = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'dispatching'
  `, [cleanString(status) || 'sent', cleanString(detail) || null, json(response), nowIso(), nowIso(), id])
  return normalizeReceipt(await db.get(
    'SELECT * FROM conversational_appointment_test_automation_receipts WHERE id = ?',
    [id]
  ))
}

export async function recordSimulatedAppointmentTestAction(context = {}, action = {}) {
  const identity = requireTestIdentity(context)
  const idempotencyKey = buildAppointmentTestActionKey(identity, action)
  const receiptId = createRistakId('conv_appt_test_action')
  await db.run(`
    INSERT INTO conversational_appointment_test_automation_receipts (
      id, test_effect_id, test_run_id, appointment_id, event_type,
      automation_id, automation_name, node_id, node_type, action_type,
      idempotency_key, execution_mode, status, detail, request_json,
      response_json, cleanup_due_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'simulated', 'simulated', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (idempotency_key) DO NOTHING
  `, [
    receiptId,
    identity.testEffectId,
    identity.testRunId,
    identity.appointmentId,
    identity.eventType,
    cleanString(action.automationId) || null,
    cleanString(action.automationName) || null,
    cleanString(action.nodeId) || null,
    cleanString(action.nodeType) || null,
    cleanString(action.actionType || 'simulated-action'),
    idempotencyKey,
    cleanString(action.detail) || 'Efecto irreversible simulado en Modo test.',
    json(action.request),
    json(action.response),
    optionalUtcIso(context.testExpiresAt || context.test_expires_at)
  ])
  return normalizeReceipt(await db.get(
    'SELECT * FROM conversational_appointment_test_automation_receipts WHERE idempotency_key = ?',
    [idempotencyKey]
  ))
}

export async function listAppointmentTestAutomationReceipts(testEffectId) {
  const rows = await db.all(`
    SELECT *
    FROM conversational_appointment_test_automation_receipts
    WHERE test_effect_id = ?
    ORDER BY created_at ASC, id ASC
  `, [cleanString(testEffectId)])
  return rows.map(normalizeReceipt)
}
