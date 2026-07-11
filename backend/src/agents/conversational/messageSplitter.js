import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'

import { normalizeAgentReplyDelivery } from '../../services/conversationalAgentService.js'
import { logger } from '../../utils/logger.js'

export const MESSAGE_SPLITTER_MODEL = 'gpt-5-nano'
export const MESSAGE_SPLITTER_TIMEOUT_MS = 8_000
export const MESSAGE_SPLITTER_MAX_BUBBLES = 6

const MESSAGE_SPLITTER_MAX_INPUT_CHARS = 4_000
const MESSAGE_SPLITTER_MAX_OUTPUT_TOKENS = 2_048

function cleanText(value) {
  // No normalizar el interior: puede contener códigos, tablas, saltos o dobles
  // espacios que deben llegar al cliente exactamente como los escribió el agente.
  return String(value || '').trim()
}

function getMaxBubbles(settings = {}) {
  const configured = Number(settings.maxBubbles)
  if (!Number.isFinite(configured)) return MESSAGE_SPLITTER_MAX_BUBBLES
  return Math.max(1, Math.min(MESSAGE_SPLITTER_MAX_BUBBLES, Math.round(configured)))
}

function fallbackResult(text, reason) {
  const clean = cleanText(text)
  return {
    messages: clean ? [clean] : [],
    source: clean ? 'fallback' : 'empty',
    reason
  }
}

function getMinimumLengthToSplit(settings = {}) {
  const configured = Number(settings.minMessageLengthToSplit)
  return Number.isFinite(configured) ? Math.max(0, Math.round(configured)) : 120
}

function getMaxBubbleLength(settings = {}, originalText = '') {
  const configured = Number(settings.maxBubbleLength)
  const requested = Number.isFinite(configured) ? Math.max(1, Math.round(configured)) : 350
  // Si el texto no cabe matemáticamente en el máximo de globos permitido,
  // repartimos el excedente en vez de exigir una condición imposible.
  return Math.max(requested, Math.ceil(String(originalText || '').length / getMaxBubbles(settings)))
}

function requiresMultipleBubbles(originalText, settings = {}) {
  return getMaxBubbles(settings) > 1 && originalText.length >= getMinimumLengthToSplit(settings)
}

function buildMessageSplitterOutput(settings, originalText) {
  const minimum = requiresMultipleBubbles(originalText, settings) ? 2 : 1
  return z.object({
    messages: z.array(z.string().min(1)).min(minimum).max(getMaxBubbles(settings))
  })
}

function isAllowedOversizedToken(message, maxLength) {
  return message.length > maxLength && !/\s/u.test(message.trim())
}

function validateAiMessages(rawMessages, originalText, settings) {
  const messages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((message) => String(message || '').trim())
    .filter(Boolean)

  if (!messages.length) {
    return { ok: false, reason: 'empty_messages', messages: [] }
  }

  if (messages.length > getMaxBubbles(settings)) {
    return { ok: false, reason: 'too_many_messages', messages: [] }
  }

  if (requiresMultipleBubbles(originalText, settings) && messages.length < 2) {
    return { ok: false, reason: 'insufficient_messages', messages: [] }
  }

  // Reconstruimos cada globo como un tramo literal del texto original. La IA
  // sólo puede escoger espacios/saltos donde cortar; nunca entrega texto propio.
  const exactMessages = []
  let cursor = 0
  for (const message of messages) {
    const index = originalText.indexOf(message, cursor)
    const separator = index < 0 ? '' : originalText.slice(cursor, index)
    if (index < 0 || separator.trim()) {
      return { ok: false, reason: 'content_changed', messages: [] }
    }
    // Entre dos globos debe existir un espacio o salto real en el original.
    // Así la IA jamás puede partir por la mitad una URL, correo, código o token.
    if (exactMessages.length > 0 && !/\s/u.test(separator)) {
      return { ok: false, reason: 'unsafe_cut_boundary', messages: [] }
    }
    exactMessages.push(originalText.slice(index, index + message.length))
    cursor = index + message.length
  }
  if (originalText.slice(cursor).trim()) {
    return { ok: false, reason: 'content_changed', messages: [] }
  }

  const maxLength = getMaxBubbleLength(settings, originalText)
  if (exactMessages.some((message) => message.length > maxLength && !isAllowedOversizedToken(message, maxLength))) {
    return { ok: false, reason: 'message_too_long', messages: [] }
  }

  return { ok: true, reason: 'exact_content_preserved', messages: exactMessages }
}

function buildSplitterInstructions(settings, originalText) {
  const maxBubbles = getMaxBubbles(settings)
  const minBubbles = requiresMultipleBubbles(originalText, settings) ? 2 : 1
  const minLength = Math.max(1, Number(settings.minBubbleLength) || 20)
  const maxLength = Math.max(minLength, getMaxBubbleLength(settings, originalText))

  return [
    'Eres un cortador de mensajes para chat. Recibes una respuesta final ya escrita y sólo decides dónde termina un globo y empieza el siguiente.',
    'No analizas al cliente, no decides acciones, no respondes preguntas y no tienes herramientas.',
    'Copia el texto exactamente: no cambies, agregues, borres, corrijas ni reordenes una sola palabra, letra, signo, número, URL, fecha, hora, precio, teléfono, correo o código.',
    `Devuelve entre ${minBubbles} y ${maxBubbles} mensajes, en el mismo orden. La longitud objetivo por globo es ${minLength}-${maxLength} caracteres.`,
    'Si hay dos o más ideas, reacciones, pasos, datos o preguntas, sepáralos como lo haría una persona en chat.',
    minBubbles === 1
      ? 'Devuelve un solo mensaje únicamente cuando el texto sea realmente breve y contenga una sola idea.'
      : 'Este texto ya superó el umbral: debes devolver al menos dos mensajes.',
    'Nunca escribas etiquetas como "globo 1", explicaciones, markdown ni marcadores como [BREAK].'
  ].join('\n')
}

async function runWithTimeout(task, timeoutMs) {
  let timeoutId
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('splitter_timeout')), timeoutMs)
      })
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function runAiSplitter({
  text,
  settings,
  apiKey,
  aiSplitter,
  openAIClient,
  timeoutMs
}) {
  if (typeof aiSplitter === 'function') {
    const raw = await runWithTimeout(
      () => aiSplitter({ text, settings, model: MESSAGE_SPLITTER_MODEL }),
      timeoutMs
    )
    return Array.isArray(raw) ? raw : raw?.messages
  }

  const client = openAIClient || new OpenAI({
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0
  })

  const response = await client.responses.parse({
    model: MESSAGE_SPLITTER_MODEL,
    instructions: buildSplitterInstructions(settings, text),
    input: text,
    reasoning: { effort: 'minimal' },
    text: {
      format: zodTextFormat(buildMessageSplitterOutput(settings, text), 'ristak_message_split'),
      verbosity: 'low'
    },
    max_output_tokens: MESSAGE_SPLITTER_MAX_OUTPUT_TOKENS,
    store: false
  })

  return response?.output_parsed?.messages
}

export function splitMessageIntoBubblesFallback({ text, settings = {} } = {}) {
  const clean = cleanText(text)
  if (!clean) return fallbackResult('', 'empty_text')

  const delivery = normalizeAgentReplyDelivery(settings?.replyDelivery || settings)
  if (!delivery.splitMessagesEnabled) {
    return { messages: [clean], source: 'disabled', reason: 'split_disabled' }
  }

  if (!requiresMultipleBubbles(clean, delivery)) {
    return { messages: [clean], source: 'threshold', reason: 'below_split_threshold' }
  }

  return fallbackResult(clean, 'safe_single_message')
}

export async function splitMessageIntoBubbles({
  text,
  settings = {},
  apiKey = null,
  aiSplitter = null,
  openAIClient = null,
  timeoutMs = MESSAGE_SPLITTER_TIMEOUT_MS,
  log = logger
} = {}) {
  const clean = cleanText(text)
  if (!clean) return fallbackResult('', 'empty_text')

  const delivery = normalizeAgentReplyDelivery(settings?.replyDelivery || settings)
  if (!delivery.splitMessagesEnabled) {
    return { messages: [clean], source: 'disabled', reason: 'split_disabled' }
  }

  if (!requiresMultipleBubbles(clean, delivery)) {
    return { messages: [clean], source: 'threshold', reason: 'below_split_threshold' }
  }

  if (clean.length > MESSAGE_SPLITTER_MAX_INPUT_CHARS) {
    return fallbackResult(clean, 'input_too_long')
  }

  if (!apiKey && typeof aiSplitter !== 'function' && !openAIClient) {
    return fallbackResult(clean, 'missing_openai_api_key')
  }

  try {
    const rawMessages = await runAiSplitter({
      text: clean,
      settings: delivery,
      apiKey,
      aiSplitter,
      openAIClient,
      timeoutMs: Math.max(1, Number(timeoutMs) || MESSAGE_SPLITTER_TIMEOUT_MS)
    })
    const validated = validateAiMessages(rawMessages, clean, delivery)
    if (!validated.ok) return fallbackResult(clean, validated.reason)

    return {
      messages: validated.messages,
      source: 'ai',
      reason: validated.reason,
      model: MESSAGE_SPLITTER_MODEL
    }
  } catch (error) {
    log.warn(`[Agente conversacional] Mini-IA de globitos falló; se enviará la respuesta completa: ${error.message}`)
    return fallbackResult(clean, error.message || 'splitter_error')
  }
}
