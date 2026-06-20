import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import {
  NOTIFICATION_PREFERENCES_CONFIG_KEY,
  resolvePushNotificationTargetForEvent
} from '../src/services/notificationPreferencesService.js'

const TEST_USER_PREFIX = 'notif-pref-test'

async function deleteTestData() {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [NOTIFICATION_PREFERENCES_CONFIG_KEY])
  await db.run('DELETE FROM users WHERE username LIKE ?', [`${TEST_USER_PREFIX}-%`])
}

async function createTestUser(role = 'employee', isActive = true) {
  const token = `${TEST_USER_PREFIX}-${role}-${isActive ? 'active' : 'inactive'}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      token,
      `${token}@example.com`,
      'test-password-hash',
      token,
      role,
      isActive ? 1 : 0
    ]
  )
  const row = await db.get('SELECT id FROM users WHERE username = ?', [token])
  return String(row.id)
}

describe('notification preferences service', () => {
  afterEach(async () => {
    await deleteTestData()
  })

  it('resolves push targets for administrators and explicit users', async () => {
    await deleteTestData()
    const adminId = await createTestUser('admin')
    const employeeId = await createTestUser('employee')
    const inactiveId = await createTestUser('employee', false)

    await setAppConfig(NOTIFICATION_PREFERENCES_CONFIG_KEY, {
      version: 1,
      rows: {
        admins: { payments: 'push' },
        [`user:${employeeId}`]: { payments: 'app_push' },
        [`user:${inactiveId}`]: { payments: 'push' }
      }
    })

    const target = await resolvePushNotificationTargetForEvent('payments')

    assert.equal(target.configured, true)
    assert.deepEqual(new Set(target.userIds), new Set([adminId, employeeId]))
  })

  it('keeps the global target when everyone is selected', async () => {
    await deleteTestData()
    await createTestUser('admin')

    await setAppConfig(NOTIFICATION_PREFERENCES_CONFIG_KEY, {
      version: 1,
      rows: {
        all: { conversations: 'push' }
      }
    })

    const target = await resolvePushNotificationTargetForEvent('chat')

    assert.equal(target.configured, true)
    assert.equal(target.userIds, null)
  })

  it('returns an empty target when the matrix disables push for an event', async () => {
    await deleteTestData()
    await setAppConfig(NOTIFICATION_PREFERENCES_CONFIG_KEY, {
      version: 1,
      rows: {
        all: { appointments: 'app' },
        admins: { appointments: 'off' }
      }
    })

    const target = await resolvePushNotificationTargetForEvent('appointments')

    assert.equal(target.configured, true)
    assert.deepEqual(target.userIds, [])
  })
})
