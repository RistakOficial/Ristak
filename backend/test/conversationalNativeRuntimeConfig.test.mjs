import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createConversationalAgent,
  getConversationalAgent,
  getConversationalNativeRuntimeResourceValidationErrors,
  updateConversationalAgent,
  assertAgentGoalRequirements
} from '../src/services/conversationalAgentService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { createAgent as createAgentController } from '../src/controllers/conversationalAgentController.js'
import * as nativeRuntimeConfig from '../src/agents/conversational/nativeRuntimeConfig.js'

const {
  DEFAULT_CONVERSATIONAL_PERSONALITY_INSTRUCTIONS,
  DEFAULT_CONVERSATIONAL_STRATEGY_INSTRUCTIONS,
  DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS,
  buildConversationalCapabilityManifest,
  getConversationalCapability,
  getConversationalCapabilitiesConfig,
  normalizeConversationalCapabilitiesConfig,
  normalizeConversationalPromptConfig
} = nativeRuntimeConfig

async function removeAgent(agentId) {
  if (!agentId) return
  await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agentId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_learning_versions WHERE agent_id = ?', [agentId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
}

function uniqueTagFilters(tag) {
  return {
    entry: {
      groups: [{
        conditions: [{
          category: 'tags',
          params: [{ field: 'tag', operator: 'has', value: tag }]
        }]
      }]
    },
    exit: { groups: [] }
  }
}

test('normalizadores nativos conservan texto vacío explícito y descartan capacidades desconocidas', () => {
  const prompt = normalizeConversationalPromptConfig({
    schemaVersion: 99,
    templateVersion: 'custom-v7',
    editableText: ''
  }, { materializeDefault: true })
  assert.deepEqual(prompt, {
    schemaVersion: 2,
    templateVersion: 'custom-v7',
    strategyText: '',
    personalityText: '',
    editableText: ''
  })

  const capabilities = normalizeConversationalCapabilitiesConfig({
    schemaVersion: 99,
    items: [
      { id: 'unknown_tool', enabled: true },
      { id: 'schedule_appointment', enabled: true, calendarId: 'cal_real', allowOverlaps: true },
      { id: 'handoff_human', enabled: true }
    ]
  })
  assert.equal(capabilities.schemaVersion, 2)
  assert.equal(capabilities.safetyPolicy.enabled, true)
  assert.equal(capabilities.testMode.enabled, false)
  assert.deepEqual(capabilities.items, [
    {
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'cal_real',
      bookingOwner: 'ai',
      handoffUserId: '',
      handoffUserName: '',
      allowOverlaps: true
    },
    {
      id: 'handoff_human',
      enabled: true,
      rules: '',
      userId: '',
      userName: '',
      pastClientsToHuman: false
    }
  ])
})

test('Datos requeridos conserva sólo condiciones estructuradas que el servidor puede comprobar', () => {
  const capabilities = normalizeConversationalCapabilitiesConfig({
    dataRequirements: {
      enabled: true,
      fields: [
        {
          field: 'email',
          level: 'conditional',
          scope: 'any_action',
          condition: {
            fact: 'appointment.primary_attendee_is_different',
            operator: 'is_true',
            value: true
          }
        },
        {
          field: 'phone',
          level: 'conditional',
          scope: 'payment',
          condition: 'si parece necesario'
        }
      ],
      participants: {
        enabled: true,
        guestFields: []
      }
    }
  })

  assert.deepEqual(capabilities.dataRequirements.fields[0], {
    field: 'email',
    level: 'conditional',
    scope: 'appointment',
    condition: {
      fact: 'appointment.primary_attendee_is_different',
      operator: 'is_true',
      value: true
    }
  })
  assert.deepEqual(capabilities.dataRequirements.fields[1], {
    field: 'phone',
    level: 'optional',
    scope: 'payment'
  })
  assert.deepEqual(capabilities.dataRequirements.participants.guestFields, [])
})

test('agendar normaliza quién termina la cita y el manifest expone ese contrato', () => {
  const human = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'cal_human',
      bookingOwner: 'human',
      handoffUserId: '42',
      handoffUserName: 'Mariana'
    }]
  })
  assert.deepEqual(human.items[0], {
    id: 'schedule_appointment',
    enabled: true,
    calendarId: 'cal_human',
    bookingOwner: 'human',
    handoffUserId: '42',
    handoffUserName: 'Mariana',
    allowOverlaps: false
  })
  assert.equal(
    buildConversationalCapabilityManifest({ capabilitiesConfig: human })
      .find((item) => item.id === 'schedule_appointment')?.bookingOwner,
    'human'
  )

  const automatic = normalizeConversationalCapabilitiesConfig({
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'cal_ai',
      bookingOwner: 'valor_invalido',
      handoffUserId: 'no_debe_quedar',
      handoffUserName: 'Tampoco'
    }]
  }).items[0]
  assert.equal(automatic.bookingOwner, 'ai')
  assert.equal(automatic.handoffUserId, '')
  assert.equal(automatic.handoffUserName, '')
})

test('publicar agenda humana valida que la persona asignada siga activa', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_human_owner_${suffix}`
  const username = `human_owner_${suffix}`
  let userId = ''
  const config = (handoffUserId) => ({
    enabled: true,
    capabilitiesConfig: {
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'human',
        handoffUserId
      }]
    }
  })

  try {
    await db.run('INSERT INTO calendars (id, name, is_active) VALUES (?, ?, 1)', [calendarId, 'Agenda humana'])
    let errors = await getConversationalNativeRuntimeResourceValidationErrors(config('999999999'))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_SCHEDULE_HANDOFF_USER_NOT_FOUND')

    await db.run(
      'INSERT INTO users (username, password_hash, full_name, is_active) VALUES (?, ?, ?, 0)',
      [username, 'test-hash', 'Usuario agenda humana']
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username])).id)
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config(userId))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_SCHEDULE_HANDOFF_USER_INACTIVE')

    await db.run('UPDATE users SET is_active = 1 WHERE id = ?', [userId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config(userId))
    assert.deepEqual(errors, [])
  } finally {
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('prompt schema 2 conserva textos largos completos y migra schema 1 sin adivinar personalidad', () => {
  const legacyText = `${'estrategia larga con acento y emoji 🙂\n'.repeat(1600)}MARCADOR_FINAL_LEGACY`
  assert.ok(legacyText.length > 50_000)

  const migrated = normalizeConversationalPromptConfig({
    schemaVersion: 1,
    templateVersion: 'legacy-v1',
    editableText: legacyText
  }, { materializeDefault: true })
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.strategyText, legacyText)
  assert.equal(migrated.personalityText, '')
  assert.equal(migrated.editableText, legacyText)

  const personalityText = `${'cálido, directo y humano\n'.repeat(900)}MARCADOR_FINAL_PERSONALIDAD`
  const split = normalizeConversationalPromptConfig({
    schemaVersion: 2,
    strategyText: legacyText,
    personalityText
  }, { materializeDefault: true })
  assert.equal(split.strategyText, legacyText)
  assert.equal(split.personalityText, personalityText)
  assert.match(split.editableText, /MARCADOR_FINAL_LEGACY/)
  assert.match(split.editableText, /MARCADOR_FINAL_PERSONALIDAD/)
})

test('paymentMode elimina residuos de anticipo que antes bloqueaban Publicar con campos ocultos', () => {
  const capabilities = normalizeConversationalCapabilitiesConfig({
    schemaVersion: 1,
    items: [{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'full_payment',
      productId: 'product_real',
      priceId: 'price_real',
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: null,
        currency: 'MXN',
        methods: { paymentLink: true }
      }
    }]
  })
  const payment = capabilities.items[0]
  assert.equal(payment.paymentMode, 'full_payment')
  assert.equal(payment.deposit.enabled, false)
  assert.equal(buildConversationalCapabilityManifest({ capabilitiesConfig: capabilities })
    .find((item) => item.id === 'collect_payment')?.ready, true)
})

test('los anticipos respetan la precisión de la moneda configurada', () => {
  const capabilities = normalizeConversationalCapabilitiesConfig({
    schemaVersion: 1,
    items: [
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        deposit: { enabled: true, amount: 12.3456, currency: 'KWD' }
      }
    ]
  })
  assert.equal(capabilities.items[0].deposit.amount, 12.346)

  const zeroDecimal = normalizeConversationalCapabilitiesConfig({
    schemaVersion: 1,
    items: [
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        deposit: { enabled: true, amount: 12.6, currency: 'JPY' }
      }
    ]
  })
  assert.equal(zeroDecimal.items[0].deposit.amount, 13)
})

test('campos viejos nunca habilitan capacidades nativas', () => {
  const capabilities = getConversationalCapabilitiesConfig({
    objective: 'citas',
    successAction: 'book_appointment',
    defaultCalendarId: 'cal_stored_deposit',
    goalWorkflow: {
      appointments: { owner: 'ai', calendarId: 'cal_stored_deposit' },
      sales: { paymentMode: 'full_payment' },
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 300,
        maxAmount: 800,
        currency: 'MXN',
        methods: { paymentLink: true, bankTransfer: false }
      },
      attention: { pastClientsToHuman: true }
    }
  })
  assert.equal(capabilities.schemaVersion, 2)
  assert.deepEqual(capabilities.items, [])
  assert.equal(capabilities.safetyPolicy.enabled, true)
  assert.equal(capabilities.testMode.enabled, false)
})

test('los filtros por palabras del mensaje se descartan y no pueden silenciar al agente', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Sin filtros léxicos',
      enabled: false,
      filters: {
        entry: {
          groups: [{
            conditions: [{
              category: 'message',
              params: [{ field: 'text', operator: 'contains', value: 'cita' }]
            }]
          }]
        },
        exit: { groups: [] }
      }
    })
    assert.deepEqual(agent.filters.entry.groups, [])
  } finally {
    await removeAgent(agent?.id)
  }
})

test('agente nuevo nace con plantilla materializada, capacidades nativas y sin selector público de runtime', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Agente nativo por default',
      enabled: false,
      objective: 'citas',
      successAction: 'book_appointment',
      defaultCalendarId: 'cal_native_default',
      goalWorkflow: {
        appointments: {
          owner: 'ai',
          calendarId: 'cal_native_default',
          allowOverlappingAppointments: true
        }
      },
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId: 'cal_native_default' }]
      }
    })

    assert.equal(Object.hasOwn(agent, 'runtimeMode'), false)
    assert.equal(agent.promptConfig.editableText, DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS)
    assert.equal(agent.promptConfig.schemaVersion, 2)
    assert.equal(agent.promptConfig.strategyText, DEFAULT_CONVERSATIONAL_STRATEGY_INSTRUCTIONS)
    assert.equal(agent.promptConfig.personalityText, DEFAULT_CONVERSATIONAL_PERSONALITY_INSTRUCTIONS)
    assert.equal(getConversationalCapability(agent, 'schedule_appointment')?.calendarId, 'cal_native_default')
    assert.equal(Object.hasOwn(agent, 'migrationCapabilitiesConfig'), false)
    assert.equal(agent.capabilityManifest.find((item) => item.id === 'schedule_appointment')?.ready, true)

    const row = await db.get(
      'SELECT runtime_mode, prompt_config, capabilities_config FROM conversational_agents WHERE id = ?',
      [agent.id]
    )
    assert.equal(row.runtime_mode, 'tool_calling_v2')
    assert.equal(JSON.parse(row.prompt_config).editableText, DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS)
    assert.equal(JSON.parse(row.capabilities_config).schemaVersion, 2)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('crear, leer y parchear instrucciones largas conserva ambos campos completos', async () => {
  let agent = null
  const strategyText = `${'Proceso real del negocio con ñ y saltos.\n'.repeat(1800)}FIN_ESTRATEGIA`
  const personalityText = `${'Tono humano y breve 🙂\n'.repeat(900)}FIN_PERSONALIDAD`
  try {
    agent = await createConversationalAgent({
      name: 'Prompt largo sin recortes',
      enabled: false,
      promptConfig: { schemaVersion: 2, strategyText, personalityText }
    })
    assert.equal(agent.promptConfig.strategyText, strategyText)
    assert.equal(agent.promptConfig.personalityText, personalityText)

    const stored = JSON.parse((await db.get(
      'SELECT prompt_config FROM conversational_agents WHERE id = ?',
      [agent.id]
    )).prompt_config)
    assert.equal(stored.strategyText, strategyText)
    assert.equal(stored.personalityText, personalityText)

    const changedPersonality = `${personalityText}\nSEGUNDO_FINAL`
    agent = await updateConversationalAgent(agent.id, {
      promptConfig: { personalityText: changedPersonality }
    })
    assert.equal(agent.promptConfig.strategyText, strategyText)
    assert.equal(agent.promptConfig.personalityText, changedPersonality)
    assert.match(agent.promptConfig.editableText, /FIN_ESTRATEGIA/)
    assert.match(agent.promptConfig.editableText, /SEGUNDO_FINAL/)

    agent = await updateConversationalAgent(agent.id, {
      promptConfig: {
        schemaVersion: 1,
        templateVersion: agent.promptConfig.templateVersion,
        editableText: agent.promptConfig.editableText
      }
    })
    assert.equal(agent.promptConfig.strategyText, strategyText)
    assert.equal(agent.promptConfig.personalityText, changedPersonality)

    const legacyMobileEdit = `${'Edición desde cliente anterior.\n'.repeat(700)}FIN_CLIENTE_ANTERIOR`
    agent = await updateConversationalAgent(agent.id, {
      promptConfig: {
        ...agent.promptConfig,
        editableText: legacyMobileEdit
      }
    })
    assert.equal(agent.promptConfig.strategyText, legacyMobileEdit)
    assert.equal(agent.promptConfig.personalityText, '')
    assert.equal(agent.promptConfig.editableText, legacyMobileEdit)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('entradas obsoletas de runtime y migración se ignoran y nunca alteran la configuración nativa', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Entrada obsoleta ignorada',
      enabled: false,
      runtimeMode: 'legacy_v1',
      objective: 'citas',
      successAction: 'book_appointment',
      goalWorkflow: {
        appointments: { owner: 'ai', calendarId: 'calendar_stored_config' },
        deposit: {
          enabled: true,
          mode: 'range',
          minAmount: 250,
          maxAmount: 600,
          currency: 'MXN',
          methods: { paymentLink: true, bankTransfer: false }
        },
        attention: { pastClientsToHuman: true }
      },
      migrationCapabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'forged', enabled: true }]
      }
    })

    assert.equal(Object.hasOwn(agent, 'runtimeMode'), false)
    assert.equal(Object.hasOwn(agent, 'migrationCapabilitiesConfig'), false)
    assert.equal(agent.capabilitiesConfig.items.some((item) => item.id === 'forged'), false)
    assert.equal(agent.capabilitiesConfig.schemaVersion, 2)
    assert.deepEqual(agent.capabilitiesConfig.items, [])
    assert.equal(agent.capabilitiesConfig.safetyPolicy.enabled, true)
    assert.equal(agent.capabilitiesConfig.testMode.enabled, false)

    const storedBeforeUpdate = await db.get(
      'SELECT runtime_mode FROM conversational_agents WHERE id = ?',
      [agent.id]
    )
    assert.equal(storedBeforeUpdate.runtime_mode, 'tool_calling_v2')

    const capabilitiesBeforeStaleUpdate = agent.capabilitiesConfig
    agent = await updateConversationalAgent(agent.id, {
      runtimeMode: 'another_removed_runtime',
      objective: 'custom',
      customObjective: 'Llevar al diagnóstico',
      successAction: 'send_trigger_link',
      goalWorkflow: {
        triggerLink: {
          triggerLinkId: 'trigger_stale_custom',
          triggerLinkUrl: 'https://example.test/diagnostico'
        }
      },
      migrationCapabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'forged_again', enabled: true }]
      }
    })
    assert.deepEqual(agent.capabilitiesConfig, capabilitiesBeforeStaleUpdate)
    assert.equal(agent.capabilitiesConfig.items.some((item) => item.id === 'forged_again'), false)
    assert.equal(
      (await db.get('SELECT runtime_mode FROM conversational_agents WHERE id = ?', [agent.id])).runtime_mode,
      'tool_calling_v2'
    )
  } finally {
    await removeAgent(agent?.id)
  }
})

test('updates conservan prompt vacío y capacidades nativas aunque llegue un selector obsoleto', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Agente nativo editable',
      enabled: false,
      promptConfig: {
        schemaVersion: 1,
        templateVersion: 'custom-empty-v1',
        editableText: ''
      },
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          {
            id: 'collect_payment',
            enabled: true,
            productId: 'prod_verified',
            priceId: 'price_verified',
            paymentMode: 'full_payment'
          },
          { id: 'handoff_human', enabled: true, rules: 'Si pide una excepción.' }
        ]
      },
      capabilityManifest: [{ id: 'forged', locked: false, ready: true }]
    })

    assert.equal(agent.promptConfig.editableText, '')
    assert.equal(agent.capabilityManifest.length, 5)
    assert.equal(agent.capabilityManifest.every((item) => item.locked === true), true)
    assert.equal(agent.capabilityManifest.some((item) => item.id === 'forged'), false)

    const beforeCapabilities = agent.capabilitiesConfig
    const updated = await updateConversationalAgent(agent.id, { name: 'Renombrado por cliente viejo' })
    assert.equal(Object.hasOwn(updated, 'runtimeMode'), false)
    assert.equal(updated.promptConfig.editableText, '')
    assert.deepEqual(updated.capabilitiesConfig, beforeCapabilities)

    const afterStaleInput = await updateConversationalAgent(agent.id, {
      runtimeMode: 'legacy_v1',
      // Clientes viejos pueden reenviar campos obsoletos o null; no deben borrar
      // la configuración nativa ni reactivar otro motor.
      promptConfig: null,
      capabilitiesConfig: null,
      migrationCapabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'forged', enabled: true }]
      }
    })
    assert.equal(Object.hasOwn(afterStaleInput, 'runtimeMode'), false)
    assert.equal(Object.hasOwn(afterStaleInput, 'migrationCapabilitiesConfig'), false)
    assert.equal(afterStaleInput.promptConfig.editableText, '')
    assert.deepEqual(afterStaleInput.capabilitiesConfig, beforeCapabilities)

    const stored = await db.get(
      'SELECT runtime_mode, prompt_config, capabilities_config FROM conversational_agents WHERE id = ?',
      [agent.id]
    )
    assert.equal(stored.runtime_mode, 'tool_calling_v2')
    assert.equal(JSON.parse(stored.prompt_config).editableText, '')
    assert.deepEqual(JSON.parse(stored.capabilities_config), beforeCapabilities)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('fila existente sin configuración materializada no revive capacidades anteriores', async () => {
  const agentId = `cagent_native_${randomUUID()}`
  try {
    await db.run(
      'INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 0)',
      [agentId, 'Agente anterior compatible']
    )
    const agent = await getConversationalAgent(agentId)
    assert.equal(Object.hasOwn(agent, 'runtimeMode'), false)
    assert.equal(Object.hasOwn(agent, 'migrationCapabilitiesConfig'), false)
    assert.equal(agent.promptConfig.editableText, DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS)
    assert.equal(agent.capabilitiesConfig.schemaVersion, 2)
    assert.deepEqual(agent.capabilitiesConfig.items, [])
    assert.equal(agent.capabilitiesConfig.safetyPolicy.enabled, true)
    assert.equal(agent.capabilitiesConfig.testMode.enabled, false)

    const manifest = buildConversationalCapabilityManifest(agent)
    assert.equal(manifest.every((item) => item.enabled === false), true)
    assert.equal(manifest.every((item) => item.locked === true), true)
  } finally {
    await removeAgent(agentId)
  }
})

test('validación nativa bloquea capacidades incompletas sólo al publicar', () => {
  const config = (item, enabled = true) => ({
    enabled,
    objective: 'custom',
    goalWorkflow: {},
    capabilitiesConfig: { schemaVersion: 1, items: [item] }
  })

  assert.throws(
    () => assertAgentGoalRequirements(config({ id: 'schedule_appointment', enabled: true })),
    /calendario activo/i
  )
  assert.throws(
    () => assertAgentGoalRequirements(config({ id: 'collect_payment', enabled: true, paymentMode: 'full_payment' })),
    /producto y un precio verificables/i
  )
  assert.throws(
    () => assertAgentGoalRequirements(config({ id: 'send_link', enabled: true, linkKind: 'verified_goal' })),
    /enlace verificable/i
  )
  assert.throws(
    () => assertAgentGoalRequirements(config({ id: 'custom_goal', enabled: true })),
    /objetivo propio/i
  )
  assert.throws(
    () => assertAgentGoalRequirements(config({
      id: 'custom_goal',
      enabled: true,
      description: 'Llevar a la persona al registro',
      completion: 'send_link'
    })),
    /activa y configura la capacidad Mandar enlace/i
  )
  const dependentCustomManifest = buildConversationalCapabilityManifest(config({
    id: 'custom_goal',
    enabled: true,
    description: 'Llevar a la persona al registro',
    completion: 'send_link'
  }))
  assert.equal(dependentCustomManifest.find((item) => item.id === 'custom_goal')?.ready, false)

  assert.doesNotThrow(() => assertAgentGoalRequirements(config({
    id: 'collect_payment',
    enabled: true,
    productId: 'prod_ok',
    priceId: 'price_ok',
    paymentMode: 'full_payment'
  })))
  assert.doesNotThrow(() => assertAgentGoalRequirements(config({
    id: 'collect_payment',
    enabled: true,
    paymentMode: 'deposit',
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: 500,
      methods: { paymentLink: true, bankTransfer: false }
    }
  })))
  assert.doesNotThrow(() => assertAgentGoalRequirements(config({
    id: 'schedule_appointment',
    enabled: true,
    calendarId: 'cal_ok'
  })))
  assert.doesNotThrow(() => assertAgentGoalRequirements({
    enabled: true,
    objective: 'citas',
    defaultCalendarId: '',
    goalWorkflow: { appointments: { calendarId: '' } },
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId: 'cal_from_native_capability',
        allowOverlaps: true
      }]
    }
  }))
  assert.doesNotThrow(() => assertAgentGoalRequirements({
    enabled: true,
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [
        {
          id: 'custom_goal',
          enabled: true,
          description: 'Llevar a la persona al registro',
          completion: 'send_link'
        },
        {
          id: 'send_link',
          enabled: true,
          linkKind: 'verified_goal',
          url: 'https://example.test/registro'
        }
      ]
    }
  }))
  assert.doesNotThrow(() => assertAgentGoalRequirements(config({
    id: 'schedule_appointment',
    enabled: true
  }, false)))
})

test('publicar exige calendario existente y activo sin persistir un update fallido', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_publish_${suffix}`
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Draft calendario real',
      enabled: false,
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId }]
      },
      filters: uniqueTagFilters(`calendar-native-${suffix}`)
    })
    assert.equal(agent.enabled, false)

    await assert.rejects(
      () => updateConversationalAgent(agent.id, { enabled: true }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_NOT_FOUND'
    )
    assert.equal(Number((await db.get('SELECT enabled FROM conversational_agents WHERE id = ?', [agent.id])).enabled), 0)

    await db.run(
      'INSERT INTO calendars (id, name, is_active) VALUES (?, ?, 0)',
      [calendarId, 'Calendario publicación nativa']
    )
    await assert.rejects(
      () => updateConversationalAgent(agent.id, { enabled: true }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_INACTIVE'
    )

    await db.run('UPDATE calendars SET is_active = 1 WHERE id = ?', [calendarId])
    agent = await updateConversationalAgent(agent.id, { enabled: true })
    assert.equal(agent.enabled, true)

    await db.run('UPDATE calendars SET is_active = 0 WHERE id = ?', [calendarId])
    await assert.rejects(
      () => updateConversationalAgent(agent.id, { name: 'No debe persistirse' }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_INACTIVE'
    )
    assert.equal(
      (await db.get('SELECT name FROM conversational_agents WHERE id = ?', [agent.id])).name,
      'Draft calendario real'
    )
  } finally {
    await removeAgent(agent?.id)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('create rechaza URL no web antes de insertar el agente', async () => {
  const suffix = randomUUID()
  await assert.rejects(
    () => createConversationalAgent({
      name: `URL inválida ${suffix}`,
      enabled: true,
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'send_link',
          enabled: true,
          linkKind: 'verified_goal',
          url: 'javascript:alert(1)'
        }]
      },
      filters: uniqueTagFilters(`invalid-url-${suffix}`)
    }),
    (error) => error.code === 'CONVERSATIONAL_CAPABILITY_LINK_URL_INVALID'
  )
  const row = await db.get('SELECT id FROM conversational_agents WHERE name = ?', [`URL inválida ${suffix}`])
  assert.equal(row, null)
})

test('validación real cruza producto-precio, trigger link y moneda del anticipo', async () => {
  const suffix = randomUUID()
  const productId = `product_native_${suffix}`
  const otherProductId = `product_native_other_${suffix}`
  const priceId = `price_native_${suffix}`
  const triggerLinkId = `trigger_native_${suffix}`
  const username = `native_handoff_${suffix}`
  let userId = null
  let paymentAgent = null
  let highLevelConfigSnapshot = null
  let insertedHighLevelConfigId = null
  const accountCurrency = String(await getAccountCurrency()).toUpperCase()
  const foreignCurrency = accountCurrency === 'USD' ? 'MXN' : 'USD'
  const config = (items) => ({
    enabled: true,
    capabilitiesConfig: {
      schemaVersion: 1,
      items: items.map((item) => item.id === 'collect_payment'
        ? { gateway: 'highlevel', expirationMinutes: 1440, ...item }
        : item)
    }
  })

  try {
    highLevelConfigSnapshot = await db.get(
      'SELECT id, location_id, api_token, ghl_invoice_mode FROM highlevel_config LIMIT 1'
    )
    if (highLevelConfigSnapshot) {
      await db.run(
        "UPDATE highlevel_config SET location_id = ?, api_token = ?, ghl_invoice_mode = 'live' WHERE id = ?",
        [`location_native_${suffix}`, `token_native_${suffix}`, highLevelConfigSnapshot.id]
      )
    } else {
      const inserted = await db.run(
        "INSERT INTO highlevel_config (location_id, api_token, ghl_invoice_mode) VALUES (?, ?, 'live')",
        [`location_native_${suffix}`, `token_native_${suffix}`]
      )
      insertedHighLevelConfigId = inserted.lastID
    }
    await db.run(
      `INSERT INTO products (id, name, currency, is_active)
       VALUES (?, ?, ?, 0), (?, ?, ?, 1)`,
      [
        productId, 'Producto nativo', accountCurrency,
        otherProductId, 'Otro producto nativo', accountCurrency
      ]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, amount, currency)
       VALUES (?, ?, ?, ?, ?)`,
      [priceId, otherProductId, 'Precio nativo', 450, accountCurrency]
    )

    let errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.equal(errors.some((item) => item.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_PRODUCT_INACTIVE'), true)
    assert.equal(errors.some((item) => item.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_PRODUCT_MISMATCH'), true)

    await db.run('UPDATE products SET is_active = 1 WHERE id = ?', [productId])
    await db.run('UPDATE product_prices SET product_id = ? WHERE id = ?', [productId, priceId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.deepEqual(errors, [])

    await db.run('UPDATE product_prices SET amount = 0 WHERE id = ?', [priceId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.equal(errors.some((item) => item.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_AMOUNT_INVALID'), true)

    paymentAgent = await createConversationalAgent({
      name: `Draft full payment ${suffix}`,
      enabled: false,
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'collect_payment',
          enabled: true,
          productId,
          priceId,
          paymentMode: 'full_payment',
          gateway: 'highlevel',
          expirationMinutes: 1440
        }]
      },
      filters: uniqueTagFilters(`full-payment-${suffix}`)
    })
    await assert.rejects(
      () => updateConversationalAgent(paymentAgent.id, { enabled: true }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_AMOUNT_INVALID'
    )
    assert.equal(Number((await db.get('SELECT enabled FROM conversational_agents WHERE id = ?', [paymentAgent.id])).enabled), 0)

    await db.run(
      'UPDATE product_prices SET amount = ?, currency = ? WHERE id = ?',
      [450, foreignCurrency, priceId]
    )
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.equal(errors.some((item) => item.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_CURRENCY_MISMATCH'), true)
    await assert.rejects(
      () => updateConversationalAgent(paymentAgent.id, { enabled: true }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_CURRENCY_MISMATCH'
    )

    await db.run('UPDATE products SET currency = ? WHERE id = ?', [foreignCurrency, productId])
    await db.run('UPDATE product_prices SET currency = NULL WHERE id = ?', [priceId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.equal(errors.some((item) => item.code === 'CONVERSATIONAL_CAPABILITY_PAYMENT_CURRENCY_MISMATCH'), true)

    await db.run('UPDATE products SET currency = ? WHERE id = ?', [accountCurrency, productId])
    await db.run(
      'UPDATE product_prices SET currency = ?, amount = ? WHERE id = ?',
      [accountCurrency, 450, priceId]
    )
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment'
    }]))
    assert.deepEqual(errors, [])
    paymentAgent = await updateConversationalAgent(paymentAgent.id, { enabled: true })
    assert.equal(paymentAgent.enabled, true)

    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 100,
        maxAmount: 300,
        currency: foreignCurrency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_DEPOSIT_CURRENCY_MISMATCH')

    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 300,
        maxAmount: 100,
        currency: accountCurrency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_DEPOSIT_AMOUNT_INVALID')

    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 100,
        maxAmount: 300,
        currency: accountCurrency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }]))
    assert.deepEqual(errors, [])

    await db.run(
      `INSERT INTO trigger_links (
        id, public_id, name, destination_url, active, archived
      ) VALUES (?, ?, ?, ?, 1, 0)`,
      [triggerLinkId, `public_${suffix}`, 'Trigger nativo', 'mailto:ventas@example.test']
    )
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'send_link',
      enabled: true,
      linkKind: 'trigger',
      triggerLinkId
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_LINK_URL_INVALID')

    await db.run(
      'UPDATE trigger_links SET destination_url = ?, archived = NULL WHERE id = ?',
      ['https://example.test/recurso', triggerLinkId]
    )
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'send_link',
      enabled: true,
      linkKind: 'trigger',
      triggerLinkId
    }]))
    assert.deepEqual(errors, [])

    await db.run('UPDATE trigger_links SET archived = 1 WHERE id = ?', [triggerLinkId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'send_link',
      enabled: true,
      linkKind: 'trigger',
      triggerLinkId
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_TRIGGER_LINK_INACTIVE')

    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'handoff_human',
      enabled: true,
      userId: '999999999'
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_HANDOFF_USER_NOT_FOUND')

    await db.run(
      'INSERT INTO users (username, password_hash, full_name, is_active) VALUES (?, ?, ?, 0)',
      [username, '$2b$12$000000000000000000000uY8p0rVdM7dJ7jQWmZJfP1yQWJvJcZy', 'Usuario handoff nativo']
    )
    userId = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'handoff_human',
      enabled: true,
      userId: String(userId)
    }]))
    assert.equal(errors[0]?.code, 'CONVERSATIONAL_CAPABILITY_HANDOFF_USER_INACTIVE')

    await db.run('UPDATE users SET is_active = 1 WHERE id = ?', [userId])
    errors = await getConversationalNativeRuntimeResourceValidationErrors(config([{
      id: 'handoff_human',
      enabled: true,
      userId: String(userId)
    }]))
    assert.deepEqual(errors, [])
  } finally {
    await removeAgent(paymentAgent?.id)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
    await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLinkId]).catch(() => undefined)
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => undefined)
    await db.run('DELETE FROM products WHERE id IN (?, ?)', [productId, otherProductId]).catch(() => undefined)
    if (highLevelConfigSnapshot) {
      await db.run(
        'UPDATE highlevel_config SET location_id = ?, api_token = ?, ghl_invoice_mode = ? WHERE id = ?',
        [
          highLevelConfigSnapshot.location_id,
          highLevelConfigSnapshot.api_token,
          highLevelConfigSnapshot.ghl_invoice_mode,
          highLevelConfigSnapshot.id
        ]
      ).catch(() => undefined)
    } else if (insertedHighLevelConfigId) {
      await db.run('DELETE FROM highlevel_config WHERE id = ?', [insertedHighLevelConfigId]).catch(() => undefined)
    }
  }
})

test('controller crea un agente nativo sin exponer selector ni campos de migración', async () => {
  const suffix = randomUUID()
  let createdAgent = null
  let statusCode = null
  let responseBody = null
  const response = {
    status(code) {
      statusCode = code
      return this
    },
    json(body) {
      responseBody = body
      return this
    }
  }

  try {
    await createAgentController({
      body: {
        name: `Agente controller ${suffix}`,
        enabled: false,
        runtimeMode: 'legacy_v1',
        promptConfig: {
          schemaVersion: 1,
          templateVersion: 'controller-native-v1',
          editableText: 'Responde claro y usa únicamente capacidades verificadas.'
        },
        capabilitiesConfig: {
          schemaVersion: 1,
          items: [{ id: 'handoff_human', enabled: true }]
        },
        migrationCapabilitiesConfig: {
          schemaVersion: 1,
          items: [{ id: 'forged', enabled: true }]
        },
        filters: uniqueTagFilters(`controller-native-${suffix}`)
      }
    }, response)

    assert.equal(statusCode, 201)
    assert.equal(responseBody?.success, true)
    createdAgent = responseBody?.data
    assert.ok(createdAgent?.id)
    assert.equal(Object.hasOwn(createdAgent, 'runtimeMode'), false)
    assert.equal(Object.hasOwn(createdAgent, 'migrationCapabilitiesConfig'), false)
    assert.equal(createdAgent.promptConfig.editableText, 'Responde claro y usa únicamente capacidades verificadas.')
    assert.equal(createdAgent.capabilitiesConfig.items.some((item) => item.id === 'forged'), false)
    assert.equal(
      (await db.get('SELECT runtime_mode FROM conversational_agents WHERE id = ?', [createdAgent.id])).runtime_mode,
      'tool_calling_v2'
    )
  } finally {
    await removeAgent(createdAgent?.id)
  }
})
