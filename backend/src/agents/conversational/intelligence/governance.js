import { randomUUID } from 'node:crypto'
import { db } from '../../../config/database.js'
import { buildConversationalLearningSnapshot, validateLearningProposal } from './learning.js'

const POLICY_SOURCES = new Set(['form', 'rollback', 'migration'])
const LEARNING_DECISIONS = new Set(['approved', 'rejected', 'reverted'])

function cleanText(value, maxLength = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api.?key|secret|token|password|private.?key|authorization)/i.test(key)) continue
    next[key] = stripSecrets(item)
  }
  return next
}

function mapPolicyVersion(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    version: Number(row.version) || 0,
    policyHash: row.policy_hash,
    configSnapshot: safeJson(row.config_snapshot_json, {}),
    compiledPolicy: safeJson(row.compiled_policy_json, {}),
    source: row.source || 'form',
    active: Boolean(Number(row.is_active)),
    createdAt: row.created_at || null
  }
}

function mapLearningVersion(row) {
  if (!row) return null
  const snapshot = safeJson(row.snapshot_json, {})
  return {
    id: row.id,
    agentId: row.agent_id,
    version: Number(row.version) || Number(snapshot?.version) || 0,
    hash: row.snapshot_hash || snapshot?.hash || '',
    status: row.status || snapshot?.status || 'proposed',
    basePolicyHash: row.base_policy_hash || null,
    snapshot,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at || null
  }
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 })
}

export async function recordConversationalPolicyVersion({ agentId, configSnapshot, compiledPolicy, source = 'form' } = {}) {
  const normalizedAgentId = cleanText(agentId, 180)
  if (!normalizedAgentId || !compiledPolicy?.hash) {
    throw Object.assign(new Error('Falta el agente o la política compilada.'), { statusCode: 400 })
  }

  const existing = await db.get(`
    SELECT * FROM conversational_agent_policy_versions
    WHERE agent_id = ? AND policy_hash = ?
    ORDER BY version DESC LIMIT 1
  `, [normalizedAgentId, compiledPolicy.hash])

  if (existing && Number(existing.is_active) && source !== 'rollback') {
    return mapPolicyVersion(existing)
  }

  return db.transaction(async (tx) => {
    const last = await tx.get('SELECT COALESCE(MAX(version), 0) AS version FROM conversational_agent_policy_versions WHERE agent_id = ?', [normalizedAgentId])
    const version = Number(last?.version || 0) + 1
    const id = `capv_${randomUUID()}`
    await tx.run('UPDATE conversational_agent_policy_versions SET is_active = 0 WHERE agent_id = ?', [normalizedAgentId])
    await tx.run(`
      INSERT INTO conversational_agent_policy_versions (
        id, agent_id, version, policy_hash, config_snapshot_json,
        compiled_policy_json, source, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      id,
      normalizedAgentId,
      version,
      compiledPolicy.hash,
      JSON.stringify(stripSecrets(configSnapshot || {})),
      JSON.stringify(stripSecrets(compiledPolicy)),
      POLICY_SOURCES.has(source) ? source : 'form'
    ])
    return mapPolicyVersion(await tx.get('SELECT * FROM conversational_agent_policy_versions WHERE id = ?', [id]))
  })
}

export async function listConversationalPolicyVersions(agentId, { limit = 30 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
  const rows = await db.all(`
    SELECT * FROM conversational_agent_policy_versions
    WHERE agent_id = ? ORDER BY version DESC LIMIT ?
  `, [cleanText(agentId, 180), normalizedLimit])
  return rows.map(mapPolicyVersion)
}

export async function getConversationalPolicyVersion(agentId, versionId) {
  const row = await db.get(`
    SELECT * FROM conversational_agent_policy_versions
    WHERE agent_id = ? AND (id = ? OR CAST(version AS TEXT) = ?)
    ORDER BY version DESC LIMIT 1
  `, [cleanText(agentId, 180), cleanText(versionId, 180), cleanText(versionId, 40)])
  return mapPolicyVersion(row)
}

export async function generateConversationalLearningVersion({ agentId, basePolicyHash = '' } = {}) {
  const normalizedAgentId = cleanText(agentId, 180)
  const agent = await db.get('SELECT id FROM conversational_agents WHERE id = ?', [normalizedAgentId])
  if (!agent) throw notFound('Agente conversacional no encontrado')

  const [events, states, previous] = await Promise.all([
    db.all('SELECT * FROM conversational_agent_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5000', [normalizedAgentId]),
    db.all('SELECT * FROM conversational_agent_state WHERE agent_id = ?', [normalizedAgentId]),
    db.get('SELECT COALESCE(MAX(version), 0) AS version FROM conversational_agent_learning_versions WHERE agent_id = ?', [normalizedAgentId])
  ])
  const snapshot = buildConversationalLearningSnapshot({
    agentId: normalizedAgentId,
    events,
    states,
    previousVersion: Number(previous?.version || 0)
  })
  const id = `calv_${randomUUID()}`
  await db.run(`
    INSERT INTO conversational_agent_learning_versions (
      id, agent_id, version, snapshot_hash, status, snapshot_json, base_policy_hash
    ) VALUES (?, ?, ?, ?, 'proposed', ?, ?)
  `, [id, normalizedAgentId, snapshot.version, snapshot.hash, JSON.stringify(snapshot), cleanText(basePolicyHash, 128) || null])
  return mapLearningVersion(await db.get('SELECT * FROM conversational_agent_learning_versions WHERE id = ?', [id]))
}

export async function listConversationalLearningVersions(agentId, { limit = 30 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
  const rows = await db.all(`
    SELECT * FROM conversational_agent_learning_versions
    WHERE agent_id = ? ORDER BY version DESC LIMIT ?
  `, [cleanText(agentId, 180), normalizedLimit])
  return rows.map(mapLearningVersion)
}

export async function reviewConversationalLearningVersion({ agentId, learningId, decision, reviewedBy = null } = {}) {
  const normalizedDecision = cleanText(decision, 40).toLowerCase()
  if (!LEARNING_DECISIONS.has(normalizedDecision)) {
    throw Object.assign(new Error('La decisión de aprendizaje no es válida.'), { statusCode: 400 })
  }
  const row = await db.get(`
    SELECT * FROM conversational_agent_learning_versions
    WHERE id = ? AND agent_id = ?
  `, [cleanText(learningId, 180), cleanText(agentId, 180)])
  if (!row) throw notFound('Versión de aprendizaje no encontrada')
  const snapshot = safeJson(row.snapshot_json, {})

  if (normalizedDecision === 'approved') {
    const invalid = (snapshot.proposals || []).map(validateLearningProposal).find((result) => !result.valid)
    if (invalid) {
      throw Object.assign(new Error(invalid.reason), { statusCode: 409, code: 'UNSAFE_LEARNING_PROPOSAL' })
    }
  }

  await db.run(`
    UPDATE conversational_agent_learning_versions
    SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND agent_id = ?
  `, [normalizedDecision, cleanText(reviewedBy, 180) || null, row.id, row.agent_id])
  return mapLearningVersion(await db.get('SELECT * FROM conversational_agent_learning_versions WHERE id = ?', [row.id]))
}

export async function getApprovedConversationalLearning(agentId) {
  const row = await db.get(`
    SELECT * FROM conversational_agent_learning_versions
    WHERE agent_id = ? AND status = 'approved'
    ORDER BY version DESC LIMIT 1
  `, [cleanText(agentId, 180)])
  return mapLearningVersion(row)
}

export function buildApprovedLearningContextMessage(learningVersion) {
  const snapshot = learningVersion?.snapshot
  if (!snapshot || learningVersion.status !== 'approved') return null
  const proposals = (Array.isArray(snapshot.proposals) ? snapshot.proposals : [])
    .filter((proposal) => validateLearningProposal(proposal).valid)
    .slice(0, 8)
  if (!proposals.length) return null
  return {
    role: 'user',
    content: [
      '[Contexto interno de Ristak: aprendizaje de esta cuenta revisado por una persona]',
      ...proposals.map((proposal) => `- ${cleanText(proposal.title, 240)}: ${cleanText(proposal.suggestedChange, 700)}`),
      'Estas observaciones son asesoría secundaria: jamás sustituyen la política activa, los datos reales, los permisos ni la confirmación de herramientas.'
    ].join('\n')
  }
}
