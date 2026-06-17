import test from 'node:test'
import assert from 'node:assert/strict'

import { CHEAPEST_OPENAI_MODEL } from '../src/config/openAIModels.js'
import { APPOINTMENT_CONFIRMATION_MODEL } from '../src/agents/appointmentConfirmationAgent.js'
import {
  buildConversationalAgentMetrics,
  getAgentReplyDeliveryPartDelayMs,
  mergeAdvancedClosingContext,
  normalizeAgentReplyDelivery,
  normalizeConversationalSuccessAction,
  shouldMigrateLegacyConversationalAgentConfig
} from '../src/services/conversationalAgentService.js'
import {
  buildReplyPartDelaySchedule,
  buildPendingReplyContextMessage,
  sendReplyParts,
  shouldRecoverPendingInbound,
  splitReplyIntoParts
} from '../src/agents/conversational/runner.js'
import {
  MESSAGE_SPLITTER_MODEL,
  splitMessageIntoBubbles,
  splitMessageIntoBubblesFallback
} from '../src/agents/conversational/messageSplitter.js'
import {
  DEFAULT_CLOSING_STRATEGY,
  buildBusinessAdaptiveClosingSection,
  buildClosingStrategyTemplateParameters,
  buildConversationalInstructions,
  renderClosingStrategyTemplate
} from '../src/agents/conversational/prompt.js'
import {
  buildBusinessProfilePromptParameters,
  normalizeBusinessProfileExtraction
} from '../src/services/aiAgentService.js'

test('flujos IA automaticos de bajo costo usan siempre el modelo mas barato aprobado', () => {
  assert.equal(CHEAPEST_OPENAI_MODEL, 'gpt-5.4-nano')
  assert.equal(MESSAGE_SPLITTER_MODEL, CHEAPEST_OPENAI_MODEL)
  assert.equal(APPOINTMENT_CONFIRMATION_MODEL, CHEAPEST_OPENAI_MODEL)
})

test('normaliza la entrega de respuestas en partes', () => {
  const delivery = normalizeAgentReplyDelivery({
    mode: 'split',
    maxBubbleLength: 40,
    minDelaySeconds: 12,
    maxDelaySeconds: 3,
    maxBubbles: 20
  })

  assert.equal(delivery.mode, 'split')
  assert.equal(delivery.splitMessagesEnabled, true)
  assert.equal(delivery.maxBubbleLength, 80)
  assert.equal(delivery.maxBubbles, 10)
  assert.equal(delivery.minDelaySeconds, 3)
  assert.equal(delivery.maxDelaySeconds, 12)
})

test('normaliza acciones del agente conversacional', () => {
  assert.equal(normalizeConversationalSuccessAction('book_appointment'), 'book_appointment')
  assert.equal(normalizeConversationalSuccessAction('ready_to_buy'), 'ready_to_buy')
  assert.equal(normalizeConversationalSuccessAction('ready_for_human'), 'ready_for_human')
  for (const action of ['internal_signal', 'none', '', null]) {
    assert.equal(normalizeConversationalSuccessAction(action), 'ready_for_human')
  }
})

test('no migra una configuración legacy vacía como agente predeterminado', () => {
  assert.equal(shouldMigrateLegacyConversationalAgentConfig({
    enabled: 1,
    model: 'gpt-5.4-mini',
    objective: 'citas',
    success_action: 'ready_for_human',
    allow_emojis: 0,
    hide_attended: 0,
    hide_attended_notifications: 0
  }), false)

  assert.equal(shouldMigrateLegacyConversationalAgentConfig({
    objective: 'ventas',
    extra_instructions: 'Pregunta presupuesto antes de pasar al equipo.'
  }), true)
})

test('calcula métricas del agente conversacional por estado y errores', () => {
  const metrics = buildConversationalAgentMetrics({
    agents: [
      { id: 'agent_1', name: 'Ventas', enabled: true, model: 'gpt-5.4-mini' },
      { id: 'agent_2', name: 'Soporte', enabled: false, model: 'gpt-5.4-mini' }
    ],
    stateRows: [
      { agent_id: 'agent_1', status: 'active', signal: null, updated_at: '2026-06-13T10:00:00Z' },
      { agent_id: 'agent_1', status: 'completed', signal: 'ready_for_human', updated_at: '2026-06-13T10:05:00Z' },
      { agent_id: 'agent_2', status: 'discarded', signal: 'discarded', updated_at: '2026-06-13T10:10:00Z' },
      { agent_id: 'agent_2', status: 'human', signal: null, updated_at: '2026-06-13T10:15:00Z' }
    ],
    eventSummary: {
      total_events: 8,
      success_events: 1,
      assigned_events: 2,
      reply_events: 3,
      error_events: 1
    }
  })

  assert.equal(metrics.totalAgents, 2)
  assert.equal(metrics.activeAgents, 1)
  assert.equal(metrics.assignedConversations, 1)
  assert.equal(metrics.agentsWithAssignedConversations, 1)
  assert.equal(metrics.completedConversations, 1)
  assert.equal(metrics.discardedConversations, 1)
  assert.equal(metrics.humanTakeovers, 1)
  assert.equal(metrics.errorEvents, 1)
  assert.equal(metrics.successRate, 33)
  assert.equal(metrics.byAgent.find((agent) => agent.agentId === 'agent_1')?.completedConversations, 1)
})

test('calcula una pausa entre partes dentro del rango configurado', () => {
  const delayMs = getAgentReplyDeliveryPartDelayMs({
    replyDelivery: {
      mode: 'split',
      maxBubbleLength: 180,
      delayBetweenBubblesEnabled: true,
      minDelaySeconds: 2,
      maxDelaySeconds: 2
    }
  })

  assert.equal(delayMs, 2000)
})

test('crea calendario de pausas dejando el primer globo inmediato', () => {
  const schedule = buildReplyPartDelaySchedule(['uno', 'dos', 'tres'], {
    replyDelivery: {
      mode: 'split',
      delayBetweenBubblesEnabled: true,
      minDelaySeconds: 2,
      maxDelaySeconds: 2
    }
  })

  assert.deepEqual(schedule, [0, 2000, 2000])
})

test('envio real espera antes de cada globo posterior', async () => {
  const sequence = []
  let splitterArgs = null
  const result = await sendReplyParts({
    contactId: 'contacto-test',
    phone: '+526561111111',
    latest: {
      id: 'mensaje-inicial',
      phone: '+526561111111',
      business_phone: '+526562222222',
      business_phone_number_id: 'phone-row-test'
    },
    agentConfig: {
      id: 'agente-test',
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 2
      }
    },
    reply: 'respuesta original',
    apiKey: 'sk-test',
    model: 'test-model',
    dependencies: {
      splitter: async (args) => {
        splitterArgs = args
        return { messages: ['globo uno', 'globo dos', 'globo tres'], source: 'test', reason: 'ok' }
      },
      sendTextMessage: async ({ text }) => {
        sequence.push(`send:${text}`)
      },
      wait: async (delayMs) => {
        sequence.push(`wait:${delayMs}`)
      },
      loadNewerInbound: async () => null,
      recordEvent: async () => {},
      markReplyComplete: async () => {
        sequence.push('complete')
      }
    }
  })

  assert.equal(splitterArgs?.model, undefined)
  assert.equal(splitterArgs?.apiKey, 'sk-test')
  assert.deepEqual(result.delaySchedule, [0, 2000, 2000])
  assert.deepEqual(sequence, [
    'send:globo uno',
    'wait:2000',
    'send:globo dos',
    'wait:2000',
    'send:globo tres',
    'complete'
  ])
})

test('mantiene una sola respuesta cuando la entrega está en modo normal', () => {
  const parts = splitReplyIntoParts('hola, te explico rápido. este mensaje podría dividirse, pero no debe.', {
    mode: 'single',
    maxBubbleLength: 120,
    minDelaySeconds: 1,
    maxDelaySeconds: 3
  })

  assert.deepEqual(parts, ['hola, te explico rápido. este mensaje podría dividirse, pero no debe.'])
})

test('parte respuestas largas respetando el máximo de segmentos', () => {
  const longReply = [
    'va, ya te entendí. Lo primero es ubicar qué necesitas resolver ahorita y qué tan urgente se volvió para ti.',
    'También necesito saber si ya intentaste algo antes, porque eso cambia bastante la recomendación.',
    'Con esa información puedo decirte cuál sería el siguiente paso sin inventarte cosas ni darte vueltas.'
  ].join(' ')

  const parts = splitReplyIntoParts(longReply, {
    mode: 'split',
    minMessageLengthToSplit: 1,
    maxBubbleLength: 120,
    maxBubbles: 6,
    minDelaySeconds: 1,
    maxDelaySeconds: 3
  })

  assert.ok(parts.length > 1)
  assert.ok(parts.length <= 6)
  assert.ok(parts.every((part) => part.trim().length > 0))
  assert.equal(parts.join(' '), longReply)
})

test('switch apagado envia una sola respuesta aunque el texto sea largo', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'Este mensaje es suficientemente largo para partirse, pero el modo esta apagado y debe salir completo.',
    settings: { mode: 'single', splitMessagesEnabled: false, maxBubbleLength: 80 },
    aiSplitter: async () => ({ messages: ['no deberia usarse'] })
  })

  assert.equal(result.source, 'disabled')
  assert.deepEqual(result.messages, ['Este mensaje es suficientemente largo para partirse, pero el modo esta apagado y debe salir completo.'])
})

test('mensaje corto se queda en un solo globo', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'Ok, listo.',
    settings: { mode: 'split', minMessageLengthToSplit: 120, minBubbleLength: 20 },
    aiSplitter: async () => ({ messages: ['Ok', 'listo.'] }),
    random: () => 0.99
  })

  assert.equal(result.source, 'threshold')
  assert.deepEqual(result.messages, ['Ok, listo.'])
})

test('modo humano no fuerza globos cuando la respuesta corta es una sola idea', () => {
  const result = splitMessageIntoBubblesFallback({
    text: 'sí, mañana a las 5 está perfecto',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 20, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0
  })

  assert.deepEqual(result.messages, ['sí, mañana a las 5 está perfecto'])
})

test('modo humano usa fallback natural cuando no hay splitter IA disponible', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ah ya te entendí… ¿pero cómo está eso exactamente?',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0.8
  })

  assert.equal(result.source, 'fallback')
  assert.deepEqual(result.messages, ['ah ya te entendí…', '¿pero cómo está eso exactamente?'])
})

test('modo humano acepta BREAK como separador pero no lo expone al contacto', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => 'ok perfecto [BREAK] ahora dime qué fecha te queda mejor'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
})

test('modo humano separa BREAK aunque venga dentro de JSON válido', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => '{"messages":["ok perfecto [BREAK] ahora dime qué fecha te queda mejor"]}'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
})

test('modo humano repara globos con reacción, salto y pregunta en el mismo mensaje', async () => {
  const original = 'ya.. entonces sí traes ese tema encima\n\npa entenderte bien y no decirte algo al aire, hoy cómo te llegan los pacientes?'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 240, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: [original] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [
    'ya..',
    'entonces sí traes ese tema encima',
    'pa entenderte bien y no decirte algo al aire',
    'hoy cómo te llegan los pacientes?'
  ])
})

test('modo humano fallback separa reaccion lectura puente y pregunta final', () => {
  const original = 'ya.. entonces sí traes ese tema encima\npa entenderte bien y no decirte algo al aire, hoy cómo te llegan los pacientes?'
  const result = splitMessageIntoBubblesFallback({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 240, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.deepEqual(result.messages, [
    'ya..',
    'entonces sí traes ese tema encima',
    'pa entenderte bien y no decirte algo al aire',
    'hoy cómo te llegan los pacientes?'
  ])
})

test('modo humano deja una reaccion con coma como globo propio', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'claro, de qué te gustaría saber?',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: ['claro, de qué te gustaría saber?'] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['claro,', 'de qué te gustaría saber?'])
})

test('modo humano no deja una frase dependiente sola antes de una pregunta', async () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: ['depende de lo que necesites.', 'tú eres médico o lo ves para alguien más?'] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [original])
})

test('modo humano fallback no corta depende de lo que necesitas antes del contexto', () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = splitMessageIntoBubblesFallback({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.deepEqual(result.messages, [original])
})

test('modo humano puede llegar hasta seis globos sólo cuando el texto largo lo amerita', () => {
  const longReply = [
    'va, ya te entendí.',
    'Primero revisamos qué estás intentando resolver ahorita.',
    'Luego vemos qué ya probaste antes para no repetir lo mismo.',
    'Después ubicamos qué dato real falta para darte una respuesta clara.',
    'Con eso te digo cuál sería el siguiente paso sin inventarte nada.',
    'Y si sí hace sentido, lo pasamos a revisión con alguien del equipo.'
  ].join(' ')

  const result = splitMessageIntoBubblesFallback({
    text: longReply,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.ok(result.messages.length > 4)
  assert.ok(result.messages.length <= 6)
  assert.equal(result.messages.join(' '), longReply)
})

test('mensaje casual se divide en globos humanos con IA', async () => {
  const original = 'Sí bro, ya puedes poner esa publicidad. Lo ideal sería que primero subas unos videos mostrando el servicio. Después activamos la campaña y vamos midiendo qué personas escriben para ajustar el anuncio. No te preocupes, yo te voy diciendo paso a paso qué hacer.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 5, minBubbleLength: 20, maxBubbleLength: 140 },
    aiSplitter: async () => ({
      messages: [
        'Sí bro, ya puedes poner esa publicidad.',
        'Lo ideal sería que primero subas unos videos mostrando el servicio.',
        'Después activamos la campaña y vamos midiendo qué personas escriben para ajustar el anuncio.',
        'No te preocupes, yo te voy diciendo paso a paso qué hacer.'
      ]
    })
  })

  assert.equal(result.source, 'ai')
  assert.equal(result.messages.length, 4)
  assert.equal(result.messages[0], 'Sí bro, ya puedes poner esa publicidad.')
})

test('mensaje largo respeta el máximo de globos', async () => {
  const original = [
    'Primero revisamos el objetivo de la campaña para que no se gaste presupuesto en mensajes que no sirven.',
    'Luego validamos que el anuncio tenga una oferta clara y que el primer mensaje de WhatsApp conteste rápido.',
    'Después medimos qué contactos avanzan, cuáles preguntan precio y cuáles necesitan seguimiento manual.',
    'Con esa información ajustamos el texto, el público y el presupuesto sin cambiar todo a ciegas.',
    'Al final te digo qué decisión tomar y qué parte conviene escalar.'
  ].join(' ')

  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 3, minBubbleLength: 20, maxBubbleLength: 140 },
    aiSplitter: async () => ({
      messages: original.split('. ').map((part) => (part.endsWith('.') ? part : `${part}.`))
    })
  })

  assert.equal(result.messages.length, 3)
  assert.ok(result.messages.every((message) => message.trim()))
})

test('no rompe URLs al dividir', async () => {
  const original = 'Claro, entra a https://ristak.com/demo?source=whatsapp para revisar la demo. Después dime si quieres que la conectemos con tu campaña actual.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 20, maxBubbleLength: 90 },
    aiSplitter: async () => ({
      messages: [
        'Claro, entra a https://ristak.com/demo?source=whatsapp para revisar la demo.',
        'Después dime si quieres que la conectemos con tu campaña actual.'
      ]
    })
  })

  assert.ok(result.messages.some((message) => message.includes('https://ristak.com/demo?source=whatsapp')))
})

test('no rompe teléfono ni precio al dividir', async () => {
  const original = 'Perfecto, el anticipo sería de $1,500 MXN y el teléfono para confirmar es +52 656 123 4567. Ya con eso apartamos tu lugar.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 20, maxBubbleLength: 90 },
    aiSplitter: async () => ({
      messages: [
        'Perfecto, el anticipo sería de $1,500 MXN y el teléfono para confirmar es +52 656 123 4567.',
        'Ya con eso apartamos tu lugar.'
      ]
    })
  })

  assert.ok(result.messages.some((message) => message.includes('$1,500 MXN')))
  assert.ok(result.messages.some((message) => message.includes('+52 656 123 4567')))
})

test('conserva pasos enumerados en orden', async () => {
  const original = '1. Manda el video. 2. Confirmamos el presupuesto. 3. Activamos la campaña. 4. Revisamos resultados mañana.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 10, maxBubbleLength: 80 },
    aiSplitter: async () => ({
      messages: [
        '1. Manda el video.',
        '2. Confirmamos el presupuesto.',
        '3. Activamos la campaña.',
        '4. Revisamos resultados mañana.'
      ]
    })
  })

  assert.deepEqual(result.messages.map((message) => message.match(/^\d/)?.[0]), ['1', '2', '3', '4'])
})

test('falla de JSON de la IA usa fallback con el texto original', async () => {
  const original = 'Esta respuesta debe quedarse completa si el divisor devuelve basura.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 5 },
    aiSplitter: async () => 'no soy json'
  })

  assert.equal(result.source, 'fallback')
  assert.deepEqual(result.messages, [original])
})

test('pausas entre globos se pueden apagar', () => {
  const delayMs = getAgentReplyDeliveryPartDelayMs({
    replyDelivery: {
      mode: 'split',
      delayBetweenBubblesEnabled: false,
      minDelaySeconds: 2,
      maxDelaySeconds: 7
    }
  })

  assert.equal(delayMs, 0)
})

test('mensaje formal conserva tono formal', async () => {
  const original = 'Con gusto. Para poder avanzar, necesitamos confirmar la fecha de la cita y el servicio requerido. En cuanto me comparta esos datos, le indico la disponibilidad.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 3, minBubbleLength: 20, maxBubbleLength: 120 },
    aiSplitter: async () => ({
      messages: [
        'Con gusto. Para poder avanzar, necesitamos confirmar la fecha de la cita y el servicio requerido.',
        'En cuanto me comparta esos datos, le indico la disponibilidad.'
      ]
    })
  })

  assert.equal(result.messages.length, 2)
  assert.match(result.messages.join(' '), /Con gusto/)
  assert.match(result.messages.join(' '), /le indico/)
})

test('construye contexto interno con mensajes pendientes sin exponerlo al cliente', () => {
  const context = buildPendingReplyContextMessage([
    { id: 'm1', message_text: 'hola, quiero info', message_type: 'text' },
    { id: 'm2', message_text: 'también cuánto cuesta?', message_type: 'text' }
  ])

  assert.equal(context.role, 'user')
  assert.match(context.content, /\[Contexto interno de Ristak:/)
  assert.match(context.content, /Responde considerando TODOS/)
  assert.match(context.content, /1\. hola, quiero info/)
  assert.match(context.content, /2\. también cuánto cuesta\?/)
})

test('rellena parametros de la estrategia de cierre de fabrica', () => {
  const rendered = renderClosingStrategyTemplate(
    'Agente de [NOMBRE_DEL_NEGOCIO] por [CANAL_DE_CONVERSACION]; problema: [PROBLEMA_REAL]; avance: [HERRAMIENTA_INTERNA_DE_AVANCE]',
    {
      NOMBRE_DEL_NEGOCIO: 'Clínica Norte',
      CANAL_DE_CONVERSACION: 'WhatsApp',
      PROBLEMA_REAL: 'dolor que ya afecta su rutina',
      HERRAMIENTA_INTERNA_DE_AVANCE: 'mark_ready_to_advance'
    }
  )

  assert.equal(rendered, 'Agente de Clínica Norte por WhatsApp; problema: dolor que ya afecta su rutina; avance: mark_ready_to_advance')
})

test('convierte el perfil estructurado del negocio en parametros del prompt', () => {
  const extraction = normalizeBusinessProfileExtraction({
    sameBusinessWithPrevious: true,
    profile: {
      businessName: 'Clínica Norte',
      industry: 'clínica dental',
      businessType: 'service',
      description: 'Atiende limpiezas, ortodoncia e implantes en Ciudad Juárez.',
      offerings: [
        { name: 'Limpieza dental', cadence: 'cada 6 meses', price: '$700 MXN' },
        { name: 'Ortodoncia', description: 'tratamiento mensual', price: 'desde $1,200 MXN al mes' }
      ],
      locations: [
        { address: 'Av. Tecnológico 123', city: 'Ciudad Juárez', postalCode: '32500' }
      ],
      hours: { summary: 'Lunes a viernes de 9 a 6' },
      payments: { transfer: 'sí', invoice: 'sí da factura' },
      contacts: { mainPhone: '656 111 2222', extension: '103' }
    }
  }, {
    businessContext: 'Clínica dental en Ciudad Juárez.'
  })

  assert.equal(extraction.profile.businessName, 'Clínica Norte')
  assert.equal(extraction.promptParameters.NOMBRE_DEL_NEGOCIO, 'Clínica Norte')
  assert.equal(extraction.promptParameters.INDUSTRIA, 'clínica dental')
  assert.match(extraction.promptParameters.PRODUCTO_O_SERVICIO, /Limpieza dental/)
  assert.match(extraction.promptParameters.VALOR, /\$700 MXN/)
  assert.match(extraction.promptParameters.UBICACION_O_MODALIDAD, /Ciudad Juárez/)
  assert.match(extraction.promptParameters.DISPONIBILIDAD, /Lunes a viernes/)
  assert.match(extraction.promptParameters.CONDICIONES_IMPORTANTES, /factura/)
  assert.match(extraction.promptParameters.ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO, /clínica dental/)
  assert.match(extraction.promptParameters.RIESGO_VERBAL_A_EVITAR, /compra ya/)

  const rendered = renderClosingStrategyTemplate(
    '[NOMBRE_DEL_NEGOCIO] · [INDUSTRIA] · [PRODUCTO_O_SERVICIO] · [UBICACION_O_MODALIDAD]',
    extraction.promptParameters
  )
  assert.match(rendered, /Clínica Norte · clínica dental/)
  assert.doesNotMatch(rendered, /\[INDUSTRIA\]/)
})

test('parametriza el cierre de fabrica sin transformar el guion general', () => {
  const parameters = buildBusinessProfilePromptParameters({
    businessName: 'Growth Médico',
    industry: 'marketing para médicos especialistas',
    businessType: 'service',
    description: 'Ayuda a médicos a convertir conversaciones de redes en pacientes agendados sin sonar invasivos.',
    offerings: [
      { name: 'sistema de captación de pacientes', description: 'anuncios, WhatsApp y seguimiento para clínicas', price: 'desde $12,000 MXN mensuales' }
    ],
    targetCustomers: 'médicos con agenda irregular que reciben mensajes pero no suficientes citas reales',
    differentiators: 'acompaña al médico con estrategia, anuncios y seguimiento conversacional',
    conversationAdaptation: {
      narrativeFrame: 'No vendas marketing; guía al médico a revisar si depender de recomendaciones y mensajes sueltos está frenando su agenda.',
      customerPerception: 'Debe sentirse como una revisión profesional de su captación de pacientes, no como una compra impulsiva.',
      languageGuidance: 'Habla de pacientes, agenda, consultas, seguimiento y claridad del sistema.',
      contrastFrame: 'Contrasta seguir con conversaciones que no llegan a cita contra ordenar el sistema para que los interesados correctos avancen.',
      discoveryAngles: ['qué pasa con los mensajes que llegan', 'cuántas consultas reales se pierden', 'qué cambió para revisar esto ahora'],
      safeValueLanguage: 'Habla de revisar si tiene sentido y de ver una ruta clara.',
      forbiddenSalesLanguage: 'Evita compra, oferta, invierte hoy y pago hasta que el médico pida avanzar.'
    }
  })

  const section = buildBusinessAdaptiveClosingSection({
    enabled: true,
    parameters
  })

  assert.match(section, /Parámetros del negocio para el guión de fábrica/)
  assert.match(section, /Growth Médico/)
  assert.match(section, /marketing para médicos especialistas/)
  assert.match(section, /No vendas marketing/)
  assert.match(section, /pacientes, agenda, consultas/)
  assert.match(section, /no reescribe, resume, reemplaza ni transforma el guión de fábrica/)
  assert.match(section, /El guión de fábrica manda completo/)
  assert.match(section, /No pongas a la persona en modo comprador/)
  assert.doesNotMatch(section, /Adaptación conversacional al negocio/)
  assert.doesNotMatch(section, /Adapta todo el diálogo/)
  assert.doesNotMatch(section, /manda sobre los ejemplos genéricos/)
})

test('los parametros del perfil no acortan ni cambian la estrategia de fabrica', () => {
  const profileParameters = buildBusinessProfilePromptParameters({
    businessName: 'Academia Sol',
    industry: 'escuela de idiomas',
    offerings: [{ name: 'clases de inglés para adultos', price: '$1,500 MXN mensuales' }],
    locations: [{ modality: 'online y presencial en Chihuahua' }]
  })
  const parameters = buildClosingStrategyTemplateParameters({
    profileParameters,
    config: { objective: 'citas', successAction: 'ready_for_human' },
    channelLabel: 'WhatsApp',
    businessName: 'Academia Sol',
    industry: 'escuela de idiomas',
    offering: 'clases de inglés para adultos',
    personType: 'prospecto',
    accountLocale: { countryCode: 'CO', currency: 'COP', dialCode: '57' }
  })
  const rendered = renderClosingStrategyTemplate(DEFAULT_CLOSING_STRATEGY, parameters, { replaceMissing: true })

  assert.match(rendered, /Academia Sol/)
  assert.match(rendered, /escuela de idiomas/)
  assert.match(rendered, /clases de inglés para adultos/)
  assert.match(rendered, /Cuenta configurada en Colombia \(CO\)/)
  assert.match(rendered, /español colombiano/)
  assert.match(rendered, /listo/)
  assert.match(rendered, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.match(rendered, /Escribes como una persona real tecleando por WhatsApp/)
  assert.match(rendered, /CÓMO PIENSAS ANTES DE CADA MENSAJE/)
  assert.match(rendered, /CONTEXTO PROFUNDO/)
  assert.match(rendered, /PROHIBICIÓN MÁXIMA/)
  assert.match(rendered, /mark_ready_to_advance/)
  assert.match(rendered, /NOMBRE_DEL_NEGOCIO: Academia Sol/)
  assert.match(rendered, /INDUSTRIA: escuela de idiomas/)
  assert.match(rendered, /PRODUCTO_O_SERVICIO: clases de inglés para adultos/)
  assert.match(rendered, /\[regresa\]/)
  assert.doesNotMatch(rendered, /dato pendiente de configurar/)
  assert.doesNotMatch(rendered, /\[(?:ESCRIBIR[^\]]*|NOMBRE_DEL_NEGOCIO|INDUSTRIA|PRODUCTO_O_SERVICIO|CANAL_DE_CONVERSACION|HERRAMIENTA_INTERNA_DE_AVANCE|HERRAMIENTA_INTERNA_DE_DESCARTE)\]/)
  assert.ok(rendered.length > 15000)
})

test('estrategia de fabrica conserva reglas anti-molde y anti-asuncion', () => {
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /me da curiosidad/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /justo ahorita/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /qué te hizo escribirnos/i)
  assert.match(DEFAULT_CLOSING_STRATEGY, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /PROHIBICIÓN MÁXIMA: NO COPIES/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Todos los ejemplos de este prompt son FILOSOFÍA, no libreto/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /CÓMO PIENSAS ANTES DE CADA MENSAJE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /CÓMO ESCRIBES \(textura humana real\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Refleja LIMPIO, en sus palabras/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /No jales hacia lo que vendes/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /PROHIBIDO diagnosticar con TUS categorías/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Reacciones y emoción \(escribe con sentimiento\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /La emoción no es decoración/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /LA BIBLIA DEL PRIMER CONTACTO Y LAS PREGUNTAS VAGAS/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Diagnosticar, jalar a tu solución y reflejar mamado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /tu primera respuesta NO informa. DEVUELVE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /ante un mensaje vago de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /EJEMPLOS = FILOSOFÍA \(NO LIBRETO\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NO ASUMAS el perfil de la persona/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /JAMÁS signos de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 6 — Asumir el perfil/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 7 — Loop de rebotes \+ signos de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NO te quedes en LOOP rebotando/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Varía el justificante/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Manejo del precio/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NUNCA suenes evasivo/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Humor y buena experiencia/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Cuidado quirúrgico con el lenguaje/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 8 — Lenguaje tieso/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /DESCARTE Y SILENCIO/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Cuándo NO te quedes callado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /El PRIMER regreso es el más delicado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /dosis EXTRA de ligereza/)
})

test('agrega memoria interna de cierre solo cuando usa estrategia de fabrica', () => {
  const baseConfig = {
    objective: 'ventas',
    customObjective: '',
    successAction: 'ready_for_human',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    allowEmojis: false,
    closingStrategyMode: 'system',
    closingStrategyCustom: ''
  }
  const advancedClosingContext = {
    enabled: true,
    parameters: {
      NOMBRE_DEL_NEGOCIO: 'Ristak',
      CANAL_DE_CONVERSACION: 'WhatsApp',
      PRODUCTO_O_SERVICIO: 'automatización de mensajes',
      OBJETIVO_FINAL: 'hablar con un humano',
      HERRAMIENTA_INTERNA_DE_AVANCE: 'mark_ready_to_advance',
      HERRAMIENTA_INTERNA_DE_DESCARTE: 'discard_conversation'
    },
    systemFacts: ['Canal detectado: WhatsApp', 'Etiqueta: prospecto'],
    learned: {
      contactReason: 'pierde leads por responder tarde',
      realProblem: 'sus conversaciones se enfrían antes de que el equipo conteste',
      desiredOutcome: 'responder más rápido sin contratar otra persona'
    },
    missingFields: ['whyNow', 'consequenceIfNoAction']
  }

  const instructions = buildConversationalInstructions({
    config: baseConfig,
    businessContext: 'Software para operación comercial.',
    brandVoice: '',
    businessName: 'Ristak',
    timezone: 'America/Mexico_City',
    nowIso: 'sábado, 13 de junio de 2026, 10:00',
    contactName: 'Juan',
    advancedClosingContext,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /Eres el asistente conversacional de Ristak/)
  assert.match(instructions, /conversación de WhatsApp/)
  assert.match(instructions, /Parámetros internos de cierre avanzado/)
  assert.match(instructions, /Puntos aprendidos de esta conversación/)
  assert.match(instructions, /Problema real: sus conversaciones se enfrían/)
  assert.match(instructions, /update_closing_context/)
  assert.match(instructions, /Parámetros del negocio para el guión de fábrica/)
  assert.match(instructions, /El guión de fábrica manda completo/)
  assert.match(instructions, /No pongas a la persona en modo comprador/)
  assert.match(instructions, /Cultura textual regional/)
  assert.match(instructions, /Cuenta configurada en México/)
  assert.match(instructions, /GAD/)
  assert.match(instructions, /Espejo y rapport/)
  assert.doesNotMatch(instructions, /\[NOMBRE_DEL_NEGOCIO\]/)
  assert.match(instructions, /\[regresa\]/)
  assert.match(instructions, /\[siguiente paso\]/)
  assert.doesNotMatch(instructions, /\[(?:ESCRIBIR[^\]]*|NOMBRE_DEL_NEGOCIO|INDUSTRIA|PRODUCTO_O_SERVICIO|CANAL_DE_CONVERSACION|HERRAMIENTA_INTERNA_DE_AVANCE|HERRAMIENTA_INTERNA_DE_DESCARTE)\]/)
  assert.match(instructions, /No uses el mismo molde dos veces seguidas/)
  assert.match(instructions, /precisión concreta, reflejo breve, respuesta puntual o siguiente paso/)

  const customInstructions = buildConversationalInstructions({
    config: {
      ...baseConfig,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Mi estrategia custom con [NOMBRE_DEL_NEGOCIO]'
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Ristak',
    timezone: 'America/Mexico_City',
    nowIso: 'sábado, 13 de junio de 2026, 10:00',
    contactName: null,
    advancedClosingContext,
    accountLocale: { countryCode: 'ES', currency: 'EUR', dialCode: '34' }
  })

  assert.match(customInstructions, /Mi estrategia custom con \[NOMBRE_DEL_NEGOCIO\]/)
  assert.match(customInstructions, /Cuenta configurada en España/)
  assert.match(customInstructions, /vale/)
  assert.doesNotMatch(customInstructions, /Lenguaje natural, cercano, mexicano/)
  assert.doesNotMatch(customInstructions, /Parámetros del negocio para el guión de fábrica/)
  assert.doesNotMatch(customInstructions, /Adaptación conversacional al negocio/)
  assert.doesNotMatch(customInstructions, /Parametros internos de cierre avanzado/)
})

test('memoria de cierre avanzado solo acepta parametros del contrato', () => {
  const result = mergeAdvancedClosingContext(
    { contactReason: 'quiere saber precios' },
    {
      whyNow: 'tiene una fecha encima',
      urgencyLevel: 'alta',
      campoInventado: 'no debe guardarse'
    },
    { updatedBy: 'agent', nowIso: '2026-06-13T10:00:00.000Z' }
  )

  assert.deepEqual(result.changedKeys.sort(), ['urgencyLevel', 'whyNow'])
  assert.equal(result.context.contactReason, 'quiere saber precios')
  assert.equal(result.context.whyNow, 'tiene una fecha encima')
  assert.equal(result.context.urgencyLevel, 'alta')
  assert.equal(result.context.campoInventado, undefined)
  assert.equal(result.context.updatedBy, 'agent')
})

test('recupera solo mensajes entrantes recientes que no fueron contestados', () => {
  const nowMs = Date.parse('2026-06-13T01:20:00Z')
  const latest = {
    id: 'inbound-reciente',
    message_timestamp: '2026-06-13 01:15:00',
    created_at: '2026-06-13 01:15:00'
  }

  assert.equal(shouldRecoverPendingInbound(latest, { status: 'active' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), true)
  assert.equal(shouldRecoverPendingInbound(latest, { status: 'paused' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    lastAnsweredInboundMessageId: 'inbound-reciente'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    lastReplyAt: '2026-06-13 01:16:00'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound({
    ...latest,
    id: 'inbound-viejo',
    message_timestamp: '2026-06-12 23:00:00'
  }, { status: 'active' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
})
