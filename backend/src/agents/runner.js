import { Agent, Runner, OpenAIProvider, assistant, webSearchTool } from '@openai/agents'
import { logger } from '../utils/logger.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { getAIAgentConfig } from '../services/aiAgentService.js'
import {
  startAgentRun,
  updateAgentRun,
  recordAgentStep,
  completeAgentRun,
  buildAgentTracePayload
} from '../services/agentExecutionLedgerService.js'
import { AGENT_CATEGORIES, getAgentCategory, resolveCategoryContextFields } from './registry.js'
import { loadAgentMemories } from './tools/memoryTools.js'

const MESSAGE_HISTORY_LIMIT = 12
const MAX_TURNS = 16
const DEFAULT_MODEL = 'gpt-5.4-nano'
const CONTEXT_FIELD_LIMIT = 4000

const MAX_CHAT_ATTACHMENTS = 8
const MAX_ATTACHMENT_TEXT_CHARS = 18000

const CONTEXT_FIELD_LABELS = {
  business_context: 'Contexto del negocio',
  market_context: 'Mercado y nicho',
  ideal_customer: 'Cliente ideal',
  location_context: 'Zona geográfica',
  competitors_context: 'Competidores y referencias',
  brand_voice: 'Tono y voz de marca'
}

const BASE_INSTRUCTIONS = `Eres un agente IA de Ristak, el panel de operación de este negocio. Respondes SIEMPRE en español, claro y directo, como un colaborador de confianza.

Reglas generales (no negociables):
- Usa tus herramientas para consultar datos reales antes de afirmar algo; nunca inventes cifras, IDs ni resultados.
- Nunca inventes un ID: obtén los IDs reales con las herramientas de búsqueda/listado.
- Para acciones destructivas (eliminar contacto, cita, pago o costo) SIEMPRE pide confirmación explícita al usuario en un mensaje y ejecuta solo cuando responda que sí.
- Si una herramienta devuelve { ok: false }, lee el error, corrige y reintenta o explica al usuario qué falta.
- Si no encuentras datos, dilo claramente ("no encontré...") en lugar de suponer.
- Puedes ver imágenes, PDFs y archivos de texto que el usuario adjunte; los videos llegan solo como miniatura.
- Responde corto: resultados primero, detalle solo si aporta.`

function truncate(value, limit) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function buildInstructions({ category, agentConfig, memories, viewContext, timezone, nowIso }) {
  const sections = [BASE_INSTRUCTIONS, category.instructions]

  const contextFields = resolveCategoryContextFields(category)
  const contextLines = contextFields
    .map((field) => {
      const value = truncate(agentConfig?.[field], CONTEXT_FIELD_LIMIT)
      return value ? `### ${CONTEXT_FIELD_LABELS[field] || field}\n${value}` : null
    })
    .filter(Boolean)

  if (contextLines.length) {
    sections.push(`## Contexto del negocio (solo lo relevante para tu especialidad)\n${contextLines.join('\n\n')}`)
  }

  sections.push(`## Fecha y zona horaria
- Fecha y hora actual: ${nowIso}
- Zona horaria de la cuenta: ${timezone}
Interpreta fechas relativas ("hoy", "mañana", "este mes") con esta fecha y zona.`)

  if (memories.length) {
    const memoryLines = memories
      .map((memory) => `- [${memory.id}] ${truncate(memory.content, 400)}`)
      .join('\n')
    sections.push(`## Memoria de tu especialidad (notas guardadas)\n${memoryLines}\nUsa save_memory para guardar datos nuevos que te pidan recordar y forget_memory para borrar notas obsoletas.`)
  } else {
    sections.push('## Memoria de tu especialidad\nAún no tienes notas guardadas. Usa save_memory cuando el usuario te pida recordar algo o detectes una preferencia estable.')
  }

  const viewPath = truncate(viewContext?.path, 200)
  const viewTitle = truncate(viewContext?.title || viewContext?.routeLabel, 200)
  if (viewPath || viewTitle) {
    sections.push(`## Pantalla actual del usuario\n${[viewTitle, viewPath].filter(Boolean).join(' — ')}`)
  }

  return sections.join('\n\n')
}

function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,')
}

/**
 * Convierte un adjunto del chat (imagen, video, PDF, texto, archivo) en partes
 * de contenido del protocolo del Agents SDK. Misma lógica que el flujo legacy.
 */
function attachmentToContentParts(attachment) {
  if (!attachment || typeof attachment !== 'object') return []

  const name = String(attachment.name || 'archivo').slice(0, 180)
  const kind = String(attachment.kind || '').toLowerCase()
  const summary = `Adjunto: ${name} (tipo=${attachment.mimeType || kind || 'desconocido'})`
  const parts = []

  if (kind === 'image' && isDataUrl(attachment.dataUrl)) {
    parts.push({ type: 'input_image', image: attachment.dataUrl })
  } else if (kind === 'video' && isDataUrl(attachment.thumbnailDataUrl)) {
    parts.push({ type: 'input_text', text: `${summary}\nEste video se envió con una miniatura visual para analizar el encuadre/contenido visible.` })
    parts.push({ type: 'input_image', image: attachment.thumbnailDataUrl })
  } else if (typeof attachment.text === 'string' && attachment.text.trim()) {
    parts.push({ type: 'input_text', text: `${summary}\nContenido del archivo ${name}:\n${attachment.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}` })
  } else if (isDataUrl(attachment.dataUrl)) {
    parts.push({ type: 'input_file', filename: name, file: attachment.dataUrl })
  } else {
    parts.push({ type: 'input_text', text: `${summary} (sin contenido legible adjunto)` })
  }

  return parts
}

export function buildInputItems(messages) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message) return false
      const hasText = typeof message.content === 'string' && message.content.trim()
      const hasAttachments = Array.isArray(message.attachments) && message.attachments.length
      return hasText || hasAttachments
    })
    .slice(-MESSAGE_HISTORY_LIMIT)

  return recent.map((message) => {
    let text = typeof message.content === 'string' ? message.content.trim() : ''
    if (message.role === 'user' && message.selectedClarificationOption?.value) {
      text = `${text}\n[Opción seleccionada: ${message.selectedClarificationOption.value}]`
    }

    if (message.role === 'assistant') {
      return assistant(text)
    }

    const attachmentParts = (Array.isArray(message.attachments) ? message.attachments : [])
      .slice(0, MAX_CHAT_ATTACHMENTS)
      .flatMap(attachmentToContentParts)

    const content = [
      ...(text ? [{ type: 'input_text', text }] : []),
      ...attachmentParts
    ]

    return {
      role: 'user',
      content: content.length ? content : [{ type: 'input_text', text: '(mensaje vacío)' }]
    }
  })
}

/**
 * Extrae fuentes (citas de URL de la búsqueda web) de las respuestas crudas del modelo.
 */
function extractSources(rawResponses = []) {
  const sources = []
  const seen = new Set()

  for (const response of rawResponses) {
    for (const item of response?.output || []) {
      const contentParts = Array.isArray(item?.content) ? item.content : []
      for (const part of contentParts) {
        const annotations = part?.annotations || part?.providerData?.annotations || []
        for (const annotation of annotations) {
          const type = annotation?.type || annotation?.Type
          const url = annotation?.url
          if (type === 'url_citation' && url && !seen.has(url)) {
            seen.add(url)
            sources.push({ title: annotation.title || url, url })
          }
        }
      }
    }
  }

  return sources.slice(0, 10)
}

function aggregateUsage(rawResponses = []) {
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  let hasData = false
  for (const response of rawResponses) {
    const u = response?.usage
    if (!u) continue
    hasData = true
    usage.input_tokens += Number(u.inputTokens || 0)
    usage.output_tokens += Number(u.outputTokens || 0)
    usage.total_tokens += Number(u.totalTokens || 0)
  }
  return hasData ? usage : null
}

async function recordToolSteps(agentRun, newItems = []) {
  const outputsByCallId = new Map()
  for (const item of newItems) {
    if (item?.type === 'tool_call_output_item') {
      const callId = item.rawItem?.callId || item.rawItem?.call_id || item.rawItem?.id
      outputsByCallId.set(callId, item.output ?? item.rawItem?.output ?? null)
    }
  }

  for (const item of newItems) {
    if (item?.type === 'handoff_output_item') {
      await recordAgentStep(agentRun, {
        stepType: 'handoff',
        toolName: item.targetAgent?.name || 'unknown_agent',
        status: 'completed',
        output: { from: item.sourceAgent?.name || null, to: item.targetAgent?.name || null }
      })
      continue
    }
    if (item?.type !== 'tool_call_item') continue
    const raw = item.rawItem || {}
    const callId = raw.callId || raw.call_id || raw.id
    let parsedInput = raw.arguments
    try {
      parsedInput = typeof raw.arguments === 'string' ? JSON.parse(raw.arguments) : raw.arguments
    } catch { /* deja el string crudo */ }

    await recordAgentStep(agentRun, {
      stepType: 'tool_call',
      toolName: raw.name || 'unknown_tool',
      status: 'completed',
      input: parsedInput || null,
      output: outputsByCallId.has(callId) ? truncate(JSON.stringify(outputsByCallId.get(callId)), 4000) : null
    })
  }
}

const SPECIALIST_HANDOFF_RULES = `## Si el tema no es tuyo
Tienes herramientas transfer_to_<agente> para pasar la conversación a otro especialista.
Si el mensaje del usuario NO corresponde a tu especialidad (ej. te preguntan de pagos y tú eres el de citas), NO intentes resolverlo ni digas que no puedes: transfiere de inmediato al especialista correcto y no escribas nada más. Para temas que cruzan varias áreas, transfiere a "general".`

const TRIAGE_INSTRUCTIONS = `Eres el recepcionista de los agentes IA de Ristak. Tu ÚNICO trabajo es leer el último mensaje del usuario (con el contexto de la conversación) y transferirlo al especialista correcto con la herramienta transfer_to_<agente>:
- citas: agendar, reprogramar, cancelar o consultar citas, calendarios y horarios disponibles.
- pagos: registrar/editar pagos, links de cobro, parcialidades, ingresos y transacciones.
- contactos: crear, editar, buscar, depurar o consultar contactos (CRM).
- anuncios: métricas y análisis de campañas de Meta Ads.
- redes: perfiles sociales conectados, bandeja y conversaciones de Facebook/Instagram.
- costos: comisiones y costos variables de los reportes.
- general: preguntas que cruzan varias áreas, dudas del negocio en general o cualquier cosa que no encaje arriba.

Reglas:
- SIEMPRE transfiere; no respondas tú el fondo de la pregunta.
- Solo contesta tú directamente saludos ("hola") o "¿qué puedes hacer?": ahí preséntate en 2-3 líneas con las áreas disponibles, en español.
- En caso de duda entre dos especialistas, usa general.`

/**
 * Construye los agentes especializados con handoffs cruzados y el triage.
 * El nombre de cada agente es el id de su categoría, así las herramientas de
 * transferencia quedan como transfer_to_citas, transfer_to_pagos, etc.
 */
function buildAgentGraph({ agentConfig, memoriesByCategory, viewContext, timezone, nowIso, model, webSearchEnabled }) {
  const specialists = AGENT_CATEGORIES.map((category) => {
    const instructions = [
      buildInstructions({
        category,
        agentConfig,
        memories: memoriesByCategory[category.id] || [],
        viewContext,
        timezone,
        nowIso
      }),
      SPECIALIST_HANDOFF_RULES
    ].join('\n\n')

    return new Agent({
      name: category.id,
      model,
      handoffDescription: `${category.label}: ${category.description}`,
      instructions,
      tools: webSearchEnabled ? [...category.tools, webSearchTool()] : category.tools,
      handoffs: []
    })
  })

  for (const agent of specialists) {
    agent.handoffs = specialists.filter((other) => other !== agent)
  }

  const triage = new Agent({
    name: 'triage',
    model,
    instructions: TRIAGE_INSTRUCTIONS,
    handoffs: [...specialists]
  })

  const byCategory = Object.fromEntries(specialists.map((agent) => [agent.name, agent]))
  return { triage, byCategory }
}

/**
 * Ejecuta el chat de agentes especializados y devuelve la respuesta con la misma
 * forma que el chat legacy: { reply, model, category, sources, usage, trace }.
 *
 * Sin categoría (o con 'auto') entra el triage, que clasifica el mensaje y lo
 * transfiere al especialista; con categoría explícita entra ese especialista,
 * que también puede transferir si el tema no es suyo.
 */
export async function runSpecializedAgentReply({ apiKey, category: categoryId, messages, viewContext = {}, userId = null }) {
  const requestedCategory = getAgentCategory(categoryId)

  const latestUserMessage = [...(messages || [])].reverse().find((message) => message?.role === 'user')?.content || ''

  let agentRun = null
  try {
    agentRun = await startAgentRun({ userId, latestUserMessage, viewContext })
  } catch (error) {
    logger.warn(`No se pudo iniciar rastro del agente especializado: ${error.message}`)
  }

  try {
    const [agentConfig, timezone, ...memoryLists] = await Promise.all([
      getAIAgentConfig({ userId }),
      getAccountTimezone().catch(() => 'America/Mexico_City'),
      ...AGENT_CATEGORIES.map((category) => loadAgentMemories(category.id))
    ])
    const memoriesByCategory = Object.fromEntries(
      AGENT_CATEGORIES.map((category, index) => [category.id, memoryLists[index]])
    )

    const model = String(agentConfig?.model || DEFAULT_MODEL)
    const nowIso = new Date().toLocaleString('es-MX', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })
    const webSearchEnabled = [true, 1, '1', 'true'].includes(agentConfig?.web_search_enabled)

    const { triage, byCategory } = buildAgentGraph({
      agentConfig,
      memoriesByCategory,
      viewContext,
      timezone,
      nowIso,
      model,
      webSearchEnabled
    })

    const entryAgent = requestedCategory ? byCategory[requestedCategory.id] : triage
    const entryCategory = requestedCategory?.id || 'auto'

    await updateAgentRun(agentRun, {
      domain: entryCategory,
      action: 'specialized_chat',
      model,
      route: { engine: 'openai-agents-sdk', entry: entryAgent.name, requested: entryCategory, webSearchEnabled }
    })
    await recordAgentStep(agentRun, {
      stepType: 'route',
      status: 'completed',
      output: { engine: 'openai-agents-sdk', entry: entryAgent.name, requested: entryCategory, model, webSearchEnabled }
    })

    const runner = new Runner({
      modelProvider: new OpenAIProvider({ apiKey }),
      tracingDisabled: true
    })

    const result = await runner.run(entryAgent, buildInputItems(messages), {
      maxTurns: MAX_TURNS,
      context: { category: entryCategory, userId }
    })

    await recordToolSteps(agentRun, result.newItems || [])

    // El agente que terminó la conversación define la categoría final
    const lastAgentName = result.lastAgent?.name || entryAgent.name
    const finalCategory = byCategory[lastAgentName] ? lastAgentName : (requestedCategory?.id || 'general')

    const reply = String(result.finalOutput || '').trim() ||
      'No pude generar una respuesta. Intenta reformular tu mensaje.'
    const usage = aggregateUsage(result.rawResponses || [])
    const sources = extractSources(result.rawResponses || [])

    await recordAgentStep(agentRun, {
      stepType: 'final_response',
      status: 'completed',
      output: { reply: truncate(reply, 1600), model, finalCategory }
    })
    await updateAgentRun(agentRun, { domain: finalCategory })
    await completeAgentRun(agentRun, { status: 'completed', reply, model, usage })

    return {
      reply,
      model,
      category: finalCategory,
      sources,
      clarificationOptions: [],
      agentMemory: null,
      usage,
      trace: buildAgentTracePayload(agentRun, 'completed')
    }
  } catch (error) {
    logger.error(`Error en agente especializado (${categoryId}): ${error.message}`)
    await recordAgentStep(agentRun, {
      stepType: 'error',
      status: 'failed',
      error: error.message
    })
    await completeAgentRun(agentRun, { status: 'failed', error: error.message })
    error.agentTrace = buildAgentTracePayload(agentRun, 'failed')
    throw error
  }
}
