import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilityToolSpecs } from '../src/mcp/capabilityTools.js'
import { __mcpRegistryTestHooks } from '../src/mcp/toolRegistry.js'

function tool(name) {
  const found = capabilityToolSpecs.find(entry => entry.name === name)
  assert.ok(found, `No existe la herramienta ${name}`)
  return found
}

test('el catálogo de capacidades altas es único, acotado y no agrega campañas de Meta', () => {
  assert.equal(capabilityToolSpecs.length, 130)
  assert.equal(new Set(capabilityToolSpecs.map(entry => entry.name)).size, capabilityToolSpecs.length)

  for (const entry of capabilityToolSpecs) {
    assert.match(entry.name, /^[a-z][a-z0-9_]+$/)
    assert.ok(entry.description.length > 20, `${entry.name} necesita una descripción útil`)
    assert.ok(['read', 'write'].includes(entry.access))
    assert.ok(['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'].includes(entry.scope))
    assert.ok(Array.isArray(entry.featureKeys))
    assert.ok(Array.isArray(entry.connectionPrerequisites))
    assert.equal(entry.inputSchema.type, 'object')
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.equal(typeof entry.execute, 'function')

    if (entry.access === 'write') {
      assert.equal(entry.confirmRequired, false, `${entry.name} no debe pedir aprobación humana por acción`)
      assert.equal(entry.idempotencyRequired, true, `${entry.name} debe ser idempotente`)
      assert.equal(entry.inputSchema.properties.confirm, undefined)
      assert.equal(entry.inputSchema.properties.approvalTicket, undefined)
      assert.equal(entry.inputSchema.properties.idempotencyKey?.type, 'string')
      assert.ok(entry.inputSchema.required.includes('idempotencyKey'))
    }
  }

  const names = capabilityToolSpecs.map(entry => entry.name).join('\n')
  assert.doesNotMatch(names, /(?:campaign|adset|facebook_ads|meta_ads)/i)
  assert.equal(tool('chat_get_linked_social').access, 'read')
})

test('credenciales, contraseñas y webhooks arbitrarios quedan fuera de los schemas MCP', () => {
  const forbidden = /^(?:password|passwordHash|token|secret|apiKey|authorization|credentials)$/i
  for (const entry of capabilityToolSpecs) {
    const keys = Object.keys(entry.inputSchema.properties || {})
    assert.equal(keys.some(key => forbidden.test(key)), false, `${entry.name} acepta credenciales`)
  }

  const userUpdate = tool('settings_user_update')
  assert.equal(userUpdate.inputSchema.properties.password, undefined)
  assert.equal(userUpdate.inputSchema.properties.passwordHash, undefined)

  const disconnect = tool('integrations_disconnect')
  assert.deepEqual(
    Object.keys(disconnect.inputSchema.properties).sort(),
    ['idempotencyKey', 'provider']
  )

  const webhookTest = tool('automations_test_webhook_action')
  assert.deepEqual(
    Object.keys(webhookTest.inputSchema.properties).sort(),
    ['automationId', 'idempotencyKey', 'nodeId']
  )
})

test('los cambios parciales y mensajes WhatsApp exigen al menos un dato de negocio válido', () => {
  for (const name of [
    'settings_account_locale_update',
    'settings_profile_update',
    'settings_user_update',
    'chat_send_whatsapp_reaction',
    'chat_send_whatsapp_template'
  ]) {
    assert.ok(Array.isArray(tool(name).inputSchema.anyOf), `${name} necesita anyOf`)
    assert.ok(tool(name).inputSchema.anyOf.length >= 2)
  }
})

test('los proveedores dependientes declaran su conexión y Media reemplaza por pase efímero', () => {
  assert.deepEqual(tool('chat_send_whatsapp_template').connectionPrerequisites, ['whatsapp'])
  assert.deepEqual(tool('appointments_google_sync').connectionPrerequisites, ['google_calendar'])
  assert.deepEqual(tool('payments_create_subscription').connectionPrerequisites, ['payment_subscriptions'])

  const replace = tool('media_prepare_bunny_replace')
  assert.equal(replace.idempotencyResultMode, 'ephemeral')
  assert.ok(replace.inputSchema.required.includes('assetId'))
  assert.ok(replace.inputSchema.required.includes('sha256'))
  assert.equal(replace.inputSchema.properties.fileBase64, undefined)
  const archive = tool('media_prepare_archive_download')
  assert.equal(archive.access, 'read')
  assert.equal(archive.inputSchema.properties.assetIds.maxItems, 50)
})

test('la auditoría sigue ocultando controles heredados y bytes sensibles', () => {
  const input = {
    approvalTicket: 'ticket-firmado',
    fileBase64: 'Ynl0ZXM=',
    note: 'visible'
  }
  assert.deepEqual(__mcpRegistryTestHooks.sanitizeAuditInput(input), {
    approvalTicket: '[redacted]',
    fileBase64: '[redacted]',
    note: 'visible'
  })
  assert.equal(__mcpRegistryTestHooks.sanitizeExternal(input).approvalTicket, 'ticket-firmado')
})
