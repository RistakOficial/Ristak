import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  AIAgentOpenAIRequiredError,
  isAIAgentOpenAIRequiredError,
  requireOpenAIApiKey
} from '../src/services/aiAgentService.js'

test('requireOpenAIApiKey bloquea funciones de IA cuando falta el token', async () => {
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
})
