import { Agent, Runner } from '@openai/agents'
import { CHEAPEST_OPENAI_MODEL } from '../../config/openAIModels.js'
import { logger } from '../../utils/logger.js'
import { evaluateConversationalGoalReadiness, visibleConversationMessages } from './decisionState.js'

/**
 * FASES DE CIERRE COMO CANDADO (no prompt).
 *
 * Convierte el "arco de la conversación" del guion de fábrica en validaciones
 * duras: el agente NO puede marcar el objetivo como cumplido (mark_ready_to_advance,
 * book_appointment, create_payment_link, send_goal_url, send_trigger_link) hasta que
 * la conversación demuestre que estas fases se cumplieron DE VERDAD, con contexto real
 * como lo tendría un humano — no con palabras vacías tipo "sí sí quiero".
 *
 * Aplica según el nivel de PERSUASIÓN configurado:
 *  - low (Anfitrión): sin candado (comportamiento actual).
 *  - medium (Estratega): exige el arco completo.
 *  - high (Cerrador): exige el arco con un estándar más profundo/intenso.
 *
 * El validador es una segunda IA barata que LEE la conversación (funciona igual en el
 * tester y en vivo, porque no depende de estado guardado) y decide fase por fase.
 */

export const CLOSING_ARC_PHASES = [
  {
    id: 'problema_contexto',
    name: 'Problema y contexto',
    criterion: 'La persona reveló su problema o necesidad CON contexto real: al menos dos de {desde cuándo lo vive, por qué le pasa, cómo le ha afectado}. No basta una frase suelta ni un "quiero cita/comprar": debe haber entendimiento real del caso, como lo tendría un humano que sí escuchó.'
  },
  {
    id: 'reto',
    name: 'Reto / por qué necesita ayuda',
    criterion: 'El agente puso un reto suave (en el espíritu de "¿seguro que necesitas ayuda con esto?") y la persona articuló POR QUÉ siente que la necesita. No un reto agresivo; un cuestionamiento que la hace calificarse sola.'
  },
  {
    id: 'consecuencia',
    name: 'Costo de no cambiar',
    criterion: 'Se abordó qué va a pasar o cómo se va a sentir la persona si NO cambia su situación (el costo de quedarse igual), conectado con lo que ella misma dijo, sin inventar miedo.'
  },
  {
    id: 'invitacion',
    name: 'Invitación al siguiente paso',
    criterion: 'El agente propuso/invitó al siguiente paso concreto (agendar, hablar con alguien, comprar, etc.) y quedó esperando la confirmación de la persona.'
  },
  {
    id: 'objeciones',
    name: 'Objeciones atendidas',
    criterion: 'Si la persona mostró dudas u objeciones (precio, tiempo, "lo pienso", etc.), se atendieron guiando con conciencia/consecuencias, no se ignoraron. Si NO hubo ninguna objeción, esta fase se considera CUMPLIDA por defecto.'
  },
  {
    id: 'decision',
    name: 'Aceptación explícita',
    criterion: 'La persona aceptó avanzar hacia el objetivo de forma EXPLÍCITA (dijo claramente que sí quiere agendar/comprar/hablar con alguien tras entender su situación). Un interés tibio, un "sí" suelto sin contexto o una simple pregunta de precio NO cuentan.'
  }
]

const HIGH_INTENSITY_NOTE = 'Este agente es de persuasión ALTA (Cerrador): exige un estándar MÁS profundo en cada fase — el problema real debe quedar DIMENSIONADO (no superficial), el costo de no actuar debe estar claro y sentido, y la decisión debe ser una aceptación FIRME, no floja. Ante cualquier fase a medias, márcala como NO cumplida.'

// Piso determinista: sin una plática mínima real no hay nada que validar.
const MIN_SUBSTANTIVE_USER_MESSAGES = 3
const MIN_USER_MESSAGE_LENGTH = 6

/** ¿Este agente usa el candado de fases? (persuasión media/alta) */
export function closingPhaseGateApplies(config = {}) {
  const level = String(config?.persuasionLevel || '').trim().toLowerCase()
  return level === 'medium' || level === 'high'
}

function countSubstantiveUserMessages(messages = []) {
  return visibleConversationMessages(messages).filter((m) => {
    if (!m || m.role !== 'user') return false
    const text = typeof m.content === 'string' ? m.content : ''
    return text.trim().length >= MIN_USER_MESSAGE_LENGTH
  }).length
}

function conversationToText(messages = []) {
  return visibleConversationMessages(messages)
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'AGENTE'}: ${m.content.trim()}`)
    .join('\n')
    .slice(-9000)
}

/**
 * Corre el validador de fases contra la conversación.
 * @returns {{ allMet: boolean, missing: Array<{id,name}>, phases: Array }}
 */
export async function evaluateClosingPhases({ messages = [], config = {}, runtime = null, model = null } = {}) {
  const phases = CLOSING_ARC_PHASES
  const isHigh = String(config?.persuasionLevel || '').trim().toLowerCase() === 'high'
  const conversation = conversationToText(messages)

  const instructions = `Eres un SUPERVISOR de calidad de cierre. Recibes una conversación entre un AGENTE y un CLIENTE. Decide, fase por fase, si el AGENTE ya cumplió DE VERDAD cada fase del arco de cierre, con contexto real y no superficial. Sé ESTRICTO: ante la duda, la fase NO está cumplida. Una simple pregunta de precio o un "sí quiero" sin plática previa NO cumple ninguna fase de fondo.
${isHigh ? HIGH_INTENSITY_NOTE : ''}

Fases a evaluar:
${phases.map((p, i) => `${i + 1}. [${p.id}] ${p.name}: ${p.criterion}`).join('\n')}

Responde ÚNICAMENTE con JSON válido, sin markdown, exactamente:
{"phases":[{"id":"problema_contexto","met":true,"evidence":"..."},{"id":"reto","met":false,"evidence":"..."}, ...]}
Incluye las ${phases.length} fases con su id exacto. "evidence" es una cita o razón muy breve.`

  const userPrompt = `Conversación:\n${conversation || '(vacía)'}\n\nEvalúa cada fase.`

  const validatorModel = runtime?.providerId === 'openai'
    ? CHEAPEST_OPENAI_MODEL
    : (model || config?.model || CHEAPEST_OPENAI_MODEL)

  const agent = new Agent({ name: 'Supervisor de fases de cierre', model: validatorModel, instructions })
  const runner = new Runner({ modelProvider: runtime.modelProvider, tracingDisabled: true })
  const result = await runner.run(agent, [{ role: 'user', content: userPrompt }], {
    maxTurns: 2,
    context: { category: 'closing_phase_gate' }
  })

  const output = String(result.finalOutput || '').trim()
  const jsonMatch = output.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`respuesta no-JSON del validador: ${output.slice(0, 160)}`)
  const parsed = JSON.parse(jsonMatch[0])
  const byId = new Map((Array.isArray(parsed.phases) ? parsed.phases : []).map((p) => [String(p?.id || ''), p]))

  const evaluated = phases.map((p) => {
    const row = byId.get(p.id)
    return { id: p.id, name: p.name, met: row?.met === true, evidence: String(row?.evidence || '') }
  })
  const missing = evaluated.filter((p) => !p.met).map((p) => ({ id: p.id, name: p.name }))
  return { allMet: missing.length === 0, missing, phases: evaluated }
}

/**
 * Candado a llamar al inicio del execute de cada tool de cierre. Devuelve un objeto
 * de error (para que la tool lo regrese y el bot siga conversando) o null si puede cerrar.
 */
export async function requireClosingPhasesIfNeeded(config, ctx) {
  if (!closingPhaseGateApplies(config)) return null

  const messages = ctx?.conversationMessages || []
  const goalReadiness = evaluateConversationalGoalReadiness({ messages, config })
  if (goalReadiness.ready) return null

  // 1) Piso determinista: sin plática real no se cierra (mata el "precio" suelto).
  if (countSubstantiveUserMessages(messages) < MIN_SUBSTANTIVE_USER_MESSAGES) {
    return {
      ok: false,
      phaseGate: true,
      missing: ['problema_contexto'],
      error: 'Aún NO cierres: no ha habido plática suficiente. Primero entiende su problema con contexto real (desde cuándo lo vive, por qué le pasa, cómo le afecta) y recorre el arco antes de avanzar. Sigue conversando.'
    }
  }

  // 2) Validador IA: lee la conversación y decide fase por fase.
  const runtime = ctx?.aiRuntime
  if (!runtime?.modelProvider) {
    // Sin runtime para validar: fail-open para no romper el cierre (el piso ya corrió).
    return null
  }
  try {
    const result = await evaluateClosingPhases({ messages, config, runtime, model: ctx?.model })
    if (result.allMet) return null
    const missingNames = result.missing.map((p) => p.name).join(' · ')
    return {
      ok: false,
      phaseGate: true,
      missing: result.missing.map((p) => p.id),
      error: `Aún NO cierres: faltan fases del arco de cierre. Pendiente: ${missingNames}. No marques el objetivo todavía; sigue conversando y cúmplelas DE VERDAD (con contexto real, no palabras vacías) antes de avanzar.`
    }
  } catch (error) {
    logger.warn(`[Fases de cierre] El validador falló (${error?.message || error}); se continúa sin bloquear (fail-open).`)
    return null
  }
}
