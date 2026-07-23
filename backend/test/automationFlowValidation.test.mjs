import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFlow,
  validateFlowForPublish,
  START_NODE_TYPE
} from '../src/services/automationFlowValidation.js'

function startNode(triggers = [{ id: 't1', type: 'trigger-contact-tag', config: {} }]) {
  return {
    id: 'start',
    type: START_NODE_TYPE,
    position: { x: 0, y: 0 },
    config: { triggers }
  }
}

function actionNode(id, type = 'channel-whatsapp') {
  return { id, type, position: { x: 100, y: 0 }, config: {} }
}

function edge(id, source, target, sourceHandle = 'out') {
  return { id, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: 'in' }
}

test('normalizeFlow devuelve un flujo vacío seguro cuando no hay datos', () => {
  const flow = normalizeFlow(null)
  assert.deepEqual(flow.nodes, [])
  assert.deepEqual(flow.edges, [])
  assert.equal(flow.viewport.zoom, 1)
})

test('normalizeFlow normaliza posiciones, handles y limita el zoom', () => {
  const flow = normalizeFlow({
    nodes: [{ id: 'a', type: 'x', position: { x: '10', y: null } }],
    edges: [{ id: 'e', sourceNodeId: 'a', targetNodeId: 'b' }],
    viewport: { x: 5, y: 5, zoom: 99 }
  })

  assert.deepEqual(flow.nodes[0].position, { x: 10, y: 0 })
  assert.equal(flow.edges[0].sourceHandle, 'out')
  assert.equal(flow.edges[0].targetHandle, 'in')
  assert.equal(flow.edges[0].animated, true)
  assert.equal(flow.viewport.zoom, 2.5)
})

test('normalizeFlow rechaza estructuras inválidas', () => {
  assert.throws(() => normalizeFlow('no soy un objeto'), /formato inválido/)
  assert.throws(
    () => normalizeFlow({ nodes: [{ type: '' }] }),
    /sin identificador o tipo/
  )
})

test('publicar requiere al menos un paso conectado al inicio', () => {
  const errors = validateFlowForPublish({ nodes: [startNode([])], edges: [] })
  assert.ok(errors.some((message) => message.includes('paso conectado')))
})

test('publicar acepta una secuencia sin disparadores si tiene pasos', () => {
  const flow = {
    nodes: [startNode([]), actionNode('a1')],
    edges: [edge('e1', 'start', 'a1')]
  }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar acepta un flujo lineal válido', () => {
  const flow = {
    nodes: [startNode(), actionNode('a1')],
    edges: [edge('e1', 'start', 'a1')]
  }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar acepta respuesta pública de Facebook con imagen', () => {
  const publicReply = {
    id: 'comment_public',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'facebook_public_comment',
      messageBlocks: [{ id: 'b1', type: 'image', url: 'https://example.com/image.jpg', caption: 'Gracias' }]
    }
  }
  const flow = {
    nodes: [
      startNode([
        { id: 't1', type: 'trigger-facebook-comment', config: { allowedComments: 'all' } }
      ]),
      publicReply
    ],
    edges: [edge('e1', 'start', 'comment_public')]
  }

  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar acepta mensaje privado por Instagram DM desde comentario de Instagram', () => {
  const privateReply = {
    id: 'comment_private',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'instagram_private_message',
      messageBlocks: [{ id: 'b1', type: 'text', compiledText: 'Te escribimos por privado' }]
    }
  }
  const flow = {
    nodes: [
      startNode([{ id: 't1', type: 'trigger-instagram-comment', config: { allowedComments: 'first_only' } }]),
      privateReply
    ],
    edges: [edge('e1', 'start', 'comment_private')]
  }

  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar rechaza una nota de voz en la respuesta privada inicial a un comentario', () => {
  const privateReply = {
    id: 'comment_voice_private',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'messenger_private_message',
      messageBlocks: [{ id: 'b1', type: 'voice', url: 'https://example.com/voice.ogg' }]
    }
  }
  const flow = {
    nodes: [
      startNode([{ id: 't1', type: 'trigger-facebook-comment', config: {} }]),
      privateReply
    ],
    edges: [edge('e1', 'start', 'comment_voice_private')]
  }

  assert.match(
    validateFlowForPublish(flow).join(' '),
    /respuesta privada inicial.*solo admite texto/i
  )
})

test('publicar rechaza respuesta de comentario que no coincide con la plataforma del disparador', () => {
  const reply = {
    id: 'comment_private',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'messenger_private_message',
      messageBlocks: [{ id: 'b1', type: 'text', compiledText: 'Te escribimos por privado' }]
    }
  }
  const flow = {
    nodes: [
      startNode([{ id: 't1', type: 'trigger-instagram-comment', config: {} }]),
      reply
    ],
    edges: [edge('e1', 'start', 'comment_private')]
  }

  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('no coincide')))
})

test('publicar rechaza adjuntos en comentario público de Instagram', () => {
  const reply = {
    id: 'comment_public',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'instagram_public_comment',
      messageBlocks: [{ id: 'b1', type: 'image', url: 'https://example.com/image.jpg' }]
    }
  }
  const flow = {
    nodes: [
      startNode([{ id: 't1', type: 'trigger-instagram-comment', config: {} }]),
      reply
    ],
    edges: [edge('e1', 'start', 'comment_public')]
  }

  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('Instagram no permite adjuntos')))
})

test('publicar rechaza private reply con varios mensajes iniciales', () => {
  const reply = {
    id: 'comment_private',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'messenger_private_message',
      messageBlocks: [
        { id: 'b1', type: 'text', compiledText: 'Primero' },
        { id: 'b2', type: 'text', compiledText: 'Segundo' }
      ]
    }
  }
  const flow = {
    nodes: [
      startNode([{ id: 't1', type: 'trigger-facebook-comment', config: {} }]),
      reply
    ],
    edges: [edge('e1', 'start', 'comment_private')]
  }

  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('un mensaje privado inicial')))
})

test('publicar exige muestra real para webhooks entrantes', () => {
  const flow = {
    nodes: [
      startNode([
        {
          id: 't1',
          type: 'trigger-incoming-webhook',
          config: { endpointId: 'hook_1', sampleResponse: {} }
        }
      ]),
      actionNode('a1')
    ],
    edges: [edge('e1', 'start', 'a1')]
  }

  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('webhook')))

  flow.nodes[0].config.triggers[0].config.sampleResponse = { contacto: { nombre: 'Ana' } }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar detecta conexiones rotas', () => {
  const flow = {
    nodes: [startNode()],
    edges: [edge('e1', 'start', 'fantasma')]
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('ya no existen')))
})

test('el aleatorizador debe sumar 100%', () => {
  const randomizer = {
    id: 'r1',
    type: 'randomizer',
    position: { x: 0, y: 0 },
    config: { branches: [{ id: 'a', percent: 60 }, { id: 'b', percent: 30 }] }
  }
  const flow = {
    nodes: [startNode(), randomizer],
    edges: [edge('e1', 'start', 'r1')]
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('100%')))

  randomizer.config.branches = [{ id: 'a', percent: 50 }, { id: 'b', percent: 50 }]
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar valida la configuración del goteo', () => {
  const drip = {
    id: 'drip1',
    type: 'logic-drip',
    position: { x: 0, y: 0 },
    config: { batchSize: 0, intervalAmount: 0, intervalUnit: 'seconds' }
  }
  const flow = {
    nodes: [startNode(), drip],
    edges: [edge('e1', 'start', 'drip1')]
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('tamaño de lote')))
  assert.ok(errors.some((message) => message.includes('intervalo')))
  assert.ok(errors.some((message) => message.includes('minutos, horas o días')))

  drip.config = { batchSize: 100, intervalAmount: 1, intervalUnit: 'minutes' }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar rechaza canales no soportados (SMS/Email)', () => {
  const smsNode = {
    id: 's1',
    type: 'channel-whatsapp',
    position: { x: 0, y: 0 },
    config: { channel: 'sms' }
  }
  const flow = {
    nodes: [startNode(), smsNode],
    edges: [edge('e1', 'start', 's1')]
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('Canales no soportados')))
  assert.ok(errors.some((message) => message.includes('sms')))

  smsNode.config = { channel: 'whatsapp' }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar acepta el canal "any" y canales permitidos en disparadores', () => {
  const flow = {
    nodes: [
      startNode([
        { id: 't1', type: 'trigger-customer-replied', config: { channel: 'any' } },
        { id: 't2', type: 'trigger-click-to-whatsapp', config: { channel: 'whatsapp' } },
        { id: 't3', type: 'trigger-whatsapp-message', config: { keywords: [] } },
        { id: 't4', type: 'trigger-instagram-message', config: { keywords: [] } },
        { id: 't5', type: 'trigger-messenger-message', config: { keywords: [] } },
        { id: 't6', type: 'trigger-email-message', config: { keywords: [] } }
      ]),
      actionNode('a1')
    ],
    edges: [edge('e1', 'start', 'a1')]
  }
  assert.deepEqual(validateFlowForPublish(flow), [])

  const badFlow = {
    nodes: [startNode([{ id: 't1', type: 'trigger-customer-replied', config: { channel: 'email' } }]), actionNode('a1')],
    edges: [edge('e1', 'start', 'a1')]
  }
  const errors = validateFlowForPublish(badFlow)
  assert.ok(errors.some((message) => message.includes('email')))
})

test('normalizeFlow preserva la configuración global del flujo', () => {
  const flow = normalizeFlow({
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { timezone: 'America/Mexico_City', allowReentry: true }
  })
  assert.equal(flow.settings.timezone, 'America/Mexico_City')
  assert.equal(flow.settings.allowReentry, true)

  const sinSettings = normalizeFlow({ nodes: [], edges: [] })
  assert.equal('settings' in sinSettings, false)
})

test('publicar limita a 10 ramas por nodo', () => {
  const hub = actionNode('hub')
  const targets = Array.from({ length: 11 }, (_, index) => actionNode(`t${index}`))
  const edges = [
    edge('e0', 'start', 'hub'),
    ...targets.map((target, index) => edge(`b${index}`, 'hub', target.id, `branch-${index}`))
  ]
  const flow = { nodes: [startNode(), hub, ...targets], edges }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('Máximo 10 ramas')))
})

test('publicar valida el horario global del flujo', () => {
  const flow = {
    nodes: [startNode()],
    edges: [],
    settings: {
      allowedSchedule: { enabled: true, daysOfWeek: [], startTime: '', endTime: '18:00' }
    }
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('al menos un día permitido')))
  assert.ok(errors.some((message) => message.includes('hora de inicio y fin')))

  flow.nodes.push(actionNode('a1'))
  flow.edges.push(edge('e1', 'start', 'a1'))
  flow.settings.allowedSchedule = {
    enabled: true,
    daysOfWeek: ['mon', 'tue'],
    startTime: '09:00',
    endTime: '18:00'
  }
  assert.deepEqual(validateFlowForPublish(flow), [])
})

test('publicar exige clic de disparo seleccionado en esperas por alias interno', () => {
  const waitNode = {
    id: 'wait1',
    type: 'logic-wait',
    position: { x: 100, y: 0 },
    config: { mode: 'action', expectedAction: 'trigger_link_click', actionResource: '' }
  }
  const flow = {
    nodes: [startNode(), waitNode],
    edges: [edge('e1', 'start', 'wait1')]
  }

  let errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('clic de disparo')))

  waitNode.config.actionResource = 'trigger_link_123'
  errors = validateFlowForPublish(flow)
  assert.deepEqual(errors, [])
})

test('publicar exige mensaje enviado anterior en esperas por respuesta a mensaje', () => {
  const messageNode = {
    id: 'msg1',
    type: 'channel-messenger',
    position: { x: 100, y: 0 },
    config: { messageBlocks: [{ id: 'b1', type: 'text', compiledText: 'Hola' }] }
  }
  const waitNode = {
    id: 'wait1',
    type: 'logic-wait',
    position: { x: 200, y: 0 },
    config: { mode: 'action', expectedAction: 'reply_message', actionResource: '' }
  }
  const flow = {
    nodes: [startNode(), messageNode, waitNode],
    edges: [edge('e1', 'start', 'msg1'), edge('e2', 'msg1', 'wait1')]
  }

  let errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('mensaje enviado anterior')))

  waitNode.config.actionResource = 'msg1'
  errors = validateFlowForPublish(flow)
  assert.deepEqual(errors, [])

  flow.edges = [edge('e1', 'start', 'wait1'), edge('e2', 'wait1', 'msg1')]
  errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('ya no está antes')))
})

test('publicar exige ventana de tiempo para el objetivo sin respuesta', () => {
  const goalNode = {
    id: 'goal-no-reply',
    type: 'logic-goal',
    position: { x: 100, y: 0 },
    config: {
      goalType: 'conversation',
      conversationEvent: 'no_reply',
      windowMode: 'none'
    }
  }
  const flow = {
    nodes: [startNode(), goalNode],
    edges: [edge('e1', 'start', 'goal-no-reply')]
  }

  let errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('necesita una ventana de tiempo')))

  goalNode.config.windowMode = 'duration'
  goalNode.config.windowAmount = 1
  goalNode.config.windowUnit = 'days'
  errors = validateFlowForPublish(flow)
  assert.deepEqual(errors, [])
})

test('Instagram bloquea documentos salientes antes de publicar el flujo', () => {
  const instagramNode = {
    id: 'ig1',
    type: 'channel-instagram',
    position: { x: 100, y: 0 },
    config: {
      messageBlocks: [{ id: 'file1', type: 'file', url: 'https://cdn.example.test/catalogo.pdf' }]
    }
  }
  const flow = {
    nodes: [startNode(), instagramNode],
    edges: [edge('e1', 'start', 'ig1')]
  }

  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('Instagram no permite documentos')))
})

test('publicar solo permite esperar respuesta de comentario cuando el comentario se respondió por privado', () => {
  const commentReply = {
    id: 'comment_reply',
    type: 'channel-comment-public-reply',
    position: { x: 100, y: 0 },
    config: {
      commentReplyTarget: 'facebook_public_comment',
      messageBlocks: [{ id: 'b1', type: 'text', compiledText: 'Gracias' }]
    }
  }
  const waitNode = {
    id: 'wait1',
    type: 'logic-wait',
    position: { x: 200, y: 0 },
    config: { mode: 'action', expectedAction: 'reply_message', actionResource: 'comment_reply' }
  }
  const flow = {
    nodes: [startNode([{ id: 't1', type: 'trigger-facebook-comment', config: {} }]), commentReply, waitNode],
    edges: [edge('e1', 'start', 'comment_reply'), edge('e2', 'comment_reply', 'wait1')]
  }

  let errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('mensaje enviado seleccionado')))

  commentReply.config.commentReplyTarget = 'messenger_private_message'
  errors = validateFlowForPublish(flow)
  assert.deepEqual(errors, [])
})

test('publicar detecta ciclos en el flujo', () => {
  const flow = {
    nodes: [startNode(), actionNode('a1'), actionNode('a2')],
    edges: [
      edge('e1', 'start', 'a1'),
      edge('e2', 'a1', 'a2'),
      edge('e3', 'a2', 'a1')
    ]
  }
  const errors = validateFlowForPublish(flow)
  assert.ok(errors.some((message) => message.includes('ciclo')))
})
