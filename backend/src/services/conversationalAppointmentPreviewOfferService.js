import { createHash } from 'node:crypto'
import { db } from '../config/database.js'

export const CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT = 'appointment_slot_preview_offer_created'
export const CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT = 'appointment_selection_progress'
export const CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT = 'appointment_preview_authority_lock'

const TEST_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{12,160}$/
const TEST_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/
const PREVIEW_SCOPE_ID_PATTERN = /^appointment_preview_[a-f0-9]{48}$/

export function buildConversationalAppointmentPreviewScopeId({
  testSessionId = '',
  requestedByUserId = '',
  agentId = ''
} = {}) {
  const sessionId = String(testSessionId || '').trim()
  const userId = String(requestedByUserId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  if (!TEST_SESSION_ID_PATTERN.test(sessionId) || !userId || !cleanAgentId) return ''
  const digest = createHash('sha256')
    .update([userId, cleanAgentId, sessionId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)
  return `appointment_preview_${digest}`
}

export function isConversationalAppointmentPreviewScopeId(value = '') {
  return PREVIEW_SCOPE_ID_PATTERN.test(String(value || '').trim())
}

export function buildConversationalAppointmentPreviewOfferEventId(previewScopeId = '') {
  const scopeId = String(previewScopeId || '').trim()
  return isConversationalAppointmentPreviewScopeId(scopeId)
    ? `cae_appointment_preview_offer_${scopeId}`
    : ''
}

export function buildConversationalAppointmentPreviewAuthorityEventId(previewScopeId = '') {
  const scopeId = String(previewScopeId || '').trim()
  return isConversationalAppointmentPreviewScopeId(scopeId)
    ? `cae_appointment_preview_authority_${scopeId}`
    : ''
}

export function buildConversationalAppointmentPreviewExecutionId({
  previewScopeId = '',
  testMessageId = ''
} = {}) {
  const scopeId = String(previewScopeId || '').trim()
  const messageId = String(testMessageId || '').trim()
  if (!isConversationalAppointmentPreviewScopeId(scopeId) || !TEST_MESSAGE_ID_PATTERN.test(messageId)) return ''
  return `preview:${createHash('sha256').update([scopeId, messageId].join('\u0000')).digest('hex').slice(0, 48)}`
}

export async function cleanupConversationalAppointmentPreviewOffers({
  previewScopeId = '',
  agentId = ''
} = {}) {
  const eventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  const cleanAgentId = String(agentId || '').trim()
  if (!eventId || !cleanAgentId) return { deleted: 0 }
  const result = await db.run(
    'DELETE FROM conversational_agent_events WHERE id = ? AND agent_id = ? AND event_type = ?',
    [eventId, cleanAgentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
  )
  let deleted = Number(result?.changes ?? result?.rowCount ?? 0)
  const authorityEventId = buildConversationalAppointmentPreviewAuthorityEventId(previewScopeId)
  const authorityResult = await db.run(
    'DELETE FROM conversational_agent_events WHERE id = ? AND agent_id = ? AND event_type = ?',
    [authorityEventId, cleanAgentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT]
  )
  deleted += Number(authorityResult?.changes ?? authorityResult?.rowCount ?? 0)
  const progressRows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE agent_id = ? AND event_type = ?`,
    [cleanAgentId, CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT]
  )
  for (const row of progressRows || []) {
    let detail = {}
    try {
      detail = row.detail_json ? JSON.parse(row.detail_json) : {}
    } catch {
      detail = {}
    }
    if (String(detail.previewScopeId || '') !== String(previewScopeId || '').trim()) continue
    const removed = await db.run(
      `DELETE FROM conversational_agent_events
       WHERE id = ? AND agent_id = ? AND event_type = ? AND detail_json = ?`,
      [row.id, cleanAgentId, CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT, row.detail_json]
    )
    deleted += Number(removed?.changes ?? removed?.rowCount ?? 0)
  }
  return { deleted }
}

export async function cleanupExpiredConversationalAppointmentPreviewOffers({
  now = new Date(),
  limit = 200
} = {}) {
  const cutoff = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(cutoff.getTime())) throw new Error('La fecha de limpieza de ofertas preview no es válida')
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200))
  const offerRows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE event_type = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
    [CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, safeLimit]
  )
  const progressRows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE event_type = ? AND detail_json LIKE ?
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    [
      CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
      '%"previewScopeId":"appointment_preview_%',
      safeLimit
    ]
  )
  const authorityRows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE event_type = ? AND detail_json LIKE ?
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    [
      CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT,
      '%"previewScopeId":"appointment_preview_%',
      safeLimit
    ]
  )
  const rows = [
    ...(offerRows || []).map((row) => ({ ...row, eventType: CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT })),
    ...(progressRows || []).map((row) => ({ ...row, eventType: CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT })),
    ...(authorityRows || []).map((row) => ({ ...row, eventType: CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT }))
  ]
  let deleted = 0
  for (const row of rows || []) {
    let detail = {}
    try {
      detail = row.detail_json ? JSON.parse(row.detail_json) : {}
    } catch {
      detail = {}
    }
    const expiresAtMs = Date.parse(detail?.expiresAt || '')
    if (Number.isFinite(expiresAtMs) && expiresAtMs > cutoff.getTime()) continue
    if (
      [
        CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
        CONVERSATIONAL_APPOINTMENT_PREVIEW_AUTHORITY_EVENT
      ].includes(row.eventType) &&
      !isConversationalAppointmentPreviewScopeId(detail?.previewScopeId)
    ) continue
    const result = await db.run(
      `DELETE FROM conversational_agent_events
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [row.id, row.eventType, row.detail_json]
    )
    deleted += Number(result?.changes ?? result?.rowCount ?? 0)
  }
  return { processed: rows.length, deleted }
}

export const __conversationalAppointmentPreviewOfferServiceTestHooks = Object.freeze({
  TEST_SESSION_ID_PATTERN,
  TEST_MESSAGE_ID_PATTERN,
  PREVIEW_SCOPE_ID_PATTERN
})
