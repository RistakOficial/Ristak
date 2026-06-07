import { randomUUID } from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

const MAX_STRING_LENGTH = 2400
const MAX_JSON_LENGTH = 24000
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 80
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|secret|password|encrypted|openai|stripe|access[_-]?token|refresh[_-]?token|client[_-]?secret)/i

function createLedgerId(prefix) {
  return `${prefix}_${randomUUID()}`
}

function cleanString(value, maxLength = MAX_STRING_LENGTH) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function sanitizeForLedger(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null

  if (typeof value === 'string') {
    return cleanString(value)
  }

  if (['number', 'boolean'].includes(typeof value)) {
    return value
  }

  if (depth >= 6) {
    return '[recortado]'
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => sanitizeForLedger(item, depth + 1))
  }

  if (typeof value === 'object') {
    const output = {}
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)

    for (const [key, item] of entries) {
      output[key] = SECRET_KEY_PATTERN.test(key)
        ? '[redactado]'
        : sanitizeForLedger(item, depth + 1)
    }

    return output
  }

  return cleanString(String(value))
}

function safeJson(value) {
  try {
    const json = JSON.stringify(sanitizeForLedger(value))
    return json.length > MAX_JSON_LENGTH ? `${json.slice(0, MAX_JSON_LENGTH)}...` : json
  } catch {
    return JSON.stringify({ error: 'No se pudo serializar el dato para el rastro.' })
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

async function safeLedgerWrite(label, callback) {
  try {
    return await callback()
  } catch (error) {
    logger.warn(`No se pudo registrar rastro del agente (${label}): ${error.message}`)
    return null
  }
}

export async function startAgentRun({
  userId = null,
  latestUserMessage = '',
  viewContext = {}
} = {}) {
  const id = createLedgerId('run')
  const traceId = randomUUID()

  await db.run(`
    INSERT INTO agent_runs (
      id,
      trace_id,
      user_id,
      status,
      input_summary,
      view_context_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    traceId,
    userId || null,
    cleanString(latestUserMessage, 1200),
    safeJson(viewContext || {})
  ])

  return {
    id,
    traceId
  }
}

export async function updateAgentRun(agentRun, updates = {}) {
  if (!agentRun?.id) return null

  const allowed = {
    status: updates.status,
    domain: updates.domain,
    action: updates.action,
    source_of_truth: updates.sourceOfTruth,
    output_summary: updates.outputSummary,
    route_json: updates.route ? safeJson(updates.route) : undefined,
    model: updates.model,
    usage_json: updates.usage ? safeJson(updates.usage) : undefined,
    error_message: updates.errorMessage
  }
  const entries = Object.entries(allowed).filter(([, value]) => value !== undefined)

  if (!entries.length) return null

  const setClause = entries.map(([key]) => `${key} = ?`).join(', ')
  const params = entries.map(([, value]) => value)

  return safeLedgerWrite('update run', async () => {
    await db.run(`
      UPDATE agent_runs
      SET ${setClause},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [...params, agentRun.id])
  })
}

export async function recordAgentStep(agentRun, {
  stepType,
  toolName = null,
  status = 'completed',
  input = null,
  output = null,
  error = null
} = {}) {
  if (!agentRun?.id || !stepType) return null

  return safeLedgerWrite('record step', async () => {
    const row = await db.get(
      'SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index FROM agent_steps WHERE run_id = ?',
      [agentRun.id]
    )
    const stepIndex = Number(row?.next_index || row?.nextIndex || 1)
    const id = createLedgerId('step')

    await db.run(`
      INSERT INTO agent_steps (
        id,
        run_id,
        step_index,
        step_type,
        tool_name,
        status,
        input_json,
        output_json,
        error_message,
        started_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      agentRun.id,
      stepIndex,
      cleanString(stepType, 120),
      toolName ? cleanString(toolName, 160) : null,
      cleanString(status, 80),
      input === null || input === undefined ? null : safeJson(input),
      output === null || output === undefined ? null : safeJson(output),
      error ? cleanString(error, 2000) : null
    ])

    return {
      id,
      stepIndex
    }
  })
}

export async function completeAgentRun(agentRun, {
  status = 'completed',
  reply = '',
  model = null,
  usage = null,
  error = null,
  route = null
} = {}) {
  if (!agentRun?.id) return null

  return safeLedgerWrite('complete run', async () => {
    await db.run(`
      UPDATE agent_runs
      SET status = ?,
          output_summary = ?,
          model = ?,
          usage_json = ?,
          error_message = ?,
          route_json = COALESCE(?, route_json),
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      cleanString(status, 80),
      cleanString(reply || '', 1600),
      model || null,
      usage ? safeJson(usage) : null,
      error ? cleanString(error, 2000) : null,
      route ? safeJson(route) : null,
      agentRun.id
    ])

    return buildAgentTracePayload(agentRun, status)
  })
}

export function buildAgentTracePayload(agentRun, status = 'running') {
  if (!agentRun?.traceId) return null

  return {
    traceId: agentRun.traceId,
    status,
    detailUrl: `/api/ai-agent/runs/${agentRun.traceId}`
  }
}

export async function getAgentRunTrace(traceId, { userId = null } = {}) {
  const cleanTraceId = cleanString(traceId, 120)
  if (!cleanTraceId) return null

  const run = await db.get(`
    SELECT *
    FROM agent_runs
    WHERE trace_id = ?
      AND (? IS NULL OR user_id = ? OR user_id IS NULL)
    LIMIT 1
  `, [cleanTraceId, userId || null, userId || null])

  if (!run) return null

  const steps = await db.all(`
    SELECT
      id,
      step_index,
      step_type,
      tool_name,
      status,
      input_json,
      output_json,
      error_message,
      started_at,
      completed_at
    FROM agent_steps
    WHERE run_id = ?
    ORDER BY step_index ASC
  `, [run.id])

  return {
    id: run.id,
    traceId: run.trace_id,
    status: run.status,
    domain: run.domain,
    action: run.action,
    sourceOfTruth: run.source_of_truth,
    inputSummary: run.input_summary,
    outputSummary: run.output_summary,
    viewContext: parseJson(run.view_context_json, {}),
    route: parseJson(run.route_json, null),
    model: run.model,
    usage: parseJson(run.usage_json, null),
    errorMessage: run.error_message,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    steps: steps.map(step => ({
      id: step.id,
      index: step.step_index,
      type: step.step_type,
      toolName: step.tool_name,
      status: step.status,
      input: parseJson(step.input_json, null),
      output: parseJson(step.output_json, null),
      errorMessage: step.error_message,
      startedAt: step.started_at,
      completedAt: step.completed_at
    }))
  }
}
