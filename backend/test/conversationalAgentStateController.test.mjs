import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { updateState } from '../src/controllers/conversationalAgentController.js'
import { createConversationalAgent } from '../src/services/conversationalAgentService.js'

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function cleanup(contactId, agentId) {
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  if (agentId) {
    await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agentId}%`]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
}

test('activar una conversación con agentId asigna ese agente al estado', async () => {
  const contactId = `conversation_agent_state_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      name: 'Agente test desktop',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'activate', agentId }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.status, 'active')
    assert.equal(res.body?.data?.agentId, agentId)
  } finally {
    await cleanup(contactId, agentId)
  }
})
