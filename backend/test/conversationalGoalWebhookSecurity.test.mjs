import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { db } from '../src/config/database.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import {
  completeExternalConversationGoal,
  handleGoalWebhook
} from '../src/controllers/conversationalAgentController.js'
import {
  completeConversationGoalLinkFromWebhook,
  createConversationalAgent,
  createConversationGoalLink,
  getConversationGoalLink,
  recoverPendingConversationGoalCompletionEffects,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'

const CONTACT_PREFIX = 'test_goal_security_'

async function removeContact(contactId) {
  await db.run(`
    DELETE FROM conversational_agent_goal_evidence_claims
    WHERE goal_id IN (
      SELECT id FROM conversational_agent_goal_links WHERE contact_id = ?
    )
  `, [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function createContact(suffix) {
  const contactId = `${CONTACT_PREFIX}${suffix}`
  const phoneSuffix = (BigInt(`0x${createHash('sha256').update(String(suffix)).digest('hex').slice(0, 12)}`) % 10000000000n)
    .toString()
    .padStart(10, '0')
  await removeContact(contactId)
  await db.run(
    `INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+52${phoneSuffix}`, `${suffix}@goal-security.test`, `Goal Security ${suffix}`]
  )
  return contactId
}

function externalAuthorization(requestId = 'request-1', actorId = 'api-user-test') {
  return { type: 'external_api', actorId, requestId }
}

function emptyCompletionEffectPlanMetadata() {
  const payload = {
    version: 1,
    agentId: '',
    agentUpdatedAt: '',
    completion: { mode: 'notify_only', userId: '', userName: '' },
    successExtras: []
  }
  return JSON.stringify({
    completionEffectPlan: {
      ...payload,
      planHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    }
  })
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

test('una URL genérica se entrega sin fetch, sin token y con meta pendiente', async (t) => {
  const contactId = await createContact('generic')
  t.after(() => removeContact(contactId))
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('send_goal_url no debe llamar dominios externos')
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const ctx = {
    contactId,
    dryRun: false,
    executionId: 'inbound-message-1',
    channel: 'whatsapp',
    actions: [],
    conversationMessages: [
      { role: 'assistant', content: '¿Te mando el enlace para agendar?' },
      { role: 'user', content: 'Sí, mándame el enlace' }
    ],
    config: {
      id: 'agent-generic-link',
      objective: 'citas',
      successAction: 'send_goal_url',
      goalWorkflow: {
        appointments: {
          owner: 'url',
          calendarId: 'cal_external_secure',
          url: 'https://calendly.example/reservar',
          trackingParam: 'booking_ref'
        }
      }
    }
  }
  const tool = createConversationalTools(ctx).find((item) => item.name === 'send_goal_url')
  const input = JSON.stringify({
    intencionDetectada: 'Quiere agendar',
    resumen: 'Aceptó continuar en el calendario externo',
    confirm: true
  })
  const first = await tool.invoke(null, input)
  const second = await tool.invoke(null, input)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.goalId, second.goalId)
  assert.equal(second.idempotent, true)
  assert.equal(first.confirmationMode, 'trusted_integration')
  assert.equal(fetchCalls, 0)
  assert.equal(new URL(first.sentUrl).searchParams.get('booking_ref'), first.goalId)
  assert.equal(new URL(first.sentUrl).searchParams.has('ristak_goal_token'), false)
  assert.doesNotMatch(JSON.stringify(first), /callbackUrl|ristak_goal_token/)

  const row = await db.get(
    `SELECT status, confirmation_token_hash, idempotency_key
     FROM conversational_agent_goal_links WHERE id = ?`,
    [first.goalId]
  )
  assert.equal(row.status, 'pending')
  assert.equal(row.confirmation_token_hash, null)
  assert.match(row.idempotency_key, /^[a-f0-9]{64}$/)
  const count = await db.get('SELECT COUNT(*) AS count FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId])
  assert.equal(Number(count.count), 1)
})

test('una integración autenticada completa cita y exige evidencia exacta', async (t) => {
  const contactId = await createContact('appointment')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'citas',
    targetUrl: 'https://agenda.example/reservar',
    metadata: { expected: { calendarId: 'cal_secure' } }
  })
  const base = {
    goalId: link.id,
    externalSource: 'calendar:test',
    externalObjectId: 'appt_secure_1',
    calendarId: 'cal_secure',
    status: 'scheduled'
  }

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, externalObjectId: '' }, { authorization: externalAuthorization() }),
    (error) => error.statusCode === 400 && /ID externo real/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, status: 'cancelled' }, { authorization: externalAuthorization() }),
    (error) => error.statusCode === 409 && /estado exitoso/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, calendarId: 'cal_other' }, { authorization: externalAuthorization() }),
    (error) => error.statusCode === 409 && /calendario esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, calendarId: 'CAL_SECURE' }, { authorization: externalAuthorization() }),
    (error) => error.statusCode === 409 && /calendario esperado/.test(error.message)
  )

  const completed = await completeConversationGoalLinkFromWebhook(base, { authorization: externalAuthorization() })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.externalObjectId, 'appt_secure_1')
  assert.equal(completed.completionAuthMethod, 'external_api')
  assert.equal(completed.completionEffectsStatus, 'completed')
})

test('una meta nueva rechaza confirmaciones públicas sin autenticación', async (t) => {
  const contactId = await createContact('unauthorized')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/continuar'
  })
  const payload = {
    goalId: link.id,
    externalObjectId: 'external_unauthorized',
    status: 'completed'
  }

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload),
    (error) => error.statusCode === 401 && /no está autorizada/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload, { authorization: { type: 'external_api', actorId: 'api-user' } }),
    (error) => error.statusCode === 400 && /Idempotency-Key/.test(error.message)
  )
  assert.equal((await getConversationGoalLink(link.id)).status, 'pending')
})

test('venta verifica producto, precio, importe y moneda configurados', async (t) => {
  const contactId = await createContact('sale')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'ventas',
    targetUrl: 'https://tienda.example/pagar',
    metadata: {
      expected: {
        productId: 'prod_secure',
        priceId: 'price_secure',
        amount: 1250.5,
        currency: 'USD'
      }
    }
  })
  const base = {
    goalId: link.id,
    externalSource: 'payments:test',
    externalObjectId: 'purchase_secure_1',
    productId: 'prod_secure',
    priceId: 'price_secure',
    amount: '1250.50',
    currency: 'usd',
    status: 'paid'
  }
  const auth = externalAuthorization('sale-request')

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, priceId: '' }, { authorization: auth }),
    (error) => error.statusCode === 409 && /precio esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, amount: '1251' }, { authorization: auth }),
    (error) => error.statusCode === 409 && /importe esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, currency: 'MXN' }, { authorization: auth }),
    (error) => error.statusCode === 409 && /moneda esperada/.test(error.message)
  )

  const completed = await completeConversationGoalLinkFromWebhook(base, { authorization: auth })
  assert.equal(completed.status, 'completed')
  const row = await db.get('SELECT metadata_json FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  const metadata = JSON.parse(row.metadata_json)
  assert.equal(metadata.receivedReference.amount, 1250.5)
  assert.equal(metadata.receivedReference.currency, 'USD')
})

test('el mismo request es idempotente y uno distinto no puede reclamar una meta completada', async (t) => {
  const contactId = await createContact('retry')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/retry'
  })
  const payload = {
    goalId: link.id,
    externalSource: 'custom:test',
    externalObjectId: 'external_retry_1',
    status: 'completed'
  }
  const auth = externalAuthorization('same-request')
  const first = await completeConversationGoalLinkFromWebhook(payload, { authorization: auth })
  const retry = await completeConversationGoalLinkFromWebhook(payload, { authorization: auth })

  assert.equal(first.alreadyCompleted, false)
  assert.equal(retry.alreadyCompleted, true)
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload, { authorization: externalAuthorization('different-request') }),
    (error) => error.statusCode === 409 && /otra solicitud/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...payload, externalObjectId: 'other' }, { authorization: auth }),
    (error) => error.statusCode === 409 && /datos distintos/.test(error.message)
  )
  const otherLink = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/another-goal'
  })
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      goalId: otherLink.id,
      externalSource: 'custom:test',
      externalObjectId: 'another_external',
      status: 'completed'
    }, { authorization: auth }),
    (error) => error.statusCode === 409 && /Idempotency-Key ya fue usado/.test(error.message)
  )
  const completionCount = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'goal_url_completed'`,
    [contactId]
  )
  assert.equal(Number(completionCount.count), 1)
})

test('dos callbacks concurrentes del mismo request convergen en un solo resultado', async (t) => {
  const contactId = await createContact('atomic')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/atomic'
  })
  const payload = {
    goalId: link.id,
    externalSource: 'custom:test',
    externalObjectId: 'atomic_external',
    status: 'completed'
  }
  const auth = externalAuthorization('atomic-request')
  const results = await Promise.all([
    completeConversationGoalLinkFromWebhook(payload, { authorization: auth }),
    completeConversationGoalLinkFromWebhook(payload, { authorization: auth })
  ])

  assert.equal(results.every((result) => result.status === 'completed'), true)
  assert.equal(results.filter((result) => result.alreadyCompleted).length, 1)
  const completionCount = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'goal_url_completed'`,
    [contactId]
  )
  assert.equal(Number(completionCount.count), 1)
})

test('tokens legacy siguen siendo seguros, expiran y su retry exacto es idempotente', async (t) => {
  const contactId = await createContact('legacy')
  const expiredContactId = await createContact('legacy-expired')
  t.after(async () => {
    await removeContact(contactId)
    await removeContact(expiredContactId)
  })
  const token = 'legacy-token-seguro-1234567890'
  const hash = createHash('sha256').update(token).digest('hex')
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/legacy'
  })
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET confirmation_token_hash = ?, confirmation_expires_at = ? WHERE id = ?`,
    [hash, '2099-01-01T00:00:00.000Z', link.id]
  )
  const payload = {
    ristak_goal_id: link.id,
    external_object_id: 'legacy_external',
    status: 'completed'
  }
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload, { confirmationToken: 'incorrecto' }),
    (error) => error.statusCode === 401
  )
  const first = await completeConversationGoalLinkFromWebhook(payload, { confirmationToken: token })
  const retry = await completeConversationGoalLinkFromWebhook(payload, { confirmationToken: token })
  assert.equal(first.status, 'completed')
  assert.equal(retry.alreadyCompleted, true)

  const expired = await createConversationGoalLink({
    contactId: expiredContactId,
    objective: 'custom',
    targetUrl: 'https://example.test/expired'
  })
  const expiredToken = 'legacy-token-expirado-0987654321'
  const expiredHash = createHash('sha256').update(expiredToken).digest('hex')
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET confirmation_token_hash = ?, confirmation_expires_at = ? WHERE id = ?`,
    [expiredHash, '2000-01-01T00:00:00.000Z', expired.id]
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      ristak_goal_id: expired.id,
      external_object_id: 'expired_external',
      status: 'completed'
    }, { confirmationToken: expiredToken }),
    (error) => error.statusCode === 410 && /expiró/.test(error.message)
  )
})

test('el controller de API externa exige token resuelto e Idempotency-Key', async (t) => {
  const contactId = await createContact('controller')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/controller'
  })
  const body = { externalSource: 'custom:controller', externalObjectId: 'controller_external', status: 'completed' }

  const missingKeyRes = createResponse()
  await completeExternalConversationGoal({
    params: { goalId: link.id },
    body,
    apiUser: { id: 'api-user-controller' },
    get: () => ''
  }, missingKeyRes)
  assert.equal(missingKeyRes.statusCode, 400)

  const res = createResponse()
  await completeExternalConversationGoal({
    params: { goalId: link.id },
    body,
    apiUser: { id: 'api-user-controller' },
    get: (name) => String(name).toLowerCase() === 'idempotency-key' ? 'controller-request' : ''
  }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.goalId, link.id)
})

test('el controller legacy no persiste el token recibido en metadata ni eventos', async (t) => {
  const contactId = await createContact('legacy-controller')
  t.after(() => removeContact(contactId))
  const token = 'legacy-controller-token-1234567890'
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/legacy-controller'
  })
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET confirmation_token_hash = ?, confirmation_expires_at = ? WHERE id = ?`,
    [createHash('sha256').update(token).digest('hex'), '2099-01-01T00:00:00.000Z', link.id]
  )
  const req = {
    params: { goalId: link.id },
    query: {},
    body: { external_object_id: 'legacy_controller_external', status: 'completed' },
    get: (name) => String(name).toLowerCase() === 'x-ristak-goal-token' ? token : ''
  }
  const res = createResponse()
  await handleGoalWebhook(req, res)
  assert.equal(res.statusCode, 200)

  const row = await db.get('SELECT metadata_json FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  const events = await db.all('SELECT detail_json FROM conversational_agent_events WHERE contact_id = ?', [contactId])
  assert.doesNotMatch(row.metadata_json, new RegExp(token))
  for (const event of events) assert.doesNotMatch(event.detail_json, new RegExp(token))
})

test('la recuperación durable finaliza efectos pendientes sin duplicar el evento', async (t) => {
  const contactId = await createContact('effects-recovery')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/effects-recovery'
  })
  await completeConversationGoalLinkFromWebhook({
    goalId: link.id,
    externalSource: 'custom:recovery',
    externalObjectId: 'effects_external',
    status: 'completed'
  }, { authorization: externalAuthorization('effects-request') })
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET completion_effects_status = 'failed', completion_effects_last_error = 'simulated crash'
     WHERE id = ?`,
    [link.id]
  )

  const signalCountBefore = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'signal_set'`,
    [contactId]
  )
  const recovered = await recoverPendingConversationGoalCompletionEffects({ limit: 20 })
  assert.ok(recovered.completed >= 1)
  const row = await db.get('SELECT completion_effects_status FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  assert.equal(row.completion_effects_status, 'completed')
  const completionCount = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'goal_url_completed'`,
    [contactId]
  )
  assert.equal(Number(completionCount.count), 1)
  const signalCountAfter = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'signal_set'`,
    [contactId]
  )
  assert.equal(Number(signalCountBefore.count), 1)
  assert.equal(Number(signalCountAfter.count), 1)
})

test('recovery aplica el plan de efectos confirmado aunque después editen el agente', async (t) => {
  const contactId = await createContact('effects-snapshot')
  let agent = null
  t.after(async () => {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await removeContact(contactId)
  })

  agent = await createConversationalAgent({
    name: 'Agente snapshot A',
    objective: 'custom',
    successAction: 'send_goal_url',
    goalWorkflow: {
      completion: { mode: 'assign_user', userId: 'snapshot_user_A', userName: 'Usuario A' }
    },
    successExtras: [
      { type: 'set_custom_field', field: 'snapshotVersion', value: 'A' }
    ]
  })
  const link = await createConversationGoalLink({
    contactId,
    agentId: agent.id,
    objective: 'custom',
    targetUrl: 'https://example.test/effects-snapshot'
  })
  await completeConversationGoalLinkFromWebhook({
    goalId: link.id,
    externalSource: 'custom:snapshot',
    externalObjectId: 'snapshot_external_A',
    status: 'completed'
  }, { authorization: externalAuthorization('snapshot-request') })

  const stored = await db.get('SELECT metadata_json FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  const storedPlan = JSON.parse(stored.metadata_json).completionEffectPlan
  assert.equal(storedPlan.agentId, agent.id)
  assert.equal(storedPlan.completion.userId, 'snapshot_user_A')
  assert.equal(storedPlan.successExtras[0].value, 'A')
  assert.match(storedPlan.planHash, /^[a-f0-9]{64}$/)

  await updateConversationalAgent(agent.id, {
    goalWorkflow: {
      completion: { mode: 'assign_user', userId: 'snapshot_user_B', userName: 'Usuario B' }
    },
    successExtras: [
      { type: 'set_custom_field', field: 'snapshotVersion', value: 'B' }
    ]
  })
  await db.run('UPDATE contacts SET custom_fields = ? WHERE id = ?', [JSON.stringify({}), contactId])
  await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_effects_status = 'failed',
        completion_effects_next_retry_at = NULL,
        completion_action_applied_at = NULL,
        completion_extras_applied_at = NULL
    WHERE id = ?
  `, [link.id])

  const recovered = await recoverPendingConversationGoalCompletionEffects({ limit: 20 })
  assert.ok(recovered.completed >= 1)
  const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
  const fields = JSON.parse(contact.custom_fields || '{}')
  assert.equal(fields.assignedUser, 'snapshot_user_A')
  assert.equal(fields.assignedUserName, 'Usuario A')
  assert.equal(fields.snapshotVersion, 'A')
})

test('la evidencia y el Idempotency-Key siguen reclamados después de borrar contacto y meta', async (t) => {
  const firstContactId = await createContact('durable-claim-first')
  const secondContactId = await createContact('durable-claim-second')
  const externalSource = 'crm:durable-delete'
  const externalObjectId = 'DurableObjectABC'
  const evidenceKey = createHash('sha256').update(`${externalSource}\0${externalObjectId}`).digest('hex')
  t.after(async () => {
    await removeContact(firstContactId)
    await removeContact(secondContactId)
    await db.run(
      'DELETE FROM conversational_agent_goal_evidence_claims WHERE external_evidence_key = ?',
      [evidenceKey]
    ).catch(() => undefined)
  })

  const firstLink = await createConversationGoalLink({
    contactId: firstContactId,
    objective: 'custom',
    targetUrl: 'https://example.test/durable-first'
  })
  await completeConversationGoalLinkFromWebhook({
    goalId: firstLink.id,
    externalSource,
    externalObjectId,
    status: 'completed'
  }, { authorization: externalAuthorization('durable-original-request') })

  await db.run('DELETE FROM contacts WHERE id = ?', [firstContactId])
  await db.run('DELETE FROM conversational_agent_goal_links WHERE id = ?', [firstLink.id])
  const claim = await db.get(
    'SELECT goal_id FROM conversational_agent_goal_evidence_claims WHERE external_evidence_key = ?',
    [evidenceKey]
  )
  assert.equal(claim.goal_id, firstLink.id)

  const secondLink = await createConversationGoalLink({
    contactId: secondContactId,
    objective: 'custom',
    targetUrl: 'https://example.test/durable-second'
  })
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      goalId: secondLink.id,
      externalSource,
      externalObjectId,
      status: 'completed'
    }, { authorization: externalAuthorization('durable-other-request') }),
    (error) => error.statusCode === 409 && /evidencia externa ya confirmó otra meta/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      goalId: secondLink.id,
      externalSource: 'crm:durable-other',
      externalObjectId: 'OtherObject',
      status: 'completed'
    }, { authorization: externalAuthorization('durable-original-request') }),
    (error) => error.statusCode === 409 && /Idempotency-Key ya fue usado/.test(error.message)
  )
})

test('la API externa rechaza aliases ambiguos e identificadores truncables', async (t) => {
  const contactId = await createContact('strict-payload')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/strict-payload'
  })
  const base = {
    goalId: link.id,
    externalSource: 'custom:strict',
    externalObjectId: 'strict_object',
    status: 'completed'
  }

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, source: 'custom:other' }, {
      authorization: externalAuthorization('strict-alias-source')
    }),
    (error) => error.statusCode === 400 && /valores conflictivos/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, appointment_id: 'other_object' }, {
      authorization: externalAuthorization('strict-alias-object')
    }),
    (error) => error.statusCode === 400 && /valores conflictivos/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, externalObjectId: 'x'.repeat(241) }, {
      authorization: externalAuthorization('strict-long-object')
    }),
    (error) => error.statusCode === 400 && /máximo de 240/.test(error.message)
  )
  for (const invalidAmount of ['nope', '1e308', '0', '-1']) {
    await assert.rejects(
      () => completeConversationGoalLinkFromWebhook({ ...base, amount: invalidAmount }, {
        authorization: externalAuthorization(`strict-amount-${invalidAmount}`)
      }),
      (error) => error.statusCode === 400 && /número finito mayor que cero/.test(error.message)
    )
  }
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(base, {
      authorization: externalAuthorization('x'.repeat(1001))
    }),
    (error) => error.statusCode === 400 && /Idempotency-Key excede/.test(error.message)
  )
  assert.equal((await getConversationGoalLink(link.id)).status, 'pending')
})

test('el guard de rolling deploy bloquea completions del binario legacy sin claim', async (t) => {
  const contactId = await createContact('rolling-guard')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/rolling-guard'
  })

  await assert.rejects(
    () => db.run(`
      UPDATE conversational_agent_goal_links
      SET status = 'completed',
          external_object_id = 'legacy_overlap_object',
          external_status = 'completed',
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [link.id]),
    /CONVERSATIONAL_GOAL_EVIDENCE_CLAIM_REQUIRED/
  )
  assert.equal((await getConversationGoalLink(link.id)).status, 'pending')
})

test('si falla el UPDATE principal también se revierte el claim de evidencia', async (t) => {
  const contactId = await createContact('claim-rollback')
  t.after(() => removeContact(contactId))
  const [firstLink, secondLink] = await Promise.all([
    createConversationGoalLink({
      contactId,
      objective: 'custom',
      targetUrl: 'https://example.test/rollback-first',
      idempotencyKey: 'rollback-first-link'
    }),
    createConversationGoalLink({
      contactId,
      objective: 'custom',
      targetUrl: 'https://example.test/rollback-second',
      idempotencyKey: 'rollback-second-link'
    })
  ])
  const auth = externalAuthorization('rollback-shared-request')
  await completeConversationGoalLinkFromWebhook({
    goalId: firstLink.id,
    externalSource: 'custom:rollback',
    externalObjectId: 'rollback_first_object',
    status: 'completed'
  }, { authorization: auth })
  // Simula una fila histórica creada antes de la tombstone, pero conservando
  // el índice único viejo de completion_request_id.
  await db.run('DELETE FROM conversational_agent_goal_evidence_claims WHERE goal_id = ?', [firstLink.id])

  const secondSource = 'custom:rollback'
  const secondObject = 'rollback_second_object'
  const secondEvidenceKey = createHash('sha256').update(`${secondSource}\0${secondObject}`).digest('hex')
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      goalId: secondLink.id,
      externalSource: secondSource,
      externalObjectId: secondObject,
      status: 'completed'
    }, { authorization: auth }),
    (error) => error.statusCode === 409 && /Idempotency-Key ya fue usado/.test(error.message)
  )
  assert.equal((await getConversationGoalLink(secondLink.id)).status, 'pending')
  const leakedClaim = await db.get(
    'SELECT goal_id FROM conversational_agent_goal_evidence_claims WHERE external_evidence_key = ?',
    [secondEvidenceKey]
  )
  assert.equal(leakedClaim, null)
})

test('la API externa exige una fuente estable para la evidencia', async (t) => {
  const contactId = await createContact('source-required')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/source-required'
  })

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      goalId: link.id,
      externalObjectId: 'source_required_object',
      status: 'completed'
    }, { authorization: externalAuthorization('source-required-request') }),
    (error) => error.statusCode === 400 && /externalSource/.test(error.message)
  )
  assert.equal((await getConversationGoalLink(link.id)).status, 'pending')
})

test('una misma evidencia externa no puede completar dos metas ni bajo carrera', async (t) => {
  const contactId = await createContact('evidence-unique')
  t.after(() => removeContact(contactId))
  const [firstLink, secondLink] = await Promise.all([
    createConversationGoalLink({
      contactId,
      objective: 'custom',
      targetUrl: 'https://example.test/evidence-first',
      idempotencyKey: 'evidence-first-link'
    }),
    createConversationGoalLink({
      contactId,
      objective: 'custom',
      targetUrl: 'https://example.test/evidence-second',
      idempotencyKey: 'evidence-second-link'
    })
  ])
  const evidence = {
    externalSource: 'crm:test',
    externalObjectId: 'OpaqueObjectABC',
    status: 'completed'
  }

  const results = await Promise.allSettled([
    completeConversationGoalLinkFromWebhook({ ...evidence, goalId: firstLink.id }, {
      authorization: externalAuthorization('evidence-request-1')
    }),
    completeConversationGoalLinkFromWebhook({ ...evidence, goalId: secondLink.id }, {
      authorization: externalAuthorization('evidence-request-2')
    })
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejection = results.find((result) => result.status === 'rejected')
  assert.equal(rejection.reason.statusCode, 409)
  assert.match(rejection.reason.message, /evidencia externa ya confirmó otra meta/)

  const completedCount = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_goal_links
     WHERE contact_id = ? AND status = 'completed'`,
    [contactId]
  )
  assert.equal(Number(completedCount.count), 1)
})

test('el recovery drena más de un lote en una sola corrida', async (t) => {
  const contactId = await createContact('recovery-batches')
  t.after(() => removeContact(contactId))
  const rows = Array.from({ length: 205 }, (_, index) => `goal_recovery_batch_${index}`)
  for (const goalId of rows) {
    await db.run(`
      INSERT INTO conversational_agent_goal_links (
        id, contact_id, objective, status, target_url, sent_url, tracking_param,
        completion_effects_status, completion_effects_updated_at,
        completion_signal_applied_at, completion_action_applied_at,
        completion_extras_applied_at, completion_notification_claimed_at,
        completion_notification_sent_at, completion_notification_status,
        completion_event_recorded_at, metadata_json, completed_at, updated_at
      ) VALUES (
        ?, ?, 'custom', 'completed', 'https://example.test/batch',
        'https://example.test/batch', 'ristak_goal_id', 'pending',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'skipped',
        CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [goalId, contactId, emptyCompletionEffectPlanMetadata()])
  }

  const recovered = await recoverPendingConversationGoalCompletionEffects({ limit: 250, batchSize: 50 })
  assert.equal(recovered.scanned, 205)
  assert.equal(recovered.completed, 205)
  assert.equal(recovered.failed, 0)
  const remaining = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_goal_links
     WHERE contact_id = ? AND completion_effects_status != 'completed'`,
    [contactId]
  )
  assert.equal(Number(remaining.count), 0)
})

test('el recovery no reejecuta completions legacy con ledger nulo', async (t) => {
  const contactId = await createContact('legacy-overlap')
  t.after(() => removeContact(contactId))
  await db.run(`
    INSERT INTO conversational_agent_goal_links (
      id, contact_id, objective, status, target_url, sent_url, tracking_param,
      completion_effects_status, completed_at, updated_at
    ) VALUES (
      'goal_legacy_overlap', ?, 'custom', 'completed',
      'https://example.test/legacy-overlap', 'https://example.test/legacy-overlap',
      'ristak_goal_id', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `, [contactId])

  const recovered = await recoverPendingConversationGoalCompletionEffects({ limit: 20, batchSize: 5 })
  assert.equal(recovered.scanned, 0)
  const events = await db.get(
    'SELECT COUNT(*) AS count FROM conversational_agent_events WHERE contact_id = ?',
    [contactId]
  )
  assert.equal(Number(events.count), 0)
})
