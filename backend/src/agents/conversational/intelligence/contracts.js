export const INTELLIGENCE_SCHEMA_VERSION = 1

export const CONVERSATION_STAGES = [
  'opening',
  'discovery',
  'qualification',
  'consideration',
  'decision',
  'action',
  'follow_up',
  'handoff',
  'completed'
]

export const LEAD_TEMPERATURES = ['cold', 'warm', 'hot']

export const STRATEGY_ACTIONS = [
  'answer_question',
  'ask_clarifying_question',
  'explore_need',
  'explore_outcome',
  'collect_required_data',
  'qualify',
  'disqualify',
  'present_relevant_solution',
  'resolve_objection',
  'build_trust',
  'propose_next_step',
  'execute_tool',
  'follow_up',
  'handoff',
  'wait',
  'close_respectfully'
]

export const TOOL_INTENTS = [
  'none',
  'get_business_profile',
  'list_products',
  'get_contact_profile',
  'save_contact_data',
  'list_calendars',
  'get_free_slots',
  'book_appointment',
  'create_payment_link',
  'send_goal_url',
  'send_trigger_link',
  'mark_ready_to_advance',
  'send_to_human',
  'discard_conversation',
  'stay_silent'
]

const DEFAULT_SIGNALS = Object.freeze({
  advance: 0.2,
  purchase: 0.1,
  scheduling: 0.1,
  attendance: 0.5,
  cancellation: 0.1,
  disengagement: 0.2,
  objection: 0.1,
  humanNeeded: 0.05,
  disqualification: 0.05,
  comparisonShopping: 0.1,
  trust: 0.35,
  clarityNeeded: 0.35,
  proposalReadiness: 0.15,
  congruence: 0.5
})

const SENSITIVE_INFERENCE_PATTERN = /(?:race|ethnic|relig|politic|sexual|gender|health|medical|diagnos|mental|disabil|income|salary|wealth|poverty|credit|pregnan|nationality|immigration|raza|etni|religi|pol[ií]tic|sexual|g[eé]nero|salud|m[eé]dic|diagn[oó]st|mental|discap|ingreso|sueldo|riqueza|pobreza|cr[eé]dito|embaraz|nacionalidad|migraci[oó]n)/i
const SENSITIVE_MEMORY_PATTERN = /(?:race|ethnic|relig|politic|sexual|gender|health|medical|diagnos|mental|disabil|income|salary|wealth|poverty|credit|pregnan|nationality|immigration|disease|symptom|injur|medication|race|raza|etni|religi|pol[ií]tic|sexual|g[eé]nero|salud|m[eé]dic|diagn[oó]st|mental|discap|ingreso|sueldo|riqueza|pobreza|cr[eé]dito|embaraz|nacionalidad|migraci[oó]n|enfermedad|s[ií]ntoma|dolor|duele|lesi[oó]n|medicaci[oó]n|tratamiento psicol[oó]gico|ansiedad|depresi[oó]n)/i

function cleanText(value, maxLength = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function normalizeEnum(value, allowed, fallback) {
  const clean = cleanText(value, 80)
  return allowed.includes(clean) ? clean : fallback
}

export function clampProbability(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return Math.max(0, Math.min(1, Number(fallback) || 0))
  return Math.max(0, Math.min(1, Math.round(number * 1000) / 1000))
}

function uniqueStrings(values, maxItems = 12, maxLength = 280) {
  const seen = new Set()
  const output = []
  for (const value of Array.isArray(values) ? values : []) {
    const clean = cleanText(value, maxLength)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    output.push(clean)
    if (output.length >= maxItems) break
  }
  return output
}

function normalizeEvidenceItem(item = {}, { hypothesis = false } = {}) {
  const key = cleanText(item.key || item.field, 120)
  const value = cleanText(item.value, 700)
  if (!key || !value) return null
  const sensitive = SENSITIVE_MEMORY_PATTERN.test(`${key} ${value} ${item.evidence || ''}`)
  if (hypothesis && (SENSITIVE_INFERENCE_PATTERN.test(key) || sensitive)) return null

  return {
    key,
    value,
    evidence: cleanText(item.evidence, 500),
    messageId: cleanText(item.messageId || item.message_id, 160) || null,
    source: normalizeEnum(item.source, ['contact', 'tool', 'business', 'system'], hypothesis ? 'contact' : 'contact'),
    confidence: hypothesis ? clampProbability(item.confidence, 0.5) : 1,
    retention: sensitive
      ? 'do_not_retain'
      : normalizeEnum(item.retention, ['conversation', 'contact', 'temporary', 'do_not_retain'], hypothesis ? 'conversation' : 'conversation')
  }
}

function normalizeEvidenceItems(items, options = {}) {
  const output = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeEvidenceItem(item, options)
    if (!normalized) continue
    const key = `${normalized.key.toLowerCase()}:${normalized.value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(normalized)
    if (output.length >= 30) break
  }
  return output
}

function normalizeContradictions(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      key: cleanText(item?.key || item?.field, 120),
      previousValue: cleanText(item?.previousValue || item?.previous_value, 500),
      currentValue: cleanText(item?.currentValue || item?.current_value, 500),
      evidence: cleanText(item?.evidence, 500)
    }))
    .filter((item) => item.key && item.currentValue)
    .slice(0, 12)
}

function normalizeObjections(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      category: normalizeEnum(item?.category, [
        'price', 'time', 'trust', 'authority', 'comparison', 'risk', 'fit',
        'results', 'previous_experience', 'urgency', 'clarity', 'commitment', 'other'
      ], 'other'),
      status: normalizeEnum(item?.status, ['expressed', 'possible', 'resolved'], 'possible'),
      confidence: clampProbability(item?.confidence, item?.status === 'expressed' ? 1 : 0.5),
      evidence: cleanText(item?.evidence, 500)
    }))
    .filter((item) => item.evidence || item.status === 'expressed')
    .slice(0, 12)
}

function normalizeSignals(raw = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_SIGNALS).map(([key, fallback]) => [key, clampProbability(raw?.[key], fallback)])
  )
}

export function deriveLeadTemperature(signals = {}, qualificationStatus = 'unknown') {
  if (qualificationStatus === 'disqualified') return 'cold'
  const advance = clampProbability(signals.advance, DEFAULT_SIGNALS.advance)
  const readiness = clampProbability(signals.proposalReadiness, DEFAULT_SIGNALS.proposalReadiness)
  const trust = clampProbability(signals.trust, DEFAULT_SIGNALS.trust)
  const disengagement = clampProbability(signals.disengagement, DEFAULT_SIGNALS.disengagement)
  const score = (advance * 0.45) + (readiness * 0.3) + (trust * 0.2) - (disengagement * 0.2)
  if (score >= 0.65) return 'hot'
  if (score >= 0.32) return 'warm'
  return 'cold'
}

export function createEmptyIntelligenceState({ objective = 'custom', channel = 'chat' } = {}) {
  return {
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    revision: 0,
    objective: cleanText(objective, 120) || 'custom',
    channel: cleanText(channel, 80) || 'chat',
    stage: 'opening',
    summary: '',
    intent: { explicit: '', implicit: '', confidence: 0 },
    story: { confirmedFacts: [], hypotheses: [], contradictions: [] },
    signals: { ...DEFAULT_SIGNALS },
    temperature: 'cold',
    qualification: { status: 'unknown', matched: [], missing: [], disqualifiers: [] },
    objections: [],
    missingInformation: [],
    strategy: {
      action: 'ask_clarifying_question',
      reason: 'Todavía no hay contexto suficiente.',
      primaryQuestion: '',
      tool: 'none',
      shouldReply: true
    },
    followUp: { recommended: false, reason: '', angle: '', stop: false },
    handoff: { recommended: false, reason: '', urgency: 'normal', summary: null },
    outcome: { status: 'open', evidence: [], lastAction: '', toolConfirmed: false },
    updatedAt: null
  }
}

export function normalizeConversationIntelligenceState(raw = {}, defaults = {}) {
  const base = createEmptyIntelligenceState(defaults)
  const qualificationStatus = normalizeEnum(raw?.qualification?.status, ['unknown', 'qualified', 'disqualified', 'partial'], 'unknown')
  const signals = normalizeSignals(raw?.signals)
  const temperature = normalizeEnum(
    raw?.temperature,
    LEAD_TEMPERATURES,
    deriveLeadTemperature(signals, qualificationStatus)
  )

  return {
    ...base,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    revision: Math.max(0, Number(raw?.revision) || 0),
    objective: cleanText(raw?.objective || defaults.objective, 120) || base.objective,
    channel: cleanText(raw?.channel || defaults.channel, 80) || base.channel,
    stage: normalizeEnum(raw?.stage, CONVERSATION_STAGES, base.stage),
    summary: cleanText(raw?.summary, 1400),
    intent: {
      explicit: cleanText(raw?.intent?.explicit, 500),
      implicit: cleanText(raw?.intent?.implicit, 500),
      confidence: clampProbability(raw?.intent?.confidence, 0)
    },
    story: {
      confirmedFacts: normalizeEvidenceItems(raw?.story?.confirmedFacts || raw?.confirmedFacts),
      hypotheses: normalizeEvidenceItems(raw?.story?.hypotheses || raw?.hypotheses, { hypothesis: true }),
      contradictions: normalizeContradictions(raw?.story?.contradictions || raw?.contradictions)
    },
    signals,
    temperature,
    qualification: {
      status: qualificationStatus,
      matched: uniqueStrings(raw?.qualification?.matched),
      missing: uniqueStrings(raw?.qualification?.missing),
      disqualifiers: uniqueStrings(raw?.qualification?.disqualifiers)
    },
    objections: normalizeObjections(raw?.objections),
    missingInformation: uniqueStrings(raw?.missingInformation || raw?.missing_information),
    strategy: {
      action: normalizeEnum(raw?.strategy?.action, STRATEGY_ACTIONS, base.strategy.action),
      reason: cleanText(raw?.strategy?.reason, 700) || base.strategy.reason,
      primaryQuestion: cleanText(raw?.strategy?.primaryQuestion || raw?.strategy?.primary_question, 500),
      tool: normalizeEnum(raw?.strategy?.tool, TOOL_INTENTS, 'none'),
      shouldReply: raw?.strategy?.shouldReply !== false
    },
    followUp: {
      recommended: raw?.followUp?.recommended === true,
      reason: cleanText(raw?.followUp?.reason, 500),
      angle: cleanText(raw?.followUp?.angle, 500),
      stop: raw?.followUp?.stop === true
    },
    handoff: {
      recommended: raw?.handoff?.recommended === true,
      reason: cleanText(raw?.handoff?.reason, 700),
      urgency: normalizeEnum(raw?.handoff?.urgency, ['normal', 'high'], 'normal'),
      summary: raw?.handoff?.summary && typeof raw.handoff.summary === 'object' ? raw.handoff.summary : null
    },
    outcome: {
      status: normalizeEnum(raw?.outcome?.status, ['open', 'pending', 'completed', 'failed', 'disqualified'], 'open'),
      evidence: uniqueStrings(raw?.outcome?.evidence, 10, 500),
      lastAction: cleanText(raw?.outcome?.lastAction || raw?.outcome?.last_action, 160),
      toolConfirmed: raw?.outcome?.toolConfirmed === true
    },
    updatedAt: cleanText(raw?.updatedAt || raw?.updated_at, 80) || null
  }
}

export function isSensitiveInferenceKey(value) {
  return SENSITIVE_INFERENCE_PATTERN.test(cleanText(value, 200))
}

export function containsSensitiveConversationMemory(value) {
  return SENSITIVE_MEMORY_PATTERN.test(cleanText(value, 4000))
}

export function sanitizeConversationIntelligenceForPersistence(raw = {}) {
  const state = normalizeConversationIntelligenceState(raw)
  const redact = (value) => containsSensitiveConversationMemory(value)
    ? 'Información sensible compartida para este turno; no se conserva en la memoria estructurada.'
    : value
  const sanitizeStructured = (value) => {
    if (Array.isArray(value)) return value.map(sanitizeStructured)
    if (!value || typeof value !== 'object') return typeof value === 'string' ? redact(value) : value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeStructured(item)]))
  }

  return normalizeConversationIntelligenceState({
    ...state,
    summary: redact(state.summary),
    intent: {
      explicit: redact(state.intent.explicit),
      implicit: redact(state.intent.implicit),
      confidence: state.intent.confidence
    },
    story: {
      confirmedFacts: state.story.confirmedFacts.filter((item) => item.retention !== 'do_not_retain'),
      hypotheses: state.story.hypotheses.filter((item) => item.retention !== 'do_not_retain'),
      contradictions: state.story.contradictions.filter((item) => !containsSensitiveConversationMemory(`${item.key} ${item.previousValue} ${item.currentValue} ${item.evidence}`))
    },
    objections: state.objections.map((item) => ({
      ...item,
      evidence: redact(item.evidence)
    })),
    handoff: {
      ...state.handoff,
      summary: sanitizeStructured(state.handoff.summary)
    }
  })
}
