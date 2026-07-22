import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import oauthRoutes from '../src/routes/oauth.routes.js'
import {
  getMcpAccessStatus,
  listMcpConnections,
  revokeMcpConnection
} from '../src/controllers/oauthConnectionsController.js'
import {
  MCP_SCOPES,
  MCP_SCOPE_VALUES,
  OAuthProtocolError,
  consumeAuthorizationCode,
  createAccessToken,
  createAuthorizationCode,
  createRefreshToken,
  hasGrantedScope,
  listOAuthConnectionsForUser,
  normalizeOAuthRedirectUri,
  normalizeRequestedScopes,
  registerOAuthClient,
  revokeOAuthGrantForUser,
  rotateRefreshToken,
  validateOAuthAccessContext,
  verifyOAuthAccessToken
} from '../src/utils/oauthTokens.js'
import { resolveMcpResource, resolveOAuthOrigin } from '../src/utils/oauthOrigin.js'
import { generateToken } from '../src/utils/auth.js'

const fixture = {
  userId: null,
  deniedUserId: null,
  sessionToken: '',
  deniedSessionToken: '',
  clientId: '',
  redirectUri: 'https://client.example.test/oauth/callback',
  resource: 'https://ristak.example.test/api/mcp',
  issuer: 'https://ristak.example.test',
  server: null,
  port: 0
}

function requestServer(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const request = http.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length)
        } : {}),
        ...headers
      }
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }))
    })
    request.once('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function mockJsonResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function authorizeGrant(scopes = MCP_SCOPE_VALUES) {
  const { verifier, challenge } = pkcePair()
  const code = await createAuthorizationCode({
    userId: fixture.userId,
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
  return grant
}

before(async () => {
  await databaseReady
  const migration = await readFile(
    new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url),
    'utf8'
  )
  await db.exec(migration)

  const username = `oauth_mcp_${crypto.randomUUID()}@example.test`
  const inserted = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used-in-this-test', 'OAuth MCP Test', 'admin', 1)`,
    [username, username]
  )
  fixture.userId = inserted.lastID
  fixture.sessionToken = generateToken({
    userId: fixture.userId,
    role: 'admin',
    tokenVersion: 0
  })

  const deniedUsername = `oauth_mcp_denied_${crypto.randomUUID()}@example.test`
  const denied = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, access_config, is_active)
     VALUES (?, ?, 'not-used-in-this-test', 'OAuth MCP Denied', 'employee', ?, 1)`,
    [deniedUsername, deniedUsername, JSON.stringify({ settings_api_access: 'none' })]
  )
  fixture.deniedUserId = denied.lastID
  fixture.deniedSessionToken = generateToken({
    userId: fixture.deniedUserId,
    role: 'employee',
    tokenVersion: 0
  })

  const client = await registerOAuthClient({
    clientName: 'Codex Test Client',
    redirectUris: [fixture.redirectUri],
    clientUri: 'https://client.example.test',
    softwareId: 'codex-test',
    softwareVersion: '1.0.0'
  })
  fixture.clientId = client.client_id

  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(oauthRoutes)
  fixture.server = http.createServer(app)
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, '127.0.0.1', resolve)
  })
  fixture.port = fixture.server.address().port
})

after(async () => {
  if (fixture.server) {
    fixture.server.closeAllConnections?.()
    await new Promise(resolve => fixture.server.close(resolve))
  }
  if (fixture.userId) {
    await db.run('DELETE FROM mcp_audit_log WHERE actor_user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM mcp_idempotency_keys WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_authorization_codes WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_refresh_tokens WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_grants WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE id = ?', [fixture.userId]).catch(() => undefined)
  }
  if (fixture.deniedUserId) {
    await db.run('DELETE FROM oauth_authorization_codes WHERE user_id = ?', [fixture.deniedUserId]).catch(() => undefined)
    await db.run('DELETE FROM oauth_grants WHERE user_id = ?', [fixture.deniedUserId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE id = ?', [fixture.deniedUserId]).catch(() => undefined)
  }
  if (fixture.clientId) {
    await db.run('DELETE FROM oauth_clients WHERE client_id = ?', [fixture.clientId]).catch(() => undefined)
  }
})

test('scopes y redirects OAuth fallan cerrado', () => {
  assert.deepEqual(normalizeRequestedScopes(), [MCP_SCOPES.READ])
  assert.deepEqual(
    normalizeRequestedScopes('ristak.execute ristak.read ristak.execute'),
    [MCP_SCOPES.READ, MCP_SCOPES.EXECUTE]
  )
  assert.equal(hasGrantedScope(MCP_SCOPE_VALUES, [MCP_SCOPES.WRITE, MCP_SCOPES.EXECUTE]), true)
  assert.equal(hasGrantedScope([MCP_SCOPES.READ], MCP_SCOPES.WRITE), false)
  assert.throws(
    () => normalizeRequestedScopes('ristak.read all.the.things'),
    error => error instanceof OAuthProtocolError && error.code === 'invalid_scope'
  )

  assert.equal(
    normalizeOAuthRedirectUri('http://127.0.0.1:8765/callback'),
    'http://127.0.0.1:8765/callback'
  )
  assert.equal(
    normalizeOAuthRedirectUri('https://chatgpt.com/connector/oauth/callback'),
    'https://chatgpt.com/connector/oauth/callback'
  )
  for (const invalid of [
    'http://example.com/callback',
    'javascript:alert(1)',
    'https://example.com/callback#fragment',
    'https://user:password@example.com/callback'
  ]) {
    assert.throws(() => normalizeOAuthRedirectUri(invalid), OAuthProtocolError)
  }
})

test('issuer y audience prefieren la URL canónica sobre headers manipulados', () => {
  const previousAppUrl = process.env.APP_URL
  try {
    process.env.APP_URL = 'https://canonical.ristak.test'
    const request = {
      protocol: 'https',
      get(name) {
        if (name === 'x-forwarded-host') return 'attacker.example.test'
        if (name === 'x-forwarded-proto') return 'https'
        if (name === 'host') return 'attacker.example.test'
        return undefined
      }
    }
    assert.equal(resolveOAuthOrigin(request), 'https://canonical.ristak.test')
    assert.equal(resolveMcpResource(request), 'https://canonical.ristak.test/api/mcp')
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = previousAppUrl
  }
})

test('producción falla cerrado si no existe un origen OAuth canónico', () => {
  const previousAppUrl = process.env.APP_URL
  const previousRenderUrl = process.env.RENDER_EXTERNAL_URL
  const previousNodeEnv = process.env.NODE_ENV
  try {
    delete process.env.APP_URL
    delete process.env.RENDER_EXTERNAL_URL
    process.env.NODE_ENV = 'production'
    const request = {
      protocol: 'https',
      get(name) {
        if (name === 'x-forwarded-host' || name === 'host') return 'attacker.example.test'
        if (name === 'x-forwarded-proto') return 'https'
        return undefined
      }
    }
    assert.throws(
      () => resolveOAuthOrigin(request),
      (error) => error.code === 'oauth_origin_not_configured'
    )
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = previousAppUrl
    if (previousRenderUrl === undefined) delete process.env.RENDER_EXTERNAL_URL
    else process.env.RENDER_EXTERNAL_URL = previousRenderUrl
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})

test('access token exige grant activo, usuario activo, issuer, audience y scopes actuales', async () => {
  const grant = await authorizeGrant()
  const { accessToken } = createAccessToken({
    ...grant,
    issuer: fixture.issuer,
    audience: fixture.resource
  })

  assert.ok(verifyOAuthAccessToken(accessToken, {
    issuer: fixture.issuer,
    audience: fixture.resource
  }))
  assert.equal(verifyOAuthAccessToken(accessToken, 'https://other.example.test/api/mcp'), null)

  const context = await validateOAuthAccessContext(accessToken, {
    issuer: fixture.issuer,
    audience: fixture.resource
  })
  assert.equal(context?.user.id, fixture.userId)
  assert.equal(context?.grant.id, grant.grantId)
  assert.deepEqual(context?.scopes, MCP_SCOPE_VALUES)

  await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [fixture.userId])
  assert.equal(await validateOAuthAccessContext(accessToken, {
    issuer: fixture.issuer,
    audience: fixture.resource
  }), null)
  await db.run('UPDATE users SET is_active = 1 WHERE id = ?', [fixture.userId])
})

test('refresh rota una sola vez y el replay revoca de inmediato todo el grant', async () => {
  const grant = await authorizeGrant([MCP_SCOPES.READ, MCP_SCOPES.WRITE])
  const refreshToken = await createRefreshToken({ ...grant })
  const firstRotation = await rotateRefreshToken({
    refreshToken,
    clientId: fixture.clientId,
    scope: MCP_SCOPES.READ
  })
  assert.ok(firstRotation?.refreshToken)
  assert.notEqual(firstRotation.refreshToken, refreshToken)
  assert.equal(firstRotation.scope, MCP_SCOPES.READ)

  const replay = await rotateRefreshToken({ refreshToken, clientId: fixture.clientId })
  assert.equal(replay, null)
  assert.equal(await rotateRefreshToken({
    refreshToken: firstRotation.refreshToken,
    clientId: fixture.clientId
  }), null)

  const row = await db.get('SELECT revoked_at, version FROM oauth_grants WHERE grant_id = ?', [grant.grantId])
  assert.ok(row.revoked_at)
  assert.ok(Number(row.version) > grant.grantVersion)
})

test('listar y revocar conexiones sólo opera sobre grants del usuario', async () => {
  const grant = await authorizeGrant([MCP_SCOPES.READ])
  const connections = await listOAuthConnectionsForUser(fixture.userId)
  const current = connections.find(connection => connection.id === grant.grantId)
  assert.equal(current?.clientName, 'Codex Test Client')
  assert.deepEqual(current?.scopes, [MCP_SCOPES.READ])

  assert.equal(await revokeOAuthGrantForUser({
    grantId: grant.grantId,
    userId: Number(fixture.userId) + 100000
  }), false)
  assert.equal(await revokeOAuthGrantForUser({
    grantId: grant.grantId,
    userId: fixture.userId
  }), true)
  assert.equal(
    (await listOAuthConnectionsForUser(fixture.userId)).some(connection => connection.id === grant.grantId),
    false
  )
})

test('endpoints autenticados de Developers exponen estado, listan y revocan el grant propio', async () => {
  const grant = await authorizeGrant([MCP_SCOPES.READ, MCP_SCOPES.WRITE])
  const request = {
    user: { userId: fixture.userId },
    params: { id: grant.grantId },
    protocol: 'https',
    get(name) {
      if (name === 'host') return 'ristak.example.test'
      return undefined
    }
  }

  const statusResponse = mockJsonResponse()
  await getMcpAccessStatus(request, statusResponse)
  assert.equal(statusResponse.statusCode, 200)
  assert.equal(statusResponse.payload.mcp.serverUrl, fixture.resource)
  assert.deepEqual(statusResponse.payload.mcp.scopes, MCP_SCOPE_VALUES)
  assert.ok(statusResponse.payload.mcp.activeConnections >= 1)
  assert.equal(statusResponse.payload.mcp.protections.immediateRevocation, true)

  const listResponse = mockJsonResponse()
  await listMcpConnections(request, listResponse)
  assert.equal(listResponse.statusCode, 200)
  assert.ok(listResponse.payload.connections.some(connection => connection.id === grant.grantId))

  const revokeResponse = mockJsonResponse()
  await revokeMcpConnection(request, revokeResponse)
  assert.equal(revokeResponse.statusCode, 200)
  assert.equal(revokeResponse.payload.id, grant.grantId)

  const secondRevokeResponse = mockJsonResponse()
  await revokeMcpConnection(request, secondRevokeResponse)
  assert.equal(secondRevokeResponse.statusCode, 404)
})

test('metadata y DCR publican todos los scopes sin secret manual y cierran redirects inseguros', async () => {
  const metadata = await requestServer('/.well-known/oauth-authorization-server')
  assert.equal(metadata.statusCode, 200)
  const metadataJson = JSON.parse(metadata.text)
  assert.deepEqual(metadataJson.scopes_supported, MCP_SCOPE_VALUES)
  assert.equal(metadataJson.code_challenge_methods_supported[0], 'S256')
  assert.match(metadataJson.registration_endpoint, /\/api\/oauth\/register$/)

  const registration = await requestServer('/api/oauth/register', {
    method: 'POST',
    body: {
      client_name: 'ChatGPT Test',
      redirect_uris: ['https://chatgpt.com/connector/oauth/test-callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }
  })
  assert.equal(registration.statusCode, 201)
  const registered = JSON.parse(registration.text)
  assert.match(registered.client_id, /^client_/)
  assert.equal(registered.client_secret, undefined)

  const unsafeRegistration = await requestServer('/api/oauth/register', {
    method: 'POST',
    body: {
      client_name: 'Unsafe Test',
      redirect_uris: ['http://attacker.example.test/callback']
    }
  })
  assert.equal(unsafeRegistration.statusCode, 400)
  assert.equal(JSON.parse(unsafeRegistration.text).error, 'invalid_client_metadata')

  await db.run('DELETE FROM oauth_clients WHERE client_id = ?', [registered.client_id])
})

test('flujo HTTP completo usa la sesión normal, autoriza con PKCE, canjea código y rota refresh', async () => {
  const localResource = `http://127.0.0.1:${fixture.port}/api/mcp`
  const localIssuer = `http://127.0.0.1:${fixture.port}`
  const { verifier, challenge } = pkcePair()
  const authorizationParameters = {
    response_type: 'code',
    client_id: fixture.clientId,
    redirect_uri: fixture.redirectUri,
    state: 'state-test',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: `${MCP_SCOPES.READ} ${MCP_SCOPES.WRITE}`,
    resource: localResource
  }

  const authorizationStart = await requestServer(
    `/api/oauth/authorize?${new URLSearchParams(authorizationParameters)}`
  )
  assert.equal(authorizationStart.statusCode, 302)
  assert.match(authorizationStart.headers.location, /^\/oauth\/authorize\?/)
  assert.doesNotMatch(authorizationStart.text, /api[ _-]?token/i)
  const spaAuthorizationUrl = new URL(authorizationStart.headers.location, localIssuer)
  const sessionBoundParameters = Object.fromEntries(spaAuthorizationUrl.searchParams)
  const authorizationCookie = (Array.isArray(authorizationStart.headers['set-cookie'])
    ? authorizationStart.headers['set-cookie']
    : [authorizationStart.headers['set-cookie']])
    .filter(Boolean)
    .map(value => String(value).split(';', 1)[0])
    .join('; ')
  assert.match(sessionBoundParameters.request_id, /^[A-Za-z0-9_-]{16}$/)
  assert.deepEqual(Object.keys(sessionBoundParameters), ['request_id'])
  assert.match(authorizationCookie, /^ristak_oauth_authorization_request=/)

  const contextWithoutSession = await requestServer(
    `/api/oauth/authorize/context?${new URLSearchParams(sessionBoundParameters)}`
  )
  assert.equal(contextWithoutSession.statusCode, 401)

  const context = await requestServer(
    `/api/oauth/authorize/context?${new URLSearchParams(sessionBoundParameters)}`,
    { headers: { Authorization: `Bearer ${fixture.sessionToken}`, Cookie: authorizationCookie } }
  )
  assert.equal(context.statusCode, 200)
  const contextPayload = JSON.parse(context.text)
  assert.equal(contextPayload.authorization.clientName, 'Codex Test Client')
  assert.equal(contextPayload.authorization.redirectHost, 'client.example.test')
  assert.deepEqual(
    contextPayload.authorization.scopes.map(scope => scope.value),
    [MCP_SCOPES.READ, MCP_SCOPES.WRITE]
  )
  assert.doesNotMatch(context.text, /api[ _-]?token/i)

  const authorization = await requestServer('/api/oauth/authorize/consent', {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.sessionToken}`, Cookie: authorizationCookie },
    body: {
      ...sessionBoundParameters,
      decision: 'approve'
    }
  })
  assert.equal(authorization.statusCode, 200)
  const clearedCookie = (Array.isArray(authorization.headers['set-cookie'])
    ? authorization.headers['set-cookie']
    : [authorization.headers['set-cookie']])
    .filter(Boolean)
    .join('; ')
  assert.match(clearedCookie, /ristak_oauth_authorization_request=;/)
  assert.match(clearedCookie, /Path=\/api\/oauth\/authorize/)
  const callback = new URL(JSON.parse(authorization.text).redirectUrl)
  assert.equal(callback.origin + callback.pathname, fixture.redirectUri)
  assert.equal(callback.searchParams.get('state'), 'state-test')
  const code = callback.searchParams.get('code')
  assert.match(code, /^code_/)

  const exchange = await requestServer('/api/oauth/token', {
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      client_id: fixture.clientId,
      redirect_uri: fixture.redirectUri,
      code_verifier: verifier,
      code,
      resource: localResource
    }
  })
  assert.equal(exchange.statusCode, 200)
  const firstTokens = JSON.parse(exchange.text)
  assert.match(firstTokens.access_token, /^[^.]+\.[^.]+\.[^.]+$/)
  assert.match(firstTokens.refresh_token, /^refresh_/)
  assert.equal(firstTokens.scope, `${MCP_SCOPES.READ} ${MCP_SCOPES.WRITE}`)
  assert.ok(await validateOAuthAccessContext(firstTokens.access_token, {
    issuer: localIssuer,
    audience: localResource
  }))

  const refresh = await requestServer('/api/oauth/token', {
    method: 'POST',
    body: {
      grant_type: 'refresh_token',
      client_id: fixture.clientId,
      refresh_token: firstTokens.refresh_token,
      scope: MCP_SCOPES.READ,
      resource: localResource
    }
  })
  assert.equal(refresh.statusCode, 200)
  const secondTokens = JSON.parse(refresh.text)
  assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token)
  assert.equal(secondTokens.scope, MCP_SCOPES.READ)
  assert.ok(await validateOAuthAccessContext(secondTokens.access_token, {
    issuer: localIssuer,
    audience: localResource
  }))
})

test('consentimiento OAuth deniega a un usuario sin permiso de Developers', async () => {
  const localResource = `http://127.0.0.1:${fixture.port}/api/mcp`
  const { challenge } = pkcePair()
  const response = await requestServer('/api/oauth/authorize/consent', {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.deniedSessionToken}` },
    body: {
      response_type: 'code',
      client_id: fixture.clientId,
      redirect_uri: fixture.redirectUri,
      state: 'denied-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: MCP_SCOPES.READ,
      resource: localResource,
      decision: 'approve'
    }
  })

  assert.equal(response.statusCode, 403)
  const payload = JSON.parse(response.text)
  assert.equal(payload.code, 'write_access_required')
  const codeCount = await db.get(
    'SELECT COUNT(*) AS total FROM oauth_authorization_codes WHERE user_id = ?',
    [fixture.deniedUserId]
  )
  assert.equal(Number(codeCount.total), 0)
})

test('el consentimiento no puede ampliar los scopes que se mostraron al usuario', async () => {
  const localResource = `http://127.0.0.1:${fixture.port}/api/mcp`
  const { verifier, challenge } = pkcePair()
  const requested = {
    response_type: 'code',
    client_id: fixture.clientId,
    redirect_uri: fixture.redirectUri,
    state: 'scope-binding',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: MCP_SCOPES.READ,
    resource: localResource
  }
  const start = await requestServer(`/api/oauth/authorize?${new URLSearchParams(requested)}`)
  assert.equal(start.statusCode, 302)
  const spaUrl = new URL(start.headers.location, `http://127.0.0.1:${fixture.port}`)
  const parameters = Object.fromEntries(spaUrl.searchParams)
  const cookie = (Array.isArray(start.headers['set-cookie'])
    ? start.headers['set-cookie']
    : [start.headers['set-cookie']])
    .filter(Boolean)
    .map(value => String(value).split(';', 1)[0])
    .join('; ')
  const expanded = await requestServer('/api/oauth/authorize/consent', {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.sessionToken}`, Cookie: cookie },
    body: {
      ...parameters,
      scope: `${MCP_SCOPES.READ} ${MCP_SCOPES.WRITE}`,
      decision: 'approve'
    }
  })

  assert.equal(expanded.statusCode, 200)
  const callback = new URL(JSON.parse(expanded.text).redirectUrl)
  const grant = await consumeAuthorizationCode({
    code: callback.searchParams.get('code'),
    clientId: fixture.clientId,
    redirectUri: fixture.redirectUri,
    codeVerifier: verifier
  })
  assert.equal(grant.scope, MCP_SCOPES.READ)
})

test('la autorización OAuth no vuelve a pedir ni aceptar un API token', async () => {
  const source = await readFile(new URL('../src/routes/oauth.routes.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /validateApiTokenUser/)
  assert.doesNotMatch(source, /apiToken/)
  assert.doesNotMatch(source, /type=["']password["']/)
  assert.match(source, /AUTHORIZATION_REQUEST_COOKIE = 'ristak_oauth_authorization_request'/)
  assert.equal((source.match(/secure: originFor\(req\)\.startsWith\('https:\/\/'\)/g) || []).length, 2)
})

test('authorize nunca redirige hacia una URL no registrada', async () => {
  const { challenge } = pkcePair()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: fixture.clientId,
    redirect_uri: 'https://attacker.example.test/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: MCP_SCOPES.READ,
    resource: `http://127.0.0.1:${fixture.port}/api/mcp`
  })
  const response = await requestServer(`/api/oauth/authorize?${query}`)
  assert.equal(response.statusCode, 400)
  assert.equal(response.headers.location, undefined)
  assert.match(response.text, /dirección de regreso no está registrada/i)
})

test('migraciones MCP crean grants, idempotencia y auditoría en ambos dialectos', async () => {
  const [sqliteSql, postgresSql] = await Promise.all([
    readFile(new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/129a_mcp_oauth_control_plane.postgres.sql', import.meta.url), 'utf8')
  ])

  for (const source of [sqliteSql, postgresSql]) {
    assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? oauth_grants/i)
    assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? mcp_idempotency_keys/i)
    assert.match(source, /UNIQUE \(user_id, client_id, tool_name, key_hash\)/i)
    assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? mcp_audit_log/i)
    assert.match(source, /input_redacted_json/i)
    assert.match(source, /result_summary_json/i)
    assert.match(source, /expires_at/i)
  }

  const tables = await db.all(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('oauth_grants', 'mcp_idempotency_keys', 'mcp_audit_log')
    ORDER BY name
  `)
  assert.deepEqual(tables.map(row => row.name), [
    'mcp_audit_log',
    'mcp_idempotency_keys',
    'oauth_grants'
  ])
})
