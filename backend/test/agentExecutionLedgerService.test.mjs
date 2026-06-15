import test from 'node:test'
import assert from 'node:assert/strict'
import {
  completeAgentRun,
  getAgentRunTrace,
  recordAgentStep,
  startAgentRun
} from '../src/services/agentExecutionLedgerService.js'

test('getAgentRunTrace reads traces created without userId', async () => {
  const run = await startAgentRun({
    latestUserMessage: 'consulta db',
    viewContext: { path: '/ai-agent/general' }
  })

  await recordAgentStep(run, {
    stepType: 'tool_call',
    toolName: 'run_database_query',
    input: { sql: 'SELECT COUNT(*) FROM contacts' },
    output: { ok: true }
  })
  await completeAgentRun(run, {
    status: 'completed',
    reply: 'Listo',
    model: 'test-model'
  })

  const trace = await getAgentRunTrace(run.traceId, {})

  assert.equal(trace.traceId, run.traceId)
  assert.equal(trace.status, 'completed')
  assert.equal(trace.steps.some((step) => step.toolName === 'run_database_query'), true)
})
