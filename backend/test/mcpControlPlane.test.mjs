import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import { domainToolSpecs } from '../src/mcp/domainTools.js'
import mcpRoutes from '../src/routes/mcp.routes.js'
import sitesRoutes from '../src/routes/sites.routes.js'
import { resetCentralStorageConfigCache } from '../src/services/mediaStorageService.js'
import { deleteSite } from '../src/services/sitesService.js'
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
  secondaryContactId: '',
  siteId: ''
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

async function requestUrl(url, { json = false } = {}) {
  const response = await fetch(url, {
    headers: { Accept: json ? 'application/json' : 'text/html' }
  })
  return {
    status: response.status,
    headers: response.headers,
    payload: json ? await response.json() : await response.text()
  }
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
  app.use('/api/sites', sitesRoutes)
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
  if (fixture.siteId) {
    await deleteSite(fixture.siteId).catch(() => undefined)
  }
  if (fixture.userId) {
    await db.run('DELETE FROM mcp_action_confirmations WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
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
    await db.run('DELETE FROM mcp_action_confirmations WHERE user_id = ?', [fixture.secondaryUserId]).catch(() => undefined)
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
  assert.match(response.payload.result.instructions, /scopes OAuth/i)
  assert.match(response.payload.result.instructions, /sin pedir aprobación humana por llamada/i)
  assert.doesNotMatch(response.payload.result.instructions, /confirm=true|approvalTicket/)
  assert.match(response.payload.result.instructions, /sites_create_html_draft/)
  assert.match(response.payload.result.instructions, /sites_patch_html_draft/)
  assert.match(response.payload.result.instructions, /no vuelvas a leer ni reenviar/i)
  assert.match(response.payload.result.instructions, /no construyas.*bloques nativos/i)
  assert.deepEqual(response.payload.result.capabilities, { tools: { listChanged: false } })
})

test('pagos separa edición, ejecución y cancelación destructiva', async () => {
  const update = domainTool('payments_update')
  assert.equal(update.scope, MCP_SCOPES.WRITE)
  assert.equal(update.inputSchema.properties.changes.additionalProperties, false)
  assert.equal(update.inputSchema.properties.changes.properties.status, undefined)

  const updatePlan = domainTool('payments_update_plan')
  assert.match(updatePlan.description, /namingOnly=true/i)
  assert.equal(updatePlan.scope, MCP_SCOPES.EXECUTE)

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
    idempotencyKey: 'payment-plan-action-001'
  })
  assert.deepEqual(calls[0].body, {
    action: 'change_card',
    payload: { returnUrl: 'https://app.example.test/settings' }
  })

  calls.length = 0
  await updatePlan.execute({
    invoke: async (_handler, request) => {
      calls.push(request)
      return { success: true }
    }
  }, {
    planId: 'plan_sin_actividad',
    changes: {
      namingOnly: true,
      name: 'Plan interno corregido',
      title: 'Factura corregida'
    },
    idempotencyKey: 'payment-plan-rename-001'
  })
  assert.deepEqual(calls[0].params, { scheduleId: 'plan_sin_actividad' })
  assert.deepEqual(calls[0].body, {
    namingOnly: true,
    name: 'Plan interno corregido',
    title: 'Factura corregida'
  })
  assert.deepEqual(calls[0].headers, { 'idempotency-key': 'payment-plan-rename-001' })
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
  assert.equal(names.has('sites_open_html_live_preview'), true)
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
  assert.equal(names.has('mcp_prepare_action_confirmation'), false)
  assert.equal(names.has('mcp_action_confirmation_status'), false)
  assert.ok(response.payload.result.tools.every(tool => tool._meta?.['ristak/confirmationRequired'] === undefined))
  for (const required of [
    'contacts_create',
    'chatbot_update',
    'appointments_create',
    'payments_record',
    'automations_publish',
    'media_prepare_bunny_upload',
    'sites_validate_html',
    'sites_create_html_draft',
    'sites_open_html_live_preview',
    'sites_patch_html_draft',
    'sites_replace_html_draft',
    'sites_update_code',
    'sites_publish'
  ]) {
    assert.equal(names.has(required), true, `falta ${required}`)
  }
  assert.equal(names.has('chat_send_whatsapp'), false, 'no debe anunciar WhatsApp desconectado')
  assert.equal([...names].some(name => name.startsWith('campaigns_')), false, 'no debe anunciar Meta Ads desconectado')
  assert.equal(names.has('integrations_connection_handoff'), true, 'debe ofrecer la conexión segura')

  const createHtml = response.payload.result.tools.find(tool => tool.name === 'sites_create_html_draft')
  assert.equal(createHtml.title, 'Crear borrador HTML profesional')
  assert.equal(createHtml.outputSchema.additionalProperties, false)
  assert.equal(createHtml.outputSchema.properties.data.additionalProperties, false)
})

test('flujo HTML MCP crea, parchea y refresca un preview temporal real', async () => {
  const originalHtml = `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Landing MCP original</title>
        <style>
          body { margin: 0; font-family: system-ui, sans-serif; }
          main { min-height: 100vh; display: grid; place-items: center; padding: clamp(24px, 6vw, 96px); }
          @media (max-width: 680px) { main { place-items: start; } }
        </style>
      </head>
      <body><main><h1>Experiencia original</h1></main></body>
    </html>`

  const validation = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 45, method: 'tools/call',
    params: {
      name: 'sites_validate_html',
      arguments: { html: originalHtml }
    }
  })
  assert.equal(validation.payload.result.isError, undefined)
  assert.equal(validation.payload.result.structuredContent.data.ready, true)

  const created = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 46, method: 'tools/call',
    params: {
      name: 'sites_create_html_draft',
      arguments: {
        name: `Landing MCP ${crypto.randomUUID()}`,
        html: originalHtml,
        idempotencyKey: `site-html-create-${crypto.randomUUID()}`
      }
    }
  })
  assert.equal(created.payload.result.isError, undefined)
  const createdData = created.payload.result.structuredContent.data
  fixture.siteId = createdData.siteId
  assert.ok(fixture.siteId)
  assert.equal(createdData.status, 'draft')
  assert.equal(createdData.editorMode, 'html')
  assert.equal(createdData.files[0].content, undefined)
  assert.match(createdData.revision, /^sha256:[a-f0-9]{64}$/)

  const livePreview = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 47, method: 'tools/call',
    params: {
      name: 'sites_open_html_live_preview',
      arguments: { siteId: fixture.siteId }
    }
  })
  assert.equal(livePreview.payload.result.isError, undefined)
  const livePreviewData = livePreview.payload.result.structuredContent.data
  assert.match(livePreviewData.url, /\/api\/sites\/public\/mcp-html-live-preview\//)
  assert.equal(livePreviewData.trackingEnabled, false)
  assert.equal(livePreviewData.mutationsEnabled, false)

  const initialCheck = await requestUrl(`${livePreviewData.url}?check=1`, { json: true })
  assert.equal(initialCheck.status, 200)
  const initialLiveRevision = initialCheck.payload.data.revision

  const edited = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 48, method: 'tools/call',
    params: {
      name: 'sites_patch_html_draft',
      arguments: {
        siteId: fixture.siteId,
        edits: [
          { search: 'Landing MCP original', replacement: 'Landing MCP editada' },
          { search: 'Experiencia original', replacement: 'Experiencia editada' }
        ],
        idempotencyKey: `site-html-edit-${crypto.randomUUID()}`
      }
    }
  })
  assert.equal(edited.payload.result.isError, undefined)
  const editedData = edited.payload.result.structuredContent.data
  assert.notEqual(editedData.revision, createdData.revision)
  assert.equal(editedData.status, 'draft')

  const refreshedCheck = await requestUrl(`${livePreviewData.url}?check=1`, { json: true })
  assert.equal(refreshedCheck.status, 200)
  assert.notEqual(refreshedCheck.payload.data.revision, initialLiveRevision)

  const livePage = await requestUrl(livePreviewData.url)
  assert.equal(livePage.status, 200)
  assert.equal(livePage.headers.get('cache-control'), 'no-store')
  assert.equal(livePage.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(livePage.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.match(livePage.payload, /Experiencia editada/)
  assert.match(livePage.payload, /data-rstk-mcp-live-preview="true"/)

  const tamperedPreview = await requestUrl(`${livePreviewData.url}x`)
  assert.equal(tamperedPreview.status, 403)

  const preview = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 49, method: 'tools/call',
    params: {
      name: 'sites_preview_html',
      arguments: { siteId: fixture.siteId }
    }
  })
  assert.equal(preview.payload.result.isError, undefined)
  assert.match(preview.payload.result.structuredContent.data.html, /Experiencia editada/)
  assert.doesNotMatch(preview.payload.result.structuredContent.data.html, /Experiencia original/)
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
  const businessArguments = {
    filename: 'archivo.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    sha256: 'a'.repeat(64),
    folderPath: 'Pruebas'
  }
  const request = () => requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: {
      name: 'media_prepare_bunny_upload',
      arguments: {
        ...businessArguments,
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

test('el scope OAuth autoriza la acción directa y el servidor conserva schema e idempotencia', async () => {
  const archived = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'contacts_archive',
      arguments: { contactId: fixture.contactId, idempotencyKey: 'archive-contact-001' }
    }
  })
  assert.equal(archived.payload.result.isError, undefined)

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

test('los controles de aprobación humana ya no existen en el protocolo MCP', async () => {
  const response = await requestMcp(fixture.fullToken, {
    jsonrpc: '2.0', id: 71, method: 'tools/call',
    params: { name: 'mcp_prepare_action_confirmation', arguments: {} }
  })
  assert.equal(response.payload.result.isError, true)
  assert.equal(response.payload.result.structuredContent.code, 'tool_not_found')
})
