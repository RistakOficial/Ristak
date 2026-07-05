import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { databaseReady, db, getUserAppConfig } from '../src/config/database.js'
import { saveUserConfig } from '../src/controllers/userConfigController.js'

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
}

describe('user config controller', () => {
  afterEach(async () => {
    await deleteTestConfig()
  })

  it('allows mobile chat appointment entry mode as a per-user preference', async () => {
    await databaseReady
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
