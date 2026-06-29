import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  AIAgentOpenAIRequiredError,
  deleteAIAgentToken,
  getAIAgentStatus,
  isAIAgentOpenAIRequiredError,
  requireOpenAIApiKey,
  saveAIAgentConfig
} from '../src/services/aiAgentService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

async function getStoredAIAgentConfigRow() {
  return db.get('SELECT * FROM ai_agent_config WHERE id = 1').catch(() => null)
}

async function restoreAIAgentConfigRow(row) {
  await db.run('DELETE FROM ai_agent_config WHERE id = 1').catch(() => undefined)
  if (!row) return

  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ai_agent_config (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  )
}

async function getStoredBusinessProfileRow() {
  return db.get('SELECT * FROM ai_business_profile WHERE id = 1').catch(() => null)
}

async function restoreBusinessProfileRow(row) {
  await db.run('DELETE FROM ai_business_profile WHERE id = 1').catch(() => undefined)
  if (!row) return

  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ai_business_profile (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  )
}

test('requireOpenAIApiKey bloquea funciones de IA cuando falta el token', async () => {
  const previousConfig = await getStoredAIAgentConfigRow()

  try {
    await db.run('DELETE FROM ai_agent_config')

    await assert.rejects(
      () => requireOpenAIApiKey(),
      (error) => {
        assert.equal(error instanceof AIAgentOpenAIRequiredError, true)
        assert.equal(isAIAgentOpenAIRequiredError(error), true)
        assert.equal(error.statusCode, 409)
        assert.equal(error.code, 'OPENAI_CREDENTIAL_REQUIRED')
        assert.equal(error.needsOpenAIConfig, true)
        return true
      }
    )
  } finally {
    await restoreAIAgentConfigRow(previousConfig)
  }
})

test('deleteAIAgentToken borra solo el token y conserva el contexto del agente', async () => {
  const previousConfig = await getStoredAIAgentConfigRow()
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  const userId = 987654

  try {
    await db.run('DELETE FROM ai_agent_config')
    await db.run('DELETE FROM ai_business_profile WHERE id = 1').catch(() => undefined)
    await db.run('DELETE FROM ai_agent_user_preferences WHERE user_id = ?', [userId]).catch(() => undefined)
    await initializeMasterKey()

    await saveAIAgentConfig({
      userId,
      apiKey: 'sk-test-token-abcdefghijklmnopqrstuvwxyz',
      model: 'gpt-5.4-mini',
      businessContext: 'Clinica dental',
      marketContext: '',
      idealCustomer: '',
      locationContext: '',
      competitorsContext: '',
      brandVoice: '',
      actionCustomizations: '',
      researchDomains: '',
      responseStyle: 'advisor',
      recommendationMode: 'when_useful',
      webSearchEnabled: false
    })

    const configuredStatus = await getAIAgentStatus({ userId })
    assert.equal(configuredStatus.configured, true)

    const nextStatus = await deleteAIAgentToken({ userId })
    assert.equal(nextStatus.configured, false)
    assert.equal(nextStatus.credentialStatus, 'missing')
    assert.equal(nextStatus.businessContext, 'Clinica dental')

    const row = await db.get('SELECT openai_api_key_encrypted, business_context FROM ai_agent_config WHERE id = 1')
    assert.equal(row.openai_api_key_encrypted, null)
    assert.equal(row.business_context, 'Clinica dental')
  } finally {
    await db.run('DELETE FROM ai_agent_user_preferences WHERE user_id = ?', [userId]).catch(() => undefined)
    await restoreAIAgentConfigRow(previousConfig)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})
