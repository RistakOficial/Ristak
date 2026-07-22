import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import { domainToolSpecs } from '../src/mcp/domainTools.js'
import mcpRoutes from '../src/routes/mcp.routes.js'
import { resetCentralStorageConfigCache } from '../src/services/mediaStorageService.js'
import {
  MCP_SCOPES,
  MCP_SCOPE_VALUES,
  consumeAuthorizationCode,
  createAccessToken,
  createAuthorizationCode,
  registerOAuthClient
} from '../src/utils/oauthTokens.js'

const fixture = {
  server: null,
  port: 0,
  origin: '',
  resource: '',
  userId: null,
  secondaryUserId: null,
  clientId: '',
  redirectUri: 'http://127.0.0.1:9847/callback',
  readToken: '',
  fullToken: '',
  contactId: '',
  secondaryContactId: ''
}

function requestMcp(token, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const request = http.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path: '/api/mcp',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': String(body.length)
      }
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          payload: text ? JSON.parse(text) : null
        })
      })
    })
    request.once('error', reject)
    request.write(body)
    request.end()
  })
}

function domainTool(name) {
  const found = domainToolSpecs.find((entry) => entry.name === name)
  assert.ok(found, `No existe la herramienta ${name}`)
  return found
}

async function issueToken(scopes, userId = fixture.userId) {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const code = await createAuthorizationCode({
    userId,
    clientId: fixture.clientId,
    redirectUri: fixture.redirectUri,
    codeChallenge: challenge,
    scope: scopes,
    resource: fixture.resource
  })
  const grant = await consumeAuthorizationCode({
    code,
    clientId: fixture.clientId,
    redirectUri: fixture.redirectUri,
    codeVerifier: verifier
  })
  assert.ok(grant)
  return createAccessToken({
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    userId: grant.userId,
    clientId: grant.clientId,
    issuer: fixture.origin,
    audience: fixture.resource,
    scope: grant.scope
  }).accessToken
}

before(async () => {
  await databaseReady
  const migration = await readFile(
    new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url),
    'utf8'
  )
  await db.exec(migration)

  const username = `mcp_plane_${crypto.randomUUID()}@example.test`
  const inserted = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used', 'MCP Control Plane', 'admin', 1)`,
    [username, username]
  )
  fixture.userId = inserted.lastID
  const secondaryUsername = `mcp_plane_secondary_${crypto.randomUUID()}@example.test`
  const secondaryInserted = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used', 'MCP Secondary User', 'admin', 1)`,
    [secondaryUsername, secondaryUsername]
  )
  fixture.secondaryUserId = secondaryInserted.lastID
  const client = await registerOAuthClient({
    clientName: 'MCP Control Plane Test',
    redirectUris: [fixture.redirectUri],
    softwareId: 'mcp-control-test'
  })
  fixture.clientId = client.client_id

  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/mcp', mcpRoutes)
  fixture.server = http.createServer(app)
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, '127.0.0.1', resolve)
  })
  fixture.port = fixture.server.address().port
  fixture.origin = `http://127.0.0.1:${fixture.port}`
  fixture.resource = `${fixture.origin}/api/mcp`
  process.env.APP_URL = fixture.origin
  fixture.readToken = await issueToken([MCP_SCOPES.READ])
})

after(async () => {
  delete process.env.APP_URL
  if (fixture.server) {
    fixture.server.closeAllConnections?.()
    await new Promise(resolve => fixture.server.close(resolve))
  }
  if (fixture.contactId) {
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => undefined)
  }
  if (fixture.secondaryContactId) {
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.secondaryContactId]).catch(() => undefined)
  }
  if (fixture.userId) {
    await db.run('DELETE FROM mcp_audit_log WHERE actor_user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM mcp_idempotency_keys WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_authorization_codes WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_grants WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE id = ?', [fixture.userId]).catch(() => undefined)
  }
  if (fixture.clientId) {
    await db.run('DELETE FROM oauth_clients WHERE client_id = ?', [fixture.clientId]).catch(() => undefined)
  }
  if (fixture.secondaryUserId) {
    await db.run('DELETE FROM mcp_audit_log WHERE actor_user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
    await db.run('DELETE FROM mcp_idempotency_keys WHERE user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_authorization_codes WHERE user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_grants WHERE user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE id = ?', [fixture.secondaryUserId]).catch(() => undefined)
  }
})

test('initialize anuncia instrucciones, protocolo y servidor MCP v2', async () => {
  const response = await requestMcp(fixture.readToken, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' }
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['mcp-protocol-version'], '2025-06-18')
  assert.equal(response.payload.result.serverInfo.version, '2.0.0')
  assert.match(response.payload.result.instructions, /confirm=true/)
  assert.deepEqual(response.payload.result.capabilities, { tools: { listChanged: false } })
})

test('pagos separa edición, ejecución y cancelación destructiva', async () => {
  const update = domainTool('payments_update')
  assert.equal(update.scope, MCP_SCOPES.WRITE)
  assert.equal(update.inputSchema.properties.changes.additionalProperties, false)
  assert.equal(update.inputSchema.properties.changes.properties.status, undefined)

  const execute = domainTool('payments_plan_action')
  assert.equal(execute.scope, MCP_SCOPES.EXECUTE)
  assert.deepEqual(execute.inputSchema.properties.action.enum, [
    'activate', 'pause', 'change_card', 'auto-payment'
  ])

  const terminate = domainTool('payments_plan_terminate')
  assert.equal(terminate.scope, MCP_SCOPES.DESTRUCTIVE)
  assert.deepEqual(terminate.inputSchema.properties.action.enum, ['cancel', 'delete'])

  const calls = []
  await execute.execute({
    invoke: async (_handler, request) => {
      calls.push(request)
      return { success: true }
    }
  }, {
    planId: 'plan_1',
    action: 'change_card',
    payload: { returnUrl: 'https://app.example.test/settings' },
    confirm: true,
    idempotencyKey: 'payment-plan-action-001'
  })
  assert.deepEqual(calls[0].body, {
    action: 'change_card',
    payload: { returnUrl: 'https://app.example.test/settings' }
  })
})

test('scope de lectura lista sólo lecturas y no expone SQL ni proxies arbitrarios', async () => {
  const response = await requestMcp(fixture.readToken, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
  })
  assert.equal(response.statusCode, 200)
  const tools = response.payload.result.tools
  assert.ok(tools.length >= 30)
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true))
  assert.ok(tools.every(tool => tool.securitySchemes?.[0]?.scopes?.[0] === MCP_SCOPES.READ))
  const names = new Set(tools.map(tool => tool.name))
  assert.equal(names.has('query_data_table'), false)
  assert.equal(names.has('ghl_api_request'), false)
  assert.equal(names.has('ghl_mcp_call_tool'), false)
  assert.equal(names.has('contacts_create'), false)
  assert.equal(names.has('sites_get_code'), true)
  assert.equal(names.has('chat_get_conversation'), true)
})

test('el servidor monta MCP antes del router catch-all de costos', async () => {
  const serverSource = await readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  const mcpMount = serverSource.indexOf("app.use('/api/mcp', mcpRoutes)")
  const costsMount = serverSource.indexOf("app.use('/api', costsRoutes)")

  assert.notEqual(mcpMount, -1)
  assert.notEqual(costsMount, -1)
  assert.ok(mcpMount < costsMount, 'costsRoutes interceptaría OAuth/MCP antes de su router propio')
})

test('grant ampliado invalida el token viejo y publica el catálogo de control', async () => {
  fixture.fullToken = await issueToken(MCP_SCOPE_VALUES)

  const stale = await requestMcp(fixture.readToken, {
    jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}
  })
  assert.equal(stale.statusCode, 401)

  const response = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 4, method: 'tools/list', params: {}
  })
  const names = new Set(response.payload.result.tools.map(tool => tool.name))
  assert.ok(names.size >= 100)
  for (const required of [
    'contacts_create',
    'chat_send_whatsapp',
    'chatbot_update',
    'appointments_create',
    'payments_record',
    'automations_publish',
    'media_prepare_bunny_upload',
    'sites_update_code',
    'sites_publish'
  ]) {
    assert.equal(names.has(required), true, `falta ${required}`)
  }
})

test('el pase temporal de Bunny se entrega una vez pero nunca queda guardado en el replay MCP', async () => {
  const envKeys = [
    'MEDIA_STORAGE_PROVIDER',
    'BUNNY_STORAGE_ZONE',
    'BUNNY_STORAGE_API_KEY',
    'BUNNY_CDN_BASE_URL',
    'BUNNY_STREAM_ENABLED'
  ]
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    MEDIA_STORAGE_PROVIDER: 'bunny',
    BUNNY_STORAGE_ZONE: 'unit-test-zone',
    BUNNY_STORAGE_API_KEY: 'unit-test-key-not-used-for-network',
    BUNNY_CDN_BASE_URL: 'https://cdn.example.test',
    BUNNY_STREAM_ENABLED: 'false'
  })
  resetCentralStorageConfigCache()
  const idempotencyKey = `bunny-ticket-${crypto.randomUUID()}`
  const request = () => requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: {
      name: 'media_prepare_bunny_upload',
      arguments: {
        filename: 'archivo.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        sha256: 'a'.repeat(64),
        folderPath: 'Pruebas',
        confirm: true,
        idempotencyKey
      }
    }
  })

  try {
    const first = await request()
    assert.equal(first.payload.result.isError, undefined)
    const ticket = first.payload.result.structuredContent.data.headers['X-Ristak-Media-Upload-Ticket']
    assert.ok(ticket)

    const row = await db.get(
      `SELECT result_json FROM mcp_idempotency_keys
       WHERE user_id = ? AND tool_name = 'media_prepare_bunny_upload'
       ORDER BY id DESC LIMIT 1`,
      [fixture.userId]
    )
    assert.equal(JSON.parse(row.result_json).reason, 'ephemeral')
    assert.equal(row.result_json.includes(ticket), false)

    const replay = await request()
    assert.equal(replay.payload.result.isError, true)
    assert.equal(replay.payload.result.structuredContent.code, 'idempotency_replay_unavailable')
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    resetCentralStorageConfigCache()
  }
})

test('escritura real usa controller, idempotencia y auditoría sin duplicar', async () => {
  const args = {
    name: 'Contacto creado por MCP',
    email: `mcp-${crypto.randomUUID()}@example.test`,
    idempotencyKey: 'contact-create-e2e-001'
  }
  const call = () => requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'contacts_create', arguments: args }
  })
  const first = await call()
  assert.equal(first.payload.result.isError, undefined)
  fixture.contactId = first.payload.result.structuredContent.data.id
  assert.ok(fixture.contactId)

  const replay = await call()
  assert.equal(replay.payload.result.structuredContent.data.id, fixture.contactId)
  const count = await db.get('SELECT COUNT(*) AS total FROM contacts WHERE email = ?', [args.email])
  assert.equal(Number(count.total), 1)

  const audit = await db.get(
    `SELECT success, risk_level, input_redacted_json
     FROM mcp_audit_log
     WHERE actor_user_id = ? AND tool_name = 'contacts_create'
     ORDER BY id DESC LIMIT 1`,
    [fixture.userId]
  )
  assert.equal(Number(audit.success), 1)
  assert.equal(audit.risk_level, 'write')
  assert.doesNotMatch(audit.input_redacted_json, /authorization|password/i)
})

test('idempotencia queda aislada por usuario aunque el cliente OAuth sea el mismo', async () => {
  const secondaryToken = await issueToken(MCP_SCOPE_VALUES, fixture.secondaryUserId)
  const response = await requestMcp(secondaryToken, {
    jsonrpc: '2.0', id: 51, method: 'tools/call',
    params: {
      name: 'contacts_create',
      arguments: {
        name: 'Contacto de segundo usuario',
        email: `mcp-secondary-${crypto.randomUUID()}@example.test`,
        idempotencyKey: 'contact-create-e2e-001'
      }
    }
  })

  assert.equal(response.payload.result.isError, undefined)
  fixture.secondaryContactId = response.payload.result.structuredContent.data.id
  assert.ok(fixture.secondaryContactId)
  assert.notEqual(fixture.secondaryContactId, fixture.contactId)
})

test('confirmación, schema e idempotencyKey se aplican dentro del servidor', async () => {
  const missingConfirmation = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'contacts_archive',
      arguments: { contactId: fixture.contactId, idempotencyKey: 'archive-contact-001' }
    }
  })
  assert.equal(missingConfirmation.payload.result.isError, true)
  assert.equal(missingConfirmation.payload.result.structuredContent.code, 'invalid_arguments')

  const unknownArgument = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: {
      name: 'contacts_get',
      arguments: { contactId: fixture.contactId, rawSql: 'SELECT * FROM users' }
    }
  })
  assert.equal(unknownArgument.payload.result.isError, true)
  assert.equal(unknownArgument.payload.result.structuredContent.code, 'invalid_arguments')
})
