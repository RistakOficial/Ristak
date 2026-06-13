import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentReplyDelivery
} from '../src/services/conversationalAgentService.js'
import {
  buildPendingReplyContextMessage,
  shouldRecoverPendingInbound,
  splitReplyIntoParts
} from '../src/agents/conversational/runner.js'

test('normaliza la entrega de respuestas en partes', () => {
  const delivery = normalizeAgentReplyDelivery({
    mode: 'split',
    targetChars: 40,
    minDelaySeconds: 12,
    maxDelaySeconds: 3
  })

  assert.equal(delivery.mode, 'split')
  assert.equal(delivery.targetChars, 120)
  assert.equal(delivery.minDelaySeconds, 3)
  assert.equal(delivery.maxDelaySeconds, 12)
})

test('calcula una pausa entre partes dentro del rango configurado', () => {
  const delayMs = getAgentReplyDeliveryPartDelayMs({
    replyDelivery: {
      mode: 'split',
      targetChars: 180,
      minDelaySeconds: 2,
      maxDelaySeconds: 2
    }
  })

  assert.equal(delayMs, 2000)
})

test('mantiene una sola respuesta cuando la entrega está en modo normal', () => {
  const parts = splitReplyIntoParts('hola, te explico rápido. este mensaje podría dividirse, pero no debe.', {
    mode: 'single',
    targetChars: 120,
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
    targetChars: 120,
    minDelaySeconds: 1,
    maxDelaySeconds: 3
  })

  assert.ok(parts.length > 1)
  assert.ok(parts.length <= 6)
  assert.ok(parts.every((part) => part.trim().length > 0))
  assert.equal(parts.join(' '), longReply)
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
