import { Agent, Runner } from '@openai/agents'
import { CHEAPEST_OPENAI_MODEL } from '../../config/openAIModels.js'
import { logger } from '../../utils/logger.js'
import { visibleConversationMessages } from './decisionState.js'

/**
 * CANDADO DE PRECONDICIONES DEL OBJETIVO.
 *
 * El nombre público de requireClosingPhasesIfNeeded se conserva porque las tools ya
 * lo consumen, pero aquí no existe un arco narrativo universal. Cada acción terminal
 * exige únicamente la evidencia que esa acción necesita en el mundo real.
 */

const SUPPORTED_ACTIONS = new Set([
  'ready_for_human',
  'book_appointment',
  'ready_to_buy',
  'send_goal_url',
  'send_trigger_link'
])

const INTERNAL_CONTEXT_PREFIX = '[Contexto interno de Ristak:'
const INTERNAL_READY_PATTERN = /\bEstado:\s*ready_to_advance\b/i
const DECLINE_PATTERN = /\b(?:no\s+(?:quiero|gracias|ahorita|por ahora|me interesa|voy a)|mejor\s+no|cancel(?:a|ar|emos)|déjalo|dejalo|ya\s+no)\b/i
const ACK_PATTERN = /^(?:(?:s[ií]+|si|ok|okay|va|sale|dale|claro|correcto|perfecto|est[aá]\s+bien|de\s+acuerdo|me\s+parece|adelante|por\s+favor|listo)[\s,.!?¿¡]*){1,3}$/i
const HUMAN_REQUEST_PATTERN = /\b(?:hablar|comunicarme|contacto|contactarme)\s+con\s+(?:alguien|una?\s+persona|una?\s+asesor(?:a)?|el\s+equipo|una?\s+humano)|\b(?:que\s+me\s+(?:llamen|contacten|atiendan)|p[aá]same\s+con|quiero\s+(?:un\s+asesor|atenci[oó]n\s+humana))\b/i
const HUMAN_OFFER_PATTERN = /\b(?:te\s+(?:paso|comunico|conecto)|quieres\s+(?:hablar|que\s+te\s+contacte)|hablar\s+con|equipo|asesor(?:a)?|humano|especialista)\b/i
const ADVANCE_PATTERN = /\b(?:quiero\s+(?:avanzar|continuar|empezar)|sigamos|vamos\s+adelante|adelante|de\s+acuerdo|me\s+parece|siguiente\s+paso)\b/i
const LINK_REQUEST_PATTERN = /\b(?:m[aá]ndame|env[ií]ame|p[aá]same|comp[aá]rteme|quiero|dame)\s+(?:el\s+)?(?:link|enlace)|\bquiero\s+continuar\s+por\s+(?:link|enlace)\b/i
const LINK_OFFER_PATTERN = /\b(?:link|enlace|continuar\s+por|abrir\s+el)\b/i
const PAYMENT_INTENT_PATTERN = /\b(?:quiero\s+(?:comprar|pagar|contratar)|c[oó]mo\s+(?:pago|compro|contrato)|m[aá]ndame\s+(?:el\s+)?(?:link|enlace)\s+de\s+pago|procedamos\s+con\s+el\s+pago|voy\s+a\s+pagar)\b/i
const PAYMENT_OFFER_PATTERN = /\b(?:pagar|pago|comprar|contratar|link\s+de\s+pago|enlace\s+de\s+pago)\b/i
const MONEY_PATTERN = /(?:[$€£]\s*\d|\b\d[\d.,]*\s*(?:mxn|usd|cop|ars|clp|pen|eur|pesos?|d[oó]lares?|euros?)\b)/i
const DAY_PATTERN = /\b(?:hoy|ma[nñ]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\b\d{1,2}(?:[/-]\d{1,2}(?:[/-]\d{2,4})?|\s+de\s+[a-záéíóúñ]+)\b/i
const TIME_PATTERN = /\b(?:a\s+las\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|hrs?\.?|horas?)\b|\ba\s+las\s+(?:[01]?\d|2[0-3])\b/i
const APPOINTMENT_INTENT_PATTERN = /\b(?:ag[eé]ndame|quiero\s+(?:agendar|una\s+cita)|confirmo\s+(?:la\s+)?cita|ese\s+horario\s+(?:me\s+)?(?:sirve|queda|funciona))\b/i
const APPOINTMENT_OFFER_PATTERN = /\b(?:cita|agendar|agenda|horario|disponible|te\s+queda|te\s+sirve)\b/i

const ACTION_LABELS = {
  ready_for_human: 'pasar el caso al equipo',
  book_appointment: 'crear la cita',
  ready_to_buy: 'crear el enlace de pago',
  send_goal_url: 'enviar el enlace del objetivo',
  send_trigger_link: 'enviar el enlace de avance'
}

export function resolveClosingPreconditions(config = {}) {
  const action = String(config?.successAction || '').trim()
  const objective = String(config?.objective || '').trim()
  const requiredData = String(config?.requiredData || '').trim()
  const requirements = []

  if (action === 'book_appointment') {
    requirements.push({
      id: 'exact_slot_confirmed',
      name: 'Horario real y exacto confirmado',
      criterion: 'La persona aceptó un día y una hora concretos que el agente presentó como disponibilidad real.'
    })
  } else if (action === 'ready_to_buy') {
    requirements.push({
      id: 'payment_details_confirmed',
      name: 'Compra y datos de pago confirmados',
      criterion: 'La conversación identifica qué va a pagar, el valor y la moneda, y la persona pidió o aceptó expresamente el enlace de pago.'
    })
  } else if (action === 'send_goal_url' || action === 'send_trigger_link') {
    requirements.push({
      id: 'link_step_confirmed',
      name: 'Continuación por enlace confirmada',
      criterion: 'La persona pidió el enlace o aceptó de forma explícita continuar por él.'
    })
  } else if (action === 'ready_for_human' && objective === 'datos') {
    requirements.push({
      id: 'configured_data_complete',
      name: 'Datos configurados completos',
      criterion: `Están presentes los datos que el negocio pidió recopilar${requiredData ? `: ${requiredData}` : ', sin agregar requisitos inventados'}.`
    })
  } else if (action === 'ready_for_human' && objective === 'filtrar') {
    requirements.push({
      id: 'configured_qualification_met',
      name: 'Criterio de calificación comprobado',
      criterion: 'La conversación demuestra los criterios de calificación definidos por el negocio; interés general no basta, pero tampoco se exige una historia de venta.'
    })
  } else if (action === 'ready_for_human' && objective === 'custom') {
    requirements.push({
      id: 'custom_goal_met',
      name: 'Objetivo personalizado comprobado',
      criterion: `Se cumplió el objetivo literal configurado por el negocio: ${String(config?.customObjective || 'objetivo personalizado no descrito').trim()}`
    })
  } else if (action === 'ready_for_human') {
    requirements.push({
      id: 'handoff_confirmed',
      name: 'Solicitud o aceptación de atención humana',
      criterion: 'La persona pidió hablar con alguien o aceptó claramente una propuesta concreta de atención por el equipo.'
    })
  }

  if (requiredData && !requirements.some((requirement) => requirement.id === 'configured_data_complete')) {
    requirements.push({
      id: 'required_data_complete',
      name: 'Datos mínimos configurados presentes',
      criterion: `Antes de esta acción deben estar presentes estos datos, sin volver a pedir los que ya constan: ${requiredData}`
    })
  }

  return requirements
}

export function closingPhaseGateApplies(config = {}) {
  return SUPPORTED_ACTIONS.has(String(config?.successAction || '').trim())
}

function rawMessageText(message = {}) {
  return String(message?.content || message?.message_text || message?.text || '').replace(/\s+/g, ' ').trim()
}

function internalContextText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => rawMessageText(message).startsWith(INTERNAL_CONTEXT_PREFIX))
    .map(rawMessageText)
    .join('\n')
    .slice(-5000)
}

function conversationToText(messages = []) {
  return visibleConversationMessages(messages)
    .map((message) => `${message.role === 'user' ? 'CLIENTE' : 'AGENTE'}: ${message.content}`)
    .join('\n')
    .slice(-9000)
}

function recentTurn(messages = []) {
  const visible = visibleConversationMessages(messages)
  let userIndex = -1
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index].role === 'user') {
      userIndex = index
      break
    }
  }
  const latestUser = userIndex >= 0 ? visible[userIndex].content : ''
  const previousAssistant = userIndex >= 0
    ? visible.slice(0, userIndex).reverse().find((message) => message.role === 'assistant')?.content || ''
    : ''
  return { visible, latestUser, previousAssistant }
}

function hasExactSlot(text = '') {
  return DAY_PATTERN.test(text) && TIME_PATTERN.test(text)
}

function acceptedAfterOffer(latestUser = '', previousAssistant = '', offerPattern) {
  if (!offerPattern.test(previousAssistant)) return false
  return ACK_PATTERN.test(latestUser) || ADVANCE_PATTERN.test(latestUser)
}

function deterministicReadiness(messages = [], config = {}) {
  const action = String(config?.successAction || '').trim()
  const objective = String(config?.objective || '').trim()
  const context = internalContextText(messages)
  const { visible, latestUser, previousAssistant } = recentTurn(messages)

  if (INTERNAL_READY_PATTERN.test(context)) {
    return { ready: true, conclusive: true, evidence: ['El runtime marcó ready_to_advance.'], missing: [] }
  }
  if (!latestUser) {
    return { ready: false, conclusive: true, evidence: [], missing: ['explicit_user_evidence'] }
  }
  if (DECLINE_PATTERN.test(latestUser)) {
    return { ready: false, conclusive: true, evidence: [`La última respuesta rechaza avanzar: "${latestUser.slice(0, 120)}"`], missing: ['explicit_acceptance'] }
  }

  if (action === 'book_appointment') {
    const directSlot = hasExactSlot(latestUser) && (APPOINTMENT_INTENT_PATTERN.test(latestUser) || /\b(?:me\s+queda|me\s+sirve|confirmo|s[ií]|va)\b/i.test(latestUser))
    const acceptedOfferedSlot = hasExactSlot(previousAssistant) && APPOINTMENT_OFFER_PATTERN.test(previousAssistant) && (ACK_PATTERN.test(latestUser) || APPOINTMENT_INTENT_PATTERN.test(latestUser))
    return directSlot || acceptedOfferedSlot
      ? { ready: true, conclusive: true, evidence: [`Horario aceptado: "${latestUser.slice(0, 120)}"`], missing: [] }
      : { ready: false, conclusive: true, evidence: [], missing: ['exact_slot_confirmed'] }
  }

  if (action === 'ready_to_buy') {
    const details = `${previousAssistant}\n${latestUser}`
    const explicitlyAccepted = PAYMENT_INTENT_PATTERN.test(latestUser) || acceptedAfterOffer(latestUser, previousAssistant, PAYMENT_OFFER_PATTERN)
    return explicitlyAccepted && MONEY_PATTERN.test(details)
      ? { ready: true, conclusive: true, evidence: [`Pago aceptado con valor visible en la conversación: "${latestUser.slice(0, 120)}"`], missing: [] }
      : { ready: false, conclusive: true, evidence: [], missing: ['payment_details_confirmed'] }
  }

  if (action === 'send_goal_url' || action === 'send_trigger_link') {
    const accepted = LINK_REQUEST_PATTERN.test(latestUser) || acceptedAfterOffer(latestUser, previousAssistant, LINK_OFFER_PATTERN)
    return accepted
      ? { ready: true, conclusive: true, evidence: [`La persona aceptó continuar por enlace: "${latestUser.slice(0, 120)}"`], missing: [] }
      : { ready: false, conclusive: true, evidence: [], missing: ['link_step_confirmed'] }
  }

  if (action === 'ready_for_human') {
    if (HUMAN_REQUEST_PATTERN.test(latestUser) || acceptedAfterOffer(latestUser, previousAssistant, HUMAN_OFFER_PATTERN)) {
      return { ready: true, conclusive: true, evidence: [`La persona pidió o aceptó atención humana: "${latestUser.slice(0, 120)}"`], missing: [] }
    }
    if ((objective === 'citas' || objective === 'ventas') && !String(config?.requiredData || '').trim()) {
      return { ready: false, conclusive: true, evidence: [], missing: ['handoff_confirmed'] }
    }
    // Datos, filtro y metas custom dependen de texto libre configurado. Una IA puede
    // contrastar esa evidencia; una regex no debe inventar el contrato del negocio.
    return { ready: false, conclusive: false, evidence: visible.filter((message) => message.role === 'user').map((message) => message.content).slice(-5), missing: resolveClosingPreconditions(config).map((item) => item.id) }
  }

  return { ready: true, conclusive: true, evidence: [], missing: [] }
}

export async function evaluateClosingPreconditions({ messages = [], config = {}, runtime = null, model = null } = {}) {
  const requirements = resolveClosingPreconditions(config)
  const conversation = conversationToText(messages)
  const internalContext = internalContextText(messages)
  const requirementIds = new Set(requirements.map((requirement) => requirement.id))
  const instructions = `Eres un supervisor de precondiciones de una acción conversacional. Decide si la evidencia real ya permite ejecutar ESA acción. No evalúes una técnica de ventas ni una secuencia narrativa.

Reglas:
- Usa como hechos sólo lo dicho por la persona, resultados reales del sistema y el contexto interno estructurado.
- Separa hechos de interpretaciones. Una interpretación puede orientar, pero no sustituye evidencia.
- No exijas cantidad mínima de mensajes, historia profunda, presión, urgencia ni pasos que no estén en las precondiciones.
- El objetivo puede ser agendar, cobrar, recopilar datos, calificar o cumplir una meta personalizada; no asumas que siempre es vender.
- Una solicitud directa de atención humana es suficiente para un traspaso, aunque la conversación sea corta.
- Sé estricto únicamente con los datos operativos reales: horario exacto para cita, detalles de pago y aceptación para cobrar, o cumplimiento literal de datos/criterios configurados.

Precondiciones:
${requirements.map((requirement) => `- [${requirement.id}] ${requirement.name}: ${requirement.criterion}`).join('\n')}

Responde sólo JSON válido:
{"ready":true|false,"missing":["id"],"evidence":["hecho breve"]}`

  const prompt = `Conversación visible:\n${conversation || '(vacía)'}\n\nContexto interno estructurado:\n${internalContext || '(sin contexto interno)'}\n\nEvalúa las precondiciones de ${ACTION_LABELS[config?.successAction] || 'la acción configurada'}.`
  const validatorModel = runtime?.providerId === 'openai'
    ? CHEAPEST_OPENAI_MODEL
    : (model || config?.model || CHEAPEST_OPENAI_MODEL)
  const agent = new Agent({ name: 'Supervisor de precondiciones del objetivo', model: validatorModel, instructions })
  const runner = new Runner({ modelProvider: runtime.modelProvider, tracingDisabled: true })
  const result = await runner.run(agent, [{ role: 'user', content: prompt }], {
    maxTurns: 2,
    context: { category: 'closing_objective_gate' }
  })

  const output = String(result.finalOutput || '').trim()
  const jsonMatch = output.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`respuesta no-JSON del validador: ${output.slice(0, 160)}`)
  const parsed = JSON.parse(jsonMatch[0])
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .map((id) => String(id || ''))
    .filter((id) => requirementIds.has(id))
  const ready = parsed.ready === true && missing.length === 0
  return {
    ready,
    missing: ready ? [] : (missing.length ? missing : requirements.map((requirement) => requirement.id)),
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((item) => String(item || '')).filter(Boolean).slice(0, 8),
    requirements
  }
}

function buildBlockedResult(config = {}, missingIds = []) {
  const requirements = resolveClosingPreconditions(config)
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement.name]))
  const missingNames = missingIds.map((id) => byId.get(id) || id).filter(Boolean)
  const pending = missingNames.length ? missingNames.join(' · ') : 'la confirmación real del siguiente paso'
  return {
    ok: false,
    objectiveGate: true,
    missing: missingIds,
    error: `Aún no ejecutes ${ACTION_LABELS[config?.successAction] || 'la acción final'}: falta ${pending}. Responde primero cualquier duda pendiente y pide sólo la confirmación o el dato principal que falta; no repitas información ni agregues obstáculos ajenos al objetivo.`
  }
}

/**
 * Compatibilidad con las tools existentes: devuelve un error para que el agente siga
 * conversando o null cuando las precondiciones reales ya están demostradas.
 */
export async function requireClosingPhasesIfNeeded(config, ctx) {
  if (!closingPhaseGateApplies(config)) return null

  const messages = ctx?.conversationMessages || []
  if (visibleConversationMessages(messages).length === 0 && !internalContextText(messages)) {
    // Algunas ejecuciones internas sólo entregan los argumentos de la tool, no el
    // historial. En ese caso mandan los validadores operativos de la propia acción;
    // no fabricamos una falta de evidencia a partir de telemetría ausente.
    return null
  }
  const deterministic = deterministicReadiness(messages, config)
  if (deterministic.ready) return null
  if (deterministic.conclusive) return buildBlockedResult(config, deterministic.missing)

  const runtime = ctx?.aiRuntime
  if (!runtime?.modelProvider) {
    // Metas libres no se pueden validar fielmente con regex. Conservamos el fail-open
    // histórico ante caída del proveedor, sin imponer un guion universal como sustituto.
    logger.warn('[Precondiciones del objetivo] Sin runtime para validar una meta de texto libre; se continúa sin bloquear (fail-open).')
    return null
  }

  try {
    const result = await evaluateClosingPreconditions({ messages, config, runtime, model: ctx?.model })
    return result.ready ? null : buildBlockedResult(config, result.missing)
  } catch (error) {
    logger.warn(`[Precondiciones del objetivo] El validador falló (${error?.message || error}); se continúa sin bloquear (fail-open).`)
    return null
  }
}
