import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { databaseReady, db } from '../src/config/database.js'
import { acceptUserInvitation, getUserInvitationInfo } from '../src/controllers/userAccessController.js'
import { __mcpRegistryTestHooks } from '../src/mcp/toolRegistry.js'
import {
  acknowledgeMcpBusinessEvents,
  listMcpBusinessEvents,
  recordMcpBusinessEvent
} from '../src/services/mcpEventInboxService.js'
import { runMcpDataMaintenance } from '../src/services/mcpMaintenanceService.js'
import { registerOAuthClient } from '../src/utils/oauthTokens.js'

const fixture = {
  userId: null,
  clientId: '',
  grantId: `grant_${crypto.randomBytes(24).toString('base64url')}`,
  invitedEmail: `mcp-invited-${crypto.randomUUID()}@example.test`
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      return this
    }
  }
}

function mcpContext() {
  return {
    user: { id: fixture.userId, userId: fixture.userId, role: 'admin', email: 'mcp-readiness@example.test' },
    mcpUser: { id: fixture.userId, clientId: fixture.clientId, grantId: fixture.grantId },
    scopes: ['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive']
  }
}

before(async () => {
  await databaseReady
  for (const filename of [
    '129_mcp_oauth_control_plane.sqlite.sql',
    '151_mcp_action_confirmations.sqlite.sql',
    '152_user_invitations.sqlite.sql',
    '153_mcp_business_events.sqlite.sql'
  ]) {
    await db.exec(await readFile(new URL(`../migrations/versioned/${filename}`, import.meta.url), 'utf8'))
  }

  const username = `mcp_readiness_${crypto.randomUUID()}@example.test`
  const user = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used', 'MCP Readiness', 'admin', 1)`,
    [username, username]
  )
  fixture.userId = user.lastID
  const client = await registerOAuthClient({
    clientName: 'MCP Readiness Test',
    redirectUris: ['http://127.0.0.1:9781/callback'],
    softwareId: 'mcp-readiness-test'
  })
  fixture.clientId = client.client_id
  await db.run(
    `INSERT INTO oauth_grants (grant_id, user_id, client_id, scope, resource)
     VALUES (?, ?, ?, ?, ?)`,
    [fixture.grantId, fixture.userId, fixture.clientId, 'ristak.read ristak.write ristak.execute ristak.destructive', 'https://example.test/api/mcp']
  )
})

after(async () => {
  await db.run('DELETE FROM mcp_event_acknowledgements WHERE oauth_grant_id = ?', [fixture.grantId]).catch(() => undefined)
  await db.run('DELETE FROM mcp_business_events').catch(() => undefined)
  await db.run('DELETE FROM user_invitations WHERE invited_by_user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM mcp_action_confirmations WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM mcp_audit_log WHERE actor_user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM mcp_idempotency_keys WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM oauth_grants WHERE grant_id = ?', [fixture.grantId]).catch(() => undefined)
  await db.run('DELETE FROM oauth_clients WHERE client_id = ?', [fixture.clientId]).catch(() => undefined)
  await db.run('DELETE FROM users WHERE email = ?', [fixture.invitedEmail]).catch(() => undefined)
  await db.run('DELETE FROM users WHERE id = ?', [fixture.userId]).catch(() => undefined)
})

test('todo el catálogo MCP tiene contrato de salida y metadata de seguridad explícitos', () => {
  const { allSpecs, toolDefinition } = __mcpRegistryTestHooks
  assert.ok(allSpecs.length > 300)
  for (const spec of allSpecs) {
    const definition = toolDefinition(spec)
    assert.equal(definition.outputSchema?.type, 'object', `${spec.name} no tiene outputSchema de objeto`)
    assert.ok(Array.isArray(definition.securitySchemes) && definition.securitySchemes.length > 0, `${spec.name} no declara seguridad`)
    assert.equal(typeof definition.annotations.readOnlyHint, 'boolean', `${spec.name} no declara readOnlyHint`)
    assert.equal(typeof definition.annotations.destructiveHint, 'boolean', `${spec.name} no declara destructiveHint`)
    assert.equal(typeof definition.annotations.idempotentHint, 'boolean', `${spec.name} no declara idempotentHint`)
  }
})

test('Meta permite leer y sincronizar datos, pero no crear ni previsualizar borradores desde MCP', () => {
  const names = new Set(__mcpRegistryTestHooks.allSpecs.map(spec => spec.name))
  for (const readable of [
    'campaigns_overview',
    'campaigns_list_page',
    'campaigns_contacts',
    'campaigns_spend_over_time',
    'campaigns_meta_assets',
    'campaigns_ad_accounts',
    'campaigns_pixels',
    'campaigns_pages',
    'campaigns_social_profiles',
    'campaigns_builder_draft_get',
    'campaigns_builder_draft_logs',
    'campaigns_sync_from_date',
    'campaigns_refresh_recent'
  ]) assert.equal(names.has(readable), true, `falta lectura/sync de Meta: ${readable}`)

  assert.equal(names.has('campaigns_builder_draft_create'), false)
  assert.equal(names.has('campaigns_builder_draft_preview'), false)
  assert.equal(__mcpRegistryTestHooks.MCP_DISABLED_TOOL_NAMES.has('campaigns_builder_draft_create'), true)
})

test('el catálogo completa lotes, invitaciones y la aprobación funciona con scopes no-read', () => {
  const specs = new Map(__mcpRegistryTestHooks.allSpecs.map(spec => [spec.name, spec]))
  for (const name of [
    'contacts_bulk_actions_list',
    'contacts_bulk_action_get',
    'contacts_bulk_action_pause',
    'contacts_bulk_action_resume',
    'contacts_bulk_action_reschedule',
    'contacts_bulk_action_cancel',
    'contacts_bulk_action_delete',
    'settings_user_invitations_list',
    'settings_user_invite',
    'settings_user_invitation_revoke'
  ]) assert.ok(specs.has(name), `falta ${name}`)

  assert.equal(specs.get('settings_user_invite').inputSchema.properties.password, undefined)
  const confirmationDefinition = __mcpRegistryTestHooks.toolDefinition(specs.get('mcp_prepare_action_confirmation'))
  assert.deepEqual(
    confirmationDefinition.securitySchemes.map(scheme => scheme.scopes[0]),
    ['ristak.write', 'ristak.execute', 'ristak.destructive']
  )
})

test('búsqueda de capacidades selecciona la acción correcta sin un modelo externo', async () => {
  const result = await __mcpRegistryTestHooks.searchMcpCapabilities(mcpContext(), {
    query: 'pausa lote contactos',
    limit: 5
  })
  assert.equal(result.success, true)
  assert.equal(result.tools[0].name, 'contacts_bulk_action_pause')
  assert.equal(result.tools.some(tool => tool.name === 'campaigns_builder_draft_create'), false)
})

test('la bandeja durable entrega, redacta y acusa eventos por grant', async () => {
  const recorded = await recordMcpBusinessEvent({
    domain: 'payments',
    type: 'payment_changed',
    entityId: 'payment_readiness_1',
    payload: {
      paymentId: 'payment_readiness_1',
      status: 'paid',
      password: 'esto-no-debe-salir',
      nested: { accessToken: 'tampoco' }
    }
  })
  assert.equal(recorded.recorded, true)

  const listed = await listMcpBusinessEvents(mcpContext(), { domain: 'payments', limit: 10 })
  const event = listed.events.find(item => item.eventId === recorded.eventId)
  assert.ok(event)
  assert.equal(event.payload.password, '[redacted]')
  assert.equal(event.payload.nested.accessToken, '[redacted]')

  const acknowledged = await acknowledgeMcpBusinessEvents(mcpContext(), [recorded.eventId, recorded.eventId])
  assert.equal(acknowledged.acknowledged, 1)
  const replay = await acknowledgeMcpBusinessEvents(mcpContext(), [recorded.eventId])
  assert.equal(replay.acknowledged, 0)
  const pending = await listMcpBusinessEvents(mcpContext(), { domain: 'payments', limit: 10 })
  assert.equal(pending.events.some(item => item.eventId === recorded.eventId), false)
})

test('una invitación válida crea contraseña propia y nunca guarda el token ni el password en claro', async () => {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
  const invitationId = `invite_${crypto.randomUUID()}`
  await db.run(
    `INSERT INTO user_invitations (
       id, email, full_name, role, access_config, token_hash, invited_by_user_id, status, expires_at
     ) VALUES (?, ?, 'Persona Invitada', 'employee', '{}', ?, ?, 'pending', ?)`,
    [invitationId, fixture.invitedEmail, tokenHash, fixture.userId, new Date(Date.now() + 60 * 60 * 1000).toISOString()]
  )

  const infoRes = responseRecorder()
  await getUserInvitationInfo({ body: { token } }, infoRes)
  assert.equal(infoRes.statusCode, 200)
  assert.equal(infoRes.body.invitation.email, fixture.invitedEmail)
  assert.equal(JSON.stringify(infoRes.body).includes(token), false)

  const weakRes = responseRecorder()
  await acceptUserInvitation({ body: { token, password: 'debil' } }, weakRes)
  assert.equal(weakRes.statusCode, 400)
  assert.equal(weakRes.body.code, 'user_invitation_password_invalid')

  const strongPassword = `Premium${crypto.randomInt(100000, 999999)}!`
  const acceptedRes = responseRecorder()
  await acceptUserInvitation({ body: { token, password: strongPassword } }, acceptedRes)
  assert.equal(acceptedRes.statusCode, 201)
  assert.equal(JSON.stringify(acceptedRes.body).includes(token), false)
  assert.equal(JSON.stringify(acceptedRes.body).includes(strongPassword), false)

  const stored = await db.get('SELECT password_hash FROM users WHERE email = ?', [fixture.invitedEmail])
  assert.ok(stored?.password_hash)
  assert.equal(stored.password_hash.includes(strongPassword), false)
  const invitation = await db.get('SELECT status, token_hash FROM user_invitations WHERE id = ?', [invitationId])
  assert.equal(invitation.status, 'accepted')
  assert.equal(invitation.token_hash, tokenHash)
})

test('mantenimiento expira pendientes y aplica retención de auditoría, eventos e idempotencia', async () => {
  const old = '2020-01-01T00:00:00.000Z'
  const expiredConfirmationId = `confirmation_${crypto.randomUUID()}`
  const expiredInvitationId = `invite_${crypto.randomUUID()}`
  const oldEventId = crypto.randomUUID()
  await db.run(
    `INSERT INTO mcp_action_confirmations (
       confirmation_id, user_id, client_id, oauth_grant_id, tool_name, arguments_hash,
       arguments_redacted_json, risk_level, status, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'contacts_archive', 'hash', '{}', 'destructive', 'pending', ?, ?, ?)`,
    [expiredConfirmationId, fixture.userId, fixture.clientId, fixture.grantId, old, old, old]
  )
  await db.run(
    `INSERT INTO user_invitations (
       id, email, full_name, role, access_config, token_hash, invited_by_user_id,
       status, expires_at, created_at, updated_at
     ) VALUES (?, ?, 'Expirada', 'employee', '{}', ?, ?, 'pending', ?, ?, ?)`,
    [expiredInvitationId, `expired-${crypto.randomUUID()}@example.test`, crypto.randomBytes(32).toString('hex'), fixture.userId, old, old, old]
  )
  await db.run(
    `INSERT INTO mcp_idempotency_keys (
       user_id, client_id, tool_name, key_hash, request_hash, status, expires_at, created_at, updated_at
     ) VALUES (?, ?, 'contacts_create', ?, 'request', 'failed', ?, ?, ?)`,
    [fixture.userId, fixture.clientId, crypto.randomBytes(32).toString('hex'), old, old, old]
  )
  await db.run(
    `INSERT INTO mcp_audit_log (
       actor_user_id, client_id, oauth_grant_id, tool_name, risk_level, success,
       started_at, completed_at, created_at
     ) VALUES (?, ?, ?, 'contacts_get', 'read', 1, ?, ?, ?)`,
    [fixture.userId, fixture.clientId, fixture.grantId, old, old, old]
  )
  await db.run(
    `INSERT INTO mcp_business_events (
       event_id, domain, event_type, payload_json, occurred_at, expires_at, created_at
     ) VALUES (?, 'chat', 'chat_message', '{}', ?, ?, ?)`,
    [oldEventId, old, old, old]
  )

  const result = await runMcpDataMaintenance({ now: new Date('2026-08-03T20:00:00.000Z') })
  assert.ok(result.confirmationsExpired >= 1)
  assert.ok(result.invitationsExpired >= 1)
  assert.ok(result.idempotencyDeleted >= 1)
  assert.ok(result.auditDeleted >= 1)
  assert.ok(result.eventsDeleted >= 1)
  assert.equal((await db.get('SELECT status FROM mcp_action_confirmations WHERE confirmation_id = ?', [expiredConfirmationId])).status, 'expired')
  assert.equal((await db.get('SELECT status FROM user_invitations WHERE id = ?', [expiredInvitationId])).status, 'expired')
  assert.equal(await db.get('SELECT event_id FROM mcp_business_events WHERE event_id = ?', [oldEventId]), null)
})
