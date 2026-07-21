import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db } from '../src/config/database.js'
import { login, ssoLogin, verifyTokenEndpoint } from '../src/controllers/authController.js'
import { hashPassword, verifyPassword, verifyToken } from '../src/utils/auth.js'
import { requireAuth } from '../src/middleware/authMiddleware.js'
import { resetLicenseCache } from '../src/services/licenseService.js'

let licenseServer
let licenseServerUrl
const bootstrapOwnerEmail = 'bootstrap-owner@example.com'
const bootstrapOwnerPassword = 'OwnerPortalPass123'
const googleOwnerEmail = 'google-owner@example.com'
const googleOwnerSetupToken = 'google-owner-setup-token'

before(async () => {
  licenseServer = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', chunk => { rawBody += chunk })
    req.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) : {}
      res.setHeader('Content-Type', 'application/json')

      if (req.url === '/api/owner-credentials/verify') {
        if (body.email === bootstrapOwnerEmail && body.password === bootstrapOwnerPassword) {
          res.end(JSON.stringify({ valid: true, password_hash: hashPassword(bootstrapOwnerPassword) }))
        } else if (body.email === 'support-owner@example.com' && body.password === 'InstallerAdminPass123') {
          res.end(JSON.stringify({ valid: true, support_access: true }))
        } else {
          res.statusCode = 403
          res.end(JSON.stringify({ valid: false, reason: 'wrong_password' }))
        }
        return
      }

      if (req.url === '/api/setup-token/verify' || req.url === '/api/setup-token/consume') {
        if (body.token === googleOwnerSetupToken && body.installation_id === 'inst_google_bootstrap') {
          res.end(JSON.stringify({
            valid: true,
            email: googleOwnerEmail,
            password_hash: null
          }))
        } else {
          res.statusCode = 403
          res.end(JSON.stringify({ valid: false, message: 'Token inválido' }))
        }
        return
      }

      if (req.url === '/api/license/users/refresh') {
        res.end(JSON.stringify({ success: true }))
        return
      }

      if (req.url === '/api/license/oauth-handoff/claim' && body.provider === 'google_login') {
        if (body.handoff_token === 'google-local-login-handoff') {
          res.end(JSON.stringify({
            success: true,
            handoff: {
              provider: 'google_login',
              payload: {
                profile: {
                  sub: 'google-local-sub',
                  email: googleOwnerEmail,
                  name: 'Google Owner',
                  picture_url: 'https://images.test/google-owner.png',
                  email_verified: true
                }
              }
            }
          }))
        } else {
          res.statusCode = 410
          res.end(JSON.stringify({ success: false, message: 'Handoff inválido' }))
        }
        return
      }

      if (req.url === '/api/license/verify') {
        res.end(JSON.stringify({
          allowed: true,
          client_id: 'cli_support',
          plan: 'professional',
          features: { dashboard: true },
          license_token: 'license_support_token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }))
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ success: false }))
    })
  })

  await new Promise(resolve => licenseServer.listen(0, '127.0.0.1', resolve))
  licenseServerUrl = `http://127.0.0.1:${licenseServer.address().port}`
})

after(() => {
  licenseServer?.closeAllConnections?.()
  licenseServer?.close()
})

function createMockResponse() {
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

beforeEach(() => {
  delete process.env.LICENSE_SERVER_URL
  delete process.env.CLIENT_ID
  delete process.env.LICENSE_KEY
  delete process.env.INSTALLATION_ID
  delete process.env.OWNER_EMAIL
  resetLicenseCache()
})

test('login accepts Android-style pasted identifiers with spaces and different casing', async () => {
  const username = `android_login_${Date.now()}`
  const email = `${username}@example.com`
  const password = 'AndroidPass123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashPassword(password), 'Android Login Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        email: `  ${email.toUpperCase()}\u200B  `,
        password
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.user.email, email)
    assert.ok(res.payload.token)
    const payload = verifyToken(res.payload.token)
    assert.equal(typeof payload.exp, 'number')
    assert.equal(payload.supportAccess, undefined)
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  }
})

test('login keeps password matching exact while cleaning only the identifier', async () => {
  const username = `android_password_${Date.now()}`
  const email = `${username}@example.com`
  const password = 'ExactPass123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashPassword(password), 'Android Password Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        email: ` ${email} `,
        password: `${password} `
      }
    }, res)

    assert.equal(res.statusCode, 401)
    assert.equal(res.payload.success, false)
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  }
})

test('login rejects internal username even when password is correct', async () => {
  const username = `internal_login_${Date.now()}`
  const email = `${username}@example.com`
  const password = 'InternalPass123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashPassword(password), 'Internal Login Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        username,
        password
      }
    }, res)

    assert.equal(res.statusCode, 400)
    assert.equal(res.payload.success, false)
    assert.equal(res.payload.message, 'Ingresa un correo válido')
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  }
})

test('login backfills legacy users that stored email in username', async () => {
  const email = `legacy_email_${Date.now()}@example.com`
  const password = 'LegacyPass123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [email, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [email, null, hashPassword(password), 'Legacy Email Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        email,
        password
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.user.email, email)

    const row = await db.get('SELECT email FROM users WHERE username = ?', [email])
    assert.equal(row.email, email)
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [email, email])
  }
})

test('login creates the first managed owner from the existing Installer credentials', async () => {
  await db.run('DELETE FROM users WHERE email = ?', [bootstrapOwnerEmail])
  const usersBefore = await db.get('SELECT COUNT(*) AS total FROM users')
  assert.equal(Number(usersBefore.total), 0)

  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_bootstrap'
  process.env.LICENSE_KEY = 'RSTK-BOOTSTRAP-0001'
  process.env.INSTALLATION_ID = 'inst_bootstrap'
  process.env.OWNER_EMAIL = bootstrapOwnerEmail
  resetLicenseCache()

  try {
    const res = createMockResponse()
    await login({
      body: {
        email: ` ${bootstrapOwnerEmail.toUpperCase()} `,
        password: bootstrapOwnerPassword
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.user.email, bootstrapOwnerEmail)
    assert.equal(res.payload.user.role, 'admin')
    assert.match(res.payload.apiToken, /^ristak_live_/)

    const stored = await db.get('SELECT * FROM users WHERE email = ?', [bootstrapOwnerEmail])
    assert.ok(stored?.id)
    assert.equal(verifyPassword(bootstrapOwnerPassword, stored.password_hash), true)

    const payload = verifyToken(res.payload.token)
    assert.equal(payload.userId, stored.id)
    assert.equal(payload.email, bootstrapOwnerEmail)
    assert.equal(payload.supportAccess, undefined)
  } finally {
    await db.run('DELETE FROM users WHERE email = ?', [bootstrapOwnerEmail])
  }
})

test('SSO creates the first managed owner when the Installer account only uses Google', async () => {
  await db.run('DELETE FROM users WHERE email = ?', [googleOwnerEmail])
  const usersBefore = await db.get('SELECT COUNT(*) AS total FROM users')
  assert.equal(Number(usersBefore.total), 0)

  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_google_bootstrap'
  process.env.LICENSE_KEY = 'RSTK-GOOGLE-BOOTSTRAP-0001'
  process.env.INSTALLATION_ID = 'inst_google_bootstrap'
  process.env.OWNER_EMAIL = googleOwnerEmail
  resetLicenseCache()

  try {
    const res = createMockResponse()
    await ssoLogin({ body: { token: googleOwnerSetupToken } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.user.email, googleOwnerEmail)
    assert.equal(res.payload.user.role, 'admin')
    assert.match(res.payload.apiToken, /^ristak_live_/)

    const stored = await db.get('SELECT * FROM users WHERE email = ?', [googleOwnerEmail])
    assert.ok(stored?.id)
    assert.ok(stored.password_hash)
    assert.equal(verifyPassword('LaContraseñaDeGoogleNoSeGuardaAquí', stored.password_hash), false)

    const payload = verifyToken(res.payload.token)
    assert.equal(payload.userId, stored.id)
    assert.equal(payload.email, googleOwnerEmail)
  } finally {
    await db.run('DELETE FROM users WHERE email = ?', [googleOwnerEmail])
  }
})

test('handoff de Google crea el primer usuario local y entrega sesión sin contraseña compartida', async () => {
  await db.run('DELETE FROM users')
  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_google_handoff'
  process.env.LICENSE_KEY = 'RSTK-GOOGLE-HANDOFF-0001'
  process.env.INSTALLATION_ID = 'inst_google_handoff'
  process.env.APP_URL = 'https://google-handoff.onrender.com'
  resetLicenseCache()

  try {
    const res = createMockResponse()
    await ssoLogin({ body: { google_handoff_token: 'google-local-login-handoff' } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.user.email, googleOwnerEmail)
    assert.equal(res.payload.user.role, 'admin')
    assert.match(res.payload.apiToken, /^ristak_live_/)

    const stored = await db.get('SELECT * FROM users WHERE email = ?', [googleOwnerEmail])
    assert.ok(stored?.id)
    assert.equal(stored.full_name, 'Google Owner')
    assert.equal(verifyPassword('LaContraseñaDeGoogleNoSeGuardaAquí', stored.password_hash), false)
    assert.equal(verifyToken(res.payload.token).userId, stored.id)
  } finally {
    await db.run('DELETE FROM users WHERE email = ?', [googleOwnerEmail])
    delete process.env.APP_URL
  }
})

test('login does not create the first managed owner with a wrong password', async () => {
  await db.run('DELETE FROM users WHERE email = ?', [bootstrapOwnerEmail])
  const usersBefore = await db.get('SELECT COUNT(*) AS total FROM users')
  assert.equal(Number(usersBefore.total), 0)

  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_bootstrap'
  process.env.LICENSE_KEY = 'RSTK-BOOTSTRAP-0001'
  process.env.INSTALLATION_ID = 'inst_bootstrap'
  process.env.OWNER_EMAIL = bootstrapOwnerEmail
  resetLicenseCache()

  const res = createMockResponse()
  await login({
    body: {
      email: bootstrapOwnerEmail,
      password: 'WrongOwnerPassword123'
    }
  }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(res.payload.success, false)
  assert.equal(await db.get('SELECT id FROM users WHERE email = ?', [bootstrapOwnerEmail]), null)
})

test('login does not bootstrap a customer account with the global support password', async () => {
  const email = 'support-owner@example.com'
  await db.run('DELETE FROM users WHERE email = ?', [email])
  const usersBefore = await db.get('SELECT COUNT(*) AS total FROM users')
  assert.equal(Number(usersBefore.total), 0)

  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_support'
  process.env.LICENSE_KEY = 'RSTK-SUPPORT-0001'
  process.env.INSTALLATION_ID = 'inst_support'
  process.env.OWNER_EMAIL = email
  resetLicenseCache()

  const res = createMockResponse()
  await login({
    body: {
      email,
      password: 'InstallerAdminPass123'
    }
  }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(res.payload.success, false)
  assert.equal(await db.get('SELECT id FROM users WHERE email = ?', [email]), null)
})

test('login acepta la contraseña del admin del Installer y deja una sesión de soporte sin expiración', async () => {
  const username = `support_login_${Date.now()}`
  const email = 'support-owner@example.com'
  // Caso borde real: la contraseña local del dueño también coincide con la
  // contraseña global del admin. Debe ganar la sesión persistente de soporte.
  const ownerPassword = 'InstallerAdminPass123'
  const originalPasswordHash = hashPassword(ownerPassword)

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active, token_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [username, email, originalPasswordHash, 'Support Owner', 'admin', 1, 3]
  )

  process.env.LICENSE_SERVER_URL = licenseServerUrl
  process.env.CLIENT_ID = 'cli_support'
  process.env.LICENSE_KEY = 'RSTK-SUPPORT-0001'
  process.env.INSTALLATION_ID = 'inst_support'
  process.env.OWNER_EMAIL = email
  resetLicenseCache()

  try {
    const res = createMockResponse()
    await login({
      body: {
        email,
        password: 'InstallerAdminPass123'
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.supportAccess, true)

    const payload = verifyToken(res.payload.token)
    assert.equal(payload.supportAccess, true)
    assert.equal(payload.exp, undefined)
    assert.equal(payload.tokenVersion, 3)

    const stored = await db.get('SELECT password_hash FROM users WHERE email = ?', [email])
    assert.equal(stored.password_hash, originalPasswordHash)

    // La sesión global no se revoca si el cliente cambia su contraseña.
    await db.run('UPDATE users SET token_version = token_version + 1 WHERE email = ?', [email])

    const verifyRes = createMockResponse()
    await verifyTokenEndpoint({ body: { token: res.payload.token } }, verifyRes)
    assert.equal(verifyRes.statusCode, 200)
    assert.equal(verifyRes.payload.success, true)

    const middlewareRes = createMockResponse()
    let nextCalled = false
    await requireAuth({
      headers: { authorization: `Bearer ${res.payload.token}` }
    }, middlewareRes, () => { nextCalled = true })
    assert.equal(nextCalled, true)
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  }
})
