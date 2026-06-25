import express from 'express'
import { logger } from '../utils/logger.js'
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  createAccessToken,
  createAuthorizationCode,
  createRefreshToken,
  getOAuthClient,
  registerOAuthClient,
  validateApiTokenUser
} from '../utils/oauthTokens.js'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'

const router = express.Router()

// (AUTH-001 / SEC-004) Rate limiting por IP para los endpoints OAuth sensibles:
// /authorize (valida API token, brute-forceable) y /token (canjeo de códigos).
// Sin esto un atacante puede iterar API tokens / códigos sin límite.
const oauthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === '1',
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({
      error: 'rate_limited',
      error_description: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.'
    })
  }
})

function originFor(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${proto}://${host}` : ''
}

function mcpResourceFor(req) {
  return `${originFor(req)}/api/mcp`
}

function authorizationServerMetadata(req) {
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
    scopes_supported: ['ristak.read']
  }
}

function protectedResourceMetadata(req) {
  return {
    resource: mcpResourceFor(req),
    resource_name: 'Ristak MCP',
    authorization_servers: [originFor(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['ristak.read']
  }
}

function sendOAuthErrorRedirect(res, redirectUri, state, error, description) {
  const target = new URL(redirectUri)
  target.searchParams.set('error', error)
  if (description) target.searchParams.set('error_description', description)
  if (state) target.searchParams.set('state', state)
  res.redirect(target.toString())
}

function renderAuthorizeForm(req, res, error = '') {
  const params = {
    response_type: req.query.response_type || req.body.response_type || '',
    client_id: req.query.client_id || req.body.client_id || '',
    redirect_uri: req.query.redirect_uri || req.body.redirect_uri || '',
    state: req.query.state || req.body.state || '',
    code_challenge: req.query.code_challenge || req.body.code_challenge || '',
    code_challenge_method: req.query.code_challenge_method || req.body.code_challenge_method || '',
    scope: req.query.scope || req.body.scope || 'ristak.read',
    resource: req.query.resource || req.body.resource || mcpResourceFor(req)
  }

  const hiddenInputs = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}" />`)
    .join('\n')

  res.type('html').send(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Autorizar Ristak</title>
    <style>
      body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(420px, calc(100vw - 32px)); background: white; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; box-shadow: 0 24px 60px rgba(15, 23, 42, .12); }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { color: #475569; line-height: 1.5; margin: 0 0 18px; }
      label { display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 8px; }
      input[type="password"] { width: 100%; box-sizing: border-box; height: 42px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font-size: 14px; }
      button { margin-top: 16px; width: 100%; height: 42px; border: 0; border-radius: 10px; background: #0f172a; color: white; font-weight: 700; cursor: pointer; }
      .error { background: #fee2e2; color: #991b1b; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
      small { display: block; color: #64748b; margin-top: 12px; line-height: 1.4; }
    </style>
  </head>
  <body>
    <main>
      <h1>Autorizar acceso a Ristak</h1>
      <p>Autoriza este conector usando tu API token de Ristak. El token se valida y se cambia por credenciales seguras para este cliente.</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="post" action="/api/oauth/authorize">
        ${hiddenInputs}
        <label for="apiToken">API token</label>
        <input id="apiToken" name="apiToken" type="password" autocomplete="off" required />
        <button type="submit">Autorizar</button>
      </form>
      <small>Genera o rota el token en Ristak: Configuración > Acceso API.</small>
    </main>
  </body>
</html>`)
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

router.post('/api/oauth/register', async (req, res) => {
  try {
    const client = await registerOAuthClient({
      clientName: req.body.client_name,
      redirectUris: Array.isArray(req.body.redirect_uris) ? req.body.redirect_uris : []
    })

    res.status(201).json(client)
  } catch (error) {
    res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: error.message
    })
  }
})

router.get('/api/oauth/authorize', (req, res) => {
  renderAuthorizeForm(req, res)
})

router.post('/api/oauth/authorize', oauthRateLimiter, async (req, res) => {
  try {
    const {
      response_type: responseType,
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      scope,
      resource,
      apiToken
    } = req.body

    if (responseType !== 'code') {
      return sendOAuthErrorRedirect(res, redirectUri, state, 'unsupported_response_type', 'response_type debe ser code')
    }

    const client = await getOAuthClient(clientId)
    if (!client || !client.redirectUris.includes(redirectUri)) {
      return renderAuthorizeForm(req, res, 'Cliente inválido o dirección de regreso no registrada.')
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return sendOAuthErrorRedirect(res, redirectUri, state, 'invalid_request', 'PKCE S256 requerido')
    }

    const user = await validateApiTokenUser(apiToken)
    if (!user) {
      return renderAuthorizeForm(req, res, 'API token inválido o revocado.')
    }

    const code = await createAuthorizationCode({
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      resource
    })

    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', state)
    res.redirect(target.toString())
  } catch (error) {
    logger.error('Error en OAuth authorize:', error)
    res.status(500).send('Error interno autorizando el conector')
  }
})

router.post('/api/oauth/token', oauthRateLimiter, async (req, res) => {
  try {
    const grantType = req.body.grant_type
    const clientId = req.body.client_id
    const resource = req.body.resource || mcpResourceFor(req)
    let grant

    if (grantType === 'authorization_code') {
      grant = await consumeAuthorizationCode({
        code: req.body.code,
        clientId,
        redirectUri: req.body.redirect_uri,
        codeVerifier: req.body.code_verifier
      })
    } else if (grantType === 'refresh_token') {
      grant = await consumeRefreshToken(req.body.refresh_token, clientId)
    } else {
      return res.status(400).json({
        error: 'unsupported_grant_type'
      })
    }

    if (!grant) {
      return res.status(400).json({
        error: 'invalid_grant'
      })
    }

    const audience = grant.resource || resource
    const { accessToken, expiresIn } = createAccessToken({
      userId: grant.userId,
      clientId: grant.clientId,
      issuer: originFor(req),
      audience,
      scope: grant.scope
    })

    const response = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: grant.scope || 'ristak.read'
    }

    if (grantType === 'authorization_code') {
      response.refresh_token = await createRefreshToken({
        userId: grant.userId,
        clientId: grant.clientId,
        scope: grant.scope,
        resource: audience
      })
    }

    res.json(response)
  } catch (error) {
    logger.error('Error en OAuth token:', error)
    res.status(500).json({
      error: 'server_error'
    })
  }
})

export default router
