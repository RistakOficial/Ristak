import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getAgentReplyDeliveryPartDelayMs,
  mergeAdvancedClosingContext,
  normalizeAgentReplyDelivery,
  normalizeConversationalSuccessAction
} from '../src/services/conversationalAgentService.js'
import {
  buildReplyPartDelaySchedule,
  buildPendingReplyContextMessage,
  sendReplyParts,
  shouldRecoverPendingInbound,
  splitReplyIntoParts
} from '../src/agents/conversational/runner.js'
import {
  splitMessageIntoBubbles
} from '../src/agents/conversational/messageSplitter.js'
import {
  DEFAULT_CLOSING_STRATEGY,
  buildConversationalInstructions,
  renderClosingStrategyTemplate
} from '../src/agents/conversational/prompt.js'

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

test('normaliza acciones redundantes del agente a humano', () => {
  for (const action of ['book_appointment', 'ready_for_human', 'ready_to_buy', 'internal_signal', 'none', '', null]) {
    assert.equal(normalizeConversationalSuccessAction(action), 'ready_for_human')
  }
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
      splitter: async () => ({ messages: ['globo uno', 'globo dos', 'globo tres'], source: 'test', reason: 'ok' }),
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

test('estrategia de fabrica evita moldes repetitivos de venta', () => {
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /ah va/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /me da curiosidad/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /qué fue lo que/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /justo ahorita/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /qué te hizo escribirnos/i)
  assert.match(DEFAULT_CLOSING_STRATEGY, /VARIACIÓN HUMANA OBLIGATORIA/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /No repitas:/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /no son guiones para copiar literal/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /sin parecer que estás llenando un formulario/)
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
    advancedClosingContext
  })

  assert.match(instructions, /Eres un agente conversacional de Ristak/)
  assert.match(instructions, /dentro de una conversación por WhatsApp/)
  assert.match(instructions, /Parámetros internos de cierre avanzado/)
  assert.match(instructions, /Puntos aprendidos de esta conversación/)
  assert.match(instructions, /Problema real: sus conversaciones se enfrían/)
  assert.match(instructions, /update_closing_context/)
  assert.doesNotMatch(instructions, /\[NOMBRE_DEL_NEGOCIO\]/)
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
    advancedClosingContext
  })

  assert.match(customInstructions, /Mi estrategia custom con \[NOMBRE_DEL_NEGOCIO\]/)
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
