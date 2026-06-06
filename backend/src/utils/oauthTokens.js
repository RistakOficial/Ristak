import crypto from 'crypto'
import { db } from '../config/database.js'
import { authenticateApiToken } from './apiTokens.js'

const AUTH_CODE_TTL_SECONDS = 10 * 60
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const OAUTH_SECRET = process.env.OAUTH_TOKEN_SECRET || process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? ''
    : 'ristak-default-secret-change-me'
)

if (!OAUTH_SECRET) {
  throw new Error('OAUTH_TOKEN_SECRET o JWT_SECRET es requerido en producción')
}

function randomToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url')
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function toTimestamp(secondsFromNow) {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString()
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = base64urlJson(header)
  const encodedPayload = base64urlJson(payload)
  const signature = crypto
    .createHmac('sha256', OAUTH_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url')

  return `${encodedHeader}.${encodedPayload}.${signature}`
}

export function verifyOAuthAccessToken(token, expectedAudience) {
  if (!token) return null

  try {
    const [encodedHeader, encodedPayload, signature] = String(token).split('.')
    if (!encodedHeader || !encodedPayload || !signature) return null

    const expectedSignature = crypto
      .createHmac('sha256', OAUTH_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url')

    const expected = Buffer.from(expectedSignature)
    const received = Buffer.from(signature)
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return null
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)

    if (payload.typ !== 'ristak_oauth_access') return null
    if (payload.exp && payload.exp < now) return null
    if (expectedAudience && payload.aud !== expectedAudience) return null

    return payload
  } catch {
    return null
  }
}

export async function getOAuthClient(clientId) {
  if (!clientId) return null

  const client = await db.get(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?',
    [clientId]
  )

  if (!client) return null

  return {
    clientId: client.client_id,
    clientName: client.client_name,
    redirectUris: JSON.parse(client.redirect_uris || '[]')
  }
}

export async function registerOAuthClient({ clientName, redirectUris = [] }) {
  const uniqueRedirectUris = Array.from(new Set(
    redirectUris
      .map(uri => String(uri || '').trim())
      .filter(Boolean)
  ))

  if (!uniqueRedirectUris.length) {
    throw new Error('redirect_uris requerido')
  }

  const clientId = `client_${randomToken(18)}`

  await db.run(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
     VALUES (?, ?, ?)`,
    [clientId, clientName || 'External MCP client', JSON.stringify(uniqueRedirectUris)]
  )

  return {
    client_id: clientId,
    client_name: clientName || 'External MCP client',
    redirect_uris: uniqueRedirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000)
  }
}

export async function validateApiTokenUser(rawToken) {
  return authenticateApiToken(rawToken)
}

export async function createAuthorizationCode({
  userId,
  clientId,
  redirectUri,
  codeChallenge,
  scope,
  resource
}) {
  const code = `code_${randomToken(32)}`
  const codeHash = hashToken(code)

  await db.run(
    `INSERT INTO oauth_authorization_codes (
       code_hash, user_id, client_id, redirect_uri, code_challenge,
       scope, resource, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      codeHash,
      userId,
      clientId,
      redirectUri,
      codeChallenge,
      scope || 'ristak.read',
      resource || null,
      toTimestamp(AUTH_CODE_TTL_SECONDS)
    ]
  )

  return code
}

export async function consumeAuthorizationCode({
  code,
  clientId,
  redirectUri,
  codeVerifier
}) {
  const codeHash = hashToken(code)
  const row = await db.get(
    `SELECT * FROM oauth_authorization_codes
     WHERE code_hash = ?
       AND client_id = ?
       AND redirect_uri = ?
       AND used_at IS NULL`,
    [codeHash, clientId, redirectUri]
  )

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return null
  }

  const verifierHash = crypto
    .createHash('sha256')
    .update(String(codeVerifier || ''), 'utf8')
    .digest('base64url')

  if (verifierHash !== row.code_challenge) {
    return null
  }

  await db.run(
    'UPDATE oauth_authorization_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ?',
    [codeHash]
  )

  return {
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope || 'ristak.read',
    resource: row.resource || null
  }
}

export function createAccessToken({ userId, clientId, issuer, audience, scope }) {
  const now = Math.floor(Date.now() / 1000)

  return {
    accessToken: signJwt({
      typ: 'ristak_oauth_access',
      iss: issuer,
      aud: audience,
      sub: String(userId),
      userId,
      clientId,
      scope: scope || 'ristak.read',
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      jti: randomToken(16)
    }),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS
  }
}

export async function createRefreshToken({ userId, clientId, scope, resource }) {
  const refreshToken = `refresh_${randomToken(32)}`

  await db.run(
    `INSERT INTO oauth_refresh_tokens (
       token_hash, user_id, client_id, scope, resource, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      hashToken(refreshToken),
      userId,
      clientId,
      scope || 'ristak.read',
      resource || null,
      toTimestamp(REFRESH_TOKEN_TTL_SECONDS)
    ]
  )

  return refreshToken
}

export async function consumeRefreshToken(refreshToken, clientId) {
  const tokenHash = hashToken(refreshToken)
  const row = await db.get(
    `SELECT * FROM oauth_refresh_tokens
     WHERE token_hash = ?
       AND client_id = ?
       AND revoked_at IS NULL`,
    [tokenHash, clientId]
  )

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return null
  }

  return {
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope || 'ristak.read',
    resource: row.resource || null
  }
}
