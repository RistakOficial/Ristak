import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { db } from '../../config/database.js'
import { logger } from '../../utils/logger.js'
import { getAccountTimezone } from '../../utils/dateUtils.js'
import { getAIAgentConfig, getOpenAIApiKey } from '../../services/aiAgentService.js'
import {
  startAgentRun,
  updateAgentRun,
  recordAgentStep,
  completeAgentRun
} from '../../services/agentExecutionLedgerService.js'
import {
  getConversationalAgentConfig,
  getConversationState,
  ensureConversationState,
  recordConversationalAgentEvent,
  getConversationalAgent,
  listConversationalAgents,
  matchAgentForMessage,
  assignAgentToConversation,
  buildRuleContext,
  exitRulesMatch,
  normalizeConversationalAgentModel,
  getAgentResponseDelayMs,
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentReplyDelivery
} from '../../services/conversationalAgentService.js'
import { buildConversationalInstructions } from './prompt.js'
import { createConversationalTools } from './tools.js'
import { buildInputItems } from '../runner.js'

const HISTORY_LIMIT = 20
const MAX_TURNS = 10
const DEFAULT_MODEL = process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || 'gpt-5.4-nano'
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000
const PENDING_INBOUND_LIMIT = 8
const PENDING_INBOUND_SCAN_LIMIT = 30
const MAX_REPLY_PARTS = 6

// Conversaciones que el agente está procesando ahora mismo (instancia única).
const runningContacts = new Set()

// Palabras internas que jamás deben llegar al cliente final.
const INTERNAL_TOKEN_PATTERN = /\b(AGENDAR|SALTAR|ready_for_human|ready_to_schedule|ready_to_buy|mark_ready_to_advance|send_to_human|discard_conversation|stay_silent|book_appointment)\b/gi

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function sanitizeAgentReply(text) {
  let reply = String(text || '').trim()
  if (!reply) return ''
  reply = reply.replace(INTERNAL_TOKEN_PATTERN, '').replace(/\[[^\]]*herramienta[^\]]*\]/gi, '')
  reply = reply.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if ((reply.startsWith('"') && reply.endsWith('"')) || (reply.startsWith('“') && reply.endsWith('”'))) {
    reply = reply.slice(1, -1).trim()
  }
  if (reply.length > MAX_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_REPLY_CHARS - 1).trim()}…`
  }
  return reply
}

function cleanMessageText(row) {
  return String(row?.message_text || '').trim() ||
    (row?.message_type && row.message_type !== 'text' ? `[${row.message_type} sin texto]` : '') ||
    '(mensaje vacío)'
}

function splitLongSegment(segment, targetChars) {
  const words = String(segment || '').trim().split(/\s+/).filter(Boolean)
  const parts = []
  let current = ''

  for (const word of words) {
    if (word.length > targetChars) {
      if (current) {
        parts.push(current)
        current = ''
      }
      for (let index = 0; index < word.length; index += targetChars) {
        parts.push(word.slice(index, index + targetChars))
      }
      continue
    }

    const next = current ? `${current} ${word}` : word
    if (next.length > targetChars && current) {
      parts.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) parts.push(current)
  return parts
}

function splitReplySegments(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [paragraph])
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function splitReplyIntoParts(reply, deliveryInput = {}) {
  const text = String(reply || '').trim()
  if (!text) return []

  const delivery = normalizeAgentReplyDelivery(deliveryInput?.replyDelivery || deliveryInput)
  if (delivery.mode !== 'split' || text.length <= Math.round(delivery.targetChars * 1.15)) {
    return [text]
  }

  const parts = []
  let current = ''

  const pushPart = (part) => {
    const clean = String(part || '').trim()
    if (clean) parts.push(clean)
  }

  for (const segment of splitReplySegments(text)) {
    const subSegments = segment.length > delivery.targetChars
      ? splitLongSegment(segment, delivery.targetChars)
      : [segment]

    for (const subSegment of subSegments) {
      const next = current ? `${current} ${subSegment}` : subSegment
      if (next.length > delivery.targetChars && current) {
        pushPart(current)
        current = subSegment
      } else {
        current = next
      }
    }
  }

  pushPart(current)

  if (parts.length <= MAX_REPLY_PARTS) return parts
  return [
    ...parts.slice(0, MAX_REPLY_PARTS - 1),
    parts.slice(MAX_REPLY_PARTS - 1).join(' ')
  ].filter(Boolean)
}

export function buildPendingReplyContextMessage(pendingMessages = []) {
  const lines = (Array.isArray(pendingMessages) ? pendingMessages : [])
    .map((message, index) => {
      const text = cleanMessageText(message).slice(0, 700)
      return `${index + 1}. ${text}`
    })
    .filter(Boolean)

  if (!lines.length) return null

  return {
    role: 'user',
    content: [
      '[Contexto interno de Ristak: mensajes entrantes pendientes sin respuesta completa]',
      'Estos mensajes todavía deben tomarse en cuenta como parte de la siguiente respuesta visible del agente.',
      'Responde considerando TODOS, no sólo el último. Si el último mensaje corrige o agrega información, prioriza lo más reciente.',
      'Si ya existe una respuesta parcial del agente en el historial, continúa de forma natural sin repetirla literal.',
      'No menciones este contexto interno.',
      ...lines
    ].join('\n')
  }
}

async function loadConversationHistory(contactId) {
  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, HISTORY_LIMIT])

  return rows.reverse().map((row) => {
    return {
      id: row.id,
      role: row.direction === 'outbound' ? 'assistant' : 'user',
      content: cleanMessageText(row),
      timestamp: row.message_timestamp || row.created_at || null
    }
  })
}

async function loadPendingInboundMessages(contactId, state = {}) {
  const rows = await db.all(`
    SELECT id, message_text, message_type, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ? AND direction = 'inbound'
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, PENDING_INBOUND_SCAN_LIMIT])

  const ordered = rows.reverse()
  const answeredIndex = state?.lastAnsweredInboundMessageId
    ? ordered.findIndex((row) => row.id === state.lastAnsweredInboundMessageId)
    : -1

  let pending = answeredIndex >= 0 ? ordered.slice(answeredIndex + 1) : ordered
  if (answeredIndex < 0 && state?.lastReplyAt) {
    pending = ordered.filter((row) => {
      const messageTime = row.message_timestamp || row.created_at || ''
      const createdTime = row.created_at || ''
      return messageTime > state.lastReplyAt || createdTime > state.lastReplyAt
    })
  }

  return pending.slice(-PENDING_INBOUND_LIMIT)
}

async function loadLatestInboundMessage(contactId) {
  return db.get(`
    SELECT id, message_text, message_type, phone, business_phone, business_phone_number_id
    FROM whatsapp_api_messages
    WHERE contact_id = ? AND direction = 'inbound'
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT 1
  `, [contactId])
}

async function buildAgentForRun({ config, conversationModel, contactId, contactName, dryRun }) {
  const [aiConfig, timezone] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => 'America/Mexico_City')
  ])

  const model = normalizeConversationalAgentModel(conversationModel || config?.model || DEFAULT_MODEL)
  const nowIso = new Date().toLocaleString('es-MX', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })

  let businessName = null
  try {
    const hlRow = await db.get('SELECT location_data FROM highlevel_config LIMIT 1')
    businessName = hlRow?.location_data ? JSON.parse(hlRow.location_data)?.name || null : null
  } catch { /* sin HighLevel */ }
  if (!businessName) {
    const userRow = await db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null)
    businessName = userRow?.business_name || null
  }

  const ctx = { contactId, config, dryRun, actions: [], suppressReply: false }
  const tools = createConversationalTools(ctx)

  const instructions = buildConversationalInstructions({
    config,
    businessContext: String(aiConfig?.business_context || '').trim().slice(0, 6000),
    brandVoice: String(aiConfig?.brand_voice || '').trim().slice(0, 2000),
    businessName,
    timezone,
    nowIso,
    contactName
  })

  const agent = new Agent({
    name: 'Ristak · Agente conversacional',
    model,
    instructions,
    tools
  })

  return { agent, ctx, model }
}

async function executeAgent({ agent, apiKey, messages, contactId, model, traceMessage = '' }) {
  let agentRun = null
  try {
    agentRun = await startAgentRun({
      userId: null,
      latestUserMessage: traceMessage || [...messages].reverse().find((m) => m.role === 'user')?.content || '',
      viewContext: { path: '/chat', title: 'Agente conversacional' }
    })
    await updateAgentRun(agentRun, {
      domain: 'conversacional',
      action: 'whatsapp_reply',
      model,
      route: { engine: 'openai-agents-sdk', category: 'conversacional', contactId }
    })
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo iniciar rastro: ${error.message}`)
  }

  try {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ apiKey }),
      tracingDisabled: true
    })
    const result = await runner.run(agent, buildInputItems(messages), {
      maxTurns: MAX_TURNS,
      context: { category: 'conversacional', contactId }
    })

    const reply = sanitizeAgentReply(result.finalOutput)
    await recordAgentStep(agentRun, {
      stepType: 'final_response',
      status: 'completed',
      output: { reply: reply.slice(0, 1600), model }
    })
    await completeAgentRun(agentRun, { status: 'completed', reply, model, usage: null })

    return reply
  } catch (error) {
    await recordAgentStep(agentRun, { stepType: 'error', status: 'failed', error: error.message })
    await completeAgentRun(agentRun, { status: 'failed', error: error.message })
    throw error
  }
}

function scheduleConversationalAgentRerun({ contactId, phone, latestMessage, reason }) {
  if (!latestMessage?.id) return
  setTimeout(() => {
    handleInboundMessageForConversationalAgent({
      contactId,
      phone: latestMessage.phone || phone,
      messageId: latestMessage.id
    }).catch((error) => {
      logger.error(`[Agente conversacional] Error reintentando tras ${reason}: ${error.message}`)
    })
  }, 0)
}

async function loadNewerInboundMessage(contactId, handledMessageId) {
  const latest = await loadLatestInboundMessage(contactId)
  return latest && latest.id !== handledMessageId ? latest : null
}

async function sendReplyParts({ contactId, phone, latest, agentConfig, reply }) {
  const parts = splitReplyIntoParts(reply, agentConfig.replyDelivery)
  if (!parts.length) return { parts: [], sentParts: 0, interruptedBy: null }

  const { sendWhatsAppApiTextMessage } = await import('../../services/whatsappApiService.js')

  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      const delayMs = getAgentReplyDeliveryPartDelayMs(agentConfig)
      if (delayMs > 0) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_part_wait_started',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, partIndex: index + 1, partCount: parts.length, delayMs }
        })
        await sleep(delayMs)
      }

      const newerInbound = await loadNewerInboundMessage(contactId, latest.id)
      if (newerInbound) {
        return { parts, sentParts: index, interruptedBy: newerInbound }
      }
    }

    await sendWhatsAppApiTextMessage({
      to: phone || latest.phone,
      from: latest.business_phone || undefined,
      phoneNumberId: latest.business_phone_number_id || undefined,
      text: parts[index],
      externalId: `convagent_${latest.id}${parts.length > 1 ? `_${index + 1}` : ''}`.slice(0, 120)
    })

    await recordConversationalAgentEvent({
      contactId,
      eventType: parts.length > 1 ? 'reply_part_sent' : 'reply_single_sent',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        partIndex: index + 1,
        partCount: parts.length,
        replyPreview: parts[index].slice(0, 180)
      }
    })
  }

  await db.run(`
    UPDATE conversational_agent_state
    SET last_reply_at = CURRENT_TIMESTAMP,
        last_answered_inbound_message_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [latest.id, contactId])

  return { parts, sentParts: parts.length, interruptedBy: null }
}

/**
 * Punto de entrada desde el webhook de mensajes entrantes de WhatsApp.
 * Es fire-and-forget: nunca lanza, solo registra errores.
 */
export async function handleInboundMessageForConversationalAgent({ contactId, phone, messageId }) {
  try {
    if (!contactId || !messageId) return

    const config = await getConversationalAgentConfig()
    if (!config.enabled) return

    const state = await ensureConversationState(contactId)
    if (!state || state.status !== 'active') return

    if (runningContacts.has(contactId)) return
    runningContacts.add(contactId)

    try {
      // Pequeña espera para agrupar ráfagas de mensajes: si después de la
      // espera ya hay un mensaje más nuevo, esa ejecución posterior atiende.
      await sleep(DEBOUNCE_MS)

      const latest = await loadLatestInboundMessage(contactId)
      if (!latest) return

      const freshState = await getConversationState(contactId)
      if (!freshState || freshState.status !== 'active') return
      if (freshState.lastInboundMessageId === latest.id && freshState.lastAnsweredInboundMessageId === latest.id) return

      // Reclama el mensaje antes de correr para evitar respuestas duplicadas.
      await db.run(`
        UPDATE conversational_agent_state
        SET last_inbound_message_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE contact_id = ?
      `, [latest.id, contactId])

      const apiKey = await getOpenAIApiKey()
      if (!apiKey) {
        logger.warn('[Agente conversacional] Sin API Key de OpenAI configurada; no se puede responder')
        return
      }

      // Resolver qué agente atiende esta conversación: el ya asignado o el
      // primero cuyas reglas de entrada coincidan con el mensaje/contacto.
      const ruleContext = await buildRuleContext({
        contactId,
        messageText: latest.message_text || '',
        channel: 'whatsapp'
      })

      let agentConfig = freshState.agentId ? await getConversationalAgent(freshState.agentId) : null
      let releasedAgentId = null

      // Reglas de salida: si alguna se cumple, este agente suelta el contacto.
      if (agentConfig && exitRulesMatch(agentConfig, ruleContext)) {
        releasedAgentId = agentConfig.id
        await assignAgentToConversation(contactId, null)
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'exit_rules' }
        })
        agentConfig = null
      }

      if (!agentConfig || !agentConfig.enabled) {
        agentConfig = await matchAgentForMessage({
          contactId,
          messageText: latest.message_text || '',
          channel: 'whatsapp',
          excludeAgentId: releasedAgentId,
          ruleContext
        })
        if (agentConfig) {
          await assignAgentToConversation(contactId, agentConfig.id)
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'agent_assigned',
            detail: { agentId: agentConfig.id, name: agentConfig.name }
          })
        }
      }
      if (!agentConfig) {
        // Ningún agente aplica a esta conversación: no responder.
        return
      }

      const contact = await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId]).catch(() => null)
      const messages = await loadConversationHistory(contactId)
      if (!messages.length) return
      const pendingMessages = await loadPendingInboundMessages(contactId, freshState)
      const pendingContextMessage = buildPendingReplyContextMessage(pendingMessages)
      const messagesForAgent = pendingContextMessage ? [...messages, pendingContextMessage] : messages
      const traceMessage = cleanMessageText(pendingMessages[pendingMessages.length - 1] || latest)

      const { agent, ctx, model } = await buildAgentForRun({
        config: agentConfig,
        conversationModel: config.model,
        contactId,
        contactName: contact?.full_name || null,
        dryRun: false
      })

      const reply = await executeAgent({
        agent,
        apiKey,
        messages: messagesForAgent,
        contactId,
        model,
        traceMessage
      })

      const responseDelayMs = getAgentResponseDelayMs(agentConfig)
      if (responseDelayMs > 0) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_wait_started',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, delayMs: responseDelayMs }
        })
        await sleep(responseDelayMs)

        const latestAfterDelay = await loadNewerInboundMessage(contactId, latest.id)
        if (latestAfterDelay) {
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'reply_suppressed',
            detail: {
              messageId: latest.id,
              agentId: agentConfig.id || null,
              reason: 'newer_inbound_during_response_delay',
              newerMessageId: latestAfterDelay.id
            }
          })
          scheduleConversationalAgentRerun({
            contactId,
            phone,
            latestMessage: latestAfterDelay,
            reason: 'pausa de respuesta'
          })
          return
        }
      }

      // El estado pudo cambiar durante la ejecución o la espera (descartada, humano, etc.)
      const postState = await getConversationState(contactId)
      const blockedStatuses = new Set(['discarded', 'paused', 'skipped', 'human'])
      if (ctx.suppressReply || !reply || blockedStatuses.has(postState?.status)) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, actions: ctx.actions, status: postState?.status || null }
        })
        return
      }

      const latestBeforeSend = await loadNewerInboundMessage(contactId, latest.id)
      if (latestBeforeSend) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            reason: 'newer_inbound_before_reply',
            newerMessageId: latestBeforeSend.id
          }
        })
        scheduleConversationalAgentRerun({
          contactId,
          phone,
          latestMessage: latestBeforeSend,
          reason: 'mensaje nuevo antes de enviar'
        })
        return
      }

      const delivery = await sendReplyParts({ contactId, phone, latest, agentConfig, reply })
      if (delivery.interruptedBy) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            reason: 'newer_inbound_during_split_reply',
            newerMessageId: delivery.interruptedBy.id,
            sentParts: delivery.sentParts,
            partCount: delivery.parts.length
          }
        })
        scheduleConversationalAgentRerun({
          contactId,
          phone,
          latestMessage: delivery.interruptedBy,
          reason: 'envío en partes'
        })
        return
      }

      await recordConversationalAgentEvent({
        contactId,
        eventType: 'reply_sent',
        detail: {
          messageId: latest.id,
          agentId: agentConfig.id || null,
          replyPreview: reply.slice(0, 280),
          partCount: delivery.parts.length,
          pendingInboundCount: pendingMessages.length,
          actions: ctx.actions
        }
      })
    } finally {
      runningContacts.delete(contactId)
    }
  } catch (error) {
    runningContacts.delete(contactId)
    logger.error(`[Agente conversacional] Error atendiendo mensaje entrante: ${error.message}`)
    await recordConversationalAgentEvent({
      contactId: contactId || null,
      eventType: 'error',
      detail: { message: error.message }
    }).catch(() => {})
  }
}

/**
 * Conversación simulada para probar el agente antes de activarlo.
 * No envía WhatsApp, no toca estados ni crea citas: las acciones internas
 * se devuelven como lista para mostrarlas en la prueba.
 */
export async function runConversationalAgentPreview({ messages = [], configOverride = null, agentId = null }) {
  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    const error = new Error('Primero configura una API Key válida de OpenAI en la sección General del Agente AI')
    error.statusCode = 409
    throw error
  }

  const globalConfig = await getConversationalAgentConfig()
  let baseConfig = agentId ? await getConversationalAgent(agentId) : null
  if (!baseConfig) {
    baseConfig = (await listConversationalAgents())[0] || null
  }
  if (!baseConfig) {
    baseConfig = {
      name: 'Agente', objective: 'citas', customObjective: '', successAction: 'ready_for_human',
      successExtras: [], requiredData: '', handoffRules: '', extraInstructions: '',
      allowEmojis: false, defaultCalendarId: null, closingStrategyMode: 'system', closingStrategyCustom: '',
      responseDelay: { mode: 'none', fixedValue: 10, fixedUnit: 'seconds', minValue: 1, maxValue: 10, rangeUnit: 'minutes' },
      replyDelivery: { mode: 'single', targetChars: 280, minDelaySeconds: 2, maxDelaySeconds: 6 }
    }
  }
  const config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig

  const cleanMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.trim() }))
    .slice(-HISTORY_LIMIT)

  if (!cleanMessages.length) {
    const error = new Error('Envía al menos un mensaje para simular la conversación')
    error.statusCode = 400
    throw error
  }

  const { agent, ctx, model } = await buildAgentForRun({
    config,
    conversationModel: globalConfig.model,
    contactId: null,
    contactName: null,
    dryRun: true
  })

  const reply = await executeAgent({ agent, apiKey, messages: cleanMessages, contactId: null, model })

  return {
    reply: ctx.suppressReply ? '' : reply,
    replyParts: ctx.suppressReply ? [] : splitReplyIntoParts(reply, config.replyDelivery),
    suppressed: ctx.suppressReply,
    actions: ctx.actions,
    model
  }
}
