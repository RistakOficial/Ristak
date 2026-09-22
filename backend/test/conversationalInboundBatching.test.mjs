import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONVERSATIONAL_INBOUND_QUIET_WINDOW_MS,
  createToolCallingV2Agent,
  loadPendingInboundMessages,
  loadToolCallingV2ConversationEnvelope,
  queueManuallyActivatedConversation,
  sendCurrentConversationalReply,
  sendReplyParts,
  toolCallingV2HasCommittedEffect,
  waitForConversationalResponseWindow
} from '../src/agents/conversational/runner.js'
import {
  assertCurrentConversationalTurn,
  currentConversationalTurnSignal,
  interruptSupersededConversationalTurn,
  rememberConversationalTurnContext,
  withCurrentConversationalTurn
} from '../src/agents/conversational/turnFreshness.js'

const start = Date.parse('2026-09-22T18:00:00.000Z')
const inbound = (id, ms) => ({ id, role: 'user', message_type: 'text', content: id, created_at: new Date(start + ms).toISOString() })
const quietWindow = CONVERSATIONAL_INBOUND_QUIET_WINDOW_MS

test('tres mensajes reinician el minuto completo desde la última recepción y persisten el vencimiento', async () => {
  let clock = start
  const arrivals = [inbound('pregunta', 0), inbound('aclaración', 40_000), inbound('último dato', 95_000)]
  const waits = []
  const deadlines = []
  const result = await waitForConversationalResponseWindow({
    contactId: 'batch', latest: arrivals[0], delayMs: quietWindow,
    now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms },
    loadLatest: async () => arrivals.filter(message => Date.parse(message.created_at) <= clock).at(-1),
    recordEvent: async () => {},
    onDeadline: async (message, deadline) => deadlines.push([message.id, Date.parse(deadline) - start])
  })
  assert.equal(quietWindow, 60_000)
  assert.deepEqual(waits, [60_000, 40_000, 55_000])
  assert.deepEqual(deadlines, [['pregunta', 60_000], ['aclaración', 100_000], ['último dato', 155_000]])
  assert.equal(result.latest.id, 'último dato')
  assert.equal(clock - Date.parse(result.latest.created_at), 60_000)
})

test('recuperación tras reinicio conserva el tiempo transcurrido y no usa el reloj del remitente', async () => {
  let clock = start + 80_000
  const message = { ...inbound('persistido', 55_000), message_timestamp: new Date(start - 600_000).toISOString() }
  const waits = []
  await waitForConversationalResponseWindow({ latest: message, delayMs: quietWindow, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms }, loadLatest: async () => message, recordEvent: async () => {} })
  assert.deepEqual(waits, [35_000])
  assert.equal(clock, start + 115_000)
})

test('una ráfaga mayor de 100 mensajes conserva todo lo pendiente desde el último contestado', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => inbound(`message_${i}`, i * 1000))
  const pending = await loadPendingInboundMessages('long_batch', { lastAnsweredInboundMessageId: 'message_2' }, 'messenger', rows.at(-1), {
    loadRows: async (_contact, _channel, { limit, offset, throughMessage }) => {
      assert.equal(throughMessage.id, 'message_204')
      return rows.slice(Math.max(0, rows.length - offset - limit), rows.length - offset)
    }
  })
  assert.equal(pending.length, 202)
  assert.equal(pending[0].id, 'message_3')
  assert.equal(pending.at(-1).id, 'message_204')
})

test('sin respuesta previa del bot usa el historial humano como contexto y sólo contesta el tramo pendiente', async () => {
  const rows = [inbound('pregunta antigua', 0), { id: 'human', role: 'assistant', content: 'Tu asesor ya explicó el servicio.' }, inbound('pregunta nueva', 2000), inbound('aclaración nueva', 3000)]
  const loadRows = async (_contact, _channel, { limit, offset = 0 }) => rows.slice(Math.max(0, rows.length - offset - limit), rows.length - offset)
  const history = await loadToolCallingV2ConversationEnvelope({ contactId: 'manual', channel: 'messenger' }, { loadRows, countRows: async () => rows.length })
  assert.deepEqual(history.messages.map(message => message.id), rows.map(message => message.id))
  assert.equal(history.telemetry.historyComplete, true)
  const pending = await loadPendingInboundMessages('manual', {}, 'messenger', null, { loadRows })
  assert.deepEqual(pending.map(message => message.id), ['pregunta nueva', 'aclaración nueva'])
})

test('el contexto conserva una respuesta que terminó de enviarse después del nuevo inbound', async () => {
  const rows = [inbound('previous', 0), inbound('pending', 1000), { id: 'sent', role: 'assistant', content: 'Respuesta al mensaje anterior', created_at: new Date(start + 2000).toISOString() }]
  const loadRows = async (_contact, _channel, { limit, offset = 0, throughMessage }) => {
    const available = throughMessage ? rows.filter(row => Date.parse(row.created_at) <= Date.parse(throughMessage.created_at)) : rows
    return available.slice(Math.max(0, available.length - offset - limit), available.length - offset)
  }
  const history = await loadToolCallingV2ConversationEnvelope({ contactId: 'in_flight', channel: 'messenger' }, { loadRows, countRows: async () => rows.length })
  const pending = await loadPendingInboundMessages('in_flight', { lastAnsweredInboundMessageId: 'previous' }, 'messenger', rows[1], { loadRows })
  assert.equal(history.messages.at(-1).id, 'sent')
  assert.deepEqual(pending.map(message => message.id), ['pending'])
})

test('otro mensaje aborta la petición en curso y descarta su salida sin marcarlo respondido', async () => {
  let newerMessage = null
  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  let sent = false
  const running = withCurrentConversationalTurn({ contactId: 'cancel', messageId: 'first', channel: 'messenger' }, async () => {
    const signal = currentConversationalTurnSignal()
    notifyStarted()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    sent = true
  }, { findNewer: async () => ({ checked: true, newerMessage }) })
  const rejected = assert.rejects(running, error => error.code === 'conversational_turn_superseded' && error.newerMessage.id === 'second')
  await started
  newerMessage = inbound('second', 5000)
  await interruptSupersededConversationalTurn('cancel', 'messenger')
  await rejected
  assert.equal(sent, false)
})

test('cancelar y retomar conserva los tres mensajes y avanza el cursor sólo tras una entrega', async () => {
  let clock = start
  const rows = [inbound('nombre', 0), inbound('teléfono', 30_000)]
  const state = { lastAnsweredInboundMessageId: null }
  const waitForBatch = latest => waitForConversationalResponseWindow({
    contactId: 'resume_batch', latest, delayMs: quietWindow, now: () => clock,
    wait: async ms => { clock += ms },
    loadLatest: async () => rows.filter(row => Date.parse(row.created_at) <= clock).at(-1),
    recordEvent: async () => {}
  })
  const first = await waitForBatch(rows[0])
  const outputs = []
  await assert.rejects(withCurrentConversationalTurn({ contactId: 'resume_batch', messageId: first.latest.id, channel: 'messenger' }, async () => {
    clock += 10_000
    rows.push(inbound('correo', clock - start))
    await assertCurrentConversationalTurn()
    outputs.push('borrador incompleto')
  }, { findNewer: async ({ handledMessageId }) => ({ checked: true, newerMessage: rows.at(-1).id === handledMessageId ? null : rows.at(-1) }) }), { code: 'conversational_turn_superseded' })
  assert.equal(state.lastAnsweredInboundMessageId, null)
  const resumed = await waitForBatch(rows.at(-1))
  assert.equal(clock - Date.parse(resumed.latest.created_at), quietWindow)
  const pending = await loadPendingInboundMessages('resume_batch', state, 'messenger', resumed.latest, { loadRows: async () => rows })
  assert.deepEqual(pending.map(row => row.id), ['nombre', 'teléfono', 'correo'])
  await sendReplyParts({ contactId: 'resume_batch', latest: resumed.latest, agentConfig: { id: 'agent' }, reply: 'Gracias, ya tengo tus tres datos.', dependencies: {
    forceSingleMessage: true, loadNewerInbound: async () => null, recordEvent: async () => {},
    sendTextMessage: async ({ text }) => { outputs.push(text) },
    markReplyComplete: async () => { state.lastAnsweredInboundMessageId = resumed.latest.id }
  } })
  assert.deepEqual(outputs, ['Gracias, ya tengo tus tres datos.'])
  assert.equal(state.lastAnsweredInboundMessageId, 'correo')
})

test('el watcher detecta mensajes de otra instancia sin depender del webhook local', async () => {
  let checked = 0
  let hold
  const keepAlive = setTimeout(() => {}, 500)
  try {
    await assert.rejects(withCurrentConversationalTurn({ contactId: 'other_instance', messageId: 'old', channel: 'whatsapp' }, async () => {
      const signal = currentConversationalTurnSignal()
      await new Promise((_resolve, reject) => { hold = reject; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
    }, { pollMs: 5, findNewer: async () => ({ checked: true, newerMessage: ++checked > 1 ? inbound('new', 10) : null }) }), { code: 'conversational_turn_superseded' })
  } finally {
    clearTimeout(keepAlive)
    hold?.(new Error('test completed'))
  }
})

test('una vuelta obsoleta no puede invocar tools y un duplicado no cancela la vuelta vigente', async () => {
  let newerMessage = null
  let effects = 0
  const agent = createToolCallingV2Agent({ model: 'gpt-5.6-luna', instructions: 'Prueba de concurrencia', tools: [{ type: 'function', name: 'save', parameters: {}, invoke: async () => { effects += 1 } }] })
  await assert.rejects(withCurrentConversationalTurn({ contactId: 'tools', messageId: 'first', channel: 'whatsapp' }, async () => {
    await interruptSupersededConversationalTurn('tools', 'whatsapp')
    assert.equal(currentConversationalTurnSignal().aborted, false)
    newerMessage = inbound('second', 10)
    await agent.tools[0].invoke(null, '{}')
  }, { findNewer: async () => ({ checked: true, newerMessage }) }), { code: 'conversational_turn_superseded' })
  assert.equal(effects, 0)
})

test('un error al comprobar autoridad bloquea el turno y no se convierte en permiso de envío', async () => {
  let called = false
  await assert.rejects(withCurrentConversationalTurn({ contactId: 'fail_closed', messageId: 'first', channel: 'whatsapp' }, async () => { called = true }, {
    findNewer: async () => { throw new Error('database unavailable') }
  }), /database unavailable/)
  assert.equal(called, false)
})

test('un hecho terminal ya confirmado conserva su resultado sin repetir la acción', async () => {
  let newerMessage = null
  const result = await withCurrentConversationalTurn({ contactId: 'committed', messageId: 'first', channel: 'whatsapp' }, async () => {
    rememberConversationalTurnContext({ committed: true })
    newerMessage = inbound('second', 10)
    await interruptSupersededConversationalTurn('committed', 'whatsapp')
    await assertCurrentConversationalTurn()
    return 'confirmed once'
  }, { findNewer: async () => ({ checked: true, newerMessage }), hasCommittedEffect: ctx => ctx?.committed === true })
  assert.equal(result, 'confirmed once')
})

test('una pregunta obligatoria ya entregada conserva su cursor cuando llega el siguiente dato', async () => {
  let newerMessage = null
  const result = await withCurrentConversationalTurn({ contactId: 'delivered_prompt', messageId: 'first', channel: 'messenger' }, async () => {
    rememberConversationalTurnContext({ actions: [], verifiedHandoffRequiredDataPromptDelivery: { settled: true } })
    newerMessage = inbound('dato solicitado', 10)
    await interruptSupersededConversationalTurn('delivered_prompt', 'messenger')
    return 'delivered'
  }, { findNewer: async () => ({ checked: true, newerMessage }), hasCommittedEffect: toolCallingV2HasCommittedEffect })
  assert.equal(result, 'delivered')
})

function fenceFixture({ newerMessage = null, status = 'active', enabled = true } = {}) {
  const calls = []
  return { calls, dependencies: {
    database: { transaction: async callback => callback({}) },
    acquireLock: async () => calls.push('lock'),
    getState: async () => ({ agentId: 'agent', status, inboundProcessingClaimToken: 'claim', inboundProcessingMessageId: 'source' }),
    getAgent: async () => ({ enabled }),
    findNewer: async () => { calls.push('authority'); return { checked: true, newerMessage } }
  } }
}

test('el fence descarta una respuesta aunque el nuevo mensaje llegue justo antes del envío', async () => {
  const fixture = fenceFixture({ newerMessage: inbound('new', 10) })
  let sent = 0
  let marked = 0
  const delivery = await sendReplyParts({ contactId: 'delivery', latest: { id: 'source' }, agentConfig: { id: 'agent' }, reply: 'old draft', dependencies: {
    forceSingleMessage: true, sendTextMessage: async () => { sent += 1 },
    loadNewerInbound: async () => null, recordEvent: async () => {}, markReplyComplete: async () => { marked += 1 },
    beforeSendFence: ({ send }) => sendCurrentConversationalReply({ contactId: 'delivery', agentId: 'agent', channel: 'messenger', sourceMessageId: 'source', inboundClaim: { claimToken: 'claim' }, send }, fixture.dependencies)
  } })
  assert.equal(delivery.interruptedBy.id, 'new')
  assert.equal(sent, 0)
  assert.equal(marked, 0)
  assert.deepEqual(fixture.calls, ['lock', 'authority'])
})

test('una respuesta vigente se envía una vez; pausa y takeover bloquean el envío', async () => {
  for (const variant of [{}, { status: 'human' }, { enabled: false }]) {
    const fixture = fenceFixture(variant)
    let sent = 0
    const result = await sendCurrentConversationalReply({ contactId: 'fence', agentId: 'agent', channel: 'messenger', sourceMessageId: 'source', inboundClaim: { claimToken: 'claim' }, send: async () => { sent += 1; return 'accepted' } }, fixture.dependencies)
    assert.equal(sent, variant.status || variant.enabled === false ? 0 : 1)
    assert.equal(result.allowed, sent === 1)
  }
})

test('activar manualmente un chat nunca atendido despierta su último inbound y crea el estado de ese canal', async () => {
  const operations = []
  const result = await queueManuallyActivatedConversation({ contactId: 'manual', agentId: 'agent', channel: 'messenger' }, {
    loadRows: async () => [inbound('pending', 0)], getState: async () => null,
    assign: async (_contact, _agent, options) => { operations.push(['assign', options.channel]); return { agentId: 'agent', status: 'active' } },
    database: { run: async () => operations.push(['reopen_unanswered']) },
    queue: async entry => { operations.push(['persist', entry.messageId]); return entry },
    schedule: entry => operations.push(['schedule', entry.latestMessage.id])
  })
  assert.equal(result.queued, 1)
  assert.deepEqual(operations, [['assign', 'messenger'], ['reopen_unanswered'], ['persist', 'pending'], ['schedule', 'pending']])
})

test('la activación manual no repite lo ya contestado ni responde a una salida humana', async () => {
  for (const latest of [{ id: 'human', role: 'assistant' }, inbound('answered', 0)]) {
    const result = await queueManuallyActivatedConversation({ contactId: 'manual_done', agentId: 'agent', channel: 'messenger' }, {
      loadRows: async () => [latest], getState: async () => ({ agentId: 'agent', status: 'active', lastAnsweredInboundMessageId: 'answered' }),
      queue: async () => assert.fail('No hay un mensaje pendiente que despertar')
    })
    assert.equal(result.queued, 0)
  }
})
