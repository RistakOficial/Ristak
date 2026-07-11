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
import { assertCompiledPolicyValid } from '../src/controllers/conversationalAgentController.js'
import {
  DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS,
  buildConversationalCapabilityManifest,
  deriveLegacyCapabilitiesConfig,
  getConversationalCapability,
  getConversationalPromptConfig,
  normalizeConversationalCapabilitiesConfig,
  normalizeConversationalPromptConfig
} from '../src/agents/conversational/nativeRuntimeConfig.js'

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

test('normalizadores v2 conservan texto vacío explícito y descartan capacidades desconocidas', () => {
  const prompt = normalizeConversationalPromptConfig({
    schemaVersion: 99,
    templateVersion: 'custom-v7',
    editableText: ''
  }, { materializeDefault: true })
  assert.deepEqual(prompt, {
    schemaVersion: 1,
    templateVersion: 'custom-v7',
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
  assert.equal(capabilities.schemaVersion, 1)
  assert.deepEqual(capabilities.items, [
    {
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'cal_real',
      allowOverlaps: false
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

test('adaptador legacy conserva cita, anticipo por rango y pase factual de clientes anteriores', () => {
  const capabilities = deriveLegacyCapabilitiesConfig({
    objective: 'citas',
    successAction: 'book_appointment',
    defaultCalendarId: 'cal_legacy_deposit',
    goalWorkflow: {
      appointments: { owner: 'ai', calendarId: 'cal_legacy_deposit' },
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
  assert.equal(capabilities.items.find((item) => item.id === 'schedule_appointment')?.enabled, true)
  const payment = capabilities.items.find((item) => item.id === 'collect_payment')
  assert.equal(payment?.paymentMode, 'deposit')
  assert.equal(payment?.deposit.mode, 'range')
  assert.equal(payment?.deposit.minAmount, 300)
  assert.equal(payment?.deposit.maxAmount, 800)
  assert.equal(capabilities.items.find((item) => item.id === 'handoff_human')?.pastClientsToHuman, true)
})

test('adaptador legacy conserva objetivo propio que termina por send_link', () => {
  const capabilities = deriveLegacyCapabilitiesConfig({
    objective: 'custom',
    customObjective: 'Llevar a la persona al diagnóstico',
    successAction: 'send_trigger_link',
    goalWorkflow: {
      triggerLink: {
        triggerLinkId: 'trigger_custom_legacy',
        triggerLinkUrl: 'https://example.test/diagnostico'
      }
    }
  })

  assert.equal(capabilities.items.find((item) => item.id === 'send_link')?.linkKind, 'trigger')
  assert.equal(capabilities.items.find((item) => item.id === 'send_link')?.triggerLinkId, 'trigger_custom_legacy')
  assert.equal(capabilities.items.find((item) => item.id === 'custom_goal')?.completion, 'send_link')
})

test('agente nuevo sin runtimeMode nace en v2 con plantilla materializada y capacidades legacy adaptadas', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Agente v2 por default',
      enabled: false,
      objective: 'citas',
      successAction: 'book_appointment',
      defaultCalendarId: 'cal_v2_default',
      goalWorkflow: {
        appointments: {
          owner: 'ai',
          calendarId: 'cal_v2_default',
          allowOverlappingAppointments: true
        }
      }
    })

    assert.equal(agent.runtimeMode, 'tool_calling_v2')
    assert.equal(agent.promptConfig.editableText, DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS)
    assert.equal(agent.promptConfig.schemaVersion, 1)
    assert.equal(getConversationalCapability(agent, 'schedule_appointment')?.calendarId, 'cal_v2_default')
    assert.deepEqual(agent.migrationCapabilitiesConfig, agent.capabilitiesConfig)
    assert.equal(agent.capabilityManifest.find((item) => item.id === 'schedule_appointment')?.ready, true)

    const row = await db.get(
      'SELECT runtime_mode, prompt_config, capabilities_config FROM conversational_agents WHERE id = ?',
      [agent.id]
    )
    assert.equal(row.runtime_mode, 'tool_calling_v2')
    assert.equal(JSON.parse(row.prompt_config).editableText, DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS)
    assert.equal(JSON.parse(row.capabilities_config).schemaVersion, 1)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('migrationCapabilitiesConfig legacy es server-derived para cita, rango y custom send_link', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Legacy migrable',
      enabled: false,
      runtimeMode: 'legacy_v1',
      objective: 'citas',
      successAction: 'book_appointment',
      goalWorkflow: {
        appointments: { owner: 'ai', calendarId: 'calendar_legacy_migration' },
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

    assert.equal(agent.capabilitiesConfig, null)
    assert.equal(agent.migrationCapabilitiesConfig.items.some((item) => item.id === 'forged'), false)
    assert.equal(agent.migrationCapabilitiesConfig.items.find((item) => item.id === 'schedule_appointment')?.calendarId, 'calendar_legacy_migration')
    assert.equal(agent.migrationCapabilitiesConfig.items.find((item) => item.id === 'collect_payment')?.deposit.mode, 'range')
    assert.equal(agent.migrationCapabilitiesConfig.items.find((item) => item.id === 'handoff_human')?.pastClientsToHuman, true)

    agent = await updateConversationalAgent(agent.id, {
      objective: 'custom',
      customObjective: 'Llevar al diagnóstico',
      successAction: 'send_trigger_link',
      goalWorkflow: {
        triggerLink: {
          triggerLinkId: 'trigger_legacy_custom',
          triggerLinkUrl: 'https://example.test/diagnostico'
        }
      },
      migrationCapabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'forged_again', enabled: true }]
      }
    })
    assert.equal(agent.migrationCapabilitiesConfig.items.find((item) => item.id === 'send_link')?.linkKind, 'trigger')
    assert.equal(agent.migrationCapabilitiesConfig.items.find((item) => item.id === 'custom_goal')?.completion, 'send_link')
    assert.equal(agent.migrationCapabilitiesConfig.items.some((item) => item.id === 'forged_again'), false)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('round-trip v2 -> legacy -> v2 conserva prompt vacío y capacidades almacenadas', async () => {
  let agent = null
  try {
    agent = await createConversationalAgent({
      name: 'Agente v2 editable',
      enabled: false,
      runtimeMode: 'tool_calling_v2',
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
    assert.equal(updated.runtimeMode, 'tool_calling_v2')
    assert.equal(updated.promptConfig.editableText, '')
    assert.deepEqual(updated.capabilitiesConfig, beforeCapabilities)

    const legacy = await updateConversationalAgent(agent.id, {
      runtimeMode: 'legacy_v1',
      // Clientes viejos pueden reenviar null; no debe borrar estado v2 dormido.
      promptConfig: null,
      capabilitiesConfig: null,
      migrationCapabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'forged', enabled: true }]
      }
    })
    assert.equal(legacy.runtimeMode, 'legacy_v1')
    assert.equal(legacy.promptConfig.editableText, '')
    assert.equal(getConversationalPromptConfig(legacy)?.editableText, '')
    assert.deepEqual(legacy.capabilitiesConfig, beforeCapabilities)
    assert.equal(legacy.migrationCapabilitiesConfig.items.some((item) => item.id === 'forged'), false)
    assert.deepEqual(legacy.migrationCapabilitiesConfig, beforeCapabilities)

    const restored = await updateConversationalAgent(agent.id, {
      runtimeMode: 'tool_calling_v2',
      promptConfig: null,
      capabilitiesConfig: null
    })
    assert.equal(restored.runtimeMode, 'tool_calling_v2')
    assert.equal(restored.promptConfig.editableText, '')
    assert.deepEqual(restored.capabilitiesConfig, beforeCapabilities)
    assert.deepEqual(restored.migrationCapabilitiesConfig, beforeCapabilities)

    const stored = await db.get(
      'SELECT prompt_config, capabilities_config FROM conversational_agents WHERE id = ?',
      [agent.id]
    )
    assert.equal(JSON.parse(stored.prompt_config).editableText, '')
    assert.deepEqual(JSON.parse(stored.capabilities_config), beforeCapabilities)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('fila existente que omite columnas v2 permanece legacy sin backfill destructivo', async () => {
  const agentId = `cagent_legacy_${randomUUID()}`
  try {
    await db.run(
      'INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 0)',
      [agentId, 'Agente legacy intacto']
    )
    const agent = await getConversationalAgent(agentId)
    assert.equal(agent.runtimeMode, 'legacy_v1')
    assert.equal(agent.promptConfig, null)
    assert.equal(agent.capabilitiesConfig, null)
    assert.equal(agent.migrationCapabilitiesConfig.items[0]?.id, 'handoff_human')

    const manifest = buildConversationalCapabilityManifest(agent)
    assert.equal(manifest.find((item) => item.id === 'handoff_human')?.enabled, true)
    assert.equal(manifest.every((item) => item.locked === true), true)
  } finally {
    await removeAgent(agentId)
  }
})

test('validación v2 bloquea capacidades incompletas sólo al publicar', () => {
  const config = (item, enabled = true) => ({
    enabled,
    runtimeMode: 'tool_calling_v2',
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
    runtimeMode: 'tool_calling_v2',
    objective: 'citas',
    defaultCalendarId: '',
    goalWorkflow: { appointments: { calendarId: '' } },
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId: 'cal_does_not_depend_on_legacy_fields',
        allowOverlaps: true
      }]
    }
  }))
  assert.doesNotThrow(() => assertAgentGoalRequirements({
    enabled: true,
    runtimeMode: 'tool_calling_v2',
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

test('publicar v2 exige calendario existente y activo sin persistir un update fallido', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_publish_${suffix}`
  let agent = null
  let legacyAgent = null
  try {
    agent = await createConversationalAgent({
      name: 'Draft calendario real',
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId }]
      },
      filters: uniqueTagFilters(`calendar-v2-${suffix}`)
    })
    assert.equal(agent.enabled, false)

    await assert.rejects(
      () => updateConversationalAgent(agent.id, { enabled: true }),
      (error) => error.code === 'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_NOT_FOUND'
    )
    assert.equal(Number((await db.get('SELECT enabled FROM conversational_agents WHERE id = ?', [agent.id])).enabled), 0)

    await db.run(
      'INSERT INTO calendars (id, name, is_active) VALUES (?, ?, 0)',
      [calendarId, 'Calendario publicación v2']
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

    // Legacy conserva su comportamiento histórico: exige un ID configurado,
    // pero no adopta la compuerta de recursos v2.
    legacyAgent = await createConversationalAgent({
      name: 'Legacy calendario externo',
      enabled: true,
      runtimeMode: 'legacy_v1',
      objective: 'citas',
      defaultCalendarId: `calendar_external_${suffix}`,
      filters: uniqueTagFilters(`calendar-legacy-${suffix}`)
    })
    assert.equal(legacyAgent.enabled, true)
  } finally {
    await removeAgent(agent?.id)
    await removeAgent(legacyAgent?.id)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('create v2 rechaza URL no web antes de insertar el agente', async () => {
  const suffix = randomUUID()
  await assert.rejects(
    () => createConversationalAgent({
      name: `URL inválida ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
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

test('validación real v2 cruza producto-precio, trigger link y moneda del anticipo', async () => {
  const suffix = randomUUID()
  const productId = `product_native_${suffix}`
  const otherProductId = `product_native_other_${suffix}`
  const priceId = `price_native_${suffix}`
  const triggerLinkId = `trigger_native_${suffix}`
  const username = `native_handoff_${suffix}`
  let userId = null
  let paymentAgent = null
  const accountCurrency = String(await getAccountCurrency()).toUpperCase()
  const foreignCurrency = accountCurrency === 'USD' ? 'MXN' : 'USD'
  const config = (items) => ({
    enabled: true,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig: { schemaVersion: 1, items }
  })

  try {
    await db.run(
      `INSERT INTO products (id, name, currency, is_active)
       VALUES (?, ?, ?, 0), (?, ?, ?, 1)`,
      [
        productId, 'Producto v2', accountCurrency,
        otherProductId, 'Otro producto v2', accountCurrency
      ]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, amount, currency)
       VALUES (?, ?, ?, ?, ?)`,
      [priceId, otherProductId, 'Precio v2', 450, accountCurrency]
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
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'collect_payment',
          enabled: true,
          productId,
          priceId,
          paymentMode: 'full_payment'
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
      [triggerLinkId, `public_${suffix}`, 'Trigger v2', 'mailto:ventas@example.test']
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
      [username, '$2b$12$000000000000000000000uY8p0rVdM7dJ7jQWmZJfP1yQWJvJcZy', 'Usuario handoff v2']
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
  }
})

test('controller conserva política legacy como auditoría pero no deja que bloquee v2', () => {
  const invalidLegacyPolicy = {
    validation: {
      valid: false,
      errors: [{ message: 'La política legacy exige un campo que v2 no usa.' }]
    }
  }

  assert.throws(
    () => assertCompiledPolicyValid(invalidLegacyPolicy, {
      enabled: true,
      effectiveConfig: { runtimeMode: 'legacy_v1' }
    }),
    /política legacy exige/i
  )
  assert.doesNotThrow(() => assertCompiledPolicyValid(invalidLegacyPolicy, {
    enabled: true,
    effectiveConfig: { runtimeMode: 'tool_calling_v2' }
  }))
})
