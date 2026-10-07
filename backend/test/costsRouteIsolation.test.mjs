import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { after, before } from 'node:test'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import costsRoutes from '../src/routes/costs.routes.js'
import conversationalAgentRoutes from '../src/routes/conversationalAgent.routes.js'
import { generateToken, hashPassword } from '../src/utils/auth.js'

const fixture = {
  server: null,
  origin: '',
  userIds: [],
  tokens: {},
  costId: null,
  contactId: `rstk_contact_route_${randomUUID()}`,
  agentId: `cagent_route_${randomUUID()}`
}

async function request(path, { actor = 'assistant', method = 'GET', body } = {}) {
  const response = await fetch(`${fixture.origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(fixture.tokens[actor] ? { Authorization: `Bearer ${fixture.tokens[actor]}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  return { status: response.status, body: await response.json() }
}

before(async () => {
  await databaseReady
  for (const [name, access] of Object.entries({
    assistant: { chat: 'write', contacts: 'write', ai_agent: 'write', settings_costs: 'none' },
    reader: { ai_agent: 'read', settings_costs: 'none' },
    costsOnly: { ai_agent: 'none', settings_costs: 'write' }
  })) {
    const email = `${name}-${randomUUID()}@example.com`
    const created = await db.run(`
      INSERT INTO users (username, email, password_hash, role, access_config, is_active)
      VALUES (?, ?, ?, 'employee', ?, 1)
    `, [email, email, hashPassword(`Aa1${randomUUID()}`), JSON.stringify(access)])
    const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [email])
    assert.ok(created.changes)
    fixture.userIds.push(user.id)
    fixture.tokens[name] = generateToken({ userId: user.id, tokenVersion: user.token_version ?? 0 })
  }

  await db.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [fixture.contactId, 'Route isolation test'])
  await db.run('INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 1)', [fixture.agentId, 'Route isolation agent'])
  await db.run(`
    INSERT INTO conversational_agent_state (contact_id, agent_id, status, signal, channel)
    VALUES (?, ?, 'active', 'ready_for_human', 'whatsapp')
  `, [fixture.contactId, fixture.agentId])

  // Use the production mount itself: mounting a protected router on /api must
  // fail these HTTP checks even when its own endpoints are named /costs.
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const mount = source.match(/app\.use\('([^']+)', costsRoutes\)/)?.[1]
  assert.ok(mount, 'No se encontró el montaje de Costos')
  const app = express()
  app.use(express.json())
  app.use(mount, costsRoutes)
  app.use('/api/conversational-agent', conversationalAgentRoutes)
  app.get('/api/unrelated-public-route', (_req, res) => res.json({ success: true }))
  fixture.server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => fixture.server.once('listening', resolve))
  fixture.origin = `http://127.0.0.1:${fixture.server.address().port}`
})

after(async () => {
  if (fixture.server) await new Promise(resolve => fixture.server.close(resolve))
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [fixture.contactId])
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [fixture.agentId])
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId])
  if (fixture.costId) await db.run('DELETE FROM costs WHERE id = ?', [fixture.costId])
  for (const id of fixture.userIds) await db.run('DELETE FROM users WHERE id = ?', [id])
})

test('la asistente puede cargar el robot y los avisos sin tener acceso a Costos', async () => {
  const agents = await request('/api/conversational-agent/agents')
  assert.equal(agents.status, 200)
  assert.ok(agents.body.data.some(agent => agent.id === fixture.agentId))

  const states = await request('/api/conversational-agent/states')
  assert.equal(states.status, 200)
  assert.ok(states.body.data.some(state => state.contactId === fixture.contactId && state.signal === 'ready_for_human'))
})

test('la asistente puede pausar, reanudar y tomar el mando del chat', async () => {
  for (const [action, status] of [['pause', 'paused'], ['resume', 'active'], ['take_over', 'human']]) {
    const result = await request(`/api/conversational-agent/states/${fixture.contactId}`, {
      method: 'POST', body: { action, agentId: fixture.agentId }
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.data.status, status)
    const persisted = await db.get('SELECT status FROM conversational_agent_state WHERE contact_id = ?', [fixture.contactId])
    assert.equal(persisted.status, status)
  }
})

test('Costos conserva sus permisos y las otras rutas conservan los suyos', async () => {
  for (const [method, path] of [
    ['GET', '/api/costs'], ['GET', '/api/costs/missing'], ['POST', '/api/costs'],
    ['PUT', '/api/costs/missing'], ['DELETE', '/api/costs/missing'], ['POST', '/api/costs/calculate']
  ]) {
    const denied = await request(path, { method })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.module, 'settings_costs')
  }
  assert.equal((await request('/api/costs', { actor: 'costsOnly' })).status, 200)
  assert.equal((await request('/api/costs', { actor: 'anonymous' })).status, 401)

  const agentDenied = await request('/api/conversational-agent/agents', { actor: 'costsOnly' })
  assert.equal(agentDenied.status, 403)
  assert.equal(agentDenied.body.module, 'ai_agent')

  const writeDenied = await request(`/api/conversational-agent/states/${fixture.contactId}`, {
    actor: 'reader', method: 'POST', body: { action: 'pause' }
  })
  assert.equal(writeDenied.status, 403)
  assert.equal(writeDenied.body.code, 'write_access_required')
  assert.equal((await request('/api/conversational-agent/states', { actor: 'reader' })).status, 200)
  assert.equal((await request('/api/unrelated-public-route', { actor: 'anonymous' })).status, 200)
})

test('las URLs existentes de Costos siguen resolviendo todos sus endpoints', async () => {
  const created = await request('/api/costs', {
    actor: 'costsOnly', method: 'POST',
    body: { name: 'Route isolation cost', type: 'general', calculation_type: 'fixed', value: 0 }
  })
  fixture.costId = created.body.cost?.id
  assert.equal(created.status, 201)
  assert.ok(fixture.costId)
  const path = `/api/costs/${fixture.costId}`
  assert.equal((await request(path, { actor: 'costsOnly' })).body.cost.id, fixture.costId)
  const updated = await request(path, {
    actor: 'costsOnly', method: 'PUT', body: { name: 'Updated route isolation cost' }
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.cost.name, 'Updated route isolation cost')
  assert.equal((await request('/api/costs/calculate', {
    actor: 'costsOnly', method: 'POST', body: { revenue: 0 }
  })).status, 200)
  assert.equal((await request(path, { actor: 'costsOnly', method: 'DELETE' })).status, 200)
  assert.equal((await db.get('SELECT is_active FROM costs WHERE id = ?', [fixture.costId])).is_active, 0)
})
