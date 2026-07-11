import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createAgent,
  rollbackAgentPolicy,
  saveConfig,
  updateAgent
} from '../src/controllers/conversationalAgentController.js'

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

async function restoreRow(table, row, key = 'id') {
  if (!row) return
  await db.run(`DELETE FROM ${table} WHERE ${key} = ?`, [row[key]])
  const columns = Object.keys(row)
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => row[column])
  )
}

function uniqueEntryFilter(marker) {
  return {
    entry: {
      groups: [{
        conditions: [{
          category: 'message',
          params: [{ field: 'text', operator: 'contains', value: marker }]
        }]
      }]
    },
    exit: { groups: [] }
  }
}

async function removeAgent(agentId) {
  if (!agentId) return
  await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agentId}%`]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE agent_id = ?', [agentId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
}

test('v2 crea, publica, enciende el runtime y revierte sin exigir el perfil legacy; legacy sigue bloqueado', async () => {
  const previousProfile = await db.get('SELECT * FROM ai_business_profile WHERE id = 1').catch(() => null)
  const previousGlobalEnabled = await db.get('SELECT enabled FROM conversational_agent_config WHERE id = 1')
  const marker = `prompt-gate-${randomUUID()}`
  let v2AgentId = ''
  let legacyDraftId = ''

  try {
    await db.run('DELETE FROM ai_business_profile WHERE id = 1')

    const createV2Response = createMockResponse()
    await createAgent({
      body: {
        name: `V2 sin perfil ${marker}`,
        enabled: true,
        runtimeMode: 'tool_calling_v2',
        capabilitiesConfig: { schemaVersion: 1, items: [] },
        filters: uniqueEntryFilter(marker)
      }
    }, createV2Response)

    assert.equal(createV2Response.statusCode, 201)
    assert.equal(createV2Response.body?.success, true)
    assert.equal(createV2Response.body?.data?.runtimeMode, 'tool_calling_v2')
    assert.equal(createV2Response.body?.data?.enabled, true)
    v2AgentId = createV2Response.body.data.id
    const firstPolicyVersion = createV2Response.body.data.policyVersion
    assert.ok(firstPolicyVersion)

    // Simula la instalación con el switch global apagado. El controller sólo
    // acepta la excepción si el agentId realmente pertenece a un v2 guardado.
    await db.run('UPDATE conversational_agent_config SET enabled = 0 WHERE id = 1')
    const enableRuntimeResponse = createMockResponse()
    await saveConfig({ body: { enabled: true, agentId: v2AgentId } }, enableRuntimeResponse)
    assert.equal(enableRuntimeResponse.statusCode, 200)
    assert.equal(enableRuntimeResponse.body?.data?.enabled, true)

    const updateV2Response = createMockResponse()
    await updateAgent({
      params: { agentId: v2AgentId },
      body: { enabled: true, name: `V2 publicado ${marker}` }
    }, updateV2Response)
    assert.equal(updateV2Response.statusCode, 200)
    assert.equal(updateV2Response.body?.data?.enabled, true)

    const rollbackV2Response = createMockResponse()
    await rollbackAgentPolicy({
      params: { agentId: v2AgentId, versionId: String(firstPolicyVersion) }
    }, rollbackV2Response)
    assert.equal(rollbackV2Response.statusCode, 200)
    assert.equal(rollbackV2Response.body?.data?.runtimeMode, 'tool_calling_v2')
    assert.equal(rollbackV2Response.body?.data?.enabled, true)

    const createLegacyDraftResponse = createMockResponse()
    await createAgent({
      body: {
        name: `Legacy pausado ${marker}`,
        enabled: false,
        runtimeMode: 'legacy_v1',
        defaultCalendarId: 'calendar_prompt_gate_test',
        filters: uniqueEntryFilter(`${marker}-legacy-draft`)
      }
    }, createLegacyDraftResponse)
    assert.equal(createLegacyDraftResponse.statusCode, 201)
    legacyDraftId = createLegacyDraftResponse.body.data.id

    const publishLegacyResponse = createMockResponse()
    await updateAgent({
      params: { agentId: legacyDraftId },
      body: { enabled: true }
    }, publishLegacyResponse)
    assert.equal(publishLegacyResponse.statusCode, 409)
    assert.equal(publishLegacyResponse.body?.code, 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY')

    const enableLegacyRuntimeResponse = createMockResponse()
    await saveConfig({ body: { enabled: true, agentId: legacyDraftId } }, enableLegacyRuntimeResponse)
    assert.equal(enableLegacyRuntimeResponse.statusCode, 409)
    assert.equal(enableLegacyRuntimeResponse.body?.code, 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY')

    const createLegacyEnabledResponse = createMockResponse()
    await createAgent({
      body: {
        name: `Legacy bloqueado ${marker}`,
        enabled: true,
        runtimeMode: 'legacy_v1',
        defaultCalendarId: 'calendar_prompt_gate_test',
        filters: uniqueEntryFilter(`${marker}-legacy-enabled`)
      }
    }, createLegacyEnabledResponse)
    assert.equal(createLegacyEnabledResponse.statusCode, 409)
    assert.equal(createLegacyEnabledResponse.body?.code, 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY')
  } finally {
    await removeAgent(v2AgentId)
    await removeAgent(legacyDraftId)
    await db.run('DELETE FROM ai_business_profile WHERE id = 1').catch(() => undefined)
    await restoreRow('ai_business_profile', previousProfile)
    if (previousGlobalEnabled) {
      await db.run(
        'UPDATE conversational_agent_config SET enabled = ? WHERE id = 1',
        [previousGlobalEnabled.enabled]
      ).catch(() => undefined)
    }
  }
})
