import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createConversationalAgent,
  getAgentResponseDelayMs
} from '../src/services/conversationalAgentService.js'
import {
  getConversationalAgentPreviewResponseDelayMs,
  resolveConversationalAgentPreviewRuntimeConfig
} from '../src/agents/conversational/runner.js'

test('preview de agente nuevo no hereda configuracion del primer agente existente', async () => {
  let existingAgent = null

  try {
    existingAgent = await createConversationalAgent({
      name: 'Agente que no debe contaminar preview',
      enabled: false,
      requiredData: 'NO HEREDAR ESTE CAMPO',
      extraInstructions: 'NO HEREDAR ESTAS INSTRUCCIONES',
      responseDelay: { mode: 'fixed', fixedValue: 9, fixedUnit: 'minutes' }
    })

    const { config } = await resolveConversationalAgentPreviewRuntimeConfig({
      configOverride: {
        name: 'Borrador desde wizard',
        extraInstructions: 'Regla real del borrador'
      }
    })

    assert.equal(config.name, 'Borrador desde wizard')
    assert.equal(config.extraInstructions, 'Regla real del borrador')
    assert.equal(config.requiredData, '')
    assert.equal(config.responseDelay.mode, 'none')
  } finally {
    if (existingAgent?.id) {
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [existingAgent.id]).catch(() => undefined)
    }
  }
})

test('preview de agente existente usa su agente por id y aplica el borrador encima', async () => {
  let agent = null

  try {
    agent = await createConversationalAgent({
      name: 'Agente persistido',
      enabled: false,
      requiredData: 'Nombre completo y servicio de interes',
      extraInstructions: 'Instrucciones guardadas',
      responseDelay: { mode: 'fixed', fixedValue: 7, fixedUnit: 'seconds' }
    })

    const { config } = await resolveConversationalAgentPreviewRuntimeConfig({
      agentId: agent.id,
      configOverride: {
        extraInstructions: 'Instrucciones del editor antes de probar'
      }
    })

    assert.equal(config.name, 'Agente persistido')
    assert.equal(config.requiredData, 'Nombre completo y servicio de interes')
    assert.equal(config.extraInstructions, 'Instrucciones del editor antes de probar')
    assert.equal(config.responseDelay.mode, 'fixed')
    assert.equal(config.responseDelay.fixedValue, 7)
  } finally {
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    }
  }
})

test('preview de configuracion ignora la espera inicial antes de contestar', () => {
  const agentConfig = {
    responseDelay: { mode: 'fixed', fixedValue: 7, fixedUnit: 'seconds' }
  }

  assert.equal(getAgentResponseDelayMs(agentConfig), 7000)
  assert.equal(getConversationalAgentPreviewResponseDelayMs(agentConfig), 0)
})
