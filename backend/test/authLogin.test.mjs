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
  const password = 'android-pass-123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashPassword(password), 'Android Login Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        username: `  ${email.toUpperCase()}\u200B  `,
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
  const password = 'exact-pass-123'

  await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  await db.run(
    'INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [username, email, hashPassword(password), 'Android Password Test', 'admin', 1]
  )

  try {
    const res = createMockResponse()

    await login({
      body: {
        username: ` ${email} `,
        password: `${password} `
      }
    }, res)

    assert.equal(res.statusCode, 401)
    assert.equal(res.payload.success, false)
  } finally {
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', [username, email])
  }
})
