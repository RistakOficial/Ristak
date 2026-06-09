import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Servidor de licencias simulado
let server
let baseUrl
let requestCount = 0
let serverMode = 'allow' // allow | block | down
let lastRequestBody = null

let licenseService

function startMockServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        lastRequestBody = body ? JSON.parse(body) : null

        if (serverMode === 'down') {
          // destruir el socket simula un servidor inaccesible sin esperar timeouts
          res.socket?.destroy()
          return
        }

        res.setHeader('Content-Type', 'application/json')

        if (req.url === '/api/license/verify') {
          requestCount += 1

          if (serverMode === 'allow') {
            res.end(JSON.stringify({
              allowed: true,
              client_id: 'cli_1',
              plan: 'pro',
              features: { whatsapp: true, meta_ads: true, ai: false },
              license_token: 'tok_123',
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }))
          } else {
            res.statusCode = 403
            res.end(JSON.stringify({
              allowed: false,
              reason: 'subscription_inactive',
              message: 'Tu licencia de Ristak no está activa.'
            }))
          }
          return
        }

        if (req.url === '/api/setup-token/verify' || req.url === '/api/setup-token/consume') {
          const { token } = lastRequestBody || {}
          if (token === 'good-token') {
            res.end(JSON.stringify({ valid: true, email: 'dueno@clinica.com' }))
          } else {
            res.statusCode = 403
            res.end(JSON.stringify({ valid: false, message: 'El enlace de configuración no es válido o ya expiró.' }))
          }
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

function configureManagedInstall() {
  process.env.LICENSE_SERVER_URL = baseUrl
  process.env.CLIENT_ID = 'cli_1'
  process.env.LICENSE_KEY = 'RSTK-TEST-0000'
  process.env.INSTALLATION_ID = 'inst_1'
  process.env.APP_URL = 'https://demo.onrender.com'
  process.env.APP_VERSION = '1.2.3'
  process.env.OWNER_EMAIL = 'dueno@clinica.com'
  delete process.env.LICENSE_OFFLINE_POLICY
}

function configureStandalone() {
  delete process.env.LICENSE_SERVER_URL
  delete process.env.CLIENT_ID
  delete process.env.LICENSE_KEY
}

before(async () => {
  await startMockServer()
  licenseService = await import('../src/services/licenseService.js')
})

after(() => {
  // Cierra también las conexiones keep-alive abiertas por fetch (undici),
  // si no el proceso del test runner queda vivo hasta su timeout.
  server?.closeAllConnections?.()
  server?.close()
})

beforeEach(() => {
  serverMode = 'allow'
  requestCount = 0
  lastRequestBody = null
  configureManagedInstall()
  licenseService.resetLicenseCache()
})

test('sin LICENSE_SERVER_URL la licencia no se exige (modo standalone/desarrollo)', async () => {
  configureStandalone()

  assert.equal(licenseService.isLicenseEnforced(), false)

  const state = await licenseService.getLicenseState()
  assert.equal(state.allowed, true)
  assert.equal(state.enforced, false)
  assert.equal(requestCount, 0)
})

test('licencia activa permite el acceso y entrega features', async () => {
  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, true)
  assert.equal(state.plan, 'pro')
  assert.equal(state.features.whatsapp, true)
  assert.equal(state.features.ai, false)

  // El payload enviado al servidor central incluye todos los datos de la instalación
  assert.equal(lastRequestBody.client_id, 'cli_1')
  assert.equal(lastRequestBody.license_key, 'RSTK-TEST-0000')
  assert.equal(lastRequestBody.installation_id, 'inst_1')
  assert.equal(lastRequestBody.email, 'dueno@clinica.com')
  assert.equal(lastRequestBody.app_url, 'https://demo.onrender.com')
  assert.equal(lastRequestBody.version, '1.2.3')
})

test('licencia suspendida bloquea aunque el password local sea correcto', async () => {
  serverMode = 'block'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, false)
  assert.equal(state.reason, 'subscription_inactive')
  assert.ok(state.message.includes('no está activa'))
})

test('el token temporal evita consultar al servidor en cada request', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')
  assert.equal(requestCount, 1)

  // Mientras el token esté vigente, getLicenseState usa el cache
  await licenseService.getLicenseState()
  await licenseService.getLicenseState()
  assert.equal(requestCount, 1)

  // forceRefresh vuelve a validar
  await licenseService.getLicenseState({ forceRefresh: true })
  assert.equal(requestCount, 2)
})

test('hasFeature respeta los feature flags del plan', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(await licenseService.hasFeature('whatsapp'), true)
  assert.equal(await licenseService.hasFeature('ai'), false)
  assert.equal(await licenseService.hasFeature('feature_inexistente'), false)
})

test('modo estricto: servidor caído sin token vigente bloquea el acceso', async () => {
  serverMode = 'down'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, false)
  assert.equal(state.reason, 'license_server_unreachable')
})

test('servidor caído con token temporal vigente mantiene el acceso', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  serverMode = 'down'
  const state = await licenseService.getLicenseState({ forceRefresh: true })

  assert.equal(state.allowed, true)
})

test('getHealthInfo responde el contrato del instalador', () => {
  const info = licenseService.getHealthInfo()

  assert.equal(info.ok, true)
  assert.equal(info.app, 'ristak')
  assert.equal(info.version, '1.2.3')
  assert.equal(info.client_id, 'cli_1')
  assert.equal(info.installation_id, 'inst_1')
})

test('setup token válido devuelve el email del dueño', async () => {
  const result = await licenseService.verifySetupToken('good-token')
  assert.equal(result.valid, true)
  assert.equal(result.email, 'dueno@clinica.com')
})

test('setup token inválido falla con mensaje claro', async () => {
  const result = await licenseService.consumeSetupToken('bad-token')
  assert.equal(result.valid, false)
  assert.ok(result.message)
})
