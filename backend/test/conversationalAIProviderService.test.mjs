import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONVERSATIONAL_AI_PROVIDER_DEFINITIONS,
  connectConversationalAIProvider,
  getDefaultConversationalModelForProvider,
  normalizeConversationalAIProvider
} from '../src/services/conversationalAIProviderService.js'
import { db } from '../src/config/database.js'
import { getAIAgentStatus } from '../src/services/aiAgentService.js'
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

test('registro de proveedores conversacionales incluye Claude con compatibilidad OpenAI', () => {
  const providerIds = CONVERSATIONAL_AI_PROVIDER_DEFINITIONS.map((provider) => provider.id)
  assert.deepEqual(providerIds, ['openai', 'gemini', 'claude', 'deepseek'])

  const claude = CONVERSATIONAL_AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === 'claude')
  assert.ok(claude)
  assert.equal(claude.label, 'Claude')
  assert.equal(claude.defaultModel, process.env.CLAUDE_CONVERSATIONAL_AGENT_MODEL || 'claude-haiku-4-5')
  assert.equal(claude.baseURL, 'https://api.anthropic.com/v1/')
  assert.equal(claude.configKey, 'conversational_ai_provider_claude_api_key_encrypted')
  assert.equal(claude.canDelete, true)

  assert.equal(normalizeConversationalAIProvider('CLAUDE'), 'claude')
  assert.equal(getDefaultConversationalModelForProvider('claude'), claude.defaultModel)
})

test('conectar OpenAI desde proveedores conversacionales guarda la credencial general de Ristak AI', async () => {
  const previousConfig = await getStoredAIAgentConfigRow()
  const originalFetch = globalThis.fetch
  const apiKey = 'sk-test-token-abcdefghijklmnopqrstuvwxyz'

  try {
    await db.run('DELETE FROM ai_agent_config WHERE id = 1').catch(() => undefined)
    await db.run(`
      INSERT INTO ai_agent_config (
        id,
        model,
        business_context,
        response_style,
        recommendation_mode,
        web_search_enabled
      ) VALUES (1, 'gpt-5.4-mini', 'Clinica dental', 'direct', 'on_request', 1)
    `)
    await initializeMasterKey()

    globalThis.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://api.openai.com/v1/models')
      assert.equal(options?.headers?.Authorization, `Bearer ${apiKey}`)
      return {
        ok: true,
        json: async () => ({ data: [] })
      }
    }

    const providers = await connectConversationalAIProvider('openai', apiKey)
    const openAIProvider = providers.find((provider) => provider.id === 'openai')
    const status = await getAIAgentStatus({})
    const row = await db.get('SELECT model, business_context, response_style, recommendation_mode, web_search_enabled FROM ai_agent_config WHERE id = 1')

    assert.equal(openAIProvider?.connected, true)
    assert.equal(openAIProvider?.defaultModel, 'gpt-5.6-luna')
    assert.equal(status.configured, true)
    assert.equal(status.model, 'gpt-5.6-luna')
    assert.equal(row.model, 'gpt-5.6-luna')
    assert.equal(row.business_context, 'Clinica dental')
    assert.equal(row.response_style, 'direct')
    assert.equal(row.recommendation_mode, 'on_request')
    assert.equal(Number(row.web_search_enabled), 1)
  } finally {
    globalThis.fetch = originalFetch
    await restoreAIAgentConfigRow(previousConfig)
  }
})
