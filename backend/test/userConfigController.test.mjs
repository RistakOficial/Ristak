import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { databaseReady, db, getUserAppConfig } from '../src/config/database.js'
import { getUserConfig, saveUserConfig } from '../src/controllers/userConfigController.js'

const TEST_USER_ID_BASE = 9026000
const APPOINTMENT_ENTRY_MODE_KEY = 'mobile_chat_appointment_entry_mode'

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

async function deleteTestConfig() {
  await db.run('DELETE FROM user_app_config WHERE user_id >= ?', [TEST_USER_ID_BASE])
  await db.run(
    "DELETE FROM audit_log WHERE entity_type = 'user_notification_preferences' AND CAST(entity_id AS INTEGER) >= ?",
    [TEST_USER_ID_BASE]
  ).catch(() => undefined)
}

async function ensureAuditTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_label TEXT,
      details_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

describe('user config controller', () => {
  afterEach(async () => {
    await deleteTestConfig()
  })

  it('allows mobile chat appointment entry mode as a per-user preference', async () => {
    await databaseReady
    await ensureAuditTable()
    await deleteTestConfig()

    const userId = TEST_USER_ID_BASE + Math.floor(Math.random() * 100000)
    const res = createMockResponse()

    await saveUserConfig({
      user: { userId },
      body: {
        key: APPOINTMENT_ENTRY_MODE_KEY,
        value: 'calendar'
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload?.success, true)
    assert.equal(await getUserAppConfig(userId, APPOINTMENT_ENTRY_MODE_KEY), 'calendar')

    const audit = await db.get(`
      SELECT action, actor_user_id, details_json
      FROM audit_log
      WHERE entity_type = 'user_notification_preferences' AND entity_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [String(userId)])
    assert.equal(audit.action, 'update')
    assert.equal(Number(audit.actor_user_id), userId)
    assert.equal(JSON.parse(audit.details_json).changes[APPOINTMENT_ENTRY_MODE_KEY].value, 'calendar')
  })

  it('returns explicit effective defaults when notification preferences were never saved', async () => {
    await databaseReady
    await ensureAuditTable()
    await deleteTestConfig()

    const userId = TEST_USER_ID_BASE + Math.floor(Math.random() * 100000)
    const res = createMockResponse()
    await getUserConfig({
      user: { userId, role: 'employee' },
      query: {
        keys: 'chat_push_notifications_enabled,calendar_push_notifications_enabled,push_notification_sound_enabled'
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.payload?.config, {
      chat_push_notifications_enabled: 'true',
      calendar_push_notifications_enabled: 'false',
      push_notification_sound_enabled: 'true'
    })
  })

  it('still rejects non-whitelisted user config keys', async () => {
    await databaseReady
    await deleteTestConfig()

    const res = createMockResponse()

    await saveUserConfig({
      user: { userId: TEST_USER_ID_BASE + 1 },
      body: {
        key: 'mobile_chat_unreviewed_setting',
        value: 'on'
      }
    }, res)

    assert.equal(res.statusCode, 400)
    assert.equal(res.payload?.success, false)
  })
})
