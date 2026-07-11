import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { buildInputItems } from '../src/agents/runner.js'
import { buildNativeConversationalInstructions } from '../src/agents/conversational/nativePrompt.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import {
  TOOL_CALLING_V2_HISTORY_BYTE_BUDGET,
  TOOL_CALLING_V2_MODEL_SETTINGS,
  buildToolCallingV2HistoryEnvelope,
  createToolCallingV2Agent,
  estimateToolCallingV2HistoryMessageBytes,
  ensureToolCallingV2VisibleReply,
  loadToolCallingV2ConversationEnvelope,
  runConversationalAgentPreview,
  runToolCallingV2Turn,
  sanitizeToolCallingV2Reply
} from '../src/agents/conversational/runner.js'

function conversationMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `mensaje ${index + 1}`
  }))
}

test('Agent v2 desactiva tool calls paralelas para serializar mutaciones', () => {
  const agent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: []
  })

  assert.equal(TOOL_CALLING_V2_MODEL_SETTINGS.parallelToolCalls, false)
  assert.equal(agent.modelSettings.parallelToolCalls, false)
})

test('v2 sólo expone mutaciones de capacidades activadas y nunca tools de silencio o descarte', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [{ id: 'schedule_appointment', enabled: true, calendarId: 'calendar-real' }]
  }
  const names = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: false,
    accountLocale: { currency: 'MXN' },
    actions: []
  }).map((candidate) => candidate.name)

  assert.ok(names.includes('get_free_slots'))
  assert.ok(names.includes('book_appointment'))
  for (const forbidden of [
    'create_payment_link',
    'send_goal_url',
    'send_to_human',
    'mark_ready_to_advance',
    'save_contact_data',
    'stay_silent',
    'discard_conversation',
    'update_closing_context'
  ]) {
    assert.equal(names.includes(forbidden), false, `no debe exponer ${forbidden}`)
  }
})

test('seguimiento v2 conserva sólo herramientas de lectura', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [
      { id: 'schedule_appointment', enabled: true, calendarId: 'calendar-real' },
      { id: 'collect_payment', enabled: true, productId: 'product-real', priceId: 'price-real' },
      { id: 'handoff_human', enabled: true }
    ]
  }
  const names = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: true,
    accountLocale: { currency: 'MXN' },
    actions: []
  }).map((candidate) => candidate.name)

  assert.deepEqual(names.sort(), ['get_business_profile', 'get_contact_profile', 'list_products'])
})

test('buildInputItems conserva el límite base y acepta completo el sobre nativo ya acotado por bytes', () => {
  const messages = conversationMessages(200)
  const base = buildInputItems(messages)
  const native = buildInputItems(messages, { preserveAll: true })

  assert.equal(base.length, 12)
  assert.equal(native.length, 200)
  assert.match(JSON.stringify(base[0]), /mensaje 189/)
  assert.match(JSON.stringify(native[0]), /mensaje 1/)
})

test('sobre v2 conserva completos 60 y 200 mensajes cortos cuando caben', () => {
  for (const count of [60, 200]) {
    const messages = conversationMessages(count)
    const envelope = buildToolCallingV2HistoryEnvelope(messages)
    assert.deepEqual(envelope.messages, messages)
    assert.equal(envelope.telemetry.totalMessages, count)
    assert.equal(envelope.telemetry.includedMessages, count)
    assert.equal(envelope.telemetry.omittedMessages, 0)
    assert.ok(envelope.telemetry.includedBytes <= TOOL_CALLING_V2_HISTORY_BYTE_BUDGET)
    assert.equal(envelope.loadOlderPage, null)
  }
})

test('sobre v2 nunca corta el último mensaje y pagina los anteriores por bytes', async () => {
  const latest = `ULTIMO-INTEGRO-${'á'.repeat(3000)}`
  const messages = [
    { role: 'user', content: 'primero' },
    { role: 'assistant', content: 'segundo' },
    { role: 'user', content: latest }
  ]
  const latestBytes = estimateToolCallingV2HistoryMessageBytes(messages[2])
  const envelope = buildToolCallingV2HistoryEnvelope(messages, { byteBudget: latestBytes - 1 })

  assert.equal(envelope.messages.length, 1)
  assert.equal(envelope.messages[0].content, latest)
  assert.equal(envelope.messages[0].content.length, latest.length)
  assert.equal(envelope.telemetry.omittedMessages, 2)
  assert.equal(envelope.telemetry.overBudget, true)

  const page = await envelope.loadOlderPage({ mode: 'previous', cursor: null, offset: null, query: null, limit: 2 })
  assert.deepEqual(page.messages.map((message) => message.text), ['primero', 'segundo'])
  assert.equal(page.hasMore, false)
})

test('sobre v2 reserva bytes para medios remotos antes de hidratarlos', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `mensaje con adjunto ${index + 1}`,
    message_type: 'image',
    media_url: `https://media.example/${index + 1}`,
    media_filename: `imagen-${index + 1}.png`,
    media_mime_type: 'image/png'
  }))
  const envelope = buildToolCallingV2HistoryEnvelope(messages)

  assert.ok(envelope.telemetry.includedMessages <= 4)
  assert.ok(envelope.telemetry.omittedMessages >= 96)
  assert.equal(envelope.messages.at(-1).content, 'mensaje con adjunto 100')
  assert.ok(envelope.telemetry.includedBytes <= TOOL_CALLING_V2_HISTORY_BYTE_BUDGET)
  assert.equal(typeof envelope.loadOlderPage, 'function')
})

test('cursor previous avanza por mensajes devueltos sin repetir ni saltar al recortar por bytes', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `cursor-${index + 1}-${'x'.repeat(7000)}`
  }))
  const envelope = buildToolCallingV2HistoryEnvelope(messages, { byteBudget: 8000 })
  assert.equal(envelope.telemetry.includedMessages, 1)

  let cursor = null
  const seen = []
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const page = await envelope.loadOlderPage({
      mode: 'previous',
      cursor,
      offset: null,
      query: null,
      limit: 30
    })
    assert.ok(page.returnedMessages >= 1 && page.returnedMessages <= 2)
    const pageTexts = page.messages.map((message) => message.text)
    assert.equal(new Set(pageTexts).size, pageTexts.length)
    assert.ok(pageTexts.every((text) => !seen.includes(text)))
    seen.push(...pageTexts)
    const expectedPosition = 1 + seen.length
    assert.equal(page.nextCursor, `previous:${expectedPosition}`)
    cursor = page.nextCursor
  }
  assert.equal(new Set(seen).size, seen.length)
})

test('hilo de 2000 mensajes permite oldest, salto aleatorio y búsqueda literal en pocas llamadas', async () => {
  const messages = Array.from({ length: 2000 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `hilo-${index + 1}-${'z'.repeat(220)}`,
    id: `internal-${index + 1}`,
    raw_payload_json: '{"private":true}'
  }))
  messages[5].content += ' aguja-compartida'
  messages[1999].content += ' aguja-compartida'
  messages[986].content += ' aguja-987'
  const envelope = buildToolCallingV2HistoryEnvelope(messages)
  assert.ok(envelope.telemetry.omittedMessages > 1500)

  const oldest = await envelope.loadOlderPage({
    mode: 'oldest', cursor: null, offset: null, query: null, limit: 3
  })
  assert.deepEqual(oldest.messages.map((message) => message.text.slice(0, 6)), ['hilo-1', 'hilo-2', 'hilo-3'])

  const jumped = await envelope.loadOlderPage({
    mode: 'offset', cursor: null, offset: 1000, query: null, limit: 2
  })
  assert.match(jumped.messages[0].text, /^hilo-1001-/)
  assert.equal(jumped.nextCursor, 'offset:1002')

  const found = await envelope.loadOlderPage({
    mode: 'search', cursor: null, offset: null, query: 'aguja-987', limit: 5
  })
  assert.equal(found.returnedMessages, 1)
  assert.match(found.messages[0].text, /aguja-987/)

  const omittedOnly = await envelope.loadOlderPage({
    mode: 'search', cursor: null, offset: null, query: 'aguja-compartida', limit: 5
  })
  assert.equal(omittedOnly.returnedMessages, 1)
  assert.match(omittedOnly.messages[0].text, /^hilo-6-/)
  assert.doesNotMatch(JSON.stringify([oldest, jumped, found, omittedOnly]), /internal-|raw_payload|private/)
})

test('carga viva pagina desde DB, queda ligada a contacto+canal y la tool no expone IDs ni payloads', async () => {
  const allMessages = conversationMessages(60).map((message, index) => ({
    ...message,
    id: `internal-${index + 1}`,
    raw_payload_json: '{"secret":"never"}',
    messageTimestamp: `2026-07-10T00:${String(index).padStart(2, '0')}:00.000Z`,
    ...(index === 55
      ? {
          message_type: 'image',
          media_url: 'https://secret.example/internal-file-token',
          media_filename: 'foto-cliente.png',
          media_mime_type: 'image/png'
        }
      : {})
  }))
  const calls = []
  const searchCalls = []
  const loadRows = async (contactId, channel, { limit, offset }) => {
    calls.push({ contactId, channel, limit, offset })
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    const endExclusive = Math.max(0, allMessages.length - offset)
    const start = Math.max(0, endExclusive - limit)
    return allMessages.slice(start, endExclusive)
  }
  const countRows = async (contactId, channel) => {
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    return allMessages.length
  }
  const searchRows = async (contactId, channel, { query, limit, offset, beforeMessage }) => {
    searchCalls.push({ contactId, channel, query, limit, offset, beforeMessage })
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    assert.equal(beforeMessage.content, 'mensaje 58')
    const matches = allMessages.slice(0, 57)
      .filter((message) => message.content.toLowerCase().includes(String(query).toLowerCase()))
    const endExclusive = Math.max(0, matches.length - offset)
    const start = Math.max(0, endExclusive - limit)
    return matches.slice(start, endExclusive)
  }

  const complete = await loadToolCallingV2ConversationEnvelope({
    contactId: 'contacto-servidor',
    channel: 'sms',
    pageSize: 7
  }, { loadRows, countRows })
  assert.equal(complete.telemetry.includedMessages, 60)
  assert.equal(complete.telemetry.omittedMessages, 0)
  assert.ok(complete.telemetry.pagesLoaded > 1)
  assert.deepEqual(complete.messages.map((message) => message.content), allMessages.map((message) => message.content))

  calls.length = 0
  const threeMessageBudget = allMessages.slice(-3)
    .reduce((sum, message) => sum + estimateToolCallingV2HistoryMessageBytes(message), 0)
  const bounded = await loadToolCallingV2ConversationEnvelope({
    contactId: 'contacto-servidor',
    channel: 'sms',
    byteBudget: threeMessageBudget,
    pageSize: 7
  }, { loadRows, countRows, searchRows })
  assert.equal(bounded.telemetry.includedMessages, 3)
  assert.equal(bounded.telemetry.omittedMessages, 57)

  const capabilitiesConfig = { schemaVersion: 1, items: [] }
  const historyTool = createConversationalTools({
    contactId: 'contacto-servidor',
    channel: 'sms',
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    historyContext: { telemetry: bounded.telemetry },
    loadConversationHistoryPage: bounded.loadOlderPage,
    followUpMode: false,
    accountLocale: { currency: 'MXN' },
    actions: []
  }).find((candidate) => candidate.name === 'get_conversation_history')

  assert.ok(historyTool)
  assert.equal(historyTool.strict, true)
  assert.deepEqual(Object.keys(historyTool.parameters.properties).sort(), ['cursor', 'limit', 'mode', 'offset', 'query'])
  assert.equal(historyTool.parameters.additionalProperties, false)
  assert.deepEqual([...historyTool.parameters.required].sort(), ['cursor', 'limit', 'mode', 'offset', 'query'])
  const older = await historyTool.invoke(null, JSON.stringify({ mode: 'previous', cursor: null, offset: null, query: null, limit: 3 }))
  assert.equal(older.ok, true)
  const olderWithMedia = await historyTool.invoke(null, JSON.stringify({ mode: 'previous', cursor: older.nextCursor, offset: null, query: null, limit: 3 }))
  assert.ok(olderWithMedia.messages.some((message) => message.attachmentSummary?.includes('Adjunto: imagen')))
  assert.doesNotMatch(JSON.stringify(olderWithMedia), /foto-cliente\.png/)
  const searched = await historyTool.invoke(null, JSON.stringify({ mode: 'search', cursor: null, offset: null, query: 'mensaje 11', limit: 3 }))
  assert.equal(searched.returnedMessages, 1)
  assert.equal(searched.messages[0].text, 'mensaje 11')
  const visiblePayload = JSON.stringify([older, olderWithMedia, searched])
  assert.doesNotMatch(visiblePayload, /internal-|raw_payload|never|secret\.example/)
  assert.ok(calls.every((call) => call.contactId === 'contacto-servidor' && call.channel === 'sms'))
  assert.ok(searchCalls.every((call) => call.contactId === 'contacto-servidor' && call.channel === 'sms'))
})

test('búsqueda SQL real sólo consulta el tramo omitido del contacto y canal ligados', async () => {
  const contactId = `history_search_${randomUUID()}`
  const otherContactId = `history_search_other_${randomUUID()}`
  const insertedContacts = [contactId, otherContactId]
  try {
    for (let index = 0; index < 40; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 6, 10, 12, 0, index)).toISOString()
      const marker = index === 5 || index === 39 ? ' clave%_literal' : ''
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, contact_id, direction, message_type, message_text, transport, message_timestamp, created_at
        ) VALUES (?, ?, ?, 'text', ?, 'sms', ?, ?)
      `, [
        `${contactId}_${String(index).padStart(3, '0')}`,
        contactId,
        index % 2 ? 'outbound' : 'inbound',
        `sql-${index + 1}-${'x'.repeat(1000)}${marker}`,
        timestamp,
        timestamp
      ])
    }
    const otherTimestamp = new Date(Date.UTC(2026, 6, 10, 11, 0, 0)).toISOString()
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, direction, message_type, message_text, transport, message_timestamp, created_at
      ) VALUES (?, ?, 'inbound', 'text', ?, 'sms', ?, ?)
    `, [`${otherContactId}_001`, otherContactId, 'otro contacto clave%_literal', otherTimestamp, otherTimestamp])

    const envelope = await loadToolCallingV2ConversationEnvelope({
      contactId,
      channel: 'sms',
      byteBudget: 2500,
      pageSize: 7
    })
    assert.ok(envelope.telemetry.omittedMessages > 30)
    const found = await envelope.loadOlderPage({
      mode: 'search', cursor: null, offset: null, query: 'clave%_literal', limit: 10
    })
    assert.equal(found.returnedMessages, 1)
    assert.match(found.messages[0].text, /^sql-6-/)
    assert.doesNotMatch(found.messages[0].text, /sql-40-/)
    assert.doesNotMatch(JSON.stringify(found), new RegExp(otherContactId))

    const oldest = await envelope.loadOlderPage({
      mode: 'oldest', cursor: null, offset: null, query: null, limit: 2
    })
    assert.match(oldest.messages[0].text, /^sql-1-/)
    assert.match(oldest.messages[1].text, /^sql-2-/)
  } finally {
    for (const id of insertedContacts) {
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [id])
    }
  }
})

test('prompt nativo separa estrategia, personalidad, contexto real y capacidades blindadas sin recortar', () => {
  const strategyText = `${'Capacitación extensa del negocio.\n'.repeat(700)}MARCADOR_FINAL_PROMPT`
  const instructions = buildNativeConversationalInstructions({
    promptConfig: {
      strategyText,
      personalityText: 'Habla como Ana y responde con mucha calma.'
    },
    capabilityManifest: [
      {
        id: 'schedule_appointment',
        label: 'Agendar cita',
        enabled: true,
        ready: true,
        locked: true,
        summary: 'Calendario Consulta general',
        missingConfiguration: []
      }
    ],
    businessContext: 'La consulta dura 45 minutos.',
    businessName: 'Clínica Norte',
    timezone: 'America/Mexico_City',
    nowIso: '10 de julio de 2026, 4:00 p.m.',
    channel: 'WhatsApp'
  })

  assert.ok(strategyText.length > 16_000)
  assert.match(instructions, /Estrategia y capacitación del agente/)
  assert.match(instructions, /MARCADOR_FINAL_PROMPT/)
  assert.match(instructions, /Personalidad del agente/)
  assert.match(instructions, /Habla como Ana y responde con mucha calma/)
  assert.match(instructions, /La consulta dura 45 minutos/)
  assert.match(instructions, /Zona blindada del sistema · no editable/)
  assert.match(instructions, /Agendar cita/)
  assert.match(instructions, /nunca puede crear, ocultar, eliminar ni ampliar capacidades/i)
  assert.match(instructions, /Nunca afirmes que una cita, cobro, enlace, transferencia o meta quedó lista/i)
})

test('prompt v2 expresa seguimientos en la zona blindada sin fabricar mensajes del cliente', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: 'Habla con calidez.' },
    followUpContext: { index: 2, strategy: 'Pregunta si desea revisar otra hora.' }
  })

  assert.match(instructions, /Modo de esta vuelta/)
  assert.match(instructions, /seguimiento programado numero 2/i)
  assert.match(instructions, /Pregunta si desea revisar otra hora/)
  assert.doesNotMatch(instructions, /\[Contexto interno de Ristak:/)
})

test('prompt v2 ordena consultar el historial omitido sin inventar una sub-IA', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: 'Habla con calma.' },
    historyContext: { includedMessages: 18, omittedMessages: 42, includedBytes: 12000 }
  })

  assert.match(instructions, /42 mensajes anteriores de este mismo hilo/i)
  assert.match(instructions, /consulta get_conversation_history/i)
  assert.match(instructions, /Usa search con una frase o dato concreto/i)
  assert.match(instructions, /oldest para revisar el inicio/i)
  assert.match(instructions, /offset para saltar/i)
  assert.match(instructions, /no inventes ni resumas por tu cuenta/i)
  assert.doesNotMatch(instructions, /assessment|planner|subagente|sub-IA/i)
})

test('prompt v2 respeta que el dueño deje vacía la zona editable', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: '' },
    businessContext: 'Atendemos de lunes a viernes.'
  })

  assert.match(instructions, /Sin estrategia o capacitación adicional/)
  assert.match(instructions, /Sin personalidad específica configurada/)
  assert.doesNotMatch(instructions, /Responde de forma clara, útil, cálida y breve/)
  assert.match(instructions, /contexto real del negocio como datos de referencia/i)
})

test('prompt v2 incluye criterios útiles de capacidades sin exponer identificadores internos', () => {
  const instructions = buildNativeConversationalInstructions({
    capabilityManifest: [
      { id: 'collect_payment', label: 'Cobrar', enabled: true, missingConfiguration: [] },
      { id: 'handoff_human', label: 'Pasar a un humano', enabled: true, missingConfiguration: [] },
      { id: 'custom_goal', label: 'Objetivo propio', enabled: true, missingConfiguration: [] }
    ],
    capabilitiesConfig: {
      items: [
        {
          id: 'collect_payment',
          paymentMode: 'deposit',
          productId: 'internal-product-id',
          priceId: 'internal-price-id',
          deposit: {
            enabled: true,
            mode: 'fixed',
            amount: 500,
            currency: 'MXN',
            methods: { bankTransfer: true },
            bankTransferDetails: 'Banco de prueba, cuenta terminación 1234'
          }
        },
        { id: 'handoff_human', rules: 'Transfiere cuando la persona pida un especialista.', pastClientsToHuman: true },
        { id: 'custom_goal', description: 'Confirmar que desea una demostración.' }
      ]
    }
  })

  assert.match(instructions, /anticipo configurado de 500 MXN/i)
  assert.match(instructions, /Banco de prueba, cuenta terminación 1234/)
  assert.match(instructions, /Transfiere cuando la persona pida un especialista/)
  assert.match(instructions, /pastClientEvidence\.isPastClient/)
  assert.doesNotMatch(instructions, /customerEvidence/)
  assert.match(instructions, /Confirmar que desea una demostración/)
  assert.doesNotMatch(instructions, /internal-product-id|internal-price-id/)
})

test('runtime v2 ejecuta sólo el agente principal con el transcript real y nunca devuelve silencio', async () => {
  const messages = conversationMessages(200)
  let mainRuns = 0
  let receivedMessages = null
  const ctx = { actions: [] }

  const result = await runToolCallingV2Turn({
    config: { runtimeMode: 'tool_calling_v2' },
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    channel: 'whatsapp'
  }, {
    buildAgentForRun: async () => ({
      agent: { name: 'fake' },
      ctx,
      model: 'fake-model',
      aiProvider: 'openai',
      capabilityManifest: [],
      validationErrors: [],
      knowledge: { context: '' }
    }),
    runInChannel: async (_channel, callback) => callback(),
    executeAgent: async (input) => {
      mainRuns += 1
      receivedMessages = input.messages
      assert.equal(input.runtimeMode, 'tool_calling_v2')
      assert.equal(input.preserveAllMessages, true)
      assert.equal(input.historyTelemetry.includedMessages, 200)
      assert.equal(input.historyTelemetry.omittedMessages, 0)
      input.runTelemetry.modelCallCount = 2
      return ''
    }
  })

  assert.equal(mainRuns, 1)
  assert.deepEqual(receivedMessages, messages)
  assert.equal(receivedMessages.some((message) => String(message.content).startsWith('[Contexto interno de Ristak:')), false)
  assert.equal(result.modelCallCount, 2)
  assert.equal(result.historyTelemetry.includedMessages, 200)
  assert.equal(result.historyTelemetry.omittedMessages, 0)
  assert.equal(result.runtimeMode, 'tool_calling_v2')
  assert.ok(result.reply.length > 0)
})

test('sobre e historial manual v2 son idénticos en OpenAI, Gemini, Claude y DeepSeek', async () => {
  const messages = conversationMessages(60)
  for (const provider of ['openai', 'gemini', 'claude', 'deepseek']) {
    let mainRuns = 0
    const result = await runToolCallingV2Turn({
      config: { runtimeMode: 'tool_calling_v2', aiProvider: provider },
      runtime: { modelProvider: { provider } },
      messages,
      channel: 'sms'
    }, {
      buildAgentForRun: async ({ historyContext }) => ({
        agent: { name: `fake-${provider}` },
        ctx: { actions: [], historyContext },
        model: `fake-${provider}`,
        aiProvider: provider,
        capabilityManifest: [],
        validationErrors: [],
        knowledge: { context: '' }
      }),
      runInChannel: async (_channel, callback) => callback(),
      executeAgent: async (input) => {
        mainRuns += 1
        assert.deepEqual(input.messages, messages)
        assert.equal(input.preserveAllMessages, true)
        assert.equal(input.historyTelemetry.includedMessages, 60)
        return `respuesta ${provider}`
      }
    })

    assert.equal(mainRuns, 1)
    assert.equal(result.reply, `respuesta ${provider}`)
    assert.equal(result.historyTelemetry.omittedMessages, 0)
  }
})

test('seguimiento v2 usa la misma llamada principal y conserva el transcript sin mensajes sintéticos', async () => {
  const messages = conversationMessages(8)
  let mainRuns = 0
  let receivedFollowUpContext = null

  const result = await runToolCallingV2Turn({
    config: { runtimeMode: 'tool_calling_v2' },
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    channel: 'whatsapp',
    followUpContext: { index: 1, strategy: 'Retoma la propuesta.' }
  }, {
    buildAgentForRun: async (input) => {
      receivedFollowUpContext = input.followUpContext
      return {
        agent: { name: 'fake' },
        ctx: { actions: [], followUpMode: true },
        model: 'fake-model',
        aiProvider: 'openai',
        capabilityManifest: [],
        validationErrors: [],
        knowledge: { context: '' }
      }
    },
    runInChannel: async (_channel, callback) => callback(),
    executeAgent: async (input) => {
      mainRuns += 1
      assert.deepEqual(input.messages, messages)
      assert.equal(input.preserveAllMessages, true)
      assert.equal(input.messages.some((message) => String(message.content).includes('Contexto interno')), false)
      return '¿quieres que revisemos otra opción?'
    }
  })

  assert.equal(mainRuns, 1)
  assert.deepEqual(receivedFollowUpContext, { index: 1, strategy: 'Retoma la propuesta.' })
  assert.equal(result.reply, '¿quieres que revisemos otra opción?')
  assert.equal(result.modelCallCount, 1)
})

test('fallback visible v2 sólo afirma éxito cuando la acción quedó confirmada', () => {
  assert.match(
    ensureToolCallingV2VisibleReply('', [{ type: 'book_appointment', outcome: { status: 'ok', ok: true } }]),
    /cita quedó confirmada/i
  )
  assert.doesNotMatch(
    ensureToolCallingV2VisibleReply('', [{ type: 'book_appointment', outcome: { status: 'error', ok: false } }]),
    /quedó confirmada/i
  )
  assert.match(
    ensureToolCallingV2VisibleReply('', [{
      type: 'send_goal_url',
      outcome: { status: 'ok', sentUrl: 'https://example.com/continuar?goal=real' }
    }]),
    /https:\/\/example\.com\/continuar\?goal=real/
  )
})

test('respuesta v2 agrega enlaces confirmados aunque el modelo los omita y no los duplica', () => {
  const paymentUrl = 'https://pay.example.com/invoice/real-123'
  const goalUrl = 'https://example.com/continuar?goal=real'
  const paymentAction = [{
    type: 'create_payment_link',
    outcome: { status: 'ok', ok: true, paymentLink: paymentUrl }
  }]
  const goalAction = [{
    type: 'send_goal_url',
    outcome: { status: 'ok', ok: true, sentUrl: goalUrl }
  }]

  const paymentReply = ensureToolCallingV2VisibleReply('Perfecto, ya lo preparé.', paymentAction)
  assert.match(paymentReply, /enlace de pago:/i)
  assert.match(paymentReply, /https:\/\/pay\.example\.com\/invoice\/real-123/)

  const alreadyVisible = ensureToolCallingV2VisibleReply(`Aquí está: ${paymentUrl}`, paymentAction)
  assert.equal(alreadyVisible.split(paymentUrl).length - 1, 1)

  const goalReply = ensureToolCallingV2VisibleReply('Te lo mando enseguida.', goalAction)
  assert.match(goalReply, /enlace para continuar:/i)
  assert.match(goalReply, /https:\/\/example\.com\/continuar\?goal=real/)
})

test('sanitizador v2 conserva lenguaje natural y URLs de agenda sin filtrar intención', () => {
  assert.equal(
    sanitizeToolCallingV2Reply('Te puedo agendar aquí: https://example.com/agendar'),
    'Te puedo agendar aquí: https://example.com/agendar'
  )
  assert.equal(
    sanitizeToolCallingV2Reply('Ejecuté book_appointment. Tu cita quedó lista.'),
    'Ejecuté la acción solicitada. Tu cita quedó lista.'
  )

  const toolNames = [
    'get_free_slots',
    'get_business_profile',
    'list_products',
    'get_contact_profile',
    'get_conversation_history',
    'save_contact_data',
    'update_closing_context',
    'register_deposit_payment_proof',
    'book_appointment',
    'create_payment_link',
    'send_goal_url',
    'send_trigger_link',
    'send_to_human',
    'mark_ready_to_advance'
  ]
  const sanitized = sanitizeToolCallingV2Reply(`Interno: ${toolNames.join(', ')}`)
  for (const toolName of toolNames) {
    assert.doesNotMatch(sanitized, new RegExp(toolName, 'i'))
  }
})

test('preview v2 comparte el sobre por bytes, conserva 60 mensajes cortos y nunca se marca suprimido', async () => {
  const messages = conversationMessages(60)
  let hydratedCount = 0
  let nativeRuns = 0
  const config = {
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }

  const result = await runConversationalAgentPreview({ messages }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (input) => {
      hydratedCount = input.length
      return input
    },
    runNativeTurn: async ({ messages: input, historyEnvelope }) => {
      nativeRuns += 1
      assert.equal(input.length, 60)
      assert.equal(historyEnvelope.telemetry.source, 'preview')
      assert.equal(historyEnvelope.telemetry.includedMessages, 60)
      assert.equal(historyEnvelope.telemetry.omittedMessages, 0)
      assert.equal(historyEnvelope.loadOlderPage, null)
      return {
        reply: 'respuesta visible',
        ctx: { actions: [] },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1,
        historyTelemetry: historyEnvelope.telemetry,
        capabilityManifest: [],
        validationErrors: []
      }
    }
  })

  assert.equal(hydratedCount, 60)
  assert.equal(nativeRuns, 1)
  assert.equal(result.reply, 'respuesta visible')
  assert.deepEqual(result.replyParts, ['respuesta visible'])
  assert.equal(result.suppressed, false)
  assert.equal(result.modelCallCount, 1)
  assert.equal(result.historyTelemetry.includedMessages, 60)
  assert.equal(result.historyTelemetry.omittedMessages, 0)
  assert.deepEqual(result.validationErrors, [])
})

test('preview v2 pagina sólo sus mensajes omitidos dentro de la misma ejecución principal', async () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `preview-${index + 1}-${'x'.repeat(4000)}`
  }))
  messages[3].content += ' preview-needle'
  const config = {
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }
  let mainRuns = 0

  const result = await runConversationalAgentPreview({ messages }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (input) => input,
    runNativeTurn: async ({ messages: input, historyEnvelope }) => {
      mainRuns += 1
      assert.ok(historyEnvelope.telemetry.omittedMessages > 0)
      assert.equal(typeof historyEnvelope.loadOlderPage, 'function')
      const page = await historyEnvelope.loadOlderPage({ mode: 'previous', cursor: null, offset: null, query: null, limit: 2 })
      const oldest = await historyEnvelope.loadOlderPage({ mode: 'oldest', cursor: null, offset: null, query: null, limit: 1 })
      const searched = await historyEnvelope.loadOlderPage({ mode: 'search', cursor: null, offset: null, query: 'preview-needle', limit: 2 })
      const includedTexts = new Set(input.map((message) => message.content))
      assert.ok(page.messages.length > 0)
      assert.ok(page.messages.every((message) => !includedTexts.has(message.text)))
      assert.match(oldest.messages[0].text, /^preview-1-/)
      assert.equal(searched.returnedMessages, 1)
      assert.match(searched.messages[0].text, /preview-needle/)
      return {
        reply: 'preview con historial',
        ctx: { actions: [] },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1,
        historyTelemetry: historyEnvelope.telemetry,
        capabilityManifest: [],
        validationErrors: []
      }
    }
  })

  assert.equal(mainRuns, 1)
  assert.equal(result.reply, 'preview con historial')
  assert.ok(result.historyTelemetry.omittedMessages > 0)
})
