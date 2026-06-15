import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { logger } from '../utils/logger.js'
import { getAIAgentConfig, getOpenAIApiKey } from '../services/aiAgentService.js'

const DEFAULT_MODEL = 'gpt-5.5'

// Prompt interno que clasifica la respuesta acumulada del contacto.
const CLASSIFICATION_INSTRUCTIONS = `Eres un clasificador especializado en analizar respuestas a mensajes de confirmación de cita.

CONTEXTO:
Hace unos minutos se envió un mensaje al contacto para confirmar su asistencia a la cita programada.

TAREA:
Analiza los mensajes del contacto que se proporcionan y determina si la persona:
1. Confirma su asistencia → "confirmed"
2. Quiere reprogramar → "reschedule"
3. Cancela la cita → "cancel"
4. Responde de forma ambigua o no afirmativa → "ambiguous"
5. Requiere intervención humana → "human_needed"

REGLAS IMPORTANTES:
- Considera TODOS los mensajes acumulados como una sola respuesta completa.
- La persona puede haber enviado varios mensajes separados que juntos forman un pensamiento.
- Presta atención tanto a señales explícitas como implícitas.

Señales que indican CONFIRMACIÓN (result: "confirmed"):
- "sí", "sip", "simon", "yes", "ok", "okay", "okey", "oki", "vale", "sale", "dale", "claro"
- "confirmo", "confirmado", "confirmada", "confirmar", "perfecto", "listo", "de acuerdo"
- "correcto", "por supuesto", "ahí voy", "ahí estaré", "asistiré", "cuenta conmigo"
- Emojis 👍 ✅ 👌 🙌
- Mencionar la fecha u hora de la cita de forma afirmativa (ej: "ok mañana a las 10", "sí el viernes")
- Preguntas logísticas que implican asistencia: "¿dónde es?", "¿me recuerdas la dirección?", "¿se puede facturar?", "¿hay estacionamiento?"

Señales de REAGENDAMIENTO (result: "reschedule"):
- Quiere ir pero no puede ese día/hora: "quiero reagendar", "¿puede ser otro día?", "¿tiene espacio más tarde?", "¿puede cambiarse?"
- "No voy a poder... pero quiero otro horario/día"

Señales de CANCELACIÓN (result: "cancel"):
- "cancelo", "no voy a ir", "ya no puedo asistir", "no podré asistir"
- Claramente no quiere la cita en ningún horario

Señales AMBIGUAS (result: "ambiguous"):
- "mejor luego le aviso", "déjeme revisar", "creo que no podré", "puede ser"
- Respuestas que no confirman ni cancelan con claridad

INTERVENCIÓN HUMANA (result: "human_needed"):
- Dudas importantes sobre el servicio, preguntas sobre precio, quejas
- Cualquier situación que claramente requiera atención personalizada

IMPORTANTE: Si alguien dice "No voy a poder ir… pero quiero reagendar para otro día" → es "reschedule", no "cancel".

Responde ÚNICAMENTE con JSON sin markdown, exactamente así:
{"result":"confirmed","confidence":"high","reason":"texto breve en español"}`

/**
 * Clasifica la respuesta acumulada del contacto usando OpenAI Agents SDK.
 * @param {string[]} accumulatedMessages - Lista de textos de mensajes recibidos
 * @returns {{ result: string, confidence: string, reason: string } | null}
 */
export async function classifyConfirmationResponse({ accumulatedMessages = [] } = {}) {
  if (!accumulatedMessages.length) return null

  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    logger.warn('[Confirmación IA] Sin API Key de OpenAI; no se puede clasificar la respuesta')
    return null
  }

  const aiConfig = await getAIAgentConfig({}).catch(() => ({}))
  const model = String(aiConfig?.model || DEFAULT_MODEL)

  const messagesText = accumulatedMessages
    .map((text, i) => `Mensaje ${i + 1}: "${String(text || '').trim()}"`)
    .join('\n')

  const userPrompt = `Los mensajes del contacto son:\n${messagesText}\n\nClasifica la respuesta según las instrucciones.`

  const agent = new Agent({
    name: 'Clasificador de confirmación de cita',
    model,
    instructions: CLASSIFICATION_INSTRUCTIONS
  })

  try {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ apiKey }),
      tracingDisabled: true
    })

    const result = await runner.run(
      agent,
      [{ role: 'user', content: userPrompt }],
      { maxTurns: 3, context: { category: 'confirmacion_cita' } }
    )

    const output = String(result.finalOutput || '').trim()
    const jsonMatch = output.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) {
      logger.warn(`[Confirmación IA] Respuesta no es JSON válido: ${output.slice(0, 200)}`)
      return null
    }

    const parsed = JSON.parse(jsonMatch[0])
    const VALID_RESULTS = new Set(['confirmed', 'reschedule', 'cancel', 'ambiguous', 'human_needed'])
    if (!VALID_RESULTS.has(parsed.result)) {
      logger.warn(`[Confirmación IA] Resultado inválido: ${parsed.result}`)
      return null
    }

    return {
      result: parsed.result,
      confidence: String(parsed.confidence || 'medium'),
      reason: String(parsed.reason || '')
    }
  } catch (error) {
    logger.error(`[Confirmación IA] Error clasificando respuesta: ${error.message}`)
    return null
  }
}
