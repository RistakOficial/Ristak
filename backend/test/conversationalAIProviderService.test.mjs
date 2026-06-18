import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONVERSATIONAL_AI_PROVIDER_DEFINITIONS,
  getDefaultConversationalModelForProvider,
  normalizeConversationalAIProvider
} from '../src/services/conversationalAIProviderService.js'

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
