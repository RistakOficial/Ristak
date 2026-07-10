import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { handleGoalWebhook } from '../src/controllers/conversationalAgentController.js'
import {
  completeConversationGoalLinkFromWebhook,
  createConversationGoalLink,
  getConversationGoalLink
} from '../src/services/conversationalAgentService.js'

const CONTACT_PREFIX = 'test_goal_security_'

async function removeContact(contactId) {
  await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function createContact(suffix) {
  const contactId = `${CONTACT_PREFIX}${suffix}`
  await removeContact(contactId)
  await db.run(
    `INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, `+5215559${suffix.padStart(6, '0')}`.slice(0, 16), `${suffix}@goal-security.test`, `Goal Security ${suffix}`]
  )
  return contactId
}

function getConfirmationToken(link) {
  const callbackUrl = new URL(link.callbackUrl)
  assert.match(callbackUrl.pathname, new RegExp(`/webhook/conversational-agent/goal/${link.id}$`))
  const token = callbackUrl.searchParams.get('ristak_goal_token')
  assert.ok(token)
  return token
}

test('crea un token aleatorio por meta, guarda sólo el hash y no lo filtra al contacto ni a eventos', async (t) => {
  const contactId = await createContact('creation')
  t.after(() => removeContact(contactId))

  const link = await createConversationGoalLink({
    contactId,
    objective: 'citas',
    targetUrl: 'https://agenda.test/reservar',
    metadata: { expected: { calendarId: 'cal_secure' } }
  })
  const token = getConfirmationToken(link)
  const sentUrl = new URL(link.sentUrl)
  const row = await db.get(
    `SELECT confirmation_token_hash, confirmation_expires_at, metadata_json
     FROM conversational_agent_goal_links WHERE id = ?`,
    [link.id]
  )
  const event = await db.get(
    `SELECT detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'goal_url_created'
     ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  )

  assert.match(row.confirmation_token_hash, /^[a-f0-9]{64}$/)
  assert.notEqual(row.confirmation_token_hash, token)
  assert.ok(new Date(row.confirmation_expires_at).getTime() > Date.now())
  assert.equal(sentUrl.searchParams.get('ristak_goal_id'), link.id)
  assert.equal(sentUrl.searchParams.has('ristak_goal_token'), false)
  assert.doesNotMatch(link.sentUrl, new RegExp(token))
  assert.doesNotMatch(row.metadata_json, new RegExp(token))
  assert.doesNotMatch(event.detail_json, new RegExp(token))
})

test('rechaza token faltante o incorrecto sin consumir la meta', async (t) => {
  const contactId = await createContact('auth')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/continuar'
  })

  const payload = {
    ristak_goal_id: link.id,
    external_object_id: 'external_auth_1',
    status: 'completed'
  }
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload),
    (error) => error.statusCode === 401 && /no está autorizada/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(payload, { confirmationToken: 'token-incorrecto' }),
    (error) => error.statusCode === 401 && /no está autorizada/.test(error.message)
  )
  assert.equal((await getConversationGoalLink(link.id)).status, 'pending')
})

test('cita exige ID externo, status exitoso y calendario exacto; el token se usa una sola vez', async (t) => {
  const contactId = await createContact('appointment')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'citas',
    targetUrl: 'https://agenda.test/reservar',
    metadata: { expected: { calendarId: 'cal_secure' } }
  })
  const confirmationToken = getConfirmationToken(link)

  const base = {
    ristak_goal_id: link.id,
    calendar_id: 'cal_secure',
    appointment_id: 'appt_secure_1',
    status: 'scheduled'
  }
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, appointment_id: '' }, { confirmationToken }),
    (error) => error.statusCode === 400 && /ID externo real/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, status: 'cancelled' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /estado exitoso/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, calendar_id: '' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /calendario esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, calendar_id: 'cal_other' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /calendario esperado/.test(error.message)
  )

  const completed = await completeConversationGoalLinkFromWebhook(base, { confirmationToken })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.externalObjectId, 'appt_secure_1')
  assert.ok(completed.confirmationUsedAt)

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook(base, { confirmationToken }),
    (error) => error.statusCode === 409 && /ya fue utilizada/.test(error.message)
  )
  const completionCount = await db.get(
    `SELECT COUNT(*) AS count FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'goal_url_completed'`,
    [contactId]
  )
  assert.equal(Number(completionCount.count), 1)
})

test('venta verifica producto, precio, importe y moneda configurados antes de completarse', async (t) => {
  const contactId = await createContact('sale')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'ventas',
    targetUrl: 'https://tienda.test/pagar',
    metadata: {
      expected: {
        productId: 'prod_secure',
        priceId: 'price_secure',
        amount: 1250.5,
        currency: 'USD'
      }
    }
  })
  const confirmationToken = getConfirmationToken(link)
  const base = {
    ristak_goal_id: link.id,
    purchase_id: 'purchase_secure_1',
    product_id: 'prod_secure',
    price_id: 'price_secure',
    amount: '1250.50',
    currency: 'usd',
    status: 'paid'
  }

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, price_id: '' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /precio esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, amount: '' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /importe esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, amount: '1251' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /importe esperado/.test(error.message)
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({ ...base, currency: 'MXN' }, { confirmationToken }),
    (error) => error.statusCode === 409 && /moneda esperada/.test(error.message)
  )

  const completed = await completeConversationGoalLinkFromWebhook(base, { confirmationToken })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.externalStatus, 'paid')
  const row = await db.get('SELECT metadata_json FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  const metadata = JSON.parse(row.metadata_json)
  assert.equal(metadata.receivedReference.amount, 1250.5)
  assert.equal(metadata.receivedReference.currency, 'USD')
})

test('la configuración real del agente prevalece sobre referencias metadata más débiles', async (t) => {
  const contactId = await createContact('agent-config')
  const agentId = 'agent_goal_security_config'
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  t.after(async () => {
    await removeContact(contactId)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  })
  await db.run(
    `INSERT INTO conversational_agents (
      id, name, enabled, objective, success_action, goal_workflow_config, created_at, updated_at
    ) VALUES (?, 'Goal Security Config', 0, 'ventas', 'send_goal_url', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [agentId, JSON.stringify({
      sales: {
        owner: 'url',
        productId: 'prod_configured',
        priceId: 'price_configured',
        amount: 799.9,
        currency: 'EUR',
        url: 'https://tienda.test/configured'
      }
    })]
  )

  const link = await createConversationGoalLink({
    contactId,
    agentId,
    objective: 'ventas',
    targetUrl: 'https://tienda.test/configured',
    metadata: {
      expected: {
        productId: 'prod_weaker_metadata',
        priceId: 'price_weaker_metadata',
        amount: 1,
        currency: 'USD'
      }
    }
  })
  const confirmationToken = getConfirmationToken(link)
  const pending = await getConversationGoalLink(link.id)
  assert.deepEqual(
    {
      productId: pending.metadata.expected.productId,
      priceId: pending.metadata.expected.priceId,
      amount: pending.metadata.expected.amount,
      currency: pending.metadata.expected.currency
    },
    {
      productId: 'prod_configured',
      priceId: 'price_configured',
      amount: 799.9,
      currency: 'EUR'
    }
  )

  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      ristak_goal_id: link.id,
      purchase_id: 'purchase_wrong_config',
      product_id: 'prod_weaker_metadata',
      price_id: 'price_weaker_metadata',
      amount: 1,
      currency: 'USD',
      status: 'paid'
    }, { confirmationToken }),
    (error) => error.statusCode === 409 && /producto esperado/.test(error.message)
  )

  const completed = await completeConversationGoalLinkFromWebhook({
    ristak_goal_id: link.id,
    purchase_id: 'purchase_configured',
    product_id: 'prod_configured',
    price_id: 'price_configured',
    amount: '799.90',
    currency: 'eur',
    status: 'paid'
  }, { confirmationToken })
  assert.equal(completed.status, 'completed')
})

test('falla cerrado para token expirado y para enlaces legacy sin hash', async (t) => {
  const expiredContactId = await createContact('expired')
  const legacyContactId = await createContact('legacy')
  t.after(async () => {
    await removeContact(expiredContactId)
    await removeContact(legacyContactId)
  })

  const expiredLink = await createConversationGoalLink({
    contactId: expiredContactId,
    objective: 'custom',
    targetUrl: 'https://example.test/expired'
  })
  const expiredToken = getConfirmationToken(expiredLink)
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET confirmation_expires_at = ? WHERE id = ?`,
    ['2000-01-01T00:00:00.000Z', expiredLink.id]
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      ristak_goal_id: expiredLink.id,
      external_object_id: 'expired_external',
      status: 'completed'
    }, { confirmationToken: expiredToken }),
    (error) => error.statusCode === 410 && /expiró/.test(error.message)
  )

  const legacyLink = await createConversationGoalLink({
    contactId: legacyContactId,
    objective: 'custom',
    targetUrl: 'https://example.test/legacy'
  })
  const legacyToken = getConfirmationToken(legacyLink)
  await db.run(
    `UPDATE conversational_agent_goal_links
     SET confirmation_token_hash = NULL, confirmation_expires_at = NULL WHERE id = ?`,
    [legacyLink.id]
  )
  await assert.rejects(
    () => completeConversationGoalLinkFromWebhook({
      ristak_goal_id: legacyLink.id,
      external_object_id: 'legacy_external',
      status: 'completed'
    }, { confirmationToken: legacyToken }),
    (error) => error.statusCode === 409 && /enlace anterior/.test(error.message)
  )
})

test('la actualización atómica permite una sola confirmación concurrente', async (t) => {
  const contactId = await createContact('atomic')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/atomic'
  })
  const confirmationToken = getConfirmationToken(link)
  const payload = {
    ristak_goal_id: link.id,
    external_object_id: 'atomic_external',
    status: 'completed'
  }

  const results = await Promise.allSettled([
    completeConversationGoalLinkFromWebhook(payload, { confirmationToken }),
    completeConversationGoalLinkFromWebhook(payload, { confirmationToken })
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409)
})

test('controller acepta token por query, toma goalId de la ruta y lo elimina de metadata persistida', async (t) => {
  const contactId = await createContact('controller')
  t.after(() => removeContact(contactId))
  const link = await createConversationGoalLink({
    contactId,
    objective: 'custom',
    targetUrl: 'https://example.test/controller'
  })
  const confirmationToken = getConfirmationToken(link)
  const req = {
    params: { goalId: link.id },
    query: { ristak_goal_token: confirmationToken },
    body: { external_object_id: 'controller_external', status: 'completed' },
    get: () => ''
  }
  const res = {
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

  await handleGoalWebhook(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.goalId, link.id)

  const row = await db.get('SELECT metadata_json FROM conversational_agent_goal_links WHERE id = ?', [link.id])
  const events = await db.all('SELECT detail_json FROM conversational_agent_events WHERE contact_id = ?', [contactId])
  assert.doesNotMatch(row.metadata_json, new RegExp(confirmationToken))
  assert.equal(JSON.parse(row.metadata_json).confirmation.ristak_goal_token, undefined)
  for (const event of events) assert.doesNotMatch(event.detail_json, new RegExp(confirmationToken))
})
