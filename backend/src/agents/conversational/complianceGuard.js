import { Agent, Runner } from '@openai/agents'
import { DEFAULT_OPENAI_MODEL } from '../../config/openAIModels.js'
import { logger } from '../../utils/logger.js'
import { usesLightDirectClosingBase } from './prompt.js'

/**
 * GUARDIÁN DE CUMPLIMIENTO (output guardrail).
 *
 * Convierte reglas duras del guion de fábrica en verificación real sobre CADA respuesta
 * visible, en vez de confiar en que el modelo las obedezca. Antes de enviar el mensaje,
 * revisa que no rompa las reglas de apertura de la biblia; si las rompe, lo REESCRIBE.
 *
 * v1 — dos reglas de disciplina de apertura (las que "más se caen"):
 *   R1 (precio): ante "costos/precio", NO se suelta número ni menú ANTES de calificar el
 *       problema; primero se regresa la pregunta. El número llega DESPUÉS, uno solo.
 *   R2 (no-pitch): ante un mensaje vago de apertura (info/qué ofrecen), NO se explica el
 *       producto ni se hace pitch; se regresa la pregunta.
 *
 * Sólo aplica cuando el agente usa la biblia pesada (persuasión media/alta + lenguaje
 * Cómplice/Callejero). En Anfitrión/Ejecutivo (guion ligero) dar precios es POR DISEÑO,
 * así que el guardián NO se mete.
 *
 * Eficiencia: un pre-filtro determinista evita la llamada IA en el caso común (una
 * pregunta corta sin precio ni explicación no puede violar nada). Cuando sí hay riesgo,
 * una sola llamada IA barata evalúa Y devuelve la versión corregida.
 */

/** ¿Este agente debe cumplir las reglas de la biblia (guion pesado)? */
export function complianceGuardApplies(config = {}) {
  if (String(config?.closingStrategyMode || '') === 'custom') return false
  return !usesLightDirectClosingBase(config)
}

// Pre-filtro determinista: ¿la respuesta siquiera PODRÍA violar R1/R2?
// Si es una pregunta corta sin dinero ni explicación larga, es imposible que rompa las
// reglas de apertura → nos ahorramos la llamada IA.
const MONEY_RE = /(\$\s?\d|\bmxn\b|\busd\b|\d+\s?(pesos|d[oó]lares|euros)|cuesta|precio|costo|tarifa|inversi[oó]n de \$?\d)/i
// Señales de pitch/explicación de producto (para cazar el "ofrecemos X, Y y Z").
const PITCH_RE = /\bofrec|\btenemos\b|\bcontamos con\b|\bmanejamos\b|\brealizamos\b|nuestros?\s+(servicios|tratamientos|programas|paquetes)|\bconsiste en\b|\bincluye\b/i

export function replyMightViolate(reply = '') {
  const text = String(reply || '')
  if (!text.trim()) return false
  const hasMoney = MONEY_RE.test(text)
  const hasPitch = PITCH_RE.test(text)
  const isLongish = text.length > 130 // posible explicación/pitch
  return hasMoney || hasPitch || isLongish
}

function conversationToText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'CLIENTE' : 'AGENTE'}: ${m.content.trim()}`)
    .join('\n')
    .slice(-7000)
}

const GUARD_INSTRUCTIONS = `Eres un SUPERVISOR de cumplimiento de un guion de ventas por chat. Recibes la conversación y un BORRADOR de la próxima respuesta del AGENTE. Revisas SÓLO estas dos reglas de APERTURA (no juzgues estilo, tono ni nada más). Sé CONSERVADOR: sólo marca violación si es CLARA; ante la duda, NO viola.

R1 — PRECIO EN FRÍO: viola si el borrador incluye un precio/número/menú de precios cuando, en TODA la conversación, la persona NO ha dado NADA de contexto de qué necesita ni qué le pasa (sólo preguntó el precio "en frío"). OJO CLAVE: viola AUNQUE el borrador también haga una pregunta al final — soltar el precio en la apertura fría YA es la falla, la pregunta no lo salva.
  EJEMPLO QUE SÍ VIOLA R1: cliente dice "costos"; el borrador responde "depende.. la consulta son $1,200 y el seguimiento $800.. qué te está pasando?" — soltó los precios sin que la persona diera contexto; debió preguntar primero, SIN número.
  NO viola si: la persona YA contó su problema/necesidad o su caso (aunque sea poco), o pidió el precio de algo específico tras dar contexto. Ahí dar UN precio corto es lo CORRECTO; no hay que rebotar la pregunta de precio más de una vez.

R2 — PITCH EN FRÍO: viola SÓLO si, ante un mensaje vago de apertura (info, qué ofrecen, cuéntame, hola) SIN contexto aún, el borrador explica/describe el producto o LISTA servicios/tratamientos/programas en vez de regresar una pregunta.
  EJEMPLO QUE SÍ VIOLA R2: ante "info", responder "ofrecemos consultas, tratamientos personalizados, terapia y programas de 8 y 12 semanas..." — eso es soltar el catálogo de golpe; debió preguntar algo como "¿qué andas buscando?" o "¿qué te está pasando?".
  NO viola si: el borrador ya regresa una pregunta, o si la persona ya dio contexto de lo que busca.

Si el borrador ya es una pregunta que regresa el balón, casi nunca hay violación.

Si (y sólo si) hay violación CLARA, REESCRIBE la respuesta cumpliendo la biblia: regresa la pregunta primero, corta y natural, con el MISMO tono/estilo/idioma del borrador (no lo vuelvas formal), SIN número/menú ni explicación del producto.

Responde ÚNICAMENTE JSON válido, sin markdown:
{"violates": true|false, "rules": ["R1"|"R2"], "reason": "breve", "corrected": "sólo el mensaje corregido, o cadena vacía si no viola"}`

async function runGuardModel({ conversation, reply, runtime, model }) {
  // Modelo mid-tier para el guardián: gpt-5.4-nano es demasiado chico e inconsistente
  // para este juicio matizado (apertura vs. calificado). Usamos el mid del proveedor.
  const guardModel = runtime?.providerId === 'openai' ? DEFAULT_OPENAI_MODEL : (model || DEFAULT_OPENAI_MODEL)
  const agent = new Agent({ name: 'Supervisor de cumplimiento', model: guardModel, instructions: GUARD_INSTRUCTIONS })
  const runner = new Runner({ modelProvider: runtime.modelProvider, tracingDisabled: true })
  const userPrompt = `Conversación:\n${conversation || '(apertura, sin historial)'}\n\nBORRADOR de respuesta del AGENTE:\n"${reply}"\n\nEvalúa R1 y R2.`
  const result = await runner.run(agent, [{ role: 'user', content: userPrompt }], { maxTurns: 2, context: { category: 'compliance_guard' } })
  const output = String(result.finalOutput || '').trim()
  const jsonMatch = output.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`respuesta no-JSON del guardián: ${output.slice(0, 160)}`)
  const parsed = JSON.parse(jsonMatch[0])
  return {
    violates: parsed.violates === true,
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    reason: String(parsed.reason || ''),
    corrected: String(parsed.corrected || '').trim()
  }
}

/**
 * Aplica el guardián sobre la respuesta visible. Devuelve la respuesta (posiblemente
 * reescrita) y metadatos. Fail-open: ante cualquier error, deja pasar la respuesta original.
 * @returns {{ reply: string, changed: boolean, violation?: {rules,reason} }}
 */
export async function enforceComplianceGuard({ reply = '', messages = [], config = {}, runtime = null, model = null } = {}) {
  const original = String(reply || '')
  if (!original.trim()) return { reply: original, changed: false }
  if (!complianceGuardApplies(config)) return { reply: original, changed: false }
  if (!replyMightViolate(original)) return { reply: original, changed: false }
  if (!runtime?.modelProvider) return { reply: original, changed: false } // sin runtime, fail-open

  try {
    const verdict = await runGuardModel({ conversation: conversationToText(messages), reply: original, runtime, model })
    if (!verdict.violates || !verdict.corrected) return { reply: original, changed: false }
    return { reply: verdict.corrected, changed: true, violation: { rules: verdict.rules, reason: verdict.reason } }
  } catch (error) {
    logger.warn(`[Guardián de cumplimiento] Falló (${error?.message || error}); se envía la respuesta original (fail-open).`)
    return { reply: original, changed: false }
  }
}
