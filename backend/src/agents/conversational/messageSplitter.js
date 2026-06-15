import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { logger } from '../../utils/logger.js'
import { normalizeAgentReplyDelivery } from '../../services/conversationalAgentService.js'

const DEFAULT_SPLITTER_MODEL = process.env.OPENAI_CONVERSATIONAL_SPLITTER_MODEL ||
  process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL ||
  'gpt-5.4-nano'

const NATURAL_SHORT_MESSAGE_PATTERN = /^(va|ok|okay|listo|perfecto|sale|claro|sí|si|no|hecho|de una)[.!?¡¿]*$/i
const VISIBLE_LABEL_PATTERN = /^(?:globo|mensaje|parte)\s*#?\s*\d+\s*[:.)-]\s*/i
const MAX_AI_INPUT_CHARS = 4000
const SIGNIFICANT_TOKEN_MIN_LENGTH = 4

const PROTECTED_TOKEN_PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{6,}\d|\$\s?\d[\d,.]*(?:\s?(?:mxn|usd|pesos|dólares|dolares))?|\b\d{1,2}:\d{2}\s?(?:am|pm)?\b|\b[A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+\b/gi

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function stripVisibleLabel(value) {
  return cleanText(value).replace(VISIBLE_LABEL_PATTERN, '').trim()
}

function getProtectedTokens(text) {
  return [...String(text || '').matchAll(PROTECTED_TOKEN_PATTERN)]
    .map((match) => match[0].replace(/[),.;:!?]+$/g, ''))
    .filter(Boolean)
}

function maskProtectedTokens(text) {
  const tokens = getProtectedTokens(text)
  let masked = String(text || '')
  tokens.forEach((token, index) => {
    masked = masked.split(token).join(`@@RISTAK_PROTECTED_${index}@@`)
  })
  return {
    masked,
    restore(value) {
      let restored = String(value || '')
      tokens.forEach((token, index) => {
        restored = restored.split(`@@RISTAK_PROTECTED_${index}@@`).join(token)
      })
      return restored
    }
  }
}

function splitNaturalSegments(text) {
  const { masked, restore } = maskProtectedTokens(text)
  return masked
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split(/(?=\n\s*(?:[-*]|\d+[.)])\s+)/g))
    .flatMap((paragraph) => paragraph.match(/[^.!?;]+[.!?;]+(?:\s+|$)|[^.!?;]+$/g) || [paragraph])
    .map((segment) => cleanText(restore(segment)))
    .filter(Boolean)
}

function splitLongSegmentByWords(segment, maxLength) {
  const words = cleanText(segment).split(/\s+/).filter(Boolean)
  const parts = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxLength && current) {
      parts.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) parts.push(current)
  return parts
}

function splitTextConservatively(text, maxLength) {
  const clean = cleanText(text)
  if (!clean || clean.length <= maxLength) return clean ? [clean] : []

  const parts = []
  let current = ''

  for (const segment of splitNaturalSegments(clean)) {
    const subSegments = segment.length > maxLength
      ? splitLongSegmentByWords(segment, maxLength)
      : [segment]

    for (const subSegment of subSegments) {
      const next = current ? `${current} ${subSegment}` : subSegment
      if (next.length > maxLength && current) {
        parts.push(current)
        current = subSegment
      } else {
        current = next
      }
    }
  }

  if (current) parts.push(current)
  return parts.filter(Boolean)
}

function isMeaningfulShortMessage(message) {
  const clean = cleanText(message)
  return clean.length > 0 && clean.length <= 16 && NATURAL_SHORT_MESSAGE_PATTERN.test(clean)
}

function mergeShortMessages(messages, settings) {
  const minLength = settings.minBubbleLength
  const maxLength = settings.maxBubbleLength
  const result = []

  for (const message of messages) {
    const clean = cleanText(message)
    if (!clean) continue

    if (clean.length < minLength && !isMeaningfulShortMessage(clean)) {
      const previous = result[result.length - 1]
      if (previous && `${previous} ${clean}`.length <= maxLength) {
        result[result.length - 1] = `${previous} ${clean}`
        continue
      }
    }

    result.push(clean)
  }

  for (let index = 0; index < result.length - 1; index += 1) {
    if (result[index].length >= minLength || isMeaningfulShortMessage(result[index])) continue
    const next = `${result[index]} ${result[index + 1]}`
    if (next.length <= maxLength) {
      result.splice(index, 2, next)
      index -= 1
    }
  }

  return result
}

function limitBubbleCount(messages, maxBubbles) {
  const parts = [...messages]
  while (parts.length > maxBubbles) {
    const last = parts.pop()
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${last}`.trim()
  }
  return parts
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9áéíóúñü@._+-]+/gi, ' ')
    .trim()
}

function significantTokens(text) {
  return normalizeToken(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= SIGNIFICANT_TOKEN_MIN_LENGTH)
}

function contentLooksPreserved(original, messages) {
  const output = messages.join(' ')
  const originalTokens = significantTokens(original)
  if (originalTokens.length < 8) return cleanText(output).length > 0

  const outputTokens = new Set(significantTokens(output))
  const covered = originalTokens.filter((token) => outputTokens.has(token)).length
  return covered / originalTokens.length >= 0.7
}

function protectedTokensAreIntact(original, messages) {
  const joined = messages.join(' ')
  for (const token of getProtectedTokens(original)) {
    if (!joined.includes(token)) return false
    if (!messages.some((message) => message.includes(token))) return false
  }
  return true
}

function repairMessages(rawMessages, originalText, settings) {
  const sourceMessages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((message) => stripVisibleLabel(message))
    .filter(Boolean)

  if (!sourceMessages.length) {
    return { ok: false, reason: 'empty_messages', messages: [] }
  }

  if (!contentLooksPreserved(originalText, sourceMessages)) {
    return { ok: false, reason: 'content_changed', messages: [] }
  }

  if (!protectedTokensAreIntact(originalText, sourceMessages)) {
    return { ok: false, reason: 'protected_token_changed', messages: [] }
  }

  let repaired = sourceMessages.flatMap((message) => splitTextConservatively(message, settings.maxBubbleLength))
  repaired = mergeShortMessages(repaired, settings)
  repaired = limitBubbleCount(repaired, settings.maxBubbles)
  repaired = repaired.map(cleanText).filter(Boolean)

  if (!repaired.length) {
    return { ok: false, reason: 'empty_after_repair', messages: [] }
  }

  if (!protectedTokensAreIntact(originalText, repaired)) {
    return { ok: false, reason: 'protected_token_changed_after_repair', messages: [] }
  }

  return { ok: true, reason: 'ok', messages: repaired }
}

function parseSplitterJson(rawOutput) {
  if (Array.isArray(rawOutput)) return { messages: rawOutput }
  if (rawOutput && typeof rawOutput === 'object') return rawOutput

  const text = String(rawOutput || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  if (!text) throw new Error('empty_splitter_output')

  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
    throw new Error('invalid_splitter_json')
  }
}

function fallbackResult(text, reason) {
  const clean = cleanText(text)
  return {
    messages: clean ? [clean] : [],
    source: 'fallback',
    reason
  }
}

function shouldUseAiForText(text, settings, random) {
  if (text.length >= settings.minMessageLengthToSplit) return true
  if (!settings.randomizeSplitting) return false
  if (text.length < Math.max(settings.minBubbleLength * 2, 70)) return false
  return random() < 0.25
}

function buildSplitterInstructions(settings) {
  return [
    'Eres un procesador de mensajes para WhatsApp. Tu única tarea es dividir una respuesta ya generada por otro agente en varios mensajes naturales.',
    '',
    'Reglas no negociables:',
    '- No cambies el significado del texto original.',
    '- No inventes información.',
    '- No elimines instrucciones, datos, precios, horarios, fechas, URLs, teléfonos, correos, códigos ni nombres propios.',
    '- No agregues saludos ni despedidas si no venían en el texto original.',
    '- No uses etiquetas visibles como "globo 1", "mensaje 2" o "parte 3".',
    '- Cada mensaje debe sonar natural por si solo, sin cortar frases de forma rara.',
    '- Si hay una pregunta importante al final, déjala preferentemente como último mensaje.',
    '- Si el texto es técnico o formal, conserva ese tono. Si es casual, conserva el tono casual.',
    '- Si hay bullets, pasos o instrucciones, conserva el orden lógico.',
    '- No devuelvas markdown, explicaciones ni texto fuera del JSON.',
    '',
    `Parámetros: mínimo para dividir ${settings.minMessageLengthToSplit} caracteres; máximo ${settings.maxBubbles} mensajes; longitud sugerida por mensaje ${settings.minBubbleLength}-${settings.maxBubbleLength} caracteres.`,
    settings.randomizeSplitting
      ? 'Puedes variar naturalmente si conviene devolver 1, 2, 3, 4 o más mensajes, siempre dentro del máximo.'
      : 'Usa una división conservadora y consistente.',
    '',
    'Devuelve únicamente JSON válido con esta estructura:',
    '{"messages":["primer mensaje","segundo mensaje"]}'
  ].join('\n')
}

function buildSplitterUserPrompt(text, settings) {
  const variationSeed = settings.randomizeSplitting ? Math.floor(Math.random() * 1000000) : 0
  return [
    `Semilla interna de variacion: ${variationSeed}`,
    'Texto original:',
    cleanText(text).slice(0, MAX_AI_INPUT_CHARS)
  ].join('\n\n')
}

async function runAiSplitter({ text, settings, apiKey, model }) {
  const agent = new Agent({
    name: 'Ristak · Divisor de mensajes WhatsApp',
    model: model || DEFAULT_SPLITTER_MODEL,
    instructions: buildSplitterInstructions(settings),
    tools: []
  })

  const runner = new Runner({
    modelProvider: new OpenAIProvider({ apiKey }),
    tracingDisabled: true
  })

  const result = await runner.run(agent, [{
    role: 'user',
    content: [{ type: 'input_text', text: buildSplitterUserPrompt(text, settings) }]
  }], {
    maxTurns: 1,
    context: { category: 'conversational_message_splitter' }
  })

  return result.finalOutput
}

export function splitMessageIntoBubblesFallback({ text, settings = {} } = {}) {
  const clean = cleanText(text)
  if (!clean) return { messages: [], source: 'empty', reason: 'empty_text' }

  const delivery = normalizeAgentReplyDelivery(settings?.replyDelivery || settings)
  if (!delivery.splitMessagesEnabled) {
    return { messages: [clean], source: 'disabled', reason: 'split_disabled' }
  }

  if (clean.length < delivery.minMessageLengthToSplit) {
    return { messages: [clean], source: 'threshold', reason: 'below_min_length' }
  }

  const repaired = repairMessages(splitTextConservatively(clean, delivery.maxBubbleLength), clean, delivery)
  if (!repaired.ok) return fallbackResult(clean, repaired.reason)
  return { messages: repaired.messages, source: 'fallback', reason: 'safe_split' }
}

export async function splitMessageIntoBubbles({
  text,
  settings = {},
  apiKey = null,
  model = null,
  aiSplitter = null,
  random = Math.random,
  log = logger
} = {}) {
  const clean = cleanText(text)
  if (!clean) return { messages: [], source: 'empty', reason: 'empty_text' }

  const delivery = normalizeAgentReplyDelivery(settings?.replyDelivery || settings)
  if (!delivery.splitMessagesEnabled) {
    return { messages: [clean], source: 'disabled', reason: 'split_disabled' }
  }

  if (!shouldUseAiForText(clean, delivery, random)) {
    return { messages: [clean], source: 'threshold', reason: 'below_min_length' }
  }

  try {
    const raw = typeof aiSplitter === 'function'
      ? await aiSplitter({ text: clean, settings: delivery })
      : apiKey
        ? await runAiSplitter({ text: clean, settings: delivery, apiKey, model })
        : null

    if (!raw) return fallbackResult(clean, 'splitter_unavailable')

    const parsed = parseSplitterJson(raw)
    const repaired = repairMessages(parsed?.messages, clean, delivery)
    if (!repaired.ok) return fallbackResult(clean, repaired.reason)

    return {
      messages: repaired.messages,
      source: 'ai',
      reason: repaired.reason
    }
  } catch (error) {
    log.warn(`[Agente conversacional] Divisor de mensajes falló; se enviará respuesta original: ${error.message}`)
    return fallbackResult(clean, error.message || 'splitter_error')
  }
}
