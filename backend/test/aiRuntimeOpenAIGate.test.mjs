import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  AIRuntimeOpenAIRequiredError,
  isAIRuntimeOpenAIRequiredError,
  requireOpenAIApiKey
} from '../src/services/aiRuntimeService.js'

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

test('requireOpenAIApiKey bloquea funciones de IA cuando falta el token', async () => {
  const previousConfig = await getStoredAIAgentConfigRow()

  try {
    await db.run('DELETE FROM ai_agent_config')

    await assert.rejects(
      () => requireOpenAIApiKey(),
      (error) => {
        assert.equal(error instanceof AIRuntimeOpenAIRequiredError, true)
        assert.equal(isAIRuntimeOpenAIRequiredError(error), true)
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
