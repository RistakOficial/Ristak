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

function actionNode(id, type = 'action-send-message') {
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

test('publicar requiere al menos un disparador', () => {
  const errors = validateFlowForPublish({ nodes: [startNode([])], edges: [] })
  assert.ok(errors.some((message) => message.includes('disparador')))
})

test('publicar acepta un flujo lineal válido', () => {
  const flow = {
    nodes: [startNode(), actionNode('a1')],
    edges: [edge('e1', 'start', 'a1')]
  }
  assert.deepEqual(validateFlowForPublish(flow), [])
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
        { id: 't2', type: 'trigger-click-to-whatsapp', config: { channel: 'whatsapp' } }
      ])
    ],
    edges: []
  }
  assert.deepEqual(validateFlowForPublish(flow), [])

  const badFlow = {
    nodes: [startNode([{ id: 't1', type: 'trigger-customer-replied', config: { channel: 'email' } }])],
    edges: []
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

  flow.settings.allowedSchedule = {
    enabled: true,
    daysOfWeek: ['mon', 'tue'],
    startTime: '09:00',
    endTime: '18:00'
  }
  assert.deepEqual(validateFlowForPublish(flow), [])
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
