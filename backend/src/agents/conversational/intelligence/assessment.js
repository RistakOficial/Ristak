import { Agent, Runner } from '@openai/agents'
import { z } from 'zod'
import { CHEAPEST_OPENAI_MODEL } from '../../../config/openAIModels.js'
import { logger } from '../../../utils/logger.js'
import {
  CONVERSATION_STAGES,
  STRATEGY_ACTIONS,
  TOOL_INTENTS,
  deriveLeadTemperature,
  normalizeConversationIntelligenceState
} from './contracts.js'

const evidenceItemSchema = z.object({
  key: z.string(),
  value: z.string(),
  evidence: z.string(),
  messageId: z.string().nullable(),
  source: z.enum(['contact', 'tool', 'business', 'system'])
})

const hypothesisSchema = evidenceItemSchema.extend({ confidence: z.number().min(0).max(1) })

const assessmentSchema = z.object({
  stage: z.enum(CONVERSATION_STAGES),
  summary: z.string(),
  intent: z.object({
    explicit: z.string(),
    implicit: z.string(),
    confidence: z.number().min(0).max(1)
  }),
  confirmedFacts: z.array(evidenceItemSchema),
  hypotheses: z.array(hypothesisSchema),
  contradictions: z.array(z.object({
    key: z.string(),
    previousValue: z.string(),
    currentValue: z.string(),
    evidence: z.string()
  })),
  signals: z.object({
    advance: z.number().min(0).max(1),
    purchase: z.number().min(0).max(1),
    scheduling: z.number().min(0).max(1),
    attendance: z.number().min(0).max(1),
    cancellation: z.number().min(0).max(1),
    disengagement: z.number().min(0).max(1),
    objection: z.number().min(0).max(1),
    humanNeeded: z.number().min(0).max(1),
    disqualification: z.number().min(0).max(1),
    comparisonShopping: z.number().min(0).max(1),
    trust: z.number().min(0).max(1),
    clarityNeeded: z.number().min(0).max(1),
    proposalReadiness: z.number().min(0).max(1),
    congruence: z.number().min(0).max(1)
  }),
  qualification: z.object({
    status: z.enum(['unknown', 'qualified', 'disqualified', 'partial']),
    matched: z.array(z.string()),
    missing: z.array(z.string()),
    disqualifiers: z.array(z.string())
  }),
  objections: z.array(z.object({
    category: z.enum([
      'price', 'time', 'trust', 'authority', 'comparison', 'risk', 'fit',
      'results', 'previous_experience', 'urgency', 'clarity', 'commitment', 'other'
    ]),
    status: z.enum(['expressed', 'possible', 'resolved']),
    confidence: z.number().min(0).max(1),
    evidence: z.string()
  })),
  missingInformation: z.array(z.string()),
  recommendation: z.object({
    action: z.enum(STRATEGY_ACTIONS),
    reason: z.string(),
    primaryQuestion: z.string(),
    tool: z.enum(TOOL_INTENTS),
    shouldReply: z.boolean()
  }),
  followUp: z.object({
    recommended: z.boolean(),
    reason: z.string(),
    angle: z.string(),
    stop: z.boolean()
  }),
  handoff: z.object({
    recommended: z.boolean(),
    reason: z.string(),
    urgency: z.enum(['normal', 'high'])
  })
})

const INTERNAL_CONTEXT_PREFIX = '[Contexto interno de Ristak:'
const HUMAN_REQUEST_PATTERN = /\b(?:humano|persona real|asesor|asesora|ejecutiv[oa]|representante|alguien del equipo|hablar con alguien|que me llamen|p[aá]same con)\b/i
const FRUSTRATION_PATTERN = /\b(?:molest[oa]|enojad[oa]|frustrad[oa]|p[eé]simo|terrible|ya te dije|no entiendes|deja de preguntar|me est[aá]s mareando)\b/i
const ADVANCE_PATTERN = /\b(?:quiero (?:agendar|comprar|pagar|avanzar|empezar)|ag[eé]ndame|m[aá]ndame (?:el )?link|d[oó]nde pago|c[oó]mo pago|me quedo con|confirmo|ese horario|esa hora)\b/i
const SCHEDULE_PATTERN = /\b(?:cita|agend|reserv|horario|disponibilidad|consulta|llamada)\b/i
const PURCHASE_PATTERN = /\b(?:compr|pagar|pago|link de pago|precio|costo|valor|mensualidad|anticipo)\b/i
const PRICE_OBJECTION_PATTERN = /\b(?:car[oa]|muy alto|no me alcanza|presupuesto|descuento|rebaja|precio|costo)\b/i
const TIME_OBJECTION_PATTERN = /\b(?:no tengo tiempo|luego|despu[eé]s|otro d[ií]a|ahorita no|m[aá]s adelante)\b/i
const TRUST_PATTERN = /\b(?:confianza|segur[oa]|garant[ií]a|reseñas|testimonios|funciona|resultados|estafa|real)\b/i
const COMPARISON_PATTERN = /\b(?:comparando|otra opci[oó]n|otros? lugares|cotizando|viendo opciones)\b/i
const NEGATIVE_ANSWER_PATTERN = /\b(?:no me interesa|ya no|no quiero|d[eé]jame|no escribas|basta|cancelar)\b/i
const ACK_ONLY_PATTERN = /^(?:s[ií]|si|ok|okay|va|sale|dale|claro|perfecto|listo|gracias)[\s.!?¿¡]*$/i
const TENTATIVE_COMMITMENT_PATTERN = /\b(?:creo que s[ií]|supongo|tal vez|quiz[aá]|si puedo|si alcanzo|a ver si|probablemente|intentar[eé]|no estoy segur[oa])\b/i
const RESCHEDULE_PATTERN = /\b(?:reprogram|cambiar (?:la )?(?:cita|hora|fecha)|otro horario|ya mov[ií] la cita|cancel[eé] antes)\b/i

function cleanText(value, maxLength = 1400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function visibleMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message, index) => ({
      id: cleanText(message.id || message.messageId || message.message_id, 160) || `m${index + 1}`,
      role: message.role,
      content: cleanText(message.content || message.message_text || message.text, 2400)
    }))
    .filter((message) => message.content && !message.content.startsWith(INTERNAL_CONTEXT_PREFIX))
    .slice(-24)
}

function conversationText(messages = []) {
  return visibleMessages(messages)
    .map((message) => `[${message.id}] ${message.role === 'user' ? 'CONTACTO' : 'AGENTE'}: ${message.content}`)
    .join('\n')
    .slice(-14000)
}

function latestUserMessage(messages = []) {
  return [...visibleMessages(messages)].reverse().find((message) => message.role === 'user') || null
}

function configuredRequiredItems(policy = {}) {
  return Array.isArray(policy?.qualification?.requiredData) ? policy.qualification.requiredData : []
}

function deterministicFacts(messages = []) {
  const facts = []
  for (const message of visibleMessages(messages).filter((item) => item.role === 'user').slice(-12)) {
    const text = message.content
    const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]
    if (email) facts.push({ key: 'email', value: email, evidence: text, messageId: message.id, source: 'contact' })

    const phone = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0]?.replace(/\s+/g, ' ').trim()
    if (phone) facts.push({ key: 'phone', value: phone, evidence: text, messageId: message.id, source: 'contact' })

    const name = text.match(/\b(?:me llamo|soy)\s+([\p{L}][\p{L}'’-]{1,50}(?:\s+[\p{L}][\p{L}'’-]{1,50}){0,3})/iu)?.[1]
    if (name) facts.push({ key: 'name', value: name, evidence: text, messageId: message.id, source: 'contact' })

    const duration = text.match(/\b(?:desde hace|hace|llevo)\s+([^,.!?]{2,80})/i)?.[0]
    if (duration) facts.push({ key: 'duration', value: duration, evidence: text, messageId: message.id, source: 'contact' })

    const desired = text.match(/\b(?:quiero|necesito|busco)\s+([^,.!?]{3,180})/i)?.[0]
    if (desired) facts.push({ key: 'desired_outcome', value: desired, evidence: text, messageId: message.id, source: 'contact' })

    const situation = text.match(/\b(?:tengo|me pasa|estoy|mi problema es)\s+([^.!?]{3,220})/i)?.[0]
    if (situation) facts.push({ key: 'current_situation', value: situation, evidence: text, messageId: message.id, source: 'contact' })
  }
  return facts
}

function deterministicContradictions(previousState = {}, currentFacts = []) {
  const previousFacts = previousState?.story?.confirmedFacts || []
  const contradictions = []
  for (const fact of currentFacts) {
    const previous = [...previousFacts].reverse().find((item) => String(item?.key || '').toLowerCase() === String(fact.key).toLowerCase())
    if (!previous || String(previous.value).toLowerCase() === String(fact.value).toLowerCase()) continue
    contradictions.push({
      key: fact.key,
      previousValue: previous.value,
      currentValue: fact.value,
      evidence: fact.evidence
    })
  }
  return contradictions.slice(0, 12)
}

function normalizedWords(value = '') {
  return cleanText(value, 1000)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) || []
}

function criterionAppearsInText(criterion = '', text = '') {
  const normalizedCriterion = normalizedWords(criterion).join(' ')
  const normalizedText = normalizedWords(text).join(' ')
  if (!normalizedCriterion || !normalizedText) return false
  if (normalizedText.includes(normalizedCriterion)) return true
  const important = normalizedWords(criterion).filter((word) => !['para', 'como', 'debe', 'tener', 'solo', 'personas'].includes(word))
  return important.length >= 2 && important.every((word) => normalizedText.includes(word))
}

function requiredItemIsKnown(item = '', facts = [], knownText = '') {
  const label = normalizedWords(item).join(' ')
  const keys = new Set((facts || []).map((fact) => String(fact?.key || '').toLowerCase()))
  if (/\b(?:correo|email|mail)\b/.test(label) && keys.has('email')) return true
  if (/\b(?:telefono|celular|whatsapp)\b/.test(label) && keys.has('phone')) return true
  if (/\b(?:nombre)\b/.test(label) && keys.has('name')) return true
  return criterionAppearsInText(item, knownText)
}

function deterministicObjections(text = '') {
  const objections = []
  if (PRICE_OBJECTION_PATTERN.test(text)) objections.push({ category: 'price', status: 'expressed', confidence: 0.9, evidence: text })
  if (TIME_OBJECTION_PATTERN.test(text)) objections.push({ category: 'time', status: 'expressed', confidence: 0.9, evidence: text })
  if (TRUST_PATTERN.test(text)) objections.push({ category: 'trust', status: 'expressed', confidence: 0.8, evidence: text })
  if (COMPARISON_PATTERN.test(text)) objections.push({ category: 'comparison', status: 'expressed', confidence: 0.9, evidence: text })
  return objections
}

export function assessConversationDeterministically({ messages = [], policy = {}, previousState = null, followUpMode = false } = {}) {
  const previous = normalizeConversationIntelligenceState(previousState || {}, {
    objective: policy?.objective?.type || 'custom'
  })
  const latest = latestUserMessage(messages)
  const text = latest?.content || ''
  const userMessages = visibleMessages(messages).filter((message) => message.role === 'user')
  const substantive = userMessages.filter((message) => message.content.length >= 18 && !ACK_ONLY_PATTERN.test(message.content))
  const asksHuman = HUMAN_REQUEST_PATTERN.test(text)
  const frustrated = FRUSTRATION_PATTERN.test(text)
  const wantsAdvance = ADVANCE_PATTERN.test(text)
  const wantsSchedule = SCHEDULE_PATTERN.test(text)
  const wantsPurchase = PURCHASE_PATTERN.test(text)
  const optsOut = NEGATIVE_ANSWER_PATTERN.test(text)
  const objections = deterministicObjections(text)
  const requiredItems = configuredRequiredItems(policy)
  const knownText = `${previous.summary} ${userMessages.map((message) => message.content).join(' ')}`.toLowerCase()
  const currentFacts = deterministicFacts(messages)
  const allFacts = [...(previous.story?.confirmedFacts || []), ...currentFacts]
  const missingRequired = requiredItems.filter((item) => !requiredItemIsKnown(item, allFacts, knownText))
  const configuredDisqualifiers = Array.isArray(policy?.qualification?.disqualifies) ? policy.qualification.disqualifies : []
  const matchedDisqualifiers = configuredDisqualifiers.filter((criterion) => criterionAppearsInText(criterion, text))
  const tentativeCommitment = TENTATIVE_COMMITMENT_PATTERN.test(text)
  const rescheduleHistory = RESCHEDULE_PATTERN.test(knownText)

  const advance = optsOut ? 0.02 : wantsAdvance ? 0.88 : substantive.length >= 2 ? 0.48 : 0.2
  const trust = frustrated ? 0.12 : TRUST_PATTERN.test(text) ? 0.3 : substantive.length >= 2 ? 0.55 : 0.35
  const disengagement = optsOut ? 0.95 : frustrated ? 0.72 : text.length < 6 ? 0.48 : 0.18
  const qualificationStatus = matchedDisqualifiers.length
    ? 'disqualified'
    : missingRequired.length
      ? (substantive.length ? 'partial' : 'unknown')
      : (requiredItems.length ? 'qualified' : 'unknown')
  const shouldHandoff = asksHuman || frustrated
  const directQuestion = /\?/.test(text) || /^(?:cu[aá]nto|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|tienen|hacen|incluye|puedo)\b/i.test(text)
  const action = followUpMode
    ? (optsOut ? 'wait' : 'follow_up')
    : shouldHandoff
      ? 'handoff'
      : optsOut
        ? 'close_respectfully'
        : directQuestion
          ? 'answer_question'
          : wantsAdvance
            ? 'propose_next_step'
            : missingRequired.length
              ? 'collect_required_data'
              : substantive.length
                ? 'explore_outcome'
                : 'ask_clarifying_question'

  return {
    stage: followUpMode ? 'follow_up' : wantsAdvance ? 'decision' : substantive.length ? 'discovery' : 'opening',
    summary: userMessages.slice(-6).map((message) => message.content).join(' | ').slice(0, 1300),
    intent: {
      explicit: cleanText(text, 500),
      implicit: wantsAdvance ? 'Quiere avanzar al siguiente paso.' : directQuestion ? 'Busca una respuesta concreta.' : '',
      confidence: text ? (wantsAdvance || directQuestion ? 0.85 : text.length < 12 ? 0.25 : 0.55) : 0
    },
    confirmedFacts: currentFacts,
    hypotheses: [],
    contradictions: deterministicContradictions(previous, currentFacts),
    signals: {
      advance,
      purchase: wantsPurchase ? 0.72 : 0.12,
      scheduling: wantsSchedule ? 0.75 : 0.12,
      attendance: tentativeCommitment && wantsSchedule ? 0.38 : wantsSchedule && wantsAdvance ? 0.68 : 0.5,
      cancellation: rescheduleHistory ? 0.78 : tentativeCommitment && wantsSchedule ? 0.68 : TIME_OBJECTION_PATTERN.test(text) ? 0.55 : 0.12,
      disengagement,
      objection: objections.length ? 0.85 : 0.12,
      humanNeeded: shouldHandoff ? 0.95 : 0.08,
      disqualification: matchedDisqualifiers.length ? 0.95 : optsOut ? 0.7 : 0.05,
      comparisonShopping: COMPARISON_PATTERN.test(text) ? 0.85 : 0.1,
      trust,
      clarityNeeded: directQuestion ? 0.62 : text.length < 12 ? 0.55 : 0.28,
      proposalReadiness: wantsAdvance ? 0.85 : substantive.length >= 2 ? 0.4 : 0.12,
      congruence: tentativeCommitment && wantsAdvance ? 0.38 : wantsAdvance && text.length < 8 ? 0.45 : optsOut ? 0.25 : 0.65
    },
    qualification: {
      status: qualificationStatus,
      matched: requiredItems.filter((item) => !missingRequired.includes(item)),
      missing: missingRequired,
      disqualifiers: matchedDisqualifiers.length
        ? matchedDisqualifiers
        : optsOut ? ['La persona pidió detener o cerrar la conversación.'] : []
    },
    objections,
    missingInformation: missingRequired,
    recommendation: {
      action,
      reason: shouldHandoff
        ? 'La persona pidió atención humana o mostró frustración que requiere intervención.'
        : directQuestion
          ? 'Primero hay que responder la pregunta concreta.'
          : 'Elegir el siguiente paso con la información disponible.',
      primaryQuestion: '',
      tool: shouldHandoff ? 'send_to_human' : 'none',
      shouldReply: action !== 'wait'
    },
    followUp: {
      recommended: followUpMode && !optsOut,
      reason: followUpMode && !optsOut ? 'Hay un punto abierto que puede retomarse con contexto.' : '',
      angle: previous.summary || '',
      stop: optsOut
    },
    handoff: {
      recommended: shouldHandoff,
      reason: asksHuman ? 'La persona pidió hablar con alguien.' : frustrated ? 'La persona muestra frustración.' : '',
      urgency: frustrated ? 'high' : 'normal'
    }
  }
}

function mergeEvidence(previousItems = [], currentItems = [], { hypotheses = false } = {}) {
  const merged = new Map()
  for (const item of [...previousItems, ...currentItems]) {
    if (!item?.key || !item?.value) continue
    const key = hypotheses ? String(item.key).toLowerCase() : `${String(item.key).toLowerCase()}:${String(item.value).toLowerCase()}`
    const existing = merged.get(key)
    if (!existing || Number(item.confidence || 1) >= Number(existing.confidence || 1)) merged.set(key, item)
  }
  return [...merged.values()].slice(-30)
}

export function mergeConversationAssessment({ previousState = null, assessment = {}, policy = {}, channel = 'chat', now = new Date() } = {}) {
  const previous = normalizeConversationIntelligenceState(previousState || {}, {
    objective: policy?.objective?.type || 'custom',
    channel
  })
  const candidate = normalizeConversationIntelligenceState({
    ...assessment,
    objective: policy?.objective?.type || previous.objective,
    channel,
    story: {
      confirmedFacts: assessment.confirmedFacts,
      hypotheses: assessment.hypotheses,
      contradictions: assessment.contradictions
    },
    strategy: assessment.recommendation,
    revision: previous.revision + 1,
    updatedAt: now.toISOString()
  }, { objective: previous.objective, channel })

  candidate.story.confirmedFacts = mergeEvidence(previous.story.confirmedFacts, candidate.story.confirmedFacts)
  candidate.story.hypotheses = mergeEvidence(previous.story.hypotheses, candidate.story.hypotheses, { hypotheses: true })
    .filter((hypothesis) => !candidate.story.confirmedFacts.some((fact) => fact.key.toLowerCase() === hypothesis.key.toLowerCase() && fact.value.toLowerCase() === hypothesis.value.toLowerCase()))
  candidate.story.contradictions = [...previous.story.contradictions, ...candidate.story.contradictions].slice(-12)
  candidate.temperature = deriveLeadTemperature(candidate.signals, candidate.qualification.status)
  return candidate
}

const ASSESSMENT_INSTRUCTIONS = `Eres el módulo de ASSESSMENT de una IA conversacional de negocio. No redactas el mensaje visible y no ejecutas acciones. Lees una sola conversación y devuelves estado estructurado.

Reglas inamovibles:
- Separa HECHOS confirmados de HIPÓTESIS. Un hecho requiere una frase explícita del contacto o un resultado de herramienta. Una hipótesis siempre lleva confidence y nunca se presenta como verdad.
- No infieras raza, etnia, religión, política, orientación sexual, género, salud, diagnóstico, salud mental, discapacidad, embarazo, ingresos, riqueza, crédito, nacionalidad o migración salvo que la persona lo haya compartido explícitamente y sea estrictamente necesario; aun así guárdalo sólo como hecho, nunca como hipótesis.
- No digas que miente, manipula o va a actuar de cierta forma. Evalúa probabilidades con prudencia y evidencia breve.
- Interés verbal no equivale a compromiso. Observa claridad, especificidad, preguntas, acciones, evasivas, cambios y aceptación de pasos concretos.
- No inventes información del negocio ni resultados de herramientas.
- Una pregunta directa debe favorecer answer_question antes de empujar venta.
- Un pedido explícito de humano, frustración, riesgo de información incorrecta o fallo crítico favorece handoff.
- El objetivo puede ser vender, agendar, recopilar datos, filtrar, resolver o transferir. No fuerces un arco comercial universal.
- Devuelve evidencia corta y messageId cuando exista. No incluyas cadena de pensamiento ni razonamiento privado; sólo etiquetas, probabilidades y razones concisas auditables.`

async function assessWithModel({ messages, policy, previousState, runtime, model, followUpMode }) {
  const assessmentModel = runtime?.providerId === 'openai'
    ? CHEAPEST_OPENAI_MODEL
    : (model || policy?.model || CHEAPEST_OPENAI_MODEL)
  const agent = new Agent({
    name: 'Ristak · Assessment conversacional',
    model: assessmentModel,
    instructions: ASSESSMENT_INSTRUCTIONS,
    outputType: assessmentSchema
  })
  const runner = new Runner({ modelProvider: runtime.modelProvider, tracingDisabled: true })
  const prompt = [
    `POLÍTICA COMPILADA:\n${JSON.stringify({
      objective: policy.objective,
      qualification: policy.qualification,
      permissions: policy.permissions,
      businessRules: policy.business?.rules || '',
      handoffRules: policy.business?.handoffRules || ''
    })}`,
    `ESTADO ANTERIOR (puede estar vacío):\n${JSON.stringify(normalizeConversationIntelligenceState(previousState || {}, { objective: policy?.objective?.type || 'custom' }))}`,
    `MODO SEGUIMIENTO: ${followUpMode ? 'sí' : 'no'}`,
    `CONVERSACIÓN:\n${conversationText(messages) || '(vacía)'}`,
    'Actualiza el assessment para el último mensaje.'
  ].join('\n\n')

  const result = await runner.run(agent, [{ role: 'user', content: prompt }], {
    maxTurns: 2,
    context: { category: 'conversational_assessment' }
  })
  if (result.finalOutput && typeof result.finalOutput === 'object') return result.finalOutput
  const raw = cleanText(result.finalOutput, 20000)
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw)
  return assessmentSchema.parse(parsed)
}

export async function analyzeConversationIntelligence({
  messages = [],
  policy = {},
  previousState = null,
  runtime = null,
  model = null,
  channel = 'chat',
  followUpMode = false,
  now = new Date()
} = {}) {
  let assessment
  let source = 'deterministic'
  if (runtime?.modelProvider) {
    try {
      assessment = await assessWithModel({ messages, policy, previousState, runtime, model, followUpMode })
      source = 'model'
    } catch (error) {
      logger.warn(`[Inteligencia conversacional] Assessment estructurado falló (${error?.message || error}); se usa fallback determinista.`)
    }
  }
  if (!assessment) assessment = assessConversationDeterministically({ messages, policy, previousState, followUpMode })

  return {
    state: mergeConversationAssessment({ previousState, assessment, policy, channel, now }),
    source
  }
}
