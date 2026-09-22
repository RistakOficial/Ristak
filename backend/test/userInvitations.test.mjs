import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { db, databaseReady } from '../src/config/database.js'
import { createUserInvitation, acceptUserInvitation, revokeUserInvitation, createUser, updateUser } from '../src/controllers/userAccessController.js'
import { constrainUserAccessToLicense } from '../src/services/userPermissionService.js'
import { verifyPassword } from '../src/utils/auth.js'
import { resetLicenseCache, setVerifiedAppBaseUrlResolverForTests } from '../src/services/licenseService.js'

let server, actorId, deliveryMode, delivered, features
const identities = new Map()
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } })
const input = () => ({ email: `team-${crypto.randomUUID()}@example.test`, role: 'employee', accessConfig: { contacts: 'read', chat: 'write', sites: 'write', settings_email: 'write' } })

before(async () => {
  await databaseReady
  await db.exec(await readFile(new URL('../migrations/versioned/152_user_invitations.sqlite.sql', import.meta.url), 'utf8'))
  const actor = await db.run("INSERT INTO users (username, email, password_hash, role, is_active) VALUES ('inviter@example.test', 'inviter@example.test', 'not-used', 'admin', 1)")
  actorId = actor.lastID
  server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body || '{}')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/license/verify') {
      return res.end(JSON.stringify({ allowed: true, plan: 'basic', features, identity_id: identities.has(payload.email) ? 'global-invite-person' : null, identity_version: 0, license_token: 'local-test', expires_at: new Date(Date.now() + 3600000).toISOString() }))
    }
    if (req.url === '/api/license/identity/credentials') {
      return res.end(JSON.stringify({ registered: identities.has(payload.email), valid: identities.get(payload.email) === payload.password }))
    }
    if (req.url === '/api/license/users/invite') {
      delivered.push(payload)
      if (deliveryMode === 'unknown') { req.socket.destroy(); return }
      if (deliveryMode === 'unavailable') {
        res.statusCode = 503
        return res.end(JSON.stringify({ success: false, code: 'team_invitation_mail_unavailable', message: 'Correo central temporalmente no disponible.' }))
      }
      return res.end(JSON.stringify({ success: true, sent: true }))
    }
    res.end(JSON.stringify({ success: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.LICENSE_SERVER_URL = `http://127.0.0.1:${server.address().port}`
  process.env.CLIENT_ID = 'local-client'
  process.env.LICENSE_KEY = 'local-license'
  process.env.INSTALLATION_ID = 'local-installation'
  process.env.APP_URL = 'https://team.example.test'
  process.env.OWNER_EMAIL = 'inviter@example.test'
  setVerifiedAppBaseUrlResolverForTests(async () => '')
})
beforeEach(() => {
  identities.clear()
  features = { dashboard: true, contacts: true, chat: true, team_access: true, sites: false, email: false }
  deliveryMode = 'sent'
  delivered = []
  resetLicenseCache()
})
after(() => { setVerifiedAppBaseUrlResolverForTests(); server?.closeAllConnections(); server?.close() })

test('crea y acepta una invitación sin SMTP comercial y sólo conserva permisos del plan', async () => {
  assert.equal(await db.get("SELECT config_value FROM app_config WHERE config_key = 'email_smtp_config'"), null)
  const member = input()
  const res = response()
  await createUserInvitation({ body: member, user: { userId: actorId } }, res)
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.delivery, 'email')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].email, member.email)
  assert.equal(res.body.invitation.accessConfig.sites, 'none')
  assert.equal(res.body.invitation.accessConfig.settings_email, 'none')
  assert.equal(res.body.invitation.accessConfig.contacts, 'read')
  assert.equal(JSON.stringify(res.body).includes(delivered[0].invitation_token), false)
  const stored = await db.get('SELECT * FROM user_invitations WHERE id = ?', [res.body.invitation.id])
  assert.notEqual(stored.token_hash, delivered[0].invitation_token)

  // A downgrade between sending and accepting must remove the lost module.
  features.chat = false
  resetLicenseCache()
  const accepted = response()
  await acceptUserInvitation({ body: { token: delivered[0].invitation_token, password: 'SecureTeam123' } }, accepted)
  assert.equal(accepted.statusCode, 201)
  const user = await db.get('SELECT access_config FROM users WHERE email = ?', [member.email])
  assert.equal(JSON.parse(user.access_config).chat, 'none')
  assert.equal(JSON.parse(user.access_config).contacts, 'read')
  const replay = response()
  await acceptUserInvitation({ body: { token: delivered[0].invitation_token, password: 'SecureTeam123' } }, replay)
  assert.equal(replay.statusCode, 410)
})

test('una respuesta perdida conserva el enlace y evita duplicar el envío', async () => {
  deliveryMode = 'unknown'
  const member = input()
  const res = response()
  await createUserInvitation({ body: member, user: { userId: actorId } }, res)
  assert.equal(res.statusCode, 202)
  assert.equal(res.body.delivery, 'pending')
  assert.ok(await db.get('SELECT id FROM user_invitations WHERE id = ?', [res.body.invitation.id]))
  const duplicate = response()
  await createUserInvitation({ body: member, user: { userId: actorId } }, duplicate)
  assert.equal(duplicate.statusCode, 409)
  assert.equal(delivered.length, 1)
  const revoked = response()
  await revokeUserInvitation({ params: { invitationId: res.body.invitation.id } }, revoked)
  assert.equal(revoked.body.invitation.status, 'revoked')
  const accepted = response()
  await acceptUserInvitation({ body: { token: delivered[0].invitation_token, password: 'SecureTeam123' } }, accepted)
  assert.equal(accepted.statusCode, 410)
})

test('aceptar otra invitación conserva la contraseña global existente sin copiarla a la cuenta', async () => {
  const member = input()
  identities.set(member.email, 'legacy')
  const created = response()
  await createUserInvitation({ body: member, user: { userId: actorId } }, created)
  assert.equal(created.statusCode, 201)
  const token = delivered[0].invitation_token
  const rejected = response()
  await acceptUserInvitation({ body: { token, password: 'AnotherPassword123' } }, rejected)
  assert.equal(rejected.statusCode, 401)
  const accepted = response()
  await acceptUserInvitation({ body: { token, password: 'legacy' } }, accepted)
  assert.equal(accepted.statusCode, 201)
  const user = await db.get('SELECT role, password_hash FROM users WHERE email = ?', [member.email])
  assert.equal(user.role, 'employee')
  assert.equal(verifyPassword('legacy', user.password_hash), false)
})

test('un rechazo definitivo permite reintentar sin dejar una invitación bloqueada', async () => {
  deliveryMode = 'unavailable'
  const member = input()
  const res = response()
  await createUserInvitation({ body: member, user: { userId: actorId } }, res)
  assert.equal(res.statusCode, 503)
  assert.equal(await db.get('SELECT id FROM user_invitations WHERE email = ?', [member.email]), null)
})

test('crear y editar usuarios también descarta módulos no contratados', async () => {
  const member = { ...input(), password: 'SecureTeam123' }
  const res = response()
  await createUser({ body: member }, res)
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.user.accessConfig.sites, 'none')
  const updated = response()
  await updateUser({ body: member, params: { userId: res.body.user.id }, user: { userId: actorId } }, updated)
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.body.user.accessConfig.settings_email, 'none')
})

test('el rol administrador no extiende la licencia y las licencias inválidas fallan cerradas', async () => {
  const state = { allowed: true, enforced: true, features }
  const access = await constrainUserAccessToLicense({ contacts: 'write', sites: 'write', settings_email: 'write' }, 'admin', state)
  assert.equal(access.sites, 'none')
  assert.equal(access.settings_email, 'none')
  assert.equal(access.contacts, 'write')
  assert.equal(access.settings_users, 'write')
  await assert.rejects(constrainUserAccessToLicense({}, 'employee', { allowed: false }), { code: 'user_access_license_blocked' })
  await assert.rejects(constrainUserAccessToLicense({}, 'employee', { allowed: true, enforced: true, featuresSourceValid: false }), { code: 'user_access_license_blocked' })
})
