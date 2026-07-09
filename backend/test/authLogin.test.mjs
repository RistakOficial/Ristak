import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { login } from '../src/controllers/authController.js'
import { hashPassword } from '../src/utils/auth.js'

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
