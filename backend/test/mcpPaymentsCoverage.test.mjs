import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseReady, db, setAppConfig } from '../src/config/database.js'
import { paymentCapabilityToolSpecs } from '../src/mcp/paymentCapabilityTools.js'
import { pickPaymentAutomationSettings } from '../src/services/paymentSettingsService.js'
import {
  callRegisteredMcpTool,
  getMcpRegistrySummary
} from '../src/mcp/toolRegistry.js'
import { MCP_SCOPE_VALUES } from '../src/utils/oauthTokens.js'

before(async () => {
  await databaseReady
  const migration = await readFile(
    new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url),
    'utf8'
  )
  await db.exec(migration)
})

function paymentTool(name) {
  const found = paymentCapabilityToolSpecs.find(tool => tool.name === name)
  assert.ok(found, `No existe la herramienta MCP ${name}`)
  return found
}

test('MCP expone la matriz operativa de pagos sin endpoints de secretos ni checkout público', () => {
  const expectedNames = [
    'payments_get_automation_settings',
    'payments_update_automation_settings',
    'payments_get_stats',
    'payments_get_summary',
    'payments_get_facets',
    'payments_sync_transactions',
    'payments_delete_transaction',
    'payments_create_offline_plan',
    'payments_create_stripe_plan',
    'payments_create_conekta_plan',
    'payments_create_rebill_plan',
    'payments_create_stripe_link',
    'payments_create_conekta_link',
    'payments_create_mercadopago_link',
    'payments_create_rebill_link',
    'payments_create_clip_link',
    'payments_list_stripe_saved_methods',
    'payments_refresh_stripe_saved_methods',
    'payments_list_conekta_saved_sources',
    'payments_list_rebill_saved_sources',
    'payments_charge_stripe_saved_card',
    'payments_charge_conekta_saved_card',
    'payments_charge_rebill_saved_card',
    'payments_create_highlevel_invoice',
    'payments_send_highlevel_invoice',
    'payments_record_highlevel_invoice_payment',
    'payments_sync_highlevel_invoice',
    'payments_send_highlevel_text2pay'
  ]

  assert.deepEqual(paymentCapabilityToolSpecs.map(tool => tool.name), expectedNames)
  assert.ok(paymentCapabilityToolSpecs.every(tool => tool.module === 'payments'))
  assert.ok(paymentCapabilityToolSpecs
    .filter(tool => tool.access === 'write')
    .every(tool => tool.idempotencyRequired && tool.inputSchema.required.includes('idempotencyKey')))
  assert.ok(paymentCapabilityToolSpecs.every(tool => !/config|secret|webhook|public_card|intent/i.test(tool.name)))

  const registry = getMcpRegistrySummary()
  assert.ok(registry.toolCount >= 373)
  assert.ok(registry.toolsByDomain.payments >= 61)
})

test('ajustes MCP de automatizaciones de pago son parciales y no exponen configuración sensible', async () => {
  const read = paymentTool('payments_get_automation_settings')
  assert.equal(read.scope, 'ristak.read')
  assert.deepEqual(read.additionalModules, ['settings_payments'])

  const update = paymentTool('payments_update_automation_settings')
  assert.equal(update.scope, 'ristak.write')
  assert.deepEqual(update.additionalModules, [{ module: 'settings_payments', access: 'write' }])
  assert.ok(update.inputSchema.anyOf.some(option => option.required.includes('remindersEnabled')))
  assert.ok(update.inputSchema.anyOf.some(option => option.required.includes('reminderChannel')))
  assert.equal(update.inputSchema.properties.paymentMode, undefined)
  assert.equal(update.inputSchema.properties.taxes, undefined)
  assert.equal(update.inputSchema.properties.checkout, undefined)
  assert.equal(update.inputSchema.properties.gigstackApiToken, undefined)

  const calls = []
  await update.execute({
    invoke: async (_handler, request) => {
      calls.push(request)
      return { success: true }
    }
  }, {
    remindersEnabled: true,
    reminderChannel: 'whatsapp',
    reminderContentMode: 'direct',
    idempotencyKey: 'payment-reminders-whatsapp-001'
  })

  assert.deepEqual(calls[0].body, {
    remindersEnabled: true,
    reminderChannel: 'whatsapp',
    reminderContentMode: 'direct'
  })
  assert.deepEqual(calls[0].headers, { 'idempotency-key': 'payment-reminders-whatsapp-001' })

  assert.deepEqual(pickPaymentAutomationSettings({
    automations: {
      remindersEnabled: true,
      reminderChannel: 'whatsapp',
      unknownSetting: 'omitido'
    },
    taxes: { fiscalId: 'dato-que-no-debe-salir' },
    checkout: { supportEmail: 'privado@example.test' }
  }), {
    remindersEnabled: true,
    reminderChannel: 'whatsapp'
  })
})

test('MCP guarda y relee recordatorios de pago sin devolver impuestos ni checkout', async () => {
  const context = {
    invoke: async (handler, request) => {
      let payload = null
      let statusCode = 200
      const response = {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        }
      }
      await handler({
        ...request,
        body: request.body || {},
        params: request.params || {},
        query: request.query || {},
        headers: request.headers || {}
      }, response)
      assert.ok(statusCode < 400, payload?.error || `HTTP ${statusCode}`)
      return payload
    }
  }

  try {
    const updated = await paymentTool('payments_update_automation_settings').execute(context, {
      remindersEnabled: true,
      reminderChannel: 'whatsapp',
      reminderContentMode: 'direct',
      reminderMessageText: 'Recordatorio seguro {{payment.amount}}',
      idempotencyKey: 'payment-settings-real-save-001'
    })

    assert.equal(updated.data.automations.remindersEnabled, true)
    assert.equal(updated.data.automations.reminderChannel, 'whatsapp')
    assert.equal(updated.data.automations.reminderContentMode, 'direct')
    assert.equal(updated.data.taxes, undefined)
    assert.equal(updated.data.checkout, undefined)

    const read = await paymentTool('payments_get_automation_settings').execute(context, {})
    assert.equal(read.data.automations.reminderMessageText, 'Recordatorio seguro {{payment.amount}}')
    assert.equal(read.data.taxes, undefined)
    assert.equal(read.data.checkout, undefined)
  } finally {
    await setAppConfig('payments_settings', null)
  }
})

test('planes MCP son tipados, respetan licencia y verifican el proveedor exacto', () => {
  const offline = paymentTool('payments_create_offline_plan')
  assert.deepEqual(offline.featureKeys, ['payment_plans'])
  assert.deepEqual(offline.connectionPrerequisites, [])
  assert.deepEqual(offline.inputSchema.required, [
    'contact', 'totalAmount', 'title', 'remainingPayments', 'idempotencyKey'
  ])
  assert.equal(offline.inputSchema.properties.contact.additionalProperties, false)
  assert.equal(offline.inputSchema.properties.remainingPayments.items.additionalProperties, false)
  assert.equal(
    offline.inputSchema.properties.remainingPayments.items.properties.dueDate.description,
    'Fecha de calendario o instante que Ristak interpreta con la zona horaria del negocio.'
  )

  const providers = ['stripe', 'conekta', 'rebill']
  for (const provider of providers) {
    const tool = paymentTool(`payments_create_${provider}_plan`)
    assert.deepEqual(tool.featureKeys, ['payment_plans'])
    assert.deepEqual(tool.connectionPrerequisites, [provider])
    assert.equal(tool.scope, 'ristak.execute')
  }
})

test('crear un plan offline manda fechas, moneda e idempotencia al controlador canónico', async () => {
  const tool = paymentTool('payments_create_offline_plan')
  const calls = []
  const args = {
    contact: {
      id: 'contact_1',
      name: 'Lilia Cuevas',
      email: 'lilia@example.test',
      phone: '+526561234567'
    },
    totalAmount: 125000,
    currency: 'MXN',
    title: 'Plan de cuatro pagos',
    firstPayment: {
      enabled: true,
      amount: 36250,
      date: '2026-07-31',
      method: 'bank_transfer'
    },
    remainingFrequency: 'monthly',
    remainingPayments: [
      { sequence: 1, amount: 29583.34, dueDate: '2026-08-31', frequency: 'monthly' },
      { sequence: 2, amount: 29583.33, dueDate: '2026-09-30', frequency: 'monthly' },
      { sequence: 3, amount: 29583.33, dueDate: '2026-10-31', frequency: 'monthly' }
    ],
    idempotencyKey: 'lilia-offline-plan-2026-001'
  }

  await tool.execute({
    invoke: async (_handler, request) => {
      calls.push(request)
      return { success: true, data: { flowId: 'flow_1' } }
    }
  }, args)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].headers, { 'idempotency-key': args.idempotencyKey })
  assert.equal(calls[0].body.idempotencyKey, undefined)
  assert.equal(calls[0].body.source, 'ristak_mcp_offline_plan')
  assert.deepEqual(calls[0].body.remainingPayments, args.remainingPayments)
})

test('links, tarjetas guardadas y HighLevel usan feature, conexión y payload correctos', async () => {
  const clip = paymentTool('payments_create_clip_link')
  assert.deepEqual(clip.featureKeys, ['payment_links'])
  assert.deepEqual(clip.connectionPrerequisites, ['clip'])
  assert.deepEqual(clip.inputSchema.required, ['amount', 'idempotencyKey'])

  const conektaCharge = paymentTool('payments_charge_conekta_saved_card')
  assert.deepEqual(conektaCharge.featureKeys, ['saved_payment_methods'])
  assert.deepEqual(conektaCharge.connectionPrerequisites, ['conekta'])
  assert.deepEqual(conektaCharge.inputSchema.required, [
    'contactId', 'paymentSourceId', 'amount', 'idempotencyKey'
  ])

  const calls = []
  await conektaCharge.execute({
    invoke: async (_handler, request) => {
      calls.push(request)
      return { success: true }
    }
  }, {
    contactId: 'contact_1',
    paymentSourceId: 'src_1',
    amount: 500,
    idempotencyKey: 'charge-conekta-saved-001'
  })
  assert.equal(calls[0].body.source, 'ristak_mcp_conekta_saved_card')
  assert.equal(calls[0].body.paymentSourceId, 'src_1')

  const highlevel = paymentTool('payments_send_highlevel_invoice')
  assert.deepEqual(highlevel.featureKeys, ['highlevel_integration', 'payment_links'])
  assert.deepEqual(highlevel.connectionPrerequisites, ['highlevel'])
})

test('la búsqueda MCP entiende planes offline y recordatorios en español', async () => {
  const result = await callRegisteredMcpTool({
    scopes: MCP_SCOPE_VALUES,
    user: { role: 'admin', permissions: { payments: 'write', settings_api_access: 'read' } },
    baseUrl: 'https://ristak.example.test'
  }, 'mcp_search_capabilities', {
    query: 'crear plan de pagos offline con recordatorios',
    domain: 'payments',
    risk: 'execute',
    limit: 10
  })

  assert.ok(result.tools.length > 0)
  assert.equal(result.tools[0].name, 'payments_create_offline_plan')
})

test('la búsqueda MCP prioriza el ajuste correcto al activar recordatorios de pago', async () => {
  const result = await callRegisteredMcpTool({
    scopes: MCP_SCOPE_VALUES,
    user: {
      role: 'admin',
      permissions: {
        payments: 'write',
        settings_payments: 'write',
        settings_api_access: 'read'
      }
    },
    baseUrl: 'https://ristak.example.test'
  }, 'mcp_search_capabilities', {
    query: 'activar recordatorios de pago por whatsapp',
    domain: 'payments',
    access: 'write',
    risk: 'write',
    limit: 10
  })

  assert.ok(result.tools.length > 0)
  assert.equal(result.tools[0].name, 'payments_update_automation_settings')
})
