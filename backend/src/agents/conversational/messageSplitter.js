import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { logger } from '../../utils/logger.js'
import { normalizeAgentReplyDelivery } from '../../services/conversationalAgentService.js'

const DEFAULT_SPLITTER_MODEL = process.env.OPENAI_CONVERSATIONAL_SPLITTER_MODEL ||
  process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL ||
  'gpt-5.4-nano'

const NATURAL_SHORT_MESSAGE_PATTERN = /^(va|ok|okay|listo|perfecto|sale|claro|sí|si|no|ya|hecho|de una)[.!?¡¿]*$/i
const NATURAL_STANDALONE_REACTION_PATTERN = /^(?:ah+h?|ah+ ya|ah+ okaa?y|ok+a+y?|va|sale|perfecto|listo|claro|órale|orale|uff|mmm(?: a ver)?|no+ manches|buen[ií]simo|déjame ver|dejame ver|ya te entend[ií]|ah ya te entend[ií])(?:[.!?…]+)?$/i
const LEADING_REACTION_SPLIT_PATTERN = /^((?:ah+\s+ok+a?y?|mmm)(?:[.!?…]+|\.{2,}|…+)?|(?:ah+\s+ya|ah+h?|ok+a+y?|va|sale|perfecto|listo|claro|órale|orale|uff|h[ií]jole|tsss|uy|ya)(?:[.!?…]+|\.{2,}|…+))\s+(.+)$/i
const VISIBLE_LABEL_PATTERN = /^(?:globo|mensaje|parte)\s*#?\s*\d+\s*[:.)-]\s*/i
const BREAK_TOKEN_PATTERN = /\s*\[BREAK\]\s*/gi
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
    .flatMap((paragraph) => paragraph.match(/[^.!?;…]+[.!?;…]+(?:\s+|$)|[^.!?;…]+$/g) || [paragraph])
    .map((segment) => cleanText(restore(segment)))
    .filter(Boolean)
}

function splitExplicitBreaks(text) {
  return String(text || '')
    .split(BREAK_TOKEN_PATTERN)
    .map((part) => cleanText(part))
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

function splitLeadingReaction(segment) {
  const clean = cleanText(segment)
  const match = clean.match(LEADING_REACTION_SPLIT_PATTERN)
  if (!match) return [clean].filter(Boolean)

  const reaction = cleanText(match[1])
  const rest = cleanText(match[2])
  if (!reaction || !rest) return [clean].filter(Boolean)
  return [reaction, rest]
}

function splitHumanBubbleFragments(message) {
  return splitExplicitBreaks(message)
    .flatMap((part) => String(part || '').split(/\n{2,}/))
    .flatMap((part) => splitLeadingReaction(part))
    .map(cleanText)
    .filter(Boolean)
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
  return clean.length > 0 && clean.length <= 28 && (
    NATURAL_SHORT_MESSAGE_PATTERN.test(clean) ||
    NATURAL_STANDALONE_REACTION_PATTERN.test(clean)
  )
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

function mergeAtIndex(messages, index) {
  if (index < 0 || index >= messages.length - 1) return messages
  const next = [...messages]
  next.splice(index, 2, `${next[index]} ${next[index + 1]}`.trim())
  return next
}

function findMergeablePair(messages, settings, random = Math.random) {
  const candidates = []
  for (let index = 0; index < messages.length - 1; index += 1) {
    const merged = `${messages[index]} ${messages[index + 1]}`.trim()
    if (merged.length <= settings.maxBubbleLength || messages.length > settings.maxBubbles) {
      candidates.push(index)
    }
  }
  if (!candidates.length) return messages.length > 1 ? messages.length - 2 : -1
  return candidates[Math.floor(random() * candidates.length)]
}

function naturalBubbleCap(text, settings) {
  const max = Math.max(1, settings.maxBubbles)
  const length = cleanText(text).length
  if (length >= 900) return Math.min(max, 6)
  if (length >= 620) return Math.min(max, 5)
  if (length >= 280) return Math.min(max, 4)
  if (length >= 130) return Math.min(max, 3)
  return Math.min(max, 2)
}

function hasNaturalSplitSignal(text, segments = []) {
  const clean = cleanText(text)
  if (splitExplicitBreaks(clean).length > 1) return true
  if (segments.length > 1) return true
  if (/[.!…]\s*¿?[\wáéíóúñ]/i.test(clean)) return true
  if (/[^\n?]{12,}\?\s+[^\n]{8,}/.test(clean)) return true
  if (/\b(?:primero|luego|después|despues|ahora|entonces)\b/i.test(clean) && clean.length >= 110) return true
  return false
}

function splitTextByHumanIntent(text, settings, random = Math.random) {
  const clean = cleanText(text)
  if (!clean) return []

  const explicit = splitExplicitBreaks(clean)
  let parts = explicit.length > 1
    ? explicit
    : splitNaturalSegments(clean)

  parts = parts
    .flatMap((part) => part.length > settings.maxBubbleLength ? splitLongSegmentByWords(part, settings.maxBubbleLength) : [part])
    .map(cleanText)
    .filter(Boolean)

  if (!parts.length) return []

  const mustSplitByLength = clean.length > settings.maxBubbleLength
  const hasSplitSignal = hasNaturalSplitSignal(clean, parts)
  if (!mustSplitByLength && !hasSplitSignal) {
    return [clean]
  }

  const maxNaturalBubbles = naturalBubbleCap(clean, settings)
  let minTarget = mustSplitByLength
    ? Math.min(maxNaturalBubbles, Math.max(2, Math.ceil(clean.length / settings.maxBubbleLength)))
    : (hasSplitSignal ? Math.min(2, maxNaturalBubbles) : 1)
  minTarget = Math.max(1, Math.min(minTarget, maxNaturalBubbles))

  let maxTarget = Math.min(parts.length, maxNaturalBubbles)
  if (!mustSplitByLength && clean.length < settings.minMessageLengthToSplit && maxTarget > 1) {
    maxTarget = Math.max(1, Math.min(maxTarget, 2))
  }

  const targetCount = settings.randomizeSplitting && maxTarget > minTarget
    ? minTarget + Math.floor(random() * (maxTarget - minTarget + 1))
    : maxTarget

  while (parts.length > targetCount) {
    const index = settings.randomizeSplitting
      ? findMergeablePair(parts, settings, random)
      : parts.length - 2
    if (index < 0) break
    parts = mergeAtIndex(parts, index)
  }

  parts = mergeShortMessages(parts, settings)
  parts = limitBubbleCount(parts, Math.min(settings.maxBubbles, 6))
  return parts.map(cleanText).filter(Boolean)
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
    .flatMap((message) => splitHumanBubbleFragments(message))
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
    if (BREAK_TOKEN_PATTERN.test(text)) {
      BREAK_TOKEN_PATTERN.lastIndex = 0
      return { messages: splitExplicitBreaks(text) }
    }
    BREAK_TOKEN_PATTERN.lastIndex = 0
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
    'Piensa en [BREAK] como el punto donde termina un globo y empieza otro, pero tu salida final debe ser un arreglo JSON de mensajes, no texto con [BREAK].',
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
    '- Una idea o intención = un mensaje. Separa reacción, confirmación, dato, pregunta, empatía, acción y pasos cuando naturalmente sean intenciones distintas.',
    '- Si una reacción corta tipo "ya..", "ahh ok", "mmm" o "uff" viene antes de una lectura, dato o pregunta, déjala como mensaje separado cuando suene natural.',
    '- Si el texto trae salto de párrafo dentro de una misma respuesta, normalmente eso indica otro globo: no metas dos líneas con intenciones distintas en el mismo mensaje.',
    '- No dividas por dividir. Si el texto es una sola idea corta y limpia, devuelve un solo mensaje.',
    '- No fuerces 2-4 mensajes siempre. Lo normal suele ser 1-4 según el texto; usa 5 o 6 sólo si el texto está largo y realmente lo amerita.',
    '- No hagas spam de mensajes mínimos. Cada mensaje debe entenderse por sí solo.',
    '- Varía el patrón: no cortes siempre en la misma cantidad ni después de la misma muletilla.',
    '- No devuelvas markdown, explicaciones ni texto fuera del JSON.',
    '',
    `Parámetros: mínimo para dividir ${settings.minMessageLengthToSplit} caracteres; máximo ${settings.maxBubbles} mensajes; longitud sugerida por mensaje ${settings.minBubbleLength}-${settings.maxBubbleLength} caracteres.`,
    settings.randomizeSplitting
      ? 'Varía naturalmente si conviene devolver 1, 2, 3, 4, 5 o 6 mensajes, siempre dentro del máximo y sólo cuando el texto lo amerite.'
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

export function splitMessageIntoBubblesFallback({ text, settings = {}, random = Math.random } = {}) {
  const clean = cleanText(text)
  if (!clean) return { messages: [], source: 'empty', reason: 'empty_text' }

  const delivery = normalizeAgentReplyDelivery(settings?.replyDelivery || settings)
  if (!delivery.splitMessagesEnabled) {
    return { messages: [clean], source: 'disabled', reason: 'split_disabled' }
  }

  if (clean.length < delivery.minMessageLengthToSplit) {
    const naturalParts = delivery.randomizeSplitting
      ? splitTextByHumanIntent(clean, delivery, random)
      : [clean]
    if (naturalParts.length <= 1) {
      return { messages: [clean], source: 'threshold', reason: 'below_min_length' }
    }
    const repairedShort = repairMessages(naturalParts, clean, delivery)
    if (!repairedShort.ok) return fallbackResult(clean, repairedShort.reason)
    return { messages: repairedShort.messages, source: 'fallback', reason: 'natural_short_split' }
  }

  const candidateParts = delivery.randomizeSplitting
    ? splitTextByHumanIntent(clean, delivery, random)
    : splitTextConservatively(clean, delivery.maxBubbleLength)
  const repaired = repairMessages(candidateParts, clean, delivery)
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

    if (!raw) {
      return splitMessageIntoBubblesFallback({
        text: clean,
        settings: delivery,
        random
      })
    }

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
