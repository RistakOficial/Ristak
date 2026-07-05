import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'RISTAK_LICENSE_SERVER_URL',
  'CLIENT_ID',
  'RISTAK_CLIENT_ID',
  'LICENSE_KEY',
  'RISTAK_LICENSE_KEY',
  'INSTALLATION_ID',
  'RISTAK_INSTALLATION_ID',
  'APP_URL',
  'FCM_PROJECT_ID',
  'FIREBASE_PROJECT_ID',
  'FCM_SERVICE_ACCOUNT_JSON',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'FCM_SERVICE_ACCOUNT_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  'APNS_PRIVATE_KEY_FILE'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function startCentralPushServer({ pushStatus = {} } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req)
      requests.push({ method: req.method, url: req.url, body })
      res.setHeader('content-type', 'application/json')

      if (req.method === 'POST' && req.url === '/api/license/mobile-push/status') {
        res.end(JSON.stringify({
          success: true,
          push: {
            configured: true,
            nativeConfigured: true,
            iosConfigured: true,
            androidConfigured: true,
            ...pushStatus
          }
        }))
        return
      }

      if (req.method === 'POST' && req.url === '/api/license/mobile-push/send') {
        const devices = Array.isArray(body.devices) ? body.devices : []
        res.end(JSON.stringify({
          success: true,
          sent: devices.length,
          results: devices.map((device) => ({
            id: device.id,
            platform: device.platform,
            success: true
          }))
        }))
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ success: false, error: 'not_found' }))
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ success: false, error: error.message }))
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`
  }
}

test('delega Android al Installer central cuando FCM local no esta configurado', async () => {
  const envSnapshot = snapshotEnv()
  const central = await startCentralPushServer()
  let db = null
  let licenseService = null
  const suffix = randomUUID()
  const deviceId = `native_push_android_central_${suffix}`
  const userId = `user_android_central_${suffix}`
  const token = `android-token-${suffix}`

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_android'
    process.env.LICENSE_KEY = 'lic_push_android'
    process.env.INSTALLATION_ID = 'inst_push_android'
    process.env.APP_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    const pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db

    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

    await db.run(`
      INSERT INTO mobile_push_devices (
        id, user_id, platform, token, calendar_ids_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'android', ?, '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [deviceId, userId, token])

    const result = await pushService.sendAppNotificationPayload({
      title: 'Mensaje nuevo',
      body: 'Hola desde Android',
      category: 'chat'
    }, { userIds: [userId] })

    assert.equal(result.nativeSent, 1)
    assert.equal(result.sent, 1)

    const sendRequest = central.requests.find((request) => request.url === '/api/license/mobile-push/send')
    assert.ok(sendRequest)
    assert.equal(sendRequest.body.client_id, 'cli_push_android')
    assert.equal(sendRequest.body.license_key, 'lic_push_android')
    assert.equal(sendRequest.body.installation_id, 'inst_push_android')
    assert.deepEqual(sendRequest.body.devices, [{
      id: deviceId,
      platform: 'android',
      token,
      experience: {
        soundEnabled: true,
        vibrationEnabled: true
      }
    }])
    assert.equal(sendRequest.body.payload.title, 'Mensaje nuevo')
  } finally {
    if (db) await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [deviceId]).catch(() => {})
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise((resolve) => central.server.close(resolve))
  }
})

test('delega iOS al Installer central con avatar de iniciales cuando el contacto no tiene foto', async () => {
  const envSnapshot = snapshotEnv()
  const central = await startCentralPushServer()
  let db = null
  let licenseService = null
  const suffix = randomUUID()
  const contactId = `contact_ios_central_${suffix}`
  const deviceId = `native_push_ios_central_${suffix}`
  const userId = `user_ios_central_${suffix}`
  const token = `ios-token-${suffix}`

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_ios'
    process.env.LICENSE_KEY = 'lic_push_ios'
    process.env.INSTALLATION_ID = 'inst_push_ios'
    process.env.APP_URL = 'https://app.ristak.test'
    process.env.PUBLIC_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    const pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db

    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

    await db.run(`
      INSERT INTO contacts (id, phone, full_name, first_name, last_name, source, created_at, updated_at)
      VALUES (?, ?, 'Raul Sin Foto', 'Raul', 'Sin Foto', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `+52656${Date.now().toString().slice(-8)}`])
    await db.run(`
      INSERT INTO mobile_push_devices (
        id, user_id, platform, token, calendar_ids_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'ios', ?, '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [deviceId, userId, token])

    const result = await pushService.sendAppNotificationPayload({
      title: 'Raul Sin Foto',
      body: 'Hola desde iPhone',
      category: 'chat',
      contactId,
      contactName: 'Raul Sin Foto',
      threadId: `chat-${contactId}`,
      tag: `chat-${contactId}`
    }, { userIds: [userId] })

    assert.equal(result.nativeSent, 1)
    assert.equal(result.sent, 1)

    const sendRequest = central.requests.find((request) => request.url === '/api/license/mobile-push/send')
    assert.ok(sendRequest)
    assert.deepEqual(sendRequest.body.devices, [{
      id: deviceId,
      platform: 'ios',
      token,
      experience: {
        soundEnabled: true,
        vibrationEnabled: true
      }
    }])
    assert.equal(sendRequest.body.payload.title, 'Raul Sin Foto')
    assert.equal(sendRequest.body.payload.contactName, 'Raul Sin Foto')
    assert.equal(sendRequest.body.payload.contactId, contactId)
    assert.match(sendRequest.body.payload.contactAvatarUrl, /^https:\/\/app\.ristak\.test\/api\/push\/contact-avatar\//)
    assert.equal(sendRequest.body.payload.senderAvatarUrl, sendRequest.body.payload.contactAvatarUrl)
    assert.equal(sendRequest.body.payload.notificationImageUrl, undefined)
  } finally {
    if (db) {
      await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [deviceId]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    }
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise((resolve) => central.server.close(resolve))
  }
})
