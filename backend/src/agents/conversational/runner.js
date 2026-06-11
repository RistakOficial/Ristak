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
  exitRulesMatch
} from '../../services/conversationalAgentService.js'
import { buildConversationalInstructions } from './prompt.js'
import { createConversationalTools } from './tools.js'
import { buildInputItems } from '../runner.js'

const HISTORY_LIMIT = 20
const MAX_TURNS = 10
const DEFAULT_MODEL = 'gpt-5.5'
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000

// Conversaciones que el agente está procesando ahora mismo (instancia única).
const runningContacts = new Set()

// Palabras internas que jamás deben llegar al cliente final.
const INTERNAL_TOKEN_PATTERN = /\b(AGENDAR|SALTAR|ready_for_human|ready_to_schedule|ready_to_buy|mark_ready_to_advance|send_to_human|discard_conversation|stay_silent|book_appointment)\b/gi

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

async function loadConversationHistory(contactId) {
  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, HISTORY_LIMIT])

  return rows.reverse().map((row) => {
    const text = String(row.message_text || '').trim() ||
      (row.message_type && row.message_type !== 'text' ? `[${row.message_type} sin texto]` : '')
    return {
      role: row.direction === 'outbound' ? 'assistant' : 'user',
      content: text || '(mensaje vacío)'
    }
  })
}

async function buildAgentForRun({ config, contactId, contactName, dryRun }) {
  const [aiConfig, timezone] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => 'America/Mexico_City')
  ])

  const model = String(aiConfig?.model || DEFAULT_MODEL)
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

async function executeAgent({ agent, apiKey, messages, contactId, model }) {
  let agentRun = null
  try {
    agentRun = await startAgentRun({
      userId: null,
      latestUserMessage: [...messages].reverse().find((m) => m.role === 'user')?.content || '',
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
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS))

      const latest = await db.get(`
        SELECT id, message_text, phone, business_phone, business_phone_number_id
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND direction = 'inbound'
        ORDER BY COALESCE(message_timestamp, created_at) DESC
        LIMIT 1
      `, [contactId])
      if (!latest) return

      const freshState = await getConversationState(contactId)
      if (!freshState || freshState.status !== 'active') return
      if (freshState.lastInboundMessageId === latest.id) return

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

      const { agent, ctx, model } = await buildAgentForRun({
        config: agentConfig,
        contactId,
        contactName: contact?.full_name || null,
        dryRun: false
      })

      const reply = await executeAgent({ agent, apiKey, messages, contactId, model })

      // El estado pudo cambiar durante la ejecución (descartada, humano, etc.)
      const postState = await getConversationState(contactId)
      const blockedStatuses = new Set(['discarded', 'paused', 'skipped'])
      if (ctx.suppressReply || !reply || blockedStatuses.has(postState?.status)) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, actions: ctx.actions, status: postState?.status || null }
        })
        return
      }

      const { sendWhatsAppApiTextMessage } = await import('../../services/whatsappApiService.js')
      await sendWhatsAppApiTextMessage({
        to: phone || latest.phone,
        from: latest.business_phone || undefined,
        phoneNumberId: latest.business_phone_number_id || undefined,
        text: reply,
        externalId: `convagent_${latest.id}`.slice(0, 120)
      })

      await db.run(`
        UPDATE conversational_agent_state
        SET last_reply_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE contact_id = ?
      `, [contactId])

      await recordConversationalAgentEvent({
        contactId,
        eventType: 'reply_sent',
        detail: { messageId: latest.id, agentId: agentConfig.id || null, replyPreview: reply.slice(0, 280), actions: ctx.actions }
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

  let baseConfig = agentId ? await getConversationalAgent(agentId) : null
  if (!baseConfig) {
    baseConfig = (await listConversationalAgents())[0] || null
  }
  if (!baseConfig) {
    baseConfig = {
      name: 'Agente', objective: 'citas', customObjective: '', successAction: 'ready_for_human',
      successExtras: [], requiredData: '', handoffRules: '', extraInstructions: '',
      allowEmojis: false, defaultCalendarId: null, closingStrategyMode: 'system', closingStrategyCustom: ''
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
    contactId: null,
    contactName: null,
    dryRun: true
  })

  const reply = await executeAgent({ agent, apiKey, messages: cleanMessages, contactId: null, model })

  return {
    reply: ctx.suppressReply ? '' : reply,
    suppressed: ctx.suppressReply,
    actions: ctx.actions,
    model
  }
}
