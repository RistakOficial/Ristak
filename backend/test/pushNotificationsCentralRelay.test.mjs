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
  'PUBLIC_URL',
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

async function startCentralPushServer({
  pushStatus = {},
  pushStatusHttpStatus = 200,
  sendResponse = null,
  hangSendBody = false
} = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req)
      requests.push({ method: req.method, url: req.url, body })
      res.setHeader('content-type', 'application/json')

      if (req.method === 'POST' && req.url === '/api/license/mobile-push/status') {
        res.statusCode = pushStatusHttpStatus
        if (pushStatusHttpStatus >= 400) {
          res.end(JSON.stringify({ success: false, error: 'mobile_push_status_temporarily_unavailable' }))
          return
        }
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
        const responseBody = typeof sendResponse === 'function'
          ? await sendResponse({ body, devices })
          : {
              success: true,
              sent: devices.length,
              results: devices.map((device) => ({
                id: device.id,
                platform: device.platform,
                success: true
              }))
            }
        if (hangSendBody) {
          res.write(JSON.stringify(responseBody).slice(0, 12))
          return
        }
        res.end(JSON.stringify(responseBody))
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
    pushService.resetCentralMobilePushStatusCacheForTest()

    await db.run(`
      INSERT INTO mobile_push_devices (
        id, user_id, platform, token, client_type, app_package, calendar_ids_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'android', ?, 'expo', 'com.ristak.android', '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
      clientType: 'expo',
      appPackage: 'com.ristak.android',
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
    pushService.resetCentralMobilePushStatusCacheForTest()

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

test('acepta skips terminales y reintenta resultados faltantes o configuración transitoria', async () => {
  const envSnapshot = snapshotEnv()
  let sendCalls = 0
  let missingDeviceId = ''
  let configSkippedDeviceId = ''
  const central = await startCentralPushServer({
    sendResponse: async ({ devices }) => {
      sendCalls += 1
      if (sendCalls === 1) {
        missingDeviceId = devices[2].id
        configSkippedDeviceId = devices[3].id
        return {
          success: true,
          sent: 1,
          results: [
            { id: devices[0].id, platform: devices[0].platform, success: true },
            { id: devices[1].id, platform: devices[1].platform, skipped: true, reason: 'disabled_by_preferences' },
            { id: configSkippedDeviceId, platform: devices[3].platform, skipped: true, reason: 'fcm_not_configured' }
          ]
        }
      }
      return {
        success: true,
        sent: devices.length,
        results: devices.map(device => ({ id: device.id, platform: device.platform, success: true }))
      }
    }
  })
  let db = null
  let licenseService = null
  const suffix = randomUUID()
  const userId = `user_central_partial_${suffix}`
  const deviceIds = [0, 1, 2, 3].map((index) => `native_push_central_partial_${index}_${suffix}`)

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_partial'
    process.env.LICENSE_KEY = 'lic_push_partial'
    process.env.INSTALLATION_ID = 'inst_push_partial'
    process.env.APP_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    const pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db

    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')
    pushService.resetCentralMobilePushStatusCacheForTest()

    for (const [index, deviceId] of deviceIds.entries()) {
      await db.run(`
        INSERT INTO mobile_push_devices (
          id, user_id, platform, token, client_type, app_package, calendar_ids_json, enabled, created_at, updated_at
        ) VALUES (?, ?, 'android', ?, 'expo', 'com.ristak.android', '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [deviceId, userId, `android-token-partial-${index}-${suffix}`])
    }

    const result = await pushService.sendAppNotificationPayload({
      title: 'Mensaje nuevo',
      body: 'Resultado parcial del relay',
      category: 'chat'
    }, { userIds: [userId] })

    assert.equal(result.attempted, 4)
    assert.equal(result.nativeSent, 1)
    assert.equal(result.sent, 1)
    assert.equal(result.acceptedSkips, 1)
    assert.equal(result.retryableFailures, 2)
    assert.equal(result.permanentFailures, 0)
    assert.deepEqual(result.retryTargets, {
      webSubscriptionIds: [],
      mobileDeviceIds: [configSkippedDeviceId, missingDeviceId]
    })

    const recovery = await pushService.sendAppNotificationPayload({
      title: 'Mensaje nuevo',
      body: 'Retry dirigido',
      category: 'chat'
    }, {
      userIds: [userId],
      deliveryTargets: result.retryTargets,
      durableDelivery: true
    })
    assert.equal(recovery.attempted, 2)
    assert.equal(recovery.sent, 2)
    assert.equal(recovery.retryableFailures, 0)
    const sendRequests = central.requests.filter(request => request.url === '/api/license/mobile-push/send')
    assert.equal(sendRequests.length, 2)
    assert.deepEqual(
      new Set(sendRequests[1].body.devices.map(device => device.id)),
      new Set([configSkippedDeviceId, missingDeviceId])
    )
  } finally {
    if (db) {
      for (const deviceId of deviceIds) {
        await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [deviceId]).catch(() => {})
      }
    }
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise((resolve) => central.server.close(resolve))
  }
})

test('status central caído conserva los devices como fallo reintentable en entrega durable', async () => {
  const envSnapshot = snapshotEnv()
  const central = await startCentralPushServer({ pushStatusHttpStatus: 503 })
  let db = null
  let licenseService = null
  const suffix = randomUUID()
  const userId = `user_central_status_down_${suffix}`
  const deviceId = `native_push_central_status_down_${suffix}`

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_status_down'
    process.env.LICENSE_KEY = 'lic_push_status_down'
    process.env.INSTALLATION_ID = 'inst_push_status_down'
    process.env.APP_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    const pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db
    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')
    pushService.resetCentralMobilePushStatusCacheForTest()

    await db.run(`
      INSERT INTO mobile_push_devices (
        id, user_id, platform, token, calendar_ids_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'android', ?, '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [deviceId, userId, `status-down-token-${suffix}`])

    const result = await pushService.sendAppNotificationPayload({
      title: 'Mensaje durable',
      body: 'No debe perderse por status caído',
      category: 'chat'
    }, { userIds: [userId], durableDelivery: true })

    assert.equal(result.skipped, false)
    assert.equal(result.attempted, 1)
    assert.equal(result.retryableFailures, 1)
    assert.deepEqual(result.retryTargets, {
      webSubscriptionIds: [],
      mobileDeviceIds: [deviceId]
    })
    assert.equal(
      central.requests.filter(request => request.url === '/api/license/mobile-push/send').length,
      0,
      'sin status confiable no se finge una entrega ni se llama un broker no confirmado'
    )
  } finally {
    if (db) await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [deviceId]).catch(() => {})
    const pushService = await import('../src/services/pushNotificationsService.js').catch(() => null)
    pushService?.resetCentralMobilePushStatusCacheForTest?.()
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise(resolve => central.server.close(resolve))
  }
})

test('HTTP 400/404 genérico no deshabilita devices; BadDeviceToken sí es terminal', async () => {
  const envSnapshot = snapshotEnv()
  let retryable400Id = ''
  let retryable404Id = ''
  let badTokenId = ''
  const central = await startCentralPushServer({
    sendResponse: async ({ devices }) => {
      retryable400Id = devices[0].id
      retryable404Id = devices[1].id
      badTokenId = devices[2].id
      return {
        success: true,
        sent: 0,
        results: [
          { id: retryable400Id, statusCode: 400, error: 'INVALID_ARGUMENT' },
          { id: retryable404Id, statusCode: 404, error: 'NOT_FOUND' },
          { id: badTokenId, statusCode: 400, reason: 'BadDeviceToken' }
        ]
      }
    }
  })
  let db = null
  let licenseService = null
  const suffix = randomUUID()
  const userId = `user_central_classification_${suffix}`
  const deviceIds = [0, 1, 2].map(index => `native_push_central_classification_${index}_${suffix}`)

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_classification'
    process.env.LICENSE_KEY = 'lic_push_classification'
    process.env.INSTALLATION_ID = 'inst_push_classification'
    process.env.APP_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    const pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db
    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')
    pushService.resetCentralMobilePushStatusCacheForTest()

    for (const [index, deviceId] of deviceIds.entries()) {
      await db.run(`
        INSERT INTO mobile_push_devices (
          id, user_id, platform, token, calendar_ids_json, enabled, created_at, updated_at
        ) VALUES (?, ?, 'ios', ?, '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [deviceId, userId, `classification-token-${index}-${suffix}`])
    }

    const result = await pushService.sendAppNotificationPayload({
      title: 'Clasificación push',
      body: 'Errores por device',
      category: 'chat'
    }, { userIds: [userId], durableDelivery: true })

    assert.equal(result.retryableFailures, 2)
    assert.equal(result.permanentFailures, 1)
    assert.deepEqual(new Set(result.retryTargets.mobileDeviceIds), new Set([retryable400Id, retryable404Id]))
    const states = await db.all(`
      SELECT id, enabled
      FROM mobile_push_devices
      WHERE id IN (?, ?, ?)
    `, [retryable400Id, retryable404Id, badTokenId])
    const enabledById = new Map(states.map(row => [row.id, Number(row.enabled)]))
    assert.equal(enabledById.get(retryable400Id), 1)
    assert.equal(enabledById.get(retryable404Id), 1)
    assert.equal(enabledById.get(badTokenId), 0)
  } finally {
    if (db) {
      for (const deviceId of deviceIds) {
        await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [deviceId]).catch(() => {})
      }
    }
    const pushService = await import('../src/services/pushNotificationsService.js').catch(() => null)
    pushService?.resetCentralMobilePushStatusCacheForTest?.()
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise(resolve => central.server.close(resolve))
  }
})

test('IDs iguales en web y mobile conservan namespace y no reenvían el éxito mobile', async () => {
  const envSnapshot = snapshotEnv()
  const central = await startCentralPushServer()
  let db = null
  let licenseService = null
  let pushService = null
  const suffix = randomUUID()
  const sharedId = `shared_push_target_${suffix}`
  const userId = `user_shared_push_target_${suffix}`
  const endpoint = `https://push.example.test/${suffix}`
  let webCalls = 0

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_namespaced'
    process.env.LICENSE_KEY = 'lic_push_namespaced'
    process.env.INSTALLATION_ID = 'inst_push_namespaced'
    process.env.APP_URL = 'https://app.ristak.test'

    const databaseModule = await import('../src/config/database.js')
    pushService = await import('../src/services/pushNotificationsService.js')
    licenseService = await import('../src/services/licenseService.js')
    db = databaseModule.db
    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')
    pushService.resetCentralMobilePushStatusCacheForTest()
    pushService.setPushProviderTransportForTest({
      webPushImpl: async subscription => {
        webCalls += 1
        assert.equal(subscription.endpoint, endpoint)
        const error = new Error('Web push temporal')
        error.statusCode = 503
        throw error
      }
    })

    await db.run(`
      INSERT INTO push_subscriptions (
        id, user_id, endpoint, subscription_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [sharedId, userId, endpoint, JSON.stringify({ endpoint, keys: { p256dh: 'test', auth: 'test' } })])
    await db.run(`
      INSERT INTO mobile_push_devices (
        id, user_id, platform, token, calendar_ids_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'android', ?, '[]', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [sharedId, userId, `shared-mobile-token-${suffix}`])

    const first = await pushService.sendAppNotificationPayload({
      title: 'Targets namespaced',
      body: 'Primer intento',
      category: 'chat'
    }, { userIds: [userId], durableDelivery: true })
    assert.equal(first.nativeSent, 1)
    assert.equal(first.retryableFailures, 1)
    assert.deepEqual(first.retryTargets, {
      webSubscriptionIds: [sharedId],
      mobileDeviceIds: []
    })

    pushService.setPushProviderTransportForTest({
      webPushImpl: async subscription => {
        webCalls += 1
        assert.equal(subscription.endpoint, endpoint)
      }
    })
    const recovery = await pushService.sendAppNotificationPayload({
      title: 'Targets namespaced',
      body: 'Retry web',
      category: 'chat'
    }, {
      userIds: [userId],
      durableDelivery: true,
      deliveryTargets: first.retryTargets
    })
    assert.equal(recovery.attempted, 1)
    assert.equal(recovery.webSent, 1)
    assert.equal(recovery.nativeSent, 0)
    assert.equal(webCalls, 2)
    assert.equal(
      central.requests.filter(request => request.url === '/api/license/mobile-push/send').length,
      1,
      'el retry web no debe reenviar el device mobile que compartía ID'
    )
  } finally {
    if (db) {
      await db.run('DELETE FROM push_subscriptions WHERE id = ?', [sharedId]).catch(() => {})
      await db.run('DELETE FROM mobile_push_devices WHERE id = ?', [sharedId]).catch(() => {})
    }
    pushService?.resetPushProviderTransportForTest?.()
    pushService?.resetCentralMobilePushStatusCacheForTest?.()
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    await new Promise(resolve => central.server.close(resolve))
  }
})

test('timeout del Installer central cubre headers y body de la respuesta', async () => {
  const envSnapshot = snapshotEnv()
  const central = await startCentralPushServer({ hangSendBody: true })
  let licenseService = null
  const suffix = randomUUID()

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.LICENSE_SERVER_URL = central.baseUrl
    process.env.CLIENT_ID = 'cli_push_body_timeout'
    process.env.LICENSE_KEY = 'lic_push_body_timeout'
    process.env.INSTALLATION_ID = 'inst_push_body_timeout'
    process.env.APP_URL = 'https://app.ristak.test'
    licenseService = await import('../src/services/licenseService.js')
    licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

    const startedAt = Date.now()
    await assert.rejects(
      licenseService.sendCentralMobilePushNotifications({
        devices: [{ id: `body-timeout-${suffix}`, platform: 'ios', token: `token-${suffix}` }],
        payload: { title: 'Timeout', body: 'Body colgado' }
      }, { timeoutMs: 30 }),
      error => error?.code === 'license_portal_timeout' && error?.retryable === true
    )
    assert.ok(Date.now() - startedAt < 500, 'el body colgado debe respetar el deadline corto')
  } finally {
    if (licenseService) licenseService.setVerifiedAppBaseUrlResolverForTests()
    restoreEnv(envSnapshot)
    central.server.closeAllConnections?.()
    await new Promise(resolve => central.server.close(resolve))
  }
})
