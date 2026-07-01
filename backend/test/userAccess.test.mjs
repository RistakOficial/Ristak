import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import { createUser, updateUser } from '../src/controllers/userAccessController.js'
import {
  getEffectiveAccessConfig,
  hasUserAccess,
  normalizeAccessConfig,
  serializeAccessConfig
} from '../src/utils/userAccess.js'

const LICENSE_ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'RISTAK_LICENSE_SERVER_URL',
  'CLIENT_ID',
  'RISTAK_CLIENT_ID',
  'LICENSE_KEY',
  'RISTAK_LICENSE_KEY'
]

function withoutLicenseEnforcement() {
  const previous = new Map(LICENSE_ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of LICENSE_ENV_KEYS) delete process.env[key]
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

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

describe('user access config', () => {
  it('gives administrators write access to every module', () => {
    const access = getEffectiveAccessConfig({ role: 'admin' })

    assert.equal(access.dashboard, 'write')
    assert.equal(access.settings_media, 'write')
    assert.equal(access.settings_users, 'write')
    assert.equal(hasUserAccess({ role: 'admin' }, 'settings_users', 'write'), true)
  })

  it('keeps account access available for employees', () => {
    const access = normalizeAccessConfig({}, 'employee')

    assert.equal(access.settings_account, 'write')
    assert.equal(hasUserAccess({ role: 'employee', access_config: access }, 'settings_account', 'write'), true)
  })

  it('does not allow employees to manage users even if the payload asks for it', () => {
    const access = normalizeAccessConfig({ settings_users: 'write', contacts: 'read' }, 'employee')

    assert.equal(access.contacts, 'read')
    assert.equal(access.settings_users, 'none')
    assert.equal(hasUserAccess({ role: 'employee', access_config: access }, 'settings_users', 'read'), false)
  })

  it('serializes unknown or invalid levels as none', () => {
    const serialized = serializeAccessConfig({ contacts: 'delete', reports: 'write', settings_media: 'read' }, 'employee')
    const parsed = JSON.parse(serialized)

    assert.equal(parsed.contacts, 'none')
    assert.equal(parsed.reports, 'write')
    assert.equal(parsed.settings_media, 'read')
  })

  it('keeps the users table ready for access management on boot', async () => {
    await databaseReady

    const columns = process.env.DATABASE_URL
      ? await db.all(`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
        `)
      : await db.all('PRAGMA table_info(users)')
    const names = new Set(columns.map((column) => column.name))

    assert.equal(names.has('access_config'), true)
    assert.equal(names.has('token_version'), true)
    assert.equal(names.has('created_at'), true)
    assert.equal(names.has('updated_at'), true)
  })

  it('creates and updates a user access map through the controller', async () => {
    await databaseReady

    const restoreLicenseEnv = withoutLicenseEnforcement()
    const email = `access-user-${Date.now()}@example.com`
    const updatedEmail = `updated-${email}`

    await db.run('DELETE FROM users WHERE email IN (?, ?) OR username IN (?, ?)', [
      email,
      updatedEmail,
      email,
      updatedEmail
    ])

    try {
      const createRes = createMockResponse()
      await createUser({
        body: {
          firstName: 'Access',
          lastName: 'User',
          email,
          phone: '',
          password: 'TempPass123',
          role: 'employee',
          accessConfig: {
            contacts: 'read',
            chat: 'write',
            reports: 'none'
          }
        }
      }, createRes)

      assert.equal(createRes.statusCode, 201)
      assert.equal(createRes.payload.success, true)
      assert.equal(createRes.payload.user.accessConfig.contacts, 'read')
      assert.equal(createRes.payload.user.accessConfig.chat, 'write')
      assert.equal(createRes.payload.user.accessConfig.settings_users, 'none')

      const userId = createRes.payload.user.id
      const updateRes = createMockResponse()
      await updateUser({
        params: { userId },
        user: { userId: '999', role: 'admin' },
        body: {
          firstName: 'Access',
          lastName: 'Updated',
          email: updatedEmail,
          phone: '',
          role: 'employee',
          accessConfig: {
            contacts: 'write',
            chat: 'read',
            reports: 'write',
            settings_users: 'write'
          }
        }
      }, updateRes)

      assert.equal(updateRes.statusCode, 200)
      assert.equal(updateRes.payload.success, true)
      assert.equal(updateRes.payload.user.email, updatedEmail)
      assert.equal(updateRes.payload.user.accessConfig.contacts, 'write')
      assert.equal(updateRes.payload.user.accessConfig.chat, 'read')
      assert.equal(updateRes.payload.user.accessConfig.reports, 'write')
      assert.equal(updateRes.payload.user.accessConfig.settings_users, 'none')

      const row = await db.get('SELECT access_config FROM users WHERE id = ?', [userId])
      const storedAccess = JSON.parse(row.access_config)
      assert.equal(storedAccess.contacts, 'write')
      assert.equal(storedAccess.reports, 'write')
      assert.equal(storedAccess.settings_users, 'none')
    } finally {
      await db.run('DELETE FROM users WHERE email IN (?, ?) OR username IN (?, ?)', [
        email,
        updatedEmail,
        email,
        updatedEmail
      ])
      restoreLicenseEnv()
    }
  })
})
