import crypto from 'crypto'
import { isIP } from 'node:net'
import { db } from '../config/database.js'
import { authenticateApiToken } from './apiTokens.js'

const AUTH_CODE_TTL_SECONDS = 10 * 60
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const OAUTH_ACCESS_TOKEN_VERSION = 2
const MAX_CLIENT_NAME_LENGTH = 120
const MAX_CLIENT_URI_LENGTH = 2048
const MAX_REDIRECT_URIS = 10
const MAX_REDIRECT_URI_LENGTH = 2048
// Reutiliza JWT_SECRET en instalaciones normales. En desarrollo sin secret,
// usa uno efímero e impredecible: un fallback fijo convertiría cualquier token
// OAuth local en falsificable con sólo leer el repositorio.
const OAUTH_SECRET = process.env.OAUTH_TOKEN_SECRET || process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? ''
    : crypto.randomBytes(48).toString('hex')
)

if (!OAUTH_SECRET) {
  throw new Error('OAUTH_TOKEN_SECRET o JWT_SECRET es requerido en producción')
}

export const MCP_SCOPES = Object.freeze({
  READ: 'ristak.read',
  WRITE: 'ristak.write',
  EXECUTE: 'ristak.execute',
  DESTRUCTIVE: 'ristak.destructive'
})

export const MCP_SCOPE_VALUES = Object.freeze(Object.values(MCP_SCOPES))

export class OAuthProtocolError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OAuthProtocolError'
    this.code = code
    this.status = status
  }
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

function parseScopeValues(value) {
  const entries = Array.isArray(value) ? value : [value]
  return entries
    .flatMap(entry => String(entry || '').trim().split(/\s+/))
    .map(scope => scope.trim())
    .filter(Boolean)
}

export function normalizeRequestedScopes(value, {
  defaultScopes = [MCP_SCOPES.READ],
  strict = true
} = {}) {
  const requested = parseScopeValues(value)
  const resolved = requested.length ? requested : parseScopeValues(defaultScopes)
  const unknown = resolved.filter(scope => !MCP_SCOPE_VALUES.includes(scope))

  if (strict && unknown.length) {
    throw new OAuthProtocolError(
      'invalid_scope',
      `Scopes no soportados: ${Array.from(new Set(unknown)).join(', ')}`
    )
  }

  const requestedSet = new Set(resolved.filter(scope => MCP_SCOPE_VALUES.includes(scope)))
  return MCP_SCOPE_VALUES.filter(scope => requestedSet.has(scope))
}

export function serializeOAuthScopes(value, options = {}) {
  return normalizeRequestedScopes(value, options).join(' ')
}

export function hasGrantedScope(grantedScopes, requiredScopes) {
  const rawRequired = parseScopeValues(requiredScopes)
  if (rawRequired.some(scope => !MCP_SCOPE_VALUES.includes(scope))) return false
  const granted = new Set(normalizeRequestedScopes(grantedScopes, {
    defaultScopes: [],
    strict: false
  }))
  const required = normalizeRequestedScopes(rawRequired, {
    defaultScopes: [],
    strict: false
  })
  return required.every(scope => granted.has(scope))
}

function cleanDisplayText(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH)
  return cleaned || fallback
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1') return true
  if (isIP(normalized) === 4) {
    const firstOctet = Number(normalized.split('.')[0])
    return firstOctet === 127
  }
  return false
}

export function normalizeOAuthRedirectUri(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > MAX_REDIRECT_URI_LENGTH) {
    throw new OAuthProtocolError('invalid_client_metadata', 'Cada redirect_uri debe ser una URL válida.')
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new OAuthProtocolError('invalid_client_metadata', 'Cada redirect_uri debe ser una URL absoluta válida.')
  }

  if (url.username || url.password || url.hash) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'redirect_uri no puede incluir credenciales ni fragmentos.'
    )
  }

  const secure = url.protocol === 'https:'
  const loopback = url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  if (!secure && !loopback) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'redirect_uri debe usar HTTPS; HTTP sólo se permite en loopback local.'
    )
  }

  return url.toString()
}

function normalizeOptionalClientUri(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.length > MAX_CLIENT_URI_LENGTH) {
    throw new OAuthProtocolError('invalid_client_metadata', 'client_uri excede el tamaño permitido.')
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new OAuthProtocolError('invalid_client_metadata', 'client_uri debe ser una URL absoluta válida.')
  }

  if (url.username || url.password || url.hash) {
    throw new OAuthProtocolError('invalid_client_metadata', 'client_uri no puede incluir credenciales ni fragmentos.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new OAuthProtocolError('invalid_client_metadata', 'client_uri debe usar HTTPS o loopback local.')
  }
  return url.toString()
}

export function normalizeOAuthResource(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > MAX_REDIRECT_URI_LENGTH) {
    throw new OAuthProtocolError('invalid_target', 'resource debe ser una URL absoluta válida.')
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new OAuthProtocolError('invalid_target', 'resource debe ser una URL absoluta válida.')
  }

  if (url.username || url.password || url.hash || url.search) {
    throw new OAuthProtocolError('invalid_target', 'resource no puede incluir credenciales, query ni fragmento.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new OAuthProtocolError('invalid_target', 'resource debe usar HTTPS o loopback local.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString()
}

function normalizeIssuer(value) {
  const raw = String(value || '').trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new OAuthProtocolError('invalid_request', 'issuer inválido.')
  }
  if (url.username || url.password || url.hash || url.search || (url.pathname && url.pathname !== '/')) {
    throw new OAuthProtocolError('invalid_request', 'issuer inválido.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new OAuthProtocolError('invalid_request', 'issuer debe usar HTTPS o loopback local.')
  }
  return url.origin
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

function parseAndVerifyJwt(token) {
  if (!token) return null

  try {
    const segments = String(token).split('.')
    if (segments.length !== 3) return null
    const [encodedHeader, encodedPayload, signature] = segments
    if (!encodedHeader || !encodedPayload || !signature) return null

    const expectedSignature = crypto
      .createHmac('sha256', OAUTH_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url')

    const expected = Buffer.from(expectedSignature, 'utf8')
    const received = Buffer.from(signature, 'utf8')
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return null
    }

    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    if (payload.typ !== 'ristak_oauth_access') return null
    if (payload.ver !== OAUTH_ACCESS_TOKEN_VERSION) return null
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= now) return null
    if (payload.iat > now + 60 || payload.exp - payload.iat > ACCESS_TOKEN_TTL_SECONDS) return null
    if (payload.nbf && (!Number.isFinite(payload.nbf) || payload.nbf > now)) return null
    if (!payload.iss || !payload.aud || !payload.sub || !payload.clientId) return null
    if (!payload.grantId || !Number.isInteger(payload.grantVersion)) return null
    normalizeRequestedScopes(payload.scope, { defaultScopes: [], strict: true })
    return payload
  } catch {
    return null
  }
}

export function verifyOAuthAccessToken(token, expectedAudienceOrOptions = null) {
  const payload = parseAndVerifyJwt(token)
  if (!payload) return null

  try {
    const options = typeof expectedAudienceOrOptions === 'string'
      ? { audience: expectedAudienceOrOptions }
      : (expectedAudienceOrOptions || {})
    if (options.audience && payload.aud !== normalizeOAuthResource(options.audience)) return null
    if (options.issuer && payload.iss !== normalizeIssuer(options.issuer)) return null
    return payload
  } catch {
    return null
  }
}

export async function validateOAuthAccessContext(token, { audience, issuer } = {}) {
  const payload = verifyOAuthAccessToken(token, { audience, issuer })
  if (!payload) return null

  const row = await db.get(
    `SELECT
       grants.grant_id,
       grants.user_id,
       grants.client_id,
       grants.scope AS grant_scope,
       grants.resource,
       grants.version AS grant_version,
       grants.revoked_at AS grant_revoked_at,
       clients.client_name,
       clients.revoked_at AS client_revoked_at,
       users.username,
       users.email,
       users.full_name,
       users.role,
       users.access_config,
       users.is_active
     FROM oauth_grants grants
     JOIN oauth_clients clients ON clients.client_id = grants.client_id
     JOIN users ON users.id = grants.user_id
     WHERE grants.grant_id = ?
       AND grants.user_id = ?
       AND grants.client_id = ?`,
    [payload.grantId, payload.userId, payload.clientId]
  )

  if (!row || !row.is_active || row.grant_revoked_at || row.client_revoked_at) return null
  if (Number(row.grant_version) !== Number(payload.grantVersion)) return null
  if (String(row.resource || '') !== String(payload.aud || '')) return null
  if (!hasGrantedScope(row.grant_scope, payload.scope)) return null

  await db.run(
    'UPDATE oauth_grants SET last_used_at = CURRENT_TIMESTAMP WHERE grant_id = ?',
    [row.grant_id]
  )

  return {
    ...payload,
    scopes: normalizeRequestedScopes(payload.scope),
    user: {
      id: row.user_id,
      userId: row.user_id,
      username: row.username,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      access_config: row.access_config
    },
    grant: {
      id: row.grant_id,
      clientId: row.client_id,
      clientName: row.client_name,
      scopes: normalizeRequestedScopes(row.grant_scope),
      resource: row.resource,
      version: Number(row.grant_version)
    }
  }
}

export async function getOAuthClient(clientId) {
  if (!clientId) return null

  const client = await db.get(
    `SELECT client_id, client_name, redirect_uris, client_uri, software_id,
            software_version, created_at, revoked_at
     FROM oauth_clients
     WHERE client_id = ?`,
    [clientId]
  )

  if (!client || client.revoked_at) return null

  let redirectUris = []
  try {
    const storedRedirectUris = JSON.parse(client.redirect_uris || '[]')
    if (!Array.isArray(storedRedirectUris)) return null
    redirectUris = Array.from(new Set(
      storedRedirectUris.map(uri => normalizeOAuthRedirectUri(uri))
    ))
  } catch {
    return null
  }
  if (!redirectUris.length) return null

  return {
    clientId: client.client_id,
    clientName: client.client_name,
    redirectUris,
    clientUri: client.client_uri || null,
    softwareId: client.software_id || null,
    softwareVersion: client.software_version || null,
    createdAt: client.created_at || null
  }
}

export async function registerOAuthClient({
  clientName,
  redirectUris = [],
  clientUri,
  softwareId,
  softwareVersion
}) {
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      `redirect_uris debe incluir entre 1 y ${MAX_REDIRECT_URIS} URLs.`
    )
  }

  const uniqueRedirectUris = Array.from(new Set(redirectUris.map(normalizeOAuthRedirectUri)))
  const normalizedClientName = cleanDisplayText(clientName, 'Cliente MCP externo')
  const normalizedClientUri = normalizeOptionalClientUri(clientUri)
  const normalizedSoftwareId = cleanDisplayText(softwareId, '').slice(0, 160) || null
  const normalizedSoftwareVersion = cleanDisplayText(softwareVersion, '').slice(0, 80) || null
  const clientId = `client_${randomToken(18)}`

  await db.run(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, client_uri, software_id,
       software_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      clientId,
      normalizedClientName,
      JSON.stringify(uniqueRedirectUris),
      normalizedClientUri,
      normalizedSoftwareId,
      normalizedSoftwareVersion
    ]
  )

  return {
    client_id: clientId,
    client_name: normalizedClientName,
    redirect_uris: uniqueRedirectUris,
    client_uri: normalizedClientUri || undefined,
    software_id: normalizedSoftwareId || undefined,
    software_version: normalizedSoftwareVersion || undefined,
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000)
  }
}

export async function validateApiTokenUser(rawToken) {
  return authenticateApiToken(rawToken)
}

async function revokeGrantInTransaction(transaction, grantId, revokedByUserId = null) {
  const result = await transaction.run(
    `UPDATE oauth_grants
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
         revoked_by_user_id = COALESCE(revoked_by_user_id, ?),
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE grant_id = ?
       AND revoked_at IS NULL`,
    [revokedByUserId, grantId]
  )

  await transaction.run(
    `UPDATE oauth_refresh_tokens
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE grant_id = ?`,
    [grantId]
  )
  return Number(result?.changes || 0) > 0
}

async function upsertOAuthGrant(transaction, { userId, clientId, scope, resource }) {
  const normalizedScope = serializeOAuthScopes(scope)
  const normalizedResource = normalizeOAuthResource(resource)
  const proposedGrantId = `grant_${randomToken(24)}`
  await transaction.run(
    `INSERT INTO oauth_grants (
       grant_id, user_id, client_id, scope, resource, version,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, client_id, resource) DO UPDATE SET
       scope = excluded.scope,
       version = oauth_grants.version + 1,
       revoked_at = NULL,
       revoked_by_user_id = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [proposedGrantId, userId, clientId, normalizedScope, normalizedResource]
  )
  const grant = await transaction.get(
    `SELECT * FROM oauth_grants
     WHERE user_id = ? AND client_id = ? AND resource = ?`,
    [userId, clientId, normalizedResource]
  )
  await transaction.run(
    `UPDATE oauth_refresh_tokens
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE grant_id = ?`,
    [grant.grant_id]
  )
  return grant
}

export async function createAuthorizationCode({
  userId,
  clientId,
  redirectUri,
  codeChallenge,
  scope,
  resource
}) {
  const normalizedRedirectUri = normalizeOAuthRedirectUri(redirectUri)
  const normalizedScope = serializeOAuthScopes(scope)
  const normalizedResource = normalizeOAuthResource(resource)
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge || ''))) {
    throw new OAuthProtocolError('invalid_request', 'code_challenge PKCE S256 inválido.')
  }

  const code = `code_${randomToken(32)}`
  const codeHash = hashToken(code)

  await db.transaction(async transaction => {
    const grant = await upsertOAuthGrant(transaction, {
      userId,
      clientId,
      scope: normalizedScope,
      resource: normalizedResource
    })

    // Sólo la autorización más reciente del mismo usuario/cliente/recurso puede
    // canjearse. Evita que dos consentimientos concurrentes reanimen scopes viejos.
    await transaction.run(
      `UPDATE oauth_authorization_codes
       SET used_at = CURRENT_TIMESTAMP
       WHERE grant_id = ? AND used_at IS NULL`,
      [grant.grant_id]
    )

    await transaction.run(
      `INSERT INTO oauth_authorization_codes (
         code_hash, user_id, client_id, redirect_uri, code_challenge,
         scope, resource, grant_id, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        codeHash,
        userId,
        clientId,
        normalizedRedirectUri,
        codeChallenge,
        normalizedScope,
        normalizedResource,
        grant.grant_id,
        toTimestamp(AUTH_CODE_TTL_SECONDS)
      ]
    )
  })

  return code
}

export async function consumeAuthorizationCode({
  code,
  clientId,
  redirectUri,
  codeVerifier
}) {
  if (!code || !clientId || !redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(String(codeVerifier || ''))) {
    return null
  }

  let normalizedRedirectUri
  try {
    normalizedRedirectUri = normalizeOAuthRedirectUri(redirectUri)
  } catch {
    return null
  }

  const codeHash = hashToken(code)
  return db.transaction(async transaction => {
    const row = await transaction.get(
      `SELECT
         codes.*,
         grants.version AS grant_version,
         grants.scope AS grant_scope,
         grants.revoked_at AS grant_revoked_at,
         clients.revoked_at AS client_revoked_at,
         users.is_active
       FROM oauth_authorization_codes codes
       JOIN oauth_grants grants ON grants.grant_id = codes.grant_id
       JOIN oauth_clients clients ON clients.client_id = codes.client_id
       JOIN users ON users.id = codes.user_id
       WHERE codes.code_hash = ?
         AND codes.client_id = ?
         AND codes.redirect_uri = ?
         AND codes.used_at IS NULL`,
      [codeHash, clientId, normalizedRedirectUri]
    )

    if (
      !row ||
      !row.is_active ||
      row.grant_revoked_at ||
      row.client_revoked_at ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) {
      return null
    }

    const verifierHash = crypto
      .createHash('sha256')
      .update(String(codeVerifier), 'utf8')
      .digest('base64url')
    const expectedChallenge = Buffer.from(String(row.code_challenge || ''), 'utf8')
    const receivedChallenge = Buffer.from(verifierHash, 'utf8')
    if (
      expectedChallenge.length !== receivedChallenge.length ||
      !crypto.timingSafeEqual(expectedChallenge, receivedChallenge)
    ) {
      return null
    }

    const consumed = await transaction.run(
      `UPDATE oauth_authorization_codes
       SET used_at = CURRENT_TIMESTAMP
       WHERE code_hash = ? AND used_at IS NULL`,
      [codeHash]
    )
    if (Number(consumed?.changes || 0) !== 1) return null

    return {
      grantId: row.grant_id,
      grantVersion: Number(row.grant_version),
      userId: row.user_id,
      clientId: row.client_id,
      scope: serializeOAuthScopes(row.scope),
      resource: normalizeOAuthResource(row.resource)
    }
  })
}

export function createAccessToken({
  grantId,
  grantVersion,
  userId,
  clientId,
  issuer,
  audience,
  scope
}) {
  if (!grantId || !Number.isInteger(Number(grantVersion)) || Number(grantVersion) < 1) {
    throw new OAuthProtocolError('invalid_grant', 'El grant OAuth no es válido.')
  }
  const normalizedIssuer = normalizeIssuer(issuer)
  const normalizedAudience = normalizeOAuthResource(audience)
  const normalizedScope = serializeOAuthScopes(scope)
  const now = Math.floor(Date.now() / 1000)

  return {
    accessToken: signJwt({
      typ: 'ristak_oauth_access',
      ver: OAUTH_ACCESS_TOKEN_VERSION,
      iss: normalizedIssuer,
      aud: normalizedAudience,
      sub: String(userId),
      userId,
      clientId,
      grantId,
      grantVersion: Number(grantVersion),
      scope: normalizedScope,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      jti: randomToken(16)
    }),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS
  }
}

async function insertRefreshToken(transaction, {
  refreshToken,
  grantId,
  userId,
  clientId,
  scope,
  resource
}) {
  await transaction.run(
    `INSERT INTO oauth_refresh_tokens (
       token_hash, user_id, client_id, scope, resource, grant_id,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      hashToken(refreshToken),
      userId,
      clientId,
      serializeOAuthScopes(scope),
      normalizeOAuthResource(resource),
      grantId,
      toTimestamp(REFRESH_TOKEN_TTL_SECONDS)
    ]
  )
}

export async function createRefreshToken({ grantId, userId, clientId, scope, resource }) {
  const refreshToken = `refresh_${randomToken(32)}`
  await db.transaction(async transaction => {
    const grant = await transaction.get(
      `SELECT
         grants.version,
         grants.revoked_at,
         users.is_active,
         clients.revoked_at AS client_revoked_at
       FROM oauth_grants grants
       JOIN users ON users.id = grants.user_id
       JOIN oauth_clients clients ON clients.client_id = grants.client_id
       WHERE grants.grant_id = ? AND grants.user_id = ? AND grants.client_id = ?`,
      [grantId, userId, clientId]
    )
    if (!grant || grant.revoked_at || grant.client_revoked_at || !grant.is_active) {
      throw new OAuthProtocolError('invalid_grant', 'El grant OAuth ya no está activo.')
    }
    await insertRefreshToken(transaction, {
      refreshToken,
      grantId,
      userId,
      clientId,
      scope,
      resource
    })
  })
  return refreshToken
}

export async function rotateRefreshToken({ refreshToken, clientId, scope } = {}) {
  if (!refreshToken || !clientId) return null
  const tokenHash = hashToken(refreshToken)

  return db.transaction(async transaction => {
    const row = await transaction.get(
      `SELECT
         tokens.*,
         grants.scope AS grant_scope,
         grants.resource AS grant_resource,
         grants.version AS grant_version,
         grants.revoked_at AS grant_revoked_at,
         clients.revoked_at AS client_revoked_at,
         users.is_active
       FROM oauth_refresh_tokens tokens
       LEFT JOIN oauth_grants grants ON grants.grant_id = tokens.grant_id
       LEFT JOIN oauth_clients clients ON clients.client_id = tokens.client_id
       LEFT JOIN users ON users.id = tokens.user_id
       WHERE tokens.token_hash = ?
         AND tokens.client_id = ?`,
      [tokenHash, clientId]
    )

    if (!row) return null

    if (row.used_at || row.rotated_to_hash) {
      if (row.grant_id) await revokeGrantInTransaction(transaction, row.grant_id)
      return null
    }

    if (
      row.revoked_at ||
      !row.grant_id ||
      row.grant_revoked_at ||
      row.client_revoked_at ||
      !row.is_active ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) {
      if (!row.is_active && row.grant_id) {
        await revokeGrantInTransaction(transaction, row.grant_id)
      }
      return null
    }

    const currentScopes = normalizeRequestedScopes(row.scope)
    const requestedScopes = scope
      ? normalizeRequestedScopes(scope, { defaultScopes: [] })
      : currentScopes
    if (!hasGrantedScope(currentScopes, requestedScopes) || !hasGrantedScope(row.grant_scope, requestedScopes)) {
      throw new OAuthProtocolError('invalid_scope', 'El refresh token no puede ampliar sus permisos.')
    }

    const nextRefreshToken = `refresh_${randomToken(32)}`
    const nextTokenHash = hashToken(nextRefreshToken)
    const rotated = await transaction.run(
      `UPDATE oauth_refresh_tokens
       SET used_at = CURRENT_TIMESTAMP,
           revoked_at = CURRENT_TIMESTAMP,
           rotated_to_hash = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE token_hash = ?
         AND used_at IS NULL
         AND revoked_at IS NULL`,
      [nextTokenHash, tokenHash]
    )

    if (Number(rotated?.changes || 0) !== 1) {
      await revokeGrantInTransaction(transaction, row.grant_id)
      return null
    }

    await insertRefreshToken(transaction, {
      refreshToken: nextRefreshToken,
      grantId: row.grant_id,
      userId: row.user_id,
      clientId: row.client_id,
      scope: requestedScopes,
      resource: row.grant_resource
    })
    await transaction.run(
      'UPDATE oauth_grants SET last_used_at = CURRENT_TIMESTAMP WHERE grant_id = ?',
      [row.grant_id]
    )

    return {
      refreshToken: nextRefreshToken,
      grantId: row.grant_id,
      grantVersion: Number(row.grant_version),
      userId: row.user_id,
      clientId: row.client_id,
      scope: serializeOAuthScopes(requestedScopes),
      resource: normalizeOAuthResource(row.grant_resource)
    }
  })
}

// Compatibilidad nominal para consumidores anteriores. El token se rota al
// consumirlo; nunca debe reutilizarse ni emitirse sin devolver el reemplazo.
export async function consumeRefreshToken(refreshToken, clientId) {
  return rotateRefreshToken({ refreshToken, clientId })
}

export async function listOAuthConnectionsForUser(userId) {
  const rows = await db.all(
    `SELECT
       grants.grant_id,
       grants.client_id,
       clients.client_name,
       clients.client_uri,
       grants.scope,
       grants.resource,
       grants.created_at,
       grants.updated_at,
       grants.last_used_at,
       grants.revoked_at
     FROM oauth_grants grants
     JOIN oauth_clients clients ON clients.client_id = grants.client_id
     WHERE grants.user_id = ?
       AND grants.revoked_at IS NULL
       AND clients.revoked_at IS NULL
     ORDER BY COALESCE(grants.last_used_at, grants.updated_at, grants.created_at) DESC`,
    [userId]
  )

  return rows.map(row => ({
    id: row.grant_id,
    clientId: row.client_id,
    clientName: row.client_name || 'Cliente MCP externo',
    clientUri: row.client_uri || null,
    scopes: normalizeRequestedScopes(row.scope),
    resource: row.resource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || null
  }))
}

export async function countOAuthConnectionsForUser(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS total
     FROM oauth_grants grants
     JOIN oauth_clients clients ON clients.client_id = grants.client_id
     WHERE grants.user_id = ?
       AND grants.revoked_at IS NULL
       AND clients.revoked_at IS NULL`,
    [userId]
  )
  return Number(row?.total || 0)
}

export async function revokeOAuthGrantForUser({ grantId, userId }) {
  if (!grantId || !userId) return false
  return db.transaction(async transaction => {
    const grant = await transaction.get(
      'SELECT grant_id FROM oauth_grants WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL',
      [grantId, userId]
    )
    if (!grant) return false
    return revokeGrantInTransaction(transaction, grant.grant_id, userId)
  })
}
