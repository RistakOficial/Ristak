import { db } from '../../../config/database.js'
import {
  normalizeConversationIntelligenceState,
  sanitizeConversationIntelligenceForPersistence
} from './contracts.js'

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function mutationCount(result) {
  return Math.max(0, Number(result?.changes ?? result?.rowCount) || 0)
}

export async function loadConversationIntelligenceState({ stateId = '', objective = 'custom', channel = 'chat' } = {}) {
  const cleanStateId = String(stateId || '').trim()
  if (!cleanStateId) return normalizeConversationIntelligenceState({}, { objective, channel })
  const row = await db.get(`
    SELECT intelligence_state_json, intelligence_policy_hash, intelligence_source, intelligence_updated_at
    FROM conversational_agent_state
    WHERE id = ?
  `, [cleanStateId]).catch(() => null)
  return normalizeConversationIntelligenceState({
    ...parseJson(row?.intelligence_state_json, {}),
    updatedAt: row?.intelligence_updated_at || parseJson(row?.intelligence_state_json, {})?.updatedAt
  }, { objective, channel })
}

export async function saveConversationIntelligenceState({
  stateId = '',
  intelligenceState = {},
  policyHash = '',
  source = 'deterministic'
} = {}) {
  const cleanStateId = String(stateId || '').trim()
  if (!cleanStateId) return { saved: false, state: normalizeConversationIntelligenceState(intelligenceState) }
  const state = sanitizeConversationIntelligenceForPersistence(intelligenceState)
  const serialized = JSON.stringify(state)
  const result = await db.run(`
    UPDATE conversational_agent_state
    SET intelligence_state_json = ?,
        intelligence_policy_hash = ?,
        intelligence_source = ?,
        intelligence_updated_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    serialized,
    String(policyHash || '').trim().slice(0, 128) || null,
    String(source || 'deterministic').trim().slice(0, 80) || 'deterministic',
    state.updatedAt || new Date().toISOString(),
    cleanStateId
  ])
  return { saved: mutationCount(result) > 0, state }
}

export async function listConversationIntelligenceSnapshots({ agentId = '', limit = 500 } = {}) {
  const cleanAgentId = String(agentId || '').trim()
  const cleanLimit = Math.max(1, Math.min(2000, Number(limit) || 500))
  const rows = await db.all(`
    SELECT id, contact_id, agent_id, channel, status, signal,
           intelligence_state_json, intelligence_policy_hash,
           intelligence_source, intelligence_updated_at
    FROM conversational_agent_state
    WHERE (? = '' OR agent_id = ?)
      AND intelligence_state_json IS NOT NULL
      AND intelligence_state_json <> ''
    ORDER BY COALESCE(intelligence_updated_at, updated_at, created_at) DESC
    LIMIT ?
  `, [cleanAgentId, cleanAgentId, cleanLimit]).catch(() => [])
  return rows.map((row) => ({
    stateId: row.id,
    contactId: row.contact_id,
    agentId: row.agent_id || null,
    channel: row.channel || 'chat',
    status: row.status,
    signal: row.signal || null,
    policyHash: row.intelligence_policy_hash || '',
    source: row.intelligence_source || '',
    updatedAt: row.intelligence_updated_at || null,
    intelligence: normalizeConversationIntelligenceState(parseJson(row.intelligence_state_json, {}), {
      channel: row.channel || 'chat'
    })
  }))
}
