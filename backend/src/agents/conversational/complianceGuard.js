import { Agent, Runner } from '@openai/agents'
import { DEFAULT_OPENAI_MODEL } from '../../config/openAIModels.js'
import { logger } from '../../utils/logger.js'
import { hasConfiguredPriceDisclosureGate, PRICE_INSISTENCE_HARD_THRESHOLD } from './prompt.js'

/**
 * Guardián de una regla EXPLÍCITA del negocio.
 *
 * Ya no impone por defecto que la IA esconda información, haga pitch inverso o
 * convierta una duda en interrogatorio. Sólo interviene cuando el negocio escribió
 * una condición concreta para revelar importes, y valida exactamente esa condición.
 */

const MONEY_RE = /(?:[$€£]\s*\d|\b\d[\d.,]*\s*(?:mxn|usd|cop|ars|clp|pen|eur|pesos?|d[oó]lares?|euros?)\b|\b(?:cuesta|vale|precio|costo|tarifa|inversi[oó]n)\s+(?:es\s+|de\s+)?[$€£]?\s*\d)/i
const SAFE_FALLBACK = 'para darte el dato que sí aplica, qué opción estás considerando?'

function configuredDisclosureRules(config = {}) {
  const businessRules = String(config?.extraInstructions || '').trim()
  const customStrategy = String(config?.closingStrategyMode || '') === 'custom'
    ? String(config?.closingStrategyCustom || '').trim()
    : ''
  return [businessRules, customStrategy].filter(Boolean).join('\n').slice(0, 5000)
}

export function complianceGuardApplies(config = {}) {
  const rules = configuredDisclosureRules(config)
  return hasConfiguredPriceDisclosureGate(rules)
}

export function replyMightViolate(reply = '') {
  return MONEY_RE.test(String(reply || ''))
}

export function ensureCorrectedGuardReply(reply = '') {
  const text = String(reply || '').trim()
  if (!text || MONEY_RE.test(text)) return SAFE_FALLBACK
  return text
}

// Alias temporal para consumidores anteriores; ya no obliga a convertir toda
// corrección en una pregunta prefabricada.
export const ensureCorrectedGuardQuestion = ensureCorrectedGuardReply

function conversationToText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim())
    .map((message) => `${message.role === 'user' ? 'CLIENTE' : 'AGENTE'}: ${message.content.trim()}`)
    .join('\n')
    .slice(-7000)
}

async function runGuardModel({ conversation, reply, rules, runtime, model }) {
  const instructions = `Eres supervisor de una condición explícita del negocio para revelar precios o importes. No aplicas una técnica de ventas general: revisas ÚNICAMENTE la regla escrita que recibes.

Marca violación sólo si se cumplen ambas cosas:
1. El borrador revela un importe real.
2. La condición literal del negocio todavía no se demuestra en la conversación.

Reglas de juicio:
- Si la condición ya se cumplió, el dato debe pasar aunque la conversación sea corta.
- No inventes requisitos adicionales, preguntas de diagnóstico, historias profundas ni una secuencia de venta.
- Una pregunta directa se responde primero salvo la condición explícita que estás validando.
- Si hay violación, reescribe breve: conserva cualquier respuesta útil que sí pueda darse, omite sólo el importe bloqueado y haz como máximo una pregunta principal ligada a la condición exacta.
- No cambies tono o idioma y no presiones.

Responde sólo JSON válido:
{"violates":true|false,"reason":"breve","corrected":"mensaje corregido o vacío si no viola"}`

  const guardModel = runtime?.providerId === 'openai' ? DEFAULT_OPENAI_MODEL : (model || DEFAULT_OPENAI_MODEL)
  const agent = new Agent({ name: 'Supervisor de condición de precio', model: guardModel, instructions })
  const runner = new Runner({ modelProvider: runtime.modelProvider, tracingDisabled: true })
  const userPrompt = `Condición explícita del negocio:\n${rules}\n\nConversación:\n${conversation || '(sin historial visible)'}\n\nBorrador de respuesta:\n"${reply}"\n\nEvalúa sólo la condición escrita.`
  const result = await runner.run(agent, [{ role: 'user', content: userPrompt }], {
    maxTurns: 2,
    context: { category: 'configured_disclosure_guard' }
  })
  const output = String(result.finalOutput || '').trim()
  const jsonMatch = output.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`respuesta no-JSON del guardián: ${output.slice(0, 160)}`)
  const parsed = JSON.parse(jsonMatch[0])
  return {
    violates: parsed.violates === true,
    reason: String(parsed.reason || ''),
    corrected: String(parsed.corrected || '').trim()
  }
}

/**
 * Devuelve la respuesta original o una corrección limitada a la condición configurada.
 * Fail-open: una caída del supervisor nunca bloquea la conversación.
 */
export async function enforceComplianceGuard({ reply = '', messages = [], config = {}, runtime = null, model = null, priceInsistenceCount = 0 } = {}) {
  const original = String(reply || '')
  if (!original.trim()) return { reply: original, changed: false }
  if (!complianceGuardApplies(config)) return { reply: original, changed: false }
  // Regla de la casa: a la tercera petición de precio la insistencia del contacto
  // cumple la condición y el dato real debe pasar; retenerlo mata la conversación.
  if (Number(priceInsistenceCount) >= PRICE_INSISTENCE_HARD_THRESHOLD) return { reply: original, changed: false }
  if (!replyMightViolate(original)) return { reply: original, changed: false }
  if (!runtime?.modelProvider) return { reply: original, changed: false }

  try {
    const verdict = await runGuardModel({
      conversation: conversationToText(messages),
      reply: original,
      rules: configuredDisclosureRules(config),
      runtime,
      model
    })
    if (!verdict.violates || !verdict.corrected) return { reply: original, changed: false }
    return {
      reply: ensureCorrectedGuardReply(verdict.corrected),
      changed: true,
      violation: { rules: ['configured_price_disclosure'], reason: verdict.reason }
    }
  } catch (error) {
    logger.warn(`[Guardián de condición de precio] Falló (${error?.message || error}); se envía la respuesta original (fail-open).`)
    return { reply: original, changed: false }
  }
}
