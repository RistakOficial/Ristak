import { createHash } from 'node:crypto'
import { db } from '../config/database.js'

export const CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT = 'appointment_slot_preview_offer_created'

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
  return { deleted: Number(result?.changes ?? result?.rowCount ?? 0) }
}

export async function cleanupExpiredConversationalAppointmentPreviewOffers({
  now = new Date(),
  limit = 200
} = {}) {
  const cutoff = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(cutoff.getTime())) throw new Error('La fecha de limpieza de ofertas preview no es válida')
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200))
  const rows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE event_type = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
    [CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, safeLimit]
  )
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
    const result = await db.run(
      `DELETE FROM conversational_agent_events
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [row.id, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, row.detail_json]
    )
    deleted += Number(result?.changes ?? result?.rowCount ?? 0)
  }
  return { processed: rows?.length || 0, deleted }
}

export const __conversationalAppointmentPreviewOfferServiceTestHooks = Object.freeze({
  TEST_SESSION_ID_PATTERN,
  TEST_MESSAGE_ID_PATTERN,
  PREVIEW_SCOPE_ID_PATTERN
})
