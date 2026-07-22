import crypto from 'node:crypto'
import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { logger } from '../utils/logger.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { signScopedToken, verifyScopedToken } from '../utils/auth.js'
import { resolveMcpResource, resolveOAuthOrigin } from '../utils/oauthOrigin.js'
import {
  MCP_SCOPE_VALUES,
  OAuthProtocolError,
  consumeAuthorizationCode,
  createAccessToken,
  createAuthorizationCode,
  createRefreshToken,
  getOAuthClient,
  normalizeOAuthRedirectUri,
  normalizeOAuthResource,
  normalizeRequestedScopes,
  registerOAuthClient,
  rotateRefreshToken,
  serializeOAuthScopes
} from '../utils/oauthTokens.js'

const router = express.Router()
const AUTHORIZATION_REQUEST_SCOPE = 'oauth_authorization_request'
const AUTHORIZATION_REQUEST_COOKIE = 'ristak_oauth_authorization_request'
const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60

const oauthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === '1',
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'rate_limited',
      error_description: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.'
    })
  }
})

// El DCR es público por diseño, pero registrar un client_id no concede acceso.
// Esta cuota acota basura automatizada sin introducir un secret manual.
const registrationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === '1',
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'rate_limited',
      error_description: 'Se alcanzó el límite de registros OAuth. Intenta más tarde.'
    })
  }
})

export function originFor(req) {
  return resolveOAuthOrigin(req)
}

export function mcpResourceFor(req) {
  return resolveMcpResource(req)
}

export function authorizationServerMetadata(req) {
  const origin = originFor(req)
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: MCP_SCOPE_VALUES
  }
}

export function protectedResourceMetadata(req) {
  return {
    resource: mcpResourceFor(req),
    resource_name: 'Ristak MCP',
    authorization_servers: [originFor(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: MCP_SCOPE_VALUES
  }
}

function noStore(res) {
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
}

function secureAuthorizationResponse(res) {
  noStore(res)
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
}

function sendOAuthErrorRedirect(res, redirectUri, state, error, description) {
  const target = new URL(redirectUri)
  target.searchParams.set('error', error)
  if (description) target.searchParams.set('error_description', String(description).slice(0, 500))
  if (state) target.searchParams.set('state', String(state).slice(0, 2048))
  secureAuthorizationResponse(res)
  res.redirect(target.toString())
}

function scopeLabel(scope) {
  const labels = {
    'ristak.read': 'Consultar datos',
    'ristak.write': 'Crear y modificar información',
    'ristak.execute': 'Ejecutar acciones externas',
    'ristak.destructive': 'Eliminar o revertir información'
  }
  return labels[scope] || scope
}

function scopeDescription(scope) {
  const descriptions = {
    'ristak.read': 'Ver la información de los módulos que ya tienes permitidos.',
    'ristak.write': 'Crear y actualizar información dentro de esos módulos.',
    'ristak.execute': 'Enviar mensajes y ejecutar acciones en servicios conectados.',
    'ristak.destructive': 'Eliminar, cancelar o revertir información cuando lo solicites.'
  }
  return descriptions[scope] || scope
}

function authorizationParams(authorization) {
  return {
    response_type: 'code',
    client_id: authorization.client.clientId,
    redirect_uri: authorization.redirectUri,
    state: authorization.state,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: 'S256',
    scope: serializeOAuthScopes(authorization.scopes),
    resource: authorization.resource
  }
}

function authorizationSpaLocation(requestId) {
  return `/oauth/authorize?${new URLSearchParams({ request_id: requestId }).toString()}`
}

function authorizationCallbackLocation(authorization, { code, error, description } = {}) {
  const target = new URL(authorization.redirectUri)
  if (code) target.searchParams.set('code', code)
  if (error) target.searchParams.set('error', error)
  if (description) target.searchParams.set('error_description', String(description).slice(0, 500))
  if (authorization.state) target.searchParams.set('state', authorization.state)
  return target.toString()
}

function authorizationRequestSource(req) {
  return req.method === 'POST' ? req.body : req.query
}

function readRequestCookie(req, name) {
  const rawCookies = String(req.headers.cookie || '').split(';')
  for (const rawCookie of rawCookies) {
    const separator = rawCookie.indexOf('=')
    if (separator < 0) continue
    if (rawCookie.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(rawCookie.slice(separator + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

function startAuthorizationRequest(req, res, authorization) {
  const requestId = crypto.randomBytes(12).toString('base64url')
  const signedRequest = signScopedToken(AUTHORIZATION_REQUEST_SCOPE, {
    requestId,
    authorization: authorizationParams(authorization)
  }, AUTHORIZATION_REQUEST_TTL_SECONDS)

  // Una sola cookie acota el tamaño del header aun si un cliente reinicia OAuth
  // muchas veces. Un inicio nuevo invalida el anterior de forma intencional.
  res.cookie(AUTHORIZATION_REQUEST_COOKIE, signedRequest, {
    httpOnly: true,
    secure: originFor(req).startsWith('https://'),
    sameSite: 'lax',
    path: '/api/oauth/authorize',
    maxAge: AUTHORIZATION_REQUEST_TTL_SECONDS * 1000
  })
  return requestId
}

function clearAuthorizationRequest(req, res, requestId) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(requestId)) return
  res.clearCookie(AUTHORIZATION_REQUEST_COOKIE, {
    httpOnly: true,
    secure: originFor(req).startsWith('https://'),
    sameSite: 'lax',
    path: '/api/oauth/authorize'
  })
}

async function resolveAuthorizationRequestSession(req) {
  const requestId = String(authorizationRequestSource(req).request_id || '')
  if (!/^[A-Za-z0-9_-]{16}$/.test(requestId)) {
    throw new OAuthProtocolError('invalid_request', 'La solicitud de autorización expiró o está incompleta.')
  }

  const signedRequest = readRequestCookie(req, AUTHORIZATION_REQUEST_COOKIE)
  const payload = verifyScopedToken(AUTHORIZATION_REQUEST_SCOPE, signedRequest)
  const stored = payload?.requestId === requestId && payload.authorization && typeof payload.authorization === 'object'
    ? payload.authorization
    : null

  if (!stored) {
    throw new OAuthProtocolError('invalid_request', 'La solicitud OAuth expiró o ya no coincide con esta sesión.')
  }

  const authorization = await resolveAuthorizationRequest(req, stored)
  const canonical = authorizationParams(authorization)
  const unchanged = Object.entries(canonical)
    .every(([name, value]) => String(stored[name] || '') === String(value || ''))
  if (!unchanged) {
    const error = new OAuthProtocolError('invalid_request', 'La solicitud OAuth firmada ya no es válida.')
    error.safeRedirectUri = authorization.redirectUri
    error.state = authorization.state
    throw error
  }

  return { authorization, requestId }
}

function assertSupportedClientMetadata(body = {}) {
  const tokenMethod = body.token_endpoint_auth_method || 'none'
  if (tokenMethod !== 'none') {
    throw new OAuthProtocolError('invalid_client_metadata', 'Sólo se admite token_endpoint_auth_method=none con PKCE.')
  }

  const responseTypes = body.response_types || ['code']
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    throw new OAuthProtocolError('invalid_client_metadata', 'response_types debe ser ["code"].')
  }

  const grantTypes = body.grant_types || ['authorization_code', 'refresh_token']
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.includes('authorization_code') ||
    grantTypes.some(value => !['authorization_code', 'refresh_token'].includes(value))
  ) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'grant_types sólo admite authorization_code y refresh_token.'
    )
  }
}

async function resolveAuthorizationRequest(req, suppliedSource = null) {
  const source = suppliedSource || (req.method === 'POST' ? req.body : req.query)
  const responseType = String(source.response_type || '')
  const clientId = String(source.client_id || '').trim()
  const state = String(source.state || '').slice(0, 2048)
  const codeChallenge = String(source.code_challenge || '')
  const codeChallengeMethod = String(source.code_challenge_method || '')

  const client = await getOAuthClient(clientId)
  if (!client) {
    throw new OAuthProtocolError('invalid_request', 'Cliente OAuth desconocido o revocado.')
  }

  let redirectUri
  try {
    redirectUri = normalizeOAuthRedirectUri(source.redirect_uri)
  } catch {
    throw new OAuthProtocolError('invalid_request', 'La dirección de regreso no es válida.')
  }
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthProtocolError('invalid_request', 'La dirección de regreso no está registrada para este cliente.')
  }

  if (responseType !== 'code') {
    const error = new OAuthProtocolError('unsupported_response_type', 'response_type debe ser code')
    error.safeRedirectUri = redirectUri
    error.state = state
    throw error
  }
  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    const error = new OAuthProtocolError('invalid_request', 'PKCE S256 es obligatorio.')
    error.safeRedirectUri = redirectUri
    error.state = state
    throw error
  }

  let scopes
  try {
    scopes = normalizeRequestedScopes(source.scope)
  } catch (error) {
    error.safeRedirectUri = redirectUri
    error.state = state
    throw error
  }

  let resource
  try {
    resource = normalizeOAuthResource(source.resource || mcpResourceFor(req))
  } catch (error) {
    error.safeRedirectUri = redirectUri
    error.state = state
    throw error
  }
  const expectedResource = normalizeOAuthResource(mcpResourceFor(req))
  if (resource !== expectedResource) {
    const error = new OAuthProtocolError('invalid_target', 'Este servidor sólo autoriza su endpoint MCP.')
    error.safeRedirectUri = redirectUri
    error.state = state
    throw error
  }

  return {
    client,
    redirectUri,
    state,
    codeChallenge,
    scopes,
    resource
  }
}

function oauthJsonError(res, error, fallbackCode = 'invalid_request') {
  const status = error instanceof OAuthProtocolError ? error.status : 400
  noStore(res)
  return res.status(status).json({
    error: error?.code || fallbackCode,
    error_description: String(error?.message || 'Solicitud OAuth inválida.').slice(0, 500)
  })
}

router.get('/.well-known/oauth-protected-resource*', (req, res) => {
  res.json(protectedResourceMetadata(req))
})

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(authorizationServerMetadata(req))
})

router.get('/.well-known/openid-configuration', (req, res) => {
  res.json(authorizationServerMetadata(req))
})

router.post('/api/oauth/register', registrationRateLimiter, async (req, res) => {
  try {
    assertSupportedClientMetadata(req.body)
    const client = await registerOAuthClient({
      clientName: req.body.client_name,
      redirectUris: req.body.redirect_uris,
      clientUri: req.body.client_uri,
      softwareId: req.body.software_id,
      softwareVersion: req.body.software_version
    })
    noStore(res)
    res.status(201).json(client)
  } catch (error) {
    oauthJsonError(res, error, 'invalid_client_metadata')
  }
})

router.get('/api/oauth/authorize', oauthRateLimiter, async (req, res) => {
  try {
    const authorization = await resolveAuthorizationRequest(req)
    const requestId = startAuthorizationRequest(req, res, authorization)
    secureAuthorizationResponse(res)
    res.redirect(authorizationSpaLocation(requestId))
  } catch (error) {
    if (error?.safeRedirectUri) {
      return sendOAuthErrorRedirect(
        res,
        error.safeRedirectUri,
        error.state,
        error.code || 'invalid_request',
        error.message
      )
    }
    oauthJsonError(res, error)
  }
})

router.get(
  '/api/oauth/authorize/context',
  oauthRateLimiter,
  requireAuth,
  requireFeature('developers'),
  requireModuleAccess('settings_api_access'),
  async (req, res) => {
    try {
      const { authorization } = await resolveAuthorizationRequestSession(req)
      secureAuthorizationResponse(res)
      res.json({
        success: true,
        authorization: {
          clientId: authorization.client.clientId,
          clientName: authorization.client.clientName,
          clientUri: authorization.client.clientUri,
          redirectHost: new URL(authorization.redirectUri).host,
          scopes: authorization.scopes.map(scope => ({
            value: scope,
            label: scopeLabel(scope),
            description: scopeDescription(scope)
          }))
        }
      })
    } catch (error) {
      oauthJsonError(res, error)
    }
  }
)

router.post(
  '/api/oauth/authorize/consent',
  oauthRateLimiter,
  requireAuth,
  requireFeature('developers'),
  requireModuleAccess('settings_api_access'),
  async (req, res) => {
    try {
      const { authorization, requestId } = await resolveAuthorizationRequestSession(req)

      if (req.body.decision === 'deny') {
        clearAuthorizationRequest(req, res, requestId)
        secureAuthorizationResponse(res)
        return res.json({
          success: true,
          redirectUrl: authorizationCallbackLocation(authorization, {
            error: 'access_denied',
            description: 'La persona canceló la autorización en Ristak.'
          })
        })
      }

      if (req.body.decision !== 'approve') {
        throw new OAuthProtocolError('invalid_request', 'La decisión de consentimiento no es válida.')
      }

      const code = await createAuthorizationCode({
        userId: req.user.userId,
        clientId: authorization.client.clientId,
        redirectUri: authorization.redirectUri,
        codeChallenge: authorization.codeChallenge,
        scope: authorization.scopes,
        resource: authorization.resource
      })

      clearAuthorizationRequest(req, res, requestId)
      secureAuthorizationResponse(res)
      res.json({
        success: true,
        redirectUrl: authorizationCallbackLocation(authorization, { code })
      })
    } catch (error) {
      clearAuthorizationRequest(req, res, String(req.body?.request_id || ''))
      if (error?.safeRedirectUri) {
        const target = new URL(error.safeRedirectUri)
        target.searchParams.set('error', error.code || 'invalid_request')
        target.searchParams.set('error_description', String(error.message || 'Solicitud OAuth inválida.').slice(0, 500))
        if (error.state) target.searchParams.set('state', String(error.state).slice(0, 2048))
        secureAuthorizationResponse(res)
        return res.status(error.status || 400).json({
          error: error.code || 'invalid_request',
          error_description: String(error.message || 'Solicitud OAuth inválida.').slice(0, 500),
          redirectUrl: target.toString()
        })
      }
      logger.error('Error en OAuth authorize:', error)
      oauthJsonError(res, error)
    }
  }
)

router.post('/api/oauth/token', oauthRateLimiter, async (req, res) => {
  noStore(res)
  try {
    const grantType = String(req.body.grant_type || '')
    const clientId = String(req.body.client_id || '').trim()
    const client = await getOAuthClient(clientId)
    if (!client) {
      return res.status(400).json({ error: 'invalid_client' })
    }

    const resource = normalizeOAuthResource(req.body.resource || mcpResourceFor(req))
    const expectedResource = normalizeOAuthResource(mcpResourceFor(req))
    if (resource !== expectedResource) {
      throw new OAuthProtocolError('invalid_target', 'Este servidor sólo emite tokens para su endpoint MCP.')
    }

    let grant
    let refreshToken
    if (grantType === 'authorization_code') {
      grant = await consumeAuthorizationCode({
        code: req.body.code,
        clientId,
        redirectUri: req.body.redirect_uri,
        codeVerifier: req.body.code_verifier
      })
      if (grant && grant.resource === resource) {
        refreshToken = await createRefreshToken({
          grantId: grant.grantId,
          userId: grant.userId,
          clientId: grant.clientId,
          scope: grant.scope,
          resource: grant.resource
        })
      }
    } else if (grantType === 'refresh_token') {
      grant = await rotateRefreshToken({
        refreshToken: req.body.refresh_token,
        clientId,
        scope: req.body.scope
      })
      if (grant && grant.resource === resource) refreshToken = grant.refreshToken
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' })
    }

    if (!grant || grant.resource !== resource || !refreshToken) {
      return res.status(400).json({ error: 'invalid_grant' })
    }

    const { accessToken, expiresIn } = createAccessToken({
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      userId: grant.userId,
      clientId: grant.clientId,
      issuer: originFor(req),
      audience: grant.resource,
      scope: grant.scope
    })

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: serializeOAuthScopes(grant.scope)
    })
  } catch (error) {
    if (error instanceof OAuthProtocolError) {
      return oauthJsonError(res, error)
    }
    logger.error('Error en OAuth token:', error)
    res.status(500).json({ error: 'server_error' })
  }
})

export default router
