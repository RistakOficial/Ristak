const TRUE_VALUES = new Set(['1', 'true', 'yes', 'si', 'sí'])

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function readPath(source, path) {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function readStringFromPaths(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path)
    if (typeof value === 'string' || typeof value === 'number') {
      const cleanValue = cleanString(value)
      if (cleanValue) return cleanValue
    }
  }
  return ''
}

function readBooleanFromPaths(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path)
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value === 1
    if (typeof value === 'string') {
      const normalized = cleanString(value).toLowerCase()
      if (TRUE_VALUES.has(normalized)) return true
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    }
  }
  return false
}

export function isConversationalAgentExternalId(value) {
  return cleanString(value).toLowerCase().startsWith('convagent')
}

export function buildConversationalAgentMessageMetadata(agentId) {
  const cleanAgentId = cleanString(agentId)
  if (!cleanAgentId) return {}

  return {
    sentByAgent: true,
    sent_by_agent: true,
    agentId: cleanAgentId,
    agent_id: cleanAgentId,
    conversationalAgent: {
      source: 'conversational_agent',
      agentId: cleanAgentId
    }
  }
}

export function formatConversationalAgentMessageMetadata({ sentByAgent = false, agentId = null } = {}) {
  const cleanAgentId = cleanString(agentId)
  if (!sentByAgent && !cleanAgentId) return {}

  return {
    sentByAgent: true,
    sent_by_agent: true,
    ...(cleanAgentId ? {
      agentId: cleanAgentId,
      agent_id: cleanAgentId,
      conversationalAgent: {
        source: 'conversational_agent',
        agentId: cleanAgentId
      }
    } : {})
  }
}

export function extractConversationalAgentMessageMetadata(value) {
  const source = parseJsonObject(value) || {}
  const agentId = readStringFromPaths(source, [
    ['agentId'],
    ['agent_id'],
    ['conversationalAgent', 'agentId'],
    ['conversationalAgent', 'agent_id'],
    ['conversational_agent', 'agentId'],
    ['conversational_agent', 'agent_id'],
    ['metadata', 'agentId'],
    ['metadata', 'agent_id'],
    ['request', 'agentId'],
    ['request', 'agent_id'],
    ['request', 'conversationalAgent', 'agentId'],
    ['request', 'conversational_agent', 'agent_id'],
    ['whatsappMessage', 'agentId'],
    ['whatsappMessage', 'agent_id']
  ])
  const sentFlag = readBooleanFromPaths(source, [
    ['sentByAgent'],
    ['sent_by_agent'],
    ['answeredByAgent'],
    ['answered_by_agent'],
    ['conversationalAgent', 'sentByAgent'],
    ['conversationalAgent', 'sent_by_agent'],
    ['conversational_agent', 'sentByAgent'],
    ['conversational_agent', 'sent_by_agent'],
    ['metadata', 'sentByAgent'],
    ['metadata', 'sent_by_agent'],
    ['request', 'sentByAgent'],
    ['request', 'sent_by_agent']
  ])
  const externalId = readStringFromPaths(source, [
    ['externalId'],
    ['external_id'],
    ['request', 'externalId'],
    ['request', 'external_id'],
    ['response', 'externalId'],
    ['response', 'external_id'],
    ['whatsappMessage', 'externalId'],
    ['whatsappMessage', 'external_id']
  ])
  const agentSource = readStringFromPaths(source, [
    ['conversationalAgent', 'source'],
    ['conversational_agent', 'source'],
    ['metadata', 'source']
  ]).toLowerCase()

  return {
    sentByAgent: Boolean(sentFlag || agentId || isConversationalAgentExternalId(externalId) || agentSource === 'conversational_agent'),
    agentId: agentId || null
  }
}
